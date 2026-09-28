# SPDX-License-Identifier: MIT
"""
tests/shared_infra/test_desktop_act_route.py — POST /api/desktop/act (R6).

Vérifie que la route Studio directe :
  • active la garde « type sans effet » (semantic_click pour type/paste) ;
  • mappe ``type_no_effect`` en 200 + ``warning`` (la frappe A été émise, le pas
    doit s'enregistrer) au lieu du 400 générique ;
  • conserve le 400 pour les autres erreurs.
``act_core`` est monkeypatché → aucun agent réel.
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient


@pytest.fixture()
def client(monkeypatch):
    # ⚠ Ordre d'import : ``shared_infra.routes`` (chef d'orchestre) AVANT le module
    # de famille, sinon import circulaire desktop.routes → opencode.routes_cli →
    # routes._state → routes/__init__ → routes_code → routes_cli (partiel).
    import shared_infra.routes  # noqa: F401
    import shared_infra.desktop.routes as rt

    def _fake_uid(request: Request):
        uid = request.headers.get("x-test-user")
        if not uid:
            raise HTTPException(401, "auth requise")
        return int(uid)

    monkeypatch.setattr(rt, "require_user_id", _fake_uid)
    monkeypatch.setattr(rt, "_username_for", lambda uid: f"user{uid}")
    monkeypatch.setattr(rt, "register_desktop_frame_owner", lambda *a, **k: None)
    # Sonde d'arbre d'après-action : aucun agent ici → échec propre (boxes vides).
    import llm_core.tools.desktop_tools as dt
    monkeypatch.setattr(dt, "probe_tree_core", lambda *a, **k: {"ok": False, "error": "no_target"})

    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


_H = {"x-test-user": "1"}


def _patch_act(monkeypatch, result):
    import llm_core.tools.desktop_tools as dt
    seen = {}

    def fake_act(username, target, **kw):
        seen.update(kw)
        seen["_username"] = username
        return result
    monkeypatch.setattr(dt, "act_core", fake_act)
    return seen


def test_type_passes_semantic_click(client, monkeypatch):
    seen = _patch_act(monkeypatch, {"ok": True, "op": "type", "frame_token": "t",
                                    "img_w": 10, "img_h": 10, "sig": "aa"})
    r = client.post("/api/desktop/act",
                    json={"target": "vm1", "op": "type", "text": "bonjour tout le monde"}, headers=_H)
    assert r.status_code == 200 and r.json()["ok"] is True
    # semantic_click activé pour la frappe → garde T-FX en vigueur.
    assert seen["semantic_click"] is True


def test_click_does_not_set_semantic_click(client, monkeypatch):
    seen = _patch_act(monkeypatch, {"ok": True, "op": "click"})
    r = client.post("/api/desktop/act", json={"target": "vm1", "op": "click", "x": 1, "y": 2}, headers=_H)
    assert r.status_code == 200
    assert seen["semantic_click"] is False


def test_type_no_effect_maps_to_200_warning(client, monkeypatch):
    _patch_act(monkeypatch, {"ok": False, "error": "type_no_effect",
                             "message": "écran inchangé", "frame_token": "tok",
                             "img_w": 640, "img_h": 360, "sig": "bb"})
    r = client.post("/api/desktop/act",
                    json={"target": "vm1", "op": "type", "text": "x" * 30}, headers=_H)
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True and data["warning"] == "type_no_effect"
    assert "écran inchangé" in data["message"]
    assert data["image_url"].startswith("/api/desktop/frame/tok")
    assert data["sig"] == "bb"


def test_other_error_stays_400(client, monkeypatch):
    _patch_act(monkeypatch, {"ok": False, "error": "element_not_found",
                             "message": "introuvable"})
    r = client.post("/api/desktop/act",
                    json={"target": "vm1", "op": "click", "element_id": "el_9"}, headers=_H)
    assert r.status_code == 400
    assert r.json()["error"] == "element_not_found"


def test_act_requires_op(client, monkeypatch):
    _patch_act(monkeypatch, {"ok": True})
    r = client.post("/api/desktop/act", json={"target": "vm1"}, headers=_H)
    assert r.status_code == 400


# ── Après une action : écran STABILISÉ + arbre a11y renvoyé avec le frame ──
# Avant : capture immédiate (pré-effet) et AUCUNE box dans la réponse → les
# éléments disparaissaient de la scène, l'utilisateur recapturait pour rien.

def _patch_probe(monkeypatch, result):
    import llm_core.tools.desktop_tools as dt
    seen = {}

    def fake_probe(username, target, scope="", max_nodes=0):
        seen.update(username=username, target=target, scope=scope, max_nodes=max_nodes)
        return result
    monkeypatch.setattr(dt, "probe_tree_core", fake_probe)
    return seen


def test_act_settles_then_returns_tree_boxes(client, monkeypatch):
    seen = _patch_act(monkeypatch, {"ok": True, "op": "click", "frame_token": "t2",
                                    "img_w": 640, "img_h": 360, "sig": "cc", "settle_ms": 420})
    probe = _patch_probe(monkeypatch, {"ok": True, "elements": [{"id": "el_1", "label": "OK", "role": "button",
                                                                 "box": [1, 2, 3, 4]}],
                                       "tree_nodes": 1, "tree_capped": False})
    r = client.post("/api/desktop/act", json={"target": "vm1", "op": "click", "x": 1, "y": 2}, headers=_H)
    assert r.status_code == 200
    data = r.json()
    assert seen["settle_ms"] > 0, "l'action attend l'écran stable avant la capture d'après-action"
    assert seen["observe_after"] is True
    assert data["boxes"] and data["boxes"][0]["id"] == "el_1"
    assert data["tree_nodes"] == 1 and data["tree_capped"] is False and data["settle_ms"] == 420
    assert probe["scope"] == "monitor" and probe["max_nodes"] >= 100, "plafond Studio, scope écran"


def test_act_settle_and_scope_overridable(client, monkeypatch):
    seen = _patch_act(monkeypatch, {"ok": True, "op": "click"})
    probe = _patch_probe(monkeypatch, {"ok": True, "elements": []})
    r = client.post("/api/desktop/act", json={"target": "vm1", "op": "click", "x": 1, "y": 2,
                                              "settle_ms": 0, "scope": "focus"}, headers=_H)
    assert r.status_code == 200 and seen["settle_ms"] == 0 and probe["scope"] == "focus"


def test_probe_failure_keeps_frame_with_empty_boxes(client, monkeypatch):
    _patch_act(monkeypatch, {"ok": True, "op": "click", "frame_token": "t3", "img_w": 1, "img_h": 1, "sig": "dd"})
    _patch_probe(monkeypatch, {"ok": False, "error": "agent_unreachable"})
    r = client.post("/api/desktop/act", json={"target": "vm1", "op": "click", "x": 1, "y": 2}, headers=_H)
    data = r.json()
    assert r.status_code == 200 and data["image_url"].startswith("/api/desktop/frame/t3") and data["boxes"] == []


def test_stale_frame_409_also_carries_boxes(client, monkeypatch):
    _patch_act(monkeypatch, {"ok": False, "error": "stale_frame", "frame_token": "t4",
                             "img_w": 1, "img_h": 1, "sig": "ee"})
    _patch_probe(monkeypatch, {"ok": True, "elements": [{"id": "el_2"}]})
    r = client.post("/api/desktop/act", json={"target": "vm1", "op": "click", "x": 1, "y": 2}, headers=_H)
    assert r.status_code == 409 and r.json()["boxes"][0]["id"] == "el_2"


def test_no_probe_when_observe_after_off_or_copy(client, monkeypatch):
    _patch_act(monkeypatch, {"ok": True, "op": "copy", "text": "x"})
    probe = _patch_probe(monkeypatch, {"ok": True, "elements": [{"id": "el_9"}]})
    r = client.post("/api/desktop/act", json={"target": "vm1", "op": "copy"}, headers=_H)
    assert r.status_code == 200 and "boxes" not in r.json() and not probe
    r = client.post("/api/desktop/act", json={"target": "vm1", "op": "click", "x": 1, "y": 1, "observe_after": False}, headers=_H)
    assert r.status_code == 200 and "boxes" not in r.json() and not probe


def test_coordonnees_mal_formees_pas_de_500(client, monkeypatch):
    """Relecture du 14/09 : ``x: "abc"`` ou ``x2: {}`` → absents (erreur métier propre), jamais un 500."""
    seen = _patch_act(monkeypatch, {"ok": True, "op": "click"})
    r = client.post("/api/desktop/act", json={"target": "vm1", "op": "click", "x": "abc", "y": {}, "x2": [1], "y2": "7"}, headers=_H)
    assert r.status_code == 200
    assert seen["x"] is None and seen["y"] is None and seen["x2"] is None and seen["y2"] == 7
    client.post("/api/desktop/act", json={"target": "vm1", "op": "click", "x": "12", "y": 34.0}, headers=_H)
    assert seen["x"] == 12 and seen["y"] == 34
