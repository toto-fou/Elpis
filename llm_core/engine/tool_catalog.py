# SPDX-License-Identifier: MIT
"""llm_core.engine.tool_catalog — catalogue d'outils d'un tour de la boucle.

Réunit en une seule charge utile ``tools[]`` les outils de tous les serveurs
MCP du tour et les outils intégrés (RAG, mémoire, sous-agents…), puis applique
les filtres : refus explicites, catégories cochées, mode plan, porte de la
mémoire. Rend aussi les tables dont la boucle a besoin pour exécuter un appel
(serveur d'un outil, gestionnaire d'un outil intégré).

Le jeu d'outils doit rester stable au sein d'une conversation : le cache de
préfixe du moteur en dépend (``tests/llm_core/test_golden_payload.py``).

Le pool de connexions MCP est lu à l'appel via son module propriétaire
(``_mcp_pool.mcp_pool``), comme dans ``engine.tool_dispatch`` : les tests le
remplacent à un seul endroit.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable, Dict, List, Optional, Tuple

from llm_core import _mcp_pool
from llm_core._mcp_wrappers import (
    _resolve_mcp_client,
    friendly_mcp_error as _friendly_mcp_error,
    mcp_tool_to_openai,
)
from llm_core._scheduling._guard import _emit
from llm_core._tool_traits import tool_traits

logger = logging.getLogger("uvicorn.error")


# Tools de la catégorie « memory » (Hermes) — gouvernées par un TOGGLE per-user
# (défaut OFF), pas par le panneau d'outils ni le set caché toujours-actif.
_MEMORY_TOOL_NAMES = frozenset({"memory", "session_search"})


def _tool_name(t) -> str:
    """Nom d'un outil, qu'il soit un objet (.name) ou un dict ({'name': ...})."""
    return getattr(t, "name", None) or (t.get("name", "") if isinstance(t, dict) else "") or ""


def _apply_memory_gate(raw_tools, memory_enabled: bool, categorize) -> list:
    """Drop the memory-category tools unless ``memory_enabled``.

    Robust even when ``filter_categories`` is None (all-pass) OR the manifest is
    down (``categorize`` returns ""): we match by tool NAME *and* by category, so
    neither path can leak ``memory`` / ``session_search`` when the toggle is OFF.
    Pure (no I/O) → directly unit-testable.
    """
    if memory_enabled:
        return list(raw_tools)
    return [
        t for t in raw_tools
        if _tool_name(t) not in _MEMORY_TOOL_NAMES and categorize(_tool_name(t)) != "memory"
    ]


def _expand_builtin_configs(mcp_configs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Remplace chaque config sentinelle ``DEFAULT_LOCAL_PYTHON`` par la liste
    des entrées intégrées du manifeste (dédoublonnées par nom d'entrée).

    Il y a normalement UNE entrée par famille, chacune avec son
    endpoint : la sentinelle se développe donc en autant de configs, et retirer
    une entrée de ``mcp.json`` retire ses outils sans autre geste. Manifeste
    réduit à une seule entrée intégrée : comportement strictement inchangé,
    y compris le nom donné par l'appelant (``task-explore``…)."""
    out: List[Dict[str, Any]] = []
    seen: set = set()
    for cfg in (mcp_configs or []):
        if isinstance(cfg, dict) and cfg.get("type", "sse") == "stdio" \
                and cfg.get("command", "") == "DEFAULT_LOCAL_PYTHON":
            try:
                from shared_infra.mcp.manifest import builtin_client_cfgs as _bcc
                expanded = _bcc(cfg.get("filter_categories"))
            except Exception:                                    # noqa: BLE001 — manifeste illisible : config d'origine
                expanded = [cfg]
            # Le nom donné par l'appelant (« Outils Locaux », « task-explore »)
            # ne survit que s'il n'y a QU'UNE entrée de service à nommer ; avec
            # une entrée par famille, chacune garde la sienne.
            solo = sum(1 for e in expanded
                       if e.get("command") == "DEFAULT_LOCAL_PYTHON") == 1
            for e in expanded:
                k = ("builtin", str(e.get("manifest") or e.get("command") or ""))
                if k in seen:
                    continue
                seen.add(k)
                # Les clés propres à l'appelant (filtre, drapeaux) sont
                # conservées ; l'entrée garde son identité (nom, manifeste,
                # familles) — sans quoi dix entrées porteraient le même nom.
                if e.get("command") == "DEFAULT_LOCAL_PYTHON":
                    e = {**cfg, **e}
                    if solo:
                        e["name"] = cfg.get("name") or e.get("name")
                out.append(e)
            continue
        out.append(cfg)
    return out


async def _collect_mcp_tools(
    mcp_configs: List[Dict[str, Any]],
    builtin_tools: Optional[Dict[str, Any]],
    on_event: Optional[Callable],
    keywords_text: str = "",
    allowed_tool_names: Optional[set] = None,
    memory_enabled: bool = True,
    deny_tool_names: Optional[set] = None,
    read_only: bool = False,
) -> Tuple[Dict[str, Dict], List[Dict], Dict[str, Callable], List[str]]:
    """Connect to every MCP server, collect their tools + filter by category.

    Returns a 4-tuple :
        tool_cfg_map            tool_name → cfg (for later mcp_pool.call_tool)
        tools_payload           list of OpenAI-formatted tool definitions
        builtin_handlers        tool_name → callable (for local/RAG tools)
        connected_server_names  list of names for the "mode" event message

    Raises ``RuntimeError`` if configs were provided but nothing connected
    AND no builtin_tools are available — i.e. the chat would be impossible.

    ``deny_tool_names`` (défaut None) : couche de deny FINALE, appliquée aux
    tools MCP (Y COMPRIS catégories cachées) ET aux builtins — contrairement à
    ``allowed_tool_names`` qui laisse toujours passer les catégories cachées.
    Utilisée par le moteur de sous-agents (outil ``task``) pour retirer sans
    exception ``task``/``todowrite`` de la surface d'un enfant (anti-récursion),
    ``todowrite`` vivant dans la catégorie cachée ``task``. None → inchangé.

    ``read_only`` (défaut False) : mode LECTURE SEULE du chat (« /plan »).
    Ne survivent que les outils ANNOTÉS read-only — y compris dans les
    catégories cachées, qu'aucune exception ne fait passer ici. C'est une
    allow-list, donc fail-fermé : un outil sans annotation tombe.
    """
    _deny: set = set(deny_tool_names) if deny_tool_names else set()
    tool_cfg_map: Dict[str, Dict]     = {}
    tools_payload: List[Dict]         = []
    connected_server_names: List[str] = []

    # Manifest-backed categorization. `categorize()` does an exact-name
    # lookup against the generated manifest (no hand-maintained allow-list).
    # Hidden categories (e.g. `task` → todowrite) are ALWAYS kept available
    # to the model, regardless of the user's filter_categories selection —
    # they're model-side aids, not user-facing capabilities.
    from llm_core._mcp_categories import (
        categorize as _categorize,
        get_hidden_categories as _get_hidden_categories,
        manifest_source as _manifest_source,
    )
    _hidden_cats = set(_get_hidden_categories())
    # registry_source() returns "live" | "static" | "empty" — we have a
    # usable registry whenever it is not "empty".
    _manifest_ok = _manifest_source() != "empty"

    # ── tool_gating config-driven (context_config) ────────────────────────
    # Modèle SÛR « drop-listed » : on ne masque QUE les catégories listées dans
    # tool_gating.gated et seulement si aucun de leurs mots-clés n'apparaît dans
    # le dernier message user. Catégories non listées / cachées / inconnues =
    # toujours exposées. ``_gated_out(name)`` couvre aussi le kill-switch par
    # outil (tools.<name>.enabled=false). Désactivable via tool_gating.enabled.
    _CTX: Any
    try:
        from llm_core.context_config import CTX as _CTX
    except Exception:  # noqa: BLE001 — réglages illisibles : aucun filtrage par réglage
        _CTX = None
    _dropped_by_gate = 0

    def _gated_out(_name: str, _explicit_cats: frozenset = frozenset()) -> bool:
        if _CTX is None or not _name:
            return False
        if not _CTX.tool_enabled(_name):          # kill-switch (hors gating)
            return True
        if not _CTX.gating_enabled():
            return False
        _cat = _categorize(_name)
        if not _cat or _cat in _hidden_cats:      # caché / inconnu → toujours dispo
            return False
        # Une catégorie EXPLICITEMENT activée par l'utilisateur dans le
        # panneau MCP (``filter_categories``) ne doit JAMAIS être masquée par le
        # gating par mots-clés : l'utilisateur l'a demandée à la main. Le gating
        # ne sert qu'à réduire le bruit des outils AUTO-inclus. Sans ce garde,
        # activer « Navigateur » (cat. browser, gated par défaut) ferait
        # disparaître tous les pw_* car aucun mot-clé ne matche ci-dessous.
        if _cat in _explicit_cats:
            return False
        # DÉCISION — l'auto-gating par mots-clés (``keywords_text``) reste
        # volontairement NON câblé : fail-OUVERT.
        # Le set d'outils est déjà contrôlé, en amont, par la sélection
        # EXPLICITE du panneau (``filter_categories``), PERSISTÉE par chat
        # (set_chat_tools/meta_json) — donc STABLE au sein d'un chat,
        # ce qui préserve le prefix-cache KV (exigence dure). Un gating auto
        # par mots-clés ferait VARIER le set d'outils au fil des messages
        # → invalidation du cache + « l'outil a disparu », pour un bénéfice
        # qui recoupe le contrôle explicite. On sur-expose plutôt que de
        # cacher (cohérent avec le repli « manifest indisponible » plus bas).
        # ``keywords_text`` reste dans la signature pour un opt-in futur borné.
        if not keywords_text:
            return False
        return _CTX.category_gated_out(_cat, keywords_text)

    # Connexions EN PARALLÈLE : en série, au rafraîchissement du cache
    # d'outils (TTL 360 s) ou après éviction (10 min d'inactivité), les coûts
    # spawn/handshake/list_tools s'additionneraient sur le chemin critique
    # avant le premier token. On connecte tout de front — le pool sérialise
    # par CLÉ, pas entre serveurs (cf. _key_lock) — puis on filtre en série
    # dans l'ordre des configs (ordre de ``connected_server_names`` préservé).
    # La SENTINELLE (« le service d'outils intégré ») se
    # développe en TOUTES les entrées intégrées du manifeste — service partagé
    # + MCP interne de l'app (mémoire, todo, graphiques, bibliothèque de
    # skills) — avec les mêmes catégories. Un seul point, pour la route de
    # chat, les sous-agents, les routines et le pré-chauffage.
    mcp_configs = _expand_builtin_configs(mcp_configs)
    _conn_results: List[Any] = []
    if mcp_configs:
        _conn_results = await asyncio.gather(
            *(_mcp_pool.mcp_pool.get_or_connect(cfg, resolve_client_fn=_resolve_mcp_client)
              for cfg in mcp_configs),
            return_exceptions=True,
        )

    for cfg, _conn in zip(mcp_configs, _conn_results):
        allowed_cats = cfg.get("filter_categories")
        try:
            if isinstance(_conn, asyncio.CancelledError):
                # Annulation d'un ENFANT isolé (cancel-scope d'un transport
                # MCP) : le parent annulé aurait fait lever ``gather`` lui-même.
                # Un serveur défaillant ne doit pas tuer le tour comme un Stop.
                _conn = RuntimeError("connexion MCP annulée")
            if isinstance(_conn, BaseException):
                raise _conn
            _client, raw_tools = _conn

            # Category filtering. We categorize each *actually exposed*
            # tool via the manifest and keep it if either:
            #   • its category is in the user's allowed_cats, OR
            #   • its category is hidden (always-on, e.g. todowrite).
            # If the manifest is missing (MCP server not restarted yet),
            # filtering is inert — we pass everything through rather than
            # silently dropping every tool.
            #
            # ``_manifest_ok`` et ``_hidden_cats`` sont RELUS ici, après la
            # connexion qui peuple le registre (``_connect_new`` →
            # ``ingest_tools``, faite dans le gather ci-dessus) ; la lecture
            # initiale ne vaut que sans serveur MCP (outils intégrés seuls).
            # Lus avant la connexion sur un worker froid (première
            # installation, pré-chauffage sauté, cache disque illisible), ils
            # vaudraient « empty » et le repli fail-open « passing all tools
            # through » donnerait à un utilisateur n'ayant coché que
            # « Fichiers » le TERMINAL et le CONTRÔLE D'ÉCRAN. Deux lectures
            # d'un dict en mémoire : coût nul.
            _manifest_ok = _manifest_source() != "empty"
            _hidden_cats = set(_get_hidden_categories())
            if allowed_cats is not None and _manifest_ok:
                allowed_set = set(allowed_cats) | _hidden_cats
                # Memory toggle (per-user, default OFF): when ON, let the
                # 'memory' category through the panel filter even though it is
                # NOT a panel-selectable category.
                if memory_enabled:
                    allowed_set.add("memory")
                kept = []
                for t in raw_tools:
                    t_name = getattr(t, "name", "") or t.get("name", "")
                    if _categorize(t_name) in allowed_set:
                        kept.append(t)
                raw_tools = kept
            elif allowed_cats is not None and not _manifest_ok:
                logger.warning(
                    "[_collect_mcp_tools] filter_categories=%s requested but "
                    "tool manifest is unavailable — passing all tools through. "
                    "Restart the MCP server to enable category filtering.",
                    allowed_cats,
                )

            # Per-user memory toggle (default OFF): drop the memory-category
            # tools unless explicitly enabled (see _apply_memory_gate).
            raw_tools = _apply_memory_gate(raw_tools, memory_enabled, _categorize)

            # Catégories explicitement activées par l'utilisateur pour CE serveur
            # (panneau MCP → ``filter_categories``). Elles court-circuitent le
            # tool_gating par mots-clés dans ``_gated_out`` ci-dessous.
            _explicit_cats = frozenset(allowed_cats) if allowed_cats else frozenset()
            for t in raw_tools:
                t_name = getattr(t, "name", "") or t.get("name", "")
                # Deny FINAL (moteur de sous-agents) : s'applique AVANT le bypass
                # des catégories cachées → retire ``todowrite`` (cat. cachée
                # ``task``) et ``task`` de la surface d'un enfant. Aucun bypass.
                if t_name in _deny:
                    continue
                # Lecture seule (« /plan ») : allow-list par ANNOTATION, avant
                # tout le reste et sans exception pour les catégories cachées.
                # Un outil non annoté tombe — c'est le point du fail-fermé.
                if read_only and not tool_traits(t_name, tool=t).read_only:
                    continue
                if _gated_out(t_name, _explicit_cats):
                    _dropped_by_gate += 1
                    continue
                # Allowlist par-outil (moteur d'agents) : un archétype expose
                # un SOUS-ENSEMBLE exact de tools. Les catégories cachées
                # (aides model-side, ex. todowrite) restent toujours dispo.
                if (
                    allowed_tool_names is not None
                    and t_name not in allowed_tool_names
                    and _categorize(t_name) not in _hidden_cats
                ):
                    continue
                # Un nom déjà fourni par un serveur précédent (ou deux fois par
                # le même) : PREMIER ARRIVÉ GAGNE. Annoncer les deux schémas
                # vaudrait un 400 chez Anthropic et OpenAI (noms d'outils
                # uniques exigés) et le routage partirait vers la DERNIÈRE
                # config. Un seul schéma annoncé, celui du serveur qui exécute.
                if t_name in tool_cfg_map:
                    logger.warning(
                        "[_collect_mcp_tools] outil '%s' déjà fourni par le "
                        "serveur '%s' — doublon du serveur '%s' ignoré",
                        t_name, (tool_cfg_map[t_name] or {}).get("name", "?"),
                        cfg.get("name", "?"))
                    continue
                tool_cfg_map[t_name] = cfg
                tools_payload.append(mcp_tool_to_openai(t))

            extra = f" ({', '.join(allowed_cats)})" if allowed_cats else ""
            connected_server_names.append(f"{cfg.get('name', '')}{extra}")

        except Exception as e:  # noqa: BLE001 — un serveur en panne n'interrompt pas le tour
            # ⚠ ``warning``, PAS ``error``. Le tour CONTINUE après cet échec —
            # les autres serveurs sont déjà connectés et le modèle va répondre.
            # Or côté front, ``error`` est TERMINAL : il marque le message
            # ``isError``, coupe ``isStreaming`` et annule les flux d'édition en
            # cours. Un seul serveur externe injoignable (Jenkins éteint, jeton
            # périmé) saborderait l'affichage de tout le tour.
            # ``warning`` rend le même texte en bandeau 12 s et laisse le tour
            # se dérouler. Le cas VRAIMENT fatal — aucun serveur connecté et
            # aucun builtin — lève un RuntimeError plus bas, qui lui produit
            # bien une erreur de tour.
            _srv_name = cfg.get("name", "?")
            logger.warning("[_collect_mcp_tools] serveur MCP '%s' injoignable : %r",
                           _srv_name, e)
            await _emit(on_event, {
                "type": "warning",
                # ``friendly_mcp_error`` aplatit les ExceptionGroup des
                # transports MCP : sans lui, un simple jeton périmé
                # s'afficherait en trace de task group, illisible pour qui doit
                # juste aller remettre son token dans le formulaire.
                "text": (f"Serveur d'outils « {_srv_name} » injoignable — ses "
                         f"outils sont absents de ce tour. "
                         f"{_friendly_mcp_error(e)}"),
            })

    # If configs were provided but no tools loaded → server(s) failed to connect.
    #
    # ⚠ « aucun outil » n'est PAS « aucune connexion ». Un filtrage peut
    # légitimement tout retirer : lecture seule (« /plan ») sur un chat dont
    # toutes les catégories cochées sont mutantes, par exemple. Sans la
    # nuance ci-dessous, l'utilisateur recevrait « Vérifiez la configuration
    # dans Paramètres → MCP » pour une connexion parfaitement saine — un
    # message qui l'envoie chercher une panne inexistante.
    # ``connected_server_names`` n'est peuplé qu'APRÈS une connexion réussie :
    # c'est lui qui départage les deux cas.
    if mcp_configs and not tool_cfg_map and not builtin_tools:
        if connected_server_names:
            logger.info(
                "[_collect_mcp_tools] connexion OK (%s) mais AUCUN outil ne "
                "passe les filtres%s — le tour se fera sans outils.",
                ", ".join(connected_server_names),
                " (mode lecture seule)" if read_only else "",
            )
        else:
            err_names = [c.get("name", "?") for c in mcp_configs]
            raise RuntimeError(
                f"Impossible de se connecter aux serveurs MCP : {', '.join(err_names)}. "
                "Vérifiez la configuration dans Paramètres → MCP."
            )

    # ── Inject built-in tools (RAG tools, etc.) ─────────────────────────
    # NB lecture seule (« /plan ») : les builtins ne portent PAS d'annotations
    # MCP (ce sont des paires definition/handler construites pour l'appel), on
    # ne peut donc rien prouver à leur sujet ici — leur appliquer le fail-fermé
    # supprimerait le RAG, qui est de la consultation et a toute sa place dans
    # un chat en lecture seule. La barrière pour eux est ``deny_tool_names`` :
    # l'appelant y met ``task`` (un sous-agent, lui, écrirait). Cf. la route de
    # génération, qui construit ce deny.
    builtin_handlers: Dict[str, Callable] = {}
    if builtin_tools:
        for bt_name, bt_info in builtin_tools.items():
            # Deny FINAL (moteur de sous-agents) : un enfant ne reçoit jamais le
            # builtin ``task`` (anti-récursion), même transmis par mégarde.
            if bt_name in _deny:
                continue
            if _gated_out(bt_name):
                _dropped_by_gate += 1
                continue
            # NB : ``allowed_tool_names`` ne s'applique PAS aux builtins. Ce filtre
            # restreint la surface LARGE du serveur MCP local (ex. un sous-ensemble
            # de ``fs``). Les builtins sont au contraire construits EXPLICITEMENT
            # pour cet appel (ex. RAG tools) : ils doivent TOUJOURS être exposés,
            # sinon le modèle voit dans son prompt un outil qu'il ne peut pas
            # appeler → « outil indisponible ».
            # Homonyme d'un outil MCP : le BUILTIN gagne. C'est lui que
            # ``_execute_single_tool_call`` route en premier, et il est construit
            # explicitement pour cet appel (cf. ci-dessus) : on retire donc le
            # schéma et la route MCP, sinon ``tools[]`` porte deux fois le nom
            # et le schéma lu par le modèle n'est pas celui qui s'exécute.
            if bt_name in tool_cfg_map:
                logger.warning(
                    "[_collect_mcp_tools] builtin '%s' homonyme d'un outil du "
                    "serveur '%s' — le builtin prévaut, le schéma MCP est retiré",
                    bt_name, (tool_cfg_map[bt_name] or {}).get("name", "?"))
                del tool_cfg_map[bt_name]
                tools_payload = [
                    d for d in tools_payload
                    if ((d or {}).get("function") or {}).get("name") != bt_name]
            tools_payload.append(bt_info["definition"])
            builtin_handlers[bt_name] = bt_info["handler"]

    if _dropped_by_gate:
        logger.info(
            "[_collect_mcp_tools] tool_gating: %d outil(s) masqué(s) "
            "(hors profil actif ce tour)", _dropped_by_gate,
        )
    return tool_cfg_map, tools_payload, builtin_handlers, connected_server_names
