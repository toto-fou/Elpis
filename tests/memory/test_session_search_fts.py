# SPDX-License-Identifier: MIT
"""Tests de l'index FTS5 session_search (chat + agentic, dégradation gracieuse)."""
from __future__ import annotations

import importlib

import pytest


@pytest.fixture
def mem_db(tmp_path, monkeypatch):
    """Pointe la DB sur un fichier temporaire et crée users + tables mémoire."""
    from shared_infra.db import _connection as _legacy
    monkeypatch.setattr(_legacy, "DB_PATH", str(tmp_path / "test.db"))

    from shared_infra.memory import store as memory_store
    # users (FK cible) — schéma minimal suffisant
    with _legacy.db_conn() as conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS users ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL)"
        )
        conn.execute("INSERT INTO users(id, username) VALUES(1, 'alice')")
        conn.commit()
    memory_store.init_memory_db()
    return memory_store


def test_index_and_search_roundtrip(mem_db):
    mem_db.session_index_message(
        user_id=1, app="chat", session_id="c1", scope_key="",
        role="user", content="comment configurer le serveur nginx",
    )
    mem_db.session_index_message(
        user_id=1, app="chat", session_id="c1", scope_key="",
        role="assistant", content="il faut editer le fichier de configuration",
    )
    rows = mem_db.session_search_fts(1, "nginx", limit=10)
    assert len(rows) == 1
    assert rows[0]["app"] == "chat"
    assert "nginx" in rows[0]["content"]


def test_search_spans_both_apps(mem_db):
    mem_db.session_index_message(user_id=1, app="chat", session_id="c1",
                                 scope_key="", role="user", content="banane chat")
    mem_db.session_index_message(user_id=1, app="agentic", session_id="run9",
                                 scope_key="pipeline:1:node:2", role="assistant",
                                 content="banane agentic")
    rows = mem_db.session_search_fts(1, "banane", limit=10)
    apps = {r["app"] for r in rows}
    assert apps == {"chat", "agentic"}


def test_search_empty_query(mem_db):
    assert mem_db.session_search_fts(1, "", limit=10) == []
    assert mem_db.session_search_fts(1, "   ", limit=10) == []


def test_index_empty_content_noop(mem_db):
    assert mem_db.session_index_message(
        user_id=1, app="chat", session_id="c1", scope_key="",
        role="user", content="   ",
    ) == 0


def test_search_scoped_to_user(mem_db):
    from shared_infra.db import _connection as _legacy
    with _legacy.db_conn() as conn:
        conn.execute("INSERT INTO users(id, username) VALUES(2, 'bob')")
        conn.commit()
    mem_db.session_index_message(user_id=1, app="chat", session_id="c1",
                                 scope_key="", role="user", content="secret alpha")
    mem_db.session_index_message(user_id=2, app="chat", session_id="c2",
                                 scope_key="", role="user", content="secret alpha")
    rows = mem_db.session_search_fts(1, "alpha", limit=10)
    assert len(rows) == 1  # n'expose pas la ligne de bob


def test_bulk_index_one_transaction(mem_db, monkeypatch):
    """(passe 8, B8) — l'indexation pré-compaction écrit ses lignes en UNE
    transaction (un seul commit), et les lignes sont retrouvables."""
    from shared_infra.memory import store as memory_store
    commits = []
    real = memory_store.db_conn

    class _Spy:
        def __init__(self, conn): self._c = conn
        def __enter__(self): self._conn = real().__enter__(); return self
        def __exit__(self, *a): return self._conn.__exit__(*a)
        def executemany(self, *a, **k): return self._conn.executemany(*a, **k)
        def execute(self, *a, **k): return self._conn.execute(*a, **k)
        def cursor(self): return self._conn.cursor()
        def commit(self): commits.append(1); return self._conn.commit()

    monkeypatch.setattr(memory_store, "db_conn", lambda: _Spy(None))
    rows = [dict(user_id=1, app="chat", session_id="s1", scope_key="", role="tool",
                 content=f"sortie outil numero {i} bulkindex", ts=1.0) for i in range(25)]
    rows.append({"user_id": 1, "content": "   "})          # vide : ignorée
    assert memory_store.session_index_messages(rows) == 25
    assert len(commits) == 1
    monkeypatch.setattr(memory_store, "db_conn", real)
    hits = memory_store.session_search_fts(1, "bulkindex", limit=50)
    assert len(hits) == 25
