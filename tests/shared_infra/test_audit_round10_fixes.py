# SPDX-License-Identifier: MIT
"""
Régressions — audit round 10 (2026-07-05), côté shared_infra.

Verrouille les correctifs :
  - F1  : révocation/clear de session PERSISTÉE (db_conn ne commit pas seul).
  - F16 : validation du charset username (injectivité dossier sandbox/mémoire).
  - F2  : concurrence optimiste sur upsert_chat (ne clobbere pas un tour concurrent).
  - F6  : _build_file_tree ne suit pas les symlinks (cross-tenant + récursion).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


@pytest.fixture()
def db(tmp_path, monkeypatch):
    """DB isolée avec les tables users + chats minimales."""
    db_file = tmp_path / "db" / "main.db"
    monkeypatch.setattr("shared_infra.db._connection.DB_PATH", str(db_file))
    from shared_infra.db import _connection as _legacy
    with _legacy.db_conn() as conn:
        conn.execute(
            "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT,"
            " username TEXT UNIQUE, pass_salt TEXT, pass_hash TEXT,"
            " created_at REAL, is_admin INTEGER DEFAULT 0, avatar TEXT,"
            " settings_json TEXT, must_change_pwd INTEGER DEFAULT 0,"
            " session_min_ts REAL DEFAULT 0)")
        conn.execute(
            "CREATE TABLE chats (id TEXT PRIMARY KEY, user_id INTEGER,"
            " title TEXT, messages_json TEXT, updated_at REAL,"
            " archived INTEGER DEFAULT 0)")
        conn.commit()
    return db_file


def _smt(uid: int) -> float:
    from shared_infra.db import _connection as _legacy
    with _legacy.db_conn() as conn:
        row = conn.execute("SELECT session_min_ts FROM users WHERE id=?", (uid,)).fetchone()
    return float(row[0] or 0.0)


# ── F1 — révocation / clear commitées ────────────────────────────────────────
def test_f1_bump_then_clear_are_committed(db):
    from shared_infra.accounts.users import bump_session_min_ts, clear_session_min_ts, create_user
    uid = create_user("alice", "pw")
    assert bump_session_min_ts(uid, 5000.0) is True
    assert _smt(uid) == 5000.0            # PERSISTÉ (échouait sans commit)
    assert clear_session_min_ts(uid) is True
    assert _smt(uid) == 0.0               # clear PERSISTÉ aussi


# ── F16 — validation username ────────────────────────────────────────────────
def test_f16_rejects_space_and_accent(db):
    from shared_infra.accounts.users import create_user
    with pytest.raises(ValueError):
        create_user("jean dupont", "pw")       # espace
    with pytest.raises(ValueError):
        create_user("José", "pw")               # accent


def test_f16_accepts_canonical(db):
    from shared_infra.accounts.users import create_user
    assert create_user("jean-dupont_2", "pw") > 0


def test_f16_rejects_collision_with_existing_noncanonical(db):
    # Insère un compte NON canonique directement (legacy), puis refuse la
    # création d'un compte canonique qui partagerait son dossier.
    from shared_infra.db import _connection as _legacy
    with _legacy.db_conn() as conn:
        conn.execute("INSERT INTO users(username, pass_salt, pass_hash, created_at) "
                     "VALUES ('jean dupont','x','y',0)")
        conn.commit()
    from shared_infra.accounts.users import create_user
    with pytest.raises(ValueError):
        create_user("jeandupont", "pw")         # même forme canonique


# ── F2 — concurrence optimiste upsert_chat ───────────────────────────────────
def test_f2_optimistic_conflict_preserves_concurrent_turn(db):
    from shared_infra.chat.store import upsert_chat
    # création
    assert upsert_chat(1, "cA", "t", [{"role": "user", "content": "m0"}], 100.0) is True
    # écriture concurrente #1 (baseline 100) réussit → updated_at devient 200
    assert upsert_chat(1, "cA", "gen1",
                       [{"role": "assistant", "content": "a1"}], 200.0,
                       expected_updated_at=100.0) is True
    # écriture #2 avec baseline PÉRIMÉ (100) alors que le chat est à 200 → CONFLIT
    assert upsert_chat(1, "cA", "compress",
                       [{"role": "system", "content": "résumé"}], 250.0,
                       expected_updated_at=100.0) is False
    # le tour gen1 est préservé (pas écrasé par la compression concurrente)
    from shared_infra.db import _connection as _legacy
    with _legacy.db_conn() as conn:
        row = conn.execute("SELECT title, messages_json FROM chats WHERE id='cA'").fetchone()
    assert row[0] == "gen1" and "a1" in row[1]


def test_f2_none_expected_is_unconditional(db):
    from shared_infra.chat.store import upsert_chat
    assert upsert_chat(1, "cB", "t", [], 100.0) is True
    # sans garde optimiste : écrase toujours (comportement historique)
    assert upsert_chat(1, "cB", "t2", [], 300.0) is True


def test_f2_cross_user_collision_still_raises(db):
    from shared_infra.chat.store import upsert_chat
    assert upsert_chat(1, "cC", "t", [], 100.0) is True
    with pytest.raises(ValueError):
        upsert_chat(2, "cC", "hijack", [], 200.0)   # autre user, même id


# ── F6 — _build_file_tree ne suit pas les symlinks ───────────────────────────
def test_f6_tree_skips_symlinks_no_infinite_recursion(tmp_path):
    from shared_infra.routes._helpers import _build_file_tree
    (tmp_path / "real.txt").write_text("hi")
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "a.txt").write_text("a")
    os.symlink(tmp_path, tmp_path / "loop")          # boucle
    os.symlink("/etc", tmp_path / "escape")          # dossier hors sandbox
    os.symlink("/etc/hostname", tmp_path / "leak")   # fichier hors sandbox
    names = sorted(i["name"] for i in _build_file_tree(tmp_path, tmp_path))
    assert names == ["real.txt", "sub"]              # symlinks exclus, pas de crash
