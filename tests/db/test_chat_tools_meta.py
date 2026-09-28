# SPDX-License-Identifier: MIT
"""tests/db/test_chat_tools_meta.py — toggles d'outils PAR CHAT (meta_json).

Réécriture : l'original (non commité) a été perdu lors du rollback du
2026-07-11 — couverture reconstruite depuis le contrat du code.

Couvre ``shared_infra/chat/store.py`` :
- ``set_chat_tools`` : roundtrip, ``[]`` (tout décoché) distinct de ``None``
  (jamais posé), False si chat inconnu, PAS de bump ``updated_at`` (garde
  optimiste F2 + tri sidebar), merge non destructif des autres clés meta,
  nettoyage des entrées (non-str, vides, caps 64) ;
- ``get_chat`` : expose ``tools`` ; tolère un schéma pré-0008 (pas de colonne) ;
- ``upsert_chat`` : ne clobbe jamais ``meta_json`` (un tour ne perd pas les
  toggles) ;
- migration ``0008_chat_meta`` : idempotente.
"""
from __future__ import annotations

import importlib
import json
import sqlite3

import pytest


@pytest.fixture()
def C(tmp_path, monkeypatch):
    """Table ``chats`` post-0008 (avec ``meta_json``), DB temporaire."""
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    from shared_infra.db._connection import db_conn
    with db_conn() as conn:
        conn.execute(
            "CREATE TABLE chats (id TEXT PRIMARY KEY, user_id INTEGER, title TEXT, "
            "messages_json TEXT, updated_at REAL, archived INTEGER DEFAULT 0, "
            "meta_json TEXT NOT NULL DEFAULT '{}')"
        )
        conn.commit()
    import shared_infra.chat.store as chats
    return chats


@pytest.fixture()
def C_pre0008(tmp_path, monkeypatch):
    """Table ``chats`` PRÉ-0008 (sans ``meta_json``) — chats d'avant la feature."""
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "old.db"))
    from shared_infra.db._connection import db_conn
    with db_conn() as conn:
        conn.execute(
            "CREATE TABLE chats (id TEXT PRIMARY KEY, user_id INTEGER, title TEXT, "
            "messages_json TEXT, updated_at REAL, archived INTEGER DEFAULT 0)"
        )
        conn.commit()
    import shared_infra.chat.store as chats
    return chats


def _raw_meta(chat_id: str) -> dict:
    from shared_infra.db._connection import db_conn
    with db_conn() as conn:
        row = conn.execute(
            "SELECT meta_json FROM chats WHERE id=?", (chat_id,)
        ).fetchone()
        return json.loads(row["meta_json"] or "{}")


# ── set_chat_tools / get_chat ───────────────────────────────────────────────

def test_roundtrip_set_puis_get(C):
    C.upsert_chat(1, "c1", "T", [{"role": "user", "content": "x"}], 10.0)
    assert C.set_chat_tools(1, "c1", ["fs", "shell"]) is True
    assert C.get_chat(1, "c1")["tools"] == ["fs", "shell"]


def test_jamais_pose_none_vs_liste_vide(C):
    C.upsert_chat(1, "c1", "T", [], 10.0)
    # Jamais posé → None : le front garde ses toggles courants (pas d'extinction).
    assert C.get_chat(1, "c1")["tools"] is None
    # [] = « tout décoché » explicite — état valide, distinct de None.
    assert C.set_chat_tools(1, "c1", []) is True
    assert C.get_chat(1, "c1")["tools"] == []


def test_chat_inconnu_false(C):
    assert C.set_chat_tools(1, "nope", ["fs"]) is False
    # Mauvais user sur un chat existant → False aussi (pas de fuite cross-user).
    C.upsert_chat(1, "c1", "T", [], 10.0)
    assert C.set_chat_tools(2, "c1", ["fs"]) is False


def test_pas_de_bump_updated_at(C):
    C.upsert_chat(1, "c1", "T", [], 42.5)
    C.set_chat_tools(1, "c1", ["fs"])
    assert C.get_chat(1, "c1")["updated_at"] == 42.5


def test_merge_preserve_les_autres_cles_meta(C):
    C.upsert_chat(1, "c1", "T", [], 10.0)
    from shared_infra.db._connection import db_conn
    with db_conn() as conn:
        conn.execute("UPDATE chats SET meta_json=? WHERE id='c1'",
                     (json.dumps({"autre": {"x": 1}}),))
        conn.commit()
    C.set_chat_tools(1, "c1", ["git"])
    meta = _raw_meta("c1")
    assert meta["tools"] == ["git"]
    assert meta["autre"] == {"x": 1}          # merge, pas d'écrasement


def test_nettoyage_entrees(C):
    C.upsert_chat(1, "c1", "T", [], 10.0)
    C.set_chat_tools(1, "c1", ["fs", "  ", "", 123, "x" * 200])  # type: ignore[list-item]
    got = C.get_chat(1, "c1")["tools"]
    assert got == ["fs", "x" * 64]            # non-str/vides filtrés, cap 64 chars
    # Cap 192 entrées (8 catégories + 53 exclusions ``-outil`` + ext:/mf:
    # dépassaient l'ancien plafond de 64, qui tronquait en silence).
    C.set_chat_tools(1, "c1", [f"cat{i}" for i in range(300)])
    assert len(C.get_chat(1, "c1")["tools"]) == 192


def test_meta_json_corrompu_tolere(C):
    C.upsert_chat(1, "c1", "T", [], 10.0)
    from shared_infra.db._connection import db_conn
    with db_conn() as conn:
        conn.execute("UPDATE chats SET meta_json='pas du json' WHERE id='c1'")
        conn.commit()
    assert C.get_chat(1, "c1")["tools"] is None          # lecture tolérante
    assert C.set_chat_tools(1, "c1", ["fs"]) is True     # écriture repart de {}
    assert C.get_chat(1, "c1")["tools"] == ["fs"]


# ── upsert_chat ne clobbe pas meta_json ─────────────────────────────────────

def test_upsert_preserve_meta_json(C):
    C.upsert_chat(1, "c1", "T", [{"role": "user", "content": "a"}], 10.0)
    C.set_chat_tools(1, "c1", ["fs"])
    # Un nouveau tour (upsert) ne doit pas perdre les toggles.
    C.upsert_chat(1, "c1", "T2", [{"role": "user", "content": "b"}], 11.0)
    assert C.get_chat(1, "c1")["tools"] == ["fs"]


# ── compat pré-0008 ─────────────────────────────────────────────────────────

def test_get_chat_schema_pre0008_tolerant(C_pre0008):
    C_pre0008.upsert_chat(1, "c1", "T", [{"role": "user", "content": "x"}], 10.0)
    got = C_pre0008.get_chat(1, "c1")
    assert got["tools"] is None               # pas de colonne → jamais posé
    assert got["messages"][0]["content"] == "x"


# ── migration 0008 ──────────────────────────────────────────────────────────

def test_migration_0008_idempotente(tmp_path):
    mig = importlib.import_module("shared_infra.db._migrations.0008_chat_meta")
    conn = sqlite3.connect(str(tmp_path / "m.db"))
    conn.execute(
        "CREATE TABLE chats (id TEXT PRIMARY KEY, user_id INTEGER, title TEXT, "
        "messages_json TEXT, updated_at REAL, archived INTEGER DEFAULT 0)"
    )
    mig.migrate(conn)
    mig.migrate(conn)                          # 2e passage = no-op
    cols = {r[1] for r in conn.execute("PRAGMA table_info(chats)").fetchall()}
    assert "meta_json" in cols
    conn.execute("INSERT INTO chats(id, user_id, title, messages_json, updated_at)"
                 " VALUES ('c', 1, 't', '[]', 0)")
    row = conn.execute("SELECT meta_json FROM chats WHERE id='c'").fetchone()
    assert row[0] == "{}"                      # défaut sain
    conn.close()
