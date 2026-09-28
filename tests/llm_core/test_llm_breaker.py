# SPDX-License-Identifier: MIT
"""tests/llm_core/test_llm_breaker.py — disjoncteur LLM (fail-safe)."""
from __future__ import annotations

import pytest

from llm_core._scheduling import _breaker as b


def test_opens_after_threshold_then_resets_on_success():
    b.reset()
    m = "model-A"
    b.allow(m)  # fermé → OK
    for _ in range(b._FAILS_TO_OPEN - 1):
        b.record_failure(m)
    b.allow(m)  # sous le seuil → encore OK
    b.record_failure(m)  # atteint le seuil → ouvert
    with pytest.raises(b.LLMCircuitOpen):
        b.allow(m)
    b.record_success(m)  # reset
    b.allow(m)  # refermé → OK
    b.reset()


def test_half_open_after_cooldown():
    b.reset()
    m = "model-B"
    for _ in range(b._FAILS_TO_OPEN):
        b.record_failure(m)
    with pytest.raises(b.LLMCircuitOpen):
        b.allow(m)
    # simule l'expiration du cooldown
    b._state[b._key(m)]["open_until"] = 0.0
    b.allow(m)  # half-open → laisse passer (probe)
    b.reset()


def test_isolated_per_model():
    b.reset()
    for _ in range(b._FAILS_TO_OPEN):
        b.record_failure("model-C")
    with pytest.raises(b.LLMCircuitOpen):
        b.allow("model-C")
    b.allow("model-D")  # autre modèle non affecté
    b.reset()


def test_failsafe_when_disabled(monkeypatch):
    monkeypatch.setattr(b, "_ENABLED", False)
    b.reset()
    for _ in range(b._FAILS_TO_OPEN + 3):
        b.record_failure("model-E")
    b.allow("model-E")  # désactivé → ne lève jamais
    b.reset()
