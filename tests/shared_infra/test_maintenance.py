# SPDX-License-Identifier: MIT
"""
tests/shared_infra/test_maintenance.py — passe d'entretien périodique (uptime
longue durée).

Couvre :
  • les purges des trois tables de télémétrie (âge + désactivation par rétention=0) ;
  • le fait qu'un run de routine ENCORE en cours n'est jamais purgé ;
  • ``run_maintenance_once`` : enchaîne les purges et reste best-effort (une purge
    qui explose n'empêche pas les autres ni ne lève).

DB isolée : on patche ``shared_infra.db._connection.DB_PATH`` vers un fichier tmp
(même recette que les autres tests DB).
"""
from __future__ import annotations

import time

import pytest

DAY = 86400.0


@pytest.fixture()
def env(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    from shared_infra.db._connection import db_conn
    with db_conn() as c:
        c.execute("CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT)")
        c.execute("INSERT INTO users(id, username) VALUES(1, 'alice')")
        # metric_events : schéma identique à _legacy.init_db (pas de FK).
        c.execute(
            "CREATE TABLE IF NOT EXISTS metric_events("
            "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
            "  event_type TEXT NOT NULL, value REAL, tags_json TEXT,"
            "  created_at REAL NOT NULL)")
        c.commit()
    import shared_infra.observability.tool_metrics_store as am
    import shared_infra.observability.daily_reports_store as dr
    import shared_infra.scheduling.routines_store as rt
    am.init_tool_metrics_db()
    rt.init_routines_db()
    dr.init_daily_reports_db()
    return legacy, am, rt


def _insert_tcm(legacy, ts):
    with legacy.db_conn() as c:
        c.execute(
            "INSERT INTO tool_call_metrics(run_id,user_id,tool_name,status,duration_ms,ts)"
            " VALUES(?,?,?,?,?,?)", ("run", 1, "shell", "success", 1, ts))
        c.commit()


def _insert_metric(legacy, ts):
    with legacy.db_conn() as c:
        c.execute("INSERT INTO metric_events(event_type,value,created_at) VALUES('total_tokens',1,?)", (ts,))
        c.commit()


def _mk_routine(rt):
    return rt.create_routine(1, name="r1", cron_expr="* * * * *", model=None,
                             system_prompt="", task_prompt="x",
                             mcp_servers=[], thinking_mode=False, enabled=True)


def _insert_run(legacy, rid, started_at, status):
    with legacy.db_conn() as c:
        c.execute(
            'INSERT INTO editor_routine_runs(routine_id,owner_user_id,status,"trigger",started_at)'
            " VALUES(?,?,?,?,?)", (rid, 1, status, "schedule", started_at))
        c.commit()


def _count(legacy, table):
    with legacy.db_conn() as c:
        return c.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]


# ── startup cleanup : honore la rétention CONFIGURÉE ──────────────────────────
def test_startup_cleanup_honore_retention_configuree(env, monkeypatch):
    """Régression 2026-07-18 : ``_run_startup_cleanup`` appelait
    ``purge_old_metrics()`` SANS argument → défaut codé en dur 90 j, ignorant
    ``METRICS_RETENTION_DAYS`` → à CHAQUE redémarrage il supprimait des
    métriques qu'un admin voulait garder plus longtemps."""
    legacy, _, _ = env
    now = time.time()
    _insert_metric(legacy, now - 200 * DAY)   # 200 j : à GARDER sous rétention 365
    _insert_metric(legacy, now - 400 * DAY)   # 400 j : à purger
    monkeypatch.setattr(legacy, "METRICS_RETENTION_DAYS", 365)
    # wal_checkpoint peut échouer hors WAL réel → neutralisé (hors périmètre).
    monkeypatch.setattr(legacy, "wal_checkpoint", lambda: None)
    legacy._run_startup_cleanup()
    with legacy.db_conn() as c:
        ages = sorted(int((now - r[0]) / DAY) for r in
                      c.execute("SELECT created_at FROM metric_events"))
    assert ages == [200]     # 200 j préservée (rétention 365), 400 j purgée


def test_startup_cleanup_retention_zero_ne_purge_pas(env, monkeypatch):
    legacy, _, _ = env
    _insert_metric(legacy, time.time() - 999 * DAY)
    monkeypatch.setattr(legacy, "METRICS_RETENTION_DAYS", 0)   # 0 = illimité
    monkeypatch.setattr(legacy, "wal_checkpoint", lambda: None)
    legacy._run_startup_cleanup()
    assert _count(legacy, "metric_events") == 1               # rien supprimé


# ── tool_call_metrics ────────────────────────────────────────────────────────
def test_purge_tool_call_metrics_age(env):
    legacy, am, _ = env
    now = time.time()
    _insert_tcm(legacy, now - 200 * DAY)   # ancien → supprimé
    _insert_tcm(legacy, now)               # récent → gardé
    assert am.purge_tool_call_metrics(90) == 1
    assert _count(legacy, "tool_call_metrics") == 1


def test_purge_tool_call_metrics_disabled_is_noop(env):
    legacy, am, _ = env
    _insert_tcm(legacy, time.time() - 999 * DAY)
    assert am.purge_tool_call_metrics(0) == 0      # rétention 0 = désactivé
    assert _count(legacy, "tool_call_metrics") == 1


# ── editor_routine_runs ───────────────────────────────────────────────────────
def test_purge_routine_runs_keeps_running_and_recent(env):
    legacy, _, rt = env
    rid = _mk_routine(rt)
    now = time.time()
    _insert_run(legacy, rid, now - 300 * DAY, "ok")        # ancien terminé → supprimé
    _insert_run(legacy, rid, now - 300 * DAY, "running")   # ancien EN COURS → gardé
    _insert_run(legacy, rid, now, "ok")                    # récent → gardé
    assert rt.purge_routine_runs(180) == 1
    with legacy.db_conn() as c:
        statuses = sorted(r[0] for r in
                          c.execute("SELECT status FROM editor_routine_runs").fetchall())
    assert statuses == ["ok", "running"]


def test_purge_routine_runs_disabled_is_noop(env):
    legacy, _, rt = env
    rid = _mk_routine(rt)
    _insert_run(legacy, rid, time.time() - 999 * DAY, "ok")
    assert rt.purge_routine_runs(0) == 0
    assert _count(legacy, "editor_routine_runs") == 1


# ── run_maintenance_once ──────────────────────────────────────────────────────
def test_run_maintenance_once_purges_all_tables(env, monkeypatch):
    legacy, am, rt = env
    import shared_infra.config as cfg
    monkeypatch.setattr(cfg, "METRICS_RETENTION_DAYS", 90)
    monkeypatch.setattr(cfg, "TOOL_METRICS_RETENTION_DAYS", 90)
    monkeypatch.setattr(cfg, "ROUTINE_RUNS_RETENTION_DAYS", 180)
    now = time.time()
    _insert_metric(legacy, now - 200 * DAY); _insert_metric(legacy, now)
    _insert_tcm(legacy, now - 200 * DAY); _insert_tcm(legacy, now)
    rid = _mk_routine(rt)
    _insert_run(legacy, rid, now - 300 * DAY, "ok"); _insert_run(legacy, rid, now, "ok")
    # Dédup webhook : une livraison périmée (> TTL 24 h) + une fraîche — la
    # purge au fil de l'eau ne tourne que sur livraison, la maintenance doit
    # ramasser derrière.
    from shared_infra.db._connection import db_conn
    with db_conn() as conn:
        conn.executemany(
            "INSERT INTO editor_webhook_deliveries(delivery_id, routine_id, received_at) "
            "VALUES(?,?,?)",
            [("vieille", rid, now - 3 * DAY), ("fraiche", rid, now)])
        conn.commit()

    from shared_infra.ops.maintenance import run_maintenance_once
    out = run_maintenance_once()
    assert out == {"metric_events": 1, "usage_events": 0, "tool_call_metrics": 1,
                   "routine_runs": 1, "daily_reports": 0,
                   "webhook_deliveries": 1,
                   # passe 3 2026-08-31 : session_messages rejoint la passe
                   # d'entretien (rien à purger dans cette fixture).
                   "session_messages": 0,
                   # ancres du ciblage desktop (table vide ici).
                   "action_cache": 0}
    assert _count(legacy, "metric_events") == 1
    assert _count(legacy, "tool_call_metrics") == 1
    assert _count(legacy, "editor_routine_runs") == 1
    assert _count(legacy, "editor_webhook_deliveries") == 1


def test_run_maintenance_once_is_exception_safe(env, monkeypatch):
    """Une purge qui lève ne doit ni stopper les autres ni faire crasher la passe
    (sinon une exception transitoire couperait l'entretien jusqu'au reboot)."""
    legacy, am, rt = env
    import shared_infra.config as cfg
    monkeypatch.setattr(cfg, "METRICS_RETENTION_DAYS", 90)
    monkeypatch.setattr(cfg, "TOOL_METRICS_RETENTION_DAYS", 90)
    monkeypatch.setattr(cfg, "ROUTINE_RUNS_RETENTION_DAYS", 180)

    import shared_infra.observability.tool_metrics_store as am_mod

    def boom(*a, **k):
        raise RuntimeError("boom")

    monkeypatch.setattr(am_mod, "purge_tool_call_metrics", boom)
    now = time.time()
    _insert_metric(legacy, now - 200 * DAY)   # purgé AVANT l'explosion de la purge tool

    from shared_infra.ops.maintenance import run_maintenance_once
    out = run_maintenance_once()              # ne doit pas lever
    assert out["metric_events"] == 1          # a tourné malgré le boom suivant
    assert out["tool_call_metrics"] == 0      # avalé proprement


# ── session_messages (passe 3 2026-08-31) ─────────────────────────────────────
def test_purge_session_messages_age_et_noop(env):
    """La dernière table à croissance non bornée rejoint la passe d'entretien :
    les lignes plus vieilles que la rétention partent (le trigger sm_ad nettoie
    l'index FTS5), les récentes restent, et 0 = conservation illimitée."""
    legacy, _, _ = env
    from shared_infra.memory import store as ms
    ms.init_memory_db()
    now = time.time()
    with legacy.db_conn() as c:
        from shared_infra.db._dialect import insert_id
        uid = insert_id(c.cursor(), "INSERT INTO users(username) VALUES('u_sm')")
        c.commit()
    assert ms.session_index_message(
        user_id=uid, app="chat", session_id="s1", scope_key="", role="user",
        content="vieux message", ts=now - 300 * DAY) > 0
    assert ms.session_index_message(
        user_id=uid, app="chat", session_id="s1", scope_key="", role="user",
        content="message récent", ts=now) > 0
    assert ms.purge_session_messages(0) == 0            # désactivé = no-op
    assert ms.purge_session_messages(180) == 1
    with legacy.db_conn() as c:
        rows = c.execute("SELECT content FROM session_messages").fetchall()
    assert [r[0] for r in rows] == ["message récent"]
    # L'index FTS ne retrouve plus le contenu purgé.
    assert all("vieux" not in (r.get("content") or "")
               for r in ms.session_search_fts(uid, "vieux"))
