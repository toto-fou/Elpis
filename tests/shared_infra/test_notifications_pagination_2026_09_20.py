# SPDX-License-Identifier: MIT
"""
Pagination des notifications : curseur ``(created_at, id)`` (2026-09-20).

Avant : tri par ``created_at`` mais curseur ``id<?`` — une notification plus
ancienne par la date mais d'id supérieur (horloge, insertion différée, autre
worker) n'apparaissait sur AUCUNE page, alors que le badge la comptait.
"""
from __future__ import annotations

import pytest


@pytest.fixture()
def base(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    legacy.init_db()
    from shared_infra.accounts.users import create_user

    # Clé étrangère vers users : les deux comptes existent (ids 7 et 8 forcés).
    from shared_infra.db._connection import db_conn
    for uid, name in ((7, "sept"), (8, "huit")):
        real = create_user(name, "pw-" + name + "-1")
        with db_conn() as conn:
            conn.execute("UPDATE users SET id=? WHERE id=?", (uid, real)); conn.commit()
    from shared_infra.notifications import store
    # id 1 créé à t=100, id 2 à t=50 (plus ancien mais id supérieur), id 3 à t=75,
    # id 4 à t=100 (même date que 1 → départage par id).
    ids = [store.create_notification(7, "k", f"n{i}") for i in range(1, 5)]
    with db_conn() as conn:
        for nid, ts in zip(ids, (100, 50, 75, 100)):
            conn.execute("UPDATE notifications SET created_at=? WHERE id=?", (ts, nid))
        conn.commit()
    return store, ids


def _titles(rows):
    return [r["title"] for r in rows]


def test_toutes_les_pages_couvrent_toutes_les_notifications(base):
    store, ids = base
    vues, cursor = [], None
    for _ in range(10):
        page = store.list_notifications(7, limit=1, before_id=cursor)
        if not page:
            break
        vues += _titles(page)
        cursor = page[-1]["id"]
    # Ordre par date décroissante puis id décroissant : n4 (100), n1 (100), n3 (75), n2 (50)
    assert vues == ["n4", "n1", "n3", "n2"]


def test_une_page_plus_large_donne_le_meme_ordre(base):
    store, _ = base
    assert _titles(store.list_notifications(7, limit=10)) == ["n4", "n1", "n3", "n2"]
    p2 = store.list_notifications(7, limit=10, before_id=_id_of(store, "n1"))
    assert _titles(p2) == ["n3", "n2"]


def test_curseur_purge_entre_deux_pages_repli_sur_l_id(base):
    store, ids = base
    from shared_infra.db._connection import db_conn
    with db_conn() as conn:
        conn.execute("DELETE FROM notifications WHERE id=?", (ids[2],))   # n3 disparaît
        conn.commit()
    # Curseur = id de n3 (inconnu désormais) : repli ``id<?`` → n1, n2 (ids 1 et 2)
    assert _titles(store.list_notifications(7, limit=10, before_id=ids[2])) == ["n1", "n2"]


def test_cloisonnement_par_utilisateur(base):
    store, _ = base
    autre = store.create_notification(8, "k", "autre")
    assert _titles(store.list_notifications(7, limit=10, before_id=autre)) == ["n4", "n1", "n3", "n2"]
    assert _titles(store.list_notifications(8, limit=10)) == ["autre"]


def _id_of(store, title):
    return next(r["id"] for r in store.list_notifications(7, limit=10) if r["title"] == title)
