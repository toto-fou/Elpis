# SPDX-License-Identifier: MIT
"""tests/llm_core/test_tokens_measured.py — ratio chars/token MESURÉ et
matérialisations en tokens (phase T0 du harnais v4, 2026-07-28).

Principe « zéro décision en chars » : les seuils de l'app sont en TOKENS ;
les longueurs de chaîne ne sont plus que des MATÉRIALISATIONS via un ratio
mesuré sur les réponses réelles (EWMA par modèle, amorce froide 3.3, bornes
anti-aberration). Verrouille :
- amorce froide, mise à jour EWMA, bornes [1.5, 8], entrées invalides ;
- ``tokens_to_chars`` (ratio mesuré) vs ``tokens_to_chars_stable`` (amorce
  figée — pour les caps ré-évalués sur du contenu stocké) ;
- ``payload_chars`` / ``est_tokens_message_measured`` / ``measured_prompt_tokens`` ;
- cap d'émission en tokens (clamp 2400 / 0.06·ctx / 25000) et sa
  matérialisation bornée sous le filet sanitize ;
- filet sanitize dérivé de ``sanitize_tool_max_tokens`` (stable).

Aucun réseau : fonctions pures + état module remis à zéro par fixture.
"""
from __future__ import annotations

import pytest

import llm_core.context.tokens as tok
from llm_core.context.budget import BUDGET
from llm_core.context.pruning import emit_cap_chars, emit_cap_tokens


@pytest.fixture(autouse=True)
def _reset_ratio():
    tok._measured_ratio.clear()
    yield
    tok._measured_ratio.clear()


# ── EWMA du ratio mesuré ────────────────────────────────────────────────────

def test_amorce_froide_puis_premiere_mesure():
    assert tok.measured_chars_per_token("m") == tok.CHARS_PER_TOKEN
    tok.note_real_usage("m", prompt_chars=40_000, prompt_tokens=10_000)
    assert tok.measured_chars_per_token("m") == pytest.approx(4.0), \
        "première mesure = valeur directe (pas de moyenne avec l'amorce)"


def test_ewma_lisse_les_mesures_suivantes():
    tok.note_real_usage("m", 40_000, 10_000)          # 4.0
    tok.note_real_usage("m", 30_000, 10_000)          # 3.0 → 4.0 + 0.3·(3−4)
    assert tok.measured_chars_per_token("m") == pytest.approx(3.7)


def test_bornes_et_entrees_invalides_ignorees():
    tok.note_real_usage("m", 1_000_000, 10_000)       # ratio 100 → aberrant
    tok.note_real_usage("m", 5_000, 10_000)           # ratio 0.5 → aberrant
    tok.note_real_usage("m", 0, 10_000)
    tok.note_real_usage("m", 10_000, 0)
    assert tok.measured_chars_per_token("m") == tok.CHARS_PER_TOKEN, \
        "aucune mesure aberrante ne doit toucher le ratio"


def test_ratio_par_modele_isole():
    tok.note_real_usage("a", 40_000, 10_000)
    assert tok.measured_chars_per_token("a") == pytest.approx(4.0)
    assert tok.measured_chars_per_token("b") == tok.CHARS_PER_TOKEN


# ── Matérialisations ────────────────────────────────────────────────────────

def test_tokens_to_chars_mesure_vs_stable():
    tok.note_real_usage("m", 40_000, 10_000)          # ratio 4.0
    assert tok.tokens_to_chars(1_000, "m") == 4_000
    # La variante STABLE ignore les mesures (caps ré-évalués sur du stocké).
    assert tok.tokens_to_chars_stable(1_000) == int(1_000 * tok.CHARS_PER_TOKEN)


def test_payload_chars_compte_content_et_tool_calls():
    msgs = [
        {"role": "user", "content": "x" * 100},
        {"role": "assistant", "content": None,
         "tool_calls": [{"id": "c1", "type": "function",
                         "function": {"name": "run", "arguments": "y" * 50}}]},
        {"role": "user", "content": [{"type": "text", "text": "z" * 30},
                                     {"type": "image_url",
                                      "image_url": {"url": "data:..."}}]},
    ]
    assert tok.payload_chars(msgs) == 100 + 3 + 50 + 30


def test_est_message_mesure_overhead_et_image():
    tok.note_real_usage("m", 40_000, 10_000)          # ratio 4.0
    m = {"role": "user", "content": "x" * 400}
    assert tok.est_tokens_message_measured(m, "m") == tok.MSG_OVERHEAD_TOKENS + 100
    img = {"role": "user", "content": [
        {"type": "text", "text": "x" * 40},
        {"type": "image_url", "image_url": {"url": "data:..."}}]}
    got = tok.est_tokens_message_measured(img, "m")
    assert got == tok.MSG_OVERHEAD_TOKENS + 10 + tok.image_token_cost()


def test_measured_prompt_tokens_somme_et_extra():
    msgs = [{"role": "user", "content": "x" * 33}] * 3
    base = tok.measured_prompt_tokens(msgs)
    assert base == 3 * (tok.MSG_OVERHEAD_TOKENS + 10)
    assert tok.measured_prompt_tokens(msgs, extra_fixed=500) == base + 500


# ── Cap d'émission en tokens ────────────────────────────────────────────────

def test_emit_cap_tokens_clamp():
    assert emit_cap_tokens(None) == BUDGET.emit_cap_min_tokens == 2_400
    assert emit_cap_tokens(262_144) == int(0.06 * 262_144) == 15_728
    assert emit_cap_tokens(1_048_576) == BUDGET.emit_cap_max_tokens == 25_000


def test_emit_cap_chars_suit_le_ratio_mesure():
    seed = emit_cap_chars(262_144, "m")
    assert seed == int(15_728 * tok.CHARS_PER_TOKEN) == 51_902
    tok.note_real_usage("m", 40_000, 10_000)          # ratio 4.0
    assert emit_cap_chars(262_144, "m") == 15_728 * 4
    # Toujours borné sous le filet sanitize (une coupe d'émission ne doit
    # jamais pouvoir être re-coupée par le filet).
    filet = tok.tokens_to_chars_stable(BUDGET.sanitize_tool_max_tokens)
    assert emit_cap_chars(1_048_576, "m") <= filet - 5_000


def test_filet_sanitize_en_tokens_stables():
    from llm_core.context.pruning import sanitize_message_history
    filet = tok.tokens_to_chars_stable(BUDGET.sanitize_tool_max_tokens)
    assert filet == int(50_000 * tok.CHARS_PER_TOKEN) == 165_000
    msgs = [
        {"role": "assistant", "content": None,
         "tool_calls": [{"id": "c1", "type": "function",
                         "function": {"name": "run", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "x" * 200_000},
    ]
    out = sanitize_message_history(msgs)
    # Repérage par RÔLE : la passe pose aussi une ancre de tâche quand
    # l'historique n'a aucun ``user`` (cf. _ensure_user_anchor).
    _tool_of = lambda ms: next(m for m in ms if m["role"] == "tool")
    assert len(_tool_of(out)["content"]) <= filet
    # Une mesure de ratio NE change PAS le filet (stable → idempotence).
    tok.note_real_usage("", 20_000, 10_000)           # ratio défaut → 2.0
    out2 = sanitize_message_history(out)
    assert _tool_of(out2)["content"] == _tool_of(out)["content"], \
        "le filet doit rester byte-stable malgré un ratio mesuré mouvant"
