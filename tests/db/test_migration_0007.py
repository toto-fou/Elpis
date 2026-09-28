# SPDX-License-Identifier: MIT
"""Migration 0007 — table ``llm_connectors`` (connecteurs LLM)."""
from __future__ import annotations

import importlib
import sqlite3

import pytest

# Migration historique d'une base SQLite (une base serveur naît du schéma de référence).
pytestmark = pytest.mark.sqlite_only


def _apply(conn):
    importlib.import_module(
        "shared_infra.db._migrations.0007_llm_connectors").migrate(conn)
    conn.commit()


@pytest.fixture()
def conn():
    c = sqlite3.connect(":memory:")
    c.row_factory = sqlite3.Row
    c.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT)")
    return c


def test_creates_table_with_expected_columns(conn):
    _apply(conn)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(llm_connectors)").fetchall()}
    for expected in ("owner_user_id", "scope", "provider_type", "wire",
                     "base_url", "api_key_enc", "key_scheme", "default_model",
                     "models_json", "enabled"):
        assert expected in cols, expected


def test_idempotent(conn):
    _apply(conn)
    _apply(conn)   # must not raise
    n = conn.execute("SELECT COUNT(*) FROM sqlite_master "
                     "WHERE type='table' AND name='llm_connectors'").fetchone()[0]
    assert n == 1


def test_owner_nullable_for_shared(conn):
    _apply(conn)
    # scope='shared' ⇒ owner_user_id NULL autorisé.
    conn.execute(
        "INSERT INTO llm_connectors(owner_user_id, scope, provider_type, wire, "
        "base_url, created_at, updated_at) VALUES(NULL,'shared','vllm','openai',"
        "'http://x:8000/v1', 0, 0)")
    conn.commit()
    row = conn.execute("SELECT owner_user_id, scope FROM llm_connectors").fetchone()
    assert row["owner_user_id"] is None and row["scope"] == "shared"


def test_indexes_present(conn):
    _apply(conn)
    idx = {r[1] for r in conn.execute(
        "SELECT * FROM sqlite_master WHERE type='index'").fetchall()}
    assert "idx_llmconn_owner" in idx and "idx_llmconn_scope" in idx
