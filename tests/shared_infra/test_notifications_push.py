# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_notifications_push.py — helper d'émission unifié.

Couvre ``shared_infra.notifications.push.push_notification`` : persistance DB +
event SSE *enrichi* (id/title/body/ref_type/ref_id/unread), best-effort sur
échec, et l'option ``live=False``. Couvre aussi l'encodage de date du rapport
quotidien (``ref_id`` = YYYYMMDD) qui permet le deep-link précis.
"""
from __future__ import annotations

import importlib

import pytest


@pytest.fixture()
def env(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    from shared_infra.db._connection import db_conn
    with db_conn() as conn:
        conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT)")
        conn.execute("INSERT INTO users(id, username) VALUES (1,'alice')")
        importlib.import_module(
            "shared_infra.db._migrations.0005_notifications_table").migrate(conn)
        conn.commit()
    # Capture les events live au lieu d'écrire dans /tmp.
    import shared_infra.observability.metrics.broadcast as broadcast
    events = []
    monkeypatch.setattr(broadcast, "publish_event", lambda p: events.append(p))
    import shared_infra.notifications.push as push
    import shared_infra.notifications.store as notif
    return push, notif, events


def test_push_creates_and_publishes_enriched(env):
    push, notif, events = env
    nid = push.push_notification(1, "routine_ok", "Titre", body="corps",
                                 ref_type="routine", ref_id=9)
    items = notif.list_notifications(1)
    assert len(items) == 1 and items[0]["id"] == nid
    assert len(events) == 1
    ev = events[0]
    assert ev["type"] == "notification"
    d = ev["data"]
    assert d["user_id"] == 1 and d["id"] == nid
    assert d["kind"] == "routine_ok" and d["title"] == "Titre" and d["body"] == "corps"
    assert d["ref_type"] == "routine" and d["ref_id"] == 9
    assert d["unread"] == 1


def test_push_live_false_skips_event(env):
    push, notif, events = env
    push.push_notification(1, "routine_ok", "T", live=False)
    assert len(notif.list_notifications(1)) == 1
    assert events == []


def test_push_best_effort_on_create_failure(env, monkeypatch):
    push, notif, events = env
    # La création DB lève → push avale, retourne None, n'émet aucun event.
    monkeypatch.setattr(
        "shared_infra.notifications.store.create_notification",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("db down")),
    )
    assert push.push_notification(1, "routine_ok", "T") is None
    assert events == []


def test_daily_report_date_to_ref_id():
    from shared_infra.observability.metrics.daily_report import _date_to_ref_id
    assert _date_to_ref_id("2026-06-22") == 20260622
    assert _date_to_ref_id("bad") is None
    assert _date_to_ref_id(None) is None


def test_notify_admins_passes_dated_ref_id(monkeypatch):
    import shared_infra.observability.metrics.daily_report as dr
    calls = []
    monkeypatch.setattr("shared_infra.accounts.users.get_all_users",
                        lambda: [{"id": 1, "is_admin": 1}, {"id": 2, "is_admin": 0}])
    monkeypatch.setattr(dr, "_summary_text", lambda payload: "résumé")
    monkeypatch.setattr("shared_infra.notifications.push.push_notification",
                        lambda *a, **k: calls.append((a, k)))
    n = dr._notify_admins("2026-06-22", {})
    assert n == 1                       # seul l'admin est notifié
    args, kw = calls[0]
    assert args[1] == "daily_report"
    assert kw.get("ref_type") == "daily_report"
    assert kw.get("ref_id") == 20260622
