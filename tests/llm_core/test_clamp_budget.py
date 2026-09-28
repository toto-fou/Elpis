# SPDX-License-Identifier: MIT
"""tests/llm_core/test_clamp_budget.py — borne du budget de génération (source unique).

Couvre ``llm_core._constants.clamp_generation_budget`` : injection du cap si absent,
CLAMP d'un override explicite (le bug qui corrompait l'historique en mode classic),
gestion de n_predict, mode thinking.
"""
from __future__ import annotations

from llm_core._constants import (
    clamp_generation_budget,
    effective_generation_cap,
    LLAMA_MAX_TOKENS_CHAT as CAP_CHAT,
    LLAMA_MAX_TOKENS_THINKING as CAP_THINK,
    LLAMA_GEN_CAP_CTX_RATIO as RATIO,
    LLAMA_GEN_CAP_FLOOR as FLOOR,
)


def _run(sampling, thinking=False, ctx_size=None):
    payload = {}
    clamp_generation_budget(payload, sampling, thinking, ctx_size=ctx_size)
    return payload


def test_injects_cap_when_no_override():
    assert _run({})["max_tokens"] == CAP_CHAT
    assert _run({}, thinking=True)["max_tokens"] == CAP_THINK


def test_clamps_excessive_override():
    # Le bug : un override énorme contournait le cap → dépassement n_ctx.
    assert _run({"max_tokens": 1_000_000})["max_tokens"] == CAP_CHAT
    assert _run({"n_predict": 999_999})["n_predict"] == CAP_CHAT
    assert _run({"max_tokens": 50_000}, thinking=True)["max_tokens"] == CAP_THINK


def test_preserves_reasonable_override():
    assert _run({"max_tokens": 4000})["max_tokens"] == 4000


def test_unlimited_n_predict_falls_back_to_cap():
    p = _run({"n_predict": -1})
    assert p["max_tokens"] == CAP_CHAT and "n_predict" not in p


# ── cap adaptatif au n_ctx (fix « fit dans ~8192 tokens » sur un 32K) ────────
def test_effective_cap_no_ctx_is_theoretical():
    assert effective_generation_cap(False) == CAP_CHAT
    assert effective_generation_cap(True) == CAP_THINK


def test_effective_cap_small_ctx_is_bounded():
    # 32K thinking : avant on réservait CAP_THINK (24576 = 75% → 8K de prompt).
    # Désormais borné à RATIO·n_ctx → la majorité du contexte va au prompt.
    cap = effective_generation_cap(True, 32768)
    assert cap == int(32768 * RATIO)
    assert cap < CAP_THINK
    # budget de prompt = n_ctx - cap → nettement > 8192
    assert 32768 - cap > 16000


def test_effective_cap_large_ctx_keeps_theoretical():
    # 128K : RATIO·n_ctx (52428) > cap théorique → c'est le théorique qui borne.
    assert effective_generation_cap(True, 131072) == CAP_THINK


def test_effective_cap_floor_on_tiny_ctx():
    assert effective_generation_cap(False, 4096) == FLOOR     # 0.4·4096=1638 < floor


def test_clamp_injects_ctx_aware_cap():
    cap32 = int(32768 * RATIO)
    assert _run({}, thinking=True, ctx_size=32768)["max_tokens"] == cap32
    # un override explicite est CLAMPÉ au cap effectif (pas au théorique)
    assert _run({"max_tokens": 50_000}, thinking=True, ctx_size=32768)["max_tokens"] == cap32


def test_clamp_without_ctx_unchanged():
    # rétro-compat : sans ctx_size, comportement identique à avant (cap théorique)
    assert _run({}, thinking=True)["max_tokens"] == CAP_THINK


# ── uncap_output : sortie NON plafonnée en mode thinking local ───────────────
def _run_uncap(sampling, thinking=True, ctx_size=None):
    payload = {"max_tokens": 1234}  # résidu d'un build antérieur → doit sauter
    clamp_generation_budget(payload, sampling, thinking, ctx_size=ctx_size,
                            uncap_output=True)
    return payload


def test_uncap_sends_no_max_tokens():
    # Aligné écosystème (Open WebUI / webui llama.cpp) : aucun max_tokens →
    # n_predict=-1 côté serveur, un long raisonnement n'est plus coupé.
    p = _run_uncap({})
    assert "max_tokens" not in p and "n_predict" not in p


def test_uncap_drops_residual_negative_n_predict():
    p = _run_uncap({"n_predict": -1})
    assert "max_tokens" not in p and "n_predict" not in p


def test_uncap_respects_explicit_override_clamped():
    # Un override explicite reste un plafond VOULU : clampé, pas neutralisé.
    p = _run_uncap({"max_tokens": 4000})
    assert p["max_tokens"] == 4000
    p = _run_uncap({"max_tokens": 1_000_000}, ctx_size=32768)
    assert p["max_tokens"] == int(32768 * RATIO)


def test_uncap_false_keeps_legacy_injection():
    payload = {}
    clamp_generation_budget(payload, {}, True, uncap_output=False)
    assert payload["max_tokens"] == CAP_THINK
