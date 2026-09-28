# SPDX-License-Identifier: MIT
"""Templates de prompt (2026-09-21) — stockage, validation, routes, isolement
par compte. Conception : docs/templates-prompt-design-2026-09-21.md."""
from __future__ import annotations

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_ENCRYPTION_KEY", "cle-de-test")
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    legacy.init_db()
    from shared_infra.accounts.users import create_user
    alice = create_user("alice", "Motdepasse-123")
    bob = create_user("bob", "Motdepasse-123")
    import shared_infra.chat.routes_prompts as rp

    def _fake_uid(request: Request):
        uid = request.headers.get("x-uid")
        if not uid:
            raise HTTPException(401, "auth")
        return int(uid)
    monkeypatch.setattr(rp, "require_user_id", _fake_uid)
    app = FastAPI()
    app.include_router(rp.router)
    return TestClient(app), alice, bob


def _h(uid):
    return {"x-uid": str(uid)}


def test_crud_complet(client):
    tc, alice, _ = client
    r = tc.post("/api/prompt-templates", headers=_h(alice), json={
        "name": "/Resume", "title": "Résumé", "content": "Résume {{texte | textarea}}"})
    assert r.status_code == 200
    item = r.json()["item"]
    assert item["name"] == "resume"                 # « / » et casse normalisés
    lst = tc.get("/api/prompt-templates", headers=_h(alice)).json()["items"]
    assert [t["name"] for t in lst] == ["resume"]
    r = tc.put(f"/api/prompt-templates/{item['id']}", headers=_h(alice), json={
        "name": "resume-court", "title": "", "content": "En 3 lignes : {{texte}}"})
    assert r.status_code == 200 and r.json()["item"]["title"] == "resume-court"
    assert tc.delete(f"/api/prompt-templates/{item['id']}", headers=_h(alice)).status_code == 200
    assert tc.get("/api/prompt-templates", headers=_h(alice)).json()["items"] == []


@pytest.mark.parametrize("name", ["", "a b", "Ã©t", "-debut", "x" * 41, "a/b", "a;rm"])
def test_raccourci_invalide(client, name):
    tc, alice, _ = client
    r = tc.post("/api/prompt-templates", headers=_h(alice),
                json={"name": name, "content": "x"})
    assert r.status_code == 400


def test_contenu_requis_et_borne(client):
    tc, alice, _ = client
    assert tc.post("/api/prompt-templates", headers=_h(alice),
                   json={"name": "a", "content": "   "}).status_code == 400
    assert tc.post("/api/prompt-templates", headers=_h(alice),
                   json={"name": "a", "content": "x" * 20_001}).status_code == 400


def test_nom_unique_par_compte_seulement(client):
    tc, alice, bob = client
    body = {"name": "trad", "content": "Traduis {{texte}}"}
    assert tc.post("/api/prompt-templates", headers=_h(alice), json=body).status_code == 200
    assert tc.post("/api/prompt-templates", headers=_h(alice), json=body).status_code == 409
    assert tc.post("/api/prompt-templates", headers=_h(bob), json=body).status_code == 200


def test_isolement_entre_comptes(client):
    tc, alice, bob = client
    tid = tc.post("/api/prompt-templates", headers=_h(alice),
                  json={"name": "a", "content": "x"}).json()["item"]["id"]
    assert tc.get("/api/prompt-templates", headers=_h(bob)).json()["items"] == []
    assert tc.put(f"/api/prompt-templates/{tid}", headers=_h(bob),
                  json={"name": "b", "content": "y"}).status_code == 404
    assert tc.delete(f"/api/prompt-templates/{tid}", headers=_h(bob)).status_code == 404
    assert len(tc.get("/api/prompt-templates", headers=_h(alice)).json()["items"]) == 1


def test_renommage_vers_un_nom_pris(client):
    tc, alice, _ = client
    tc.post("/api/prompt-templates", headers=_h(alice), json={"name": "a", "content": "x"})
    tid = tc.post("/api/prompt-templates", headers=_h(alice),
                  json={"name": "b", "content": "y"}).json()["item"]["id"]
    assert tc.put(f"/api/prompt-templates/{tid}", headers=_h(alice),
                  json={"name": "a", "content": "y"}).status_code == 409


def test_limite_par_compte(client, monkeypatch):
    tc, alice, _ = client
    import shared_infra.chat.prompt_templates_store as st
    monkeypatch.setattr(st, "PER_USER_MAX", 2)
    for n in ("a", "b"):
        assert tc.post("/api/prompt-templates", headers=_h(alice),
                       json={"name": n, "content": "x"}).status_code == 200
    assert tc.post("/api/prompt-templates", headers=_h(alice),
                   json={"name": "c", "content": "x"}).status_code == 409


def test_templates_supprimes_avec_le_compte(client):
    tc, alice, _ = client
    tc.post("/api/prompt-templates", headers=_h(alice), json={"name": "a", "content": "x"})
    from shared_infra.accounts.users import delete_user_full
    from shared_infra.chat.prompt_templates_store import list_templates
    assert delete_user_full(alice) is True
    assert list_templates(alice) == []
