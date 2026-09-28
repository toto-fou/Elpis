# SPDX-License-Identifier: MIT
"""tests/chatbot/test_plan_mode_route.py — PUT /api/saved/chats/{id}/plan-mode.

Route de bascule du mode LECTURE SEULE (commande « /plan » du composeur).
Contrat : booléen strict (422 sinon), 404 sur un chat qui n'est pas le sien,
écriture dans ``meta_json`` sans toucher aux autres réglages par-chat.

Auth simulée en patchant ``require_user_id`` (pattern test_prompts_route.py).
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
    assert create_user("bob", "pw-bob") == 2

    from shared_infra.chat.store import upsert_chat
    upsert_chat(1, "c-alice", "T", [{"role": "user", "content": "x"}], 10.0)

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
_URL = "/api/saved/chats/c-alice/plan-mode"


def test_activation_puis_lecture(client):
    r = client.put(_URL, json={"plan_mode": True}, headers=_H)
    assert r.status_code == 200
    assert r.json() == {"ok": True, "plan_mode": True}

    from shared_infra.chat.store import get_chat_plan_mode
    assert get_chat_plan_mode(1, "c-alice") is True


def test_desactivation(client):
    client.put(_URL, json={"plan_mode": True}, headers=_H)
    r = client.put(_URL, json={"plan_mode": False}, headers=_H)
    assert r.status_code == 200
    from shared_infra.chat.store import get_chat_plan_mode
    assert get_chat_plan_mode(1, "c-alice") is False


@pytest.mark.parametrize("corps", [
    {"plan_mode": "on"},        # la chaîne « on » du composeur est traduite CÔTÉ FRONT
    {"plan_mode": 1},           # 1 n'est pas True : on ne devine pas
    {"plan_mode": None},
    {},                          # champ absent
])
def test_corps_invalide_422(client, corps):
    assert client.put(_URL, json=corps, headers=_H).status_code == 422


def test_chat_inconnu_404(client):
    r = client.put("/api/saved/chats/nexiste-pas/plan-mode",
                   json={"plan_mode": True}, headers=_H)
    assert r.status_code == 404


def test_chat_dun_autre_utilisateur_404(client):
    """Le mode est un réglage par-chat : bob ne bascule pas le chat d'alice."""
    r = client.put(_URL, json={"plan_mode": True},
                   headers={"x-test-user": "2"})
    assert r.status_code == 404
    from shared_infra.chat.store import get_chat_plan_mode
    assert get_chat_plan_mode(1, "c-alice") is False


def test_sans_auth_401(client):
    assert client.put(_URL, json={"plan_mode": True}).status_code == 401


def test_ne_detruit_pas_les_categories_doutils(client):
    """Deux réglages par-chat vivent dans le même meta_json : la bascule ne
    doit pas emporter les toggles du panneau Outils."""
    from shared_infra.chat.store import get_chat, set_chat_tools
    set_chat_tools(1, "c-alice", ["fs", "git"])
    client.put(_URL, json={"plan_mode": True}, headers=_H)
    chat = get_chat(1, "c-alice")
    assert chat["tools"] == ["fs", "git"]
    assert chat["plan_mode"] is True


def test_pas_de_remontee_dans_la_sidebar(client):
    """Basculer un mode n'est pas un tour de conversation : ``updated_at``
    ne bouge pas, sinon le chat remonte en tête de liste pour rien."""
    from shared_infra.chat.store import get_chat
    avant = get_chat(1, "c-alice")["updated_at"]
    client.put(_URL, json={"plan_mode": True}, headers=_H)
    assert get_chat(1, "c-alice")["updated_at"] == avant
