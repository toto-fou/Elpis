# SPDX-License-Identifier: MIT
"""
tests/shared_infra/test_password_session_invalidation.py

Régression (sécurité / logique) : un changement OU un reset de mot de passe
DOIT invalider les sessions existantes de l'utilisateur.

Bug d'origine : ``reset_user_password`` ne mettait à jour que le hash, et ni la
route self-service ``/api/users/change-password`` ni la route admin
``/api/admin/reset-password`` ne touchaient ``users.session_min_ts``. Le gate de
session (``deps.require_user_id`` étape 3) ne révoque que si
``login_ts < session_min_ts`` → une session volée/encore active survivait au
changement de mot de passe (jusqu'à expiration ``max_age`` ≈ 24 h).

On teste ici le helper DB ``bump_session_min_ts`` (le mécanisme désormais
appelé par les deux routes) et on reproduit la règle du gate pour prouver
qu'une ancienne session est éjectée tandis que la session courante (ré-estampillée
par la route) est conservée.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _gate_rejects(login_ts: float, session_min_ts: float) -> bool:
    """Réplique exacte de la règle de révocation par-user (deps.py étape 3)."""
    return session_min_ts > 0 and login_ts < session_min_ts


@pytest.fixture()
def user_db(tmp_path, monkeypatch):
    """DB SQLite isolée avec une table ``users`` minimale + un utilisateur."""
    db_file = tmp_path / "db" / "main.db"
    monkeypatch.setattr("shared_infra.db._connection.DB_PATH", str(db_file))
    from shared_infra.db import _connection as _legacy
    with _legacy.db_conn() as conn:
        conn.execute(
            "CREATE TABLE users ("
            " id INTEGER PRIMARY KEY AUTOINCREMENT,"
            " username TEXT UNIQUE,"
            " pass_salt TEXT, pass_hash TEXT,"
            " is_admin INTEGER DEFAULT 0,"
            " must_change_pwd INTEGER DEFAULT 0,"
            " session_min_ts REAL DEFAULT 0)"
        )
        from shared_infra.db._dialect import insert_id
        uid = insert_id(
            conn.cursor(),
            "INSERT INTO users(username, pass_salt, pass_hash) VALUES (?,?,?)",
            ("alice", "deadbeef", "x"),
        )
        conn.commit()
        return uid


def _session_min_ts(uid: int) -> float:
    from shared_infra.db import _connection as _legacy
    with _legacy.db_conn() as conn:
        row = conn.execute(
            "SELECT session_min_ts FROM users WHERE id=?", (uid,)
        ).fetchone()
    return float(row[0] or 0.0)


def test_reset_password_alone_does_not_touch_session_min_ts(user_db):
    # reset_user_password gère UNIQUEMENT le hash ; l'invalidation des sessions
    # est de la responsabilité de la route (via bump_session_min_ts).
    from shared_infra.accounts.users import reset_user_password
    reset_user_password(user_db, "Sup3rSecret!")
    assert _session_min_ts(user_db) == 0.0


def test_bump_sets_revocation_epoch(user_db):
    from shared_infra.accounts.users import bump_session_min_ts
    assert bump_session_min_ts(user_db, 1000.0) is True
    assert _session_min_ts(user_db) == 1000.0


def test_bump_default_ts_is_now(user_db):
    import time
    from shared_infra.accounts.users import bump_session_min_ts
    before = time.time()
    bump_session_min_ts(user_db)
    smt = _session_min_ts(user_db)
    assert smt >= before


def test_bump_unknown_user_returns_false(user_db):
    from shared_infra.accounts.users import bump_session_min_ts
    assert bump_session_min_ts(999999, 1.0) is False


def test_password_change_ejects_old_session_keeps_current(user_db):
    """Reproduit le comportement de la route change-password corrigée."""
    from shared_infra.accounts.users import reset_user_password, bump_session_min_ts

    old_login_ts = 1000.0  # une session ouverte AVANT le changement
    # Avant le changement : la session est valide (session_min_ts == 0).
    assert _gate_rejects(old_login_ts, _session_min_ts(user_db)) is False

    # La route fait : reset_user_password + bump_session_min_ts(_now) +
    # request.session["_login_ts"] = _now.
    change_ts = 2000.0
    reset_user_password(user_db, "Sup3rSecret!")
    bump_session_min_ts(user_db, change_ts)
    current_login_ts = change_ts  # session courante ré-estampillée

    smt = _session_min_ts(user_db)
    # Ancienne session (login_ts antérieur) : éjectée au prochain appel.
    assert _gate_rejects(old_login_ts, smt) is True
    # Session courante (login_ts == session_min_ts) : conservée (garde stricte <).
    assert _gate_rejects(current_login_ts, smt) is False
