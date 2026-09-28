# SPDX-License-Identifier: MIT
"""Unit tests for the ReadinessCache pure logic (no Docker required)."""
from shared_infra.sandbox.executors._readiness import ReadinessCache


class FakeClock:
    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t

    def advance(self, dt):
        self.t += dt


def _healthy(ttl=10.0, clock=None):
    c = ReadinessCache(ttl_s=ttl, clock=clock or FakeClock())
    c.set_events_healthy(True)
    return c


def test_confirm_requires_events_healthy():
    c = ReadinessCache(ttl_s=10, clock=FakeClock())
    c.record_running("elpis-sb-alice")
    # Stream not proven healthy yet → must NOT confirm (safe fallback).
    assert c.confirmed_running("elpis-sb-alice") is False
    c.set_events_healthy(True)
    assert c.confirmed_running("elpis-sb-alice") is True


def test_ttl_expiry():
    clk = FakeClock()
    c = _healthy(ttl=10, clock=clk)
    c.record_running("x")
    assert c.confirmed_running("x") is True
    clk.advance(9.9)
    assert c.confirmed_running("x") is True
    clk.advance(0.2)  # now 10.1 > ttl
    assert c.confirmed_running("x") is False


def test_stopped_signal_not_confirmed():
    c = _healthy()
    c.record_running("x")
    c.record_stopped("x")
    assert c.confirmed_running("x") is False


def test_unknown_container_not_confirmed():
    assert _healthy().confirmed_running("never-seen") is False


def test_apply_event_transitions():
    c = _healthy()
    c.apply_event("x", "start")
    assert c.confirmed_running("x") is True
    c.apply_event("x", "die")
    assert c.confirmed_running("x") is False
    c.apply_event("x", "unpause")
    assert c.confirmed_running("x") is True
    c.apply_event("x", "kill")
    assert c.confirmed_running("x") is False


def test_apply_event_unknown_action_is_noop():
    c = _healthy()
    c.record_running("x")
    c.apply_event("x", "exec_create")  # not an up/down action
    assert c.confirmed_running("x") is True


def test_invalidate():
    c = _healthy()
    c.record_running("x")
    c.invalidate("x")
    assert c.confirmed_running("x") is False


def test_events_unhealthy_disables_confirmation():
    c = _healthy()
    c.record_running("x")
    assert c.confirmed_running("x") is True
    c.set_events_healthy(False)
    assert c.confirmed_running("x") is False


def test_disabled_via_env(monkeypatch):
    monkeypatch.setenv("SANDBOX_READINESS_CACHE", "0")
    c = _healthy()
    c.record_running("x")
    assert c.confirmed_running("x") is False


def test_state_stamp_suit_les_evenements_et_la_sante_du_flux():
    """(2026-09-21) Signal consommé par le cache d'IP d'aperçu."""
    from shared_infra.sandbox.executors._readiness import ReadinessCache
    t = [100.0]
    c = ReadinessCache(clock=lambda: t[0])
    c.apply_event("sb", "start")
    assert c.state_stamp("sb") is None            # flux pas (encore) sain
    c.set_events_healthy(True)
    first = c.state_stamp("sb")
    assert first == (True, 100.0)
    t[0] = 101.0
    c.apply_event("sb", "die")
    c.apply_event("sb", "start")
    assert c.state_stamp("sb") != first
