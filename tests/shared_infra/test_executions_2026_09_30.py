# SPDX-License-Identifier: MIT
"""Exécutions (L5.2) : la table ``runs``, sa migration et l'enregistreur
``run_scope`` — ligne écrite au début puis à la fin, statut, agrégats,
exécution fille, échantillons de la sandbox."""
from __future__ import annotations

import asyncio
import sqlite3

import pytest

from shared_infra.observability import runs as R


@pytest.fixture()
def db(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    legacy.init_db()
    return legacy


async def _attendre_ecriture(run_id, statut, delai=5.0):
    fin = asyncio.get_running_loop().time() + delai
    while True:
        r = await asyncio.to_thread(R.get_run, run_id)
        if r and r["status"] == statut:
            return r
        assert asyncio.get_running_loop().time() < fin, r
        await asyncio.sleep(0.01)


async def test_ligne_ecrite_au_debut_puis_a_la_fin(db):
    async with R.run_scope("chat", run_id="chat-abc", user_id=1, chat_id="c1",
                           model="m", engine="builtin", sample_sandbox=False) as e:
        assert R.current_run() is e and R.current_run_id() == "chat-abc"
        debut = await _attendre_ecriture("chat-abc", "running")
        assert debut["ended_at"] is None
        e.add_usage(source="chat", status="ok", input_tokens=100, output_tokens=40,
                    cache_read_tokens=30, thinking_tokens=90)
        e.add_llm_call({"prompt_ms": 12.5, "predicted_ms": 300})
        e.add_llm_call(None)
        e.add_wait(7)
        e.add_tool_call("fs", "success")
        e.add_tool_call("fs", "error")
        e.add_tool_call("shell", "timeout")
        e.add_files([{"path": "a.txt"}, {"path": "a.txt"}, "b.txt", {"x": 1}])
    assert R.current_run() is None
    r = await _attendre_ecriture("chat-abc", "ok")
    assert (r["kind"], r["user_id"], r["chat_id"], r["model"], r["engine"]) == \
        ("chat", 1, "c1", "m", "builtin")
    assert (r["input_tokens"], r["output_tokens"], r["cache_read_tokens"]) == (100, 40, 30)
    assert r["thinking_tokens"] == 40                     # réflexion ⊆ sortie
    assert (r["llm_calls"], r["prefill_ms"], r["decode_ms"], r["wait_ms"]) == (2, 12, 300, 7)
    assert (r["tool_calls"], r["tool_errors"]) == (3, 2)
    assert r["tool_families"] == {"fs": 2, "shell": 1}
    assert r["files_changed"] == 2 and r["ended_at"] >= r["started_at"]


async def test_statut_du_dernier_tour_de_la_source_du_proprietaire(db):
    async with R.run_scope("chat", sample_sandbox=False) as e:
        e.add_usage(source="chat", status="tool_limit")
        e.add_usage(source="title", status="ok")          # un titre n'en décide pas
    assert e.status == "tool_limit"
    async with R.run_scope("routine", sample_sandbox=False) as e2:
        e2.add_usage(source="webhook", status="error", error_kind="http_500")
    assert (e2.status, e2.error_kind) == ("error", "http_500")
    async with R.run_scope("compaction", sample_sandbox=False) as e3:
        e3.finish("ok")                                   # posé par le propriétaire
        e3.add_usage(source="compression", status="error")
    assert e3.status == "ok"
    async with R.run_scope("chat", sample_sandbox=False) as e4:
        pass
    assert e4.status == "ok"                              # aucun tour LLM


async def test_une_exception_donne_error_ou_cancelled(db):
    with pytest.raises(RuntimeError):
        async with R.run_scope("chat", sample_sandbox=False) as e:
            raise RuntimeError("x")
    assert e.status == "error"
    with pytest.raises(asyncio.CancelledError):
        async with R.run_scope("chat", sample_sandbox=False) as e2:
            raise asyncio.CancelledError()
    assert e2.status == "cancelled"
    await _attendre_ecriture(e2.id, "cancelled")


async def test_execution_fille_et_echantillons(db, monkeypatch):
    import shared_infra.sandbox.executors as ex
    appels = []

    async def stats(uid):
        appels.append(uid)
        return {"cpu_pct": 150.0 if len(appels) == 1 else 20.0, "mem_mb": 300.0 + len(appels)}
    monkeypatch.setattr(ex, "running_container_stats", stats)
    monkeypatch.setattr(R, "ECHANTILLON_S", 0.01)
    async with R.run_scope("chat", user_id=7) as parent:
        async with R.run_scope("subagent", chat_id="c#task-t1") as fille:
            assert fille.parent_id == parent.id and fille.kind == "subagent"
            n = len(appels)
            await asyncio.sleep(0.1)
            assert len(appels) > n                        # seul le parent échantillonne
        async with R.run_scope("subagent", parent_id="") as orpheline:
            assert orpheline.parent_id == ""
    assert appels and set(appels) == {7}
    assert parent.sandbox_cpu_peak == 150.0 and parent.sandbox_mem_peak_mb >= 302.0
    assert fille.sandbox_cpu_peak is None
    nb = len(appels)
    await asyncio.sleep(0.05)
    assert len(appels) == nb                              # échantillonnage arrêté


async def test_ecriture_perdue_ne_casse_rien(db, monkeypatch):
    def boum(row):
        raise RuntimeError("base indisponible")
    monkeypatch.setattr(R, "upsert_run", boum)
    async with R.run_scope("chat", sample_sandbox=False) as e:
        e.add_usage(source="chat", status="ok", input_tokens=1)
    assert e.status == "ok"
    assert R.upsert_run is boum


def test_identifiants_et_purge(db):
    assert R.new_run_id("chat", "0123abcd") == "chat-0123abcd"
    assert R.new_run_id("routine").startswith("routine-") and len(R.new_run_id("x")) == 18
    import time
    vieux = R.Execution(id="chat-vieux", kind="chat", started_at=time.time() - 100 * 86400)
    vieux.finish("ok")
    recent = R.Execution(id="chat-recent", kind="chat")
    recent.finish("ok")
    assert R.upsert_run(vieux.row()) and R.upsert_run(recent.row())
    assert R.purge_runs(0) == 0
    assert R.purge_runs(90) == 1
    assert R.get_run("chat-vieux") is None and R.get_run("chat-recent")


def test_memoire_du_conteneur_en_mio():
    from shared_infra.sandbox.executors._user_sandbox import _mib
    assert _mib("512MiB") == 512.0
    assert _mib("1.5GiB") == 1536.0
    assert round(_mib("1000kB"), 4) == round(1e6 / 1048576, 4)
    assert _mib("12B") == pytest.approx(12 / 1048576)
    assert _mib("n/a") is None and _mib("") is None


@pytest.mark.sqlite_only
def test_migration_0021_sur_une_base_ancienne(tmp_path):
    import importlib
    m = importlib.import_module("shared_infra.db._migrations.0021_runs")
    con = sqlite3.connect(tmp_path / "ancienne.db")
    con.execute("CREATE TABLE usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, "
                "ts REAL NOT NULL, user_id INTEGER, source TEXT NOT NULL DEFAULT 'unknown')")
    con.execute("CREATE TABLE tool_call_metrics (id INTEGER PRIMARY KEY AUTOINCREMENT, "
                "run_id TEXT NOT NULL, user_id INTEGER NOT NULL, tool_name TEXT NOT NULL, "
                "ts REAL NOT NULL)")
    con.execute("INSERT INTO usage_events(ts, user_id) VALUES (1, 1)")
    for _ in range(2):                                    # idempotente
        m.migrate(con)
    cols = {t: {r[1] for r in con.execute(f"PRAGMA table_info({t})")}
            for t in ("usage_events", "tool_call_metrics", "runs")}
    assert "run_id" in cols["usage_events"]
    assert {"call_id", "started_at", "category", "exit_code", "args_bytes",
            "result_bytes"} <= cols["tool_call_metrics"]
    assert {"id", "kind", "status", "prefill_ms", "sandbox_mem_peak_mb"} <= cols["runs"]
    assert con.execute("SELECT run_id FROM usage_events").fetchone() == ("",)


# ── Relecture L5 (2026-09-30) ────────────────────────────────────────────────

async def test_entree_sans_attente_et_ecritures_dans_l_ordre(db, monkeypatch):
    """L'écriture initiale n'est plus attendue (un Stop pendant elle laissait
    le flux du chat ouvert) ; plus lente que la finale, elle ne la remplace
    pas (l'exécution restait « running »)."""
    import time
    vrai = R.upsert_run
    ordre: list = []

    def lente(row):
        if row["status"] == "running":
            time.sleep(0.4)
        ordre.append(row["status"])
        return vrai(row)
    monkeypatch.setattr(R, "upsert_run", lente)
    t = time.monotonic()
    async with R.run_scope("chat", run_id="chat-ord", user_id=1, sample_sandbox=False) as e:
        assert time.monotonic() - t < 0.2                   # entrée sans attente
        e.add_usage(source="chat", status="ok", input_tokens=1)
    await asyncio.sleep(0.8)
    r = await asyncio.to_thread(R.get_run, "chat-ord")
    assert r["status"] == "ok", ordre


def test_executions_perdues_marquees(db):
    import time
    R.upsert_run({"id": "chat-vieux", "kind": "chat", "status": "running",
                  "started_at": time.time() - 2 * R.RUNNING_STALE_S})
    R.upsert_run({"id": "chat-recent", "kind": "chat", "status": "running",
                  "started_at": time.time()})
    assert R.mark_lost_runs() == 1
    assert R.get_run("chat-vieux")["status"] == "lost"
    assert R.get_run("chat-recent")["status"] == "running"


def test_index_des_executions_utilises(db):
    """Index simples : ``WHERE run_id = ?`` et ``WHERE parent_id = ?`` ne
    parcourent pas toute la table (un index partiel ne servait pas)."""
    with db.db_conn() as c:
        for sql in ("SELECT * FROM usage_events WHERE run_id = ?",
                    "SELECT * FROM runs WHERE parent_id = ?"):
            plan = " ".join(str(tuple(x)) for x in c.execute("EXPLAIN QUERY PLAN " + sql, ("x",)))
            assert "USING INDEX" in plan, (sql, plan)


def test_cache_des_lignes_sans_moteur_hors_entree(db):
    """Avant L5.1 le moteur n'était pas noté et seul Anthropic remplissait
    le cache, hors de l'entrée (le taux dépassait 100 %). La migration 0025
    ramène ces lignes au sens commun : cache compris dans l'entrée."""
    import importlib
    import time

    from shared_infra.observability import usage_store as U
    with db.db_conn() as c:
        c.execute("INSERT INTO usage_events(ts, source, connector, input_tokens, submitted_tokens, "
                  "cache_read_tokens) VALUES(?, 'chat', '', 1000, 1000, 9000)", (time.time(),))
        importlib.import_module("shared_infra.db._migrations.0025_usage_entree_inclusive").migrate(c)
        c.commit()
    tot = U.usage_cache_totals(time.time() - 60)
    assert tot["input_total"] == 10000 and tot["cache_read_tokens"] == 9000

