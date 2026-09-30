# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_desktop_uia.py — virage UI Automation (action sémantique +
synchronisation OS). ``_agent_req`` / cible monkeypatchés → aucun agent réel.

Couvre : act_core invoke/set_value (forward auto_id, repli coords, pas de
dépendance au cache), resolve par auto_id, launch_core/wait_window_core, et le
rejeu UIA-first (clic auto_id → invoke ; clic auto_id sans coords ne casse pas ;
attente window_ready).
"""
from __future__ import annotations

import pytest

from llm_core import _desktop_replay as dr, _desktop_session as ds
from llm_core.tools import desktop_tools as dt

FAKE_TGT = {"name": "t1", "agent_url": "http://agent", "os": "windows"}


@pytest.fixture
def agent(monkeypatch):
    seen = []
    resp = {"default": {"ok": True}}

    def fake_req(tgt, endpoint, payload=None, method="POST", timeout=None):
        seen.append((endpoint, payload))
        return resp.get(endpoint, resp["default"])

    monkeypatch.setattr(dt, "_resolve_target",
                        lambda target, username="": (FAKE_TGT if target in ("", "t1") else None))
    monkeypatch.setattr(dt, "_agent_req", fake_req)
    monkeypatch.setattr(dt, "_grab", lambda tgt: (b"PNG", 800, 600))
    monkeypatch.setattr(dt, "_save_frame", lambda png, owner="": "tok")
    return {"seen": seen, "resp": resp}


# ── act_core : invoke / set_value ───────────────────────────────────────────
def test_invoke_forwards_auto_id_and_coords(agent):
    res = dt.act_core("u", "t1", op="invoke", auto_id="okBtn", name="OK",
                      control_type="button", x=30, y=20)
    assert res["ok"] is True
    ep, p = agent["seen"][0]
    assert ep == "/invoke"
    assert p["auto_id"] == "okBtn" and p["name"] == "OK" and p["control_type"] == "button"
    assert p["x"] == 30 and p["y"] == 20


def test_invoke_by_auto_id_only_no_cache(agent):
    # auto_id sans coords ET cache vide → on N'échoue PAS (l'agent résout l'id).
    res = dt.act_core("u", "t1", op="invoke", auto_id="okBtn")
    assert res["ok"] is True
    assert agent["seen"][0][0] == "/invoke"
    assert "x" not in agent["seen"][0][1]


def test_invoke_method_passthrough(agent):
    agent["resp"]["/invoke"] = {"ok": True, "method": "invoke"}
    res = dt.act_core("u", "t1", op="invoke", auto_id="okBtn")
    assert res["method"] == "invoke"


def test_invoke_needs_target(agent):
    res = dt.act_core("u", "t1", op="invoke")
    assert res["ok"] is False and res["error"] == "need_target"
    assert agent["seen"] == []


def test_set_value_forwards_text(agent):
    res = dt.act_core("u", "t1", op="set_value", auto_id="f1", text="hello")
    ep, p = agent["seen"][0]
    assert ep == "/set_value" and p["auto_id"] == "f1" and p["text"] == "hello"
    assert res["ok"] is True


def test_set_value_needs_text(agent):
    res = dt.act_core("u", "t1", op="set_value", auto_id="f1")
    assert res["ok"] is False and res["error"] == "need_text"


# ── resolve_element par auto_id ─────────────────────────────────────────────
def test_merge_preserves_depth_and_auto_id():
    # L'arbre UIA (profondeur + identité) doit survivre au merge a11y⊕vision.
    a11y = [
        {"role": "window", "name": "App", "auto_id": "win", "depth": 0, "rect": [0, 0, 200, 80]},
        {"role": "button", "name": "OK", "auto_id": "okBtn", "depth": 1, "rect": [10, 10, 60, 24]},
    ]
    out = dt._merge_elements(a11y, [])
    assert out[0]["depth"] == 0 and out[0]["auto_id"] == "win"
    assert out[1]["depth"] == 1 and out[1]["auto_id"] == "okBtn" and out[1]["role"] == "button"


def test_resolve_element_by_auto_id():
    ds.register_desktop_observation("u", "t1", [
        {"id": "el_1", "label": "Save", "auto_id": "saveBtn", "center": [5, 5]},
        {"id": "el_2", "label": "Cancel", "auto_id": "cancelBtn", "center": [9, 9]},
    ])
    el = ds.resolve_element("u", "t1", auto_id="cancelBtn")
    assert el and el["id"] == "el_2"


# ── launch_core / wait_window_core ──────────────────────────────────────────
def test_launch_core_returns_window(agent):
    agent["resp"]["/launch"] = {"ok": True, "launched": "notepad.exe", "found": True,
                                "title": "Bloc-notes", "interaction_state": "ready"}
    res = dt.launch_core("u", "t1", app="notepad.exe", timeout_ms=5000)
    assert res["ok"] is True and res["found"] is True
    assert res["title"] == "Bloc-notes" and res["interaction_state"] == "ready"
    assert res["frame_token"] == "tok"
    ep, p = agent["seen"][0]
    assert ep == "/launch" and p["target"] == "notepad.exe"


def test_launch_core_needs_app(agent):
    res = dt.launch_core("u", "t1", app="")
    assert res["ok"] is False and res["error"] == "need_app"


def test_wait_window_core_found(agent):
    agent["resp"]["/wait_window"] = {"ok": True, "found": True,
                                     "interaction_state": "ready", "title": "Bloc-notes"}
    res = dt.wait_window_core("u", "t1", title_re="Bloc.*", timeout_ms=3000)
    assert res["ok"] is True and res["found"] is True and res["interaction_state"] == "ready"


def test_wait_window_core_needs_matcher(agent):
    res = dt.wait_window_core("u", "t1")
    assert res["ok"] is False and res["error"] == "need_matcher"


# ── rejeu : UIA-first ───────────────────────────────────────────────────────
@pytest.fixture
def replay_env(monkeypatch):
    state = {"act": []}
    monkeypatch.setattr(dr, "observe_core",
                        lambda u, t="", prompt="", use_vision=True, use_tree=True, max_elements=80, **kw: {"ok": True, "elements": []})
    monkeypatch.setattr(dr, "resolve_element",
                        lambda u, t="", element_id=None, query=None, auto_id=None,
                        near=None, role=None: None)
    monkeypatch.setattr(dr, "grab_core", lambda u, t="": {"ok": True, "sig": "aaaaaaaaaaaaaaaa"})
    monkeypatch.setattr(dr, "read_text_core", lambda u, t="", *a, **k: {"ok": True, "text": ""})
    monkeypatch.setattr(dr, "_now_ms", lambda: 0)
    monkeypatch.setattr(dr, "_sleep_ms", lambda ms: None)

    def fake_act(u, t="", **kw):
        state["act"].append(kw)
        return {"ok": True, "op": kw.get("op"), "frame_token": "f"}
    monkeypatch.setattr(dr, "act_core", fake_act)
    return state


def test_replay_auto_id_click_uses_invoke(replay_env):
    steps = [{"op": "click", "anchor": {"auto_id": "okBtn", "label": "OK", "role": "button"},
              "args": {}, "expect": {"kind": "none"}}]
    out = dr.replay_scenario(steps, "u", "t1")
    assert out["passed"] == 1
    kw = replay_env["act"][0]
    assert kw["op"] == "invoke" and kw["auto_id"] == "okBtn"
    assert kw["name"] == "OK" and kw["control_type"] == "button"


def test_replay_auto_id_click_proceeds_without_coords(replay_env):
    # resolve_element → None (coords introuvables) : un clic auto_id NE DOIT PAS
    # échouer — l'agent invoque par id.
    steps = [{"op": "click", "anchor": {"auto_id": "okBtn", "label": "Ghost"},
              "args": {}, "expect": {"kind": "none"}}]
    out = dr.replay_scenario(steps, "u", "t1")
    assert out["passed"] == 1 and out["failed"] == 0
    assert replay_env["act"][0]["op"] == "invoke"


def test_replay_double_click_auto_id_sets_clicks(replay_env):
    steps = [{"op": "double_click", "anchor": {"auto_id": "fileItem", "label": "rapport.txt"},
              "args": {}, "expect": {"kind": "none"}}]
    dr.replay_scenario(steps, "u", "t1")
    assert replay_env["act"][0]["op"] == "invoke" and replay_env["act"][0]["clicks"] == 2


def test_replay_launch_step(replay_env, monkeypatch):
    launched = {}
    monkeypatch.setattr(dr, "launch_core",
                        lambda u, t="", app="", timeout_ms=15000: (launched.update(app=app) or {"ok": True, "found": True, "frame_token": "f"}))
    steps = [{"op": "launch", "anchor": {}, "args": {"app": "notepad.exe"},
              "expect": {"kind": "none"}}]
    out = dr.replay_scenario(steps, "u", "t1")
    assert out["passed"] == 1 and launched["app"] == "notepad.exe"


def test_replay_window_ready_expectation(replay_env, monkeypatch):
    monkeypatch.setattr(dr, "wait_window_core",
                        lambda u, t="", **kw: {"ok": True, "found": True, "interaction_state": "ready"})
    steps = [{"op": "double_click", "anchor": {"x": 5, "y": 5}, "args": {},
              "expect": {"kind": "window_ready", "query": "Bloc-notes"}, "timeout_ms": 60000}]
    out = dr.replay_scenario(steps, "u", "t1")
    assert out["passed"] == 1
    assert out["results"][0]["expect"].startswith("window_ready")
