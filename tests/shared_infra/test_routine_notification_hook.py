# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_routine_notification_hook.py — émission de notif sur fin de run.

Vérifie que ``_emit_run_notification`` (appelé par le scheduler aux points
``mark_run_ok``/``mark_run_error``) crée bien une notification du bon ``kind`` pour
le bon utilisateur, et qu'une erreur interne ne se propage jamais (best-effort).
"""
from __future__ import annotations

import importlib

import pytest


@pytest.fixture()
def env(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    # publish_event écrit dans /tmp : on le neutralise pour ne pas polluer.
    import shared_infra.observability.metrics.broadcast as broadcast
    monkeypatch.setattr(broadcast, "publish_event", lambda payload: None)
    from shared_infra.db._connection import db_conn
    with db_conn() as conn:
        conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT)")
        conn.execute("INSERT INTO users(id, username) VALUES (1,'alice')")
        mod = importlib.import_module(
            "shared_infra.db._migrations.0005_notifications_table")
        mod.migrate(conn)
        conn.commit()
    import shared_infra.notifications.store as notif
    import shared_infra.scheduling.routines_scheduler as sched
    return sched, notif


def test_emit_success_notification(env):
    sched, notif = env
    sched._emit_run_notification(1, 7, "Daily report", ok=True, detail="résumé")
    items = notif.list_notifications(1)
    assert len(items) == 1
    assert items[0]["kind"] == "routine_ok"
    assert items[0]["ref_type"] == "routine" and items[0]["ref_id"] == 7
    assert "Daily report" in items[0]["title"]


def test_emit_error_notification(env):
    sched, notif = env
    sched._emit_run_notification(1, 9, "Backup", ok=False, detail="RuntimeError: boom")
    items = notif.list_notifications(1)
    assert items[0]["kind"] == "routine_error"
    assert "boom" in items[0]["body"]


def test_emit_never_raises_on_internal_error(env, monkeypatch):
    sched, notif = env
    # Si la couche DB lève, l'émission doit avaler l'erreur (best-effort).
    monkeypatch.setattr(
        "shared_infra.notifications.store.create_notification",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("db down")),
    )
    sched._emit_run_notification(1, 1, "X", ok=True, detail="")  # ne doit pas lever


# ─────────────────────────────────────────────────────────────────────────────
#  Politique de notification PAR ROUTINE (2026-09-08) : ``notify_on`` filtre,
#  ``notify_keep`` borne — appliqués par ``_notify_run_end`` AU-DESSUS de
#  ``_emit_run_notification`` (dont la signature, stubbée partout, ne bouge pas).
# ─────────────────────────────────────────────────────────────────────────────
def test_notify_wanted_policy_table(env):
    sched, _ = env
    base = {"id": 1, "owner_user_id": 1, "name": "A"}
    assert sched._notify_wanted(base, ok=True) and sched._notify_wanted(base, ok=False)
    assert sched._notify_wanted({**base, "notify_on": "all"}, ok=True)
    assert not sched._notify_wanted({**base, "notify_on": "error"}, ok=True)
    assert sched._notify_wanted({**base, "notify_on": "error"}, ok=False)
    assert not sched._notify_wanted({**base, "notify_on": "none"}, ok=True)
    assert not sched._notify_wanted({**base, "notify_on": "none"}, ok=False)
    # valeur inconnue / casse → défaut 'all' (même normalisation que le store)
    assert sched._notify_wanted({**base, "notify_on": "bizarre"}, ok=True)
    assert not sched._notify_wanted({**base, "notify_on": " ERROR "}, ok=True)


async def test_notify_run_end_respects_policy(env):
    sched, notif = env
    base = {"id": 7, "owner_user_id": 1, "name": "Daily"}
    await sched._notify_run_end({**base, "notify_on": "none"}, 1, ok=True, detail="")
    await sched._notify_run_end({**base, "notify_on": "none"}, 1, ok=False, detail="")
    await sched._notify_run_end({**base, "notify_on": "error"}, 1, ok=True, detail="")
    assert notif.list_notifications(1) == []
    await sched._notify_run_end({**base, "notify_on": "error"}, 1, ok=False, detail="boom")
    items = notif.list_notifications(1)
    assert [n["kind"] for n in items] == ["routine_error"] and "boom" in items[0]["body"]
    await sched._notify_run_end({**base, "notify_on": "all"}, 1, ok=True, detail="")
    await sched._notify_run_end(base, 1, ok=True, detail="")            # défaut = all
    assert len(notif.list_notifications(1)) == 3


async def test_notify_keep_caps_per_routine_only(env):
    sched, notif = env
    a = {"id": 7, "owner_user_id": 1, "name": "A", "notify_keep": 2}
    b = {"id": 8, "owner_user_id": 1, "name": "B"}                       # 0 = pas de cap dédié
    for i in range(5):
        await sched._notify_run_end(a, 1, ok=(i % 2 == 0), detail=str(i))
    for i in range(3):
        await sched._notify_run_end(b, 1, ok=True, detail=str(i))
    items = notif.list_notifications(1)
    assert [n["body"] for n in items if n["ref_id"] == 7] == ["4", "3"]   # les 2 plus récentes
    assert len([n for n in items if n["ref_id"] == 8]) == 3
    # un keep non entier → traité comme 0 (rien purgé), jamais une exception
    await sched._notify_run_end({**b, "notify_keep": "abc"}, 1, ok=True, detail="x")
    assert len([n for n in notif.list_notifications(1) if n["ref_id"] == 8]) == 4


async def test_notify_run_end_keeps_emitter_contract(env, monkeypatch):
    """Le contrat ``_emit_run_notification(uid, rid, name, *, ok, detail)`` est
    celui que stubbent tous les tests de l'exécuteur : il ne doit pas bouger."""
    sched, _ = env
    seen = []
    monkeypatch.setattr(sched, "_emit_run_notification",
                        lambda uid, rid, name, *, ok, detail: seen.append((uid, rid, name, ok, detail)))
    await sched._notify_run_end({"id": 3, "owner_user_id": 1, "name": "N"}, 1, ok=True, detail="d")
    assert seen == [(1, 3, "N", True, "d")]


def test_emit_title_matches_shared_helper(env):
    """Le titre vient de ``routine_notification_title`` (source unique partagée
    avec le renommage) — sinon un renommage produirait des titres d'une autre forme."""
    sched, notif = env
    from shared_infra.scheduling.routines_store import routine_notification_title
    sched._emit_run_notification(1, 7, "Daily report", ok=True, detail="")
    sched._emit_run_notification(1, 7, "", ok=False, detail="")
    titles = {n["kind"]: n["title"] for n in notif.list_notifications(1)}
    assert titles["routine_ok"] == routine_notification_title("Daily report", 7, ok=True)
    assert titles["routine_error"] == routine_notification_title("", 7, ok=False) == "Routine « Routine #7 » en échec"


def test_prune_ref_notifications_store(env):
    _, notif = env
    for i in range(4):
        notif.create_notification(1, "routine_ok", f"t{i}", ref_type="routine", ref_id=5)
    notif.create_notification(1, "routine_ok", "autre", ref_type="routine", ref_id=6)
    assert notif.prune_ref_notifications(1, "routine", 5, 0) == 0          # 0 = no-op
    assert notif.prune_ref_notifications(1, "routine", 5, "x") == 0        # garbage = no-op
    assert notif.prune_ref_notifications(2, "routine", 5, 1) == 0          # tenant-gated
    assert notif.prune_ref_notifications(1, "routine", 5, 2) == 2
    left = notif.list_notifications(1)
    assert [n["title"] for n in left] == ["autre", "t3", "t2"]
