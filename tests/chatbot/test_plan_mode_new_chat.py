# SPDX-License-Identifier: MIT
"""POST /api/saved/chats/new — lecture seule scellée À LA CRÉATION (2026-08-16).

« /plan » sur un chat VIERGE : le front arme le mode localement, puis le
pré-vol de sendMessage crée le chat en passant ``{"plan_mode": true}`` dans le
corps du POST. Le mode couvre donc le PREMIER tour — sans ça, « préparer un
plan avant d'agir » ne fonctionnait que sur une conversation déjà entamée.

Contrat verrouillé ici :
  - corps ``{"plan_mode": true}``  → chat créé DÉJÀ en lecture seule ;
  - corps ``{"plan_mode": false}`` → chat normal (identique à l'absence) ;
  - SANS corps (appels historiques) → comportement inchangé, mode absent ;
  - ``plan_mode`` non booléen → 422 strict (même contrat que le PUT) ;
  - le scellement ne casse ni le titre ni la présence en base.

Auth simulée en patchant ``require_user_id`` (pattern test_plan_mode_route.py).
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    from shared_infra.db._connection import init_db
    init_db()
    from shared_infra.accounts.users import create_user
    assert create_user("alice", "pw-alice") == 1

    import chatbot_app.routes.saved_chats as sc

    def _fake_uid(request: Request):
        uid = request.headers.get("x-test-user")
        if not uid:
            raise HTTPException(401, "auth requise")
        return int(uid)

    monkeypatch.setattr(sc, "require_user_id", _fake_uid)

    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


_H = {"x-test-user": "1"}
_URL = "/api/saved/chats/new"


def _plan_of(chat_id: str) -> bool:
    from shared_infra.chat.store import get_chat_plan_mode
    return get_chat_plan_mode(1, chat_id)


def test_creation_avec_plan_mode(client):
    r = client.post(_URL, json={"plan_mode": True}, headers=_H)
    assert r.status_code == 200
    cid = r.json()["id"]
    assert _plan_of(cid) is True


def test_creation_plan_mode_false_identique_a_absent(client):
    cid = client.post(_URL, json={"plan_mode": False}, headers=_H).json()["id"]
    assert _plan_of(cid) is False


def test_creation_sans_corps_inchangee(client):
    """Le POST historique (aucun corps) reste strictement identique."""
    r = client.post(_URL, headers=_H)
    assert r.status_code == 200
    cid = r.json()["id"]
    assert _plan_of(cid) is False
    from shared_infra.chat.store import get_chat
    c = get_chat(1, cid)
    assert c is not None and c["title"] == "Nouveau chat"


def test_corps_vide_inchange(client):
    cid = client.post(_URL, json={}, headers=_H).json()["id"]
    assert _plan_of(cid) is False


@pytest.mark.parametrize("val", ["on", 1, None, [True]])
def test_plan_mode_non_booleen_422(client, val):
    """Même contrat strict que le PUT /plan-mode : on ne devine pas — et
    surtout on ne crée PAS de chat sur un corps invalide."""
    from shared_infra.chat.store import list_chats
    avant = len(list_chats(1, archived=0))
    assert client.post(_URL, json={"plan_mode": val}, headers=_H).status_code == 422
    assert len(list_chats(1, archived=0)) == avant


def test_scellement_visible_dans_get_chat(client):
    """Le chemin de restauration du front (loadChat lit ``plan_mode`` du GET)
    doit voir le mode dès la création — c'est lui qui rallume le témoin."""
    cid = client.post(_URL, json={"plan_mode": True}, headers=_H).json()["id"]
    r = client.get(f"/api/saved/chats/{cid}", headers=_H)
    assert r.status_code == 200
    assert r.json().get("plan_mode") is True
