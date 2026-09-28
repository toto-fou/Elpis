# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_chat_tools_route.py — PUT /api/saved/chats/{id}/tools.

Réécriture : l'original (non commité) a été perdu lors du rollback du
2026-07-11 — couverture reconstruite depuis le contrat de la route.

Couvre ``chatbot_app/routes/saved_chats.py::api_saved_set_tools`` :
- 200 + persistance (relue via ``get_chat``), ``[]`` accepté (tout décoché) ;
- 422 : ``tools`` absent / non-liste / liste avec non-str ;
- 404 : chat inconnu, chat d'un autre utilisateur ;
- 401 sans identité.

Auth simulée en patchant ``require_user_id`` (pattern
test_manual_compress_route.py) ; vraie DB temporaire via ``init_db``
(exerce le schéma post-0008 réel).
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

    import chatbot_app.routes.saved_chats as saved_mod

    def _fake_uid(request: Request):
        uid = request.headers.get("x-test-user")
        if not uid:
            raise HTTPException(401, "auth requise")
        return int(uid)

    monkeypatch.setattr(saved_mod, "require_user_id", _fake_uid)

    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    from shared_infra.chat.store import get_chat, upsert_chat
    return TestClient(app), get_chat, upsert_chat


def _alice():
    return {"x-test-user": "1"}


def _bob():
    return {"x-test-user": "2"}


def test_put_tools_persiste(client):
    tc, get_chat, upsert = client
    upsert(1, "c1", "T", [{"role": "user", "content": "x"}], 10.0)
    r = tc.put("/api/saved/chats/c1/tools", headers=_alice(),
               json={"tools": ["fs", "shell"]})
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert get_chat(1, "c1")["tools"] == ["fs", "shell"]


def test_put_tools_liste_vide_valide(client):
    tc, get_chat, upsert = client
    upsert(1, "c1", "T", [], 10.0)
    assert tc.put("/api/saved/chats/c1/tools", headers=_alice(),
                  json={"tools": []}).status_code == 200
    assert get_chat(1, "c1")["tools"] == []      # tout décoché ≠ jamais posé


@pytest.mark.parametrize("body", [
    {},                          # tools absent
    {"tools": "fs"},             # pas une liste
    {"tools": ["fs", 42]},       # non-str dedans
    {"tools": {"fs": True}},     # mauvais type
])
def test_put_tools_422_payload_invalide(client, body):
    tc, _, upsert = client
    upsert(1, "c1", "T", [], 10.0)
    assert tc.put("/api/saved/chats/c1/tools", headers=_alice(),
                  json=body).status_code == 422


def test_put_tools_404_chat_inconnu(client):
    tc, *_ = client
    assert tc.put("/api/saved/chats/nope/tools", headers=_alice(),
                  json={"tools": ["fs"]}).status_code == 404


def test_put_tools_404_chat_autre_user(client):
    tc, get_chat, upsert = client
    upsert(1, "c1", "T", [], 10.0)
    assert tc.put("/api/saved/chats/c1/tools", headers=_bob(),
                  json={"tools": ["fs"]}).status_code == 404
    assert get_chat(1, "c1")["tools"] is None    # rien écrit


def test_put_tools_401_sans_identite(client):
    tc, *_ = client
    assert tc.put("/api/saved/chats/c1/tools",
                  json={"tools": ["fs"]}).status_code == 401
