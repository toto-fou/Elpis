# SPDX-License-Identifier: MIT
"""tests/llm_core/test_desktop_live_sync.py — portage des attentes du rejeu vers
les outils MCP live : ``desktop_wait`` (wait_core → check_expect) et le *settle*
intelligent de ``desktop_act`` (act_core → wait_stable). check_expect/wait_stable
sont monkeypatchés → on vérifie le CÂBLAGE (mapping kind→expect, settle borné).
"""
from __future__ import annotations

import pytest

from llm_core import _desktop_replay as dr
from llm_core.tools import desktop_tools as dt

TGT = {"name": "t1", "agent_url": "http://agent", "os": "linux"}


@pytest.fixture
def stub(monkeypatch):
    monkeypatch.setattr(dt, "_resolve_target",
                        lambda target, username="": (TGT if target in ("", "t1") else None))
    monkeypatch.setattr(dt, "_grab", lambda tgt: (b"PNG", 800, 600))
    monkeypatch.setattr(dt, "_save_frame", lambda png, owner="": "tok")
    monkeypatch.setattr(dt, "_frame_sig", lambda png: "sig")


# ── wait_core : mapping kind → expect + délégation à check_expect ────────────
def test_wait_core_element_builds_expect(stub, monkeypatch):
    seen = {}

    def fake_check(username, target, expect, timeout_ms, baseline=None):
        seen["expect"] = expect
        seen["timeout"] = timeout_ms
        return (True, 123, "element «Save»")
    monkeypatch.setattr(dr, "check_expect", fake_check)
    res = dt.wait_core("u", "t1", kind="element", query="Save", timeout_ms=5000)
    assert res["ok"] is True and res["satisfied"] is True and res["waited_ms"] == 123
    assert seen["expect"]["kind"] == "element" and seen["expect"]["query"] == "Save"
    assert seen["timeout"] == 5000
    assert res["frame_token"] == "tok"


def test_wait_core_value_maps_expected(stub, monkeypatch):
    seen = {}

    def fake_check(u, t, e, to, baseline=None):
        seen["e"] = e
        return (True, 1, "value")
    monkeypatch.setattr(dr, "check_expect", fake_check)
    dt.wait_core("u", "t1", kind="value", query="Total", value="42", match=True)
    assert seen["e"]["kind"] == "value" and seen["e"]["query"] == "Total"
    assert seen["e"]["expected"] == "42" and seen["e"]["match"] is True


def test_wait_core_text_maps_to_query(stub, monkeypatch):
    seen = {}
    monkeypatch.setattr(dr, "check_expect",
                        lambda u, t, e, to, baseline=None: (seen.update(e=e), (False, 9, "text_gone"))[1])
    dt.wait_core("u", "t1", kind="text_gone", text="Loading")
    assert seen["e"]["kind"] == "text_gone" and seen["e"]["query"] == "Loading"


def test_wait_core_window_ready_maps_anchor(stub, monkeypatch):
    seen = {}
    monkeypatch.setattr(dr, "check_expect",
                        lambda u, t, e, to, baseline=None: (seen.update(e=e), (True, 1, "wr"))[1])
    dt.wait_core("u", "t1", kind="window_ready", title_re="Notepad", auto_id="aid")
    assert seen["e"]["kind"] == "window_ready" and seen["e"]["query"] == "Notepad"
    assert seen["e"]["anchor"]["auto_id"] == "aid"


def test_wait_core_count_maps_op(stub, monkeypatch):
    seen = {}
    monkeypatch.setattr(dr, "check_expect",
                        lambda u, t, e, to, baseline=None: (seen.update(e=e), (True, 1, "count"))[1])
    dt.wait_core("u", "t1", kind="count", query="row", role="row", op=">=", count=3)
    assert seen["e"]["op"] == ">=" and seen["e"]["count"] == 3 and seen["e"]["role"] == "row"


def test_wait_core_no_target(monkeypatch, stub):
    monkeypatch.setattr(dt, "_resolve_target", lambda target, username="": None)
    res = dt.wait_core("u", "nope", kind="stable")
    assert res["ok"] is False and res["error"] == "no_target"


# ── act_core : settle intelligent post-action ────────────────────────────────
@pytest.fixture
def act_stub(monkeypatch):
    monkeypatch.setattr(dt, "_resolve_target", lambda target, username="": TGT)
    monkeypatch.setattr(dt, "_agent_req",
                        lambda tgt, ep, payload=None, method="POST", timeout=None: {"ok": True})
    monkeypatch.setattr(dt, "_grab", lambda tgt: (b"PNG", 1, 1))
    monkeypatch.setattr(dt, "_save_frame", lambda png, owner="": "tok")
    monkeypatch.setattr(dt, "_frame_sig", lambda png: "sig")


def test_act_settle_invokes_wait_stable(act_stub, monkeypatch):
    called = {}

    def fake_stable(u, t, *, timeout_ms, quiet_ms=None, poll_ms=None):
        called["ms"] = timeout_ms
        called["quiet"] = quiet_ms
        called["poll"] = poll_ms
        return 250
    monkeypatch.setattr(dr, "wait_stable", fake_stable)
    res = dt.act_core("u", "t1", op="click", x=5, y=5, settle_ms=1500)
    assert res["ok"] is True
    assert called["ms"] == 1500          # budget de settle transmis
    # P5 — quiet/poll adaptatifs (config) passés à wait_stable (chemin chat).
    assert called["quiet"] is not None and called["poll"] is not None
    assert res["settle_ms"] == 250       # durée réellement attendue remontée


def test_act_no_settle_by_default(act_stub, monkeypatch):
    def boom(*a, **k):
        raise AssertionError("wait_stable ne doit PAS être appelé quand settle_ms=0")
    monkeypatch.setattr(dr, "wait_stable", boom)
    res = dt.act_core("u", "t1", op="click", x=5, y=5)   # settle_ms défaut = 0
    assert res["ok"] is True and "settle_ms" not in res


def test_act_settle_skipped_for_copy(act_stub, monkeypatch):
    def boom(*a, **k):
        raise AssertionError("pas de settle pour copy (ne change pas l'UI)")
    monkeypatch.setattr(dr, "wait_stable", boom)
    res = dt.act_core("u", "t1", op="copy", settle_ms=1000)
    assert res["ok"] is True
