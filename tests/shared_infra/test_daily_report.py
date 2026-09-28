# SPDX-License-Identifier: MIT
"""
tests/shared_infra/test_daily_report.py — rapport quotidien d'usage IA + digest.

Couvre la construction du snapshot curé, l'idempotence du digest (un seul par
jour, re-générable en force) et la notification des admins.

DB isolée (tmp) avec users + notifications + daily_usage_reports.
"""
from __future__ import annotations

import pytest

ADMIN_ID = 1


@pytest.fixture()
def env(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    from shared_infra.db._connection import db_conn
    with db_conn() as c:
        # users : colonnes lues par get_all_users + FK notifications.
        c.execute("CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, "
                  "is_admin INTEGER DEFAULT 0, created_at REAL, avatar TEXT)")
        c.executemany("INSERT INTO users(id, username, is_admin, created_at) VALUES(?,?,?,?)",
                      [(1, "admin", 1, 0.0), (2, "bob", 0, 0.0)])
        # notifications (schéma de la migration 0005).
        c.execute("CREATE TABLE notifications(id INTEGER PRIMARY KEY AUTOINCREMENT, "
                  "owner_user_id INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, "
                  "body TEXT DEFAULT '', ref_type TEXT DEFAULT '', ref_id INTEGER, "
                  "read_at REAL, created_at REAL NOT NULL)")
        c.commit()
    import shared_infra.observability.daily_reports_store as dr
    dr.init_daily_reports_db()
    return legacy, dr


def test_build_daily_report_shape(env):
    from shared_infra.observability.metrics.daily_report import (
        REPORT_WIDGET_IDS, build_daily_report)
    rep = build_daily_report(scope_hours=24, date="2026-06-21")
    assert rep["date"] == "2026-06-21"
    assert rep["scope_hours"] == 24
    assert isinstance(rep["sections"], list) and rep["sections"]
    # widgets est un dict ; chaque id curé calculé (un provider en erreur reste
    # une clé avec {"error": ...}, jamais un crash).
    assert isinstance(rep["widgets"], dict)
    assert set(rep["widgets"].keys()) <= set(REPORT_WIDGET_IDS)


def test_digest_is_idempotent_per_day(env):
    legacy, dr = env
    from shared_infra.observability.metrics.daily_report import generate_and_store_daily_digest

    d = generate_and_store_daily_digest(date="2026-06-21")
    assert d == "2026-06-21"
    assert dr.report_exists("2026-06-21")
    # 2e appel le MÊME jour → skip (None), pas de doublon de notif.
    assert generate_and_store_daily_digest(date="2026-06-21") is None
    # force → régénère.
    assert generate_and_store_daily_digest(date="2026-06-21", force=True) == "2026-06-21"


def test_digest_notifies_admins_only(env):
    legacy, dr = env
    from shared_infra.observability.metrics.daily_report import generate_and_store_daily_digest
    generate_and_store_daily_digest(date="2026-06-21")
    with legacy.db_conn() as c:
        rows = c.execute(
            "SELECT owner_user_id, kind FROM notifications WHERE kind='daily_report'"
        ).fetchall()
    owners = sorted(r[0] for r in rows)
    assert owners == [ADMIN_ID]      # admin notifié, bob (non-admin) non
