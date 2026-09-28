# SPDX-License-Identifier: MIT
"""tests/llm_core/test_llm_retry_and_status.py — P0 audit harness (fiches 5/14).

Couvre les deux briques introduites le 2026-07-24 :
- ``_harness_status_line`` : jalons de budget communiqués au modèle (50 %,
  75 %, 5 dernières itérations, wall-clock) — append-only, hors jalon = None ;
- ``llm_core._llm_retry`` : classification fatal/transitoire (4xx hors
  408/429), backoff full-jitter borné, attente « modèle en chargement »
  via sonde /health injectable, pause cancel-aware.
"""
from __future__ import annotations

import httpx
import pytest

from llm_core._chat_with_tools import _harness_status_line
from llm_core._llm_retry import (
    backoff_delay,
    llm_error_is_fatal,
    llm_error_is_loading,
    retry_pause,
    wait_llama_ready,
)


def _http_error(code: int) -> httpx.HTTPStatusError:
    req = httpx.Request("POST", "http://llm.test/v1/chat/completions")
    resp = httpx.Response(code, request=req)
    return httpx.HTTPStatusError(f"HTTP {code}", request=req, response=resp)


# ── _harness_status_line : jalons ────────────────────────────────────────────

def test_status_hors_jalon_silencieux():
    # Milieu de course loin des jalons → aucun bruit injecté.
    for k in (1, 5, 10, 24, 26, 37, 39, 44):
        assert _harness_status_line(k, 50) is None


def test_status_jalons_50_et_75_pct():
    mid = _harness_status_line(25, 50)
    assert mid is not None and "25/50" in mid and mid.startswith("<harness_status>")
    three_q = _harness_status_line(38, 50)   # (3*50+3)//4 = 38
    assert three_q is not None and "38/50" in three_q


def test_status_dernieres_iterations_et_finale():
    for k in (45, 46, 47, 48):
        line = _harness_status_line(k, 50)
        assert line is not None and "Wrap up" in line
    last = _harness_status_line(49, 50)
    assert last is not None and "LAST iteration" in last
    # k >= n : la sortie de boucle + synthèse forcée prennent le relais.
    assert _harness_status_line(50, 50) is None
    assert _harness_status_line(51, 50) is None


def test_status_bornes_et_petits_budgets():
    assert _harness_status_line(0, 50) is None
    assert _harness_status_line(1, 0) is None
    assert _harness_status_line(1, 1) is None          # budget 1 : rien à annoncer
    line = _harness_status_line(1, 2)                  # budget 2 : k=1 = dernière
    assert line is not None and "LAST" in line


def test_status_wall_clock_ajoute_minutes():
    line = _harness_status_line(25, 50, wall_left_s=125.0)
    assert line is not None and "~2 min" in line
    # Deadline dépassée entre deux checks : clampé à 0, jamais négatif.
    line = _harness_status_line(25, 50, wall_left_s=-30.0)
    assert line is not None and "~0 min" in line


# ── _llm_retry : classification ──────────────────────────────────────────────

def test_fatal_4xx_sauf_408_429():
    for code in (400, 401, 403, 404, 413, 422):
        assert llm_error_is_fatal(_http_error(code)) is True
    for code in (408, 429, 500, 502, 503):
        assert llm_error_is_fatal(_http_error(code)) is False
    assert llm_error_is_fatal(httpx.ConnectError("refused")) is False
    assert llm_error_is_fatal(RuntimeError("x")) is False
    assert llm_error_is_fatal(None) is False


def test_loading_503_seulement():
    assert llm_error_is_loading(_http_error(503)) is True
    assert llm_error_is_loading(_http_error(500)) is False
    assert llm_error_is_loading(httpx.ConnectError("refused")) is False


# ── _llm_retry : backoff full-jitter ─────────────────────────────────────────

def test_backoff_bornes_full_jitter():
    for attempt in range(6):
        plafond = min(15.0, 1.0 * (2 ** attempt))
        for _ in range(50):
            d = backoff_delay(attempt, base=1.0, cap=15.0)
            assert 0.0 <= d <= plafond
    # Grand attempt : toujours plafonné par le cap.
    assert all(backoff_delay(12, base=1.0, cap=15.0) <= 15.0 for _ in range(50))


# ── _llm_retry : sonde /health injectable ────────────────────────────────────

async def test_wait_ready_apres_chargement():
    seq = [503, None, 503, 200]

    async def probe():
        return seq.pop(0) if seq else 200

    assert await wait_llama_ready(5.0, probe=probe, poll_s=0.01) is True
    assert seq == []   # la sonde a bien été consommée jusqu'au 200


async def test_wait_ready_echeance_depassee():
    async def probe():
        return 503

    assert await wait_llama_ready(0.05, probe=probe, poll_s=0.01) is False


async def test_wait_ready_annulation_leve_cancelled():
    # Même sémantique que l'ex-_cancel_aware_sleep du chemin classic : un stop
    # utilisateur pendant l'attente LÈVE (aucune tentative supplémentaire).
    import asyncio

    async def probe():
        return 503

    with pytest.raises(asyncio.CancelledError):
        await wait_llama_ready(
            30.0, probe=probe, poll_s=0.01, is_cancelled=lambda: True)


# ── _llm_retry : retry_pause branche selon l'erreur ──────────────────────────

async def test_retry_pause_503_local_attend_health(monkeypatch):
    waited = {}

    async def fake_wait(max_wait_s=None, *, is_cancelled=None, probe=None, poll_s=2.0):
        waited["called"] = True
        return True

    monkeypatch.setattr("llm_core._llm_retry.wait_llama_ready", fake_wait)
    await retry_pause(_http_error(503), 0)
    assert waited.get("called") is True


async def test_retry_pause_transitoire_backoff_court(monkeypatch):
    # Erreur transport ≠ loading, et AUCUN appel LLM abouti dans ce processus
    # → serveur jamais démarré : échec rapide, backoff seul, pas de sonde.
    from llm_core._llm_retry import forget_llm_success
    forget_llm_success()

    async def fake_wait(*a, **k):            # ne doit PAS être appelée
        raise AssertionError("wait_llama_ready ne doit pas être sondée")

    monkeypatch.setattr("llm_core._llm_retry.wait_llama_ready", fake_wait)
    monkeypatch.setattr("llm_core._llm_retry.backoff_delay", lambda *a, **k: 0.0)
    await retry_pause(httpx.ConnectError("refused"), 2)


async def test_retry_pause_injoignable_apres_succes_attend_health(monkeypatch):
    """AUDIT long-run 2026-08-21 — un moteur qui a DÉJÀ répondu puis devient
    injoignable est un REDÉMARRAGE (swap de modèle, systemd, relance après
    OOM), pas un serveur absent : on sonde /health au lieu de brûler les
    ~45 s de backoff et de tuer une mission de plusieurs heures."""
    from llm_core._llm_retry import note_llm_success, forget_llm_success
    waited = {}

    async def fake_wait(max_wait_s=None, *, is_cancelled=None, probe=None, poll_s=2.0):
        waited["called"] = True
        return True

    monkeypatch.setattr("llm_core._llm_retry.wait_llama_ready", fake_wait)
    monkeypatch.setattr("llm_core._llm_retry.backoff_delay", lambda *a, **k: 0.0)
    try:
        note_llm_success()
        await retry_pause(httpx.ConnectError("refused"), 2)
        assert waited.get("called") is True
    finally:
        forget_llm_success()
