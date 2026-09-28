# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_desktop_act_core.py — couvre ``act_core`` (Phase 1 :
chemin d'action partagé entre le tool ``desktop_act``, l'endpoint
``POST /api/desktop/act`` et le rejeu de scénarios).

Le control-agent (``_agent_req``) et la cible (``_resolve_target``) sont
monkeypatchés → aucun réseau, aucune machine cible requise.
"""
from __future__ import annotations

import pytest

from llm_core.tools import desktop_tools as dt
from llm_core import _desktop_session as ds

FAKE_TGT = {"name": "t1", "agent_url": "http://agent", "os": "linux"}


@pytest.fixture
def calls(monkeypatch):
    """Capture les appels au control-agent ; stubs déterministes."""
    seen = []

    def fake_agent_req(tgt, endpoint, payload=None, method="POST", timeout=None):
        seen.append((endpoint, payload))
        return {"ok": True}

    monkeypatch.setattr(dt, "_resolve_target",
                        lambda target, username="": (FAKE_TGT if target in ("", "t1") else None))
    monkeypatch.setattr(dt, "_agent_req", fake_agent_req)
    monkeypatch.setattr(dt, "_grab", lambda tgt: (b"PNG", 1920, 1080))
    monkeypatch.setattr(dt, "_save_frame", lambda png, owner="": "tok_abc")
    return seen


def test_probe_tree_core_reads_tree_without_screenshot(monkeypatch):
    """P1 : probe_tree_core lit /ui_tree et n'appelle JAMAIS _grab (screenshot)."""
    grabbed = {"n": 0}
    reqs = []

    def fake_req(tgt, endpoint, payload=None, method="POST", timeout=None):
        reqs.append(endpoint)
        if endpoint == "/ui_tree":
            return {"ok": True, "width": 1920, "height": 1080, "elements": [
                {"id": "el_1", "label": "OK", "role": "button", "auto_id": "okBtn",
                 "box": [0, 0, 20, 40], "center": [10, 20], "source": "a11y"}]}
        return {"ok": True}

    monkeypatch.setattr(dt, "_resolve_target", lambda target, username="": FAKE_TGT)
    monkeypatch.setattr(dt, "_agent_req", fake_req)
    monkeypatch.setattr(dt, "_grab", lambda tgt: grabbed.__setitem__("n", grabbed["n"] + 1) or (b"P", 1, 1))

    res = dt.probe_tree_core("u", "t1")
    assert res["ok"] is True
    assert res["count"] == 1 and res["elements"][0]["auto_id"] == "okBtn"
    assert res["frame_token"] is None
    assert grabbed["n"] == 0, "aucun screenshot pour une sonde arbre"
    assert reqs == ["/ui_tree"]
    # L'observation est enregistrée → resolve_element la retrouve (comme observe_core).
    assert ds.resolve_element("u", "t1", auto_id="okBtn") is not None


def test_type_no_effect_fires_with_semantic_click(calls, monkeypatch):
    # _frame_sig constant → sig avant == sig après (Hamming 0). Frappe substantielle
    # + semantic_click → la garde T-FX refuse le faux succès.
    monkeypatch.setattr(dt, "_frame_sig", lambda png: "abcdabcdabcdabcd")
    res = dt.act_core("u", "t1", op="type", text="x" * 30, semantic_click=True)
    assert res.get("ok") is False and res["error"] == "type_no_effect"
    # Le frame frais accompagne l'erreur (pour rafraîchir le stage Studio).
    assert res.get("frame_token") == "tok_abc" and res.get("sig")


def test_type_no_effect_silent_without_semantic_click(calls, monkeypatch):
    # Studio direct SANS semantic_click (ancien comportement) : pas de garde.
    monkeypatch.setattr(dt, "_frame_sig", lambda png: "abcdabcdabcdabcd")
    res = dt.act_core("u", "t1", op="type", text="x" * 30, semantic_click=False)
    assert res["ok"] is True and res["op"] == "type"


def test_stale_frame_blocks_coords_act(calls, monkeypatch):
    # R8 — sig courant ÉLOIGNÉ du expect_sig → clic coords refusé (stale_frame).
    monkeypatch.setattr(dt._cfg, "DESKTOP_STALE_FRAME_HAM", 10, raising=False)
    monkeypatch.setattr(dt, "_frame_sig", lambda png: "ffffffffffffffff")  # tout à 1
    res = dt.act_core("u", "t1", op="click", x=10, y=10,
                      expect_sig="0000000000000000")                       # tout à 0 → Hamming 64
    assert res.get("ok") is False and res["error"] == "stale_frame"
    assert res.get("frame_token") == "tok_abc" and res.get("sig")
    assert calls == []                        # aucune action envoyée à l'agent


def test_fresh_frame_allows_coords_act(calls, monkeypatch):
    # sig quasi identique (0 bit d'écart) → l'acte passe normalement.
    monkeypatch.setattr(dt._cfg, "DESKTOP_STALE_FRAME_HAM", 10, raising=False)
    monkeypatch.setattr(dt, "_frame_sig", lambda png: "0000000000000000")
    res = dt.act_core("u", "t1", op="click", x=10, y=10, expect_sig="0000000000000000")
    assert res["ok"] is True and res["op"] == "click"
    assert calls[0][0] == "/click"


def test_expect_sig_ignored_for_element_id(calls, monkeypatch):
    # La garde ne vise QUE resolved_by=="coords" : un clic par element_id (re-résolu)
    # n'est PAS soumis à expect_sig même si l'écran a « changé ».
    monkeypatch.setattr(dt._cfg, "DESKTOP_STALE_FRAME_HAM", 10, raising=False)
    monkeypatch.setattr(dt, "_frame_sig", lambda png: "ffffffffffffffff")
    ds.register_desktop_observation("u", "t1", [
        {"id": "el_1", "label": "Save", "role": "button",
         "center": [10, 20], "box": [0, 0, 20, 40], "source": "a11y"}])
    res = dt.act_core("u", "t1", op="click", element_id="el_1", expect_sig="0000000000000000")
    assert res["ok"] is True and res["op"] == "click"


def test_settle_uses_configured_quiet_poll(calls, monkeypatch):
    # P5 — le settle du chemin chat passe quiet/poll depuis la config (courts) à
    # wait_stable, pas les constantes (longues) du rejeu.
    monkeypatch.setattr(dt._cfg, "DESKTOP_ACT_SETTLE_QUIET_MS", 111, raising=False)
    monkeypatch.setattr(dt._cfg, "DESKTOP_ACT_SETTLE_POLL_MS", 77, raising=False)
    seen = {}
    import llm_core._desktop_replay as dr

    def fake_wait_stable(username, target, *, timeout_ms, quiet_ms=None, poll_ms=None):
        seen.update(timeout_ms=timeout_ms, quiet_ms=quiet_ms, poll_ms=poll_ms)
        return 42
    monkeypatch.setattr(dr, "wait_stable", fake_wait_stable)

    res = dt.act_core("u", "t1", op="click", x=1, y=1, settle_ms=1000)
    assert res["ok"] is True and res.get("settle_ms") == 42
    assert seen == {"timeout_ms": 1000, "quiet_ms": 111, "poll_ms": 77}


def test_no_settle_when_settle_ms_zero(calls, monkeypatch):
    # Studio/rejeu : settle_ms=0 (défaut) → wait_stable JAMAIS appelé.
    import llm_core._desktop_replay as dr
    called = {"n": 0}
    monkeypatch.setattr(dr, "wait_stable",
                        lambda *a, **k: called.__setitem__("n", called["n"] + 1) or 0)
    dt.act_core("u", "t1", op="click", x=1, y=1)          # settle_ms défaut 0
    assert called["n"] == 0


def test_click_xy_calls_agent_and_returns_frame(calls):
    res = dt.act_core("u", "t1", op="click", x=600, y=400)
    assert res["ok"] is True
    assert res["op"] == "click"
    assert res["point"] == [600, 400]
    assert res["frame_token"] == "tok_abc"
    assert res["img_w"] == 1920 and res["img_h"] == 1080
    assert calls[0][0] == "/click"
    assert calls[0][1]["x"] == 600 and calls[0][1]["y"] == 400


def test_click_resolves_element_id_from_observation(calls):
    ds.register_desktop_observation("u", "t1", [
        {"id": "el_1", "label": "Save", "role": "button",
         "center": [10, 20], "box": [0, 0, 20, 40], "source": "a11y"},
    ])
    res = dt.act_core("u", "t1", op="click", element_id="el_1")
    assert res["ok"] is True
    assert res["point"] == [10, 20]      # center de l'élément observé


def test_click_unknown_element_errors(calls):
    ds.register_desktop_observation("u", "t1", [])
    res = dt.act_core("u", "t1", op="click", element_id="el_999")
    assert res["ok"] is False
    assert res["error"] == "element_not_found"


def test_type_needs_text(calls):
    res = dt.act_core("u", "t1", op="type")
    assert res["ok"] is False and res["error"] == "need_text"


def test_key_routes_combo(calls):
    res = dt.act_core("u", "t1", op="key", keys="ctrl+s", observe_after=False)
    assert res["ok"] is True
    assert ("/key", {"keys": "ctrl+s"}) in calls
    assert "frame_token" not in res        # observe_after=False → pas de capture


def test_drag_needs_end_point(calls):
    res = dt.act_core("u", "t1", op="drag", x=10, y=10)
    assert res["ok"] is False and res["error"] == "need_drag_end"


def test_bad_op(calls):
    res = dt.act_core("u", "t1", op="frobnicate", x=1, y=1)
    assert res["ok"] is False and res["error"] == "bad_op"


def test_no_target(monkeypatch, calls):
    monkeypatch.setattr(dt, "_resolve_target", lambda target, username="": None)
    res = dt.act_core("u", "nope", op="click", x=1, y=1)
    assert res["ok"] is False and res["error"] == "no_target"


def test_endpoint_is_registered():
    # Smoke : l'endpoint REST existe et est une coroutine.
    import inspect
    from shared_infra.desktop import routes as d
    assert hasattr(d, "api_desktop_act")
    assert inspect.iscoroutinefunction(d.api_desktop_act)


# ── A2 : resolved_by (COMMENT le client a ciblé l'élément) dans le résultat ──

def test_resolved_by_coords(calls):
    res = dt.act_core("u", "t1", op="click", x=5, y=6, observe_after=False)
    assert res["resolved_by"] == "coords"


def test_resolved_by_element_id(calls):
    ds.register_desktop_observation("u", "t1", [
        {"id": "el_1", "label": "Save", "role": "button", "center": [10, 20], "source": "a11y"},
    ])
    res = dt.act_core("u", "t1", op="click", element_id="el_1", observe_after=False)
    assert res["resolved_by"] == "element_id"


def test_resolved_by_substring(calls, monkeypatch):
    monkeypatch.setattr(ds, "_lookup_pinned_anchor", lambda u, t, q: None)
    monkeypatch.setattr(ds, "_learn_anchor", lambda *a, **k: None)
    ds.register_desktop_observation("u", "t1", [
        {"id": "el_1", "label": "Save draft", "role": "button", "center": [10, 20], "source": "a11y"},
    ])
    res = dt.act_core("u", "t1", op="click", query="Save", observe_after=False)
    assert res["resolved_by"] == "substring"


# ── A3 : erreurs d'act_core actionnables (fix + next_action) ─────────────────

def test_need_point_error_has_next_action(calls):
    res = dt.act_core("u", "t1", op="click", observe_after=False)   # aucune cible
    assert res["ok"] is False and res["error"] == "need_point"
    assert res["next_action"] == "desktop_observe()"


def test_semantic_op_agent_error_enriched(calls, monkeypatch):
    # L'agent échoue une op SÉMANTIQUE (pattern absent) → repli actionnable greffé.
    def agent_err(tgt, endpoint, payload=None, method="POST", timeout=None):
        return {"ok": False, "error": "pattern_unsupported", "message": "no TogglePattern"}
    monkeypatch.setattr(dt, "_agent_req", agent_err)
    ds.register_desktop_observation("u", "t1", [
        {"id": "el_1", "label": "Wifi", "role": "checkbox", "auto_id": "wifi",
         "center": [5, 5], "source": "a11y"},
    ])
    res = dt.act_core("u", "t1", op="toggle", element_id="el_1", observe_after=False)
    assert res["ok"] is False
    assert "click" in res["fix"]                       # repli clic suggéré
    assert res["next_action"] == "desktop_observe()"


def test_agent_error_with_fix_not_overwritten(calls, monkeypatch):
    # Si l'agent fournit DÉJÀ un fix, on ne l'écrase pas.
    def agent_err(tgt, endpoint, payload=None, method="POST", timeout=None):
        return {"ok": False, "error": "x", "fix": "déjà fourni"}
    monkeypatch.setattr(dt, "_agent_req", agent_err)
    ds.register_desktop_observation("u", "t1", [
        {"id": "el_1", "label": "Wifi", "role": "checkbox", "auto_id": "wifi",
         "center": [5, 5], "source": "a11y"},
    ])
    res = dt.act_core("u", "t1", op="toggle", element_id="el_1", observe_after=False)
    assert res["fix"] == "déjà fourni"


# ── Variantes de clic : triple / milieu ──────────────────────────────────────

def test_triple_click_sends_three(calls):
    res = dt.act_core("u", "t1", op="triple_click", x=5, y=6, observe_after=False)
    assert res["ok"] is True
    assert calls[0][0] == "/click" and calls[0][1]["clicks"] == 3


def test_middle_click_button(calls):
    dt.act_core("u", "t1", op="middle_click", x=5, y=6, observe_after=False)
    assert calls[0][0] == "/click" and calls[0][1]["button"] == "middle"
