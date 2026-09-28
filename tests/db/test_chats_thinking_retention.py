# SPDX-License-Identifier: MIT
"""tests/db/test_chats_thinking_retention.py — le « thinking » n'est PAS retenu.

Le raisonnement (``thinking``) n'est utile qu'à l'affichage live du tour en
cours. ``upsert_chat`` (seul chemin d'écriture des messages) le retire avant
de persister : un chat rechargé n'expose plus aucun thinking. Les autres champs
(content, tool_history, métriques) restent intacts, et l'objet source n'est pas
muté (copie défensive).
"""
from __future__ import annotations

import pytest


@pytest.fixture()
def C(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    from shared_infra.db._connection import db_conn
    with db_conn() as conn:
        conn.execute(
            "CREATE TABLE chats (id TEXT PRIMARY KEY, user_id INTEGER, title TEXT, "
            "messages_json TEXT, updated_at REAL, archived INTEGER DEFAULT 0)"
        )
        conn.commit()
    import shared_infra.chat.store as chats
    return chats


def test_thinking_stripped_on_persist(C):
    msgs = [
        {"role": "user", "content": "salut", "thinking": "ne devrait pas exister"},
        {"role": "assistant", "content": "réponse", "thinking": "raisonnement secret",
         "tool_history": [{"x": 1}], "tool_history_delta": True,
         "metrics": {"model": "m"}},
    ]
    C.upsert_chat(1, "c1", "Titre", msgs, 123.0)
    got = C.get_chat(1, "c1")["messages"]

    assert all("thinking" not in m for m in got)        # retiré partout
    assert got[0]["content"] == "salut"                 # contenu intact
    assert got[1]["content"] == "réponse"
    assert got[1]["tool_history"] == [{"x": 1}]         # tool_history préservé
    assert got[1]["tool_history_delta"] is True         # marqueur delta préservé
    assert got[1]["metrics"] == {"model": "m"}

    # Copie défensive : l'objet passé par l'appelant n'est pas muté.
    assert msgs[1]["thinking"] == "raisonnement secret"


def test_persist_without_thinking_is_noop(C):
    msgs = [{"role": "assistant", "content": "ok"}]
    C.upsert_chat(1, "c2", "T", msgs, 1.0)
    got = C.get_chat(1, "c2")["messages"]
    assert got == [{"role": "assistant", "content": "ok"}]
