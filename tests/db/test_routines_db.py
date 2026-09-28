# SPDX-License-Identifier: MIT
"""
tests/db/test_routines_db.py — couche DB des routines planifiées.

Couvre la correction de concurrence (admission cap atomique sous threads,
claim par minute, garde de statut sur mark_run_*), l'isolation tenant, la
réconciliation par heartbeat et le CASCADE delete.

DB isolée : on patche ``shared_infra.db._connection.DB_PATH`` vers un fichier tmp et
on crée une table ``users`` minimale (FK).
"""
from __future__ import annotations

import threading
import time

import pytest


@pytest.fixture()
def R(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    from shared_infra.db._connection import db_conn
    with db_conn() as conn:
        conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT)")
        conn.executemany("INSERT INTO users(id, username) VALUES (?,?)",
                         [(1, "alice"), (2, "bob")])
        conn.commit()
    import shared_infra.scheduling.routines_store as routines
    routines.init_routines_db()
    return routines


def _mk(R, owner=1, name="r1", cron="* * * * *"):
    return R.create_routine(owner, name=name, cron_expr=cron, model=None,
                            system_prompt="", task_prompt="do it",
                            mcp_servers=[], thinking_mode=False, enabled=True)


def test_init_idempotent(R):
    R.init_routines_db()  # second call must not raise
    assert R.list_routines(1) == []


def test_strip_mcp_secrets_on_create(R):
    rid = R.create_routine(
        1, name="s", cron_expr="0 9 * * *", model=None, system_prompt="",
        task_prompt="t", thinking_mode=False, enabled=True,
        mcp_servers=[{"type": "sse", "name": "x", "url": "http://h",
                      "auth": "Bearer SECRET", "headers": {"k": "v"},
                      "filter_categories": ["a"]}])
    snap = R.get_routine(rid, 1)["mcp_snapshot"]
    assert snap[0]["url"] == "http://h"
    assert snap[0]["filter_categories"] == ["a"]
    assert "auth" not in snap[0] and "headers" not in snap[0]


def test_crud_owner_isolation(R):
    rid = _mk(R, owner=1)
    # bob (user 2) ne voit/touche rien de alice (user 1)
    assert R.get_routine(rid, 2) is None
    assert R.update_routine(rid, 2, name="hacked") is False
    assert R.set_routine_enabled(rid, 2, False) is False
    assert R.delete_routine(rid, 2) is False
    # alice oui
    assert R.get_routine(rid, 1)["name"] == "r1"
    assert R.update_routine(rid, 1, name="renamed") is True
    assert R.get_routine(rid, 1)["name"] == "renamed"


def test_admit_cap_atomic_under_threads(R):
    rid = _mk(R, owner=1)
    cap = 5
    n_threads = 12
    results = []
    lock = threading.Lock()
    barrier = threading.Barrier(n_threads)

    def worker():
        barrier.wait()  # maximise la contention
        run_id = R.admit_and_insert_run(rid, 1, trigger="schedule",
                                        cap=cap, worker_boot_id="t")
        with lock:
            results.append(run_id)

    threads = [threading.Thread(target=worker) for _ in range(n_threads)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    admitted = [r for r in results if r is not None]
    assert len(admitted) == cap                      # jamais plus que le cap
    with R.db_conn() as conn:
        n = conn.execute("SELECT COUNT(*) FROM editor_routine_runs "
                         "WHERE owner_user_id=1 AND status='running'").fetchone()[0]
    assert n == cap
    assert len(set(admitted)) == cap                 # run_ids distincts


def test_admit_releases_slot_after_completion(R):
    rid = _mk(R, owner=1)
    ids = [R.admit_and_insert_run(rid, 1, trigger="schedule", cap=2, worker_boot_id="t")
           for _ in range(3)]
    assert ids[0] and ids[1] and ids[2] is None       # 3e refusé (cap=2)
    assert R.mark_run_ok(ids[0], output_tokens=3, summary="ok") is True
    # un slot libéré → admission de nouveau possible
    assert R.admit_and_insert_run(rid, 1, trigger="schedule", cap=2, worker_boot_id="t") is not None


def test_cap_is_per_user(R):
    r1 = _mk(R, owner=1)
    r2 = _mk(R, owner=2, name="r2")
    assert R.admit_and_insert_run(r1, 1, trigger="schedule", cap=1, worker_boot_id="t")
    assert R.admit_and_insert_run(r1, 1, trigger="schedule", cap=1, worker_boot_id="t") is None
    # user 2 a son propre cap
    assert R.admit_and_insert_run(r2, 2, trigger="schedule", cap=1, worker_boot_id="t")


def test_claim_minute_fire_idempotent(R):
    rid = _mk(R, owner=1)
    assert R.claim_minute_fire(rid, "2026-06-04T10:00") is True
    assert R.claim_minute_fire(rid, "2026-06-04T10:00") is False   # même minute
    assert R.claim_minute_fire(rid, "2026-06-04T10:01") is True    # minute suivante


def test_mark_run_ok_guards_status(R):
    rid = _mk(R, owner=1)
    run_id = R.admit_and_insert_run(rid, 1, trigger="manual", cap=5, worker_boot_id="t")
    assert R.mark_run_ok(run_id, output_tokens=1, summary="done") is True
    assert R.mark_run_ok(run_id, output_tokens=1, summary="again") is False  # plus 'running'


def test_reconcile_orphans_by_heartbeat(R):
    rid = _mk(R, owner=1)
    stale = R.admit_and_insert_run(rid, 1, trigger="schedule", cap=5, worker_boot_id="t")
    fresh = R.admit_and_insert_run(rid, 1, trigger="schedule", cap=5, worker_boot_id="t")
    # rend 'stale' périmé
    import shared_infra.db._connection as legacy
    from shared_infra.db._connection import db_conn
    with db_conn() as conn:
        conn.execute("UPDATE editor_routine_runs SET heartbeat_at=? WHERE id=?",
                     (time.time() - 10_000, stale))
        conn.commit()
    n = R.reconcile_orphans(stale_after_s=300.0)
    assert n == 1
    runs = {r["id"]: r["status"] for r in R.list_runs(rid, 1)}
    assert runs[stale] == "orphaned"
    assert runs[fresh] == "running"
    # le run réconcilié ne peut plus être marqué ok
    assert R.mark_run_ok(stale, summary="x") is False


def test_skills_roundtrip_and_sanitize(R):
    # Défaut : pas de skills → [].
    rid = _mk(R)
    assert R.get_routine(rid, 1)["skills"] == []
    # Sanitize : non-strings ignorés, blancs strippés/écartés, dédup (ordre gardé).
    rid2 = R.create_routine(
        1, name="s", cron_expr="0 9 * * *", model=None, system_prompt="",
        task_prompt="t", mcp_servers=[], thinking_mode=False, enabled=True,
        skills=["jenkins/deploy", " veille ", "jenkins/deploy", "", 42, None])
    assert R.get_routine(rid2, 1)["skills"] == ["jenkins/deploy", "veille"]
    by_id = {r["id"]: r for r in R.list_routines(1)}
    assert by_id[rid2]["skills"] == ["jenkins/deploy", "veille"]
    assert by_id[rid]["skills"] == []


def test_skills_update(R):
    rid = _mk(R)
    assert R.update_routine(rid, 1, skills=["a", "b"]) is True
    assert R.get_routine(rid, 1)["skills"] == ["a", "b"]
    # Vider la sélection est une mise à jour légitime.
    assert R.update_routine(rid, 1, skills=[]) is True
    assert R.get_routine(rid, 1)["skills"] == []
    # Champ absent = inchangé.
    assert R.update_routine(rid, 1, skills=["x"], name="n2") is True
    assert R.update_routine(rid, 1, name="n3") is True
    assert R.get_routine(rid, 1)["skills"] == ["x"]


@pytest.mark.sqlite_only       # table ancienne créée en DDL SQLite brut
def test_init_adds_skills_column_to_legacy_table(tmp_path, monkeypatch):
    """Base créée AVANT le champ skills : init_routines_db doit ALTER (migration
    douce) sans toucher aux lignes existantes."""
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "old.db"))
    from shared_infra.db._connection import db_conn
    with db_conn() as conn:
        conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT)")
        conn.execute("INSERT INTO users(id, username) VALUES (1, 'alice')")
        conn.execute("""
        CREATE TABLE editor_routines (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_user_id    INTEGER NOT NULL,
            name             TEXT    NOT NULL,
            cron_expr        TEXT    NOT NULL,
            model            TEXT    DEFAULT NULL,
            system_prompt    TEXT    NOT NULL DEFAULT '',
            task_prompt      TEXT    NOT NULL DEFAULT '',
            mcp_snapshot     TEXT    NOT NULL DEFAULT '[]',
            thinking_mode    INTEGER NOT NULL DEFAULT 0,
            enabled          INTEGER NOT NULL DEFAULT 1,
            created_at       REAL    NOT NULL,
            updated_at       REAL    NOT NULL,
            last_fire_minute TEXT    DEFAULT NULL,
            FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE CASCADE
        );""")
        conn.execute("INSERT INTO editor_routines(owner_user_id, name, cron_expr, "
                     "created_at, updated_at) VALUES (1, 'r', '* * * * *', 0, 0)")
        conn.commit()
    import shared_infra.scheduling.routines_store as routines
    routines.init_routines_db()
    r = routines.list_routines(1)[0]
    assert r["skills"] == []                       # défaut sur ligne pré-existante
    assert routines.update_routine(r["id"], 1, skills=["a"]) is True
    assert routines.get_routine(r["id"], 1)["skills"] == ["a"]
    routines.init_routines_db()                    # re-init : idempotent


def test_cascade_delete_reaps_runs(R):
    rid = _mk(R, owner=1)
    R.admit_and_insert_run(rid, 1, trigger="schedule", cap=5, worker_boot_id="t")
    assert len(R.list_runs(rid, 1)) == 1
    assert R.delete_routine(rid, 1) is True
    assert R.get_routine(rid, 1) is None
    assert R.list_runs(rid, 1) == []   # CASCADE


def test_list_runs_owner_gated(R):
    rid = _mk(R, owner=1)
    R.admit_and_insert_run(rid, 1, trigger="schedule", cap=5, worker_boot_id="t")
    assert len(R.list_runs(rid, 1)) == 1
    assert R.list_runs(rid, 2) == []   # bob ne voit pas les runs de alice


# ─────────────────────────────────────────────────────────────────────────────
#  Historique PAR ROUTINE (2026-09-08) : journal borné (runs_keep) + récap
#  (notifications) qui suit la routine — supprimé avec elle, renommé avec elle.
# ─────────────────────────────────────────────────────────────────────────────
def _notif_table():
    """Table ``notifications`` (migration réelle) dans la DB temp du test."""
    import importlib
    from shared_infra.db._connection import db_conn
    from shared_infra.db._dialect import SQLITE, dialect_of
    with db_conn() as conn:
        if dialect_of(conn) == SQLITE:
            importlib.import_module(
                "shared_infra.db._migrations.0005_notifications_table").migrate(conn)
        else:                              # moteur serveur : schéma de référence
            from shared_infra.db._schema import ensure_tables
            ensure_tables(conn, ("notifications",))
        conn.commit()


def test_history_defaults_and_normalization(R):
    rid = _mk(R)
    r = R.get_routine(rid, 1)
    assert (r["runs_keep"], r["notify_on"], r["notify_keep"]) == (0, "all", 0)
    assert R.update_routine(rid, 1, runs_keep=25, notify_on="ERROR", notify_keep=3)
    r = R.get_routine(rid, 1)
    assert (r["runs_keep"], r["notify_on"], r["notify_keep"]) == (25, "error", 3)
    # Hors bornes / inconnu → normalisé, jamais persisté tel quel.
    assert R.update_routine(rid, 1, runs_keep=99999, notify_on="maybe", notify_keep=-4)
    r = R.get_routine(rid, 1)
    assert (r["runs_keep"], r["notify_on"], r["notify_keep"]) == (R.KEEP_MAX, "all", 0)
    # Un booléen n'est pas un compteur (True → 1 serait un arrondi silencieux).
    assert R.update_routine(rid, 1, runs_keep=True, notify_keep="12")
    r = R.get_routine(rid, 1)
    assert (r["runs_keep"], r["notify_keep"]) == (0, 12)
    # create_routine accepte les trois kwargs.
    rid2 = R.create_routine(1, name="h", cron_expr="* * * * *", model=None,
                            system_prompt="", task_prompt="t", mcp_servers=[],
                            runs_keep=2, notify_on="none", notify_keep=1)
    r2 = R.get_routine(rid2, 1)
    assert (r2["runs_keep"], r2["notify_on"], r2["notify_keep"]) == (2, "none", 1)
    # list_routines / list_enabled_routines portent les mêmes champs normalisés.
    assert {x["id"]: x["notify_on"] for x in R.list_routines(1)} == {rid: "all", rid2: "none"}
    assert {x["id"]: x["runs_keep"] for x in R.list_enabled_routines()} == {rid: 0, rid2: 2}


def _run(R, rid, *, status="ok"):
    run = R.admit_and_insert_run(rid, 1, trigger="schedule", cap=10, worker_boot_id="t")
    assert run is not None
    if status == "ok":
        assert R.mark_run_ok(run, summary="s")
    elif status == "error":
        assert R.mark_run_error(run, error="e")
    elif status == "cancelled":
        assert R.mark_run_cancelled(run)
    elif status == "skipped":
        assert R.mark_run_skipped(run, reason="r")
    time.sleep(0.002)   # started_at strictement croissant
    return run


def test_runs_keep_prunes_oldest_finished_runs(R):
    rid = _mk(R)
    R.update_routine(rid, 1, runs_keep=2)
    ids = [_run(R, rid) for _ in range(4)]
    assert [r["id"] for r in R.list_runs(rid, 1)] == [ids[3], ids[2]]   # les 2 plus récents


def test_runs_keep_zero_keeps_everything(R):
    rid = _mk(R)
    ids = [_run(R, rid) for _ in range(5)]
    assert len(R.list_runs(rid, 1)) == 5 and ids


def test_runs_keep_all_terminal_transitions_apply_it(R):
    """Chaque transition terminale (ok / error / cancelled / skipped requalifié /
    skip inséré) applique la borne — pas seulement mark_run_ok."""
    rid = _mk(R)
    R.update_routine(rid, 1, runs_keep=1)
    _run(R, rid, status="ok")
    last = _run(R, rid, status="error")
    assert [r["id"] for r in R.list_runs(rid, 1)] == [last]
    last = _run(R, rid, status="cancelled")
    assert [r["id"] for r in R.list_runs(rid, 1)] == [last]
    last = _run(R, rid, status="skipped")
    assert [r["id"] for r in R.list_runs(rid, 1)] == [last]
    last = R.insert_skipped_run(rid, 1, trigger="schedule", reason="cap")
    assert [r["id"] for r in R.list_runs(rid, 1)] == [last]


def test_runs_keep_never_counts_nor_deletes_running(R):
    rid = _mk(R)
    R.update_routine(rid, 1, runs_keep=1)
    old = _run(R, rid, status="error")
    running = R.admit_and_insert_run(rid, 1, trigger="manual", cap=10, worker_boot_id="t")
    time.sleep(0.002)
    skipped = R.insert_skipped_run(rid, 1, trigger="schedule", reason="cap")
    statuses = {r["id"]: r["status"] for r in R.list_runs(rid, 1)}
    # l'échec ancien est parti (1 terminé gardé = le skip), le run vivant reste
    assert statuses == {running: "running", skipped: "skipped"}
    assert old not in statuses
    # …et quand le run vivant se termine, il entre dans le décompte : « X
    # dernières » suit l'ORDRE DU JOURNAL (started_at desc) — le skip, démarré
    # après lui, est le plus récent et reste seul.
    assert R.mark_run_ok(running, summary="fin")
    assert [r["id"] for r in R.list_runs(rid, 1)] == [skipped]


def test_runs_keep_is_per_routine(R):
    a = _mk(R, name="A")
    b = _mk(R, name="B")
    R.update_routine(a, 1, runs_keep=1)
    for _ in range(3):
        _run(R, a)
        _run(R, b)
    assert len(R.list_runs(a, 1)) == 1
    assert len(R.list_runs(b, 1)) == 3   # B (0 = tout) n'est pas touchée par la borne de A


def test_delete_routine_reaps_its_notifications(R):
    _notif_table()
    from shared_infra.notifications.store import create_notification, list_notifications
    a = _mk(R, name="A")
    b = _mk(R, name="B")
    create_notification(1, "routine_ok", "Routine « A » terminée", ref_type="routine", ref_id=a)
    create_notification(1, "routine_error", "Routine « A » en échec", ref_type="routine", ref_id=a)
    create_notification(1, "routine_ok", "Routine « B » terminée", ref_type="routine", ref_id=b)
    create_notification(1, "daily_report", "Rapport", ref_type="daily_report", ref_id=20260908)
    # bob a une notif portant le MÊME ref_id : elle n'est pas à alice, on n'y touche pas
    create_notification(2, "routine_ok", "Routine « X » terminée", ref_type="routine", ref_id=a)
    assert R.delete_routine(a, 1) is True
    assert sorted(n["title"] for n in list_notifications(1)) == ["Rapport", "Routine « B » terminée"]
    assert [n["title"] for n in list_notifications(2)] == ["Routine « X » terminée"]


def test_rename_routine_retitles_its_notifications(R):
    _notif_table()
    from shared_infra.notifications.store import create_notification, list_notifications
    a = _mk(R, name="Veille")
    b = _mk(R, name="Backup")
    create_notification(1, "routine_ok", R.routine_notification_title("Veille", a, ok=True),
                        ref_type="routine", ref_id=a, body="corps 1")
    create_notification(1, "routine_error", R.routine_notification_title("Veille", a, ok=False),
                        ref_type="routine", ref_id=a)
    create_notification(1, "routine_ok", R.routine_notification_title("Backup", b, ok=True),
                        ref_type="routine", ref_id=b)
    assert R.update_routine(a, 1, name="Veille v2")
    titles = {n["kind"]: n["title"] for n in list_notifications(1) if n["ref_id"] == a}
    assert titles == {"routine_ok": "Routine « Veille v2 » terminée",
                      "routine_error": "Routine « Veille v2 » en échec"}
    # le corps (récap du run) est intact, B n'est pas touchée
    assert [n["body"] for n in list_notifications(1) if n["kind"] == "routine_ok" and n["ref_id"] == a] == ["corps 1"]
    assert [n["title"] for n in list_notifications(1) if n["ref_id"] == b] == ["Routine « Backup » terminée"]
    # un update SANS nom ne réécrit rien
    assert R.update_routine(a, 1, task_prompt="autre")
    assert {n["kind"]: n["title"] for n in list_notifications(1) if n["ref_id"] == a} == titles


def test_notification_title_helper_fallback(R):
    assert R.routine_notification_title("", 12, ok=True) == "Routine « Routine #12 » terminée"
    assert R.routine_notification_title("  Veille ", 12, ok=False) == "Routine « Veille » en échec"


def test_delete_and_rename_without_notifications_table(R):
    """Base SANS table notifications (fixture par défaut) : ni crash ni faux 404."""
    a = _mk(R)
    assert R.update_routine(a, 1, name="n2") is True
    assert R.get_routine(a, 1)["name"] == "n2"
    assert R.delete_routine(a, 1) is True


@pytest.mark.sqlite_only       # table ancienne créée en DDL SQLite brut
def test_init_adds_history_columns_to_legacy_table(tmp_path, monkeypatch):
    """Base d'AVANT les colonnes d'historique : ALTER doux, défauts = tout garder
    + tout notifier (le comportement antérieur), et les champs sont éditables."""
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "old.db"))
    from shared_infra.db._connection import db_conn
    with db_conn() as conn:
        conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT)")
        conn.execute("INSERT INTO users(id, username) VALUES (1, 'alice')")
        conn.execute("""CREATE TABLE editor_routines (
            id INTEGER PRIMARY KEY AUTOINCREMENT, owner_user_id INTEGER NOT NULL,
            name TEXT NOT NULL, cron_expr TEXT NOT NULL, model TEXT DEFAULT NULL,
            system_prompt TEXT NOT NULL DEFAULT '', task_prompt TEXT NOT NULL DEFAULT '',
            mcp_snapshot TEXT NOT NULL DEFAULT '[]', thinking_mode INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1, created_at REAL NOT NULL,
            updated_at REAL NOT NULL, last_fire_minute TEXT DEFAULT NULL)""")
        conn.execute("INSERT INTO editor_routines(owner_user_id, name, cron_expr, "
                     "created_at, updated_at) VALUES (1, 'ancienne', '0 9 * * *', 0, 0)")
        conn.commit()
    import shared_infra.scheduling.routines_store as routines
    routines.init_routines_db()
    r = routines.list_routines(1)[0]
    assert (r["runs_keep"], r["notify_on"], r["notify_keep"]) == (0, "all", 0)
    assert routines.update_routine(r["id"], 1, runs_keep=3, notify_on="error", notify_keep=1)
    r = routines.get_routine(r["id"], 1)
    assert (r["runs_keep"], r["notify_on"], r["notify_keep"]) == (3, "error", 1)
    routines.init_routines_db()                    # re-init : idempotent
