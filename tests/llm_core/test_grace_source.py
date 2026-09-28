# SPDX-License-Identifier: MIT
"""tests/llm_core/test_grace_source.py — source unique de la fenêtre de
grâce LLM (AUDIT 2026-06).

Quand le lock distribué Redis est effectivement actif, la grâce
process-locale est sautée (LLM_GRACE_SOURCE=auto). ``local``/``both`` =
rollback immédiat vers le comportement historique. Erreur → fail-safe
(grâce locale conservée).
"""
from __future__ import annotations

import pytest

from llm_core._scheduling._concurrency import LLMConcurrencyManager
from llm_core._scheduling import _locks as locks_mod


@pytest.fixture()
def mgr():
    return LLMConcurrencyManager(max_models=1, max_conversations_per_model=2)


def _set_distributed(monkeypatch, value: bool):
    monkeypatch.setattr(locks_mod.MODEL_EXCLUSIVITY, "is_distributed",
                        lambda: value)


def test_auto_skips_local_grace_when_distributed(mgr, monkeypatch):
    monkeypatch.setenv("LLM_GRACE_SOURCE", "auto")
    _set_distributed(monkeypatch, True)
    assert mgr._local_grace_enabled() is False


def test_auto_keeps_local_grace_without_redis(mgr, monkeypatch):
    monkeypatch.setenv("LLM_GRACE_SOURCE", "auto")
    _set_distributed(monkeypatch, False)
    assert mgr._local_grace_enabled() is True


def test_local_and_both_force_historic_behavior(mgr, monkeypatch):
    _set_distributed(monkeypatch, True)   # même distribué…
    for mode in ("local", "both"):
        monkeypatch.setenv("LLM_GRACE_SOURCE", mode)
        assert mgr._local_grace_enabled() is True


def test_fail_safe_on_exception(mgr, monkeypatch):
    monkeypatch.setenv("LLM_GRACE_SOURCE", "auto")
    monkeypatch.setattr(locks_mod.MODEL_EXCLUSIVITY, "is_distributed",
                        lambda: (_ for _ in ()).throw(RuntimeError("boom")))
    assert mgr._local_grace_enabled() is True


def test_unknown_mode_defaults_to_historic(mgr, monkeypatch):
    monkeypatch.setenv("LLM_GRACE_SOURCE", "n-importe-quoi")
    assert mgr._local_grace_enabled() is True


def test_is_distributed_reflects_fallback_state():
    """is_distributed() : False par défaut (pas de client Redis connecté)."""
    lock = locks_mod.DistributedModelExclusivityLock()
    assert lock.is_distributed() is False
    # AUDIT 2026-08-23 — ``_fallback_active`` est désormais une PROPRIÉTÉ
    # DATÉE : on bascule par ``_enter_fallback()``, et le repli expire.
    lock._enter_fallback()
    assert lock._fallback_active is True
    assert lock.is_distributed() is False


def test_le_repli_local_est_reversible():
    """Une seule erreur EVAL faisait basculer le worker en verrou local
    DÉFINITIVEMENT : après un blip Redis d'une seconde, l'abonné se
    rétablissait et croyait veiller pendant que toutes les acquisitions
    passaient en local, en silence, jusqu'au recyclage du process."""
    lock = locks_mod.DistributedModelExclusivityLock()
    lock._enter_fallback()
    assert lock._fallback_active is True
    lock._fallback_until = 0.0            # cooldown écoulé
    assert lock._fallback_active is False, \
        "le repli local est encore définitif"
    # ⚠ Et il faut que la reconnexion soit POSSIBLE : la garde de
    # ``_ensure_redis`` sort d'emblée tant que ``self._redis`` n'est pas None.
    assert lock._redis is None


def test_labsence_de_redis_asyncio_reste_definitive():
    """Celui-là ne se répare pas à chaud : inutile de retenter toutes les
    30 secondes."""
    lock = locks_mod.DistributedModelExclusivityLock()
    lock._enter_fallback(permanent=True)
    lock._fallback_until = 0.0
    assert lock._fallback_active is True


# ── Grâce : un `low` SAME-MODEL n'attend pas (aucun switch requis) ────────────

@pytest.mark.asyncio
async def test_low_same_model_ne_bloque_pas_sur_la_grace(monkeypatch):
    """Régression 2026-07-18 : après qu'un `high` libère m1, un `low` qui veut
    LE MÊME m1 était bloqué toute la fenêtre de grâce (8 s) pour rien — aucun
    switch à empêcher. Il doit passer immédiatement ; un `low` vers un AUTRE
    modèle reste, lui, protégé par la grâce."""
    import time
    import llm_core._model_info as _mi
    monkeypatch.setattr(_mi, "_cached_total_slots", 2)   # court-circuite /props (réseau)
    monkeypatch.setenv("LLM_GRACE_SOURCE", "local")      # force la grâce locale

    mgr = LLMConcurrencyManager(max_models=1, max_conversations_per_model=2)
    mgr.GRACE_S = 1.0

    async with mgr.acquire_for("m1", priority="high"):
        pass                                              # release → grâce sur m1
    assert "m1" in mgr._grace                             # grâce bien posée

    t0 = time.monotonic()
    async with mgr.acquire_for("m1", priority="low"):     # MÊME modèle
        same_wait = time.monotonic() - t0
    assert same_wait < 0.3, f"low same-model a attendu {same_wait:.2f}s (grâce inutile)"


@pytest.mark.asyncio
async def test_low_other_model_reste_protege_par_la_grace(monkeypatch):
    import time
    import llm_core._model_info as _mi
    monkeypatch.setattr(_mi, "_cached_total_slots", 2)
    monkeypatch.setenv("LLM_GRACE_SOURCE", "local")

    mgr = LLMConcurrencyManager(max_models=1, max_conversations_per_model=2)
    mgr.GRACE_S = 0.8

    async with mgr.acquire_for("m1", priority="high"):
        pass
    t0 = time.monotonic()
    async with mgr.acquire_for("m2", priority="low"):     # AUTRE modèle
        other_wait = time.monotonic() - t0
    assert other_wait >= 0.6, f"low other-model n'a pas attendu la grâce ({other_wait:.2f}s)"