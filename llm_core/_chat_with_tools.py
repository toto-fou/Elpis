# SPDX-License-Identifier: MIT
"""
llm_core._chat_with_tools — la boucle agentique : chat avec outils (MCP et
intégrés).

Ce module est l'orchestrateur : ``run_chat_multi_mcp(...)`` enchaîne
LLM ↔ outils jusqu'au budget d'itérations (annulation, capture d'écran pour la
vision, métriques du tour) ; ``run_chat_multi_mcp_v2`` force le mode
``optimized`` (créneau LLM rendu pendant l'exécution des outils).

Il garde le prélude (vision, catalogue, assemblage du contexte, rappel
todo), la boucle et ses compteurs, l'aiguillage de chaque tour (appels natifs,
appels écrits en texte, reprise, réponse finale) et le point d'étape budget
communiqué au modèle. Les compteurs d'itérations restent ICI, en entiers : les
sous-routines rendent des issues que la boucle applique. Elles vivent dans
``llm_core.engine`` :

  - ``engine.run`` — état du run (``RunContext``, ``RunRecord``) et
    dépendances injectées (``LoopDeps``) ;
  - ``engine.llm_turn`` — un tour LLM (``call_llm``) et son issue ;
  - ``engine.resume`` — reprises automatiques d'une génération coupée ;
  - ``engine.run_exit`` — réponse finale, sortie sur limite, sortie d'erreur ;
  - ``engine.live_text`` — émission directe du contenu ;
  - ``engine.llm_stream`` — un appel LLM en flux avec ``tools[]`` (replis :
    sans flux, puis analyse du texte) ;
  - ``engine.tool_catalog`` — outils de tous les serveurs MCP configurés et
    outils intégrés, réunis en une charge utile ;
  - ``engine.tool_dispatch`` — exécution des appels d'outils, noyau commun aux
    deux canaux (``run_tool_batch``, ``ChannelSpec``) : préparation du lot,
    appels écrits en texte et leurs relances, anti-boucle, appels coupés par
    la limite de génération, un appel isolé (MCP ou intégré) ; les lots
    passent par ``engine.tool_exec``, en série ou en parallèle selon
    ``_tool_traits`` ;
  - ``engine.result_contract`` — classement des échecs d'outil.

Lecture des appels écrits en texte : ``_tool_parsing``. Élagage des vieux
résultats : ``context.pruning`` ; mémoire d'accessibilité et contexte de la
sandbox : ``context.assembly``.

Points de substitution des tests : ``_llama_chat_with_tools_stream`` et
``_record_tool_call_metric_safe`` sont lus dans les globales de CE module au
début du run et injectés (``LoopDeps``) ; la taille de contexte, le pool MCP,
l'élagage et le registre d'usage sont lus à l'appel via leur module
propriétaire (``_model_info``, ``_mcp_pool``, ``context.pruning``,
``usage_ctx``).
"""
from __future__ import annotations

import asyncio
import functools
import json
import logging
import secrets
import time
from contextvars import ContextVar
from typing import Any, Callable, Dict, List, Optional, Tuple

from llm_core._constants import LLAMA_MAX_TOOL_ITERATIONS
from llm_core._health import verify_llm_availability
from llm_core._scheduling._guard import _emit
from llm_core._vision import _clear_last_screenshot_for, _model_supports_vision
from llm_core.context.assembly import (
    assemble_operational_context as _assemble_operational_context,
)
from llm_core.context.compaction_gate import CompactionThreshold
from llm_core.context.pruning import ephemeral as _ephemeral_msg
from llm_core.engine.llm_stream import _llama_chat_with_tools_stream
from llm_core.engine.llm_turn import (
    LLMTurnState,
    call_llm,
)
from llm_core.engine.resume import ResumeState
from llm_core.engine.run import (
    LoopDeps,
    RunContext,
    RunRecord,
)
from llm_core.engine.run_exit import finish_ok, finish_on_error, finish_on_limit
from llm_core.engine.tool_catalog import _collect_mcp_tools
from llm_core.engine.tool_dispatch import (
    _TCM_UID_CACHE,
    NATIF,
    TEXTE,
    CycleGuard,
    TruncationGuard,
    _record_tool_call_metric_safe,
    classify_text_reply,
    open_native_round,
    open_text_round,
    relaunch_unparsed_call,
    run_tool_batch,
)
from shared_infra import config as _bk_config
from shared_infra.config import LLAMA_MODEL
from shared_infra.observability import usage_ctx as _usage_ctx
from shared_infra.observability.tracing import swallow

logger = logging.getLogger("uvicorn.error")


# ── Budget communiqué au modèle ──────────────────────────────────────────────
# Idiome du <system_warning> d'Anthropic (Sonnet 4.5) : le harnais poste des
# points d'étape de budget DANS le flux de la conversation, en append-only
# APRÈS les tool results — jamais dans la tête système ni en réécriture, pour
# préserver la byte-stabilité du prefix-cache KV. Émis aux jalons seulement
# (50 %, 75 %, puis chacune des 5 dernières itérations) : ~10 tokens par
# émission, silence le reste du temps. Le fragment système (FRAGMENT_TOOLS)
# explique au modèle comment lire le tag.
def _harness_status_line(k: int, n: int, *,
                         wall_left_s: Optional[float] = None,
                         hard_left: Optional[int] = None,
                         ctx_left: Optional[int] = None,
                         ctx_size: Optional[int] = None,
                         sandbox_limits: Optional[str] = None) -> Optional[str]:
    """Ligne ``<harness_status>`` pour k itérations productives consommées sur
    un budget de n — ou None hors jalon. k >= n est géré ailleurs (sortie de
    boucle + tour de synthèse « MAXIMUM STEPS REACHED »).

    ``hard_left`` = itérations restantes avant le PLAFOND DUR (cascade
    d'appels en échec). Ce plafond termine le run tout comme le budget
    d'étapes : sans l'annoncer, le modèle planifierait contre un budget qui
    n'est pas celui qui va l'arrêter. On l'annonce dès qu'il devient la
    contrainte la plus proche.

    ``ctx_left``/``ctx_size`` (jetons) et ``sandbox_limits`` (texte court)
    s'ajoutent au point d'étape budget : le modèle planifie contre la
    fenêtre restante et les limites réelles du conteneur. Rien de plus émis
    hors jalon."""
    # Le plafond dur passe DEVANT quand il est sur le point de mordre : c'est
    # alors lui la vraie limite, et le geste utile n'est pas le même (des
    # appels échouent en série — il faut changer d'approche, pas se dépêcher).
    if hard_left is not None and 0 < hard_left <= 5 and (n <= 0 or k < n):
        return (f"<harness_status>Failed-call ceiling: only {hard_left} attempt(s) "
                "left before this turn is stopped for repeated tool failures "
                "(this is NOT the step budget). Your recent tool calls are "
                "failing: change approach — re-read the actual error, verify "
                "arguments and paths, or report the blocker instead of "
                "retrying.</harness_status>")
    if n <= 0 or k <= 0 or k >= n:
        return None
    left = n - k
    at_half = k == (n + 1) // 2
    at_three_quarters = k == (3 * n + 3) // 4
    if not (at_half or at_three_quarters or left <= 5):
        return None
    if left == 1:
        body = (f"Tool-iteration budget: {k}/{n} used — LAST iteration "
                "available. Deliver your final answer now; call one more tool "
                "only if answering is impossible without it.")
    elif left <= 5:
        body = (f"Tool-iteration budget: {k}/{n} used — only {left} left. "
                "Wrap up: finish the essential steps, then deliver the final "
                "answer. Do not start anything new.")
    else:
        body = (f"Tool-iteration budget: {k}/{n} used, {left} left. Plan the "
                "remaining work to fit. If the goal is already reached, stop "
                "calling tools and answer now; otherwise keep going — do not "
                "stop early while budget remains.")
    if wall_left_s is not None:
        body += f" Wall-clock remaining: ~{max(0, int(wall_left_s // 60))} min."
    if ctx_size and ctx_size > 0 and ctx_left is not None:
        body += (f" Context window: ~{max(0, int(ctx_left)) // 1000}k of "
                 f"{int(ctx_size) // 1000}k tokens left.")
    if sandbox_limits:
        body += f" Sandbox limits: {sandbox_limits}."
    return f"<harness_status>{body}</harness_status>"


def _sandbox_limits_text() -> Optional[str]:
    """Limites du conteneur sandbox (config admin) en une ligne courte pour
    ``<harness_status>`` ; None si la config est illisible."""
    try:
        from shared_infra.sandbox.executors._user_sandbox import load_admin_config
        cfg = load_admin_config()
        return (f"{int(cfg.memory_mb)} MB RAM, {cfg.cpu_quota_pct / 100.0:g} CPU, "
                f"{int(cfg.pids_max)} processes, {int(cfg.timeout_s)} s per command")
    except Exception as _e:                                       # noqa: BLE001 — point d'étape sans les limites du conteneur
        logger.debug("sandbox limits unavailable for harness_status: %s", _e)
        return None


def _todo_status_reminder(username: str, chat_id: Optional[str]) -> Optional[str]:
    """Bloc ``<todo_status>`` injecté EN DÉBUT DE TOUR quand la todo-list
    persistée du chat (``meta_json["todos"]``, outil ``todowrite``) garde des
    tâches ouvertes. Sans lui, la liste ne survivrait qu'en ARCHÉOLOGIE — le
    tool result todowrite enfoui dans le tool_history des tours précédents,
    élagable (prune/compaction) et jamais relu spontanément : le modèle
    « oublierait » de continuer ou solder ses tâches au tour suivant. None si
    pas de chat persisté, pas de liste, ou plus rien d'ouvert."""
    if not chat_id or chat_id == "default":
        return None
    try:
        from shared_infra.chat.store import get_chat_todos
        # Même cache username→uid que les métriques d'outils : pas de
        # ``SELECT * FROM users`` à chaque tour pour ne garder que l'id.
        uid = _TCM_UID_CACHE.get(username)
        if uid is None:
            from shared_infra.accounts.users import get_user
            row = get_user(username)
            if row is None:
                return None
            uid = int(row["id"])
            _TCM_UID_CACHE[username] = uid
        todos = get_chat_todos(uid, chat_id)
    except Exception:  # noqa: BLE001 — rappel facultatif : le tour part sans
        return None
    open_count = sum(1 for t in todos
                     if isinstance(t, dict) and t.get("status") in ("pending", "in_progress"))
    if not open_count:
        return None
    # Même forme canonique que le ``checklist`` renvoyé par todowrite
    # (``N. [status] contenu``) : le modèle recopie au lieu de reformuler.
    from llm_core.tools._todo_format import render_checklist
    return (
        "<todo_status>Your session todo list from previous turns still has "
        f"{open_count} open task(s):\n" + render_checklist(todos) + "\n"
        "Unless the user's latest message changes the plan, resume this work: "
        "set the task you start to in_progress, mark each task completed as "
        "soon as it is done (or cancelled if obsolete) — always via todowrite "
        "with the FULL updated list, every item with its content (copied "
        "verbatim) and its status.</todo_status>"
    )


async def _run_chat_multi_mcp_wrapper(*args, **kwargs) -> Tuple[str, List[Dict[str, Any]], Dict[str, Any]]:
    """Wrapper public de ``_run_chat_multi_mcp_impl`` avec nettoyage garanti.

    Le corps de la fonction n'a aucun ``finally`` de niveau fonction : les
    purges de ``_LAST_SCREENSHOT`` vivent sur les chemins de ``return``
    nominaux, alors que la fonction lève ``CancelledError`` en plusieurs
    points et que le flux de chat (``chatbot_app.turn.execution``) annule la
    tâche à chaque déconnexion client. Sans
    ce wrapper, chaque « Stop » / fermeture d'onglet pendant un tour ayant
    capturé une screenshot laisserait un JPEG (100-400 Ko) dans le dict
    module-level À VIE. Ce wrapper garantit la purge sur TOUS les chemins —
    y compris annulation et exception.
    """
    # username / chat_id : mêmes défauts que la signature de l'impl.
    _username = kwargs.get("username", args[3] if len(args) > 3 else "guest")
    _chat_id = kwargs.get("chat_id", args[7] if len(args) > 7 else None)
    # L'impl n'enregistre l'usage que sur ses TROIS retours (ok / limite /
    # échec). Un Stop, une déconnexion, un sous-agent tué par son délai
    # sortent par ``CancelledError`` : sans ce cumul, les tokens consommés —
    # ceux des runs les plus longs — ne seraient comptés nulle part. L'impl
    # tient ce cumul à jour ici ; on l'enregistre si le run meurt annulé.
    _acc: Dict[str, Any] = {}
    _acc_tok = _RUN_USAGE_ACC.set(_acc)
    _t0 = time.time()
    try:
        return await _run_chat_multi_mcp_impl(*args, **kwargs)
    except asyncio.CancelledError:
        _record_cancelled_run_usage(_acc, _t0)
        raise
    except Exception as _run_err:
        # Exception hors des trois retours (post-traitement…) : l'usage des
        # itérations déjà faites est enregistré aussi.
        _record_cancelled_run_usage(_acc, _t0, status="error",
                                    error_kind=type(_run_err).__name__)
        raise
    finally:
        _RUN_USAGE_ACC.reset(_acc_tok)
        with swallow("harness.run_chat_multi_mcp_wrapper"):
            _clear_last_screenshot_for(f"{_username}:{_chat_id or 'default'}")


# Cumul d'usage du run EN COURS (cf. _run_chat_multi_mcp_wrapper).
_RUN_USAGE_ACC: "ContextVar[Optional[Dict[str, Any]]]" = ContextVar(
    "run_usage_acc", default=None)


def _record_cancelled_run_usage(acc: Dict[str, Any], t0: float,
                                status: str = "cancelled",
                                error_kind: str = "") -> None:
    """Enregistre l'usage d'un run ANNULÉ (status ``cancelled``) ou mort sur
    une exception (``error``), s'il a consommé quelque chose et qu'aucun
    retour ne l'a déjà enregistré."""
    if not acc or acc.get("recorded"):
        return
    _in = int(acc.get("in") or 0) + int(acc.get("inflight_in") or 0)
    _out = int(acc.get("out") or 0)
    if _in <= 0 and _out <= 0:
        return
    with swallow("harness.record_usage_on_cancel"):
        _usage_ctx.record_turn_usage(
            model=acc.get("model") or LLAMA_MODEL, path="tools",
            input_tokens=_in, output_tokens=_out, submitted_tokens=_in,
            usage={"cache_read_input_tokens": int(acc.get("cache_read") or 0),
                   "cache_creation_input_tokens": int(acc.get("cache_creation") or 0),
                   "tool_input_tokens": int(acc.get("tool_in") or 0)},
            duration_ms=int((time.time() - t0) * 1000),
            iterations=int(acc.get("iterations") or 0),
            status=status, error_kind=error_kind,
        )
        acc["recorded"] = True


async def _run_chat_multi_mcp_impl(
    messages: List[Dict[str, Any]],
    mcp_configs: List[Dict[str, Any]],
    on_event: Optional[Callable] = None,
    username: str = "guest",
    model: Optional[str] = None,
    builtin_tools: Optional[Dict[str, Any]] = None,
    is_cancelled: Optional[Callable[[], bool]] = None,
    chat_id: Optional[str] = None,
    sampling_override: Optional[Dict[str, Any]] = None,
    thinking_mode: bool = False,
    allowed_tool_names: Optional[set] = None,
    memory_enabled: bool = True,
    _inline_semaphore: bool = False,
    priority: str = "high",
    compression_prev_state: Optional[Dict[str, Any]] = None,
    deny_tool_names: Optional[set] = None,
    live_shell: bool = False,
    compression_enabled: Optional[bool] = None,
    compaction_threshold: Optional[CompactionThreshold] = None,
    compaction_max_rounds: Optional[int] = None,
    prune_keys: Optional[list] = None,
    read_only: bool = False,
    user_id: Optional[int] = None,
) -> Tuple[str, List[Dict[str, Any]], Dict[str, Any]]:
    """
    Exécute un chat avec accès aux serveurs MCP via tool calls natifs OpenAI.

    user_id (défaut None) : id numérique du compte, recopié dans le ``_meta``
        des appels d'outils LOCAUX — un hôte d'outils DISTANT
        n'a pas la base des comptes pour le retrouver depuis ``username``.

    prune_keys (défaut None) : marques d'élagage DÉJÀ persistées pour ce chat
        (``meta_json["ctx_pruned_keys"]``). La boucle les prend comme état
        initial et y ajoute ses propres sélections intra-run ; l'union est
        ré-émise en fin de tour (event ``prune_state``).

    compression_enabled (défaut None) : autorisation de compaction AUTOMATIQUE
        pour CE tour, déjà résolue par l'appelant (interrupteur maître admin ET
        opt-in per-user ``compression_enabled``). None = repli sur le maître
        seul (routines, appelants sans utilisateur). La compaction manuelle
        (/compact) ne passe pas par ici et reste toujours disponible.

    compaction_threshold (défaut None) : « contexte max avant compaction »
        choisi par le compte (``CompactionThreshold`` : % de la fenêtre OU
        nombre de tokens). None = défaut d'instance, auto à défaut
        (``resolve_threshold``) ; seuil vide = auto, c'est-à-dire le plafond
        technique (n_ctx − cap de génération − buffer). Le seuil est opposé à
        l'occupation à CHAQUE itération — la porte étant évaluée entre deux
        appels d'outils, rien n'est en cours de streaming à cet instant, et une
        mission de plusieurs heures tient dans un seul tour (cf.
        ``llm_core.context.compaction_gate``).

    compaction_max_rounds (défaut None) : cap de compactions par CONVERSATION
        réglé par le compte, convention compresseur (0 = illimité). None = rien
        de réglé ⇒ défaut d'instance ``COMPRESSION_MAX_PER_CHAT``. Relève
        AUSSI le budget de compactions du run : sans ça, un run de plusieurs
        heures buterait sur le plafond de la boucle bien avant le cap choisi.

    live_shell (défaut False) : propage ``live_shell: "1"`` dans le meta MCP
        de chaque tool call → ``execute_shell`` streame sa sortie en direct
        (événements ``shell_output``). Posé par la route chat selon le
        réglage utilisateur « Terminal en direct ».

    compression_prev_state (défaut None) : état de compression persisté du
        chat (round / covered_turns / summary_xml, cf.
        conversation_compressor.extract_compression_state). Permet à la
        compression en boucle d'appliquer le cap COMPRESSION_MAX_PER_CHAT et
        le comptage cumulatif des tours couverts.

    allowed_tool_names (défaut None) : si fourni, restreint les outils
        exposés au modèle à CE sous-ensemble exact (par nom). Utilisé par le
        moteur d'agents pour appliquer l'allowlist d'un archétype (ex. un
        ``explorer`` n'obtient qu'un sous-ensemble de la catégorie ``fs``). Les
        catégories cachées (aides model-side) restent toujours disponibles.
        None → aucune restriction par nom.

    deny_tool_names (défaut None) : couche de deny FINALE (voir
        _collect_mcp_tools) — s'applique AUSSI aux catégories cachées et aux
        builtins, contrairement à allowed_tool_names. Le moteur de sous-agents
        (outil ``task``) l'utilise pour interdire ``task``/``todowrite`` à un
        enfant (anti-récursion). None → inchangé.

    builtin_tools: dict mapping tool_name → {"definition": {...}, "handler": callable}
                   handler(args) → str (JSON result). Handled inline, no MCP needed.

    _inline_semaphore (défaut False) :
        - False (classic) → le caller est responsable d'acquérir LLM_SEMAPHORE
          autour de l'appel entier à cette fonction. Pendant les tool calls
          MCP, le sémaphore reste pris.
        - True → cette fonction acquiert LLM_SEMAPHORE elle-même, UNIQUEMENT
          autour de chaque appel LLM individuel dans la boucle. Entre deux
          itérations (pendant les tool calls MCP), le sémaphore est libéré.
          Combiné avec --cache-ram côté llama-server, un autre user peut
          utiliser le slot pendant qu'on exécute un tool, et le kv cache
          est automatiquement restauré au retour.
          L'alias ``run_chat_multi_mcp_v2`` force ce comportement.

    OPTIMISATION (mcp_pool) :
    ─────────────────────────
    Les connexions MCP sont persistantes (MCPConnectionPool) : pas de nouveau
    subprocess + handshake + list_tools à chaque requête, le pool maintient
    les connexions en vie et cache les outils
    pendant TOOLS_CACHE_TTL_SEC (défaut 360s). La reconnexion est automatique.

    Fallback automatique : si le LLM ne supporte pas les tool calls natifs
    (finish_reason != "tool_calls" ET pas de tool_calls dans la réponse), on
    tente de détecter des appels JSON en texte libre via extract_tool_calls()
    pour assurer la compatibilité avec les modèles plus anciens.
    """
    await verify_llm_availability()
    start_time = time.time()

    # Le sémaphore inline ne concerne que les serveurs llama.cpp (max_models=1 :
    # une seule clé de modèle active). Acquis SANS test de cible, un run sur
    # connecteur CLOUD occuperait l'unique slot local à chaque itération (les
    # utilisateurs du modèle local attendraient derrière un run qui n'envoie
    # rien au GPU), et attendrait lui-même derrière leurs générations. Même
    # patron que _guard.py (le niveau ordonnanceur saute les cibles distantes).
    # Chaque serveur llama.cpp, intégré ou connecteur, a SON gestionnaire
    # (``_scheduling._engines``) : le sémaphore inline s'applique à chacun sur
    # le sien ; les autres cibles le sautent.
    if _inline_semaphore:
        try:
            from llm_core.engines import current_engine
            if not current_engine().is_llamacpp:
                _inline_semaphore = False
        except Exception:  # noqa: BLE001 — moteur illisible : le sémaphore inline reste pris
            pass

    # ── Détection vision : permet d'injecter les screenshots automatiquement
    # quand le LLM appelle pw_page("inspect") sur un modèle multimodal.
    _model_has_vision = await _model_supports_vision(model or LLAMA_MODEL or "")
    # Chat key pour tracker la dernière screenshot (user + chat_id).
    # Chaque chat garde sa propre screenshot → pas de fuite entre chats du même user.
    _chat_key_suffix = chat_id or "default"

    # ── 1. Connexion aux serveurs MCP via le pool, collecte des outils ────
    # Cf. ``engine.tool_catalog._collect_mcp_tools``. Raises RuntimeError si
    # les serveurs sont configurés mais aucun n'a pu se connecter (et pas de
    # builtin_tools pour compenser). Le pool ré-ingère le registre de
    # catégories (tags/meta) à chaque connexion.
    tool_cfg_map, tools_payload, builtin_handlers, connected_server_names = \
        await _collect_mcp_tools(
            mcp_configs, builtin_tools, on_event,
            allowed_tool_names=allowed_tool_names,
            memory_enabled=memory_enabled,
            deny_tool_names=deny_tool_names,
            read_only=read_only,
        )

    # Snapshot des tools actifs pour ce turn. Sert au manifeste
    # ``# Active tools`` injecté dans la tête système et à la porte du rappel
    # todo. Calcul une fois, passé tel quel — les helpers chat ne mutent pas
    # cette liste.
    _allowed_tool_names: List[str] = sorted(set(tool_cfg_map.keys()) | set(builtin_handlers.keys()))

    if on_event and connected_server_names:
        await _emit(on_event, {
            "type": "mode",
            "text": (
                f"Connecté : {', '.join(connected_server_names)} "
                f"({len(tools_payload)} outil(s))"
            ),
        })

    # ── 2. Assemblage du contexte opérationnel (→ context.assembly) ───────
    # Socle défaut si absent + capacités actives (fragments) + runtime_ctx +
    # sanitisation + AX memory + fold dans l'UNIQUE système de tête.
    # La byte-stabilité de la tête entre itérations est gardée par les goldens
    # payload. Hors de la boucle d'événements : l'assemblage lit la base
    # (compte, profil réseau, réglages) et, pour la mémoire AX d'un chat
    # navigateur, interroge le service Playwright par un ``urlopen`` synchrone
    # (jusqu'à 2 s) — sur la boucle, tous les flux du worker gèleraient à
    # chaque début de tour.
    working_messages = await asyncio.to_thread(
        _assemble_operational_context,
        messages,
        allowed_tool_names=_allowed_tool_names,
        username=username,
    )

    # ── 2b. Rappel d'état todo (début de tour) ────────────────────────────
    # Cf. _todo_status_reminder : des tâches todowrite restées ouvertes au
    # tour précédent sont ré-données au modèle comme ÉTAT COURANT, pas
    # seulement comme archéologie de tool_history. Append en QUEUE (tête
    # système intacte → prefix-cache préservé), éphémère (jamais persisté,
    # jamais rendu côté UI — même canal que <harness_status>). Gate sur la
    # disponibilité réelle de l'outil ce run : un enfant task (todowrite
    # denied) ou un run sans outils n'a rien à faire de ce rappel.
    #
    # Le tour commence presque toujours par le ``user`` réel : un second
    # ``user`` à sa suite fait lever les gabarits à
    # alternance stricte (famille Gemma, Mistral) → 500, puis aplatissement.
    # Le rappel est alors FUSIONNÉ dans ce dernier ``user``, sur une COPIE (le
    # dict appartient à l'appelant, qui le persiste : le rappel ne doit jamais
    # y entrer). Seule la queue change, la tête système reste intacte.
    if "todowrite" in _allowed_tool_names:
        _todo_reminder = await asyncio.to_thread(_todo_status_reminder, username, chat_id)
        if _todo_reminder:
            _tail = working_messages[-1] if working_messages else None
            if isinstance(_tail, dict) and _tail.get("role") == "user":
                from llm_core.context.pruning import merge_user_suffix
                working_messages[-1] = {
                    **_tail, "content": merge_user_suffix(_tail.get("content"),
                                                          _todo_reminder)}
                # Le rappel doit exister aussi aux tours suivants : rendue sans
                # lui, la question ferait diverger le préfixe KV dès elle —
                # tout le tour précédent (outils, résultats) re-préchargé à
                # chaque nouveau message tant que des tâches restent ouvertes.
                # La route persiste ce suffixe (event interne) et l'expansion
                # le rejoue à l'octet.
                await _emit(on_event, {"type": "llm_user_suffix",
                                       "text": _todo_reminder})
            elif not (isinstance(_tail, dict) and _tail.get("role") == "assistant"):
                # Queue ``assistant`` = préremplissage d'une reprise
                # (« Continuer » d'un raisonnement coupé) : un ``user`` ajouté
                # derrière désarmerait ``continue_final_message`` et la reprise
                # native deviendrait un tour neuf (raisonnement refait).
                working_messages.append(_ephemeral_msg("user", _todo_reminder))

    # Trace du run (événements rendus à l'appelant, tool_history, usage,
    # lot en cours, fenêtre de contexte, marques d'élagage) : cf. engine.run.
    rec = RunRecord(usage_acc=_RUN_USAGE_ACC.get())

    # ── 3. Boucle tool-call (cap configurable) ───────────────────────────
    # Limite d'itérations du cycle tool_call → tool_result → tool_call.
    # Défaut : LLAMA_MAX_TOOL_ITERATIONS (env var / config.json). Peut être
    # overridé par chat via sampling_override.max_tool_iterations depuis l'UI.
    # Sans cap, un LLM qui hallucine peut boucler indéfiniment.
    # NOTE: LLM_SEMAPHORE est intentionnellement absent ici.
    # En mode classique, l'appelant (flux de chat, routines) le tient déjà
    # via ``llm_scheduling_guard`` AVANT d'appeler run_chat_multi_mcp ; en mode
    # « optimized », ``engine.run.llm_slot`` le prend à chaque appel du moteur.
    # asyncio.Semaphore n'est pas réentrant :
    # le ré-acquérir ici provoquerait un deadlock avec LLAMA_MAX_CONCURRENCY=1.
    _max_iter = LLAMA_MAX_TOOL_ITERATIONS
    # Plafond de l'override UI : il suit la config (au moins 500, sinon 4× le
    # défaut configuré). env/config.json n'ont pas de plafond : un plafond fixe
    # plus BAS empêcherait l'UI d'exprimer un run que le serveur autorise.
    _iter_ceiling = max(500, LLAMA_MAX_TOOL_ITERATIONS * 4)
    if sampling_override and isinstance(sampling_override, dict):
        _mi_override = sampling_override.get("max_tool_iterations")
        if isinstance(_mi_override, (int, float)) and 1 <= int(_mi_override) <= _iter_ceiling:
            _max_iter = int(_mi_override)
    if _max_iter != LLAMA_MAX_TOOL_ITERATIONS:
        logger.info("[run_chat_multi_mcp] max_tool_iterations override : %d "
                    "(défaut %d)", _max_iter, LLAMA_MAX_TOOL_ITERATIONS)

    # ``rec.budget_drop_floor`` est remis à zéro dès que ``working_messages``
    # est réécrit (compaction, aplatissement) : ses groupes ne désignent plus
    # les mêmes messages.
    # ``rec.tools_tok_counted`` : compté UNE fois (paresseusement) au lieu de
    # re-dump + re-hash ~30 Ko à chaque itération ; partagé par la pré-porte
    # (repli estimé), la porte exacte du compresseur et le budget dur.
    # Longueur du schéma d'outils en CHARS — numérateur du ratio chars/token
    # mesuré (le dénominateur, ``prompt_tokens``, le facture). Stable sur tout
    # le run, calculé une fois.
    try:
        _tools_payload_chars = (len(json.dumps(tools_payload, ensure_ascii=False))
                                if tools_payload else 0)
    except Exception:  # noqa: BLE001 — schéma non sérialisable : longueur nulle
        _tools_payload_chars = 0
    # ctx_size du modèle pour activer le seuil tokens. Récupéré une fois
    # en début de boucle (le modèle ne change pas en cours de conversation).
    # Résolu PAR CIBLE : sur un connecteur distant, le /props LOCAL décrit un
    # autre modèle — voire rien du tout, et ctx=0 met TOUT le pipeline en
    # veille (ni compaction, ni élagage, ni budget, et un cap d'émission
    # bloqué à son plancher). ``resolve_context_window`` retombe sur le /props
    # local pour une cible locale.
    try:
        from llm_core._ctx_window import resolve_context_window
        rec.ctx_size = await resolve_context_window(
            model or LLAMA_MODEL or "")
    except Exception:  # noqa: BLE001 — fenêtre inconnue (0) : pas de budget de contexte
        rec.ctx_size = 0

    # ── Total pour la JAUGE de contexte LIVE ─────────────────────────────
    # La fenêtre est résolue par CIBLE (``resolve_context_window``) : le total
    # est juste quand il est connu — on l'affiche. Fenêtre inconnue ⇒ 0 ⇒
    # jauge masquée : on n'affiche JAMAIS un pourcentage inventé.
    rec.gauge_ctx_total = rec.ctx_size if rec.ctx_size > 0 else 0

    # ── Cap d'itérations : 2 compteurs (productivité + plafond dur) ───
    # Une itération où le modèle appelle un outil qui ÉCHOUE (mauvais nom,
    # arguments invalides, MCP timeout) ne consomme pas le budget : sinon
    # 33 outils réussis + 13 échecs épuiseraient un budget de 50 avant la fin
    # du travail réel.
    #
    #   - ``effective_iter`` ne s'incrémente QUE sur une itération
    #     "productive" (au moins un tool_call de cette itération a
    #     renvoyé un résultat sans champ ``error``, ou pas de tool_call
    #     du tout = réponse finale). C'est ce compteur qu'on compare au
    #     budget utilisateur ``_max_iter``.
    #   - ``hard_iter`` est un cap absolu (``max(2 × _max_iter,
    #     _max_iter + 10)``) qui protège contre les boucles infinies si
    #     TOUS les tool calls d'un modèle hallucinant échouent en cascade.
    #     Sans cela, un modèle cassé pourrait boucler indéfiniment sans que
    #     ``effective_iter`` n'avance.
    _effective_iter_budget = _max_iter
    _hard_iter_cap = max(_max_iter * 2, _max_iter + 10)
    effective_iter = 0
    hard_iter = 0
    iteration = 0

    # État privé des tours LLM (mesure du contexte, compactions, séries de
    # récupération) : cf. engine.llm_turn.
    st = LLMTurnState.for_run(
        compression_prev_state=compression_prev_state,
        compaction_threshold=compaction_threshold,
        compaction_max_rounds=compaction_max_rounds,
        max_iter=_max_iter)
    # Sortie « le moteur renvoie des réponses vides » (issue ``stop_empty`` de
    # call_llm) : distincte de la limite d'itérations, qui sinon porterait un
    # diagnostic faux.
    _empty_choices_stop = False
    # Budget mur d'horloge OPT-IN de la boucle outillée (0 = off, défaut).
    _loop_max_s = float(getattr(_bk_config, "LLAMA_TOOL_LOOP_MAX_S", 0) or 0)
    _loop_t0 = time.monotonic()

    # Anti-boucle desktop : si le modèle répète la même action sans que l'écran
    # change, on lui injecte une consigne plutôt que de gaspiller des
    # itérations, puis on arrête les actions (cf. engine.tool_dispatch).
    cycle = CycleGuard()
    _cycle_hard_stopped = False

    # ── Élagage INTRA-RUN ──────────────────────────────────────────────────
    # Marques d'élagage actives : celles déjà persistées pour ce chat + celles
    # sélectionnées PENDANT ce run. Appliquées à chaque itération par
    # ``fit_context`` (vue transitoire — ``working_messages`` reste intact).
    # Une sélection faite seulement en FIN de tour (rendue au tour SUIVANT)
    # laisserait un run de 200 itérations sans aucun élagage.
    rec.run_prune_keys = {k for k in (prune_keys or []) if isinstance(k, str)}

    # Relances consommées après un appel d'outil illisible, perdu ou vers un
    # outil inconnu (budget borné : cf. ``relaunch_unparsed_call``), réarmées
    # par une itération productive ou un appel texte lisible.
    _malformed_retry = 0

    # Dernier JALON <harness_status> émis (dédoublonnage). Clé
    # mixte ``("steps", k)`` / ``("hard", n)`` : sans ça, le même jalon serait
    # ré-injecté à chaque tour raté — et l'alerte « plafond dur », elle,
    # ne sortirait JAMAIS (elle vit précisément quand effective_iter stagne).
    _hs_last_status_key: Optional[Tuple[str, int]] = None
    # Limites de la sandbox pour <harness_status> : None = pas encore lues,
    # "" = rien à dire (shell absent) ou déjà annoncées dans ce tour.
    _hs_sandbox_limits: Optional[str] = None

    # Jeton de routage des logs, unique à CE run.
    #
    # Le routeur de logs du wrapper MCP (``_LogRouter``) est porté par
    # l'instance de wrapper ; or le serveur d'outils locaux se fond en UNE
    # seule entrée de pool (``_make_key``), donc UN routeur pour tous les
    # comptes et tous les chats du worker. Or l'identifiant d'appel n'est
    # unique QUE dans un run : le harnais fabrique ``call_{iter}_{idx}`` /
    # ``legacy_{iter}_{idx}``, et llama.cpp lui-même renvoie ``call_0``. Avec
    # l'id d'appel pour jeton, deux ``execute_shell`` concurrents porteraient
    # le MÊME jeton : la sortie du terminal d'un compte partirait chez
    # l'autre, puis le premier ``unregister`` couperait le flux du second.
    #
    # On ne touche PAS au ``call_id`` — il apparie l'appel et son résultat,
    # côté modèle comme côté rendu chat. On transporte un jeton SÉPARÉ, dédié
    # au routage, que le pont d'exécution recopie dans ses notifications.
    _run_log_tok = secrets.token_hex(4)

    # Appels d'outils coupés par finish=length d'affilée : au-delà d'une
    # série, sortie par le chemin tool-limit avec la cause réelle — fenêtre
    # pleine ou plafond de SORTIE (cf. ``TruncationGuard``).
    trunc = TruncationGuard()
    # Sortie VOLONTAIRE de la boucle (mur d'horloge, coupes en série, boucle
    # d'action). Ces chemins n'écrasent pas ``effective_iter`` avec le budget
    # pour passer la condition du ``while`` : le couple exposé à l'UI
    # (« 200/200 tours ») mentirait, et la cause réelle se perdrait derrière
    # une « limite d'itérations atteinte ». Le compteur reste vrai.
    _forced_stop = False
    # Reprises automatiques d'une génération coupée (raisonnement, rédaction) :
    # demande en attente et compteurs de la série, cf. engine.resume.
    resume = ResumeState()
    # Plusieurs chemins sortent de la boucle par la synthèse sans que le budget
    # soit en cause (``_forced_stop``) : mur d'horloge, contexte saturé, boucle
    # d'action. Le tour de synthèse ne doit pas affirmer « step budget
    # exhausted » — le modèle rapporterait à l'utilisateur une limite d'étapes
    # qu'il n'a pas atteinte. On garde donc la vraie cause pour la lui donner.
    _wallclock_stop = False

    # Instantané de la tool_history à l'annulation, et filet des points de
    # suspension hors des ``try`` d'annulation : cf. RunRecord.
    _emit_partial_tool_history_snapshot = functools.partial(
        rec.emit_partial_snapshot, on_event)
    _guard_cancel = functools.partial(rec.guard_cancel, on_event)

    def _maybe_inject_harness_status() -> None:
        """Point d'étape budget appendé APRÈS les tool results du
        tour (append-only, jamais dans la tête système → prefix-cache intact).
        Invisible côté UI : les messages role:user injectés mi-tour ne sont
        jamais rendus (cf. _tool_segments « prompt / nudge mid-turn »).
        ``working_messages`` lu via la closure (suit les réassignations)."""
        nonlocal _hs_last_status_key, _hs_sandbox_limits
        _hard_left = max(0, _hard_iter_cap - hard_iter)
        # Contexte restant : occupation du dernier appel LLM (les
        # résultats d'outils qui suivent n'y sont pas : ordre de grandeur).
        _u = (rec.last_raw or {}).get("usage") or {}
        _occ = int(_u.get("prompt_tokens", 0) or 0) + int(_u.get("completion_tokens", 0) or 0)
        # Limites de la sandbox : seulement si le shell est offert,
        # annoncées au premier point d'étape du tour, pas à chaque jalon.
        if _hs_sandbox_limits is None:
            _hs_sandbox_limits = (_sandbox_limits_text() or "") if "execute_shell" in _allowed_tool_names else ""
        _hs = _harness_status_line(
            effective_iter, _effective_iter_budget,
            wall_left_s=((_loop_max_s - (time.monotonic() - _loop_t0))
                         if _loop_max_s > 0 else None),
            hard_left=_hard_left,
            ctx_left=(rec.ctx_size - _occ) if _occ else None,
            ctx_size=rec.ctx_size,
            sandbox_limits=_hs_sandbox_limits or None,
        )
        if not _hs:
            return
        # Dédoublonnage par JALON, pas par ``effective_iter`` seul : une
        # itération non productive laisse ``effective_iter`` inchangé, et
        # c'est EXACTEMENT le régime où l'alerte « plafond dur » compte. La
        # clé mixte laisse donc passer l'alerte de cascade tout en gardant un
        # seul point d'étape budget par palier.
        _key = ("hard", _hard_left) if _hard_left <= 5 else ("steps", effective_iter)
        if _key == _hs_last_status_key:
            return
        _hs_last_status_key = _key
        # Annoncées une fois : seulement si CETTE ligne les portait (l'alerte
        # du plafond d'échecs ne les porte pas).
        if _hs_sandbox_limits and "Sandbox limits:" in _hs:
            _hs_sandbox_limits = ""
        # ÉPHÉMÈRE : jamais persisté, donc jamais compté comme un tour
        # (sans quoi ``covered_turns`` sur-compte à la compaction et le
        # tour suivant jette de vrais tours en trop).
        working_messages.append(_ephemeral_msg("user", _hs))

    # Constantes du run et dépendances injectées dans les sous-routines
    # (cf. engine.run) : la fonction de flux et la métrique d'outil sont lues
    # ICI, dans les globales de ce module, où les tests les substituent.
    ctx = RunContext(
        on_event=on_event, username=username, model=model, chat_id=chat_id,
        user_id=user_id, sampling_override=sampling_override,
        thinking_mode=thinking_mode, is_cancelled=is_cancelled,
        compression_enabled=compression_enabled,
        compaction_max_rounds=compaction_max_rounds,
        inline_semaphore=_inline_semaphore, priority=priority,
        live_shell=live_shell, start_time=start_time,
        model_has_vision=_model_has_vision, chat_key_suffix=_chat_key_suffix,
        run_log_tok=_run_log_tok, tools_payload=tools_payload,
        tool_cfg_map=tool_cfg_map, builtin_handlers=builtin_handlers,
        tools_payload_chars=_tools_payload_chars, max_iter=_max_iter,
        effective_iter_budget=_effective_iter_budget,
        hard_iter_cap=_hard_iter_cap,
    )
    deps = LoopDeps(stream=_llama_chat_with_tools_stream,
                    record_metric=_record_tool_call_metric_safe)

    while (effective_iter < _effective_iter_budget
           and hard_iter < _hard_iter_cap and not _forced_stop):

        # Yield cooperatively : permet à CancelledError (task.cancel())
        # de se propager immédiatement ici si client déconnecté — avec le
        # snapshot de la tool_history, comme aux autres points d'annulation
        # (sinon le partiel du tour précédent de boucle perdrait ses outils).
        await _guard_cancel(asyncio.sleep(0))

        # ── Cancellation check (called before LLM request and every tool call) ──
        if is_cancelled and is_cancelled():
            logger.info("[run_chat_multi_mcp] Cancellation demandée par l'utilisateur → arrêt")
            await _emit_partial_tool_history_snapshot()
            raise asyncio.CancelledError("User cancelled")

        # Budget mur d'horloge OPT-IN : une longue chaîne d'outils lents
        # (mais qui réussissent) n'est bornée que par le NOMBRE d'itérations. Si
        # activé (LLAMA_TOOL_LOOP_MAX_S>0) et dépassé, on sort par le chemin
        # « limite atteinte » (tour de synthèse) plutôt que de continuer indéfiniment.
        # La garde « au moins un tour » porte sur le compteur DUR : exiger
        # ``effective_iter > 0`` laisserait un run 100 % en échec (aucune
        # itération productive) échapper au budget de temps jusqu'au cap dur.
        if (_loop_max_s > 0 and (time.monotonic() - _loop_t0) > _loop_max_s
                and (effective_iter > 0 or hard_iter > 0)):
            _forced_stop = True
            _wallclock_stop = True
            await _emit(on_event, {"type": "notice", "level": "warn",
                                   "message": "budget de temps de la tâche atteint — synthèse et arrêt"})
            logger.warning("[run_chat_multi_mcp] budget mur d'horloge (%.0fs) atteint → synthèse", _loop_max_s)
            continue

        # Suivi des compteurs pour le reste de la boucle :
        #   ``iteration`` reste le compteur "absolu" affiché dans les
        #   logs/UI (chaque tour LLM = +1) pour ne pas casser les
        #   messages utilisateurs et la corrélation des _req_id.
        iteration = hard_iter

        # Événement de TOUR ReAct (un appel LLM = un tour, quel que soit le
        # nombre de tool calls qu'il émet). Le moteur d'agents s'en sert pour une
        # barre « tours / budget » fidèle — compter les ``tool_call`` surestime
        # quand le modèle fait des appels parallèles.
        # ``tokens_used`` (cumul in+out de TOUS les tours) SUR-COMPTE
        # massivement l'occupation contexte en mode outils : les
        # prompt_tokens de chaque tour ré-incluent tout l'historique, donc le
        # cumul croît quadratiquement. On émet EN PLUS ``context_tokens`` =
        # prompt+completion du DERNIER tour (l'occupation réelle, même calcul
        # que l'event kv_cache) ; champ additif, fallback ``tokens_used``
        # conservé pour les clients existants. Ne PAS toucher rec.cumul_in/out
        # (sémantique comptable assumée, métriques historiques).
        _last_usage_live = (rec.last_raw or {}).get("usage") or {}
        await _emit(on_event, {
            "type": "iteration", "n": effective_iter + 1, "max": _effective_iter_budget,
            # tokens cumulés des tours PRÉCÉDENTS (in+out) → jauge « Contexte »
            # des agents qui bouge EN DIRECT (pas seulement au budget final).
            "tokens_used": rec.cumul_in + rec.cumul_out,
            "context_tokens": int(_last_usage_live.get("prompt_tokens", 0) or 0)
                            + int(_last_usage_live.get("completion_tokens", 0) or 0),
        })

        await _emit(on_event, {"type": "mode", "text": "Réflexion…"})

        # Tour LLM (engine.llm_turn) : son issue dit quoi faire de l'itération,
        # et la liste de travail est TOUJOURS celle qu'il rend (la compaction et
        # l'aplatissement la réaffectent).
        turn = await call_llm(ctx, rec, st, resume, deps, working_messages,
                              iteration=iteration, effective_iter=effective_iter)
        working_messages = turn.messages
        if turn.outcome == "retry":
            continue
        if turn.outcome == "retry_counted":
            hard_iter += 1
            continue
        if turn.outcome == "stop_empty":
            _empty_choices_stop = True
            break
        if turn.outcome == "fatal":
            return await finish_on_error(
                ctx, rec, resume, error=turn.error, err_kind=turn.err_kind,
                live=turn.live, thinking_parts=turn.thinking_parts,
                iteration=iteration, effective_iter=effective_iter,
                hard_iter=hard_iter)

        # Réponse décodée, relue par les chemins d'outils, les reprises et la
        # réponse finale.
        _live = turn.live
        raw_response = turn.raw_response
        usage = turn.usage
        finish = turn.finish
        msg = turn.msg
        tool_calls = turn.tool_calls
        _iter_thinking = turn.iter_thinking
        _iter_clean = turn.iter_clean
        _raw_content_exact = turn.raw_content_exact

        # ── Tool call TRONQUÉ par la limite de génération ─────────────────
        # finish_reason == "length" + tool_calls : le modèle a été coupé
        # EN PLEIN MILIEU de l'émission de l'appel d'outil, fenêtre de
        # contexte pleine ou plafond de sortie atteint. Les `arguments`
        # sont donc un JSON tronqué/invalide. Conséquences si on laisse passer :
        #   * exécution → ValidationError pydantic (ex: write_file sans
        #     `path`, FastMCP rejette avant même le corps de l'outil) ;
        #   * SURTOUT : sauver ce message assistant aux tool_calls cassés
        #     empoisonne l'historique → 500 en boucle aux tours suivants.
        # On ne l'exécute donc PAS et on ne sauve PAS les tool_calls
        # tronqués : on garde le texte produit, on explique au modèle, et
        # on reboucle pour qu'il réémette un appel plus compact.
        if finish == "length" and tool_calls:
            await _live.flush()
            if await trunc.cut(NATIF.name, ctx, rec, working_messages, usage=usage,
                               iter_clean=_iter_clean, iteration=iteration):
                _forced_stop = True
            hard_iter += 1
            continue

        if finish == "tool_calls" or tool_calls:
            # ── Canal natif : le LLM retourne tool_calls structurés ───────
            channel = NATIF
            prepared = await open_native_round(
                ctx, rec, working_messages, live=_live, msg=msg,
                tool_calls=tool_calls, iter_clean=_iter_clean, iteration=iteration)
        else:
            # ── Canal texte : appels écrits dans la prose ─────────────────
            reply = classify_text_reply(ctx, _live, _iter_clean, iteration)
            raw_text, _iter_clean = reply.raw_text, reply.iter_clean
            legacy_calls = reply.calls

            # Même garde que le canal natif, pour un appel écrit en TEXTE :
            # ``extract_tool_calls`` a des regex ancrées sur la fin de chaîne
            # (``…|$``), donc un bloc <tool_call>/<function=> coupé en plein
            # milieu est quand même « extrait » avec des arguments malformés.
            if finish == "length" and legacy_calls:
                await _live.flush()
                if await trunc.cut(TEXTE.name, ctx, rec, working_messages, usage=usage,
                                   iter_clean=_iter_clean, iteration=iteration):
                    _forced_stop = True
                hard_iter += 1
                continue

            # Tentative d'appel qui n'a rien exécuté (illisible, perdue dans
            # le reasoning, ou vers un outil inconnu) : relance bornée.
            _relaunched, _malformed_retry = await relaunch_unparsed_call(
                rec, working_messages, reply, live=_live,
                iter_thinking=_iter_thinking, iteration=iteration,
                malformed_retry=_malformed_retry)
            if _relaunched:
                hard_iter += 1
                continue

            if not legacy_calls:
                if await resume.plan(
                        ctx, live=_live, finish=finish, tool_calls=tool_calls,
                        legacy_calls=legacy_calls, iter_thinking=_iter_thinking,
                        iter_clean=_iter_clean, raw_content_exact=_raw_content_exact,
                        raw_response=raw_response, gauge_ctx_total=rec.gauge_ctx_total,
                        iteration=iteration):
                    # Une reprise n'est pas un tour productif : hard_iter seul.
                    hard_iter += 1
                    continue

                return await finish_ok(
                    ctx, rec, resume, working_messages, live=_live, msg=msg,
                    raw_text=raw_text, finish=finish, iter_thinking=_iter_thinking,
                    iteration=iteration, effective_iter=effective_iter)

            _malformed_retry = 0     # parse OK sur le canal texte → budget de relance réarmé
            channel = TEXTE
            prepared = open_text_round(
                ctx, rec, working_messages, raw_text=raw_text, calls=legacy_calls,
                finish=finish, iteration=iteration)

        # Lot lu avec succès ⇒ le contexte n'est pas (plus) saturé, et le
        # chaînage d'auto-reprises repart de zéro (par appel LLM).
        trunc.reset()
        resume.reset_chain()

        # Exécution du lot, commune aux deux canaux (engine.tool_dispatch).
        out = await run_tool_batch(channel, ctx, rec, deps, working_messages, prepared,
                                   iteration=iteration, cycle=cycle)
        if out.cycle_hard_stopped:
            _cycle_hard_stopped = True
            _forced_stop = True

        # ── Avancement des compteurs ──────────────────────────────
        # ``hard_iter`` toujours +1 (cap absolu anti-boucle infinie).
        # ``effective_iter`` +1 SEULEMENT si l'itération a été
        # productive (au moins un tool call sans erreur). Une
        # itération 100% ratée ne consomme PAS le budget user.
        hard_iter += 1
        if out.had_success:
            effective_iter += 1
            # Itération PRODUCTIVE ⇒ les séries de récupération liées au
            # CONTENU sont réarmées : le modèle vient de produire un
            # appel exploitable, les erreurs de format antérieures sont de
            # l'histoire ancienne. Le blocage anti-boucle se relâche de la
            # même façon, après une plage franche d'itérations utiles.
            _malformed_retry = 0
            cycle.on_productive()
        else:
            logger.info(channel.log_unproductive, iteration, effective_iter,
                        _effective_iter_budget, hard_iter, _hard_iter_cap)
        _maybe_inject_harness_status()

    return await finish_on_limit(
        ctx, rec, resume, deps, working_messages,
        effective_iter=effective_iter, hard_iter=hard_iter,
        wallclock_stop=_wallclock_stop,
        ctx_saturated_stop=(trunc.stop == "ctx_saturated"),
        gen_cap_stop=(trunc.stop == "gen_cap"), cycle_hard_stopped=_cycle_hard_stopped,
        empty_choices_stop=_empty_choices_stop)

# Nom public : le wrapper, habillé de la signature/doc de l'impl.
# ``functools.wraps`` est posé APRÈS coup (l'impl est définie APRÈS le
# wrapper dans le fichier). ``inspect.signature`` suit ``__wrapped__`` :
# l'iso-signature avec v2 voit la vraie impl, pas le wrapper. (Les tests qui
# lisent le code de la boucle passent par ``tests/_sources.py``.)
run_chat_multi_mcp = functools.wraps(_run_chat_multi_mcp_impl)(_run_chat_multi_mcp_wrapper)


async def run_chat_multi_mcp_v2(
    messages: List[Dict[str, Any]],
    mcp_configs: List[Dict[str, Any]],
    on_event: Optional[Callable] = None,
    username: str = "guest",
    model: Optional[str] = None,
    builtin_tools: Optional[Dict[str, Any]] = None,
    is_cancelled: Optional[Callable[[], bool]] = None,
    chat_id: Optional[str] = None,
    sampling_override: Optional[Dict[str, Any]] = None,
    thinking_mode: bool = False,
    allowed_tool_names: Optional[set] = None,
    memory_enabled: bool = True,
    priority: str = "high",
    compression_prev_state: Optional[Dict[str, Any]] = None,
    deny_tool_names: Optional[set] = None,
    live_shell: bool = False,
    compression_enabled: Optional[bool] = None,
    compaction_threshold: Optional[CompactionThreshold] = None,
    compaction_max_rounds: Optional[int] = None,
    prune_keys: Optional[list] = None,
    read_only: bool = False,
    user_id: Optional[int] = None,
) -> Tuple[str, List[Dict[str, Any]], Dict[str, Any]]:
    """Variante "optimized" : sémaphore LLM acquis INLINE autour de chaque
    appel LLM dans la boucle tool-calling, PAS autour de toute la fonction.

    Le caller NE DOIT PAS wrapper cet appel dans un ``async with
    LLM_SEMAPHORE.acquire_for(...)`` — la fonction gère le sémaphore
    elle-même. Sinon deadlock ou sérialisation inutile.

    :param priority: ``"high"`` (chat user) ou ``"low"`` (pipeline).
        Propagée à chaque acquire interne du sémaphore inline pour
        que les pipelines cèdent leur tour aux chats user.

    Voir run_chat_multi_mcp pour la documentation complète du comportement
    de la boucle tool-calling.
    """
    return await run_chat_multi_mcp(
        messages           = messages,
        mcp_configs        = mcp_configs,
        on_event           = on_event,
        username           = username,
        model              = model,
        builtin_tools      = builtin_tools,
        is_cancelled       = is_cancelled,
        chat_id            = chat_id,
        sampling_override  = sampling_override,
        thinking_mode      = thinking_mode,
        allowed_tool_names = allowed_tool_names,
        memory_enabled     = memory_enabled,
        _inline_semaphore  = True,
        priority           = priority,
        compression_prev_state = compression_prev_state,
        deny_tool_names    = deny_tool_names,
        live_shell         = live_shell,
        compression_enabled = compression_enabled,
        compaction_threshold = compaction_threshold,
        compaction_max_rounds = compaction_max_rounds,
        # DOIT être relayé : la route choisit v2 en mode « optimized », et un
        # paramètre oublié ici ne dégrade pas — il lève un TypeError à l'appel,
        # pour la moitié des déploiements seulement (cf. test d'iso-signature).
        prune_keys         = prune_keys,
        read_only          = read_only,
        user_id            = user_id,
    )

def build_task_builtin_tool(**kwargs):
    """Proxy fin vers :func:`tools.task_tool.build_task_builtin_tool` — garde le
    contrat d'import public ``from llm_core import build_task_builtin_tool``
    stable (façade). Import tardif : ``tools.task_tool`` charge ``run_chat_multi_mcp``
    à l'exécution du handler, jamais à l'import (pas de cycle)."""
    from llm_core.tools.task_tool import build_task_builtin_tool as _build
    return _build(**kwargs)
