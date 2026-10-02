# SPDX-License-Identifier: MIT
"""llm_core.engine.llm_turn — un tour LLM de la boucle agentique.

``call_llm`` fait tout ce qui sépare la tête d'itération de la réponse
décodée : rappels de flux (raisonnement, contenu en direct, fragments
d'arguments, progression du préremplissage), surcoût du schéma d'outils, porte
de compaction, élagage intra-run, ajustement au budget de contexte
(``fit_context``), consommation de la reprise en attente, slot LLM, appel,
récupération des échecs (contexte dépassé → compaction, historique
empoisonné → aplatissement, hoquet du moteur), cumul d'usage, occupation et
jauge (``kv_cache``), réponse sans ``choices``, puis décodage et fusion des
reprises.

Il rend un ``LLMTurn`` à l'issue explicite — ``ok``, ``retry`` (relancer
l'itération), ``retry_counted`` (relancer en comptant un tour dur),
``stop_empty`` (le moteur ne renvoie plus que des réponses vides) ou
``fatal`` (la sortie d'erreur du run) — et TOUJOURS la liste de travail, que
la compaction et l'aplatissement réaffectent.

``LLMTurnState`` est l'état privé de ces tours d'un bout à l'autre du run :
mesure du contexte, compactions, séries de récupération. Personne d'autre ne
le lit.
"""
from __future__ import annotations

import asyncio
import functools
import logging
import secrets
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional

from llm_core import _model_info
from llm_core._chat_classic import _extract_thinking, llama_chat
from llm_core._llm_retry import (
    KIND_CONTEXT_OVERFLOW as _KIND_CTX_OVERFLOW,
    KIND_FORBIDDEN as _KIND_FORBIDDEN,
    KIND_INVALID_REQUEST as _KIND_INVALID_REQUEST,
    KIND_RATE_LIMITED as _KIND_RATE_LIMITED,
    KIND_UNKNOWN as _KIND_UNKNOWN,
    error_body_text as _llm_error_body_text,
    llm_error_kind as _llm_error_kind,
)
from llm_core._scheduling._guard import _emit
from llm_core._think_tokens import native_reasoning_tokens as _native_reasoning_tokens
from llm_core.context import pruning as _pruning
from llm_core.context.compaction_gate import CompactionThreshold
from llm_core.context.pruning import truncate_head_tail as _truncate_head_tail
from llm_core.context.tokens import count_tools_tokens_ex as _count_tools_payload_tokens_ex
from llm_core.engine.live_text import LiveText
from llm_core.engine.resume import ResumeRequest, ResumeState
from llm_core.engine.run import (
    LoopDeps,
    RunContext,
    RunRecord,
    _clip_thinking_history,
    engine_semaphore,
    llm_slot,
)
from llm_core.engine.tool_dispatch import _noter_attente
from shared_infra import config as _bk_config
from shared_infra.config import LLAMA_MODEL
from shared_infra.db import log_metric
from shared_infra.observability.tracing import swallow

logger = logging.getLogger("uvicorn.error")

# Harnais long-run — lus À L'IMPORT comme les autres constantes de ce module.
# Cadence de l'élagage intra-run et nombre de compactions réussies autorisées
# dans un même run.
_PRUNE_EVERY_ITERS = int(getattr(_bk_config, "PRUNE_EVERY_ITERS", 10) or 0)
_COMPACTIONS_PER_RUN_MAX = max(
    1, int(getattr(_bk_config, "COMPACTIONS_PER_RUN_MAX", 2) or 2))



# Relance posée quand l'aplatissement laisserait un message ASSISTANT en
# dernier : un assistant final est interprété comme un « prefill » à
# continuer par les llama-server récents, qui n'en acceptent qu'un. Le
# filet doit rendre la main au modèle, pas lui demander de terminer sa
# propre phrase.
_FLATTEN_RESUME_NUDGE = (
    "[SYSTEM] The structured tool history above was flattened to plain text "
    "for compatibility. Pick the mission up where it stands and continue."
)


# Un 429 n'est pas toujours un rate-limit passager : « quota épuisé » (OpenAI
# ``insufficient_quota``) se classe aussi RATE_LIMITED, alors que le rejouer
# redonnera la même réponse tant que personne n'a rechargé le compte.
# (« Quota exceeded … per minute » de certaines passerelles est, lui, un vrai
# rate-limit : on ne retient que les marqueurs d'un solde épuisé.)
_QUOTA_MARKERS = ("insufficient_quota", "exceeded your current quota")


def _llm_error_hiccup_ok(kind: str, err: Optional[BaseException], *,
                         flatten_pending: bool) -> bool:
    """La relance « hoquet » (même requête, après un backoff) peut-elle
    aboutir pour cette famille de panne ?

    Non pour les pannes DÉTERMINISTES — rejouer la même requête redonne la
    même erreur, douze secondes plus tard et trois fois de suite :
      * dépassement de contexte (a son propre chemin de compaction ; s'il n'a
        pas pu compacter, la requête ne rétrécira pas toute seule) ;
      * refus d'accès (401/403, offre fermée) ;
      * quota épuisé (429 porteur d'un marqueur de quota) ;
      * requête refusée (4xx) une fois l'aplatissement consommé. AVANT, les
        hoquets restent le chemin qui y mène (on ne court-circuite pas le
        retry transitoire, et l'aplatissement n'arrive qu'après eux)."""
    if kind in (_KIND_CTX_OVERFLOW, _KIND_FORBIDDEN):
        return False
    if kind == _KIND_RATE_LIMITED:
        body = _llm_error_body_text(err).lower()
        if any(m in body for m in _QUOTA_MARKERS):
            return False
    if kind == _KIND_INVALID_REQUEST and not flatten_pending:
        return False
    return True


def _unique_tool_call_ids(tool_calls: List[Dict[str, Any]],
                          history: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Garantit des ids d'appel UNIQUES sur tout l'historique. PURE (copie).

    Les ids de repli sont positionnels (``call_0``, ``call_1``… :
    accumulateur SSE sans ``id`` fourni par le serveur, récupération depuis
    le raisonnement, repli après 500), donc IDENTIQUES d'une itération à
    l'autre. Or tout ce qui indexe par id prend la dernière occurrence :
    l'élagage (nom d'outil → protection), le résumeur (statut ok/ÉCHEC
    épinglé), la matérialisation d'un Stop (un résultat de ``write_file``
    écarté parce que ``call_0`` d'un round précédent « existe déjà » →
    écriture rejouée au Continuer). Un id vide ou déjà vu reçoit un id neuf ;
    un id fourni et inédit est gardé tel quel."""
    if not tool_calls:
        return tool_calls
    seen = set()
    for m in history or []:
        if isinstance(m, dict) and m.get("role") == "assistant":
            for tc in (m.get("tool_calls") or []):
                if isinstance(tc, dict) and tc.get("id"):
                    seen.add(tc["id"])
    out: List[Dict[str, Any]] = []
    for tc in tool_calls:
        if not isinstance(tc, dict):
            out.append(tc)
            continue
        _id = tc.get("id")
        if not _id or _id in seen:
            tc = {**tc, "id": f"call_{secrets.token_hex(6)}"}
        seen.add(tc["id"])
        out.append(tc)
    return out


def _flatten_tool_messages(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Dernier recours : convertit tout message lié aux outils en TEXTE.

    Le résultat ne contient plus que des messages ``system``/``user``/
    ``assistant`` avec un simple ``content`` — aucun ``tool_calls``,
    aucun ``role:"tool"``. C'est le filet qui empêche un chat d'être
    DÉFINITIVEMENT bloqué quand la sanitisation n'a pas suffi à
    identifier le poison. Le modèle perd le détail structuré des outils
    mais garde l'info en texte, et surtout le chat redevient utilisable.

    ⚠ La FORME du résultat compte autant que son contenu. Replier chaque
    résultat d'outil dans le message ``assistant`` qui le précède
    produirait, sur une boucle agentique, une file de N messages
    ``assistant`` CONSÉCUTIFS terminée par un assistant : le même
    llama-server qui accepte l'historique structuré (dernier message
    ``tool``) refuse cette forme en 400 — les builds récents traitent un
    assistant final comme un « prefill » à continuer et posent une limite
    d'un seul. La seule voie de récupération du run se solderait par un
    second refus.

    On rend donc au résultat une forme conversationnelle stricte :
      - les observations d'outils redeviennent des messages ``user``
        (c'est ce qu'elles sont : de l'information DONNÉE au modèle) ;
      - les messages system sont hissés en tête ;
      - deux messages de même rôle ne se suivent jamais ;
      - le dernier message n'est JAMAIS un assistant.

    Les marques ``_ephemeral`` / ``_task_anchor`` survivent (comptage des
    tours de la compaction, ancre protégée par le budget dur) :
      - un message d'origine les garde ; une fusion n'est éphémère que si
        TOUTES ses parties l'étaient (un vrai ``user`` fusionné reste un tour),
        et reste ancre si l'une d'elles l'était ;
      - une observation d'outil devenue ``user`` est éphémère : un ``tool``
        n'ouvre pas de tour et n'est pas l'énoncé de la tâche — sans la
        marque, chaque résultat aplati compterait pour un tour et deviendrait
        « la demande en cours » aux yeux du budget dur ;
      - la relance finale (``_FLATTEN_RESUME_NUDGE``) est un nudge du harnais.
    """
    systems: List[Dict[str, Any]] = []
    body: List[Dict[str, Any]] = []

    def _text_of(m: Dict[str, Any]) -> str:
        content = m.get("content")
        if isinstance(content, list):
            content = " ".join(
                b.get("text", "") for b in content
                if isinstance(b, dict) and isinstance(b.get("text"), str)
            )
        return str(content or "")

    def _push(role: str, text: str, *, ephemeral: bool = False,
              anchor: bool = False) -> None:
        text = (text or "").strip()
        if not text:
            return
        if body and body[-1].get("role") == role:
            prev = body[-1]
            prev["content"] = f"{prev['content']}\n\n{text}"
            if not (ephemeral and prev.get("_ephemeral")):
                prev.pop("_ephemeral", None)
            if anchor:
                prev["_task_anchor"] = True
            return
        msg: Dict[str, Any] = {"role": role, "content": text}
        if ephemeral:
            msg["_ephemeral"] = True
        if anchor:
            msg["_task_anchor"] = True
        body.append(msg)

    for m in messages:
        if not isinstance(m, dict):
            continue
        role = m.get("role")
        if role == "system":
            systems.append({**m, "content": _text_of(m)})
        elif role == "tool":
            txt = _text_of(m)
            if len(txt) > 8000:
                # Tête+queue (pas tête-seule) : la fin d'un résultat d'outil —
                # verdict, dernière erreur — est souvent la partie décisive.
                txt = _truncate_head_tail(txt, 8000)
            _push("user", f"[Tool result — previous turn]\n{txt}", ephemeral=True)
        elif role == "assistant":
            content = _text_of(m)
            if m.get("tool_calls"):
                names = [
                    (tc.get("function") or {}).get("name", "?")
                    for tc in (m.get("tool_calls") or [])
                    if isinstance(tc, dict)
                ]
                content = (content + f"\n[Tools called: {', '.join(names)}]").strip()
            _push("assistant", content or "(...)",
                  ephemeral=bool(m.get("_ephemeral")))
        else:
            # user, et tout rôle exotique : côté « entrée du modèle ».
            _push("user", _text_of(m), ephemeral=bool(m.get("_ephemeral")),
                  anchor=bool(m.get("_task_anchor")))

    if not body or body[-1].get("role") == "assistant":
        body.append({"role": "user", "content": _FLATTEN_RESUME_NUDGE,
                     "_ephemeral": True})
    return systems + body


# Séries de récupération : des ENCHAÎNEMENTS bornés, pas des totaux de run.
# Dimensionnés pour un tour de conversation, des totaux de run seraient
# absurdes sur une mission : deux hoquets moteur espacés de deux heures, ou
# trois JSON cassés en 300 itérations, tueraient un run par ailleurs
# parfaitement productif. Toutes sont remises à zéro dès qu'une itération
# aboutit.
_CTX_OVERFLOW_RETRY_MAX = 2      # relances après compaction sur « contexte dépassé »
_LLM_HICCUP_RETRY_MAX = 3        # hoquets transitoires du moteur
_EMPTY_CHOICES_RETRY_MAX = 3     # réponses sans ``choices``


@dataclass(slots=True)
class LLMTurnState:
    """État privé des tours LLM, d'un bout à l'autre du run."""

    # Budget de compactions RÉUSSIES de ce run et seuil « contexte max avant
    # compaction » : résolus une fois (cf. ``for_run``, qui retombe sur le
    # défaut d'instance quand l'appelant n'en donne pas).
    run_compaction_max: int
    compaction_threshold: CompactionThreshold
    # État de compression persisté du chat (round / tours couverts / résumé) :
    # avance localement si une compaction réussit DANS ce run. Cap par
    # conversation atteint → ``compr_capped`` coupe les essais pour le run.
    compr_state_cur: Optional[Dict[str, Any]] = None
    compr_capped: bool = False
    compactions_this_run: int = 0
    # Backoff des ÉCHECS de compaction : chaque échec consécutif repousse la
    # tentative suivante de 3×2^streak itérations (cap ×8) ; remis à zéro au
    # succès.
    last_compression_iter: int = -1_000_000   # sentinelle : « jamais »
    compr_fail_streak: int = 0
    # Trace « la compaction est partie sur le seuil du compte » : une fois par
    # run, sinon chaque itération au-dessus du seuil la répéterait.
    compaction_threshold_logged: bool = False
    # True si le budget dur a RETIRÉ des messages au dernier fit : la mesure
    # réelle décrit alors la vue RÉDUITE, pas ``working_messages`` complet →
    # on la débranche (porte sur l'estimation du complet, fast-path coupé)
    # pour ne pas masquer la saturation.
    fit_dropped: bool = False
    # Occupation RÉELLE du dernier appel (``prompt_tokens`` du serveur) et
    # longueur de ``working_messages`` à cet instant. None tant qu'aucune
    # réponse n'est reçue — autorité de la règle d'overflow et du fast-path
    # du budget dur.
    last_real_ctx_tok: Optional[int] = None
    real_ctx_msg_count: Optional[int] = None
    # Ancrage d'occupation EXACTE de l'historique COMPLET : posé quand une
    # confirmation exacte a refusé la compaction. Contrairement à la mesure
    # serveur (qui décrit la VUE envoyée et est invalidée par un retrait du
    # budget dur), il mesure ``working_messages`` entier — valide quels que
    # soient les retraits, il croît par delta mesuré. Sans lui, le cycle
    # estimation → confirmation se repaierait à chaque itération dès que le
    # budget dur retire des messages.
    occ_anchor_tok: Optional[int] = None
    occ_anchor_count: Optional[int] = None
    # Dernière itération de l'élagage intra-run (cadence ``_PRUNE_EVERY_ITERS``).
    last_prune_iter: int = -10_000
    # Avertissement « contexte non réductible » : UNE fois par tour (la
    # condition, elle, se répète à chaque itération).
    over_budget_warned: bool = False
    # Récupération « historique empoisonné » : une seule fois par run.
    flatten_retry_done: bool = False
    # Séries de récupération (cf. les plafonds ci-dessus).
    ctx_overflow_retries: int = 0
    llm_hiccup_streak: int = 0
    # Compteur DÉDIÉ aux réponses vides : ``llm_hiccup_streak`` est remis à
    # zéro dès qu'un appel ABOUTIT — or une réponse vide EST un appel abouti.
    # Celui-ci n'est réarmé que par une réponse EXPLOITABLE.
    empty_choices_streak: int = 0

    @classmethod
    def for_run(cls, *, compression_prev_state: Optional[Dict[str, Any]],
                compaction_threshold: Optional[CompactionThreshold],
                compaction_max_rounds: Optional[int],
                max_iter: int) -> "LLMTurnState":
        """État initial d'un run.

        Compactions réussies par run : une seule serait tenable pour un tour
        court, absurde pour 200 itérations — passé la première, il ne
        resterait que le budget dur, qui JETTE les vieux tours au lieu de les
        résumer. Plafond : ``COMPACTIONS_PER_RUN_MAX`` mis à l'échelle du
        budget d'itérations réel de CE run (le réglage global ne connaît pas un
        ``max_tool_iterations`` relevé depuis l'interface) : une compaction par
        tranche de ~25 itérations productives, jamais moins que le réglage. Le
        cap PAR CONVERSATION choisi par le compte relève ce budget quand il est
        plus haut : sur une mission de plusieurs heures, tout tient dans UN
        run, et un budget de run inférieur au cap réglé couperait la compaction
        en plein milieu sans rien expliquer.

        Seuil de compaction : choix du compte, sinon défaut d'instance, sinon
        auto (plafond technique). Résolu UNE fois par run — un seuil qui
        changerait en plein run ferait bouger la porte d'une itération à
        l'autre pour rien."""
        from llm_core.context.compaction_gate import (
            run_compaction_budget as _run_budget,
        )
        _run_compaction_max = _run_budget(
            max(_COMPACTIONS_PER_RUN_MAX, min(64, max(1, max_iter // 25))),
            compaction_max_rounds)
        if _run_compaction_max != _COMPACTIONS_PER_RUN_MAX:
            logger.info(
                "[run_chat_multi_mcp] budget de compactions du run : %d "
                "(réglage %d, mis à l'échelle sur %d itérations, cap du compte %s)",
                _run_compaction_max, _COMPACTIONS_PER_RUN_MAX, max_iter,
                "—" if compaction_max_rounds is None
                else ("illimité" if compaction_max_rounds <= 0
                      else compaction_max_rounds))
        _compaction_threshold = compaction_threshold
        if _compaction_threshold is None:
            from llm_core.context.compaction_gate import resolve_threshold
            _compaction_threshold = resolve_threshold()   # défaut d'instance seul
        return cls(run_compaction_max=_run_compaction_max,
                   compaction_threshold=_compaction_threshold,
                   compr_state_cur=compression_prev_state)


# Issue d'un tour LLM (cf. ``LLMTurn``) : l'orchestrateur aiguille sur ces
# seules valeurs.
TurnOutcome = Literal["ok", "retry", "retry_counted", "stop_empty", "fatal"]


@dataclass(frozen=True, slots=True)
class LLMTurn:
    """Issue d'un tour LLM et ce que les phases suivantes en relisent.

    ``outcome`` : ``ok`` (réponse décodée), ``retry`` (relancer l'itération),
    ``retry_counted`` (relancer en comptant un tour dur), ``stop_empty`` (le
    moteur ne renvoie plus que des réponses vides) ou ``fatal`` (sortie
    d'erreur du run, ``error`` et ``err_kind`` renseignés). ``messages`` est
    TOUJOURS la liste de travail courante : la compaction et l'aplatissement
    la réaffectent. ``live`` porte le tampon et l'émission directe du contenu
    de l'itération, ``thinking_parts`` les jetons de raisonnement."""

    outcome: TurnOutcome
    messages: List[Dict[str, Any]]
    live: LiveText
    thinking_parts: List[str]
    error: Optional[BaseException] = None
    err_kind: Optional[str] = None
    raw_response: Dict[str, Any] = field(default_factory=dict)
    usage: Dict[str, Any] = field(default_factory=dict)
    finish: Any = ""
    msg: Dict[str, Any] = field(default_factory=dict)
    tool_calls: List[Dict[str, Any]] = field(default_factory=list)
    iter_thinking: str = ""
    iter_clean: str = ""
    raw_content_exact: str = ""


def _auto_compaction_on(ctx: RunContext) -> bool:
    """Compaction automatique active pour ce run ? Décision résolue par
    l'appelant, sinon interrupteur maître RELU du disque : lu avant la
    resynchronisation, il garderait une valeur périmée pour les runs sans
    appelant (routines, agents) quand l'admin l'a changée depuis un autre
    worker."""
    if ctx.compression_enabled is not None:
        return bool(ctx.compression_enabled)
    with swallow("harness.auto_compaction_reload"):
        from shared_infra.config import reload_compression_config_from_disk
        reload_compression_config_from_disk()
    return bool(getattr(_bk_config, "COMPRESSION_ENABLED", True))


async def call_llm(ctx: RunContext, rec: RunRecord, st: LLMTurnState,
                   resume: ResumeState, deps: LoopDeps,
                   working_messages: List[Dict[str, Any]], *,
                   iteration: int, effective_iter: int) -> LLMTurn:
    """Un tour LLM de la boucle, de la tête d'itération à la réponse décodée
    (voir l'en-tête du module). Une panne de l'appel LLM devient une issue ;
    une annulation se propage, après l'instantané de la tool_history."""
    # Constantes du run sous leurs noms locaux usuels.
    on_event = ctx.on_event
    model = ctx.model
    username = ctx.username
    chat_id = ctx.chat_id
    sampling_override = ctx.sampling_override
    thinking_mode = ctx.thinking_mode
    is_cancelled = ctx.is_cancelled
    compression_enabled = ctx.compression_enabled
    compaction_max_rounds = ctx.compaction_max_rounds
    tools_payload = ctx.tools_payload
    priority = ctx.priority
    _guard_cancel = functools.partial(rec.guard_cancel, on_event)
    _emit_partial_tool_history_snapshot = functools.partial(
        rec.emit_partial_snapshot, on_event)

    def _fin(outcome: TurnOutcome, **champs: Any) -> LLMTurn:
        """Issue du tour, avec la liste de travail COURANTE (réaffectée par la
        compaction et l'aplatissement) et les tampons de l'itération."""
        return LLMTurn(outcome, working_messages, _live, _iter_thinking_parts, **champs)

    # Callbacks streaming : thinking et contenu émis token par token
    # (contenu : émission directe, cf. engine.live_text).
    _iter_thinking_parts: List[str] = []
    _live = LiveText(on_event)
    _iter_content_parts: List[str] = _live.parts

    async def _on_think_iter(tok: str, _buf: List[str] = _iter_thinking_parts) -> None:
        _buf.append(tok)
        await _emit(on_event, {"type": "thinking_token", "text": tok})

    # Des fragments d'arguments (tool_call_delta) ont été
    # streamés pour une itération qui n'a PAS abouti à des tool_call
    # (coupure en pleine génération des args, hoquet, aplatissement,
    # rattrapage overflow, tool_call tronqué) : ce tour de boucle la
    # rejoue ou l'abandonne — le front doit jeter l'accumulateur de cette
    # itération, sinon le JSON d'args est concaténé deux fois (aperçu
    # Monaco corrompu) ou l'édition optimiste reste ouverte.
    if rec.delta_pending_iter is not None:
        await _emit(on_event, {"type": "tool_call_delta", "reset": True,
                               "index": -1, "iter": rec.delta_pending_iter})
        rec.delta_pending_iter = None

    # Callback streaming : fragments d'arguments des tool_calls en cours
    # de génération par le LLM. Émis AVANT l'exécution du tool, purement
    # informatif pour le frontend (pré-affichage streaming de
    # write_file / edit_file dans l'éditeur). Le frontend accumule et
    # décode progressivement le JSON des args. Chaque index correspond
    # à un tool call distinct dans la même itération (parallel tool use).
    async def _on_tool_call_delta_iter(
        index: int,
        name_delta: str,
        args_delta: str,
        _iter: int = iteration,
    ) -> None:
        # Le modèle a FINI sa prose : plus aucun texte ne suivra dans ce
        # flux (les deltas d'appel viennent après le contenu). On relâche
        # la fenêtre de retenue MAINTENANT — sinon les ≤48 derniers
        # caractères de la phrase resteraient invisibles pendant toute la
        # génération des arguments (plusieurs secondes pour un
        # write_file) et surgiraient d'un coup avec l'appel.
        await _live.flush()
        # On ne transmet que s'il y a quelque chose à transmettre. Le
        # frontend utilise un reset automatique par iteration (tracking
        # via `call_idx` + `iteration`). `_iter` est figé via default
        # arg pour éviter tout piège de late-binding en closure.
        evt: Dict[str, Any] = {
            "type":  "tool_call_delta",
            "index": index,
            "iter":  _iter,
        }
        rec.delta_pending_iter = _iter    # cf. reset en tête de boucle
        if name_delta:
            evt["name_delta"] = name_delta
        if args_delta:
            evt["args_delta"] = args_delta
        await _emit(on_event, evt)

    # Progression du PRÉ-REMPLISSAGE. C'est la phase où le flux est
    # totalement muet : mesuré 33 s pour 4 339 tokens sur GPU grand
    # public, donc plusieurs MINUTES sur un historique long — pendant
    # lesquelles l'utilisateur ne peut pas distinguer « ça calcule » de
    # « c'est planté ». Le moteur sait le dire depuis b10545, on le relaie.
    #
    # ``cache`` est le bonus : c'est le nombre de tokens RÉELLEMENT
    # réutilisés du préfixe KV, donc la première mesure directe de ce que
    # produisent nos efforts de byte-stabilité (ordre figé des outils,
    # coupes idempotentes, ancrage du prompt).
    _pp_last_emit = [0.0]
    _pp_logged = [False]

    async def _on_prompt_progress(pp: Dict[str, Any]) -> None:
        _total = int(pp.get("total") or 0)
        _done = int(pp.get("processed") or 0)
        _cache = int(pp.get("cache") or 0)
        # Prompt de l'appel EN VOL : un Stop pendant la génération
        # perdrait sinon ses tokens d'entrée — souvent le
        # plus gros poste du run. Remis à zéro par ``RunRecord.usage_note`` dès
        # que l'appel se termine et entre dans le cumul.
        if rec.usage_acc is not None and _total > 0:
            rec.usage_acc["inflight_in"] = _total
        _final = _total > 0 and _done >= _total
        _now = time.monotonic()
        # Cadence : au plus un événement par demi-seconde, mais le dernier
        # (100 %) passe toujours — sans quoi la barre resterait figée.
        if _final or (_now - _pp_last_emit[0]) >= 0.5:
            _pp_last_emit[0] = _now
            await _emit(on_event, {
                "type": "prompt_progress",
                "total": _total, "processed": _done, "cache": _cache,
                "time_ms": int(pp.get("time_ms") or 0),
                "iter": iteration,
            })
        if _final and not _pp_logged[0] and _total > 0:
            _pp_logged[0] = True
            logger.info(
                "[run_chat_multi_mcp] pré-remplissage iter %d : %d tokens, "
                "%d réutilisés du cache KV (%.0f %%), %.1f s",
                iteration, _total, _cache, 100.0 * _cache / _total,
                (pp.get("time_ms") or 0) / 1000.0)
            with swallow("harness.kv_reuse_metric"):
                await asyncio.to_thread(
                    log_metric, "kv_prefix_reuse_pct",
                    int(100.0 * _cache / _total), {
                        "model": model or LLAMA_MODEL or "",
                        "iteration": iteration,
                    })

    # Demande d'auto-reprise CONSOMMÉE par cet appel (cf. plus bas) :
    # posé juste avant l'appel, il dit aux relances (hoquet, aplatissement,
    # compaction, réponse sans ``choices``) qu'il faut la RESTITUER.
    _resume_consumed = False
    _resume_req = ResumeRequest()

    # Wrap l'appel LLM principal pour ne pas crasher la boucle entière
    # si llama-server hoquète sur un seul tour (parser tool_calls qui
    # plante, timeout transient, etc.). Au lieu de raise, on émet un
    # event d'erreur et on retourne le partiel accumulé.
    try:
        # n_ctx à 0 sur un échec TRANSITOIRE de /props au démarrage (llama
        # saturé au 1er tour) désactiverait budget ET compression pour TOUT
        # le run (early-return sur ctx<=0), même après récupération du
        # serveur → prompt jamais élagué → finish=length en plein tool_call.
        # On re-sonde tant que c'est 0 : la valeur correcte est déjà chauffée
        # par clamp_generation_budget (re-sonde chaque itération). Cache
        # global → quasi-gratuit une fois chaud.
        if not rec.ctx_size or rec.ctx_size <= 0:
            with swallow("harness.run_chat_multi_mcp_impl"):
                rec.ctx_size = await _model_info.get_model_context_size(
                    model or LLAMA_MODEL or "")
                if (rec.ctx_size and rec.ctx_size > 0
                        and rec.gauge_ctx_total <= 0):
                    # Re-évalue la visibilité de la jauge (tout serveur
                    # llama.cpp, intégré ou connecteur).
                    with swallow("harness.run_chat_multi_mcp_impl.2"):
                        from llm_core._target import current_target as _ct2
                        # Tout serveur llama.cpp : n_ctx lu sur SON /props.
                        if _ct2().is_llamacpp:
                            rec.gauge_ctx_total = rec.ctx_size

        # ── Surcoût fixe du prompt : tokens du schéma tools ─────────────
        # Compté UNE fois par run (set d'outils stable), AVANT la porte de
        # compression et le budget : pré-porte (repli estimé), porte exacte
        # et budget dur partagent ainsi le MÊME total. Gate sur ctx connu :
        # si le /props local n'a pas répondu, inutile de tenter le
        # /tokenize (pas de stall pour une cible distante sans serveur).
        if (rec.tools_tok_counted is None and tools_payload
                and rec.ctx_size):
            rec.tools_tok_counted = await _count_tools_payload_tokens_ex(
                tools_payload, model or LLAMA_MODEL or None)
        _tools_fixed_tok = int(rec.tools_tok_counted[0]) if rec.tools_tok_counted else 0

        # ── Compaction : LA règle d'overflow ───────────────────────────
        # occupation ≥ usable = n_ctx − cap de génération − buffer.
        # Occupation, par ordre de vérité : mesure RÉELLE du dernier
        # appel + delta des messages apparus depuis (ratio mesuré,
        # zéro I/O) ; sans mesure (tête de tour, reload) : estimation
        # au ratio mesuré, CONFIRMÉE par un comptage exact dans
        # maybe_compress avant d'agir (l'occupation exacte est alors
        # ancrée comme pseudo-mesure → pas de re-comptage par itération).
        # Ni pourcentage, ni marge, ni cooldown — restent : le backoff
        # des ÉCHECS (×2^streak), le plafond de compactions du run, le
        # cap par chat et la matière minimale (côté compresseur).
        # Compaction auto DÉSACTIVÉE (le défaut par compte) : la porte
        # n'entre pas dans ``llm_slot(ctx)`` — sinon une attente en FILE à
        # chaque itération au-dessus du seuil, pour un compresseur qui
        # répondrait aussitôt « disabled », puis une seconde attente pour
        # le vrai appel. Même règle que le compresseur (décision déjà
        # résolue par l'appelant, sinon interrupteur maître).
        _auto_compr_on = _auto_compaction_on(ctx)
        if (_auto_compr_on and not st.compr_capped
                and st.compactions_this_run < st.run_compaction_max):
            _in_backoff = (
                st.compr_fail_streak > 0
                and (iteration - st.last_compression_iter)
                < 3 * (2 ** min(st.compr_fail_streak, 3)))
            _usable_tok = 0
            _gate_tok = 0
            _compr_gate = None
            if rec.ctx_size and rec.ctx_size > 0:
                # Resync disque AVANT lecture, comme tous les chemins de
                # lecture des COMPRESSION_* : sinon la valeur « oscillerait »
                # selon le worker qui sert le tour après une modif admin,
                # jusqu'au redémarrage. Alimente AUSSI le buffer et le
                # défaut d'instance du seuil.
                with swallow("harness.run_chat_multi_mcp_impl.3"):
                    from shared_infra.config import reload_compression_config_from_disk
                    reload_compression_config_from_disk()
                from llm_core.context.compaction_gate import (
                    compaction_gate,
                    gate_tokens,
                )
                _compr_gate = compaction_gate(
                    rec.ctx_size,
                    thinking_mode=thinking_mode,
                    threshold=st.compaction_threshold)
                _usable_tok = _compr_gate.usable_tokens
                # Le seuil du compte s'oppose à l'occupation à CHAQUE
                # itération, pas seulement en tête de tour. On est ici
                # ENTRE deux appels d'outils : la requête précédente est
                # finie, la suivante n'est pas partie — rien n'est en cours
                # de streaming, il n'y a pas de flux à couper. Et une
                # mission de plusieurs heures ne connaît qu'UN tour : la
                # reporter au « tour suivant » reviendrait à ne jamais
                # compacter.
                _gate_tok = gate_tokens(_compr_gate)
            _occ = None
            _occ_is_real = False
            if _gate_tok > 0 and not _in_backoff:
                from llm_core.context.tokens import measured_prompt_tokens
                _real = None if st.fit_dropped else st.last_real_ctx_tok
                if (_real and _real > 0 and st.real_ctx_msg_count is not None
                        and 0 <= st.real_ctx_msg_count <= len(working_messages)):
                    _occ = int(_real) + measured_prompt_tokens(
                        working_messages[st.real_ctx_msg_count:],
                        model_id=(model or LLAMA_MODEL or None))
                    _occ_is_real = True
                elif (st.occ_anchor_tok and st.occ_anchor_count is not None
                      and 0 <= st.occ_anchor_count <= len(working_messages)):
                    # Ancrage exact du FULL historique (drop-proof) + delta.
                    _occ = int(st.occ_anchor_tok) + measured_prompt_tokens(
                        working_messages[st.occ_anchor_count:],
                        model_id=(model or LLAMA_MODEL or None))
                    _occ_is_real = True
                else:
                    _occ = measured_prompt_tokens(
                        working_messages,
                        model_id=(model or LLAMA_MODEL or None),
                        extra_fixed=_tools_fixed_tok)
            # Compaction déclenchée par le SEUIL DU COMPTE et non par le
            # plafond technique : dit une fois par run. C'est la seule
            # trace qui distingue « la fenêtre était pleine » de « le
            # compte a demandé à compacter à ce niveau-là » — un opérateur
            # qui voit compacter à 60 % d'occupation doit pouvoir savoir
            # lequel des deux parle.
            if (_occ is not None and _compr_gate is not None
                    and _compr_gate.is_user_threshold
                    and not st.compaction_threshold_logged
                    and _occ >= _gate_tok):
                st.compaction_threshold_logged = True
                logger.info(
                    "[run_chat_multi_mcp] compaction sur le seuil du compte "
                    "(%d tk, réglé %s) à l'itération %d — occupation ≈%d, "
                    "plafond technique à %d tk.",
                    _compr_gate.trigger_tokens, _compr_gate.describe(),
                    iteration, _occ, _usable_tok)
            if _occ is not None and _occ >= _gate_tok:
                from llm_core.conversation_compressor import (
                    compression_was_attempted,
                    maybe_compress_conversation,
                )
                async with llm_slot(ctx):
                    working_messages, _compr_stats = await maybe_compress_conversation(
                        working_messages,
                        llama_chat_fn   = llama_chat,
                        on_event        = on_event,
                        model           = model,
                        user_id         = str(username),
                        log_prefix      = f"multi_mcp[iter{iteration}]",
                        ctx_size_tokens = rec.ctx_size or None,
                        real_tokens     = (_occ if _occ_is_real else None),
                        usable_tokens   = _usable_tok,
                        # Seuil EFFECTIF : celui du compte s'il est plus bas
                        # que le plafond technique. Ancre aussi la cible de la
                        # compaction partielle.
                        trigger_tokens  = _gate_tok,
                        # Cap par conversation choisi par le compte (None =
                        # défaut d'instance). Sur une mission longue, c'est LUI
                        # le vrai mur : atteint, plus rien ne compacte et il ne
                        # reste que le budget dur, qui jette au lieu de résumer.
                        max_rounds      = compaction_max_rounds,
                        prev_state      = st.compr_state_cur,
                        # Même surcoût fixe que la jauge et le budget : la
                        # porte se déclenche sur le poids RÉEL du prompt.
                        extra_fixed_tokens = _tools_fixed_tok,
                        # FTS avant destruction : les tours compressés restent
                        # cherchables via session_search (rattachés à CE chat).
                        fts_session_id  = chat_id,
                        # ``auto_enabled`` est une décision DÉJÀ RÉSOLUE par
                        # l'appelant (contrat de maybe_compress_conversation) :
                        # interrupteur maître admin ET opt-in per-user, le mode
                        # mission étant pris en compte côté route. Forcer True
                        # ici court-circuiterait aussi le kill-switch admin.
                        auto_enabled    = compression_enabled,
                    )
                # Cap par conversation atteint : maybe_compress a émis
                # ``compression_capped`` (badge UI) — on coupe les checks
                # pour le reste du run (sinon re-émission à chaque iter).
                if _compr_stats.get("reason") == "max_rounds_reached":
                    st.compr_capped = True
                # Compression appliquée : l'état LOCAL avance (les tours
                # couverts ont été REMPLACÉS par le résumé → équivalent
                # d'un drop PLEIN, d'où applied_drop_turns=covered).
                if _compr_stats.get("new_state"):
                    st.compr_state_cur = dict(
                        _compr_stats["new_state"],
                        applied_drop=True,
                        applied_drop_turns=int(
                            _compr_stats["new_state"].get("covered_turns") or 0),
                    )
                if (compression_was_attempted(_compr_stats)
                        or _compr_stats.get("defer_retry")):
                    # Backoff : échec consécutif → prochaine tentative
                    # repoussée de 3×2^streak itérations ; succès → reset.
                    # ``defer_retry`` = compaction ABOUTIE (ou abandonnée
                    # avant l'appel) sans approcher sa cible. La retenter à
                    # l'itération suivante redonnerait le même résultat au
                    # même prix — 50 s d'appel LLM pour quelques milliers
                    # de tokens, toutes les trois minutes. Elle pèse donc
                    # comme un échec dans le backoff, et le compteur se
                    # remet à zéro dès qu'une compaction atteint sa cible.
                    st.compr_fail_streak = (
                        0 if (_compr_stats.get("compressed")
                              and not _compr_stats.get("defer_retry"))
                        else min(st.compr_fail_streak + 1, 3))
                    st.last_compression_iter = iteration
                    if _compr_stats.get("compressed"):
                        st.compactions_this_run += 1
                        rec.budget_drop_floor = 0
                        # Une compaction qui aboutit prouve que le chemin
                        # de récupération « contexte dépassé » fonctionne :
                        # on réarme sa série.
                        st.ctx_overflow_retries = 0
                        # Mesures pré-compression obsolètes : la prochaine
                        # réponse LLM re-mesurera.
                        st.last_real_ctx_tok = None
                        st.real_ctx_msg_count = None
                        st.occ_anchor_tok = None
                        st.occ_anchor_count = None
                elif (_compr_stats.get("reason") == "threshold_not_reached"
                      and _compr_stats.get("occupancy_tokens")):
                    # L'estimation ratio dépassait ``usable`` mais le
                    # comptage EXACT est en dessous : ANCRE l'occupation
                    # exacte du full historique (drop-proof) — le comptage
                    # ne sera pas re-payé à chaque itération.
                    st.occ_anchor_tok = int(_compr_stats["occupancy_tokens"])
                    st.occ_anchor_count = len(working_messages)

        # ── Élagage INTRA-RUN des vieilles sorties d'outils ────────────
        # Sélection périodique PENDANT le run : sans elle, les marques ne
        # seraient produites qu'en fin de tour et appliquées qu'au tour
        # SUIVANT — un run long empilerait ses résultats d'outils sans
        # jamais rien récupérer, avec le seul budget dur (qui jette) pour
        # tenir dans la fenêtre. Best-effort : un échec ici ne
        # doit jamais interrompre le run.
        if (_PRUNE_EVERY_ITERS > 0 and rec.ctx_size
                and (iteration - st.last_prune_iter) >= _PRUNE_EVERY_ITERS):
            st.last_prune_iter = iteration
            try:
                _new_keys = await _pruning.select_prune_keys(
                    working_messages,
                    ctx_size=rec.ctx_size,
                    model_id=(model or LLAMA_MODEL or None),
                    already_marked=rec.run_prune_keys,
                )
                if _new_keys:
                    rec.run_prune_keys.update(_new_keys)
                    rec.prune_keys_new.extend(_new_keys)
                    # La dernière mesure serveur décrit la vue AVANT
                    # élagage : la garder ferait rater au fast-path tout
                    # le contexte qu'on vient de libérer. On la débranche
                    # pour que le fit recompte exactement une fois.
                    st.last_real_ctx_tok = None
                    st.real_ctx_msg_count = None
                    logger.info(
                        "[run_chat_multi_mcp] élagage intra-run iter %d : "
                        "%d sortie(s) d'outil effacée(s) de la vue "
                        "(total marqué : %d)",
                        iteration, len(_new_keys), len(rec.run_prune_keys),
                    )
            except Exception:  # noqa: BLE001 — élagage best-effort, jamais bloquant
                logger.debug("[run_chat_multi_mcp] élagage intra-run échoué",
                             exc_info=True)

        # Pipeline de réduction (→ context.pruning.fit_context) :
        # marques d'élagage → élagage des frames vision (2 dernières
        # gardées) → budget dur (garantie prompt + génération ≤ n_ctx,
        # réserve = cap de génération effectif). working_messages n'est
        # jamais muté : la liste renvoyée est la VUE transitoire envoyée
        # au LLM.
        _fit_stats: Dict[str, Any] = {}
        compacted_msgs = await _pruning.fit_context(
            working_messages,
            ctx_size=rec.ctx_size,
            model_id=(model or LLAMA_MODEL or None),
            thinking_mode=thinking_mode,
            tools_fixed_tokens=_tools_fixed_tok,
            real_ctx_tokens=st.last_real_ctx_tok,
            real_ctx_msg_count=st.real_ctx_msg_count,
            stats_out=_fit_stats,
            prune_keys=rec.run_prune_keys,
            drop_floor=rec.budget_drop_floor,
        )
        rec.budget_drop_floor = int(_fit_stats.get("drop_floor", 0) or 0)
        # Drop par le budget dur ⇔ la vue est plus courte (la vision
        # REMPLACE du contenu, seuls les drops retirent des messages).
        # Conditionne la validité de la prochaine mesure réelle.
        # La longueur seule ne suffit pas quand ``_ensure_user_anchor``
        # insère l'ancre dans la passe qui retire un message (+1 −1) : on
        # lit aussi le compteur ``dropped`` du budget dur.
        st.fit_dropped = (bool(_fit_stats.get("dropped"))
                        or rec.budget_drop_floor > 0
                        or len(compacted_msgs) != len(working_messages))

        # Le budget dur n'a PAS su faire tenir le prompt (message unique
        # plus gros que le budget, ou schémas d'outils qui le mangent
        # entièrement). On part quand même — le serveur tranchera — mais
        # on prévient MAINTENANT plutôt que de laisser l'utilisateur
        # découvrir un refus brut après coup. Une seule fois par tour :
        # la condition se répète à chaque itération.
        if _fit_stats.get("over_budget") and not st.over_budget_warned:
            st.over_budget_warned = True
            _est = _fit_stats.get("estimated")
            _bud = _fit_stats.get("budget")
            _chiffres = (f" (~{_est} tokens estimés pour ~{_bud} disponibles)"
                         if _est and _bud else "")
            await _emit(on_event, {
                "type": "warning",
                "text": (
                    "Contexte maximum atteint : la conversation est trop "
                    "longue pour la fenêtre du modèle et n'a pas pu être "
                    f"réduite davantage{_chiffres}. Compactez la "
                    "conversation (/compact), retirez les pièces jointes "
                    "volumineuses, ou démarrez un nouveau chat."
                ),
            })

        # Jauge de contexte : AUCUNE émission avant l'appel. Elle est
        # recalée UNIQUEMENT sur l'usage réel renvoyé par le serveur en fin
        # de requête (event kv_cache après chaque réponse, plus bas) : une
        # estimation du prompt (/apply-template ou heuristique) afficherait
        # un chiffre que le serveur ne confirme pas. Entre deux réponses, le
        # front garde la dernière valeur réelle connue.

        # Auto-reprise : consommer la demande pendante pour CET appel (le
        # raisonnement accumulé à poursuivre — None = appel normal).
        _resume_req = resume.take()
        _resume_consumed = True

        # Mode optimized : on acquiert le sémaphore INLINE uniquement
        # autour de cet appel LLM, pas autour des tool calls qui suivent.
        # Cela permet à un autre user de prendre le slot pendant nos
        # tool calls MCP. Le kv cache est gardé en RAM via --cache-ram.
        if ctx.inline_semaphore:
            _wait_start = time.time()
            async with engine_semaphore().acquire_for(model, priority=priority):
                _wait_ms = int((time.time() - _wait_start) * 1000)
                _noter_attente(_wait_ms)
                # Écriture SQLite déportée : elle tombe à CHAQUE
                # itération, juste avant l'appel LLM, et bloquerait la
                # boucle du worker (cf. _write_telemetry dans
                # engine/tool_exec pour le raisonnement complet).
                with swallow("harness.run_chat_multi_mcp_impl.4"):
                    await asyncio.to_thread(
                        log_metric, "llm_wait_time_ms", _wait_ms, {
                            "model": model or LLAMA_MODEL or "",
                            "mode": "optimized",
                            "iteration": iteration,
                        })
                raw_response = await deps.stream(
                    compacted_msgs,
                    tools_payload,
                    model_override=model,
                    user_id=username,
                    on_thinking_token=_on_think_iter,
                    on_content_token=_live.on_token,
                    on_tool_call_delta=_on_tool_call_delta_iter,
                    on_prompt_progress=_on_prompt_progress,
                    is_cancelled=is_cancelled,
                    sampling_override=sampling_override,
                    thinking_mode=thinking_mode,
                    chat_id=chat_id,
                    resume_think=_resume_req.think,
                    resume_native_ok=_resume_req.native_ok,
                    resume_content=_resume_req.content,
                )
        else:
            # Mode classic : le caller a déjà acquis le sémaphore autour
            # de la boucle entière. Appel direct sans wrapping.
            raw_response = await deps.stream(
                compacted_msgs,
                tools_payload,
                model_override=model,
                user_id=username,
                on_thinking_token=_on_think_iter,
                on_content_token=_live.on_token,
                on_tool_call_delta=_on_tool_call_delta_iter,
                on_prompt_progress=_on_prompt_progress,
                is_cancelled=is_cancelled,
                sampling_override=sampling_override,
                thinking_mode=thinking_mode,
                chat_id=chat_id,
                resume_think=_resume_req.think,
                resume_native_ok=_resume_req.native_ok,
                resume_content=_resume_req.content,
            )
    except asyncio.CancelledError:
        await _emit_partial_tool_history_snapshot()
        raise
    except Exception as llm_err:  # noqa: BLE001 — toute panne de l'appel devient une issue du tour
        logger.warning("[run_chat_multi_mcp] Erreur LLM iter %d: %s — termine avec partiel",
                       iteration, str(llm_err)[:200])
        # La demande de reprise a été vidée AVANT l'appel : sans
        # restitution, toutes les relances ci-dessous (issue ``retry``)
        # partiraient SANS elle — le modèle réécrirait sa réponse depuis le
        # début (doublon à l'écran) et la partie déjà écrite n'arriverait
        # jamais en base. On la restitue ; la voie d'erreur s'en sert aussi
        # (partiel).
        if _resume_consumed:
            resume.restore(_resume_req)

        # ── Récupération « historique empoisonné » ───────────────────
        # Un échec dès l'itération 0 n'est PAS un tool call que le
        # modèle vient de produire — c'est l'HISTORIQUE envoyé qui
        # fait planter llama.cpp (rendu du chat template sur un
        # message tool/tool_calls bancal). _sanitize_message_history
        # a déjà tenté de le réparer en amont ; si ça échoue quand
        # même, on APLATIT tout le tool-history en texte brut et on
        # retente UNE fois. Garantit qu'un chat n'est jamais bloqué
        # en boucle 500 : sans ce filet, l'utilisateur devrait changer de
        # chat.
        #
        # SAUF si le serveur a dit « contexte dépassé » : l'historique
        # n'est alors pas malformé, il est trop GROS. L'aplatir ne le
        # réduit pas, la seconde tentative échoue pareil, et l'utilisateur
        # aura lu entre-temps un diagnostic faux (« historique
        # incompatible ») au lieu du seul geste utile — compacter.
        _err_kind = _llm_error_kind(getattr(llm_err, "cause", llm_err))

        # ── « Contexte dépassé » ⇒ compacter puis UNE relance ───────────
        # Le serveur est l'autorité finale de l'overflow : quand il
        # refuse, on compacte (porte d'occupation acquise —
        # triggered_by_overflow) et on retente l'itération une fois.
        # Équivalent de l'auto-continue d'OpenCode, sans message
        # synthétique (notre compaction est inter-itérations).
        # Compaction auto désactivée : pas d'attente en file pour un
        # compresseur qui répondrait « disabled » (même règle que la porte
        # d'occupation).
        if (_err_kind == _KIND_CTX_OVERFLOW
                and st.compactions_this_run < st.run_compaction_max
                and st.ctx_overflow_retries < _CTX_OVERFLOW_RETRY_MAX
                and _auto_compaction_on(ctx)):
            st.ctx_overflow_retries += 1
            from llm_core.conversation_compressor import (
                maybe_compress_conversation as _mcc_overflow,
            )
            # Le gate est BYPASSÉ ici (``triggered_by_overflow``) : le seuil
            # ne sert qu'à ancrer la cible de la compaction partielle. Un
            # compte qui compacte tôt veut aussi récupérer PLUS de marge
            # quand le serveur vient de refuser. Recalculé localement : le
            # gate de la porte d'occupation peut ne pas avoir été construit
            # cette itération (cap atteint, backoff…).
            _ovf_gate = None
            if rec.ctx_size and rec.ctx_size > 0:
                from llm_core.context.compaction_gate import compaction_gate as _cg
                _ovf_gate = _cg(rec.ctx_size,
                                thinking_mode=thinking_mode,
                                threshold=st.compaction_threshold)
            try:
                async with llm_slot(ctx):
                    working_messages, _ovf_stats = await _mcc_overflow(
                        working_messages,
                        llama_chat_fn   = llama_chat,
                        on_event        = on_event,
                        model           = model,
                        user_id         = str(username),
                        log_prefix      = f"multi_mcp[iter{iteration}:overflow]",
                        ctx_size_tokens = rec.ctx_size or None,
                        usable_tokens   = (_ovf_gate.usable_tokens if _ovf_gate else None),
                        trigger_tokens  = (_ovf_gate.trigger_tokens if _ovf_gate else None),
                        max_rounds      = compaction_max_rounds,
                        triggered_by_overflow = True,
                        prev_state      = st.compr_state_cur,
                        extra_fixed_tokens = _tools_fixed_tok,
                        fts_session_id  = chat_id,
                        # Le rattrapage « contexte dépassé » reste une compaction
                        # AUTOMATIQUE : même autorisation que la porte d'occupation,
                        # sinon un utilisateur qui gère lui-même son compactage se
                        # verrait quand même réécrire son historique.
                        auto_enabled    = compression_enabled,
                    )
            except asyncio.CancelledError:
                # Appel LLM de ~50 s dans ``except Exception`` : hors du
                # filet d'annulation principal.
                await _emit_partial_tool_history_snapshot()
                raise
            if _ovf_stats.get("compressed"):
                st.compactions_this_run += 1
                rec.budget_drop_floor = 0
                st.last_real_ctx_tok = None
                st.real_ctx_msg_count = None
                # L'ancre décrit une liste qui n'existe plus : la garder
                # ferait rapporter à l'itération suivante l'occupation
                # d'AVANT la compaction — et comme elle est marquée
                # « mesure réelle », maybe_compress sauterait sa
                # confirmation exacte et recompacterait pour rien, juste
                # après un overflow. Même geste que le chemin nominal.
                st.occ_anchor_tok = None
                st.occ_anchor_count = None
                if _ovf_stats.get("new_state"):
                    st.compr_state_cur = dict(
                        _ovf_stats["new_state"], applied_drop=True,
                        applied_drop_turns=int(
                            _ovf_stats["new_state"].get("covered_turns") or 0))
                logger.warning(
                    "[run_chat_multi_mcp] contexte dépassé iter %d → "
                    "compaction puis relance (%d/%d de la série)",
                    iteration, st.ctx_overflow_retries,
                    _CTX_OVERFLOW_RETRY_MAX)
                return _fin("retry")
            # Compaction impossible (matière insuffisante, rollback…) :
            # on retombe sur le message utilisateur KIND_CONTEXT_OVERFLOW.

        # Un historique qui devient irrendable par le gabarit du moteur
        # ARRIVE EN COURS DE RUN : un tool_call émis malformé, un artefact
        # de compaction, un résultat orphelin. Limité à l'itération 0, ce
        # recours laisserait mourir une mission à l'itération 150 (trois
        # hoquets rejouant le MÊME 400) avec la moitié de son budget
        # intacte. On l'autorise donc une fois par run, à n'importe quelle
        # itération, pour un REFUS DE REQUÊTE (4xx hors dépassement de
        # contexte, qui a son propre chemin de compaction juste au-dessus)
        # et seulement une fois les hoquets épuisés — un 400 franc n'est pas
        # un hoquet, mais on ne court-circuite pas le retry transitoire.
        # À l'itération 0 aussi, seul un REFUS de requête (ou une panne non
        # classée, typiquement le 500 du rendu de gabarit) justifie
        # l'aplatissement. Un timeout, un 503 de chargement, un 429 ou un
        # 401 qui aplatiraient l'historique donneraient un faux message
        # « historique incompatible », perdraient le cache KV et laisseraient
        # la panne réelle intacte : ces familles passent par le hoquet.
        _flatten_kind_ok = _err_kind in (_KIND_INVALID_REQUEST, _KIND_UNKNOWN)
        _flatten_now = (
            not st.flatten_retry_done
            and _flatten_kind_ok
            and (iteration == 0
                 or st.llm_hiccup_streak >= _LLM_HICCUP_RETRY_MAX)
        )
        if _flatten_now:
            st.flatten_retry_done = True
            logger.warning(
                "[run_chat_multi_mcp] échec iter %d (%s) → aplatissement de "
                "l'historique tool et nouvelle tentative (récupération)",
                iteration, _err_kind,
            )
            await _emit(on_event, {
                "type": "info",
                "text": ("Historique de conversation incompatible avec "
                         "le moteur — récupération automatique en cours "
                         "(les détails d'outils des tours précédents "
                         "sont simplifiés en texte)."),
            })
            working_messages = _flatten_tool_messages(working_messages)
            rec.budget_drop_floor = 0
            # La liste a changé de forme : l'ancre de la dernière mesure
            # réelle ne correspond plus (comme les trois autres réécritures).
            st.real_ctx_msg_count = None
            # Idem pour l'ancrage d'occupation exacte : il décrit la liste
            # d'AVANT (même geste que la compaction sur dépassement).
            st.occ_anchor_tok = None
            st.occ_anchor_count = None
            return _fin("retry")

        # HOQUET transitoire du moteur : si AUCUN token n'a été
        # streamé pendant l'appel qui a échoué (buffers d'itération vides → zéro
        # texte déjà envoyé au client, donc zéro duplication) ET qu'aucun outil
        # n'a tourné pour cette itération (l'exception vient de l'appel LLM,
        # AVANT l'exécution des outils), on retente LA MÊME itération.
        # ``working_messages`` n'a pas été muté par cet appel → état identique.
        # Série CONSÉCUTIVE (réarmée par toute itération qui aboutit) : un
        # run de plusieurs heures traverse légitimement plusieurs hoquets
        # isolés ; avec « une fois par run », le second hoquet — même
        # survenu deux heures plus tard — terminerait la mission.
        #
        # (a) La famille de panne compte : une panne DÉTERMINISTE (contexte
        # dépassé non compactable, 401/403, quota, 4xx après aplatissement)
        # n'est pas un hoquet — la rejouer trois fois coûterait 12 s pour
        # la même erreur (cf. ``_llm_error_hiccup_ok``). (b) L'itération 0
        # y a droit aussi : c'est le même état « rien d'exécuté, rien de
        # streamé » — aucun outil n'a tourné dans ce run, et la garde des
        # buffers vides couvre le texte. L'aplatissement est réservé aux
        # refus de requête (juste au-dessus).
        if (st.llm_hiccup_streak < _LLM_HICCUP_RETRY_MAX
                and not _iter_content_parts and not _iter_thinking_parts
                and _llm_error_hiccup_ok(
                    _err_kind, getattr(llm_err, "cause", llm_err),
                    flatten_pending=not st.flatten_retry_done)):
            st.llm_hiccup_streak += 1
            logger.warning("[run_chat_multi_mcp] hoquet moteur iter %d (%s) → "
                           "nouvelle tentative %d/%d (aucun token émis)",
                           iteration, _err_kind, st.llm_hiccup_streak,
                           _LLM_HICCUP_RETRY_MAX)
            await _emit(on_event, {
                "type": "info",
                "text": "Hoquet du moteur LLM — nouvelle tentative…",
            })
            # Backoff progressif : un moteur qui redémarre a besoin de plus
            # que 2 s à la troisième tentative. Ce sleep vit dans
            # ``except Exception``, hors du filet d'annulation de l'appel
            # LLM : snapshot via ``_guard_cancel``.
            await _guard_cancel(asyncio.sleep(2 * st.llm_hiccup_streak))
            return _fin("retry")

        return _fin("fatal", error=llm_err, err_kind=_err_kind)

    rec.last_raw = raw_response
    # L'appel LLM a abouti ⇒ les séries de récupération qui portent sur le
    # TRANSPORT sont réarmées (on borne un enchaînement, pas un total de
    # run). Le compteur de tool-calls malformés, lui, porte sur le
    # CONTENU : la boucle le réarme quand une sortie parsable arrive.
    st.llm_hiccup_streak = 0
    st.ctx_overflow_retries = 0
    usage     = raw_response.get("usage") or {}
    rec.cumul_in  += usage.get("prompt_tokens", 0)
    rec.cumul_out += usage.get("completion_tokens", 0)
    # Cache de prompt (Anthropic) : ces tokens ne sont PAS inclus dans
    # ``prompt_tokens`` ; non cumulés, ils se perdraient entre deux
    # itérations et le retour sur investissement du cache resterait
    # invisible côté métriques. On les cumule comme le reste du tour.
    rec.cumul_cache_read     += int(usage.get("cache_read_input_tokens") or 0)
    rec.cumul_cache_creation += int(usage.get("cache_creation_input_tokens") or 0)
    rec.usage_note(effective_iter=effective_iter, model=model or LLAMA_MODEL)
    # Raisonnement déclaré : cumulé sur les itérations. Ne lire que la
    # dernière sous-compterait tout ce qui a été pensé avant les outils.
    _rsn_iter = _native_reasoning_tokens(usage)
    if _rsn_iter is not None:
        rec.cumul_reasoning = (rec.cumul_reasoning or 0) + _rsn_iter

    # ── Occupation du CONTEXTE DE TRAVAIL, mesurée (fin de requête) ───
    # ``prompt_tokens`` = tout ce que le serveur a réellement reçu (system
    # + tools + historique) à ``st.real_ctx_msg_count`` messages. Autorité de
    # la règle d'overflow et du fast-path du budget dur ; les deux ajoutent
    # par-dessus le delta des messages APPARUS depuis la mesure.
    #
    # ⚠ On n'ajoute PAS ``completion_tokens``, pour deux raisons :
    #   1. le raisonnement qu'il contient est ÉPHÉMÈRE — jamais re-soumis
    #      (la boucle ne garde pas ``reasoning_content`` dans
    #      ``working_messages``, ``upsert_chat`` retire ``thinking``) : un
    #      long raisonnement ne pèse RIEN sur le contexte de travail, et le
    #      compter déclencherait la compaction pour une occupation qui
    #      n'existe plus au tour suivant ;
    #   2. sa part visible (texte + tool_calls) est DÉJÀ recomptée par le
    #      delta : le message assistant est ajouté à ``working_messages``
    #      APRÈS cette mesure, donc il tombe dans la tranche
    #      ``[st.real_ctx_msg_count:]``. L'additionner ici le compterait
    #      deux fois.
    # La jauge de contexte de la route lit de même ``last_prompt_tokens``
    # seul : les deux vues concordent.
    _pt_real = int(usage.get("prompt_tokens", 0) or 0)
    if _pt_real > 0:
        st.last_real_ctx_tok = _pt_real
        # Ratio chars/token MESURÉ : chaque réponse réelle
        # recale la conversion utilisée pour matérialiser les coupes et
        # estimer les deltas sans I/O. Best-effort.
        with swallow("harness.run_chat_multi_mcp_impl.5"):
            from llm_core.context.tokens import count_image_blocks, note_real_usage, payload_chars
            # Numérateur = chars des messages **+ schéma des outils**.
            # Le dénominateur (``prompt_tokens``) facture tout le prompt,
            # schéma d'outils compris (~30 Ko de JSON) : ne compter que
            # les messages sous-estimerait systématiquement le ratio
            # chars/token — biais maximal en début de run, quand les
            # outils pèsent plus que l'historique. Un ratio trop bas fait
            # SUR-estimer l'occupation (compaction déclenchée trop tôt) et
            # raccourcit les caps d'émission.
            note_real_usage(model or LLAMA_MODEL or None,
                            payload_chars(compacted_msgs) + ctx.tools_payload_chars,
                            _pt_real,
                            n_images=count_image_blocks(compacted_msgs))
        # Tout message d'indice ≥ cette longueur est POSTÉRIEUR à la
        # mesure (assistant du tour + tool_results à venir) → c'est le
        # delta que le fast-path du budget dur ré-estimera. Mesure valable
        # SEULEMENT si l'envoi était complet (pas de drop au fit).
        st.real_ctx_msg_count = None if st.fit_dropped else len(working_messages)

    # Watcher contexte/perf (LLAMA_WATCH=1) : prompt assemblé (la vue
    # réellement ENVOYÉE) + mesure réelle du serveur + stats du fit.
    # Best-effort, no-op si inactif.
    with swallow("harness.run_chat_multi_mcp_impl.6"):
        from llm_core._watch import watch_llm_call
        watch_llm_call(
            chat_id=chat_id, path="tools", iteration=iteration,
            model=(model or LLAMA_MODEL or ""),
            messages=compacted_msgs, tools_payload=tools_payload,
            usage=usage, timings=raw_response.get("timings") or {},
            fit=dict(_fit_stats, fit_dropped=st.fit_dropped),
        )

    # Jauge de contexte : émission UNIQUE, après chaque réponse, depuis
    # l'usage réel (le front recale la jauge sur CHAQUE event kv_cache ;
    # aucun event estimé avant l'appel). Affiché = PROMPT RÉEL seul
    # (``prompt_tokens``) : on N'AJOUTE PAS ``completion_tokens``, qui
    # contient le thinking — éphémère, strippé de l'historique au tour
    # suivant (l'inclure redonnerait le saut « 4,7k en fin de tour vs 800
    # à la relance »). Le contenu généré ce tour apparaîtra dans le
    # prompt_tokens réel de la requête suivante.
    with swallow("harness.run_chat_multi_mcp_impl.7"):
        _kv_used  = _pt_real
        # Fenêtre de la cible inconnue (``rec.gauge_ctx_total`` = 0) → pas
        # d'événement : jamais de pourcentage inventé.
        _kv_total = int(rec.gauge_ctx_total or 0)
        if _kv_used > 0 and _kv_total > 0:
            await _emit(on_event, {
                "type": "kv_cache", "used": _kv_used, "total": _kv_total,
                "pct": min(100, round(_kv_used / _kv_total * 100)),
            })

    choices = raw_response.get("choices") or []
    if not choices:
        # Une réponse SANS ``choices`` est une anomalie de moteur (réponse
        # tronquée côté serveur, routeur qui renvoie une enveloppe vide),
        # pas une fin de travail. Un ``break`` sec sortirait par le chemin
        # « limite d'itérations atteinte » : run arrêté en plein milieu ET
        # diagnostic FAUX (« budget d'itérations épuisé » alors qu'il en
        # reste 180). On la traite comme le hoquet moteur d'à côté : série
        # bornée, réarmée par toute itération qui aboutit.
        # Compteur DÉDIÉ : ``st.llm_hiccup_streak`` est remis à zéro dès
        # qu'un appel LLM ABOUTIT (juste au-dessus, ``rec.last_raw = …``) — or
        # une réponse vide EST un appel abouti. Le réutiliser ici ferait
        # repartir la série à 1 à chaque tour : retry infini jusqu'au cap
        # dur. Celui-ci n'est réarmé que par une réponse EXPLOITABLE.
        # Une auto-reprise consommée par cet appel vide est restituée
        # (comme dans ``except``) : la relance porte la MÊME demande, et la
        # sortie de série garde la prose déjà affichée pour son partiel.
        if _resume_consumed:
            resume.restore(_resume_req)
        if st.empty_choices_streak < _EMPTY_CHOICES_RETRY_MAX:
            st.empty_choices_streak += 1
            logger.warning(
                "[run_chat_multi_mcp] réponse sans 'choices' iter %d → "
                "nouvelle tentative %d/%d", iteration,
                st.empty_choices_streak, _EMPTY_CHOICES_RETRY_MAX)
            await _emit(on_event, {
                "type": "info",
                "text": "Réponse vide du moteur — nouvelle tentative…",
            })
            await _guard_cancel(asyncio.sleep(2 * st.empty_choices_streak))
            return _fin("retry_counted")
        logger.error(
            "[run_chat_multi_mcp] réponse sans 'choices' %d fois de suite "
            "— arrêt du run", st.empty_choices_streak)
        return _fin("stop_empty")
    # Réponse exploitable : la série de réponses vides est réarmée.
    st.empty_choices_streak = 0

    choice     = choices[0]
    finish     = choice.get("finish_reason", "")
    msg        = choice.get("message") or {}
    tool_calls = _unique_tool_call_ids(msg.get("tool_calls") or [],
                                       working_messages)

    # Thinking accumulé pendant le streaming
    _iter_thinking = "".join(_iter_thinking_parts)
    # ``content`` peut arriver en LISTE de blocs (provider multimodal
    # OpenAI-compat) : ``.strip()`` lèverait AttributeError HORS de tout
    # try → tour entier tué, rien persisté. Coercition défensive.
    _rc = msg.get("content")
    if isinstance(_rc, list):
        _rc = "".join(
            (b.get("text") or "") if isinstance(b, dict) else str(b)
            for b in _rc)
    _raw_content = (str(_rc) if _rc is not None else "").strip()
    # Copie NON strippée : une reprise de rédaction doit renvoyer au
    # serveur EXACTEMENT ce qu'il a produit. Le ``.strip()`` ci-dessus est
    # bon pour l'affichage, mais il mange l'espace de fin — or c'est
    # précisément à cette frontière que la génération reprend : sans lui,
    # « …en trois » + « parties » donne « troisparties ».
    _raw_content_exact = str(_rc) if _rc is not None else ""

    # Fallback : thinking dans le contenu texte (non détecté en streaming).
    # ``truncated`` : sur une coupure par plafond, un <think> non fermé est
    # du raisonnement tronqué — les promotions anti-bulle-vide 3a/3b sont
    # inhibées (sinon le raisonnement s'affiche en markdown dans la bulle).
    if not _iter_thinking:
        _iter_thinking, _raw_content = _extract_thinking(
            _raw_content, truncated=(str(finish or "") == "length"))
        if _iter_thinking:
            await _emit(on_event, {"type": "thinking_content", "text": _iter_thinking})

    _iter_clean = _raw_content
    if _iter_thinking:
        rec.all_thinking.append(_iter_thinking)
        _clip_thinking_history(rec.all_thinking)

    # Continuation d'une auto-reprise : FUSIONNER le segment avec le
    # raisonnement déjà accumulé (la reprise continue token-exacte, souvent
    # en pleine phrase — pas d'entrée séparée dans rec.all_thinking, dont le
    # rendu final joint par "\n\n").
    if _resume_req.think:
        if _iter_thinking and rec.all_thinking and rec.all_thinking[-1] == _iter_thinking:
            rec.all_thinking.pop()
        if rec.all_thinking and rec.all_thinking[-1] == _resume_req.think:
            rec.all_thinking.pop()
        _iter_thinking = _resume_req.think + (_iter_thinking or "")
        rec.all_thinking.append(_iter_thinking)
        _clip_thinking_history(rec.all_thinking)

    # Continuation d'une reprise de PROSE : le segment reprend token-exacte
    # à l'intérieur du message assistant non fermé, donc en pleine phrase.
    # On RECOLLE sans séparateur, et on recolle aussi le buffer de tokens
    # (``_iter_content_parts``) : c'est LUI qui alimente le streaming final
    # vers le client — sans ça, la réponse affichée ne montrerait que le
    # dernier segment, en perdant tout ce qui précède la coupure.
    if _resume_req.content:
        _iter_clean = _resume_req.content + (_iter_clean or "")
        # Le client tient DÉJÀ ce préfixe (émis avant la coupure, queue
        # comprise) : ``prefixer_deja_emis`` le compte aussi dans ``n``. Sans
        # effet sur un tampon vide (fournisseur sans flux, stub de test).
        _live.prefixer_deja_emis(_resume_req.content)

    return _fin("ok", raw_response=raw_response, usage=usage, finish=finish,
                msg=msg, tool_calls=tool_calls, iter_thinking=_iter_thinking,
                iter_clean=_iter_clean, raw_content_exact=_raw_content_exact)
