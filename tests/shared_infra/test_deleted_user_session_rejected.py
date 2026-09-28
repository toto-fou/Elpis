# SPDX-License-Identifier: MIT
"""
tests/shared_infra/test_deleted_user_session_rejected.py

Régression (sécurité / autorisation) — AUDIT 2026-08-02 (C1).

Bug d'origine : ``DELETE /api/admin/users/{id}`` supprimait la ligne ``users``
sans poser de révocation. Or ``deps._session_validity_checks`` faisait
``SELECT session_min_ts FROM users WHERE id=?`` et, sur ``row is None`` (compte
supprimé), le ``if row:`` sautait TOUTES les gates → une session sur un compte
FANTÔME restait valide jusqu'à ``max_age`` (24 h), gardant chat, dépense LLM et
un shell interactif, sans aucune remédiation ciblée possible.

Correctif : le SELECT ayant réussi, l'absence de ligne est DÉFINITIVE (pas une
erreur transitoire) → fail-CLOSED. On teste directement le gate DB.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


class _FakeRequest:
    """Requête minimale : ``_session_validity_checks`` ne lit que ``.session``."""
    def __init__(self, session: dict):
        self.session = session


@pytest.fixture()
def user_db(tmp_path, monkeypatch):
    """DB SQLite isolée avec une table ``users`` minimale + un utilisateur."""
    db_file = tmp_path / "db" / "main.db"
    monkeypatch.setattr("shared_infra.db._connection.DB_PATH", str(db_file))
    # Config neutre : max_age 24 h par défaut, aucune révocation globale.
    import shared_infra.config as _cfg
    monkeypatch.setattr(_cfg, "read_config_json", lambda: {})
    from shared_infra.db import _connection as _legacy
    with _legacy.db_conn() as conn:
        conn.execute(
            "CREATE TABLE users ("
            " id INTEGER PRIMARY KEY AUTOINCREMENT,"
            " username TEXT UNIQUE,"
            " is_admin INTEGER DEFAULT 0,"
            " must_change_pwd INTEGER DEFAULT 0,"
            " session_min_ts REAL DEFAULT 0)"
        )
        from shared_infra.db._dialect import insert_id
        uid = insert_id(conn.cursor(), "INSERT INTO users(username) VALUES (?)", ("alice",))
        conn.commit()
        return uid


def test_active_account_session_is_valid(user_db):
    from shared_infra.security.deps import _session_validity_checks
    req = _FakeRequest({"_login_ts": time.time()})
    assert _session_validity_checks(req, user_db) is True


def test_deleted_account_session_is_rejected(user_db):
    """C1 : une fois la ligne ``users`` supprimée, toute session portant cet
    uid doit être rejetée (fail-closed), pas silencieusement tolérée."""
    from shared_infra.security.deps import _session_validity_checks
    from shared_infra.db import _connection as _legacy

    # Session valide tant que le compte existe…
    assert _session_validity_checks(
        _FakeRequest({"_login_ts": time.time()}), user_db) is True

    # …compte supprimé (le SELECT réussira mais ne ramènera aucune ligne).
    with _legacy.db_conn() as conn:
        conn.execute("DELETE FROM users WHERE id=?", (user_db,))
        conn.commit()

    session = {"_login_ts": time.time()}
    assert _session_validity_checks(_FakeRequest(session), user_db) is False
    # La session a été vidée (require_user_id renverra alors 401).
    assert session == {}
