# SPDX-License-Identifier: MIT
"""tests/llm_core/test_desktop_focus_scope.py — Axe A/C côté hôte.

  • scope d'observation (focus défaut) threadé jusqu'à /ui_tree ;
  • memo a11y SCOPE-AWARE (un arbre focus ne sert pas une requête monitor) ;
  • persist_frame=False (sondes d'attente du rejeu) → aucune écriture disque ;
  • gestion de fenêtres : desktop_windows / desktop_focus (cores).

Aucun réseau : _agent_req / _grab / _save_frame / cible monkeypatchés.
"""
from __future__ import annotations

import pytest

from llm_core.tools import desktop_tools as dt

FAKE_TGT = {"name": "t1", "agent_url": "http://agent", "os": "windows"}
TREE = [{"role": "button", "name": "Save", "auto_id": "btnSave",
         "box": [10, 10, 90, 40], "states": ["enabled"]}]


@pytest.fixture
def env(monkeypatch):
    seen = {"endpoints": [], "saved": 0}

    def fake_agent_req(tgt, endpoint, payload=None, method="POST", timeout=None):
        seen["endpoints"].append((endpoint, payload, method))
        if endpoint == "/ui_tree":
            return {"elements": TREE, "width": 1920, "height": 1080,
                    "scope": (payload or {}).get("scope")}
        if endpoint == "/windows":
            return {"ok": True, "windows": [
                {"hwnd": 13310, "title": "Bloc-notes", "state": "normal", "is_foreground": True},
                {"hwnd": 42, "title": "Paramètres", "state": "minimized", "is_foreground": False},
            ]}
        if endpoint == "/window_action":
            return {"ok": True, "action": (payload or {}).get("action"), "method": "pywinauto"}
        return {"ok": True}

    def fake_save(png, owner=""):
        seen["saved"] += 1
        return "tok"

    monkeypatch.setattr(dt, "_resolve_target", lambda target, username="": FAKE_TGT)
    monkeypatch.setattr(dt, "_agent_req", fake_agent_req)
    monkeypatch.setattr(dt, "_grab", lambda tgt: (b"PNG", 1920, 1080))
    monkeypatch.setattr(dt, "_save_frame", fake_save)
    monkeypatch.setattr(dt._cfg, "VISION_ENDPOINT_URL", "", raising=False)
    monkeypatch.setattr(dt._cfg, "DESKTOP_OBSERVE_SCOPE", "focus", raising=False)
    monkeypatch.setattr(dt, "_A11Y_MEMO_TTL_S", 0.0, raising=False)  # off → assertions déterministes
    dt._A11Y_MEMO.clear()
    return seen


def _ui_tree_payloads(seen):
    return [p for (e, p, m) in seen["endpoints"] if e == "/ui_tree"]


def test_observe_default_scope_is_focus(env):
    dt.observe_core("u", "t1")
    assert _ui_tree_payloads(env)[-1].get("scope") == "focus"


def test_observe_explicit_scope_monitor(env):
    dt.observe_core("u", "t1", scope="monitor")
    assert _ui_tree_payloads(env)[-1].get("scope") == "monitor"


def test_observe_invalid_scope_falls_back_to_focus(env):
    dt.observe_core("u", "t1", scope="bogus")
    assert _ui_tree_payloads(env)[-1].get("scope") == "focus"


def test_persist_frame_false_skips_disk(env):
    dt.observe_core("u", "t1", persist_frame=False)
    assert env["saved"] == 0           # pas d'écriture PNG ni de prune en sonde d'attente
    dt.observe_core("u", "t1", persist_frame=True)
    assert env["saved"] == 1


def test_scope_aware_a11y_memo(env, monkeypatch):
    monkeypatch.setattr(dt, "_A11Y_MEMO_TTL_S", 5.0, raising=False)
    dt._A11Y_MEMO.clear()
    dt.observe_core("u", "t1", scope="focus")
    dt.observe_core("u", "t1", scope="monitor")
    # 2 lectures /ui_tree DISTINCTES : un arbre focus ne doit pas servir un monitor.
    assert len(_ui_tree_payloads(env)) == 2
    assert {"t1::focus", "t1::monitor"} <= set(dt._A11Y_MEMO.keys())


def test_list_windows_core_maps_hwnd_to_id(env):
    r = dt.list_windows_core("u", "t1")
    assert r["ok"] is True and r["count"] == 2
    assert r["windows"][0]["id"] == "13310" and r["windows"][0]["is_foreground"] is True
    assert any(e == "/windows" and m == "GET" for (e, p, m) in env["endpoints"])


def test_window_action_core_invalidates_memo(env):
    dt._A11Y_MEMO["t1::focus"] = {"sig": "x", "elements": [], "ts": 9e9}
    r = dt.window_action_core("u", "t1", action="activate", window_id="13310")
    assert r["ok"] is True and r["action"] == "activate" and r["window_id"] == "13310"
    assert "t1::focus" not in dt._A11Y_MEMO          # agencement changé → memo purgé
    sent = [p for (e, p, m) in env["endpoints"] if e == "/window_action"][-1]
    assert sent["hwnd"] == 13310 and sent["action"] == "activate"


def test_window_action_core_requires_window_id(env):
    assert dt.window_action_core("u", "t1", action="activate", window_id="").get("error") == "bad_window"


def test_act_surfaces_mouse_from_agent_cursor(env, monkeypatch):
    """L'agent joint ``cursor`` à chaque action → act_core l'expose en ``mouse``
    (le modèle sait toujours où est le pointeur, même après un clic)."""
    def fake_req(tgt, endpoint, payload=None, method="POST", timeout=None):
        if endpoint == "/ui_tree":
            return {"elements": TREE, "width": 1920, "height": 1080}
        if endpoint in ("/click", "/element", "/type", "/key", "/move", "/scroll", "/drag"):
            return {"ok": True, "method": "coords", "cursor": [640, 480]}
        return {"ok": True}
    monkeypatch.setattr(dt, "_agent_req", fake_req)
    obs = dt.observe_core("u", "t1", use_vision=False)        # set dims + register elements
    elid = (obs.get("elements") or [{}])[0].get("id")
    r = dt.act_core("u", "t1", op="click", element_id=elid,
                    semantic_click=False, return_elements=False)
    assert r.get("ok") is not False
    assert r.get("mouse") == [640, 480]
