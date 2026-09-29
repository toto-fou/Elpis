# SPDX-License-Identifier: MIT
"""Un tour ne doit plus être perdu par une écriture sans rapport (AUDIT 2026-09-16).

R1  ``PUT /save-messages`` (sauvegarde partielle du streaming en arrière-plan)
    écrivait sans garde et avançait ``updated_at`` pendant qu'un run tenait le
    chat. La persistance finale du run, sous garde optimiste, tombait alors en
    conflit : réponse jamais sauvée. Le PUT est désormais ignoré tant qu'un run
    tient le chat.

R2  Un renommage pendant la génération avance aussi ``updated_at``. Le conflit
    est BÉNIN (aucun message écrit entre-temps) : ``_persist_turn`` réécrit sur
    la nouvelle base et garde le titre choisi. Un vrai tour concurrent reste
    refusé.
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from shared_infra.runtime import chat_locks


@pytest.fixture()
def base(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    legacy.reset_pool()
    from shared_infra.db._connection import init_db
    init_db()
    from shared_infra.accounts.users import create_user
    assert create_user("alice", "pw-alice-12") == 1
    monkeypatch.setattr(chat_locks, "LOCK_DIR", tmp_path / "locks")
    yield
    legacy.reset_pool()


@pytest.fixture()
def client(base, monkeypatch):
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


ALICE = {"x-test-user": "1"}
DEPART = [{"role": "user", "content": "bonjour"}]
TOUR = DEPART + [{"role": "assistant", "content": "réponse complète du run"}]


# ── R1 ──────────────────────────────────────────────────────────────────────

def test_save_messages_ignore_pendant_un_run(client):
    from shared_infra.chat.store import get_chat, upsert_chat
    upsert_chat(1, "c1", "mon chat", DEPART, 100.0)
    fd = chat_locks.acquire("gen", 1, "c1")
    assert fd is not None
    try:
        r = client.put("/api/saved/chats/c1/save-messages", headers=ALICE,
                       json={"messages": DEPART + [{"role": "assistant", "content": "partiel"}],
                             "title": "mon chat"})
        assert r.status_code == 200
        assert r.json().get("skipped") == "generation_running"
        # Rien n'a bougé : la garde optimiste du run tiendra.
        assert get_chat(1, "c1")["updated_at"] == 100.0
    finally:
        chat_locks.release(fd)


def test_save_messages_ecrit_hors_run(client):
    from shared_infra.chat.store import get_chat, upsert_chat
    upsert_chat(1, "c2", "mon chat", DEPART, 100.0)
    r = client.put("/api/saved/chats/c2/save-messages", headers=ALICE,
                   json={"messages": TOUR, "title": "mon chat"})
    assert r.status_code == 200 and "skipped" not in r.json()
    assert get_chat(1, "c2")["messages"][-1]["content"] == "réponse complète du run"


def test_scenario_complet_le_tour_du_run_est_persiste(client):
    """Séquence réelle : run démarré (baseline lue), PUT partiel du front
    pendant le run, puis persistance finale du run → doit réussir."""
    from chatbot_app.routes.chats import _persist_turn
    from shared_infra.chat.store import get_chat, upsert_chat
    upsert_chat(1, "c3", "mon chat", DEPART, 100.0)
    debut = get_chat(1, "c3")
    fd = chat_locks.acquire("gen", 1, "c3")
    try:
        client.put("/api/saved/chats/c3/save-messages", headers=ALICE,
                   json={"messages": DEPART + [{"role": "assistant", "content": "partiel"}],
                         "title": "mon chat"})
        ret, _ = _persist_turn(upsert_chat, 1, "c3", "mon chat", TOUR,
                               baseline_updated_at=debut["updated_at"],
                               baseline_messages=debut["messages"],
                               baseline_title=debut["title"])
    finally:
        chat_locks.release(fd)
    assert ret is True
    assert get_chat(1, "c3")["messages"] == TOUR


# ── R2 ──────────────────────────────────────────────────────────────────────

def test_renommage_pendant_le_tour_ne_perd_pas_la_reponse(base):
    from chatbot_app.routes.chats import _persist_turn
    from shared_infra.chat.store import get_chat, rename_chat, upsert_chat
    upsert_chat(1, "r1", "ancien titre", DEPART, 100.0)
    debut = get_chat(1, "r1")
    assert rename_chat(1, "r1", "titre choisi")
    ret, titre = _persist_turn(upsert_chat, 1, "r1", "ancien titre", TOUR,
                               baseline_updated_at=debut["updated_at"],
                               baseline_messages=debut["messages"],
                               baseline_title=debut["title"])
    assert ret is True
    fin = get_chat(1, "r1")
    assert fin["messages"] == TOUR
    # Le renommage de l'utilisateur survit à la persistance du tour.
    assert titre == "titre choisi" and fin["title"] == "titre choisi"


def test_vrai_tour_concurrent_reste_refuse(base):
    from chatbot_app.routes.chats import _persist_turn
    from shared_infra.chat.store import get_chat, upsert_chat
    upsert_chat(1, "r2", "chat", DEPART, 100.0)
    debut = get_chat(1, "r2")
    concurrent = DEPART + [{"role": "assistant", "content": "écrit par un autre worker"}]
    upsert_chat(1, "r2", "chat", concurrent, 200.0)
    ret, _ = _persist_turn(upsert_chat, 1, "r2", "chat", TOUR,
                           baseline_updated_at=debut["updated_at"],
                           baseline_messages=debut["messages"],
                           baseline_title=debut["title"])
    assert ret is False
    assert get_chat(1, "r2")["messages"] == concurrent


def test_chat_neuf_sans_baseline_ecrit_directement(base):
    from chatbot_app.routes.chats import _persist_turn
    from shared_infra.chat.store import get_chat, upsert_chat
    ret, titre = _persist_turn(upsert_chat, 1, "n1", "Nouveau", TOUR,
                               baseline_updated_at=None, baseline_messages=None,
                               baseline_title="")
    assert ret is True and titre == "Nouveau"
    assert get_chat(1, "n1")["messages"] == TOUR


def test_session_ephemere_reste_un_no_op(base):
    from chatbot_app.routes.chats import _persist_turn
    ret, _ = _persist_turn(lambda *a, **k: None, 1, "e1", "x", TOUR,
                           baseline_updated_at=5.0, baseline_messages=[],
                           baseline_title="x")
    assert ret is None


# ── Titre posé dès le début d'un run reprenable ─────────────────────────────
def test_titre_pose_au_debut_du_tour_sans_toucher_la_garde(base):
    """Quitter un chat en plein tour le montait « Nouveau chat » dans la barre
    latérale jusqu'à la fin. Le titre est posé au départ, SANS bump
    d'``updated_at`` (la garde optimiste de fin de tour reste valide), et
    jamais par-dessus un titre déjà choisi."""
    import inspect

    import chatbot_app.routes.chats as ch
    from shared_infra.chat.store import get_chat, rename_chat, set_title_if_default, upsert_chat

    upsert_chat(1, "c1", "Nouveau chat", [], 1000.0)
    assert set_title_if_default(1, "c1", "Question LENT un") is True
    c = get_chat(1, "c1")
    assert c["title"] == "Question LENT un" and c["updated_at"] == 1000.0
    assert upsert_chat(1, "c1", "Question LENT un", TOUR, 2000.0,
                       expected_updated_at=1000.0) is not False

    upsert_chat(1, "c2", "Nouveau chat", [], 1000.0)
    assert rename_chat(1, "c2", "Mon titre")
    assert set_title_if_default(1, "c2", "Autre") is False
    assert get_chat(1, "c2")["title"] == "Mon titre"
    assert set_title_if_default(2, "c1", "Intrus") is False

    src = inspect.getsource(ch)
    assert "if _resumable and _title_was_generated and _existing_chat:" in src


# ── B8 : la question est écrite dès le début du tour ────────────────────────
def test_la_question_est_persistee_des_le_debut_du_tour(base):
    """Un worker qui meurt en plein tour emportait la QUESTION elle-même (elle
    n'était écrite qu'avec la réponse). La base du persist final est recalée
    sur cette première écriture, sinon il conflit contre lui-même."""
    import inspect

    import chatbot_app.routes.chats as ch
    from shared_infra.chat.store import get_chat, upsert_chat

    src = inspect.getsource(ch)
    assert "await _persist_question()" in src
    assert "nonlocal _baseline_updated_at, _baseline_messages, _baseline_title" in src
    # Ni tour de reprise, ni session jetable, ni lecture de chat en échec.
    assert "if not _resumable or ephemeral or _chat_read_failed or is_continue:" in src

    # Écriture de la question puis du tour complet, sous garde optimiste :
    # la seconde écriture passe (c'est la première qui a fixé la base).
    upsert_chat(1, "b8", "Nouveau chat", [], 100.0)
    assert upsert_chat(1, "b8", "bonjour", DEPART, 150.0,
                       expected_updated_at=100.0) is not False
    apres_question = get_chat(1, "b8")
    assert apres_question["messages"] == DEPART
    from chatbot_app.routes.chats import _persist_turn
    ret, _ = _persist_turn(upsert_chat, 1, "b8", "bonjour", TOUR,
                           baseline_updated_at=150.0,
                           baseline_messages=DEPART,
                           baseline_title="bonjour")
    assert ret is True and get_chat(1, "b8")["messages"] == TOUR
