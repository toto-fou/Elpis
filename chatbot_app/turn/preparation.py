# SPDX-License-Identifier: MIT
"""
chatbot_app.turn.preparation — préparation d'un tour de chat :
``prepare_turn`` transforme le payload client en ``TurnPlan`` (données
décidées une fois pour toutes), ``TurnResources`` (persistance, mémoire, outils
RAG) et ``PersistBaseline`` (base de l'enregistrement optimiste).

Les adresses des serveurs MCP sont résolues ICI, côté serveur, jamais reprises
du client ; les interrupteurs du compte (outils, mémoire, sous-agents,
compaction, mode plan) y sont appliqués avant que le modèle voie quoi que ce
soit.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import secrets
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional

from fastapi import HTTPException, Request

from chatbot_app.turn.history import (
    _expand_history_for_llm,
    _graft_stopped_turn_state,
    _normalize_client_messages,
)
from chatbot_app.turn.tasks import keep
from llm_core import apply_rag
from shared_infra.accounts.users import get_user_settings, get_username_by_id
from shared_infra.chat.store import get_chat, get_chat_plan_mode, set_title_if_default, upsert_chat
from shared_infra.observability.events_bus import CURRENT_LOADED_MODELS, _refresh_model_cache, system_events
from shared_infra.observability.tracing import swallow
from shared_infra.routes._helpers import _msg_text, last_user_text, recent_user_text

logger = logging.getLogger("uvicorn.error")


def _settings_from_cached_row(urow) -> Optional[Dict[str, Any]]:
    """Réglages du compte depuis la ligne ``users`` déjà chargée par la porte
    de session (``request.state._user_row``). ``None`` = illisible : l'appelant
    relit en base, il ne repart JAMAIS sur ``{}``.

    Pas d'``except`` large ici : une erreur de programmation doit lever. Un
    repli silencieux sur ``{}`` ferait partir CHAQUE tour avec des réglages
    VIDES (serveurs MCP externes jetés à la résolution, sous-agents et
    mémoire éteints, prompt custom perdu, ``enable_mcp`` remis au défaut).
    Un JSON illisible se SIGNALE et renvoie ``None`` pour relire en base.
    Les tests qui simulent l'auth en patchant ``require_user_id`` ne posent
    jamais ``_user_row`` : un test dédié le pose comme en production.
    """
    try:
        raw = urow["settings_json"]
    except (KeyError, IndexError, TypeError):
        return None
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        logger.warning("[chats] settings_json illisible sur la ligne users en "
                       "cache — relecture en base pour ce tour")
        return None
    return parsed if isinstance(parsed, dict) else None


def _stdio_allowed_for(user_id) -> bool:
    """Le propriétaire peut-il faire exécuter une commande ``stdio`` sur
    l'hôte ? Administrateur PLEIN seulement (``is_admin == 1``)."""
    try:
        from shared_infra.accounts.users import get_user_by_id
        me = get_user_by_id(int(user_id))
        return bool(me and me["is_admin"] == 1)
    except Exception:  # noqa: BLE001 — compte illisible : refus (fail-closed)
        return False


def _agent_mcp_configs(user_settings, user_id=None) -> list:
    """Serveurs MCP qu'un agent CUSTOM peut référencer par id.

    Délègue à ``shared_infra.mcp.servers.resolve_for_agents`` : le scheduler
    de routines lance les mêmes agents custom, et deux définitions auraient
    divergé au premier changement de règle.
    """
    from shared_infra.mcp.servers import resolve_for_agents
    return resolve_for_agents(
        user_settings, allow_stdio=_stdio_allowed_for(user_id) if user_id is not None else False)


@dataclass(frozen=True, slots=True)
class TurnPlan:
    """Tout ce que la préparation a décidé pour le tour : identité, cible,
    outils, compaction, historique, titre.

    Gel SUPERFICIEL : aucun champ n'est réaffecté après la préparation, mais
    les listes et dictionnaires ne sont pas copiés (ce sont ceux du payload
    client ou de la lecture du chat) ; ``frozen`` n'en protège pas le contenu.
    """
    user_id: int
    chat_id: str
    username: str
    user_settings: dict
    ephemeral: bool
    is_continue: bool
    resumable: bool
    run_id: str
    exec_id: str
    target: Any
    selected_model: Any
    thinking_mode: bool
    sampling_override: Optional[dict]
    active_mcp_servers: list
    rag_meta: Optional[dict]
    rag_collection: Any
    mcp_on: bool
    agents_on: bool
    memory_on: bool
    live_shell_on: bool
    deny_tools: Optional[set]
    plan_mode: bool
    ui_tool_cats: list
    ui_ext_ids: list
    ui_excl: list
    compression_on: bool
    compaction_threshold: Any
    compaction_max_rounds: Any
    pruned_keys: list
    messages: list
    msgs: list
    msgs_for_llm: list
    last_user_text: str
    existing_chat: Optional[dict]
    chat_read_failed: bool
    title: str
    title_was_generated: bool
    title_content: Optional[str]


@dataclass(frozen=True, slots=True)
class TurnResources:
    """Ressources du tour : fonction de persistance (vide en session
    éphémère), gestionnaire de mémoire (fermé par le worker) et outils RAG
    intégrés. Séparées de ``TurnPlan`` : ce ne sont pas des données."""
    persist_chat: Callable[..., Any]
    mem_manager: Any
    rag_builtin_tools: Optional[dict]


@dataclass(slots=True)
class PersistBaseline:
    """Base de l'enregistrement optimiste et état de compression précédent.

    Seul porteur de ces valeurs entre la préparation, le handler (qui la
    recale après une passation) et ``run_turn``, qui la déballe à son
    démarrage : ses propres écritures (question d'un tour reprenable, état de
    compression relu) recalent ensuite les locales du tour.
    """
    updated_at: Any
    messages: Optional[list]
    title: str
    compr_prev_state: Optional[dict]


async def prepare_turn(request: Request, data: dict, user_id: int,
                       chat_id: str) -> "tuple[TurnPlan, TurnResources, PersistBaseline]":
    """Prépare un tour de chat à partir du payload client.

    Résout la cible et les serveurs MCP côté serveur, lit le chat persisté,
    applique les interrupteurs du compte (mémoire, sous-agents, compaction,
    outils), assemble la tête système, développe l'historique, ré-applique
    l'état de compression, branche le RAG et calcule le titre. Lève
    ``HTTPException`` (400, 409), que le handler laisse remonter : rien n'est
    encore rendu au client à ce stade.
    """
    messages = data.get("messages") or []
    active_mcp_servers = data.get("active_mcp_servers", [])
    # Snapshot des toggles du panneau Outils, AVANT l'injection mémoire :
    # catégories locales cochées + serveurs EXTERNES actifs (préfixe
    # ``ext:<id>``, même canal meta_json["tools"]) — mémorisé sur le chat en
    # fin de tour et retrouvé au switch. L'état des externes est lui aussi
    # par chat : rangé dans les settings GLOBAUX, il « collerait » d'un chat
    # à l'autre.
    _ui_tool_cats: list = []
    _ui_ext_ids: list = []
    for _srv in (active_mcp_servers or []):
        if not isinstance(_srv, dict):
            continue
        if _srv.get("command") == "DEFAULT_LOCAL_PYTHON" \
                and isinstance(_srv.get("filter_categories"), list):
            if not _ui_tool_cats:
                _ui_tool_cats = [str(c) for c in _srv["filter_categories"] if isinstance(c, str)]
        elif _srv.get("id"):
            _ui_ext_ids.append("ext:" + str(_srv["id"]))
        elif _srv.get("manifest"):
            # Serveur DÉCLARÉ dans ``mcp.json`` : même canal
            # per-chat que les externes, préfixe ``mf:<nom>``.
            _ui_ext_ids.append("mf:" + str(_srv["manifest"]))

    # Outils DÉCOCHÉS un par un dans le panneau. Canal séparé
    # d'``active_mcp_servers``, à dessein : rangée dans la config d'un serveur,
    # cette liste entrerait dans la clé du pool (une connexion par combinaison
    # de cases cochées) et dans les snapshots de routines. C'est une donnée du
    # CHAT — elle s'applique APRÈS connexion, via ``deny_tool_names``, la seule
    # couche qui porte aussi les catégories cachées.
    _ui_excl: list = [
        str(_t).strip()[:64]
        for _t in (data.get("excluded_tools") or [])
        if isinstance(_t, str) and _t.strip()
    ][:96]

    use_rag = bool(data.get("use_rag", False))
    rag_collection  = data.get("rag_collection", "")
    rag_search_mode = data.get("rag_search_mode", "classic")
    if rag_search_mode not in ("classic", "hybrid", "bm25"):
        rag_search_mode = "classic"

    try:
        rag_top_k    = max(1, min(int(data.get("rag_top_k", 8)), 20))
        rag_use_mmr  = bool(data.get("rag_use_mmr", True))

        rag_ctx_size = max(0, int(data.get("ctx_size", 0)))
    except (TypeError, ValueError):
        raise HTTPException(400, "rag_top_k / ctx_size doivent être des entiers")

    selected_model = data.get("model")
    connector_id = data.get("connector_id")
    thinking_mode = bool(data.get("thinking_mode", False))

    # ── Connecteur LLM cible pour ce tour ─────────────────────────────────
    # Défaut (connector_id absent) : le llama.cpp intégré.
    # Sinon : connecteur perso/partagé (cloud Anthropic/OpenAI… ou backend
    # local alternatif). Le target est activé dans le générateur de stream.
    #
    # AUCUN repli silencieux. Un connecteur supprimé, désactivé ou à la clé
    # illisible ne doit pas répondre par le serveur INTÉGRÉ : avec deux
    # serveurs exposant les mêmes noms de modèles, la bascule serait
    # invisible. Et la visibilité des serveurs par
    # utilisateur / groupe (``engine_access``) doit être appliquée ICI, pas
    # seulement dans la liste du sélecteur. Refus = 409 explicite que le front
    # affiche et qui lui fait purger la sélection.
    from llm_core._target import EngineUnavailable as _EngineUnavailable, resolve_llm_target as _resolve_target
    try:
        _cid_int = int(connector_id) if connector_id not in (None, "", 0, "0") else None
    except (TypeError, ValueError):
        _cid_int = None
        connector_id = None
    try:
        _target = _resolve_target(user_id, _cid_int, selected_model, strict=True)
    except _EngineUnavailable as _eu:
        raise HTTPException(409, {"code": "engine_unavailable",
                                  "reason": _eu.reason, "message": _eu.message})
    try:
        from shared_infra.llm import engine_access as _ea
        _ekey = _ea.connector_key(_cid_int) if _cid_int else _ea.BUILTIN_KEY
        _allowed = await asyncio.to_thread(_ea.can_use_engine, user_id, _ekey)
    except Exception:  # noqa: BLE001 — fail-open documenté dans engine_access
        _allowed = True
    if not _allowed:
        raise HTTPException(409, {"code": "engine_unavailable",
                                  "reason": "forbidden",
                                  "message": "Ce serveur ne vous est pas ouvert."})

    # ``ephemeral`` : session jetable (Annotation Studio). On NE persiste PAS le
    # chat (pas de pollution de la sidebar des chats sauvegardés). Toutes les
    # écritures passent par ``_persist_chat`` qui devient un no-op.
    ephemeral = bool(data.get("ephemeral", False))
    _persist_chat = (lambda *a, **k: None) if ephemeral else upsert_chat

    sampling_override = data.get("sampling_override")
    if sampling_override is not None and not isinstance(sampling_override, dict):
        sampling_override = None

    # L'auto-chargement local (routeur multi-modèles) ne concerne QUE le moteur
    # intégré llama.cpp. Un moteur local vLLM/générique ou un modèle cloud ne se
    # « charge » pas ainsi côté serveur.
    if _target.is_local_llamacpp and selected_model and selected_model not in CURRENT_LOADED_MODELS:
        CURRENT_LOADED_MODELS.add(selected_model)
        # Référence forte : asyncio ne retient les tâches qu'en WeakSet, une
        # tâche fire-and-forget non référencée peut être collectée avant de
        # tourner (ici : cache de modèles jamais rafraîchi, l'UI afficherait
        # un modèle périmé).
        keep(asyncio.create_task(_refresh_model_cache()))
        await system_events.broadcast({
            "type": "log", "message": f"[LLM] Modèle auto-chargé par requête chat: {selected_model}", "level": "INFO",
        })

    # La gate de session (deps._session_validity_checks) a déjà chargé la
    # ligne ``users`` de cette requête : settings + username en sortent sans
    # nouveau SELECT (pas de ``SELECT *`` synchrone sur la boucle). Repli en
    # thread si le state est absent.
    # ⚠ Ligne en cache ILLISIBLE ⇒ relecture en base, jamais ``{}`` : des
    # réglages vides ici jettent silencieusement les serveurs MCP externes,
    # les sous-agents, la mémoire, le prompt custom (cf. _settings_from_cached_row).
    _urow = getattr(request.state, "_user_row", None)
    user_settings = _settings_from_cached_row(_urow) if _urow is not None else None
    if user_settings is not None:
        try:
            username = _urow["username"] or f"user_{user_id}"
        except (KeyError, IndexError, TypeError):
            username = f"user_{user_id}"
    else:
        def _read_user_bits():
            return get_user_settings(user_id), get_username_by_id(user_id)
        user_settings, _uname = await asyncio.to_thread(_read_user_bits)
        if not isinstance(user_settings, dict):
            user_settings = {}
        username = _uname or f"user_{user_id}"

    # ── Bibliothèque MCP PARTAGÉE : résolution CÔTÉ SERVEUR ───────────────
    # Le navigateur ne connaît d'un serveur publié que son nom, son type et son
    # URL — jamais l'identifiant d'accès (chiffré en base, cf.
    # shared_infra/mcp/servers.py). Il pousse donc une entrée-référence
    # ``{"id": "shared:<n>", "shared": true}`` que l'on remplace ici par la
    # vraie config (URL + en-tête d'auth).
    #
    # Trois refus, tous silencieux (l'entrée est simplement jetée) : id inconnu,
    # serveur dépublié/désactivé, et serveur que CE compte n'a pas coché dans
    # son panneau. Corollaire : un client modifié ne peut pas se fabriquer un
    # serveur arbitraire sous une identité partagée, ni emprunter un serveur
    # qu'il n'affiche pas.
    # Les serveurs PERSO passent par la même résolution : le client ne fournit
    # qu'un id ; l'URL et l'auth viennent toujours du magasin serveur. Recopier
    # l'entrée du payload ferait ouvrir au backend une URL arbitraire avec des
    # en-têtes arbitraires depuis sa position réseau (SSRF à en-têtes
    # contrôlés, atteignable par tout compte authentifié).
    if active_mcp_servers:
        from shared_infra.mcp.servers import (
            client_builtin_ref as _builtin_ref,
            resolve_config as _resolve_shared,
            resolve_personal as _resolve_perso,
            shared_id as _shared_id,
        )
        # Un serveur perso ``stdio`` n'est spawné que pour un administrateur
        # plein (cf. servers.StdioNotAllowed).
        _stdio_ok = _stdio_allowed_for(user_id)
        _visible = {str(v) for v in ((user_settings or {}).get("shared_mcp_visible") or [])}
        _resolved: list = []
        for _srv in active_mcp_servers:
            if not isinstance(_srv, dict):
                continue
            _cats = _srv.get("filter_categories")

            # Serveur d'outils LOCAUX : pas d'id, commande en dur côté serveur.
            # L'entrée est RECONSTRUITE (nom + catégories du client, rien
            # d'autre) : recopiés tels quels, ``type``/``url``/``headers``
            # ouvriraient une URL arbitraire depuis le backend.
            if not _srv.get("id"):
                _ref = _builtin_ref(_srv)
                if _ref is not None:
                    _resolved.append(_ref)
                elif _srv.get("manifest"):
                    # Serveur déclaré dans ``mcp.json`` : le
                    # navigateur n'envoie que le NOM ; URL, en-têtes et
                    # commande viennent du manifeste (autorité serveur).
                    from shared_infra.mcp.manifest import resolve_external_cfg as _mf_cfg
                    _cfg = _mf_cfg(str(_srv.get("manifest")))
                    if _cfg:
                        if _cats is not None:
                            _cfg["filter_categories"] = _cats
                        _resolved.append(_cfg)
                continue

            _rid = _shared_id(_srv.get("id"))
            if _rid is not None:
                if str(_srv.get("id")) not in _visible:
                    continue
                _cfg = _resolve_shared(_rid)
            else:
                _cfg = _resolve_perso(user_settings, _srv.get("id"), allow_stdio=_stdio_ok)
            if not _cfg:
                continue
            if _cats is not None:
                _cfg["filter_categories"] = _cats
            _resolved.append(_cfg)
        active_mcp_servers = _resolved
    # Mémoire long-terme (Hermes) : TOGGLE per-user, défaut OFF (opt-in). Le flag
    # global ``MEMORY_ENABLED`` reste un interrupteur maître. ``_memory_on``
    # gouverne À LA FOIS le bloc mémoire injecté (lecture, system prompt) ET
    # l'exposition des outils ``memory`` / ``session_search`` (passé en
    # ``memory_enabled`` à run_chat_multi_mcp). Hors du panneau d'outils.
    from shared_infra.config import MEMORY_ENABLED as _MEMORY_MASTER
    _memory_on = bool(_MEMORY_MASTER and (user_settings or {}).get("memory_enabled", False))
    # Sous-agents (outil ``task``) : même gabarit que la mémoire — TOGGLE
    # per-user ``agents_enabled`` (défaut OFF, opt-in) sous interrupteur maître
    # ``AGENTS_ENABLED``. Gouverne la construction du builtin ``task`` plus bas.
    from shared_infra.config import AGENTS_ENABLED as _AGENTS_MASTER
    _agents_on = bool(_AGENTS_MASTER and (user_settings or {}).get("agents_enabled", False))
    if _agents_on:
        # Toggle actif mais banque entièrement désactivée : pas d'outil ``task``
        # (son enum serait vide → grammaire llama.cpp invalide).
        from llm_core.tools.task_tool import has_active_agents
        _agents_on = has_active_agents((user_settings or {}).get("custom_agents") or [])
    # Terminal en direct : TOGGLE per-user (défaut ON — pur réglage
    # d'affichage, comme le thinking). Propagé à run_chat_multi_mcp qui pose
    # ``live_shell: "1"`` dans le meta MCP → execute_shell streame sa sortie
    # (événements ``shell_output``). OFF ⇒ rien n'est émis (zéro overhead).
    _live_shell_on = bool((user_settings or {}).get("live_shell_enabled", True))
    # Compaction AUTOMATIQUE : même gabarit — TOGGLE per-user
    # ``compression_enabled`` (défaut OFF, opt-in) sous interrupteur maître
    # ``COMPRESSION_ENABLED``. Motif produit : beaucoup d'utilisateurs préfèrent
    # décider eux-mêmes quand compacter (commande /compact), qui reste TOUJOURS
    # disponible quel que soit ce réglage. Ne gouverne que l'automatique — porte
    # d'occupation ET rattrapage « contexte dépassé ».
    from shared_infra.config import COMPRESSION_ENABLED as _COMPR_MASTER
    _compression_on = bool(_COMPR_MASTER and (user_settings or {}).get("compression_enabled", False))
    # « Contexte max avant compaction » : seuil choisi par le compte — en % de
    # la fenêtre OU en tokens — sinon le défaut d'instance
    # (``llm.compaction.threshold_*``), sinon auto (plafond technique).
    # Résolu ICI, comme ``_compression_on`` : la
    # boucle et le compresseur reçoivent une décision, pas des réglages à
    # recomposer.
    from llm_core.context.compaction_gate import resolve_threshold as _resolve_thr
    _compaction_threshold = _resolve_thr(user_settings)
    # Compactions max pour CETTE conversation (auto + /compact confondus).
    # None = le compte n'a rien réglé ⇒ défaut d'instance
    # ``COMPRESSION_MAX_PER_CHAT``. C'est le réglage qui décide si une mission
    # de plusieurs heures peut continuer à se compacter jusqu'au bout, ou si
    # elle finit sur le budget dur (qui jette les vieux tours au lieu de les
    # résumer).
    from llm_core.context.compaction_gate import resolve_max_rounds as _resolve_rounds
    _compaction_max_rounds = _resolve_rounds(user_settings)
    # Mémoire long-terme : les outils ``memory`` (écrire/éditer) et
    # ``session_search`` vivent dans le serveur MCP local. Ils ne sont exposés que
    # si ce serveur est actif — or il ne l'est QUE si l'utilisateur a activé au
    # moins une catégorie d'outils dans le panneau. Conséquence : mémoire ON mais
    # aucun outil actif ⇒ le modèle ne voit PAS l'outil mémoire et ne peut donc
    # rien mémoriser. On injecte donc un serveur local scopé à la catégorie cachée
    # ``memory`` dès que la mémoire est active et qu'aucun serveur local n'est déjà
    # présent. ``_apply_memory_gate`` + la catégorie ``memory`` laissée passer par
    # _collect_mcp_tools (quand memory_enabled) font le reste. Ça bascule aussi
    # ``_use_mcp_path`` à True (active_mcp_servers devient non vide).
    # ── Interrupteur « Outils externes » (settings ``enable_mcp``) ────────
    # Appliqué CÔTÉ SERVEUR, seule place qui fait autorité (un client modifié
    # ne peut pas le contourner). Masquer le bouton et le panneau côté UI ne
    # suffit pas : les catégories déjà cochées continueraient de partir au
    # modèle à chaque tour, sans que l'utilisateur puisse les décocher.
    #
    # OFF ⇒ aucun serveur d'outils : ni local (fs/shell/git/browser/desktop…),
    # ni MCP externe. SEULE exception voulue : les outils de MÉMOIRE, qui sont
    # réinjectés juste en dessous si la mémoire est active — écrire un souvenir
    # n'est pas « exécuter du code chez l'utilisateur ».
    #
    # Défaut ABSENT = ON (fail-open) : la clé n'a jamais eu de défaut backend,
    # la couper d'office retirerait les outils à tout compte qui n'a jamais
    # ouvert ce réglage. Seul un ``false`` EXPLICITE coupe.
    _mcp_on = bool((user_settings or {}).get("enable_mcp", True))
    if not _mcp_on:
        active_mcp_servers = []
        _ui_tool_cats = []
        _ui_ext_ids = []
        _ui_excl = []
        # Sous-agents retirés avec le reste. ⚠ PAS parce qu'ils hériteraient
        # de la surface du parent — un enfant reconstruit sa
        # config MCP de zéro (catégories pré-cochées de son type), donc il
        # aurait ses outils AU COMPLET pendant que le chat n'en a aucun.
        # C'est justement pour ça qu'il faut couper ici : cet interrupteur dit
        # « aucun outil ne tourne chez cet utilisateur », et déléguer serait le
        # contournement le plus simple qui soit.
        _agents_on = False
    # Deny FINAL quand les outils sont coupés : les catégories CACHÉES
    # (``memory``, ``task``) traversent ``filter_categories`` par conception,
    # si bien que le serveur « Mémoire » ramènerait aussi ``todowrite``. Or la
    # consigne est de ne garder QUE la mémoire — ``deny_tool_names`` est la
    # seule couche qui s'applique aussi aux catégories cachées.
    _deny_tools = None if _mcp_on else {"todowrite"}
    # Les cases décochées rejoignent le deny FINAL : un outil retiré l'est pour
    # ce tour, sans exception pour les catégories cachées.
    if _ui_excl:
        _deny_tools = set(_deny_tools or ()) | set(_ui_excl)

    # Chat persisté chargé ICI (avant plan/system/expansion) : les marques
    # d'élagage vivent dans meta_json["ctx_pruned_keys"] et pilotent le
    # rendu des tool_results ; ``_existing_chat`` est réutilisé plus bas
    # (état de compression, titre, garde optimiste).
    # Un échec de CETTE lecture (« database is locked » après les 10 s de
    # busy_timeout en contention WAL multi-worker, ou ``messages_json``
    # illisible) désarme trois choses d'un coup :
    #   • ``_baseline_updated_at`` → la persistance finale écrit SANS garde
    #     optimiste et peut clobberer un tour concurrent ;
    #   • ``_compr_prev_state`` → ``_with_compr_state`` ne re-préfixe plus le
    #     message system, donc le résumé de compaction et le compteur de rounds
    #     sont EFFACÉS de messages_json (le client ne renvoie jamais de system) ;
    #   • ``_pruned_keys`` → les marques d'élagage sont ignorées.
    # On distingue donc « chat absent » (légitime : chat neuf) d'un échec de
    # lecture, qui est tracé ET marqué pour interdire l'écriture destructrice
    # plus bas.
    _existing_chat = None
    _chat_read_failed = False
    try:
        # Hors boucle : json.loads de TOUT messages_json est linéaire en
        # taille de conversation.
        _existing_chat = await asyncio.to_thread(get_chat, user_id, chat_id)
    except Exception:  # noqa: BLE001 — échec marqué (``_chat_read_failed``), relu ci-dessous
        _existing_chat = None
        _chat_read_failed = True
    if _chat_read_failed:
        # UNE relecture après un court délai : l'échec typique est une
        # contention SQLite passagère, et un tour lancé sans cette lecture n'a
        # ni garde optimiste, ni état de compression, ni titre connu.
        await asyncio.sleep(0.3)
        try:
            _existing_chat = await asyncio.to_thread(get_chat, user_id, chat_id)
            _chat_read_failed = False
        except Exception:  # noqa: BLE001 — l'échec reste marqué et tracé ci-dessous
            _existing_chat = None
    if _chat_read_failed:
        logger.warning(
            "[chats] lecture du chat %s échouée — état de compression et garde "
            "optimiste indisponibles pour ce tour", str(chat_id)[:12],
            exc_info=True)

    # ── Mode lecture seule du chat (commande « /plan ») ───────────────────
    # Lu EN BASE, jamais dans le corps de la requête : c'est le serveur qui
    # fait autorité, un onglet resté ouvert ne doit pas pouvoir rendre la
    # main sur les toggles d'écriture en envoyant un état périmé.
    # Dérivé de ``_existing_chat`` (qui expose déjà ``plan_mode``) plutôt
    # que d'un second SELECT meta_json synchrone sur la boucle. Si CETTE
    # lecture a échoué, on ne dérive JAMAIS « mode normal » d'une absence de
    # donnée (fail-open sur les outils d'écriture d'un chat en lecture
    # seule) : repli sur une lecture légère dédiée, dont l'échec fait échouer
    # le tour (pas de tour sans connaître le mode).
    if _chat_read_failed:
        _plan_mode = bool(await asyncio.to_thread(get_chat_plan_mode, user_id, chat_id))
    else:
        _plan_mode = bool((_existing_chat or {}).get("plan_mode"))
    if _plan_mode:
        # La réduction de surface (outils annotés read-only seulement) est
        # faite par la boucle. Restent les BUILTINS, qui n'ont pas
        # d'annotations : ``task`` doit tomber ici, sans quoi un sous-agent
        # ``implement`` écrirait depuis un chat en lecture seule — le
        # contournement le plus évident qui soit. Le RAG, lui, est de la
        # consultation : il reste.
        _deny_tools = set(_deny_tools or set()) | {"task"}

    _has_local_srv = any(
        isinstance(s, dict) and s.get("command") == "DEFAULT_LOCAL_PYTHON"
        for s in (active_mcp_servers or [])
    )
    # Le service d'outils INTÉGRÉ (entrée ``toolhost`` du manifeste
    # ``mcp.json``) est joint dès qu'une de ces conditions tient, même si
    # aucune catégorie n'est cochée :
    #   • mémoire active : les outils ``memory``/``session_search`` (catégorie
    #     laissée passer par ``memory_enabled`` dans _collect_mcp_tools) — y
    #     compris outils COUPÉS (``enable_mcp`` faux : ``_deny_tools`` retire
    #     alors ``todowrite``, seule la mémoire reste) ;
    #   • sous-agents actifs sans aucun serveur : le builtin ``task`` n'existe
    #     que sur le chemin MCP, un serveur scopé à rien (``[]`` = catégories
    #     cachées seules) suffit à l'exposer ;
    #   • serveurs EXTERNES seuls : ``todowrite`` (catégorie cachée ``task``)
    #     doit rester disponible dès qu'au moins un outil MCP est actif.
    # ``filter_categories=[]`` = catégories cachées + mémoire si active.
    if not _has_local_srv and (
            _memory_on
            or (_mcp_on and _agents_on and not active_mcp_servers)
            or (_mcp_on and active_mcp_servers)):
        from shared_infra.mcp.manifest import builtin_client_cfg as _builtin_cfg
        active_mcp_servers = list(active_mcp_servers or []) + [_builtin_cfg([])]
    # Le prompt de base du chatbot est CHATBOT_SYSTEM.md
    # (config.SYSTEM_PROMPT_DEFAULT), réellement injecté. Le prompt custom
    # de l'utilisateur (settings) est ajouté EN SUFFIXE s'il existe — il
    # étend/affine le défaut au lieu de le remplacer.
    from shared_infra.config import SYSTEM_PROMPT_DEFAULT as _BASE_SYS
    _base_sys = (_BASE_SYS or "").strip()
    _user_sys = user_settings.get("system_prompt", "").strip()
    if _base_sys and _user_sys:
        custom_sys = _base_sys + "\n\n---\n\n" + _user_sys
    else:
        custom_sys = _base_sys or _user_sys

    if not chat_id: chat_id = secrets.token_hex(12)

    if not isinstance(messages, list):
        raise HTTPException(400, "messages doit être une liste")

    messages, msgs = _normalize_client_messages(messages)
    if not messages:
        raise HTTPException(400, "messages: aucun message valide dans le payload")
    # Travail d'outils d'un tour STOPPÉ : le serveur l'a persisté avec le
    # partiel, mais le client (fetch abandonné au Stop) ne l'a jamais reçu et
    # renvoie ce message sans. Sans greffe, le tour suivant ne verrait plus
    # les outils déjà exécutés (écritures, commits) — le modèle pourrait les
    # rejouer — et le persist effacerait leur trace en base.
    if _existing_chat and not _chat_read_failed:
        with swallow("chat.graft_stopped_tool_history"):
            _graft_stopped_turn_state(messages, msgs,
                                      _existing_chat.get("messages"))
    # Un payload de NOTICES seules n'est pas un tour : sans message réel, le
    # modèle recevrait la seule tête système et répondrait dans le vide.
    if all(_m.get("role") == "notice" for _m in messages):
        raise HTTPException(400, "messages: aucun message valide dans le payload")

    is_continue = bool(data.get("is_continue", False))

    # Dernier message utilisateur — sert au matching déterministe des skills
    # (procédures injectées dans le system prompt) ET à l'indexation mémoire.
    # Best-effort : si pas de message user, le bloc skills se réduit à l'index.
    # ``last_user_text`` gère aussi le content MULTIMODAL (liste texte+image) :
    # sinon un message multimodal laisserait ce texte vide → skills non matchés
    # et mémoire indexant un tour vide.
    _last_user_text = last_user_text(messages)

    # ── Run REPRENABLE ───────────────────────────────────────────────────────
    # Le chat principal pose ``resumable`` : (a) ses événements sont journalisés
    # (``shared_infra.runtime.run_journal``) pour qu'un retour sur la
    # conversation — autre chat puis retour, rechargement, autre appareil —
    # REJOUE le tour puis le suive en direct ; (b) une déconnexion le DÉTACHE,
    # outils ou non : quitter la conversation laisse le tour se terminer
    # proprement côté serveur. Le studio et les sessions éphémères ne le
    # posent pas : pas de journal, et une déconnexion n'y détache le tour que
    # si un outil a tourné ou si ``DETACH_RUN_ON_DISCONNECT`` est actif
    # (``_should_detach_run``).
    _resumable = bool(data.get("resumable", False)) and not ephemeral
    _run_id = secrets.token_hex(8)
    # Exécution du tour (``runs``) : même identifiant que son journal.
    _exec_id = f"chat-{_run_id}"

    # Matching des skills : fenêtre des derniers tours user (pas seulement le
    # dernier message) → le corps d'une procédure reste matché même au tour
    # « fais-le » / « continue » qui ne contient aucun mot-clé. La mémoire, elle,
    # garde ``_last_user_text`` (un seul tour) pour l'indexation.
    _skill_query = recent_user_text(messages, k=3)

    # Skills épinglés par l'utilisateur via /skill dans la barre de prompt :
    # injectés de force (en plus de l'auto-matching) pour ce message.
    _pinned_skills = data.get("pinned_skills") or []
    if not isinstance(_pinned_skills, list):
        _pinned_skills = []

    # Mémoire long-terme auto-curée (façon Hermes) : on construit le manager
    # per-user (scope "user") et on capture le snapshot UNE fois PAR REQUÊTE
    # (donc par tour — le manager est reconstruit ici à chaque appel). Ce bloc
    # figé ne change pas en cours de requête même si l'agent écrit via l'outil
    # ``memory`` pendant la boucle d'outils (intra-tour, le modèle se fie aux
    # ``entries`` renvoyées par l'outil) ; le prefix-cache n'est préservé
    # entre deux tours que si le store n'a pas muté (rendu déterministe,
    # ids stables f(contenus)). Best-effort, jamais bloquant.
    _memory_block = ""
    _mem_manager = None
    try:
        if _memory_on:
            from llm_core.memory import build_default_manager
            _mem_manager = build_default_manager(
                username=username, scope_key="user",
                app="chat", session_id=chat_id,
            )
            # Threadpool : initialize lit USER.md + MEMORY.md sur
            # disque — hors boucle, comme le reste du préambule déporté.
            await asyncio.to_thread(_mem_manager.initialize, session_id=chat_id)
            _memory_block = _mem_manager.system_prompt_block()
    except Exception:  # noqa: BLE001 — mémoire best-effort : le tour part sans elle
        _mem_manager = None
        _memory_block = ""

    # Date du jour en anglais (tête système full-EN ; indépendant de la locale).
    import datetime as _dt

    from llm_core._system_prompts import assemble_system_messages
    _EN_MONTHS = ("January", "February", "March", "April", "May", "June", "July",
                  "August", "September", "October", "November", "December")
    _n = _dt.datetime.now()
    _today_fr = f"{_EN_MONTHS[_n.month - 1]} {_n.day}, {_n.year}"
    # Le bloc skills (index + header qui dit d'appeler skill_get/skill_read_file/
    # skill_run_script) ne doit être injecté QUE si la catégorie d'outils
    # « skill » est active pour ce tour — sinon le modèle reçoit une instruction
    # morte (outils non exposés). On lit l'activation depuis les filter_categories
    # des serveurs MCP actifs (cf. ``engine.tool_catalog._collect_mcp_tools``).
    _skills_on = any(
        (_fc := (s.get("filter_categories") if isinstance(s, dict) else None)) is None
        or "skill" in _fc
        for s in (active_mcp_servers or [])
    )
    # Libellé du modèle pour l'en-tête runtime (« Backing model: … ») : le socle
    # dit de répondre aux questions d'identité depuis cette ligne — les modèles
    # servis ici sont interchangeables, un nom appris à l'entraînement serait
    # halluciné. Best-effort : cible résolue (connecteur OU sélection UI), sinon
    # le modèle configuré du moteur local. Placeholder de config non informatif
    # → ligne omise (le socle prévoit l'absence : « say you don't know »).
    _model_label = (_target.model or selected_model or "").strip()
    if not _model_label and _target.is_default:
        import shared_infra.config as _cfg_mod
        _m = (getattr(_cfg_mod, "LLAMA_MODEL", "") or "").strip()
        _model_label = "" if _m == "local-model" else _m
    msgs_for_llm = assemble_system_messages(
        custom_sys=custom_sys,
        last_user_text=_skill_query,
        user_id=user_id,
        pinned_skills=[str(x) for x in _pinned_skills if x],
        memory_block=_memory_block,
        today=_today_fr,
        skills_enabled=_skills_on,
        plan_mode=_plan_mode,
        model_label=_model_label,
    )

    # (``_existing_chat`` chargé plus haut, avant la résolution du mode plan.)
    _pruned_keys = (_existing_chat or {}).get("ctx_pruned_keys") or []

    # Reprise NATIVE (continue_final_message) pour un Continue sur un tour
    # think-only : UNIQUEMENT si le support est CONFIRMÉ pour ce modèle — une
    # tentative optimiste échouerait ici en erreur de tour, sans le repli
    # in-run dont disposent les moteurs. Le cache est peuplé par les
    # auto-reprises (llm_core._think_resume) ; tant qu'il ne l'est pas, le
    # repli « think fermé + consigne de conclusion » fait le travail.
    _resume_native_ok = False
    if is_continue and _target.is_llamacpp:
        with swallow("chat.resume_native_probe"):
            from llm_core._llm_params import continue_final_support
            _resume_native_ok = continue_final_support(
                selected_model or _target.model) is True

    msgs_for_llm.extend(_expand_history_for_llm(
        messages, is_continue=is_continue, pruned_keys=_pruned_keys,
        resume_native=_resume_native_ok,
        user_suffixes=(_existing_chat or {}).get("llm_user_suffixes")))

    # ── État de compression PERSISTANT (round / tours couverts / résumé) ────
    # Le résumé vit en tête de messages_json côté serveur (le client ne
    # renvoie jamais de message system) : on le relit ici et on le ré-applique
    # au prompt — injection du résumé + drop des tours déjà couverts. Sans ça,
    # la compression serait re-payée à chaque tour et le cap
    # COMPRESSION_MAX_PER_CHAT n'aurait aucune mémoire. Appliqué pour
    # TOUTES les cibles (local + cloud : moins de tokens facturés).
    _compr_prev_state = None
    # Baseline pour la concurrence optimiste : updated_at du chat AU DÉBUT
    # du stream. La persistance finale n'écrit que si le chat n'a pas bougé
    # depuis (sinon une génération/compression concurrente sur un autre worker a
    # écrit entre-temps → on NE clobbere PAS). None pour un chat neuf (INSERT).
    _baseline_updated_at = (_existing_chat or {}).get("updated_at") if _existing_chat else None
    # De quoi distinguer, sur conflit, un vrai tour concurrent
    # d'un simple renommage (cf. ``_persist_turn``). Référence, pas copie : rien
    # ne mute la liste lue.
    _baseline_messages = (_existing_chat or {}).get("messages") if _existing_chat else None
    _baseline_title = ((_existing_chat or {}).get("title") or "") if _existing_chat else ""
    try:
        if _existing_chat:
            from llm_core.conversation_compressor import apply_persisted_state, extract_compression_state
            _compr_prev_state = extract_compression_state(_existing_chat.get("messages") or [])
            if _compr_prev_state:
                msgs_for_llm, _compr_prev_state = apply_persisted_state(
                    msgs_for_llm, _compr_prev_state)
    except Exception:  # noqa: BLE001 — non fatal : historique sans l'état de compression
        logger.warning("[chats] apply état de compression échoué (non-fatal)", exc_info=True)
        _compr_prev_state = None

    rag_meta = None
    _rag_builtin_tools = None

    if use_rag:

        from llm_core import build_rag_builtin_tools
        _rag_builtin_tools = build_rag_builtin_tools(
            collection=rag_collection,
            search_mode=rag_search_mode,
            top_k=rag_top_k,
            use_mmr=rag_use_mmr,
            ctx_size=rag_ctx_size,
        )
        if _rag_builtin_tools:
            rag_meta = {"enabled": True, "used": True, "mode": "tools"}
        else:

            # apply_rag est SYNCHRONE de bout en bout (httpx.Client vers le
            # service RAG, 30 s de timeout) : exécuté sur la boucle, l'auto-RAG
            # gèlerait tous les flux du worker avant le premier token.
            # Threadpool.
            msgs_for_llm, rag_meta = await asyncio.to_thread(
                apply_rag, msgs_for_llm,
                collection=rag_collection, search_mode=rag_search_mode)
            _rag_builtin_tools = None

    # Titre personnalisé (rename) : jamais écrasé. Recalculer TOUJOURS le
    # titre depuis le 1er message user remplacerait le titre choisi par les 28
    # premiers caractères du 1er message. On lit donc le chat existant : si un titre custom y figure
    # (non vide ET != "Nouveau chat"), on le CONSERVE et on n'auto-génère que
    # pour un chat neuf. ``_title_was_generated`` indique si on a (re)calculé un
    # titre côté serveur ce tour-ci → ne réémet le 'title' dans l'event 'final'
    # que dans ce cas (sinon la sidebar changerait sous les yeux de l'user).
    title = "Nouveau chat"
    _existing_title = ""
    try:
        # ``_existing_chat`` déjà chargé plus haut (état de compression) —
        # évite une 2e lecture/parse de messages_json sur les longs chats.
        if _existing_chat:
            _existing_title = (_existing_chat.get("title") or "").strip()
    except Exception:  # noqa: BLE001 — titre illisible : traité comme absent
        _existing_title = ""

    _title_content: Optional[str] = None
    _title_was_generated = False
    if _existing_title and _existing_title != "Nouveau chat":
        # Chat déjà nommé (rename utilisateur ou titre auto antérieur) : on garde.
        title = _existing_title
    else:
        first_user = next((x for x in msgs if x["role"] == "user"), None)
        if first_user:
            _title_content = re.sub(r'---\s*FILE:\s*.+?\s*---[\s\S]*?---\s*END FILE\s*---\s*', '', _msg_text(first_user["content"])).strip()
            _new_title = (_title_content or "Nouveau chat")[:28]
            if _new_title != title:
                _title_was_generated = True
            title = _new_title

    # Run reprenable : la barre latérale (tous onglets) le montre en cours dès
    # qu'on le quitte ; sans titre posé tout de suite elle y lirait « Nouveau
    # chat » jusqu'à la fin du tour (save-messages est ignoré pendant un run).
    if _resumable and _title_was_generated and _existing_chat:
        with swallow("chat.early_title"):
            await asyncio.to_thread(set_title_if_default, user_id, chat_id, title)

    plan = TurnPlan(
        user_id=user_id,
        chat_id=chat_id,
        username=username,
        user_settings=user_settings,
        ephemeral=ephemeral,
        is_continue=is_continue,
        resumable=_resumable,
        run_id=_run_id,
        exec_id=_exec_id,
        target=_target,
        selected_model=selected_model,
        thinking_mode=thinking_mode,
        sampling_override=sampling_override,
        active_mcp_servers=active_mcp_servers,
        rag_meta=rag_meta,
        rag_collection=rag_collection,
        mcp_on=_mcp_on,
        agents_on=_agents_on,
        memory_on=_memory_on,
        live_shell_on=_live_shell_on,
        deny_tools=_deny_tools,
        plan_mode=_plan_mode,
        ui_tool_cats=_ui_tool_cats,
        ui_ext_ids=_ui_ext_ids,
        ui_excl=_ui_excl,
        compression_on=_compression_on,
        compaction_threshold=_compaction_threshold,
        compaction_max_rounds=_compaction_max_rounds,
        pruned_keys=_pruned_keys,
        messages=messages,
        msgs=msgs,
        msgs_for_llm=msgs_for_llm,
        last_user_text=_last_user_text,
        existing_chat=_existing_chat,
        chat_read_failed=_chat_read_failed,
        title=title,
        title_was_generated=_title_was_generated,
        title_content=_title_content,
    )
    res = TurnResources(
        persist_chat=_persist_chat,
        mem_manager=_mem_manager,
        rag_builtin_tools=_rag_builtin_tools,
    )
    base = PersistBaseline(
        updated_at=_baseline_updated_at,
        messages=_baseline_messages,
        title=_baseline_title,
        compr_prev_state=_compr_prev_state,
    )
    return plan, res, base
