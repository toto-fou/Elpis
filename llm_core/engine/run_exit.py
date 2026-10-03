# SPDX-License-Identifier: MIT
"""llm_core.engine.run_exit — les trois sorties d'un run de la boucle.

  - ``finish_ok`` : le modèle a conclu sans appel d'outil (tour sain) ;
  - ``finish_on_limit`` : la boucle s'arrête sans réponse finale (budget
    d'étapes, plafond dur, mur d'horloge, contexte saturé, plafond de
    génération, boucle d'action, réponses vides) — un dernier appel SANS
    outils rédige la synthèse ;
  - ``finish_on_error`` : l'appel LLM échoue après les récupérations.

Chacune rend le triple de la boucle (texte, événements, métriques), dépose le
delta de ``tool_history`` dans les métriques et enregistre l'usage du tour :
une ligne par tour, ici et nulle part ailleurs (la route de chat ne
journalise rien, et les routines, webhooks et sous-agents ne passent que par
ici). Le registre d'usage se lit à l'appel via ``usage_ctx`` : c'est là que
les tests le substituent.
"""
from __future__ import annotations

import asyncio
import functools
import logging
import time
from typing import Any, Dict, List, Optional, Tuple

from llm_core._chat_classic import _extract_thinking
from llm_core._llm_retry import LLMFailure, llm_error_user_message as _llm_error_user_message
from llm_core._metrics import calculate_metrics
from llm_core._scheduling._guard import _emit
from llm_core._think_tokens import (
    measure_thinking_tokens,
    native_reasoning_tokens as _native_reasoning_tokens,
)
from llm_core._thinking_reconcile import reconcile_thinking_content
from llm_core._tool_parsing import _strip_tool_call_markup
from llm_core._vision import _clear_last_screenshot_for
from llm_core.context import pruning as _pruning
from llm_core.engine.live_text import LiveText
from llm_core.engine.resume import ResumeState
from llm_core.engine.run import (
    LoopDeps,
    RunContext,
    RunRecord,
    _clip_thinking_history,
    _content_text,
    engine_semaphore,
)
from shared_infra.config import LLAMA_MODEL
from shared_infra.db import log_metric
from shared_infra.observability import usage_ctx as _usage_ctx
from shared_infra.observability.tracing import swallow

logger = logging.getLogger("uvicorn.error")


# Réponse rendue quand la sortie finale du modèle n'est QUE du balisage
# d'appel d'outil inexploitable (cf. ``finish_ok``).
_MARKUP_ONLY_REPLY = (
    "Ma dernière réponse était une tentative d'appel d'outil mal formée, qui "
    "n'a pas pu être exécutée. Relancez la demande, au besoin en la "
    "reformulant."
)


# Consigne du tour de SYNTHÈSE final quand le budget d'itérations est épuisé
# (modèle OpenCode max-steps.txt) : appel SANS outils, texte seul. Injectée en
# message user préfixé [SYSTEM], comme la relance compacte (contrainte « un
# seul role:system » des templates stricts).
_MAX_STEPS_WRAPUP = (
    "[SYSTEM] MAXIMUM STEPS REACHED. The step budget for this task is "
    "exhausted and tools are disabled for this turn. Respond with TEXT ONLY: "
    "state that the step limit was reached, summarize concisely what was "
    "actually accomplished (real results only), list what remains to be done, "
    "and recommend the next action. Do not attempt any tool call."
)


# Variantes par CAUSE RÉELLE d'arrêt. Le run peut sortir par le chemin
# « limite atteinte » sans que le budget d'étapes soit en cause : mur
# d'horloge, contexte saturé, ou cascade d'appels ratés qui a épuisé le cap
# dur (2× le budget) alors que le compteur d'étapes productives reste bas —
# un message unique ferait annoncer au modèle une limite d'étapes qu'il n'a
# pas atteinte. Même contrat de sortie (texte seul), seul le constat change.
_WRAPUP_BY_KIND = {
    "wallclock": (
        "[SYSTEM] TIME BUDGET REACHED. The wall-clock budget for this task ran "
        "out (the step budget was NOT exhausted) and tools are disabled for "
        "this turn. Respond with TEXT ONLY: state that the time limit was "
        "reached, summarize concisely what was actually accomplished (real "
        "results only), list what remains to be done, and recommend the next "
        "action. Do not attempt any tool call."
    ),
    "ctx_saturated": (
        "[SYSTEM] CONTEXT SATURATED. Your tool calls kept being cut off "
        "mid-emission, so the loop stopped (the step budget was NOT "
        "exhausted). Tools are disabled for this turn. Respond with TEXT ONLY: "
        "state that the context filled up, summarize concisely what was "
        "actually accomplished (real results only), list what remains to be "
        "done, and recommend the next action — restarting from a fresh, "
        "narrower request is usually the fix. Do not attempt any tool call."
    ),
    "gen_cap": (
        "[SYSTEM] OUTPUT LENGTH LIMIT. Your tool calls kept being cut off by "
        "the generation length limit (the context window is NOT full and the "
        "step budget was NOT exhausted), so the loop stopped. Tools are "
        "disabled for this turn. Respond with TEXT ONLY: state that the tool "
        "calls were too long for the output limit, summarize concisely what "
        "was actually accomplished (real results only), list what remains to "
        "be done, and recommend the next action — split large writes into "
        "several smaller calls. Do not attempt any tool call."
    ),
    "hard": (
        "[SYSTEM] TOO MANY FAILED STEPS. The loop stopped on its "
        "failed-iteration guard, not on the step budget: too many tool calls "
        "in a row returned errors. Tools are disabled for this turn. Respond "
        "with TEXT ONLY: state that the run was stopped after repeated tool "
        "failures, quote the decisive error, summarize what was actually "
        "accomplished (real results only), list what remains, and recommend "
        "the next action. Do not attempt any tool call."
    ),
}


def _norm_thinking(text: Any) -> str:
    """Forme de comparaison d'un raisonnement : blancs repliés. Le flux brut
    et la valeur ``strip()``ée du message final ne diffèrent souvent QUE par
    là — une égalité stricte les verrait comme deux raisonnements distincts."""
    return " ".join(str(text or "").split())


async def finish_ok(ctx: RunContext, rec: RunRecord, resume: ResumeState,
                    working_messages: List[Dict[str, Any]], *, live: LiveText,
                    msg: Dict[str, Any], raw_text: str, finish: Any,
                    iter_thinking: str, iteration: int,
                    effective_iter: int) -> Tuple[str, List[Dict[str, Any]], Dict[str, Any]]:
    """Réponse finale (aucun appel d'outil) : nettoyage du contenu et du
    raisonnement, filet « réponse piégée dans le thinking », queue de
    l'émission directe, métriques et registre d'usage du tour sain, trace
    des outils et élagage de fin de tour."""
    # Constantes du run sous leurs noms locaux usuels.
    on_event = ctx.on_event
    model = ctx.model
    username = ctx.username
    start_time = ctx.start_time
    _chat_key_suffix = ctx.chat_key_suffix
    _inline_semaphore = ctx.inline_semaphore
    _guard_cancel = functools.partial(rec.guard_cancel, ctx.on_event)
    _emit_partial_tool_history_snapshot = functools.partial(rec.emit_partial_snapshot, ctx.on_event)
    _live = live
    _iter_content_parts = live.parts
    _iter_thinking = iter_thinking
    # ── Réponse finale (aucun appel d'outil détecté) ─────────────────
    # Contenu déjà streamé token par token (cf. LiveText)
    _streamed_content = "".join(_iter_content_parts)

    # Extraire reasoning_content natif OU <think> du contenu brut
    _final_reasoning = (msg.get("reasoning_content") or "").strip()
    if _final_reasoning:
        final_thinking = _final_reasoning
        final_clean    = raw_text
    else:
        final_thinking, final_clean = (
            _extract_thinking(raw_text, truncated=(str(finish or "") == "length"))
            if raw_text else ("", raw_text))
    # Comparaison NORMALISÉE (blancs) : ``_final_reasoning`` est
    # ``strip()``é alors que ``rec.all_thinking`` garde le flux brut —
    # l'égalité stricte raterait la correspondance (fournisseur Anthropic :
    # raisonnement streamé ET rendu dans le message) et le raisonnement
    # s'afficherait puis se persisterait en double.
    _seen_thinking = {_norm_thinking(t) for t in rec.all_thinking}
    if final_thinking and _norm_thinking(final_thinking) not in _seen_thinking:
        rec.all_thinking.append(final_thinking)
        _clip_thinking_history(rec.all_thinking)
        await _emit(on_event, {"type": "thinking_content", "text": final_thinking})

    # Le buffer STREAMÉ ne court-circuite pas le nettoyage.
    # ``_streamed_content`` est la concaténation BRUTE des tokens de
    # contenu : préféré tel quel, il ferait gagner la version SALE dès
    # qu'un token a été streamé, et un dialecte de raisonnement inconnu du
    # splitter (``<|thinking|>…<|/thinking|>``) partirait tel quel dans la
    # bulle ET en base — compté deux fois. Le splitter connaît ce dialecte
    # (cf. ``_stream_tag_parser``) ; ce filet couvre les builds qui en
    # inventeraient un autre, et les tampons rejoués d'une reprise.
    if _streamed_content:
        _st_think, _st_clean = _extract_thinking(
            _streamed_content, truncated=(str(finish or "") == "length"))
        if _st_think and _norm_thinking(_st_think) not in {
                _norm_thinking(t) for t in rec.all_thinking}:
            rec.all_thinking.append(_st_think)
            _clip_thinking_history(rec.all_thinking)
        final_clean = _st_clean or final_clean or raw_text or ""
    else:
        final_clean = final_clean or raw_text or ""
    # Un modèle peut émettre du markup d'appel
    # d'outil (Qwen <tool_call>, Llama <function=>) en TEXTE au lieu du
    # canal natif tool_calls. Les appels vers des outils CONNUS ont déjà
    # été ré-exécutés en amont via extract_tool_calls (branche legacy).
    # Ce qui atteint ce point est donc du markup résiduel NON exécutable
    # (outil inconnu, ou markup mêlé à de la prose tombé entre les
    # branches) : on ne doit JAMAIS l'afficher brut dans la bulle. On le
    # nettoie pour l'affichage ET la persistance. cf. _strip_tool_call_markup.
    _pre_strip = final_clean
    final_clean = _strip_tool_call_markup(final_clean)
    if final_clean != _pre_strip:
        # Observabilité : si on a dû nettoyer du markup ICI, c'est que le
        # modèle a free-formé un appel d'outil en texte que la couche
        # native n'a pas capté. Souvent symptôme d'un llama-server lancé
        # SANS --jinja (+ template tool-aware) → le tool-calling natif
        # OpenAI ne s'active pas. cf. note déploiement.
        logger.warning(
            "[run_chat_multi_mcp] markup d'appel d'outil nettoyé du flux "
            "final (iter %d, model=%s) — le modèle a émis un tool call en "
            "TEXTE non capté par le canal natif. Vérifier que llama-server "
            "tourne avec --jinja + un chat template tool-aware.",
            iteration, model or LLAMA_MODEL,
        )
    all_thinking_text = "\n\n".join(rec.all_thinking)

    # ── Filet « réponse finale piégée dans le thinking » (cf. _thinking_reconcile) ─
    # Même règle que le recovery du chemin classic, mais appliquée ICI
    # (orchestration) plutôt que dans la fonction de stream interne : c'est le seul
    # point où l'on dispose À LA FOIS de la réponse (final_clean) ET du raisonnement
    # live à effacer. Si ce DERNIER tour n'a produit AUCUNE prose visible alors que
    # le modèle a émis du raisonnement (<think> non fermé / reasoning_content-only /
    # </think> scindé), la bulle serait vide et la réponse resterait coincée dans le
    # panneau « thinking » (re-titré « Réponse » côté front). On promeut le
    # raisonnement de CE tour en réponse, on le retire de l'accumulé, et on EFFACE le
    # bloc thinking live (thinking_content="" le remplace) pour ne pas l'afficher en
    # double (panneau + bulle).
    _truncated_in_think = False
    if not (final_clean or "").strip() and (_iter_thinking or "").strip():
        _, _promoted = reconcile_thinking_content(
            _iter_thinking, final_clean, had_tool_calls=False,
            finish=str(finish or ""))
        # Le texte promu peut charrier le markup d'une tentative d'appel
        # partie dans le reasoning (cf. la relance « appel perdue hors
        # canal ») : même nettoyage que le
        # content plus haut. Vidé par le strip = markup pur, PAS une
        # réponse → branche « non promu » (thinking gardé, Continuer armé).
        if _promoted:
            _promoted = _strip_tool_call_markup(_promoted)
        if _promoted:
            final_clean = _promoted
            if rec.all_thinking and rec.all_thinking[-1] == _iter_thinking:
                rec.all_thinking.pop()
            all_thinking_text = "\n\n".join(rec.all_thinking)
            await _emit(on_event, {"type": "thinking_content", "text": ""})
            logger.warning(
                "[run_chat_multi_mcp] réponse finale piégée dans le thinking — promue "
                "en réponse visible (chars=%d, iter %d).", len(final_clean), iteration)
        else:
            # Coupé par le plafond EN PLEIN raisonnement (finish=length), ou
            # promotion vidée par le strip (markup pur) : PAS une réponse —
            # on n'affiche rien en markdown ; le front garde le bloc thinking
            # et arme « Continuer » (reprise avec le raisonnement en prefill).
            _truncated_in_think = True
            logger.warning(
                "[run_chat_multi_mcp] raisonnement non promu en réponse "
                "(finish=%s, %d chars) — thinking gardé, Continuer armé "
                "(iter %d).", str(finish or ""), len(_iter_thinking or ""),
                iteration)

    # Réponse RÉDUITE À RIEN par le nettoyage (balisage d'appel d'outil
    # pur, JSON cassé, relances « non parsable » épuisées) : le retour
    # ``final_clean or raw_text`` persisterait le balisage BRUT, réaffiché
    # tel quel au rechargement. On ne rend jamais le brut ; une
    # phrase déterministe dit ce qui s'est passé (même principe que le
    # filet final du chemin « limite » : jamais de bulle vide muette). La
    # coupure en plein raisonnement (``_truncated_in_think``) garde sa
    # bulle vide : le bloc Réflexion et « Continuer » la portent.
    if (not (final_clean or "").strip() and not _truncated_in_think
            and (_pre_strip or "").strip()):
        logger.warning(
            "[run_chat_multi_mcp] réponse finale réduite à du balisage "
            "d'appel d'outil non exécutable (iter %d) — message de repli "
            "rendu à la place du brut.", iteration)
        final_clean = _MARKUP_ONLY_REPLY

    # Queue de la réponse finale — l'essentiel est DÉJÀ parti en direct via
    # le flux. Reste à émettre : la fenêtre de retenue, ou tout le texte si
    # le portail anti-markup avait coupé l'émission. Si le nettoyage a
    # modifié la partie déjà émise (strip, extraction d'un dialecte de
    # thinking, reprise de prose), ``content_replace`` resynchronise la
    # bulle — le champ ``assistant`` du 'final' n'y suffit pas : le front
    # ne le préfère au streamé que s'il est au moins aussi LONG.
    if final_clean and on_event:
        try:
            await _live.emit_rest(final_clean, replace_on_divergence=True)
        except asyncio.CancelledError:
            # Annulation pendant l'émission du reste de la réponse finale :
            # snapshot la tool_history AVANT de propager (comme tous les
            # autres points d'annulation). Sans ça, _partial_tool_history
            # de la route reste vide → le partiel sauvé n'a aucune trace des
            # outils exécutés → un « Continuer » repart aveugle.
            await _emit_partial_tool_history_snapshot()
            raise

    # Récupère les vraies timings de llama.cpp (dernier appel = réponse finale)
    _real_timings = (rec.last_raw or {}).get("timings") or {}
    # Part de RÉFLEXION du tour : mesurée UNE fois, sur le raisonnement
    # cumulé de toutes les itérations (``/tokenize`` en local, estimation au
    # ratio mesuré sinon — cf. _think_tokens). Le raisonnement n'est pas
    # re-soumis d'une itération à l'autre (``working_messages`` ne garde pas
    # ``reasoning_content``) : il ne pèse donc que sur la SORTIE, et
    # ``output = réflexion + réponse`` reste vrai malgré le cumul.
    # Points de suspension de fin de tour sous ``_guard_cancel`` :
    # un Stop ici garde la trace des outils du run dans le partiel.
    _think_tok, _think_est = await _guard_cancel(measure_thinking_tokens(
        all_thinking_text, model_id=model or LLAMA_MODEL,
        usage=({"reasoning_tokens": rec.cumul_reasoning}
               if rec.cumul_reasoning is not None else None),
        output_tokens=rec.cumul_out))
    meta_for_metrics = {
        "usage":   {"prompt_tokens": rec.cumul_in, "completion_tokens": rec.cumul_out,
                    "cache_read_input_tokens": rec.cumul_cache_read,
                    "cache_creation_input_tokens": rec.cumul_cache_creation,
                    "tool_input_tokens": rec.cumul_tool_in},
        "timings": _real_timings,
        "model":   model or LLAMA_MODEL,
        "thinking": all_thinking_text,
        "thinking_tokens": _think_tok,
        "thinking_tokens_estimated": _think_est,
    }
    metrics = calculate_metrics(meta_for_metrics, time.time() - start_time)
    metrics.update({"input_tokens": rec.cumul_in, "output_tokens": rec.cumul_out})
    # Alias EXPLICITE de ``input_tokens`` (sémantique : tokens SOUMIS —
    # cumul des itérations du tool loop, l'historique re-soumis compte à
    # chaque round = vérité de facturation API). Pour l'OCCUPATION du
    # contexte, voir ``last_prompt_tokens``. Cf. docs/token-counters.md.
    metrics["submitted_input_tokens"] = rec.cumul_in
    # Nombre de TOURS ReAct productifs (un appel LLM = un tour). Exposé sur le
    # chemin normal aussi (le chemin tool_limit le fournit déjà) pour que le
    # moteur d'agents compte des tours, pas des tool calls.
    metrics["iterations"] = effective_iter
    # Troncature de la réponse finale : le modèle a été coupé par le plafond
    # de génération (``finish=="length"``) → ``truncated`` fait offrir
    # « Continuer » par la route, dans deux cas : de la prose VISIBLE a été
    # produite (reprise de la réponse), ou la coupure est tombée en plein
    # raisonnement sans réponse promue (``truncated_in_think`` : le front
    # repart avec le raisonnement en prefill).
    metrics["finish_reason"] = finish
    metrics["truncated"] = bool(finish == "length"
                                and ((final_clean or "").strip() or _truncated_in_think))
    metrics["truncated_in_think"] = _truncated_in_think
    # Reprises in-run chaînées sur le DERNIER appel LLM (0 = tour normal).
    metrics["think_resumes"] = resume.think_count
    # Reprises de RÉDACTION de ce tour : sans ce compteur, une réponse
    # recollée à partir de trois segments est indiscernable d'une réponse
    # écrite d'un trait — et on ne saurait pas si le filet a servi.
    if resume.content_count:
        metrics["content_resumes"] = resume.content_count
    # KV cache metric (UX) : ``rec.cumul_in`` est CUMULÉ sur toutes les
    # itérations du tool loop -- inutilisable pour estimer le KV cache.
    # On expose en plus le prompt_tokens de la DERNIÈRE itération (=
    # taille du dernier prompt envoyé au LLM, qui correspond à ce qui
    # est effectivement chargé dans le KV cache à la fin du tour).
    # Le front utilise ce champ comme fallback quand /api/llm/models
    # ne remonte pas les stats live du KV cache.
    _last_usage = (rec.last_raw or {}).get("usage") or {}
    metrics["last_prompt_tokens"]     = _last_usage.get("prompt_tokens", 0)
    metrics["last_completion_tokens"] = _last_usage.get("completion_tokens", 0)
    if all_thinking_text:
        metrics["thinking"] = all_thinking_text

    # ── Registre d'usage : UNE ligne par tour, ici et nulle part ailleurs ──
    # La route de chat ne journalise rien (sinon le tour serait compté deux
    # fois et le tableau de bord admin sommerait les deux) : elle se contente d'ouvrir un
    # ``usage_scope``. C'est aussi ce qui rend visibles les routines, les
    # webhooks et les sous-agents, qui passent par ICI mais jamais par la
    # route.
    _real_model = metrics.get("model") or model or LLAMA_MODEL
    _usage_ctx.record_turn_usage(
        model=_real_model, path="tools",
        input_tokens=rec.cumul_in, output_tokens=rec.cumul_out,
        submitted_tokens=rec.cumul_in, thinking_tokens=_think_tok,
        usage={"cache_read_input_tokens": rec.cumul_cache_read,
               "cache_creation_input_tokens": rec.cumul_cache_creation,
               "tool_input_tokens": rec.cumul_tool_in},
        duration_ms=int((time.time() - start_time) * 1000),
        iterations=effective_iter,
        # Ce chemin est le tour SAIN : le cap d'itérations sort par
        # ``finish_on_limit``, qui enregistre son propre statut.
        status="ok",
    )
    rec.usage_note(effective_iter=effective_iter, model=model or LLAMA_MODEL, recorded=True)
    # Débit et latence restent des séries de perf (pas de la conso) : elles
    # gardent ``metric_events``, mais avec le modèle RÉELLEMENT utilisé —
    # ``LLAMA_MODEL`` est une constante de configuration, elle fausserait
    # toute répartition par modèle dès qu'un connecteur externe sert.
    # Les quatre écritures de fin de tour partent dans UNE seule bascule
    # de thread : quatre transactions SQLite d'affilée sur l'event loop,
    # c'est jusqu'à quatre attentes du verrou WAL au moment précis où le
    # client attend son dernier event.
    _mode_tag = "optimized" if _inline_semaphore else "classic"

    def _write_end_of_turn_metrics() -> None:
        log_metric("write_tps",   metrics.get("write_tps", 0), {"model": _real_model})
        log_metric("llm_latency", time.time() - start_time,    {"model": _real_model})
        # Observabilité scheduling : permet de comparer classic vs optimized
        # sur wait_time et tool_iterations au fil du temps.
        log_metric(
            "llm_scheduling_mode", 1,
            {
                "model": _real_model,
                "mode": _mode_tag,
                "user": username,
            },
        )
        # Cohérence : même définition de « tour » que ``metrics["iterations"]``
        # renvoyé/affiché (tours PRODUCTIFS = effective_iter) ;
        # ``iteration + 1`` (= hard_iter+1, TOUS les tours) ferait diverger
        # la métrique d'observabilité et le compteur exposé.
        log_metric(
            "llm_tool_iterations", effective_iter,
            {"model": _real_model, "mode": _mode_tag},
        )

    with swallow("harness.run_chat_multi_mcp_impl.9"):
        await _guard_cancel(asyncio.to_thread(_write_end_of_turn_metrics))

    # Cleanup vision : libère la mémoire de la dernière screenshot après
    # la fin du tour. La prochaine run_chat_multi_mcp repartira de zéro
    # (ou utilisera les screenshots capturées durant ce nouveau tour).
    _clear_last_screenshot_for(f"{username}:{_chat_key_suffix}")

    # ── tool_history sur le chemin NORMAL (réponse finale) ───────────
    # DELTA du run uniquement (``rec.run_tool_history``) : les tours précédents
    # sont déjà persistés sur LEURS messages assistant respectifs, la
    # route ré-expanse chaque bulle. Une capture cumulative (depuis le
    # 1er message agentic) ré-inclurait l'historique passé ré-expandé en
    # tête → doublement du contexte à chaque tour.
    _norm_tool_history = rec.delta_snapshot()
    if _norm_tool_history:
        metrics["tool_history"] = _norm_tool_history
        metrics["tool_history_delta"] = True

    # ── Élagage FIN DE TOUR (marques persistées) ─────────────────────
    # Sélection en tokens exacts des vieilles sorties d'outils ; les clés
    # partent en event INTERNE ``prune_state`` (pattern compression_state)
    # → la route les fusionne dans meta_json["ctx_pruned_keys"] et le
    # rendu du PROCHAIN tour les remplace par le marqueur plein.
    try:
        _new_prune_keys = await _guard_cancel(_pruning.select_prune_keys(
            working_messages, ctx_size=rec.ctx_size,
            model_id=(model or LLAMA_MODEL or None),
            already_marked=rec.run_prune_keys))
        # Union des marques posées PENDANT le run (élagage intra-run) et de
        # la passe finale : les deux doivent être persistées, sinon les
        # sorties effacées de la vue reviendraient PLEINES au tour suivant
        # — le contexte regagné serait reperdu à chaque tour.
        _all_prune_keys = rec.prune_keys_new + [
            k for k in _new_prune_keys if k not in rec.run_prune_keys]
        if _all_prune_keys:
            await _guard_cancel(_emit(on_event, {"type": "prune_state",
                                                 "keys": _all_prune_keys}))
    except Exception:  # noqa: BLE001 — élagage de fin de tour best-effort
        logger.debug("[run_chat_multi_mcp] select_prune_keys a échoué "
                     "(best-effort)", exc_info=True)

    return final_clean, rec.events, metrics


async def finish_on_limit(ctx: RunContext, rec: RunRecord, resume: ResumeState,
                          deps: LoopDeps, working_messages: List[Dict[str, Any]], *,
                          effective_iter: int, hard_iter: int, wallclock_stop: bool,
                          ctx_saturated_stop: bool, gen_cap_stop: bool,
                          cycle_hard_stopped: bool, empty_choices_stop: bool,
                          ) -> Tuple[str, List[Dict[str, Any]], Dict[str, Any]]:
    """Sortie de la boucle sans réponse finale : cause réelle de l'arrêt,
    événement ``tool_limit``, tour de SYNTHÈSE sans outils (modèle OpenCode
    « max-steps »), filets de message, métriques, élagage et registre
    d'usage (statut ``tool_limit``)."""
    # Constantes du run sous leurs noms locaux usuels.
    on_event = ctx.on_event
    model = ctx.model
    username = ctx.username
    chat_id = ctx.chat_id
    sampling_override = ctx.sampling_override
    is_cancelled = ctx.is_cancelled
    tools_payload = ctx.tools_payload
    priority = ctx.priority
    start_time = ctx.start_time
    _chat_key_suffix = ctx.chat_key_suffix
    _inline_semaphore = ctx.inline_semaphore
    _effective_iter_budget = ctx.effective_iter_budget
    _hard_iter_cap = ctx.hard_iter_cap
    _max_iter = ctx.max_iter
    _guard_cancel = functools.partial(rec.guard_cancel, ctx.on_event)
    _emit_partial_tool_history_snapshot = functools.partial(rec.emit_partial_snapshot, ctx.on_event)
    _wallclock_stop = wallclock_stop
    _ctx_saturated_stop = ctx_saturated_stop
    _gen_cap_stop = gen_cap_stop
    _cycle_hard_stopped = cycle_hard_stopped
    _empty_choices_stop = empty_choices_stop
    # Sortie de boucle sans réponse finale — un des deux caps atteint.
    # Distingue dans les logs lequel a été limitant pour l'observabilité :
    #   - effective_iter_budget : limite UX souhaitée (itérations productives)
    #   - hard_iter_cap         : garde-fou anti-boucle infinie
    # Cause RÉELLE de la sortie — les causes spécifiques d'abord, le budget
    # d'étapes puis le cap dur en dernier recours. Les sorties forcées ne
    # touchent pas à ``effective_iter`` : le couple k/budget exposé est vrai.
    if _wallclock_stop:
        _stop_reason = "wallclock"
    elif _ctx_saturated_stop:
        _stop_reason = "ctx_saturated"
    elif _gen_cap_stop:
        _stop_reason = "gen_cap"
    elif _cycle_hard_stopped:
        _stop_reason = "cycle"
    elif _empty_choices_stop:
        _stop_reason = "empty_choices"
    elif effective_iter >= _effective_iter_budget:
        _stop_reason = "steps"
    else:
        _stop_reason = "hard"
    # ``limit_kind`` (contrat existant) : « hard » = garde-fou anti-cascade,
    # « effective » = tout le reste. La cause fine voyage dans ``stop_reason``.
    _limit_kind = "hard" if _stop_reason == "hard" else "effective"
    if _stop_reason == "steps":
        logger.warning(
            "[run_chat_multi_mcp] Limite EFFECTIVE atteinte : %d itérations productives "
            "sur %d total (budget %d, hard cap %d).",
            effective_iter, hard_iter, _effective_iter_budget, _hard_iter_cap,
        )
    elif _stop_reason == "hard":
        logger.warning(
            "[run_chat_multi_mcp] Limite HARD atteinte (boucle improductive) : "
            "%d/%d hard, seulement %d/%d effectives — modèle probablement coincé "
            "sur des appels d'outil échoués en cascade.",
            hard_iter, _hard_iter_cap, effective_iter, _effective_iter_budget,
        )
    else:
        logger.warning(
            "[run_chat_multi_mcp] Sortie forcée (%s) : %d/%d itérations "
            "productives, %d/%d dures — budget d'étapes NON épuisé.",
            _stop_reason, effective_iter, _effective_iter_budget,
            hard_iter, _hard_iter_cap,
        )
    # Compte les tool_calls effectivement exécutés pour le feedback UI.
    # On compte UNIQUEMENT les messages role="tool" (résultats d'outils) :
    # chaque tool exécuté produit exactement un message "tool", donc le
    # compte est 1:1 avec les outils réellement appelés. C'est la même
    # valeur que celle affichée dans toolSteps côté front (qui compte
    # les events ``tool_result``), donc cohérent avec l'UI.
    #
    # Ne PAS additionner aussi les messages assistant.tool_calls : cela
    # produirait un double-comptage (un appel = 1 assistant + 1 tool = 2).
    # Compté dans ``rec.run_tool_history`` (le DELTA de ce run), pas dans
    # ``working_messages`` : celui-ci porte l'historique ré-expansé des tours
    # précédents (``_expand_history_for_llm``) et perd les rounds absorbés
    # par une compaction/un aplatissement → compteur faux (persisté, affiché)
    # et porte du tour de synthèse (``> 0``) vraie sans outil ou fausse après
    # compaction.
    _tool_calls_done = sum(
        1
        for m in rec.run_tool_history
        if m.get("role") == "tool"
    )
    await _emit(on_event, {
        "type":               "tool_limit",
        # ``iterations`` est lu en face de ``max_iterations`` : il porte donc les
        # PRODUCTIVES (même unité que le budget). Le compteur dur reste exposé
        # à part — il monte jusqu'à 2× le budget et n'est pas comparable.
        "iterations":         effective_iter,
        "effective_iterations": effective_iter,
        "hard_iterations":    hard_iter,
        "hard_iterations_max": _hard_iter_cap,
        "max_iterations":     _max_iter,
        "tool_calls_done":    _tool_calls_done,
        "reason":             ("empty_choices" if _empty_choices_stop
                               else "max_iter_reached"),
        "limit_kind":         _limit_kind,
        # Cause fine : steps | hard | wallclock | ctx_saturated | gen_cap |
        # cycle | empty_choices. Le bandeau du front en tire son libellé.
        "stop_reason":        _stop_reason,
    })

    # ── Tour de SYNTHÈSE final (modèle OpenCode « max-steps ») ──────────
    # Rendre le dernier partiel SEC donnerait souvent une bulle vide (le
    # modèle venait d'appeler un outil). Un DERNIER appel LLM SANS outils
    # force une conclusion texte propre : constat de la limite, résumé du
    # réalisé, tâches restantes. Best-effort : tout échec retombe sur le
    # dernier partiel. Sauté si l'arrêt vient de l'anti-boucle desktop
    # (message dédié plus clair) ou sur annulation.
    _wrapup_text = ""
    # Synthèse coupée (plafond de génération ou flux interrompu) : elle ne doit
    # pas être rendue comme complète — cf. ``truncated`` plus bas.
    _wrapup_cut = False
    # Cause réelle de la sortie → consigne de synthèse correspondante. Ordre :
    # les causes SPÉCIFIQUES d'abord, le budget d'étapes en dernier recours.
    _wrapup_kind = _stop_reason if _stop_reason in _WRAPUP_BY_KIND else "steps"
    _wrapup_prompt = _WRAPUP_BY_KIND.get(_wrapup_kind, _MAX_STEPS_WRAPUP)
    # Occupation de contexte à exposer : le DERNIER prompt réellement envoyé
    # (celui de la synthèse s'il a lieu). Sans ce champ, la route retomberait
    # sur ``input_tokens`` — le CUMUL de toutes les itérations — et pousserait
    # une jauge à 100 % : bannière « contexte presque plein » à chaque limite
    # d'outils, fenêtre à 30 %.
    _limit_last_usage: Dict[str, Any] = dict((rec.last_raw or {}).get("usage") or {})
    if (not _cycle_hard_stopped and _tool_calls_done > 0
            and not (is_cancelled and is_cancelled())):
        try:
            _wrap_stats: Dict[str, Any] = {}
            # MÊME ``tools[]`` que les itérations : les gabarits rendent les
            # définitions d'outils EN TÊTE du prompt ; les retirer ferait
            # diverger le préfixe juste après le système — re-préremplissage
            # COMPLET, au moment où le contexte est le plus plein, puis une
            # seconde fois au tour suivant (slot écrasé par un préfixe sans
            # outils). Un appel d'outil émis quand même est
            # ignoré : seul le texte compte (consigne « TEXT ONLY »).
            _wrap_tools_tok = int(rec.tools_tok_counted[0]) if rec.tools_tok_counted else 0
            _wrap_msgs = await _pruning.fit_context(
                working_messages + [{"role": "user", "content": _wrapup_prompt}],
                ctx_size=rec.ctx_size,
                model_id=(model or LLAMA_MODEL or None),
                thinking_mode=False,
                tools_fixed_tokens=_wrap_tools_tok,
                stats_out=_wrap_stats,
                # Même plancher que la dernière itération : sans lui, le budget
                # repartirait de zéro et retirerait jusqu'au filigrane bas — la
                # tête de la vue changerait, et la synthèse re-préremplirait
                # tout le contexte, au plus plein.
                drop_floor=rec.budget_drop_floor,
                # Le tour de synthèse tourne typiquement CONTRE un contexte
                # plein (c'est souvent ce qui a provoqué la sortie) : sans les
                # marques d'élagage, il repartirait avec les sorties d'outils
                # pleines et échouerait — laissant une bulle vide.
                prune_keys=rec.run_prune_keys,
            )

            # Bufferisé SANS émettre : les tokens bruts du tour de synthèse
            # peuvent porter du markup <tool_call>/<function=…>. On ne diffuse
            # qu'APRÈS strip (comme ``finish_ok``) — sinon
            # du markup brut clignote dans l'UI avant la valeur nettoyée.
            async def _on_wrap_tok(tok: str) -> None:
                return None

            if _inline_semaphore:
                async with engine_semaphore().acquire_for(model, priority=priority):
                    _wrap_raw = await deps.stream(
                        _wrap_msgs, tools_payload, model_override=model, user_id=username,
                        on_content_token=_on_wrap_tok, is_cancelled=is_cancelled,
                        sampling_override=sampling_override,
                        thinking_mode=False, chat_id=chat_id,
                        # Outils GARDÉS (préfixe KV) mais non offerts : la
                        # consigne dit « outils désactivés », un appel émis
                        # quand même viderait la synthèse.
                        tool_choice="none",
                    )
            else:
                _wrap_raw = await deps.stream(
                    _wrap_msgs, tools_payload, model_override=model, user_id=username,
                    on_content_token=_on_wrap_tok, is_cancelled=is_cancelled,
                    sampling_override=sampling_override,
                    thinking_mode=False, chat_id=chat_id,
                    tool_choice="none",
                )
            _wrap_usage = _wrap_raw.get("usage") or {}
            if int(_wrap_usage.get("prompt_tokens") or 0) > 0:
                _limit_last_usage = dict(_wrap_usage)
            rec.cumul_in += _wrap_usage.get("prompt_tokens", 0)
            rec.cumul_out += _wrap_usage.get("completion_tokens", 0)
            # Cache de prompt : cumulé comme à chaque itération de la boucle.
            rec.cumul_cache_read     += int(_wrap_usage.get("cache_read_input_tokens") or 0)
            rec.cumul_cache_creation += int(_wrap_usage.get("cache_creation_input_tokens") or 0)
            rec.note_tool_input(_wrap_msgs, tools_payload, model or LLAMA_MODEL,
                                _wrap_usage.get("prompt_tokens", 0))
            rec.usage_note(effective_iter=effective_iter, model=model or LLAMA_MODEL)
            # Le tour de synthèse consomme comme les autres : sa part de
            # raisonnement déclarée compte aussi, sinon le cumul s'arrête à
            # la dernière itération d'outils.
            _rsn_wrap = _native_reasoning_tokens(_wrap_usage)
            if _rsn_wrap is not None:
                rec.cumul_reasoning = (rec.cumul_reasoning or 0) + _rsn_wrap
            _wrap_choice = (_wrap_raw.get("choices") or [{}])[0] or {}
            _wrap_msg = _wrap_choice.get("message") or {}
            _wrapup_cut = bool(_wrap_raw.get("partial")
                             or str(_wrap_choice.get("finish_reason") or "") == "length")
            _wrap_text_raw = _content_text(_wrap_msg.get("content")).strip()
            # Défense : thinking résiduel + markup d'appel jamais affichés.
            _wt_think, _wrap_text_raw = _extract_thinking(_wrap_text_raw)
            if _wt_think:
                rec.all_thinking.append(_wt_think)
                _clip_thinking_history(rec.all_thinking)
            _wrapup_text = _strip_tool_call_markup(_wrap_text_raw).strip()
            # Émettre le texte NETTOYÉ en content_token (même contrat que la
            # réponse finale : _on_wrap_tok a bufferisé sans émettre).
            #
            # Un seul event : le texte est DÉJÀ complet à cet instant (il faut
            # l'avoir en entier pour en retirer le markup). Le découper en
            # tranches temporisées ne serait qu'une animation de streaming, qui
            # coûterait 1 s par millier de caractères à la fin d'un run long,
            # quand l'utilisateur attend sa conclusion. Le client concatène les
            # ``content_token``, il n'en voit pas la découpe.
            if _wrapup_text and on_event:
                await _emit(on_event, {"type": "content_token",
                                       "text": _wrapup_text})
        except asyncio.CancelledError:
            # Stop pendant la synthèse (30-60 s contre un
            # contexte plein) : snapshot AVANT de propager, comme les autres
            # points d'annulation — c'est le moment où ``rec.run_tool_history``
            # est le plus rempli ; sans lui « Continuer » repart aveugle et
            # rejoue les outils mutants.
            await _emit_partial_tool_history_snapshot()
            raise
        except Exception as _wrap_err:  # noqa: BLE001 — synthèse best-effort : repli sur le partiel
            logger.warning(
                "[run_chat_multi_mcp] tour de synthèse max-steps échoué (%s) — "
                "retour au partiel historique", str(_wrap_err)[:160],
            )
            _wrapup_text = ""

    # Retourner le contenu partiel accumulé (pas un message d'erreur).
    # Même protection que ``finish_ok`` : le dernier assistant
    # peut porter du markup <tool_call> brut (assistant synthétique du
    # fallback legacy, ou prose mêlée au markup sur le chemin natif) — strip
    # avant affichage/persistance.
    # Le repli ne lit jamais ``reversed(working_messages)`` (tout l'historique
    # du chat) : un run sans prose, synthèse vide ou en échec, rendrait la
    # réponse du TOUR PRÉCÉDENT, persistée comme nouvelle réponse (et
    # planterait sur un ``content`` en liste). Même source que la voie
    # d'erreur : le travail de CE run — la prose d'une reprise de rédaction
    # en suspens (déjà affichée, absente du delta) d'abord, puis le dernier
    # assistant du delta.
    _partial = _wrapup_text
    if not _partial:
        _partial = (resume.pending_content or "").strip() or rec.last_assistant_text()
    if _partial:
        _partial = _strip_tool_call_markup(_partial)
    # Arrêt anti-boucle : garantir un message clair même si le dernier
    # assistant était vide (il venait d'appeler un outil, sans texte).
    if _cycle_hard_stopped and not (_partial and _partial.strip()):
        _partial = ("Je me suis arrêté : la même action s'est répétée plusieurs fois "
                    "sans que l'écran change (boucle détectée). Vérifie l'état réel de "
                    "la cible (fenêtre active, élément réellement cliquable), puis "
                    "dis-moi comment procéder.")
    # Arrêt « contexte saturé » (streak de tool calls coupés par finish=length) :
    # même garantie — le tour de synthèse a probablement échoué contre le même
    # contexte plein, l'utilisateur doit comprendre quoi faire.
    if _ctx_saturated_stop and not (_partial and _partial.strip()):
        _partial = ("Le contexte du modèle est saturé : mes appels d'outils ont été "
                    "coupés plusieurs fois de suite, je m'arrête pour préserver la "
                    "conversation. Compactez la conversation ou ouvrez un nouveau "
                    "chat pour continuer.")
    # Arrêt « plafond de génération » : la fenêtre n'est PAS pleine, inutile
    # de compacter — il faut des écritures plus courtes ou un max_tokens plus
    # haut. Annoncer un contexte saturé ici enverrait l'utilisateur compacter
    # une conversation qui n'en a pas besoin.
    if _gen_cap_stop and not (_partial and _partial.strip()):
        _partial = ("Mes appels d'outils ont été coupés plusieurs fois de suite par "
                    "le plafond de génération — le contexte, lui, n'est pas plein. "
                    "Je m'arrête pour ne pas boucler. Relancez avec « Reprendre » "
                    "en demandant des écritures plus courtes (plusieurs appels), "
                    "ou relevez max_tokens dans les réglages de génération.")
    # Arrêt « le moteur renvoie des réponses vides » : rien à voir avec le
    # budget d'itérations. Le travail
    # déjà fait est intact — « Continuer » repart de là.
    if _empty_choices_stop and not (_partial and _partial.strip()):
        _partial = ("Le moteur a renvoyé plusieurs réponses vides d'affilée : je "
                    "m'arrête pour ne pas boucler. Le travail déjà effectué est "
                    "conservé — relancez avec « Continuer ».")
    # FILET FINAL — « gracieux » ne doit JAMAIS vouloir dire « bulle vide ».
    # Le tour de synthèse est best-effort : s'il échoue (typiquement contre le
    # même contexte plein qui a provoqué la limite) ET qu'aucun texte assistant
    # n'a été accumulé (le modèle venait d'appeler un outil), le partiel
    # serait "" : une réponse vide, sans dire ce qui s'est passé ni qu'on peut
    # reprendre. Message déterministe, sans appel LLM.
    if not (_partial and _partial.strip()):
        _outils = (f" {_tool_calls_done} appel(s) d'outil ont abouti."
                   if _tool_calls_done else "")
        # Le constat doit correspondre à la VRAIE cause : avec le cap dur
        # (cascade d'appels ratés), « limite atteinte (12/200 tours) »
        # contredirait sa propre phrase.
        if _wallclock_stop:
            _cause = "J'ai atteint le budget de temps de la tâche"
        elif _limit_kind == "hard":
            _cause = (f"Je me suis arrêté après trop d'appels d'outils en échec "
                      f"d'affilée ({hard_iter} tentatives pour seulement "
                      f"{effective_iter} tour(s) utile(s))")
        else:
            _cause = (f"J'ai atteint la limite d'itérations d'outils "
                      f"({effective_iter}/{_max_iter} tours)")
        _suite = ("Le travail n'est pas terminé : utilisez « Reprendre » pour "
                  "continuer là où je me suis arrêté")
        _suite += ("." if _limit_kind == "hard" else
                   ", ou augmentez le budget d'itérations dans les réglages de "
                   "génération.")
        _partial = f"{_cause} avant de pouvoir rédiger ma réponse.{_outils} {_suite}"
    _limit_metrics = {
        "tool_limit_reached": True,
        "tool_limit_iters":   hard_iter,
        "tool_limit_effective_iters": effective_iter,
        "tool_limit_max":     _max_iter,
        "tool_limit_calls":   _tool_calls_done,
        "tool_limit_kind":    _limit_kind,
        "tool_limit_stop_reason": _stop_reason,
        # True = la réponse retournée est le tour de synthèse final (appel
        # sans outils), pas un partiel brut.
        "max_steps_wrapup":   bool(_wrapup_text),
        # Occupation RÉELLE fin de tour (même contrat que le chemin normal) :
        # c'est ce champ que la jauge de la route lit — jamais le cumul.
        "last_prompt_tokens": int(_limit_last_usage.get("prompt_tokens", 0) or 0),
        "last_completion_tokens": int(_limit_last_usage.get("completion_tokens", 0) or 0),
        "input_tokens":       rec.cumul_in,
        "submitted_input_tokens": rec.cumul_in,   # alias sémantique (tokens soumis)
        "output_tokens":      rec.cumul_out,
        # Cache (lu / créé) : même champs que les métriques du chemin normal.
        **({"cache_read_input_tokens": rec.cumul_cache_read} if rec.cumul_cache_read else {}),
        **({"cache_creation_input_tokens": rec.cumul_cache_creation}
           if rec.cumul_cache_creation else {}),
        **({"tool_input_tokens": rec.cumul_tool_in} if rec.cumul_tool_in else {}),
    }
    # Même décomposition de la sortie que sur le chemin normal : ce tour est le
    # plus coûteux de tous, la part de réflexion y est la plus intéressante.
    _limit_thinking = "\n\n".join(rec.all_thinking) if rec.all_thinking else ""
    _limit_think_tok, _limit_think_est = await _guard_cancel(measure_thinking_tokens(
        _limit_thinking, model_id=model or LLAMA_MODEL,
        usage=({"reasoning_tokens": rec.cumul_reasoning}
               if rec.cumul_reasoning is not None else None),
        output_tokens=rec.cumul_out))
    _limit_metrics["thinking_tokens"] = _limit_think_tok
    _limit_metrics["response_tokens"] = max(0, rec.cumul_out - _limit_think_tok)
    _limit_metrics["thinking_tokens_estimated"] = _limit_think_est
    if rec.all_thinking:
        _limit_metrics["thinking"] = _limit_thinking
    if _ctx_saturated_stop:
        _limit_metrics["context_saturated"] = True
    if _gen_cap_stop:
        _limit_metrics["gen_cap_stop"] = True
    if _wrapup_text and _wrapup_cut:
        # Synthèse coupée : « Continuer » plutôt qu'une conclusion tronquée
        # présentée comme complète.
        _limit_metrics["truncated"] = True
        _limit_metrics["max_steps_wrapup_truncated"] = True
    if _empty_choices_stop:
        _limit_metrics["empty_choices_stop"] = True
        # Le budget n'est PAS épuisé : la route doit offrir « Continuer »
        # (sans ce flag, l'arrêt se lirait « limite d'itérations atteinte »
        # et la mission s'arrêterait là).
        _limit_metrics["truncated"] = True
    # ── tool_history : DELTA du run (rec.run_tool_history) ──────────────────
    # Sur un Resume, la route fusionne ce delta au tronc persisté
    # (_merge_continue_tool_history) : pas de capture cumulative, qui,
    # ré-expandée à chaque bulle par la route, doublerait le contexte à chaque
    # tour. Le compteur _tool_calls_done est compté sur ce même delta.
    _tool_history = rec.delta_snapshot()
    if _tool_history:
        _limit_metrics["tool_history"] = _tool_history
        _limit_metrics["tool_history_delta"] = True
    # Élagage fin de tour aussi sur le chemin « cap atteint » — le tour
    # est terminé, ses vieilles sorties sont éligibles comme sur le chemin
    # normal. Best-effort.
    try:
        _new_prune_keys = await _guard_cancel(_pruning.select_prune_keys(
            working_messages, ctx_size=rec.ctx_size,
            model_id=(model or LLAMA_MODEL or None),
            already_marked=rec.run_prune_keys))
        _all_prune_keys = rec.prune_keys_new + [
            k for k in _new_prune_keys if k not in rec.run_prune_keys]
        if _all_prune_keys:
            await _guard_cancel(_emit(on_event, {"type": "prune_state",
                                                 "keys": _all_prune_keys}))
    except Exception:  # noqa: BLE001 — élagage de fin de tour best-effort
        logger.debug("[run_chat_multi_mcp] select_prune_keys (cap) a échoué",
                     exc_info=True)
    _clear_last_screenshot_for(f"{username}:{_chat_key_suffix}")
    # Registre d'usage — ce chemin (cap d'itérations / budget de temps atteint)
    # est le plus COÛTEUX de tous : il ne doit surtout pas être le seul à ne
    # rien enregistrer. Statut ``tool_limit`` pour le distinguer d'un tour sain.
    _usage_ctx.record_turn_usage(
        model=(model or LLAMA_MODEL), path="tools",
        input_tokens=rec.cumul_in, output_tokens=rec.cumul_out, submitted_tokens=rec.cumul_in,
        thinking_tokens=_limit_think_tok,
        usage={"cache_read_input_tokens": rec.cumul_cache_read,
               "cache_creation_input_tokens": rec.cumul_cache_creation,
               "tool_input_tokens": rec.cumul_tool_in},
        duration_ms=int((time.time() - start_time) * 1000),
        iterations=effective_iter,
        status="tool_limit", error_kind=str(_limit_kind or ""),
    )
    rec.usage_note(effective_iter=effective_iter, model=model or LLAMA_MODEL, recorded=True)
    return _partial, rec.events, _limit_metrics


async def finish_on_error(ctx: RunContext, rec: RunRecord, resume: ResumeState, *,
                          error: Optional[BaseException], err_kind: Optional[str],
                          live: LiveText, thinking_parts: List[str], iteration: int,
                          effective_iter: int, hard_iter: int,
                          ) -> Tuple[str, List[Dict[str, Any]], Dict[str, Any]]:
    """Sortie d'erreur du run (appel LLM en échec après les récupérations) :
    événement ``error`` actionnable, partiel du run, métriques et registre
    d'usage (statut ``aborted``)."""
    # Constantes du run sous leurs noms locaux usuels.
    on_event = ctx.on_event
    model = ctx.model
    username = ctx.username
    start_time = ctx.start_time
    _chat_key_suffix = ctx.chat_key_suffix
    _effective_iter_budget = ctx.effective_iter_budget
    _hard_iter_cap = ctx.hard_iter_cap
    _guard_cancel = functools.partial(rec.guard_cancel, ctx.on_event)
    llm_err = error
    _err_kind = err_kind
    _iter_content_parts = live.parts
    _iter_thinking_parts = thinking_parts
    # Message ACTIONNABLE en tête (LLMFailure stringifie déjà en clair ;
    # pour toute autre exception, la taxonomie donne le repli), motif
    # technique dans ``detail`` — replié derrière « Détails » côté UI,
    # jamais la seule chose lue par l'utilisateur.
    _err_text = (str(llm_err) if isinstance(llm_err, LLMFailure)
                 else _llm_error_user_message(llm_err))
    _err_detail = (llm_err.detail if isinstance(llm_err, LLMFailure)
                   else f"{type(llm_err).__name__}: {str(llm_err)[:300]}")
    await _emit(on_event, {
        "type": "error",
        "text": f"{_err_text} La réponse partielle est conservée.",
        "detail": _err_detail,
        "kind": _err_kind,
        # Homogène : itérations PRODUCTIVES sur leur budget (avec
        # ``hard_iter``, tous les tours, le numérateur pourrait
        # dépasser le dénominateur affiché).
        "iteration": f"{min(effective_iter + 1, _effective_iter_budget)}/{_effective_iter_budget}",
        "hard_iteration": f"{hard_iter + 1}/{_hard_iter_cap}",
    })
    # Retourne le contenu accumulé avant l'erreur comme réponse finale.
    # Le dernier assistant peut être le message synthétique du
    # fallback legacy (content = texte brut AVEC <tool_call>/
    # <function=>) : strip avant de retourner, comme le chemin de
    # réponse finale (cf. _strip_tool_call_markup sur final_clean) —
    # sinon le markup brut partirait dans la bulle ET en base.
    # Le partiel vient du DELTA DE CE RUN, jamais de
    # ``working_messages`` : celle-ci porte tout l'historique, si bien
    # qu'un run n'ayant produit que des tool_calls renverrait la
    # réponse du TOUR PRÉCÉDENT (persistée comme nouvelle réponse,
    # « Continuer » offert), et qu'un « Continuer » renverrait son
    # propre préfixe — doublé en base par la route.
    # Texte déjà streamé par l'appel qui a échoué : c'est ce que
    # l'utilisateur vient de voir s'interrompre — il prime. Sur une
    # reprise de rédaction, il PROLONGE la prose déjà affichée (les
    # segments d'avant la coupure, restitués dans
    # ``resume.pending_content``) : sans ce préfixe, le partiel ne
    # porterait que le dernier segment et la partie 1 disparaîtrait en
    # base.
    _partial_text = ((resume.pending_content or "")
                     + "".join(_iter_content_parts)).strip()
    if not _partial_text:
        _partial_text = rec.last_assistant_text()
    if _partial_text:
        _partial_text = _strip_tool_call_markup(_partial_text)
    # Mêmes clés d'occupation que les deux autres sorties : sans
    # ``last_prompt_tokens`` ni ``submitted_input_tokens``, la jauge de
    # la route (``_kv_gauge_used_tokens``) retomberait sur
    # ``input_tokens`` — le CUMUL des itérations — et afficherait
    # 100 % après chaque erreur.
    _err_last_usage = (rec.last_raw or {}).get("usage") or {}
    _err_metrics = {
        "input_tokens": rec.cumul_in,
        "submitted_input_tokens": rec.cumul_in,
        "output_tokens": rec.cumul_out,
        "last_prompt_tokens": int(_err_last_usage.get("prompt_tokens", 0) or 0),
        "last_completion_tokens": int(_err_last_usage.get("completion_tokens", 0) or 0),
        "model": model or LLAMA_MODEL,
        "iterations": effective_iter,
        "tool_iterations": iteration,
        "ended_with_error": True,
        # Comme les retours normal et « limite » : sans cette clé, la
        # réflexion affichée en direct disparaîtrait au rechargement.
        "thinking": "\n\n".join(
            p for p in (rec.all_thinking + ["".join(_iter_thinking_parts or [])]) if p),
        # Un partiel existe → le tour est REPRENABLE : ``truncated``
        # fait poser le flag par la route et le front affiche
        # « Continuer » : une erreur LLM après retries garde un chemin
        # de reprise en un clic (vital en mission autonome de
        # plusieurs heures).
        "truncated": bool(_partial_text),
    }
    # tool_history = DELTA du run (voir rec.run_tool_history). La route
    # fusionne au tronc si Continue — pas de capture cumulative.
    _err_history = rec.delta_snapshot()
    if _err_history:
        _err_metrics["tool_history"] = _err_history
        _err_metrics["tool_history_delta"] = True
    # Cohérence avec les retours normal/limite : libère la dernière
    # screenshot trackée pour ce chat (sinon fuite mémoire jusqu'au
    # prochain tour, qui l'écraserait de toute façon).
    _clear_last_screenshot_for(f"{username}:{_chat_key_suffix}")
    # Registre d'usage : les trois retours enregistrent (status "ok",
    # "tool_limit", et ici "aborted", comme les partiels du chemin
    # classic). Aucune autre couche ne compense — la route ne
    # journalise pas. Sans lui, un run autonome de 3 h qui meurt à
    # l'itération 181 disparaîtrait de l'onglet Utilisation et du
    # tableau de bord, alors qu'il est le plus coûteux de la journée.
    # Mesure du raisonnement et enregistrement SÉPARÉS : un échec de
    # la mesure ne doit pas sauter l'enregistrement, puisque le run est
    # marqué « enregistré » juste après.
    _err_think_tok = 0
    with swallow("harness.measure_thinking_on_error"):
        _err_think_tok, _ = await _guard_cancel(measure_thinking_tokens(
            "\n\n".join(rec.all_thinking), model_id=(model or LLAMA_MODEL or None),
            usage=({"reasoning_tokens": rec.cumul_reasoning}
                   if rec.cumul_reasoning is not None else None),
            output_tokens=rec.cumul_out))
    with swallow("harness.record_usage_on_error"):
        _usage_ctx.record_turn_usage(
            model=(model or LLAMA_MODEL), path="tools",
            input_tokens=rec.cumul_in, output_tokens=rec.cumul_out,
            submitted_tokens=rec.cumul_in, thinking_tokens=_err_think_tok,
            usage={"cache_read_input_tokens": rec.cumul_cache_read,
                   "cache_creation_input_tokens": rec.cumul_cache_creation,
                   "tool_input_tokens": rec.cumul_tool_in},
            duration_ms=int((time.time() - start_time) * 1000),
            iterations=effective_iter,
            status="aborted",
            error_kind=str(_err_kind or type(llm_err).__name__),
        )
    rec.usage_note(effective_iter=effective_iter, model=model or LLAMA_MODEL, recorded=True)
    return _partial_text, rec.events, _err_metrics
