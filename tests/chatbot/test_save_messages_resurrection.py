# SPDX-License-Identifier: MIT
"""Une conversation supprimée ne doit pas revenir.

``PUT /api/saved/chats/{id}/save-messages`` ne sert qu'aux sauvegardes
PARTIELLES du streaming en arrière-plan. Le front crée toujours le chat côté
serveur avant de streamer (``POST /api/saved/chats/new``, app-chat.js) — ce
endpoint n'a donc jamais à en créer un. Il passait pourtant par ``upsert_chat``,
qui insère quand la ligne manque.

Conséquence, reproduite en séquentiel strict (donc même sans course) :

    DELETE /api/saved/chats/{id}   → 200
    GET    /api/saved/chats/{id}   → 404
    PUT    …/save-messages         → 200
    GET    /api/saved/chats/{id}   → 200   ← la conversation est revenue

Le déclencheur réel : l'utilisateur supprime une conversation pendant qu'une
génération tourne encore en arrière-plan. La sauvegarde partielle suivante la
recrée, et elle réapparaît dans la liste.
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    legacy.reset_pool()
    from shared_infra.db._connection import init_db
    init_db()
    from shared_infra.accounts.users import create_user
    assert create_user("alice", "pw-alice-12") == 1
    assert create_user("bob", "pw-bob-1234") == 2

    import chatbot_app.routes.saved_chats as saved_mod

    def _fake_uid(request: Request):
        uid = request.headers.get("x-test-user")
        if not uid:
            raise HTTPException(401, "auth requise")
        return int(uid)

    monkeypatch.setattr(saved_mod, "require_user_id", _fake_uid)

    app = FastAPI()
    from shared_infra.routes._state import router
    app.include_router(router)
    with TestClient(app) as c:
        yield c
    legacy.reset_pool()


ALICE = {"x-test-user": "1"}
BOB = {"x-test-user": "2"}
UN_MESSAGE = {"messages": [{"role": "user", "content": "bonjour"}], "title": "mon chat"}


def _nouveau(client) -> str:
    r = client.post("/api/saved/chats/new", headers=ALICE)
    assert r.status_code == 200
    return r.json()["id"]


# ── Le bug ──────────────────────────────────────────────────────────────────

def test_une_sauvegarde_tardive_ne_ressuscite_pas_le_chat(client):
    cid = _nouveau(client)
    assert client.put(f"/api/saved/chats/{cid}/save-messages",
                      headers=ALICE, json=UN_MESSAGE).status_code == 200
    assert client.delete(f"/api/saved/chats/{cid}", headers=ALICE).status_code == 200
    assert client.get(f"/api/saved/chats/{cid}", headers=ALICE).status_code == 404

    tardive = client.put(f"/api/saved/chats/{cid}/save-messages", headers=ALICE,
                         json={"messages": [{"role": "user", "content": "bonjour"},
                                            {"role": "assistant", "content": "suite du flux"}],
                               "title": "mon chat"})
    assert tardive.status_code == 200
    assert tardive.json().get("skipped") == "absent"
    assert client.get(f"/api/saved/chats/{cid}", headers=ALICE).status_code == 404, \
        "la conversation supprimée est revenue"


def test_le_chat_ressuscite_ne_reapparait_pas_dans_la_liste(client):
    cid = _nouveau(client)
    client.delete(f"/api/saved/chats/{cid}", headers=ALICE)
    client.put(f"/api/saved/chats/{cid}/save-messages", headers=ALICE, json=UN_MESSAGE)
    items = client.get("/api/saved/chats", headers=ALICE).json()["items"]
    assert all(c["id"] != cid for c in items)


def test_un_identifiant_jamais_vu_ne_cree_rien(client):
    """Corollaire : ce endpoint ne doit servir à personne pour fabriquer des
    conversations sans passer par la route de création."""
    r = client.put("/api/saved/chats/jamais-vu-du-tout/save-messages",
                   headers=ALICE, json=UN_MESSAGE)
    assert r.status_code == 200 and r.json().get("skipped") == "absent"
    assert client.get("/api/saved/chats/jamais-vu-du-tout",
                      headers=ALICE).status_code == 404


def test_le_chat_d_un_autre_utilisateur_n_est_pas_touche(client):
    """``get_chat`` porte le user_id : pour Bob, le chat d'Alice « n'existe
    pas » — il ne doit ni être écrasé, ni être recréé sous son compte."""
    cid = _nouveau(client)
    client.put(f"/api/saved/chats/{cid}/save-messages", headers=ALICE, json=UN_MESSAGE)

    r = client.put(f"/api/saved/chats/{cid}/save-messages", headers=BOB,
                   json={"messages": [{"role": "user", "content": "intrusion"}],
                         "title": "à moi"})
    assert r.json().get("skipped") == "absent"

    chez_alice = client.get(f"/api/saved/chats/{cid}", headers=ALICE).json()
    assert chez_alice["messages"][0]["content"] == "bonjour"
    assert chez_alice["title"] == "mon chat"
    assert client.get("/api/saved/chats", headers=BOB).json()["items"] == []


# ── Ce qui doit continuer de marcher ────────────────────────────────────────

def test_la_sauvegarde_partielle_normale_fonctionne_toujours(client):
    cid = _nouveau(client)
    r = client.put(f"/api/saved/chats/{cid}/save-messages", headers=ALICE,
                   json={"messages": [{"role": "user", "content": "salut"}],
                         "title": "un titre"})
    assert r.status_code == 200 and "skipped" not in r.json()
    chat = client.get(f"/api/saved/chats/{cid}", headers=ALICE).json()
    assert chat["title"] == "un titre"
    assert chat["messages"][0]["content"] == "salut"


def test_le_contenu_continue_de_croitre(client):
    cid = _nouveau(client)
    for n in (1, 2, 3):
        msgs = [{"role": "user", "content": f"message {i}"} for i in range(n)]
        client.put(f"/api/saved/chats/{cid}/save-messages", headers=ALICE,
                   json={"messages": msgs, "title": "t"})
    chat = client.get(f"/api/saved/chats/{cid}", headers=ALICE).json()
    assert len([m for m in chat["messages"] if m.get("role") == "user"]) == 3


def test_la_garde_anti_stale_est_toujours_active(client):
    """Elle protégeait déjà d'un partiel périmé qui écraserait la version
    complète — ce correctif ne doit pas l'avoir court-circuitée."""
    cid = _nouveau(client)
    client.put(f"/api/saved/chats/{cid}/save-messages", headers=ALICE,
               json={"messages": [{"role": "user", "content": "x" * 500}], "title": "t"})
    r = client.put(f"/api/saved/chats/{cid}/save-messages", headers=ALICE,
                   json={"messages": [{"role": "user", "content": "court"}], "title": "t"})
    assert r.json().get("skipped") == "stale"
    chat = client.get(f"/api/saved/chats/{cid}", headers=ALICE).json()
    assert len(chat["messages"][0]["content"]) == 500


def test_le_titre_est_repris_du_stocke_quand_il_manque(client):
    cid = _nouveau(client)
    client.put(f"/api/saved/chats/{cid}/save-messages", headers=ALICE,
               json={"messages": [{"role": "user", "content": "a"}], "title": "titre gardé"})
    client.put(f"/api/saved/chats/{cid}/save-messages", headers=ALICE,
               json={"messages": [{"role": "user", "content": "a"},
                                  {"role": "assistant", "content": "b"}]})
    assert client.get(f"/api/saved/chats/{cid}",
                      headers=ALICE).json()["title"] == "titre gardé"
