# SPDX-License-Identifier: MIT
"""Outil builtin ``task`` — sous-agents éphémères à contexte ISOLÉ.

Modèle OpenCode (``tool/task.ts``) adapté à ce harnais : le parent délègue une
sous-mission autonome à un agent enfant qui déroule SA PROPRE boucle agentique
(``run_chat_multi_mcp``) dans un contexte isolé, sur le MÊME modèle chargé, et
seul son TEXTE FINAL remonte au parent — enveloppé
``<task id="…" state="completed"><task_result>…</task_result></task>``. Les
lectures larges (30 fichiers, navigation web…) brûlent le contexte de l'enfant,
pas celui du chat principal.

Isolation (deux couches) : l'enfant ne reçoit JAMAIS ``task`` (pas de récursion)
ni ``todowrite`` — via le param ``deny_tool_names`` de ``run_chat_multi_mcp``,
qui s'applique aussi aux catégories cachées (``todowrite`` vit dans la catégorie
cachée ``task``) et aux builtins, contrairement à ``allowed_tool_names`` (T11).

Le builtin est construit PAR TOUR par ``build_task_builtin_tool(...)`` : son
handler capture par closure le contexte du tour parent (modèle, configs MCP,
toggles, ``is_cancelled``, ``on_event``, mode de scheduling). Câblé dans la route
chat à côté de ``build_rag_builtin_tools`` (llm_core/tools/rag_tools.py).

Gestion (parité OpenCode, 2026-07-18) :
- **Reprise ``task_id``** : re-passer l'id de l'enveloppe continue le MÊME enfant
  avec son historique (store in-process par worker, TTL/cap — best-effort ;
  reprise sur un autre worker → ``unknown_task_id`` propre). Vaut aussi pour
  les runs INTERROMPUS (timeout / échec / annulation ciblée) : le travail
  partiel est reconstruit depuis les events tool_call/tool_result et
  l'enveloppe d'erreur porte alors le ``task_id`` à reprendre.
- **Annulation par-enfant** : ``cancel_child(username, child_id)`` (endpoint
  ``POST /api/chat/task-cancel``) arrête UN enfant SANS tuer le tour parent —
  le modèle reçoit une enveloppe ``task_cancelled`` et continue.
- **Récursion opt-in** : ``TASK_SUBAGENT_DEPTH`` (modèle OpenCode v1.18.3,
  défaut 1) — un enfant à profondeur d reçoit lui-même le builtin ``task``
  ssi d+1 < N.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import secrets
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field, replace
from datetime import datetime
from itertools import count
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from llm_core._constants import (
    TASK_CHILD_TIMEOUT_S,
    TASK_MAX_ITERS_CUSTOM,
    TASK_MAX_ITERS_EXPLORE,
    TASK_MAX_ITERS_IMPLEMENT,
    TASK_MAX_ITERS_PR,
    TASK_MAX_ITERS_VERIFY,
    TASK_MAX_ITERS_WEB,
    TASK_RESULT_PERSIST_CAP,
    TASK_RESUME_MAX,
    TASK_RESUME_TTL_S,
    TASK_SUBAGENT_DEPTH,
)
from llm_core._system_prompts import load_agent_persona
from llm_core.context.pruning import emit_cap_chars, truncate_head_tail
from llm_core.tools import _task_resume
from llm_core.tools._toolkit import err
from shared_infra.observability.usage_ctx import usage_scope

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Registres in-process (PAR WORKER)
# ─────────────────────────────────────────────────────────────────────────────
# ⚠ L'app tourne en gunicorn MULTI-worker (``server/gunicorn_conf.py`` :
# ``workers = cpu-1`` dès 3 vCPU) et les requêtes sont distribuées sans
# affinité. Un registre module-level ne voit donc que SON process — l'ancienne
# note « déploiement single-worker assumé » était fausse et a coûté deux
# fonctionnalités silencieusement inertes :
#   * le ✕ par-agent → réglé par le bus (``cancel_child`` / ``apply_child_cancel``) ;
#   * la reprise ``task_id`` → réglée par le store partagé (``_task_resume``).
# Tout nouvel état à durée de vie inter-requêtes doit passer par l'un des deux.

# Enfants ACTIFS : (username, child_id) → méta (agent, chat parent, t0).
_ACTIVE_CHILDREN: Dict[Tuple[str, str], Dict[str, Any]] = {}
# Annulations CIBLÉES par-enfant (endpoint task-cancel). Lue par le
# ``is_cancelled`` composite de l'enfant ; nettoyée en fin de run.
_CANCELLED_CHILDREN: Set[Tuple[str, str]] = set()

# Store de REPRISE : (username, child_id) → {"agent", "messages", "ts"}.
# ``messages`` = liste PRÊTE pour la prochaine reprise (système persona +
# tours précédents expansés + dernier rapport). TTL + cap, prune à l'accès.
_RESUME_STORE: "OrderedDict[Tuple[str, str], Dict[str, Any]]" = OrderedDict()
# AUDIT 2026-09-26 — le store est muté depuis des threads (``to_thread`` :
# enregistrement, élagage, relecture) : sans verrou, l'élagage pouvait lever
# « OrderedDict mutated during iteration » et remplacer le résultat d'un
# sous-agent pourtant terminé par une erreur d'outil.
_RESUME_LOCK = threading.RLock()


def apply_child_cancel(username: str, child_id: str) -> bool:
    """Applique LOCALEMENT une demande d'annulation d'enfant.

    Ne pose le flag que si l'enfant est ACTIF sur CE worker — un flag « au cas
    où » n'était nettoyé que par le ``finally`` d'un run : un cancel raté
    (enfant d'un autre worker, run déjà fini) fuirait pour toujours dans
    ``_CANCELLED_CHILDREN``. Les ``child_id`` étant uniques par run
    (``t{n}-{hex}``), un écho tardif du bus ne peut pas frapper un homonyme.

    Point d'entrée du tailer de ``shared_infra.runtime.cancel_bus`` — et de
    ``cancel_child`` pour le worker qui reçoit la requête.
    """
    key = (str(username), str(child_id))
    active = key in _ACTIVE_CHILDREN
    if active:
        _CANCELLED_CHILDREN.add(key)
    return active


def cancel_child(username: str, child_id: str) -> bool:
    """Annule UN sous-agent sans toucher au tour parent (point 3 de l'analyse
    gestion).

    Applique en direct sur CE worker PUIS diffuse sur le bus d'annulation.
    ⚠ Sans la diffusion, le ✕ n'agissait qu'une fois sur N (N = workers
    gunicorn) : l'enfant tourne dans le worker qui tient le stream, alors que
    ``POST /api/chat/task-cancel`` est une requête indépendante distribuée
    sans affinité — l'API répondait ``{"status": "cancelled"}`` pendant que
    l'agent continuait à consommer des tokens jusqu'à son terme. Exactement le
    problème que ``cancel_bus`` avait déjà réglé pour le Stop du chat.

    Le booléen renvoyé reste la réponse LOCALE (l'enfant était-il ici ?) :
    l'appelant ne peut pas savoir de façon synchrone ce que feront les autres
    workers — ils appliquent sous ~100 ms via le tailer. Pas de course avec le
    spawn : le ✕ du front n'existe qu'après l'event ``spawned``, émis APRÈS
    l'enregistrement dans ``_ACTIVE_CHILDREN``.
    """
    active = apply_child_cancel(username, child_id)
    try:
        from shared_infra.runtime.cancel_bus import publish_child_cancel
        publish_child_cancel(str(username), str(child_id))
    except Exception as exc:                                    # noqa: BLE001
        logger.warning("[task_tool] diffusion cancel_child échouée (%r) — "
                       "annulation locale seule", exc)
    logger.info("[task_tool] cancel_child %s/%s (actif ici=%s, diffusé)",
                username, child_id, active)
    return active


def _prune_resume_store(now: Optional[float] = None) -> None:
    """TTL (depuis le plus ancien) + cap d'entrées. O(évictions).

    Applique la même politique au store PARTAGÉ sur disque (best-effort).
    """
    now = now if now is not None else time.time()
    with _RESUME_LOCK:
        while _RESUME_STORE:
            _k, _v = next(iter(_RESUME_STORE.items()))
            if now - _v.get("ts", 0) > TASK_RESUME_TTL_S:
                _RESUME_STORE.pop(_k, None)
            else:
                break
        while len(_RESUME_STORE) > TASK_RESUME_MAX:
            _RESUME_STORE.popitem(last=False)
    try:
        _task_resume.prune(TASK_RESUME_TTL_S, TASK_RESUME_MAX, now)
    except Exception:                                           # noqa: BLE001
        pass


def _resume_lookup(username: str, child_id: str) -> Optional[Dict[str, Any]]:
    """Enregistrement de reprise pour ``task_id``, mémoire PUIS disque.

    Le dictionnaire module-level ne vit que dans SON worker : la reprise d'un
    tour à l'autre (nouvelle requête HTTP, worker arbitraire sous gunicorn)
    répondait ``unknown_task_id`` alors que l'enveloppe venait justement de
    proposer ce ``task_id`` au modèle. Le store partagé rattrape ce cas ; le
    dictionnaire reste le cache chaud, ré-hydraté au passage.
    """
    key = (str(username), str(child_id))
    with _RESUME_LOCK:
        rec = _RESUME_STORE.get(key)
    if rec is not None:
        # AUDIT 2026-09-24 (point 11) — le cache L1 était servi SANS regarder
        # le disque. Or un AUTRE worker a pu reprendre cet agent depuis
        # (nouvelle requête sans affinité) et réécrire le store partagé : ce
        # worker-ci repartait alors de SA version périmée, puis écrasait sur
        # disque le travail plus récent. On compare l'horodatage du disque
        # (``peek_ts`` : un simple ``stat`` — ``put`` cale la mtime du fichier
        # sur le ``ts`` du record — pas la relecture d'un JSON de plusieurs
        # Mo) à celui du L1. Marge d'1 ms : arrondi flottant ↔ nanosecondes.
        try:
            _disk_ts = _task_resume.peek_ts(str(username), str(child_id))
        except Exception:                                       # noqa: BLE001
            _disk_ts = None
        if _disk_ts is None or _disk_ts <= float(rec.get("ts") or 0) + 1e-3:
            return rec
        # Le disque est plus récent : on le relit et on remplace le L1.
    try:
        _disk = _task_resume.get(str(username), str(child_id), TASK_RESUME_TTL_S)
    except Exception:                                           # noqa: BLE001
        _disk = None
    if _disk is None:
        return rec
    if rec is not None and float(_disk.get("ts") or 0) <= float(rec.get("ts") or 0):
        return rec
    with _RESUME_LOCK:
        _RESUME_STORE[key] = _disk
        _RESUME_STORE.move_to_end(key)
    return _disk


def _expand_child_history(hist: Any) -> List[Dict[str, Any]]:
    """``tool_history`` (séquence OpenAI produite par la boucle, cf.
    _expand_history_for_llm côté route — dupliqué ici pour ne pas faire dépendre
    llm_core de chatbot_app) → messages assistant(tool_calls)/tool/user."""
    out: List[Dict[str, Any]] = []
    for _h in (hist or []):
        if not isinstance(_h, dict):
            continue
        _r = _h.get("role")
        if _r not in ("assistant", "tool", "user"):
            continue
        _m: Dict[str, Any] = {"role": _r}
        if "content" in _h:
            _m["content"] = _h.get("content")
        if _r == "assistant" and _h.get("tool_calls"):
            _m["tool_calls"] = _h["tool_calls"]
        if _r == "tool" and _h.get("tool_call_id"):
            _m["tool_call_id"] = _h["tool_call_id"]
        out.append(_m)
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Registre des types d'agents
# ─────────────────────────────────────────────────────────────────────────────

# Deny appliqué à TOUS les enfants : anti-récursion (``task``), pas de todo-list
# d'enfant (``todowrite``), pas de questionnaire interactif (``ask_user`` — un
# enfant n'a AUCUNE UI : le panneau ne s'affiche pas et « la réponse dans le
# prochain message user » n'existe pas pour lui). Cf. OpenCode
# agent/subagent-permissions.ts.
_DENY_BASE: Set[str] = {"task", "todowrite", "ask_user"}

# NOTE (2026-08-06) — les allowlists PAR OUTIL (``_READ_TOOLS``, ``_WEB_TOOLS``
# et les ensembles nommés dans ``_AGENTS``) ont été SUPPRIMÉES. Un sous-agent est
# désormais un chat dont les toggles du panneau Outils sont PRÉ-COCHÉS : il
# reçoit des CATÉGORIES ENTIÈRES, comme n'importe quelle conversation. Voir
# ``_AGENTS`` juste en dessous pour le raisonnement.


@dataclass(frozen=True)
class AgentSpec:
    """Définition d'un type de sous-agent.

    persona_stem       fichier system_prompts/<stem>.md (tête système de l'enfant)
    summary            une ligne pour le roster injecté dans la description du tool
    filter_categories  catégories du serveur local synthétique ; None = hérite la
                       surface complète du parent
    allowed_tool_names allowlist exacte par nom ; None = aucune restriction
    deny_extra         deny en plus de _DENY_BASE (ex. l'écriture mémoire pour un
                       agent qui hérite de la config du parent)
    max_iters          budget d'itérations tool-call de l'enfant
    inherit_config     True → configs MCP + builtins + mémoire HÉRITÉS du parent ;
                       False → serveur local synthétique dédié. AUCUN agent
                       intégré ne l'active depuis le casting de spécialistes ;
                       le mécanisme reste pour les surfaces héritées éventuelles
    persona_text       persona INLINE (agents custom, settings_json) — prime sur
                       ``persona_stem`` quand non-None
    mcp_server_ids     agents custom : ids de serveurs MCP EXTERNES de
                       l'utilisateur (settings.mcp_servers) à connecter EN PLUS
                       du serveur local synthétique — id inconnu = inerte
    """
    persona_stem: str
    summary: str
    filter_categories: Optional[List[str]]
    allowed_tool_names: Optional[Set[str]]
    max_iters: int
    inherit_config: bool
    deny_extra: Set[str] = field(default_factory=set)
    persona_text: Optional[str] = None
    mcp_server_ids: Optional[List[str]] = None


# Ordre stable → description du tool byte-stable d'un tour à l'autre (prefix KV).
#
# MODÈLE (2026-08-06) — un sous-agent EST un chat dont les toggles du panneau
# Outils sont PRÉ-COCHÉS. Il reçoit des CATÉGORIES ENTIÈRES, exactement comme une
# conversation où l'utilisateur active « Fichiers » et « Git » : tout ``fs``,
# tout ``git``, tout ``shell``. Plus aucune allowlist par outil.
#
# Pourquoi ce virage : le casting de spécialistes (2026-08-04) donnait 6 à 9
# outils nommés à la main par agent. Ça paraissait sûr et c'était en fait la
# cause des enfants qui n'arrivent à rien — il manquait toujours le geste
# suivant. Un explore qui ne peut pas lire l'historique d'un fichier RENOMMÉ, un
# implement qui ne peut pas supprimer le module qu'il remplace, un verify qui ne
# peut pas voir dans quel état est l'arbre : chacun s'arrête à un outil près, et
# le rapport dit « je n'ai pas l'outil » au lieu de répondre. Le panneau Outils
# ne demande jamais à l'utilisateur de cocher 8 outils parmi 55 — il coche
# « Fichiers ». Les agents suivent la même unité.
#
# Où vit la spécialisation, alors ?
#   1. dans les CATÉGORIES pré-cochées — un agent web n'a pas ``git``, un agent
#      pr n'a pas ``shell`` ;
#   2. dans la PERSONA — c'est elle qui dit « tu es en lecture seule », comme le
#      prompt système d'un chat. C'est une consigne, pas une barrière : le
#      manifeste ``# Active tools`` liste ce que l'agent a VRAIMENT, et chaque
#      persona en lecture seule nomme explicitement les outils d'écriture
#      qu'elle s'interdit (sinon elle contredirait le manifeste) ;
#   3. dans le BUDGET d'itérations, propre à chaque mission.
#
# ``_DENY_BASE`` reste la seule barrière dure (anti-récursion ``task``, pas de
# todo-list d'enfant, pas de ``ask_user`` — un enfant n'a aucune UI).
#
# Corollaire assumé : plus aucun enfant n'hérite des builtins du parent, donc
# plus de RAG ni de MCP externes en sous-agent intégré (les agents custom ont
# ``mcp_server_ids`` pour ça).
_AGENTS: "OrderedDict[str, AgentSpec]" = OrderedDict([
    ("explore", AgentSpec(
        persona_stem="AGENT_TASK_EXPLORE",
        summary="read-only codebase exploration — locate code, read it, judge it, git history",
        filter_categories=["fs", "git"],
        allowed_tool_names=None,
        max_iters=TASK_MAX_ITERS_EXPLORE,
        inherit_config=False,
    )),
    ("implement", AgentSpec(
        persona_stem="AGENT_TASK_IMPLEMENT",
        summary="writes the code change in the sandbox and verifies it (does not commit)",
        filter_categories=["fs", "shell", "git"],
        allowed_tool_names=None,
        max_iters=TASK_MAX_ITERS_IMPLEMENT,
        inherit_config=False,
    )),
    ("verify", AgentSpec(
        persona_stem="AGENT_TASK_VERIFY",
        summary="runs tests and commands, diagnoses failures, changes nothing",
        filter_categories=["shell", "fs", "git"],
        allowed_tool_names=None,
        max_iters=TASK_MAX_ITERS_VERIFY,
        inherit_config=False,
    )),
    ("web", AgentSpec(
        persona_stem="AGENT_TASK_WEB",
        summary="web research specialist driving a real browser (pw_* tools)",
        filter_categories=["browser", "fs"],
        allowed_tool_names=None,
        max_iters=TASK_MAX_ITERS_WEB,
        inherit_config=False,
    )),
    ("pr", AgentSpec(
        persona_stem="AGENT_TASK_PR",
        summary="branches, commits and opens the pull request for work already in the tree",
        filter_categories=["git", "fs"],
        allowed_tool_names=None,
        max_iters=TASK_MAX_ITERS_PR,
        inherit_config=False,
    )),
])


# ─────────────────────────────────────────────────────────────────────────────
# Agents CUSTOM (définis par l'utilisateur — settings_json.custom_agents)
# ─────────────────────────────────────────────────────────────────────────────

# Source de vérité UNIQUE des contraintes — le PUT /api/settings les importe.
AGENT_NAME_RE = re.compile(r"^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$")
# Seul « task » reste réservé. Un agent du compte qui porte le nom d'un INTÉGRÉ
# n'est plus une collision : c'est une SURCHARGE — les intégrés sont distribués
# en modèles, et l'entrée ne porte que les écarts (prompt, catégories, budget,
# serveurs, ``enabled``). Cf. docs/agents-bank-design-2026-09-11.md.
RESERVED_AGENT_NAMES: Set[str] = {"task"}
# Relevé 10 → 30 le 2026-08-30 : la liste est un CATALOGUE de spécialistes
# (un par domaine récurrent), pas une sélection. À 10, l'utilisateur arbitrait
# entre des agents utiles au lieu de les écrire. Le coût d'un agent inutilisé
# est une ligne dans le roster de la description du tool, pas un run.
CUSTOM_AGENTS_MAX = 30
CUSTOM_DESC_MAX = 200
# Budget d'itérations PROPRE à un agent custom (champ ``max_iters``, optionnel).
# Absent = le défaut ``TASK_MAX_ITERS_CUSTOM``. Plafond aligné sur le harnais
# parent (200) et très en dessous du clamp du loop (500).
CUSTOM_ITERS_MAX = 200
CUSTOM_PROMPT_MAX = 16000
CUSTOM_CATS_MAX = 12
CUSTOM_MCP_MAX = 8
_CAT_SLUG_RE = re.compile(r"^[a-z0-9_-]{1,32}$")

# Socle d'un agent custom qui n'a RIEN choisi. Un agent sans outils n'est pas un
# agent : il lit sa mission, ne peut rien en faire, et brûle son budget à le
# constater. Les intégrés tiennent leur surface de leur identité ; un agent
# custom n'en déclare pas en termes d'outils, on lui donne donc le socle de
# travail générique — celui d'``implement`` : lire, écrire, exécuter, inspecter.
#
# Ce défaut est ÉCRIT dans l'agent par ``validate_custom_agents`` (donc affiché
# en puces sur sa carte, et modifiable), jamais appliqué en douce au moment du
# lancement. ``_specs_from_custom`` l'applique aussi, pour les agents déjà
# enregistrés avec une liste vide avant cette règle.
CUSTOM_DEFAULT_CATEGORIES: List[str] = ["fs", "shell", "git"]


def custom_default_categories() -> List[str]:
    """Socle de catégories d'un agent custom qui n'en demande aucune.
    (2026-09-11) ``mcp.json › x-elpis.default_on`` du service intégré, s'il
    en déclare ; sinon le socle historique ``CUSTOM_DEFAULT_CATEGORIES``."""
    try:
        from shared_infra.mcp.manifest import load as _mf_load
        on = _mf_load().default_on_categories()
    except Exception:
        on = set()
    return sorted(on) if on else list(CUSTOM_DEFAULT_CATEGORIES)


def _norm_desc(raw: Any) -> str:
    """Description sur UNE ligne — elle est injectée dans le roster
    ``- name: summary`` de la description du tool, un ``\\n`` casserait le
    format. Collapse whitespace puis cap."""
    return " ".join(str(raw or "").split())[:CUSTOM_DESC_MAX]


def _free_agent_name(base: str, taken: Set[str]) -> str:
    """Nom libre dérivé de ``base``, pour un agent custom dont le nom est devenu
    RÉSERVÉ après coup.

    Le casting intégré peut bouger (2026-08-04 : ``general`` retiré,
    ``implement``/``verify``/``pr`` ajoutés). Un utilisateur qui avait créé un
    agent nommé ``pr`` — nom parfaitement libre la veille — se retrouvait
    sinon avec un PUT /api/settings en 400 sur le blob ENTIER : le panneau
    Paramètres re-poste tout à chaque « Enregistrer », donc plus AUCUN réglage
    n'était enregistrable tant que l'agent n'était pas renommé à la main, et
    l'agent était silencieusement inerte au runtime en attendant.

    Renommer plutôt que refuser ne masque rien d'un nouveau conflit : le
    formulaire côté client refuse déjà un nom réservé saisi à la main
    (``RESERVED_AGENT_NAMES`` dans app-settings.js), donc ce chemin ne se
    déclenche que sur des données DÉJÀ stockées.
    """
    stem = (base or "agent")[:24].rstrip("-_") or "agent"
    for cand in [f"{stem}-custom"] + [f"{stem}-custom{i}" for i in range(2, 20)]:
        if cand not in taken and cand not in RESERVED_AGENT_NAMES:
            return cand
    return f"{stem[:20].rstrip('-_') or 'agent'}-{secrets.token_hex(3)}"


def validate_custom_agents(raw: Any) -> List[Dict[str, Any]]:
    """Valide/normalise la liste ``custom_agents`` pour le PUT settings.

    Lève ``ValueError`` (message précis, index 1-based) sinon retourne la liste
    CANONIQUE ``[{name, description, prompt, tool_categories}]``. Idempotent :
    re-valider une liste déjà canonique la renvoie identique (le bouton
    Enregistrer global re-PUT tout le blob à chaque fois).

    Ne lèvent QUE les fautes qu'un utilisateur peut commettre DANS le
    formulaire (nom, prompt, structure) — il peut les corriger et ré-enregistrer.
    Tout ce qui n'est pas saisissable à la main (slug de catégorie, id de
    serveur) est SAUTÉ avec un warning plutôt que refusé : un blob rejeté rend
    l'intégralité des réglages non enregistrable, et l'utilisateur n'aurait
    aucun moyen de retirer la valeur fautive depuis le panneau.
    """
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError("custom_agents doit être une liste.")
    if len(raw) > CUSTOM_AGENTS_MAX:
        raise ValueError(f"custom_agents : maximum {CUSTOM_AGENTS_MAX} agents.")
    out: List[Dict[str, Any]] = []
    seen: Set[str] = set()
    # Noms DEMANDÉS par la liste entrante : un renommage automatique ne doit pas
    # voler le nom d'un agent qui arrive plus loin dans la même liste.
    _incoming_names: Set[str] = {
        str(e.get("name") or "").strip().lower()
        for e in raw if isinstance(e, dict)
    }
    for i, entry in enumerate(raw, start=1):
        if not isinstance(entry, dict):
            raise ValueError(f"agent {i} : entrée invalide (objet attendu).")
        name = str(entry.get("name") or "").strip().lower()
        if not AGENT_NAME_RE.match(name):
            raise ValueError(
                f"agent {i} : nom invalide « {name} » (1-32 caractères a-z 0-9 - _, "
                "commence et finit par un alphanumérique).")
        if name in RESERVED_AGENT_NAMES:
            # Nom devenu réservé APRÈS coup (le casting intégré a bougé) : on
            # renomme au lieu de refuser, sinon le PUT échoue sur le blob
            # ENTIER et plus aucun réglage n'est enregistrable. Cf.
            # _free_agent_name pour le raisonnement complet.
            _renamed = _free_agent_name(name, seen | _incoming_names)
            logger.warning("[task_tool] agent custom « %s » renommé en « %s » "
                           "(nom devenu réservé par le casting intégré)", name, _renamed)
            name = _renamed
        if name in seen:
            raise ValueError(f"agent {i} : nom « {name} » en double.")
        seen.add(name)
        # Surcharge d'un intégré : le prompt est OPTIONNEL (vide = persona
        # livrée, qui continue de suivre ses mises à jour) ; les catégories
        # vides valent celles du modèle, pas le socle par défaut.
        is_override = name in _AGENTS
        prompt = str(entry.get("prompt") or "").strip()
        if not prompt and not is_override:
            raise ValueError(f"agent {i} ({name}) : prompt système requis.")
        if len(prompt) > CUSTOM_PROMPT_MAX:
            raise ValueError(
                f"agent {i} ({name}) : prompt trop long "
                f"({len(prompt)} > {CUSTOM_PROMPT_MAX} caractères).")
        cats_raw = entry.get("tool_categories") or []
        if not isinstance(cats_raw, list):
            raise ValueError(f"agent {i} ({name}) : tool_categories doit être une liste.")
        if len(cats_raw) > CUSTOM_CATS_MAX:
            raise ValueError(f"agent {i} ({name}) : maximum {CUSTOM_CATS_MAX} catégories.")
        # Slugs et ids ne sont PAS saisis à la main : le formulaire ne propose
        # que des cases à cocher (catégories du registre, serveurs de la liste).
        # Une valeur malformée vient donc TOUJOURS de données déjà stockées —
        # legacy, import, édition manuelle du blob — et l'utilisateur n'a aucun
        # moyen de la retirer depuis le panneau (un id absent de la liste n'a
        # pas de case à décocher). La refuser faisait échouer le PUT sur le blob
        # ENTIER, donc plus aucun réglage enregistrable, sans issue par l'UI :
        # même piège que les noms devenus réservés (cf. _free_agent_name). On
        # SAUTE l'entrée invalide — comme ``_specs_from_custom`` le fait déjà au
        # runtime — et la liste canonique renvoyée en porte la trace.
        cats: List[str] = []
        for c in cats_raw:
            slug = str(c or "").strip().lower()
            if not _CAT_SLUG_RE.match(slug):
                logger.warning("[task_tool] agent « %s » : catégorie invalide %r ignorée",
                               name, c)
                continue
            if slug not in cats:    # dédup, ordre préservé
                cats.append(slug)
        # PAS de validation contre le registre live des catégories (politique du
        # module _mcp_categories : registre vide = inconnu, ne pas rejeter) —
        # une catégorie inconnue est inerte (le filtre ne produit aucun outil).
        mcp_raw = entry.get("mcp_server_ids") or []
        if not isinstance(mcp_raw, list):
            raise ValueError(f"agent {i} ({name}) : mcp_server_ids doit être une liste.")
        if len(mcp_raw) > CUSTOM_MCP_MAX:
            raise ValueError(f"agent {i} ({name}) : maximum {CUSTOM_MCP_MAX} serveurs MCP.")
        mcp_ids: List[str] = []
        for s in mcp_raw:
            sid = str(s or "").strip()
            if not sid or len(sid) > 64:
                logger.warning("[task_tool] agent « %s » : id de serveur MCP "
                               "invalide %r ignoré", name, s)
                continue
            if sid not in mcp_ids:    # dédup, ordre préservé
                mcp_ids.append(sid)
        # Id inconnu = inerte (résolu contre settings.mcp_servers au tour) : ne
        # pas rejeter, la liste des serveurs évolue indépendamment des agents.
        if not cats and not mcp_ids and not is_override:
            # Aucun outil demandé : on POSE le socle par défaut au lieu de
            # laisser partir un agent qui ne peut rien faire. Écrit dans
            # l'entrée renvoyée ⇒ visible sur la carte de l'agent, et l'auteur
            # peut le restreindre ensuite (cf. CUSTOM_DEFAULT_CATEGORIES).
            cats = custom_default_categories()
        canon: Dict[str, Any] = {
            "name": name,
            "description": _norm_desc(entry.get("description")),
            "prompt": prompt,
            "tool_categories": cats,
            "mcp_server_ids": mcp_ids,
        }
        # Écrit UNIQUEMENT si l'agent en fixe un : sans ce champ il suit le
        # défaut, et suivra ses relèvements futurs.
        _iters = _norm_max_iters(entry.get("max_iters"))
        if _iters is not None:
            canon["max_iters"] = _iters
        # ``enabled`` n'est écrit QUE faux : absent = actif. Un intégré
        # désactivé disparaît de l'enum et du roster du tool ``task``.
        if entry.get("enabled") is False:
            canon["enabled"] = False
        if is_override and not any((canon["description"], canon["prompt"],
                                    canon["tool_categories"], canon["mcp_server_ids"],
                                    "max_iters" in canon, "enabled" in canon)):
            # Surcharge SANS écart : ne pas l'écrire. Le blob ne porte que ce
            # qui diffère du livré — « modifié » se lit donc sans comparer, et
            # « Réinitialiser » n'est qu'un effacement.
            continue
        out.append(canon)
    return out


def _norm_max_iters(raw: Any) -> Optional[int]:
    """Budget d'itérations d'un agent custom, ou ``None`` s'il n'en fixe pas.

    Absent, vide, zéro ou illisible → ``None`` : l'agent SUIT le défaut, et
    bénéficie donc d'un relèvement futur de celui-ci. Une valeur donnée est
    bornée à 1..``CUSTOM_ITERS_MAX`` au lieu d'être refusée — un budget hors
    borne vient d'un blob importé ou édité à la main, et faire échouer le PUT
    rendrait TOUS les réglages non enregistrables (même piège que les noms
    devenus réservés, cf. ``_free_agent_name``).
    """
    if raw is None or raw == "":
        return None
    try:
        v = int(raw)
    except (TypeError, ValueError):
        return None
    if v <= 0:
        return None
    return min(v, CUSTOM_ITERS_MAX)


def _cats_of(raw: Any) -> List[str]:
    """Slugs de catégories d'une entrée stockée : nettoyés, dédupliqués, ordre
    préservé. Version DÉFENSIVE (runtime) : rien ne lève."""
    cats: List[str] = []
    if isinstance(raw, list):
        for c in raw:
            slug = str(c or "").strip().lower()
            if _CAT_SLUG_RE.match(slug) and slug not in cats:
                cats.append(slug)
    return cats


def _mcp_ids_of(raw: Any) -> List[str]:
    ids: List[str] = []
    if isinstance(raw, list):
        for s in raw[:CUSTOM_MCP_MAX]:
            sid = str(s or "").strip()
            if sid and len(sid) <= 64 and sid not in ids:
                ids.append(sid)
    return ids


def _agents_roster(custom_agents: Optional[List[Dict[str, Any]]]) -> "OrderedDict[str, AgentSpec]":
    """Roster EFFECTIF d'un compte : les modèles intégrés, surchargés champ par
    champ par les entrées qui portent leur nom (``enabled: false`` les retire),
    puis les agents personnalisés.

    Sans entrée, strictement ``_AGENTS`` — la définition zéro-arg du tool reste
    byte-identique (préfixe KV inter-utilisateurs). Une surcharge REMPLACE en
    place : l'ordre des intégrés ne bouge pas, donc la définition par-user
    reste byte-stable d'un tour à l'autre."""
    roster: "OrderedDict[str, AgentSpec]" = OrderedDict(_AGENTS)
    for entry in (custom_agents or []):
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip().lower()
        base = _AGENTS.get(name)
        if base is None:
            continue
        if entry.get("enabled") is False:
            roster.pop(name, None)
            continue
        prompt = str(entry.get("prompt") or "").strip()[:CUSTOM_PROMPT_MAX]
        cats = _cats_of(entry.get("tool_categories"))
        mcp_ids = _mcp_ids_of(entry.get("mcp_server_ids"))
        roster[name] = replace(
            base,
            persona_text=prompt or None,            # None → fichier persona livré
            summary=_norm_desc(entry.get("description")) or base.summary,
            filter_categories=cats or base.filter_categories,
            max_iters=_norm_max_iters(entry.get("max_iters")) or base.max_iters,
            mcp_server_ids=mcp_ids or None,
        )
    roster.update(_specs_from_custom(custom_agents))
    return roster


def has_active_agents(custom_agents: Optional[List[Dict[str, Any]]]) -> bool:
    """Vrai si au moins un agent reste actif — sinon l'outil ``task`` n'est pas
    exposé (cf. ``build_task_builtin_tool``)."""
    return bool(_agents_roster(custom_agents))


def agent_templates() -> List[Dict[str, Any]]:
    """Les intégrés tels que livrés — ce que le formulaire PRÉ-REMPLIT quand on
    ouvre un modèle, persona entière comprise."""
    return [{
        "name": name,
        "summary": spec.summary,
        "prompt": load_agent_persona(spec.persona_stem),
        "tool_categories": list(spec.filter_categories or []),
        "max_iters": int(spec.max_iters),
    } for name, spec in _AGENTS.items()]


def _specs_from_custom(custom_agents: Optional[List[Dict[str, Any]]]) -> "OrderedDict[str, AgentSpec]":
    """Map ``name → AgentSpec`` des agents custom. Version DÉFENSIVE : le blob
    settings peut porter du legacy — les entrées invalides sont SKIPPÉES
    (warning), jamais bloquantes. Ordre stocké préservé (définition du tool
    byte-stable PAR USER d'un tour à l'autre).

    Un nom devenu RÉSERVÉ (le casting intégré a bougé) est RENOMMÉ, pas skippé :
    même règle que ``validate_custom_agents``, pour que l'agent reste utilisable
    dès le tour suivant sans attendre un passage par le panneau Paramètres. Le
    renommage étant déterministe, la définition du tool reste byte-stable."""
    out: "OrderedDict[str, AgentSpec]" = OrderedDict()
    _incoming: Set[str] = {
        str(e.get("name") or "").strip().lower()
        for e in (custom_agents or []) if isinstance(e, dict)
    }
    for entry in (custom_agents or []):
        try:
            if not isinstance(entry, dict):
                raise ValueError("entrée non-objet")
            name = str(entry.get("name") or "").strip().lower()
            if name in _AGENTS:
                continue            # surcharge d'un intégré : cf. _agents_roster
            if entry.get("enabled") is False:
                continue            # désactivé : absent du roster
            if AGENT_NAME_RE.match(name) and name in RESERVED_AGENT_NAMES:
                name = _free_agent_name(name, set(out) | _incoming)
            prompt = str(entry.get("prompt") or "").strip()
            if not AGENT_NAME_RE.match(name) or name in RESERVED_AGENT_NAMES or name in out:
                raise ValueError(f"nom invalide/réservé/dupliqué : {name!r}")
            if not prompt:
                raise ValueError(f"prompt vide : {name!r}")
            cats = _cats_of(entry.get("tool_categories"))
            mcp_ids = _mcp_ids_of(entry.get("mcp_server_ids"))
            # Même règle que ``validate_custom_agents``, appliquée ici pour les
            # agents ENREGISTRÉS AVANT cette version (blob settings inchangé
            # tant que l'utilisateur ne rouvre pas le panneau) : un agent sans
            # aucun outil ne part jamais au travail les mains vides.
            if not cats and not mcp_ids:
                cats = custom_default_categories()
            out[name] = AgentSpec(
                persona_stem="",
                summary=_norm_desc(entry.get("description")) or "custom agent",
                filter_categories=cats,
                allowed_tool_names=None,
                max_iters=_norm_max_iters(entry.get("max_iters")) or TASK_MAX_ITERS_CUSTOM,
                inherit_config=False,
                persona_text=prompt[:CUSTOM_PROMPT_MAX],
                mcp_server_ids=mcp_ids,
            )
        except ValueError as e:
            logger.warning("[task_tool] agent custom ignoré : %s", e)
    return out


def _build_definition(agents: "Optional[OrderedDict[str, AgentSpec]]" = None) -> Dict[str, Any]:
    """Definition OpenAI du tool ``task``, description augmentée du roster
    (style OpenCode : « Available agent types »). Ordre stable ⇒ byte-stable ;
    l'appel ZÉRO-ARG (builtins seuls) reste byte-identique quel que soit
    l'utilisateur — la variante avec agents custom n'est stable que par-user."""
    agents = agents if agents is not None else _AGENTS
    roster = "\n".join(f"- {name}: {spec.summary}" for name, spec in agents.items())
    description = (
        "Launch an ephemeral sub-agent to handle a well-scoped sub-mission "
        "autonomously and report back. The agent runs its OWN tool loop in an "
        "isolated context (on the same model) and returns a single final report; "
        "its intermediate steps stay out of this conversation.\n\n"
        "Available agent types (subagent_type):\n"
        f"{roster}\n\n"
        "Usage notes:\n"
        "1. Fresh context by default: without task_id the agent starts blank, so the "
        "prompt MUST be a complete, autonomous brief — include all needed context and "
        "state EXPLICITLY what the final report must contain (paths, line numbers, "
        "quotes, links, values).\n"
        "2. The result carries an id: pass it back as task_id to CONTINUE the same "
        "agent with its previous context (follow-up questions, refinements). This "
        "also works after a timeout/failure/cancellation when the error envelope "
        "carries a task_id — the agent resumes from its partial work. Best "
        "effort — if it expired, you get an error and should start fresh.\n"
        "3. The agent's work is NOT shown to the user: always restate the result in "
        "your own answer.\n"
        "4. When NOT to use: reading one known file (read it directly), a trivial 1-2 "
        "call lookup, or anything needing user interaction mid-task.\n"
        "5. You may request several independent tasks in one message; they run one "
        "after another."
    )
    return {
        "type": "function",
        "function": {
            "name": "task",
            "description": description,
            "parameters": {
                "type": "object",
                "properties": {
                    "description": {
                        "type": "string",
                        "description": "A short (5-6 word) description of the task.",
                    },
                    "prompt": {
                        "type": "string",
                        "description": "The complete, autonomous brief for the agent to perform.",
                    },
                    "subagent_type": {
                        "type": "string",
                        "enum": list(agents.keys()),
                        "description": "Which agent type to use: " + ", ".join(agents.keys()) + ".",
                    },
                    "task_id": {
                        "type": "string",
                        "description": "Only to resume: the id from a previous task result — continues that agent with its context. Omit to start fresh.",
                    },
                },
                "required": ["description", "prompt", "subagent_type"],
            },
        },
    }


def _preview(args: Any, maxlen: int = 120) -> str:
    """Résumé court des args d'un tool-call enfant, pour l'UI (mini-transcript)."""
    try:
        s = json.dumps(args, ensure_ascii=False, separators=(",", ":")) if not isinstance(args, str) else args
    except (TypeError, ValueError):
        s = str(args)
    s = " ".join(s.split())
    return s if len(s) <= maxlen else s[: maxlen - 1] + "…"


def _child_env_block(spec: AgentSpec, timeout_s: int) -> str:
    """Bloc ``<task_env>`` ajouté à la persona : date + budget réel de l'enfant.

    Le ``<runtime_context>`` sandbox est injecté par le fold de l'enfant (fs/git)
    → pas de duplication ici, et SURTOUT pas de règle de chemins concurrente.

    Audit « limites fantômes » 2026-07-31 — ce bloc se terminait par « Always use
    absolute paths. » alors que le ``<runtime_context>`` fusionné dans le MÊME
    message système dit l'inverse (tout est relatif à la racine du sandbox,
    ``path="/tmp/foo"`` est refusé). L'enfant lisait donc une consigne et son
    contraire, et brûlait des itérations en chemins absolus rejetés — exactement
    la boucle que ``build_runtime_sandbox_context`` existe pour supprimer.
    """
    return (
        "<task_env>\n"
        f"Date: {datetime.now().strftime('%Y-%m-%d')}\n"
        f"Budget: {spec.max_iters} tool iterations, up to {timeout_s // 60} minutes "
        "wall-clock. Finish with a clean final report BEFORE the budget runs out.\n"
        "</task_env>"
    )


# ─────────────────────────────────────────────────────────────────────────────
# Enveloppe de retour (modèle OpenCode)
# ─────────────────────────────────────────────────────────────────────────────

def _render_result(child_id: str, text: str) -> str:
    """Enveloppe succès ``<task ...><task_result>…</task_result></task>``.
    Texte vide → task_result vide (fidèle OpenCode : l'enfant a fini sur un
    tool-call ou sans texte)."""
    return (
        f'<task id="{child_id}" state="completed">\n'
        "<task_result>\n"
        f"{text or ''}\n"
        "</task_result>\n"
        "</task>"
    )


# ─────────────────────────────────────────────────────────────────────────────
# Factory (appelée PAR TOUR par la route)
# ─────────────────────────────────────────────────────────────────────────────

def build_task_builtin_tool(
    *,
    parent_mcp_configs: List[Dict[str, Any]],
    parent_builtin_tools: Optional[Dict[str, Any]],
    username: str,
    chat_id: Optional[str],
    model: Optional[str],
    sampling_override: Optional[Dict[str, Any]],
    memory_enabled: bool,
    is_cancelled: Optional[Callable[[], bool]],
    on_event: Optional[Callable],
    scheduling_mode: str,
    usage_sink: Optional[Dict[str, Any]] = None,
    custom_agents: Optional[List[Dict[str, Any]]] = None,
    user_mcp_configs: Optional[List[Dict[str, Any]]] = None,
    user_id: Optional[int] = None,
    depth: int = 0,
    priority: str = "high",
) -> Dict[str, Any]:
    """Construit ``{"task": {"definition", "handler"}}`` pour ``builtin_tools``.

    ``priority`` (AUDIT 2026-09-25) : priorité d'ordonnancement des appels LLM
    de l'enfant — celle du PARENT. Une routine (``low``) lançait ses
    sous-agents en ``high`` : ils passaient devant les chats interactifs.

    Toutes les dépendances du tour parent sont capturées par closure :
    ``model`` (héritage explicite du modèle courant), ``parent_mcp_configs`` /
    ``parent_builtin_tools`` (surface héritée par un agent ``inherit_config``),
    ``is_cancelled`` (annulation pilotée par le PARENT), ``on_event`` (relais UI),
    ``scheduling_mode`` (choix du runner enfant, cf. sémaphore réentrant).

    ``depth`` = profondeur de CE spawner (0 = le chat). Un enfant reçoit
    lui-même le builtin ``task`` ssi ``depth+1 < TASK_SUBAGENT_DEPTH``.

    ``custom_agents`` = définitions per-user (settings_json, déjà validées au
    PUT ; re-filtrées défensivement ici) qui ÉTENDENT le registre builtin —
    enum, roster et résolution du handler voient la map effective.

    ``user_mcp_configs`` = liste COMPLÈTE des serveurs MCP configurés par
    l'utilisateur (settings.mcp_servers) — les agents custom y résolvent leurs
    ``mcp_server_ids`` (serveurs connectés à l'enfant même s'ils ne sont pas
    actifs dans le chat parent). Les builtins n'y touchent jamais.

    ``user_id`` = propriétaire du run, utilisé UNIQUEMENT pour l'index des
    skills d'un enfant qui possède la catégorie ``skill`` (cf. plus bas). None
    = pas d'index (dégradation propre, l'enfant garde ses outils).
    """
    _counter = count(1)
    # Registre EFFECTIF de ce tour : builtins puis agents custom de l'utilisateur
    # (ordre stocké). Sans customs, strictement équivalent à _AGENTS — la
    # définition zéro-arg reste byte-identique (prefix KV inter-users).
    _agents_map: "OrderedDict[str, AgentSpec]" = _agents_roster(custom_agents)
    if not _agents_map:
        # Banque entièrement désactivée : ``subagent_type`` aurait un enum VIDE,
        # que le convertisseur grammaire de llama.cpp transforme en valeur
        # impossible (``()``) → requête refusée (« Unable to generate parser »)
        # ou appel au JSON invalide. Pas d'agent = pas d'outil.
        return {}

    async def _handle_task(args: Dict[str, Any]) -> str:
        if not isinstance(args, dict):
            return json.dumps(err("bad_args", "task expects an object argument"))
        agent_type = str(args.get("subagent_type") or "").strip()
        prompt = str(args.get("prompt") or "").strip()
        task_id = str(args.get("task_id") or "").strip()
        description = str(args.get("description") or "").strip()[:90] or agent_type

        if not prompt:
            return json.dumps(err(
                "empty_prompt",
                "the task prompt is empty",
                fix="pass a complete, autonomous brief in `prompt`",
            ))

        # ── Reprise ``task_id`` : le record stocké PRIME (agent + historique) ──
        resumed: Optional[Dict[str, Any]] = None
        if task_id:
            # AUDIT 2026-08-31 (passe 4, B8) — prune (scan disque) + lookup
            # (lecture d'un record jusqu'à 8 Mo) hors de la boucle.
            await asyncio.to_thread(_prune_resume_store)
            resumed = await asyncio.to_thread(_resume_lookup, username, task_id)
            if resumed is None:
                return json.dumps(err(
                    "unknown_task_id",
                    f"no resumable agent '{task_id}' on this server (expired or never existed)",
                    fix="omit task_id and start a fresh agent with a complete, autonomous brief",
                ))
            agent_type = resumed["agent"]

        spec = _agents_map.get(agent_type)
        if spec is None:
            return json.dumps(err(
                "unknown_agent",
                f"'{agent_type}' is not a valid subagent_type",
                fix="pick one of the listed agent types",
                valid_choices=list(_agents_map.keys()),
            ))

        if resumed is not None:
            child_id = task_id           # id STABLE : enveloppe + corrélation UI
        else:
            n = next(_counter)
            child_id = f"t{n}-{secrets.token_hex(3)}"
        # chat_id SYNTHÉTIQUE : isole l'enfant du parent (clé screenshots, FTS…)
        # SANS toucher au registre d'annulation (_cancelled_chats est keyé sur le
        # (uid, parent_chat_id) que porte déjà la closure is_cancelled ci-dessous).
        child_chat_id = f"{chat_id or 'chat'}#task-{child_id}"

        # ── Annulation PAR-ENFANT : enregistrement + is_cancelled composite ──
        # L'endpoint POST /api/chat/task-cancel pose un flag ciblé ; la boucle
        # enfant le voit via ce composite et lève CancelledError — que le
        # handler DISCRIMINE plus bas (enfant seul → enveloppe task_cancelled,
        # le tour parent SURVIT ; parent annulé → propagation, comportement Stop).
        _ckey = (str(username), child_id)
        # AUDIT 2026-08-23 — l'inscription dans ``_ACTIVE_CHILDREN`` a DESCENDU
        # jusqu'au ``try`` qui porte déjà son retrait (chercher « inscription
        # ICI » plus bas). Elle vivait ici, ~490 lignes plus haut, avec deux
        # points de suspension réels dans l'intervalle (construction de l'index
        # de skills, émission de l'event ``spawned``), tous deux gardés par un
        # ``except Exception`` — que ``CancelledError``, qui dérive de
        # ``BaseException``, TRAVERSE. Un Stop pendant le spawn sortait donc du
        # handler AVANT d'atteindre le ``try``, et l'entrée n'était jamais
        # retirée. Or ``apply_child_cancel`` ne pose son flag QUE si la clé est
        # dans ``_ACTIVE_CHILDREN`` : c'est le garde-fou anti-flag-orphelin,
        # qu'une entrée fantôme rouvrait — les deux conteneurs module-level
        # grossissaient alors définitivement pour la vie du worker (qui, depuis
        # le drain « linger » 12 h, se compte en heures).

        def _child_is_cancelled() -> bool:
            if is_cancelled and is_cancelled():
                return True
            return _ckey in _CANCELLED_CHILDREN

        # ── Config de l'enfant selon le type d'agent ─────────────────────────
        if spec.inherit_config:
            child_mcp_configs = parent_mcp_configs
            child_allowed = None
            child_builtins = parent_builtin_tools    # RAG passthrough ; JAMAIS task
            child_memory = memory_enabled
        else:
            # Serveur local synthétique. ``None`` = pas de filtre (surface locale
            # complète) ≠ ``[]`` = aucune catégorie demandée — seul ``[]`` le
            # supprime, et un agent dans ce cas tient sa surface de ses serveurs
            # MCP (le socle par défaut couvre le cas « il n'a rien demandé du
            # tout », cf. CUSTOM_DEFAULT_CATEGORIES).
            child_mcp_configs = []
            if spec.filter_categories is None or spec.filter_categories:
                child_mcp_configs.append({
                    "type": "stdio",
                    "name": f"task-{agent_type}",
                    "command": "DEFAULT_LOCAL_PYTHON",
                    "filter_categories": spec.filter_categories,
                })
            # Agents custom : serveurs MCP EXTERNES choisis, résolus par id dans
            # la liste complète de l'utilisateur (ordre de la liste préservé ;
            # id inconnu = inerte — la liste des serveurs évolue indépendamment).
            if spec.mcp_server_ids and user_mcp_configs:
                _wanted = set(spec.mcp_server_ids)
                child_mcp_configs += [
                    s for s in user_mcp_configs
                    if isinstance(s, dict) and s.get("id") in _wanted
                ]
            if not child_mcp_configs:
                # Un agent qui ne tenait sa surface QUE de ``mcp_server_ids``
                # (serveur depuis supprimé, dépublié, ou plus affiché par ce
                # compte) partirait sans le moindre outil et rendrait quand même
                # un rapport « completed » — c'est-à-dire une réponse inventée
                # présentée au parent comme un résultat. Un agent a toujours des
                # outils : on lui rend le socle de travail.
                logger.warning(
                    "[task_tool] agent '%s' : aucune source d'outils résolue "
                    "(serveurs %s introuvables) — repli sur le socle %s",
                    agent_type, spec.mcp_server_ids, CUSTOM_DEFAULT_CATEGORIES)
                child_mcp_configs.append({
                    "type": "stdio",
                    "name": f"task-{agent_type}",
                    "command": "DEFAULT_LOCAL_PYTHON",
                    "filter_categories": custom_default_categories(),
                })
            child_allowed = set(spec.allowed_tool_names) if spec.allowed_tool_names else None
            child_builtins = None
            child_memory = False

        # (2026-09-11, P2) ``meta.policy.deny_for: ["subagent"]`` des outils
        # (todowrite, ask_user…) fait foi ; ``_DENY_BASE`` reste le repli d'un
        # registre vide. ``task`` (builtin, jamais dans le registre) toujours.
        from llm_core._mcp_categories import tools_denied_for as _denied_for
        child_deny = {"task"} | _denied_for("subagent", fallback=_DENY_BASE) | set(spec.deny_extra)

        # ── Récursion opt-in (TASK_SUBAGENT_DEPTH, modèle OpenCode v1.18.3) ──
        # L'enfant (profondeur depth+1) reçoit lui-même le builtin ``task`` ssi
        # depth+1 < N : factory imbriquée qui capture la MÊME chaîne d'annulation
        # (parent → enfant → petit-enfant) et le même sink (rollup + runs, avec
        # ``depth`` pour l'indentation UI). À N (défaut 1), comportement
        # historique : deny dur, l'enfant ne voit jamais l'outil.
        if depth + 1 < TASK_SUBAGENT_DEPTH:
            _nested = build_task_builtin_tool(
                parent_mcp_configs=parent_mcp_configs,
                parent_builtin_tools=parent_builtin_tools,
                username=username,
                # chat_id SYNTHÉTIQUE de CET enfant (pas celui du parent
                # originel) : un petit-enfant devient ``…#task-x#task-y`` —
                # la chaîne porte la profondeur réelle (screenshots/FTS/slot
                # distincts par niveau, cohérents avec la doc du module).
                chat_id=child_chat_id,
                model=model,
                sampling_override=sampling_override,
                memory_enabled=memory_enabled,
                is_cancelled=_child_is_cancelled,
                on_event=on_event,
                scheduling_mode=scheduling_mode,
                usage_sink=usage_sink,
                custom_agents=custom_agents,
                user_mcp_configs=user_mcp_configs,
                user_id=user_id,
                depth=depth + 1,
                priority=priority,
            )
            child_builtins = {**(child_builtins or {}), **_nested}
            child_deny.discard("task")

        # ── Tête système + messages : frais, ou REPRISE de l'historique stocké ──
        if resumed is not None:
            # Le store contient la liste PRÊTE (système persona d'origine +
            # tours précédents expansés + dernier rapport) → on ajoute la
            # nouvelle mission. Budget d'itérations remis à neuf (la boucle
            # gère l'overflow de contexte comme pour le parent).
            child_messages = list(resumed["messages"]) + [{"role": "user", "content": prompt}]
        else:
            # Agents custom : persona INLINE (settings_json) ; builtins : fichier
            # system_prompts/<stem>.md (hot-reload par mtime).
            if spec.persona_text is not None:
                persona = spec.persona_text
            else:
                persona = load_agent_persona(spec.persona_stem)
            if not persona:
                logger.warning("[task_tool] persona '%s' introuvable — enfant sans tête dédiée", spec.persona_stem)
            system_content = (persona + "\n\n" + _child_env_block(spec, TASK_CHILD_TIMEOUT_S)).strip()
            # Index des skills — SEULEMENT pour un enfant qui détient la
            # catégorie ``skill``. L'index est injecté par la route de chat, pas
            # par la boucle : un agent (custom) qui coche « Skills » recevait
            # ``skill_get`` / ``skill_read_file`` / ``skill_run_script`` sans
            # jamais savoir quels skills existent — trois outils annoncés par le
            # manifeste ``# Active tools`` et inappelables sans deviner un nom.
            # Aucun corps injecté (full-pull) ⇒ le coût est le seul index, et
            # uniquement pour les agents concernés. Best-effort de bout en bout.
            if user_id is not None and "skill" in set(spec.filter_categories or ()):
                try:
                    from llm_core._system_prompts import build_skills_index_block
                    # ``discover_skills`` parcourt DEUX arborescences et lit
                    # chaque SKILL.md : de l'I/O disque, jamais dans la boucle
                    # (le worker sert les autres requêtes pendant ce temps).
                    _skills_idx = await asyncio.to_thread(
                        build_skills_index_block, user_id)
                except Exception as exc:                        # noqa: BLE001
                    logger.warning("[task_tool] index skills non construit (%r)", exc)
                    _skills_idx = None
                if _skills_idx:
                    system_content = f"{system_content}\n\n{_skills_idx}"
            child_messages = [
                {"role": "system", "content": system_content},
                {"role": "user", "content": prompt},
            ]

        # ── Sampling : hérite du parent, override du cap d'itérations enfant ──
        child_sampling = dict(sampling_override or {})
        child_sampling["max_tool_iterations"] = spec.max_iters

        # ── Relais d'événements enfant → task_step (mini-transcript UI) ──────
        # On ne transmet JAMAIS l'``on_event`` parent brut à l'enfant : ses
        # content_token / thinking_token pollueraient la bulle du parent. Seuls
        # kv_cache / iteration / tool_call / tool_result sont convertis.
        #
        # Compteur de tokens : MÊME mécanisme que la jauge du parent (« réel
        # seul », cf. _ctxLive dans app-chat.js) — on affiche l'occupation de
        # contexte RÉELLE mesurée par le serveur, recalée après CHAQUE requête
        # LLM de l'enfant via son event ``kv_cache`` (used = prompt_tokens
        # réels). Aucune estimation, pas de cumul comptable (l'ancien
        # ``tokens_used`` re-compte l'historique à chaque tour → quadratique).
        # Fallback cible distante (kv_cache non émis sans n_ctx local fiable) :
        # ``iteration.context_tokens`` = prompt+completion RÉELS du dernier
        # appel (même calcul que kv_cache, cf. loop :1740).
        # ``_transcript`` accumule le déroulé (cap 50) : joint au record du run
        # dans ``usage_sink["runs"]`` → persisté sur le message assistant
        # (``task_runs``) pour que la carte agent SURVIVE au rechargement.
        # ``_chat`` (UX 2026-07-24, modale « œil ») = déroulé COMPLET compact :
        # entrées {"text": …} (narration/réponse de l'enfant, flush aux
        # frontières de tool_call) et {"tool", "args_preview", "status",
        # "result_preview"} — persisté dans le record (clé ``transcript``,
        # NON strippée par _task_runs_for_persist) + émis dans le task_step
        # ``final``. Bornes : 120 entrées, texte 1500 c, résultat 400 c.
        _step_no = count(1)
        # AUDIT 2026-09-25 — ids d'appel de l'historique LIVE uniques PAR RUN :
        # ``live_{step}`` repartait de 1 à chaque appel du handler, et une
        # reprise elle-même interrompue empilait des ``live_1`` en double dans
        # l'historique repris (élagage/résumeur sur le mauvais appel ; ids de
        # ``tool_use`` dupliqués refusés par Anthropic).
        _run_nonce = secrets.token_hex(3)
        _steps_seen = {"n": 0}
        # Progression « étape N/M » : N doit être HOMOGÈNE à M. M est un budget
        # d'ITÉRATIONS (spec.max_iters → max_tool_iterations de l'enfant), donc N
        # doit compter les TOURS, pas les appels d'outils : compter les tool_call
        # surestime dès que le modèle appelle plusieurs outils en parallèle (et
        # les appels ratés comptaient aussi) → l'UI affichait « étape 63/40 ».
        # Source de vérité = l'event ``iteration`` de l'enfant, seul couple n/max
        # cohérent émis par la boucle (cf. _chat_with_tools). ``_steps_seen``
        # continue de compter les APPELS (rendu séparément : « N appel(s) »).
        _iters = {"n": 0, "max": spec.max_iters}
        _tok = {"v": 0, "real": False}   # v = occupation réelle ; real = kv_cache vu
        _transcript: List[Dict[str, Any]] = []
        _chat: List[Dict[str, Any]] = []
        _chat_buf = {"t": ""}

        async def _flush_chat(emit: bool = True, deja_rendu: str = "") -> None:
            """Fige le texte enfant accumulé en une entrée du déroulé ; ``emit``
            relaie aussi un task_step ``text`` (narration LIVE dans la modale).

            ``deja_rendu`` — texte que l'appelant s'apprête à publier PAR
            AILLEURS (le ``result`` du bilan final). Le tampon est alors vidé
            SANS entrer dans le déroulé.

            AUDIT 2026-08-30 — c'est le flush de FIN de run qui posait
            problème. Le texte streamé après le dernier appel d'outil EST la
            réponse finale de l'agent : il atterrissait en dernière entrée du
            déroulé, alors que ``result`` le portait déjà pour le bloc
            « Résultat ». La modale montrait donc, dans l'ordre : la réponse,
            la liste des outils, puis la réponse une seconde fois.

            La narration INTERMÉDIAIRE (flushée à chaque frontière d'outil) ne
            passe jamais par ce paramètre : elle reste dans le déroulé, c'est
            tout son intérêt.
            """
            t = _chat_buf["t"].strip()
            _chat_buf["t"] = ""
            if not t:
                return
            if deja_rendu:
                # Comparaison TOLÉRANTE : entre le tampon et le texte rendu par
                # le runner, il peut y avoir un strip de markup ou une coupe.
                # L'un contenant l'autre suffit à conclure au doublon.
                _a, _b = t.strip(), deja_rendu.strip()
                if _a and _b and (_a in _b or _b in _a):
                    return
            if len(t) > 1500:
                t = truncate_head_tail(t, 1500, reason="task transcript bound")
            if len(_chat) < 120:
                _chat.append({"text": t})
            if emit and on_event:
                try:
                    await on_event({
                        "type": "task_step", "child_id": child_id,
                        "agent": agent_type, "status": "text", "text": t,
                    })
                except Exception:
                    pass
        # Historique LIVE (reprise après interruption, 2026-07-18) : messages
        # OpenAI appariés reconstruits au fil des events tool_call/tool_result.
        # Le chemin ``completed`` n'en a pas besoin (tool_history du runner,
        # plus riche : textes assistant intermédiaires inclus) — mais sur
        # timeout/échec/annulation ciblée, ces events sont la SEULE trace du
        # travail partiel : sans eux, tout re-partait de zéro. Contenus bornés
        # par entrée (RAM) ; ids synthétiques cohérents assistant↔tool.
        _hist_live: List[Dict[str, Any]] = []
        # Appariement tool_call ↔ tool_result par ``call_id`` : c'est le SEUL
        # champ qui distingue deux appels PARALLÈLES du même outil (trois
        # read_file dans un même batch portent le même ``name``). L'ancien
        # appariement par nom en FIFO attribuait le premier résultat revenu au
        # premier appel émis : sur un batch parallèle, le contenu de C était
        # enregistré sous l'id de l'appel sur A, et l'historique de reprise
        # présentait au modèle « j'ai lu A » avec le contenu de C.
        _live_by_call: Dict[str, str] = {}         # call_id → id d'appel synthétique
        # Repli pour les émetteurs qui ne fournissent pas de call_id (cibles
        # distantes, wrappers tiers) : FIFO par nom, comportement historique.
        _live_pending: Dict[str, List[str]] = {}   # tool name → FIFO d'ids en attente

        async def _emit_tick() -> None:
            if on_event:
                await on_event({
                    "type": "task_step",
                    "child_id": child_id,
                    "agent": agent_type,
                    "status": "tick",
                    "tokens": _tok["v"],
                })

        async def _child_on_event(ev: Dict[str, Any]) -> None:
            if not isinstance(ev, dict):
                return
            _t = ev.get("type")
            if _t == "kv_cache":
                # Occupation réelle serveur (prompt_tokens) — signal PRIMAIRE,
                # identique à celui qui recale la jauge du parent.
                _used = int(ev.get("used", 0) or 0)
                if _used > 0:
                    _tok["v"] = _used
                    _tok["real"] = True
                    await _emit_tick()
            elif _t == "iteration":
                # Progression en TOURS (numérateur homogène à max_steps).
                _n = int(ev.get("n", 0) or 0)
                if _n > 0:
                    _iters["n"] = _n
                _m = int(ev.get("max", 0) or 0)
                if _m > 0:
                    _iters["max"] = _m
                # Fallback réel (cible distante) : jamais quand kv_cache existe.
                if not _tok["real"]:
                    _ctx_t = int(ev.get("context_tokens", 0) or 0)
                    if _ctx_t > 0:
                        _tok["v"] = _ctx_t
                        await _emit_tick()
            elif _t == "content_token":
                # Narration/texte de l'enfant → tampon du déroulé (borné RAM ;
                # la coupe propre à 1500 c se fait au flush).
                if len(_chat_buf["t"]) < 6000:
                    _chat_buf["t"] += str(ev.get("text") or "")
            elif _t == "tool_call":
                await _flush_chat()
                step = next(_step_no)
                _steps_seen["n"] = step
                _cid = ev.get("call_id")
                if len(_transcript) < 50:
                    _transcript.append({
                        "tool": ev.get("name"),
                        "call_id": _cid,
                        "args_preview": _preview(ev.get("args")),
                        "status": "running",
                    })
                if len(_chat) < 120:
                    _chat.append({
                        "tool": ev.get("name"),
                        "call_id": _cid,
                        # 200 c (vs 120 du mini-transcript) : la carte détail
                        # de la modale a la place d'un aperçu plus complet.
                        "args_preview": _preview(ev.get("args"), 200),
                        "status": "running",
                        "result_preview": "",
                    })
                _live_id = f"live_{_run_nonce}_{step}"
                _raw_args = ev.get("args")
                try:
                    _args_s = _raw_args if isinstance(_raw_args, str) \
                        else json.dumps(_raw_args or {}, ensure_ascii=False)
                except (TypeError, ValueError):
                    _args_s = "{}"
                _hist_live.append({"role": "assistant", "content": None, "tool_calls": [{
                    "id": _live_id, "type": "function",
                    "function": {"name": ev.get("name") or "", "arguments": _args_s},
                }]})
                if _cid:
                    _live_by_call[str(_cid)] = _live_id
                else:
                    _live_pending.setdefault(ev.get("name") or "", []).append(_live_id)
                if on_event:
                    await on_event({
                        "type": "task_step",
                        "child_id": child_id,
                        "agent": agent_type,
                        # « étape N/M » = TOURS (cf. _iters). ``calls`` porte le
                        # compte d'appels, distinct et rendu séparément.
                        "step": _iters["n"] or 1,
                        "max_steps": _iters["max"],
                        "calls": step,
                        "tool": ev.get("name"),
                        "args_preview": _preview(ev.get("args")),
                        "tokens": _tok["v"],
                        "status": "running",
                    })
            elif _t == "tool_result":
                _failed = _result_is_tool_failure_safe(ev.get("result"))
                _st = "error" if _failed else "done"
                _res_prev = _preview(ev.get("result"), 400)
                _cid = ev.get("call_id")
                _cid_s = str(_cid) if _cid else ""

                def _match(entry) -> bool:
                    """L'entrée décrit-elle l'appel dont voici le résultat ?

                    Par ``call_id`` quand il est là (exact, y compris sur un
                    batch parallèle du même outil) ; sinon repli historique sur
                    le nom, en prenant la dernière entrée encore en cours.
                    """
                    if entry.get("status") != "running":
                        return False
                    if _cid_s and entry.get("call_id"):
                        return str(entry["call_id"]) == _cid_s
                    return entry.get("tool") == ev.get("name")

                for _entry in reversed(_transcript):
                    if _match(_entry):
                        _entry["status"] = _st
                        break
                for _entry in reversed(_chat):
                    if _match(_entry):
                        _entry["status"] = _st
                        _entry["result_preview"] = _res_prev
                        break

                _rid = _live_by_call.pop(_cid_s, None) if _cid_s else None
                if _rid is None:
                    _q = _live_pending.get(ev.get("name") or "")
                    if _q:
                        _rid = _q.pop(0)
                if _rid is not None:
                    _rc = ev.get("result")
                    if not isinstance(_rc, str):
                        try:
                            _rc = json.dumps(_rc, ensure_ascii=False)
                        except (TypeError, ValueError):
                            _rc = str(_rc)
                    _cap = emit_cap_chars(None)
                    if len(_rc) > _cap:
                        _rc = truncate_head_tail(_rc, _cap,
                                                 reason="live history bound")
                    _hist_live.append({"role": "tool", "tool_call_id": _rid,
                                       "content": _rc})
                if on_event:
                    await on_event({
                        "type": "task_step",
                        "child_id": child_id,
                        "agent": agent_type,
                        # Même unité qu'à l'ouverture (TOURS) : avant, ce chemin
                        # renvoyait le n° du dernier appel DÉMARRÉ, ce qui faisait
                        # bondir « étape N » à chaque résultat d'appel parallèle.
                        "step": _iters["n"] or 1,
                        "max_steps": _iters["max"],
                        "calls": _steps_seen["n"],
                        "tool": ev.get("name"),
                        "tokens": _tok["v"],
                        "status": _st,
                        "result_preview": _res_prev,
                        # Fichiers modifiés par l'outil de l'enfant : le
                        # parent les ajoute aux diffs du tour (2026-09-26).
                        **({"files": ev["files"]} if isinstance(ev.get("files"), list)
                           and ev.get("files") else {}),
                    })
            # tout le reste (content_token, thinking_*, iteration, mode,
            # tool_progress/log, notice, compression_*) : DROP.

        # ── Choix du runner selon le mode de scheduling (sémaphore) ──────────
        # classic   : le parent TIENT LLM_SEMAPHORE pendant les tool calls →
        #             l'enfant NE DOIT PAS le ré-acquérir (deadlock à
        #             concurrency=1) → run_chat_multi_mcp(_inline_semaphore=False).
        # optimized : le parent a RELÂCHÉ le sémaphore pendant le tool call →
        #             l'enfant l'acquiert par appel LLM → run_chat_multi_mcp_v2.
        from llm_core._chat_with_tools import (
            run_chat_multi_mcp, run_chat_multi_mcp_v2,
        )
        _runner = run_chat_multi_mcp_v2 if scheduling_mode == "optimized" else run_chat_multi_mcp

        _t0 = time.time()
        _state = "completed"
        final_text = ""
        child_metrics: Dict[str, Any] = {}

        def _resumable_live_history() -> List[Dict[str, Any]]:
            """Historique live remis en FORME CANONIQUE pour la reprise.

            AUDIT 2026-08-23 — le collecteur appende un message assistant par
            ``tool_call`` (à l'émission) puis un ``role:tool`` par résultat
            (à l'ARRIVÉE). Or la boucle émet TOUS les ``tool_call`` d'un lot
            avant d'exécuter quoi que ce soit, et les résultats d'un lot
            parallèle reviennent dans le DÉSORDRE. Pour trois ``read_file``
            concurrents, l'historique de reprise valait donc :

                assistant(tc1), assistant(tc2), assistant(tc3),
                tool(3), tool(1), tool(2)

            — trois assistants CONSÉCUTIFS portant chacun un appel pendant,
            puis des réponses hors position. C'est exactement la forme que
            llama.cpp a REFUSÉE en 400 (cf. la note de
            ``_flatten_tool_messages``) : la reprise échouait en « Le modèle a
            refusé la requête », et le travail partiel qu'on voulait sauver
            était perdu. L'ancien filtre ne retirait que les appels sans
            réponse ; il ne regroupait ni ne réordonnait rien, et
            ``sanitize_message_history`` ne répare pas cette forme (son
            ``open_ids`` est un SET).

            On rétablit donc la même discipline que ``_delta_snapshot`` du
            chemin ``completed`` : UN assistant portant les N appels de la
            vague, puis ses ``tool`` DANS L'ORDRE de ses ``tool_calls``. Un
            appel resté sans réponse est retiré de la vague ; une vague dont
            aucun appel n'a répondu disparaît entièrement.
            """
            _answered: Dict[str, Dict[str, Any]] = {}
            for _m in _hist_live:
                if _m.get("role") == "tool" and _m.get("tool_call_id"):
                    _answered[str(_m["tool_call_id"])] = _m

            out: List[Dict[str, Any]] = []
            _i, _n = 0, len(_hist_live)
            while _i < _n:
                _m = _hist_live[_i]
                if _m.get("role") == "assistant" and _m.get("tool_calls"):
                    # Vague = les assistants à tool_calls CONSÉCUTIFS (le
                    # collecteur en crée un par appel du même lot).
                    _calls: List[Dict[str, Any]] = []
                    _j = _i
                    while (_j < _n and _hist_live[_j].get("role") == "assistant"
                           and _hist_live[_j].get("tool_calls")):
                        _calls.extend(_hist_live[_j].get("tool_calls") or [])
                        _j += 1
                    _kept = [c for c in _calls
                             if str((c or {}).get("id") or "") in _answered]
                    if _kept:
                        out.append({"role": "assistant", "content": None,
                                    "tool_calls": _kept})
                        for _c in _kept:
                            out.append(_answered[str(_c["id"])])
                    _i = _j
                    continue
                if _m.get("role") == "tool":
                    _i += 1          # déjà émis, dans l'ordre de sa vague
                    continue
                out.append(_m)
                _i += 1
            return out

        def _store_resume_state() -> None:
            """Store de reprise : un run ABOUTI (rapport ou tool_history)
            devient continuable via task_id = child_id — liste PRÊTE pour le
            prochain run (tête système + missions/tours expansés + rapport).
            Un run INTERROMPU (timeout / échec / annulation ciblée OU Stop
            parent) l'est aussi dès qu'il a du travail partiel : l'historique
            live reconstruit remplace le tool_history que le runner n'a jamais
            pu retourner (2026-07-18)."""
            _hist = child_metrics.get("tool_history") if isinstance(child_metrics, dict) else None
            _next_msgs: Optional[List[Dict[str, Any]]] = None
            # ``incomplete`` (borne du harnais, cf. point 10) : la boucle a
            # RETOURNÉ normalement, son ``tool_history`` delta est disponible
            # — même reconstruction que le chemin abouti.
            if _state in ("completed", "incomplete") and (final_text or _hist):
                # tool_history est le DELTA du run (cf. _run_tool_history dans
                # run_chat_multi_mcp) : elle ne contient QUE le travail de ce
                # cycle. Base = child_messages ENTIER (qui porte déjà les
                # cycles précédents sur une reprise) + le delta. L'ancienne
                # coupe au 1er message agentique compensait la capture
                # cumulative — la garder avec un delta perdrait tout le
                # travail des reprises antérieures.
                _next_msgs = list(child_messages) + _expand_child_history(_hist or [])
                if final_text:
                    _next_msgs.append({"role": "assistant", "content": final_text})
            elif _state in ("timeout", "failed", "cancelled"):
                _live = _resumable_live_history()
                if _live:
                    _next_msgs = list(child_messages) + _live
            if _next_msgs is not None:
                _rec = {"agent": agent_type, "messages": _next_msgs, "ts": time.time()}
                with _RESUME_LOCK:
                    _RESUME_STORE[(str(username), child_id)] = _rec
                    _RESUME_STORE.move_to_end((str(username), child_id))
                # Store PARTAGÉ : la reprise arrive presque toujours dans un
                # autre worker (nouvelle requête HTTP, aucune affinité).
                try:
                    _task_resume.put(str(username), child_id, _rec)
                except Exception:                               # noqa: BLE001
                    pass
                _prune_resume_store()

        def _record_run() -> None:
            """Rollup tokens + record du run dans ``usage_sink`` (un record par
            enfant, attaché au message assistant persisté ``task_runs`` → la
            carte agent est réhydratée au rechargement). ``context_tokens`` =
            occupation réelle FINALE ; input/output = cumul comptable (rollup
            métriques admin). Appelé sur le chemin NORMAL **et** sur le Stop
            parent (fix 2026-07-18 : l'append vivait après le ``raise`` → le
            run en vol disparaissait du ``task_runs`` persisté avec le partiel,
            la ligne agent restait en spinner puis s'évaporait au reload)."""
            if usage_sink is None:
                return
            _in_t = int(child_metrics.get("input_tokens", 0) or 0)
            _out_t = int(child_metrics.get("output_tokens", 0) or 0)
            # Part de RÉFLEXION, COMPRISE dans ``_out_t`` (le raisonnement n'est
            # pas re-soumis d'un tour à l'autre : sortie = réflexion + réponse).
            # Exposée à part pour qu'un appelant headless — un workflow — puisse
            # dire ce que le TRAVAIL a coûté, hors délibération.
            _think_t = int(child_metrics.get("thinking_tokens", 0) or 0)
            usage_sink["tasks"] = usage_sink.get("tasks", 0) + 1
            usage_sink["input_tokens"] = usage_sink.get("input_tokens", 0) + _in_t
            usage_sink["output_tokens"] = usage_sink.get("output_tokens", 0) + _out_t
            usage_sink.setdefault("runs", []).append({
                "id": child_id,
                "agent": agent_type,
                "label": description,
                # Brief donné à l'agent (modale « œil », accordéon
                # « Instructions ») — borné pour la persistance.
                "prompt": prompt if len(prompt) <= 2000 else prompt[:2000] + "…",
                # Résultat FINAL de l'agent, ENTIER (modale « œil », bloc
                # « Résultat »). Jusqu'ici il n'existait que dans l'historique
                # d'outils du parent : le MODÈLE le recevait sans coupe
                # (``_render_result``), l'humain n'en voyait que le reflet
                # tronqué à 1500 c dans le déroulé. Le cap est un garde-fou
                # anti-mégaoctets, pas un affichage borné.
                "result": (final_text or "")[:TASK_RESULT_PERSIST_CAP],
                "state": _state,
                "steps_total": _steps_seen["n"],
                "context_tokens": _tok["v"],
                "input_tokens": _in_t,
                "output_tokens": _out_t,
                "think_tokens": _think_t,
                "duration_ms": int((time.time() - _t0) * 1000),
                "tools": _transcript,
                # Déroulé complet (modale « œil ») — SEULE clé de déroulé
                # persistée (_task_runs_for_persist strippe ``tools``).
                "transcript": _chat,
                "depth": depth,
                "resumed": resumed is not None,
            })
        # Event de NAISSANCE : donne child_id au front AVANT le 1er appel LLM
        # (sinon le bouton ✕ n'a pas d'id pendant le prefill initial). Le front
        # ne fait que corréler/assigner l'id (+ depth pour l'indentation).
        if on_event:
            try:
                await on_event({
                    "type": "task_step", "child_id": child_id, "agent": agent_type,
                    "status": "spawned", "resumed": resumed is not None, "depth": depth,
                })
            except Exception:
                pass
        # inscription ICI (cf. la note plus haut) : l'invariant « le ✕ du front
        # n'existe qu'APRÈS l'event ``spawned`` » est préservé — l'event vient
        # d'être émis juste au-dessus — et le retrait du ``finally`` couvre
        # désormais toute la durée de vie de l'entrée, annulation pendant le
        # spawn comprise.
        _ACTIVE_CHILDREN[_ckey] = {"agent": agent_type, "chat_id": chat_id,
                                   "t0": time.time()}
        try:
            # Registre d'usage : l'enfant consomme sur SON propre appel LLM.
            # Scope imbriqué (le user est hérité du parent) pour que sa conso
            # soit attribuée à l'utilisateur ET rattachée au tour parent —
            # avant, elle n'entrait dans aucun agrégat.
            with usage_scope("subagent", user_id=user_id,
                             origin_id=str(child_chat_id or child_id),
                             parent_id=str(chat_id or "")):
                final_text, _child_events, child_metrics = await asyncio.wait_for(
                    _runner(
                        child_messages,
                        mcp_configs=child_mcp_configs,
                        on_event=_child_on_event,
                        username=username,
                        model=model,
                        builtin_tools=child_builtins,
                        is_cancelled=_child_is_cancelled,
                        chat_id=child_chat_id,
                        sampling_override=child_sampling,
                        thinking_mode=False,
                        allowed_tool_names=child_allowed,
                        memory_enabled=child_memory,
                        deny_tool_names=child_deny,
                        # AUDIT 2026-09-25 — priorité du PARENT (une routine
                        # reste « low ») et propriétaire du run : sans lui,
                        # le ``_meta`` des outils locaux de l'enfant n'avait
                        # pas d'``user_id`` (hôte d'outils distant, trames
                        # desktop non rapatriées).
                        priority=priority,
                        user_id=user_id,
                    ),
                    timeout=TASK_CHILD_TIMEOUT_S,
                )
            # AUDIT 2026-08-30 — ex-« filet déroulé » RETIRÉ : il posait
            # ``_chat_buf["t"] = final_text`` quand le runner n'avait pas
            # streamé de content_token, pour que la réponse de l'enfant entre
            # quand même dans le déroulé de la modale. Ce filet datait d'AVANT
            # le bloc « Résultat » ; depuis, ``_emit_final_step`` porte
            # ``result=final_text`` et le record aussi. Le texte partait donc
            # DEUX FOIS sur le chemin normal — bloc « Résultat » en entier, et
            # dernière entrée du déroulé (tronquée à 1500 c) — et la modale
            # affichait la réponse finale en double.
            #
            # Le chemin ANNULATION garde son flush (plus bas) : lui n'émet pas
            # de ``result``, le déroulé y reste la seule trace du travail fait.
            if (child_metrics or {}).get("ended_with_error"):
                # (2026-09-21) La boucle d'outils RETOURNE sur un échec LLM au
                # lieu de lever : sans cette lecture, un agent mort en route
                # était rendu « completed » avec un rapport vide ou tronqué.
                _state = "failed"
                out = json.dumps(err(
                    "task_failed",
                    f"sub-agent '{agent_type}' stopped on a model error before finishing",
                    retryable=True,
                    **({"task_id": child_id,
                        "next_action": "pass task_id to resume this agent from its partial work"}
                       if (resumed is not None or _resumable_live_history()) else {}),
                    **({"partial_report": final_text[:4000]} if final_text else {}),
                ))
            elif (child_metrics or {}).get("tool_limit_reached"):
                # AUDIT 2026-09-24 (point 10) — arrêt sur une BORNE du harnais
                # (itérations, budget de temps, anti-boucle, contexte saturé,
                # plafond de génération…) : la boucle rend alors un message
                # destiné à l'HUMAIN (« utilisez Reprendre… »). Il partait au
                # parent sous ``state="completed"``, comme un rapport abouti :
                # le modèle parent le relayait tel quel ou le prenait pour le
                # résultat de la mission. État distinct + consigne de reprise.
                _state = "incomplete"
                _why = str((child_metrics or {}).get("tool_limit_stop_reason")
                           or "steps")
                out = json.dumps(err(
                    "task_incomplete",
                    f"sub-agent '{agent_type}' stopped before finishing "
                    f"(harness limit: {_why}); its work is unfinished",
                    stop_reason=_why,
                    **({"task_id": child_id,
                        "next_action": "pass task_id to resume this agent from its partial work, with a narrower brief"}
                       if ((child_metrics or {}).get("tool_history")
                           or _resumable_live_history()) else {}),
                    **({"partial_report": final_text[:4000]} if final_text else {}),
                ))
            else:
                out = _render_result(child_id, final_text)
        except asyncio.CancelledError:
            _state = "cancelled"
            # DISCRIMINATION : annulation CIBLÉE de CET enfant (task-cancel) →
            # le tour parent SURVIT, enveloppe lisible par le modèle. Toute
            # autre CancelledError (Stop du chat, task.cancel() worker) →
            # propagation intacte (jamais avalée).
            # ``cancelling()`` : un VRAI ``task.cancel()`` (drain du worker,
            # ``wait_for`` extérieur) arrivé pendant que le ✕ de l'enfant est
            # posé n'est pas un arrêt ciblé — il se propage (passe
            # robustesse 2026-09-24). Arrêt ciblé normal : la boucle enfant
            # lève d'elle-même, ``cancelling() == 0``.
            _cur = asyncio.current_task()
            _child_only = (_ckey in _CANCELLED_CHILDREN
                           and not (is_cancelled and is_cancelled())
                           and not (_cur is not None and _cur.cancelling()))
            if not _child_only:
                # Stop parent : bilan émis (relayé malgré le flag cancel — la
                # route laisse passer les task_step ``final``), record du run
                # (state=cancelled) poussé dans usage_sink AVANT propagation
                # (sinon la ligne agent disparaissait du partiel persisté), et
                # travail partiel stocké (reprenable via task_id après un
                # « Continuer »). Le finally ci-dessous nettoie les registres.
                await _flush_chat(emit=False)
                await _emit_final_step(on_event, child_id, agent_type, _state,
                                       _steps_seen["n"], child_metrics, _t0,
                                       context_tokens=_tok["v"], transcript=_chat)
                # AUDIT 2026-08-31 (passe 4, B8) — json.dumps (cap 8 Mo) +
                # écriture disque du store partagé : hors boucle.
                await asyncio.to_thread(_store_resume_state)
                _record_run()
                raise
            out = json.dumps(err(
                "task_cancelled",
                f"sub-agent '{agent_type}' was cancelled by the user",
                next_action="continue the turn without this sub-agent's report, or ask the user how to proceed",
                **({"task_id": child_id} if (resumed is not None or _resumable_live_history()) else {}),
            ))
        except asyncio.TimeoutError:
            _state = "timeout"
            # Travail partiel collecté → le modèle peut REPRENDRE cet agent
            # (task_id) au lieu de re-payer tout le brief + les tool calls.
            _partial = (
                {"task_id": child_id,
                 "next_action": "pass task_id to resume this agent from its partial work, with a narrower brief"}
                if (resumed is not None or _resumable_live_history()) else {}
            )
            out = json.dumps(err(
                "task_timeout",
                f"sub-agent '{agent_type}' exceeded {TASK_CHILD_TIMEOUT_S}s",
                fix="split the mission into smaller, more targeted tasks",
                **_partial,
            ))
        except Exception as e:  # noqa: BLE001 — le tool retourne toujours une string
            _state = "failed"
            logger.warning("[task_tool] sous-agent '%s' échoué : %s", agent_type, e, exc_info=True)
            out = json.dumps(err(
                "task_failed",
                str(e)[:300],
                retryable=True,
                **({"task_id": child_id} if (resumed is not None or _resumable_live_history()) else {}),
            ))
        finally:
            _ACTIVE_CHILDREN.pop(_ckey, None)
            _CANCELLED_CHILDREN.discard(_ckey)
            # PAS de teardown navigateur ici pour l'agent ``web`` (audit
            # 2026-07-18) : les sessions pw_* sont PAR UTILISATEUR (owner =
            # username côté browser-service, une instance partagée entre le
            # parent, les enfants et les autres chats) — fermer à la mort d'un
            # enfant tuerait le navigateur de l'utilisateur. Les contextes
            # orphelins relèvent du TTL / ``cleanup`` du service Node.

        # ``deja_rendu`` : ce flush-ci ne doit PAS redéposer dans le déroulé le
        # texte que la ligne suivante publie en ``result`` (cf. _flush_chat).
        await _flush_chat(emit=False, deja_rendu=final_text or "")
        await _emit_final_step(on_event, child_id, agent_type, _state,
                               _steps_seen["n"], child_metrics, _t0,
                               context_tokens=_tok["v"], transcript=_chat,
                               result=(final_text or "")[:TASK_RESULT_PERSIST_CAP])
        # AUDIT 2026-08-31 (passe 4, B8) — cf. le site du Stop parent : la
        # persistance du store de reprise part en thread (fin de CHAQUE agent).
        await asyncio.to_thread(_store_resume_state)
        _record_run()

        return out

    return {"task": {"definition": _build_definition(_agents_map), "handler": _handle_task}}


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

async def _emit_final_step(
    on_event: Optional[Callable],
    child_id: str,
    agent_type: str,
    state: str,
    steps_total: int,
    metrics: Dict[str, Any],
    t0: float,
    *,
    context_tokens: int = 0,
    transcript: Optional[List[Dict[str, Any]]] = None,
    result: str = "",
) -> None:
    """Événement ``task_step`` FINAL : bilan de l'enfant (état, coût, durée).
    ``context_tokens`` = occupation réelle finale (affichage compteur, même
    mécanisme que la jauge parent) ; input/output = cumul comptable ;
    ``transcript`` = déroulé complet borné (modale « œil » — le front le pose
    sur le run, qui repart tel quel dans task_runs persistés).

    ``result`` = texte final ENTIER de l'enfant. Sans lui dans CET event, le
    bloc « Résultat » de la modale n'apparaîtrait qu'après un rechargement (le
    record persisté le porte, pas le flux live) — exactement le symptôme que
    le correctif vient supprimer. Vide sur les chemins annulé/échec."""
    if not on_event:
        return
    try:
        await on_event({
            "type": "task_step",
            "child_id": child_id,
            "agent": agent_type,
            "status": "final",
            "state": state,
            "steps_total": steps_total,
            "context_tokens": int(context_tokens or 0),
            "input_tokens": int((metrics or {}).get("input_tokens", 0) or 0),
            "output_tokens": int((metrics or {}).get("output_tokens", 0) or 0),
            "duration_ms": int((time.time() - t0) * 1000),
            "transcript": transcript or [],
            "result": result or "",
        })
    except Exception:
        return


def _result_is_tool_failure_safe(result: Any) -> bool:
    """Wrapper import-tardif de ``_result_is_tool_failure`` (évite le cycle)."""
    try:
        from llm_core._chat_with_tools import _result_is_tool_failure
        return bool(_result_is_tool_failure(result))
    except Exception:
        return False
