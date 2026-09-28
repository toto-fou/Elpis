# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_notifications_route.py — endpoints /api/notifications/*.

Couvre le contrat HTTP (list+unread, unread-count, mark read, read-all, delete,
clear) et l'owner-gating (un user ne lit/altère pas les notifs d'un autre).

Auth : on monkeypatch ``require_user_id`` du module de routes pour injecter un uid
sans passer par la session/cookie (le plumbing de session est testé ailleurs).
"""
from __future__ import annotations

import importlib

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    from shared_infra.db._connection import db_conn
    with db_conn() as conn:
        conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT)")
        conn.executemany("INSERT INTO users(id, username) VALUES (?,?)",
                         [(1, "alice"), (2, "bob")])
        mod = importlib.import_module(
            "shared_infra.db._migrations.0005_notifications_table")
        mod.migrate(conn)
        conn.commit()

    import shared_infra.notifications.routes as routes_notif
    # uid injecté par un holder mutable pour basculer d'utilisateur dans un test.
    holder = {"uid": 1}
    monkeypatch.setattr(routes_notif, "require_user_id", lambda request: holder["uid"])

    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    import shared_infra.notifications.store as notif
    return TestClient(app), notif, holder


def test_list_and_unread(client):
    c, notif, _ = client
    notif.create_notification(1, "routine_ok", "A terminée", body="ok", ref_type="routine", ref_id=5)
    notif.create_notification(1, "routine_error", "B échouée", ref_type="routine", ref_id=6)
    r = c.get("/api/notifications")
    assert r.status_code == 200
    j = r.json()
    assert j["unread"] == 2
    assert len(j["items"]) == 2
    assert {i["kind"] for i in j["items"]} == {"routine_ok", "routine_error"}

    assert c.get("/api/notifications/unread-count").json()["count"] == 2


def test_mark_read_and_read_all(client):
    c, notif, _ = client
    a = notif.create_notification(1, "routine_ok", "A")
    notif.create_notification(1, "routine_ok", "B")
    r = c.patch(f"/api/notifications/{a}/read")
    assert r.status_code == 200 and r.json()["unread"] == 1
    r = c.post("/api/notifications/read-all")
    assert r.json()["unread"] == 0
    assert c.get("/api/notifications/unread-count").json()["count"] == 0


def test_delete_and_clear(client):
    c, notif, _ = client
    a = notif.create_notification(1, "routine_ok", "A")
    notif.create_notification(1, "routine_ok", "B")
    assert c.delete(f"/api/notifications/{a}").status_code == 200
    assert len(c.get("/api/notifications").json()["items"]) == 1
    assert c.post("/api/notifications/clear").json()["unread"] == 0
    assert c.get("/api/notifications").json()["items"] == []


def test_pagination_params(client):
    c, notif, _ = client
    for i in range(4):
        notif.create_notification(1, "routine_ok", f"n{i}")
    j = c.get("/api/notifications?limit=2").json()
    assert [i["title"] for i in j["items"]] == ["n3", "n2"]
    cursor = j["items"][-1]["id"]
    j2 = c.get(f"/api/notifications?limit=2&before={cursor}").json()
    assert [i["title"] for i in j2["items"]] == ["n1", "n0"]


def test_mark_unread_endpoint(client):
    c, notif, _ = client
    a = notif.create_notification(1, "routine_ok", "A")
    c.patch(f"/api/notifications/{a}/read")
    assert c.get("/api/notifications/unread-count").json()["count"] == 0
    r = c.patch(f"/api/notifications/{a}/unread")
    assert r.status_code == 200 and r.json()["unread"] == 1


def test_owner_gating(client):
    c, notif, holder = client
    a = notif.create_notification(1, "routine_ok", "alice notif")
    notif.create_notification(2, "routine_ok", "bob notif")

    # bob ne voit que la sienne.
    holder["uid"] = 2
    items = c.get("/api/notifications").json()["items"]
    assert len(items) == 1 and items[0]["title"] == "bob notif"
    # bob tente de marquer/supprimer la notif d'alice → no-op, alice intacte.
    c.patch(f"/api/notifications/{a}/read")
    c.delete(f"/api/notifications/{a}")
    holder["uid"] = 1
    alice = c.get("/api/notifications").json()
    assert len(alice["items"]) == 1 and alice["unread"] == 1
