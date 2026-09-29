# SPDX-License-Identifier: MIT
"""
tests/db/test_notifications_db.py — couche DB du centre de notifications.

Couvre : application de la migration 0005 (table + index), CRUD de base,
isolation tenant (owner-gating sur list/count/mark/delete), comptage des non-lus,
purge au-delà du cap par utilisateur, et CASCADE delete sur suppression du user.

DB isolée : on patche ``shared_infra.db._connection.DB_PATH`` vers un fichier tmp, on
crée une table ``users`` minimale (FK) puis on applique la migration 0005.
"""
from __future__ import annotations

import pytest


@pytest.fixture()
def N(tmp_path, monkeypatch):
    import importlib

    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    from shared_infra.db._connection import db_conn
    with db_conn() as conn:
        conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT)")
        conn.executemany("INSERT INTO users(id, username) VALUES (?,?)",
                         [(1, "alice"), (2, "bob")])
        # Applique la migration RÉELLE (table + index) plutôt qu'un CREATE inline.
        # import_module gère un nom de module commençant par un chiffre.
        # Sur un moteur serveur, la table vient du schéma de référence (une
        # base serveur ne rejoue pas l'historique SQLite).
        from shared_infra.db._dialect import SQLITE, dialect_of
        if dialect_of(conn) == SQLITE:
            mod = importlib.import_module(
                "shared_infra.db._migrations.0005_notifications_table")
            mod.migrate(conn)
        else:
            from shared_infra.db._schema import ensure_tables
            ensure_tables(conn, ("notifications",))
        conn.commit()
    import shared_infra.notifications.store as notif
    return notif


def _mk(notif, owner=1, kind="routine_ok", title="t", **kw):
    return notif.create_notification(owner, kind, title, **kw)


def test_create_and_list(N):
    nid = _mk(N, 1, title="Routine A terminée", body="résumé", ref_type="routine", ref_id=7)
    assert isinstance(nid, int) and nid > 0
    items = N.list_notifications(1)
    assert len(items) == 1
    row = items[0]
    assert row["kind"] == "routine_ok"
    assert row["title"] == "Routine A terminée"
    assert row["ref_type"] == "routine" and row["ref_id"] == 7
    assert row["read_at"] is None


def test_unread_count_and_mark_read(N):
    a = _mk(N, 1)
    _mk(N, 1)
    assert N.count_unread(1) == 2
    assert N.mark_read(1, a) is True
    assert N.count_unread(1) == 1
    # Re-mark déjà lu → no-op.
    assert N.mark_read(1, a) is False
    assert N.mark_all_read(1) == 1
    assert N.count_unread(1) == 0


def test_tenant_isolation(N):
    a = _mk(N, 1)
    _mk(N, 2)
    assert len(N.list_notifications(1)) == 1
    assert len(N.list_notifications(2)) == 1
    # bob ne peut pas marquer/supprimer la notif d'alice.
    assert N.mark_read(2, a) is False
    assert N.delete_notification(2, a) is False
    assert len(N.list_notifications(1)) == 1
    # alice supprime la sienne.
    assert N.delete_notification(1, a) is True
    assert len(N.list_notifications(1)) == 0


def test_clear_all_scoped(N):
    _mk(N, 1); _mk(N, 1); _mk(N, 2)
    assert N.clear_all(1) == 2
    assert N.list_notifications(1) == []
    assert len(N.list_notifications(2)) == 1


def test_purge_caps_per_user(N, monkeypatch):
    monkeypatch.setattr(N, "_MAX_PER_USER", 5)
    for i in range(8):
        _mk(N, 1, title=f"n{i}")
    items = N.list_notifications(1, limit=100)
    assert len(items) == 5
    # Les plus récentes sont conservées (tri created_at DESC, id DESC).
    titles = [r["title"] for r in items]
    assert titles[0] == "n7"


def test_cascade_delete_on_user_removal(N):
    _mk(N, 1)
    from shared_infra.db._connection import db_conn
    from shared_infra.db._dialect import SQLITE, dialect_of
    with db_conn() as conn:
        if dialect_of(conn) == SQLITE:            # toujours actives ailleurs
            conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("DELETE FROM users WHERE id=1")
        conn.commit()
    assert N.list_notifications(1) == []


def test_pagination_before_cursor(N):
    # ids croissants n0..n4 ; l'ordre d'affichage est le plus récent d'abord.
    for i in range(5):
        _mk(N, 1, title=f"n{i}")
    page1 = N.list_notifications(1, limit=2)
    assert [r["title"] for r in page1] == ["n4", "n3"]
    page2 = N.list_notifications(1, limit=2, before_id=page1[-1]["id"])
    assert [r["title"] for r in page2] == ["n2", "n1"]
    page3 = N.list_notifications(1, limit=2, before_id=page2[-1]["id"])
    assert [r["title"] for r in page3] == ["n0"]
    # Le curseur est tenant-gated comme le reste (pas de fuite cross-user).
    _mk(N, 2, title="bob")
    assert N.list_notifications(2, limit=10, before_id=10_000)[0]["title"] == "bob"


def test_mark_unread(N):
    a = _mk(N, 1)
    assert N.mark_read(1, a) is True and N.count_unread(1) == 0
    # Repasse en non-lu → recompté.
    assert N.mark_unread(1, a) is True and N.count_unread(1) == 1
    # Déjà non-lu → no-op.
    assert N.mark_unread(1, a) is False
    # Tenant-gating : bob ne peut pas toucher la notif d'alice.
    assert N.mark_read(1, a) is True
    assert N.mark_unread(2, a) is False and N.count_unread(1) == 0
