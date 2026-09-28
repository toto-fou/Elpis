# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_think_resume.py

Unitaires PURS de ``llm_core._think_resume`` (aucune I/O) :

  • ``clip_resume_thinking``    — borne au suffixe + marqueur ;
  • ``build_resume_tail``       — forme native (continue_final_message) vs
                                  repli (think fermé + consigne de conclusion) ;
  • ``should_auto_resume``      — chaque garde, et le cas nominal ;
  • ``merge_segment_usage``     — somme des completion, prompt = dernier.
"""
from __future__ import annotations

from llm_core import _think_resume as tr


# ── clip_resume_thinking ─────────────────────────────────────────────────────
def test_clip_short_passthrough():
    assert tr.clip_resume_thinking("abc") == "abc"
    assert tr.clip_resume_thinking("") == ""


def test_clip_long_keeps_suffix_with_marker():
    long = "x" * (tr.MAX_RESUME_THINKING_CHARS + 500) + "FIN"
    out = tr.clip_resume_thinking(long)
    assert out.startswith(tr.RESUME_TRUNC_MARKER)
    assert out.endswith("FIN")
    assert len(out) == len(tr.RESUME_TRUNC_MARKER) + tr.MAX_RESUME_THINKING_CHARS


# ── build_resume_tail ────────────────────────────────────────────────────────
def test_tail_native_shape_and_flags():
    msgs, flags = tr.build_resume_tail("raisonnement en cours", native=True)
    assert msgs == [{"role": "assistant", "content": "",
                     "reasoning_content": "raisonnement en cours"}]
    assert flags == {"continue_final_message": True, "add_generation_prompt": False}


def test_tail_fallback_closed_think_plus_instruction():
    msgs, flags = tr.build_resume_tail("raisonnement", native=False)
    assert flags == {}
    assert len(msgs) == 2
    a, u = msgs
    assert a["role"] == "assistant"
    # Think FERMÉ : un prefill non fermé ne « continue » pas réellement hors
    # continue_final_message (le template clôt le message et rouvre un tour).
    assert a["content"].startswith("<think>\n")
    assert a["content"].endswith("</think>")
    assert "raisonnement" in a["content"]
    assert u == {"role": "user", "content": tr.RESUME_AFTER_THINK_INSTRUCTION}


# ── should_auto_resume ───────────────────────────────────────────────────────
_BASE = dict(finish="length", content="", thinking="pensées…",
             had_tool_calls=False, partial=False,
             resumes_done=0, think_tokens_done=0,
             ctx_size=None, window_tokens=0)


def _decide(**over):
    kw = {**_BASE, **over}
    return tr.should_auto_resume(**kw)


def test_resume_ok_nominal():
    ok, why = _decide()
    assert ok is True
    assert "reprise" in why


def test_resume_refused_on_stop():
    ok, why = _decide(finish="stop")
    assert (ok, why) == (False, "finish!=length")


def test_resume_refused_when_content_present():
    ok, _ = _decide(content="du texte visible")
    assert ok is False


def test_resume_refused_without_thinking():
    ok, _ = _decide(thinking="   ")
    assert ok is False


def test_resume_refused_with_tool_calls():
    ok, why = _decide(had_tool_calls=True)
    assert ok is False and "tool_calls" in why


def test_resume_accepted_on_partial():
    # Audit cœur 2026-08-21 : un partiel de transport n'est PLUS un motif de
    # refus — la reprise passe par le retry/backoff complet (un serveur mort
    # échoue vite) et les mêmes plafonds bornent l'acharnement. Bloquer ici
    # transformait chaque micro-coupure en fin de run sur les missions longues.
    ok, why = _decide(partial=True)
    assert ok is True and "coupure transport" in why


def test_resume_refused_at_max_resumes(monkeypatch):
    monkeypatch.setattr(tr, "LLAMA_THINK_RESUME_MAX", 2)
    ok, why = _decide(resumes_done=2)
    assert ok is False and "plafond" in why
    ok, _ = _decide(resumes_done=1)
    assert ok is True


def test_resume_disabled_when_max_zero(monkeypatch):
    monkeypatch.setattr(tr, "LLAMA_THINK_RESUME_MAX", 0)
    ok, why = _decide()
    assert ok is False and "désactivée" in why


def test_resume_refused_over_total_budget(monkeypatch):
    monkeypatch.setattr(tr, "LLAMA_THINK_RESUME_TOTAL_TOKENS", 1000)
    ok, why = _decide(think_tokens_done=1000)
    assert ok is False and "budget total" in why
    ok, _ = _decide(think_tokens_done=999)
    assert ok is True


def test_resume_refused_when_inference_window_full():
    # Occupation RÉELLE mesurée + marge ≥ n_ctx → bannière plutôt qu'une
    # reprise vouée au même mur (elle coûterait un prefill complet pour
    # quelques tokens).
    ok, why = _decide(ctx_size=10_000, window_tokens=8_500)
    assert ok is False and "fenêtre d'inférence" in why
    ok, _ = _decide(ctx_size=10_000, window_tokens=5_500)
    assert ok is True


def test_le_raisonnement_cumule_ne_compte_pas_dans_la_fenetre():
    """Le prompt d'un segment de reprise CONTIENT déjà le raisonnement des
    segments précédents : l'additionner comptait deux fois et refusait la
    reprise vers la moitié de la fenêtre réelle. Un raisonnement long était
    bloqué par un mur qui n'existait pas."""
    # 6 000 de fenêtre réelle sur 10 000, avec 3 500 de thinking cumulé DÉJÀ
    # inclus dans ces 6 000 : l'ancien calcul (6 000 + 3 500 + 2 048) refusait.
    ok, _ = _decide(ctx_size=10_000, window_tokens=6_000,
                    think_tokens_done=3_500)
    assert ok is True


def test_fenetre_inconnue_ne_bloque_pas():
    """Sans mesure (usage absent), on ne refuse pas sur une occupation
    supposée : la garde ne porte que sur du RÉEL."""
    ok, _ = _decide(ctx_size=4_096, window_tokens=0, think_tokens_done=99_000)
    assert ok is True


# ── merge_segment_usage ──────────────────────────────────────────────────────
def test_merge_usage_sums_completion_keeps_last_prompt():
    acc = {"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150}
    seg = {"prompt_tokens": 160, "completion_tokens": 30, "total_tokens": 190}
    out = tr.merge_segment_usage(acc, seg)
    assert out["completion_tokens"] == 80
    assert out["total_tokens"] == 340
    # prompt = DERNIER segment (les précédents sont des préfixes du même
    # prompt : les sommer gonflerait la jauge).
    assert out["prompt_tokens"] == 160


def test_merge_usage_empty_acc_returns_seg_copy():
    seg = {"prompt_tokens": 7, "completion_tokens": 3}
    out = tr.merge_segment_usage({}, seg)
    assert out == seg and out is not seg


def test_merge_usage_empty_seg_keeps_acc():
    acc = {"completion_tokens": 5}
    assert tr.merge_segment_usage(acc, {}) is acc
