# SPDX-License-Identifier: MIT
"""Affichage des métriques de tokens (2026-10-03) : quatre postes disjoints —
cache et entrée utile (entrée), réflexion et réponse (sortie) — côté serveur.

* découpe commune ``token_breakdown`` et ses bornes ;
* ``/api/usage/me`` : cache, entrée utile, part du cache, découpe par origine ;
* widgets admin : détail des tokens, frise « Entrée — cache vs utile », barres
  par modèle / utilisateur à quatre postes, set par défaut ;
* « Continuer » : métriques du message CUMULÉES sur ses segments ;
* chemin sans outils : relais de la progression du prompt.
"""
from __future__ import annotations

import asyncio
import time

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient


@pytest.fixture()
def db(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    from shared_infra.db._connection import init_db
    init_db()
    from shared_infra.accounts.users import create_user
    assert create_user("alice", "pw-alice-123") == 1
    assert create_user("bob", "pw-bob-123") == 2
    return legacy


def _ligne(user_id=1, source="chat", model="qwen", **kw):
    from shared_infra.observability.usage_store import record_usage
    assert record_usage(user_id=user_id, source=source, model=model, connector="builtin", **kw)


# ── Découpe commune ─────────────────────────────────────────────────────────

def test_token_breakdown_postes_et_bornes():
    from shared_infra.observability.usage_store import token_breakdown
    assert token_breakdown(12345, 1130, cache_read_tokens=11800, thinking_tokens=820,
                           tool_tokens=3200) == {
        "input": 12345, "cache": 11800, "input_new": 545, "cache_creation": 0, "tools": 3200,
        "output": 1130, "thinking": 820, "response": 310, "cache_pct": 95.6}
    assert token_breakdown(100, 0, tool_tokens=500)["tools"] == 100         # outils ≤ entrée
    b = token_breakdown(100, 10, cache_read_tokens=500, thinking_tokens=50)
    assert (b["cache"], b["input_new"], b["thinking"], b["response"]) == (100, 0, 10, 0)
    assert token_breakdown()["cache_pct"] == 0.0
    assert token_breakdown("x", None)["input"] == 0


def test_totaux_portent_l_entree_utile(db):
    from shared_infra.observability.usage_store import usage_totals
    _ligne(input_tokens=1000, output_tokens=100, cache_read_tokens=900, thinking_tokens=60)
    t = usage_totals(time.time() - 60)
    assert (t["cache_read_tokens"], t["input_new_tokens"]) == (900, 100)
    assert (t["thinking_tokens"], t["response_tokens"]) == (60, 40)


# ── /api/usage/me ───────────────────────────────────────────────────────────

@pytest.fixture()
def client(db, monkeypatch):
    import shared_infra.observability.routes_usage as usage_mod
    import shared_infra.observability.tool_metrics_store as am
    import shared_infra.scheduling.routines_store as routines
    am.init_tool_metrics_db()
    routines.init_routines_db()

    def _uid(request: Request):
        uid = request.headers.get("x-test-user")
        if not uid:
            raise HTTPException(401, "auth requise")
        return int(uid)

    monkeypatch.setattr(usage_mod, "require_user_id", _uid)
    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_utilisation_decoupe_entree_et_sortie(client):
    _ligne(input_tokens=10000, output_tokens=1000, cache_read_tokens=9000, thinking_tokens=750,
           tool_tokens=4000)
    _ligne(source="routine", input_tokens=2000, output_tokens=200, cache_read_tokens=0,
           thinking_tokens=0)
    _ligne(user_id=2, input_tokens=99999, output_tokens=1)            # un autre compte
    t = client.get("/api/usage/me?days=7", headers={"x-test-user": "1"}).json()["tokens"]
    assert (t["input"], t["cache"], t["input_new"]) == (12000, 9000, 3000)
    assert t["cache_pct"] == 75.0
    assert (t["output"], t["thinking"], t["response"]) == (1200, 750, 450)
    assert t["tools"] == 4000
    assert t["total"] == 13200
    chat = next(s for s in t["by_source"] if s["source"] == "chat")
    assert (chat["cache"], chat["input_new"], chat["thinking"], chat["response"]) == (9000, 1000, 750, 250)
    assert (chat["input"], chat["output"], chat["tools"]) == (10000, 1000, 4000)
    routine = next(s for s in t["by_source"] if s["source"] == "routine")
    assert (routine["cache"], routine["input_new"], routine["tokens"]) == (0, 2000, 2200)


# ── Widgets admin ───────────────────────────────────────────────────────────

def test_widget_tokens_detaille_cache_et_reflexion(db):
    from shared_infra.observability.metrics._usage_providers import KPIUsageTokensProvider
    _ligne(input_tokens=10000, output_tokens=1000, cache_read_tokens=9000, thinking_tokens=750)
    d = KPIUsageTokensProvider().get_data(scope_hours=24)
    assert d["detail"] == "10 k entrée (cache 90 %) · 1 k sortie (réflexion 75 %)"


def test_format_des_tokens_identique_au_front():
    from shared_infra.observability.metrics._usage_providers import _fmt_tokens
    assert [_fmt_tokens(v) for v in (0, 845, 12345, 14000, 245000, 1234567, None)] == [
        "0", "845", "12,3 k", "14 k", "245 k", "1,2 M", "0"]


def test_frise_entree_cache_vs_utile(db):
    from shared_infra.observability.metrics._usage_providers import UsageInputTimelineProvider
    _ligne(input_tokens=1000, output_tokens=10, cache_read_tokens=800)
    chart = UsageInputTimelineProvider().get_data(24)
    series = {ds["label"]: sum(ds["data"]) for ds in chart["datasets"]}
    assert series == {"Cache": 800, "Utile": 200}


def test_barres_par_modele_et_utilisateur_a_quatre_postes(db):
    from shared_infra.observability.metrics._usage_providers import (
        UsageByModelProvider,
        UsageTopUsersProvider,
    )
    _ligne(model="qwen", input_tokens=1000, output_tokens=100, cache_read_tokens=600, thinking_tokens=40)
    _ligne(user_id=2, model="gemma", input_tokens=500, output_tokens=50)
    m = UsageByModelProvider().get_data(24)
    assert m["labels"] == ["qwen", "gemma"] and m["meta"] == {"horizontal": True}
    assert {ds["label"]: ds["data"] for ds in m["datasets"]} == {
        "Cache": [600, 0], "Entrée utile": [400, 500], "Réflexion": [40, 0], "Réponse": [60, 50]}
    u = UsageTopUsersProvider().get_data(24)
    assert u["labels"] == ["alice", "bob"]


def test_cache_dans_le_set_par_defaut_et_le_rapport():
    from shared_infra.observability.metrics.daily_report import REPORT_WIDGET_IDS
    from shared_infra.observability.metrics.engine import DEFAULT_WIDGETS, registry
    assert {"usage_cache", "usage_input_timeline"} <= DEFAULT_WIDGETS
    assert {"usage_cache", "usage_input_timeline"} <= set(REPORT_WIDGET_IDS)
    assert {"usage_cache", "usage_input_timeline"} <= {p.id for p in registry.providers}


# ── « Continuer » : métriques cumulées ──────────────────────────────────────

def test_continuer_additionne_les_segments():
    from chatbot_app.turn.persistence import merge_continue_metrics
    avant = {"input_tokens": 5000, "output_tokens": 800, "thinking_tokens": 500,
             "response_tokens": 300, "cache_read_input_tokens": 4000, "duration": 10.5,
             "thinking_tokens_estimated": True, "model": "qwen", "write_tps": 40.0}
    suite = {"input_tokens": 6000, "output_tokens": 200, "thinking_tokens": 0,
             "response_tokens": 200, "cache_read_input_tokens": 5800, "duration": 3.25,
             "model": "qwen", "write_tps": 45.0, "kv_cache": {"used": 6200}}
    m = merge_continue_metrics(avant, suite)
    assert (m["input_tokens"], m["output_tokens"], m["thinking_tokens"]) == (11000, 1000, 500)
    assert (m["response_tokens"], m["cache_read_input_tokens"]) == (500, 9800)
    assert m["duration"] == 13.75
    assert m["thinking_tokens_estimated"] is True and m["segments"] == 2
    assert m["write_tps"] == 45.0 and m["kv_cache"] == {"used": 6200}     # dernier segment
    assert merge_continue_metrics(m, suite)["segments"] == 3
    assert merge_continue_metrics({}, suite) == suite


def test_final_porte_les_compteurs_cumules():
    from chatbot_app.turn.execution import _payload_final
    metrics = {"input_tokens": 6000, "output_tokens": 200, "tool_history": [{"x": 1}]}
    msg = {"metrics": {"input_tokens": 11000, "output_tokens": 1000, "segments": 2}}
    p = _payload_final("ok", msg, "", metrics, exec_id="chat-1", chat_id="c", plan_done=False,
                       title_was_generated=False, final_title="", persisted=True,
                       persist_error=None)
    assert p["metrics"]["input_tokens"] == 11000 and p["metrics"]["segments"] == 2
    assert p["metrics"]["tool_history"] == [{"x": 1}]


# ── Chemin sans outils : progression du prompt ─────────────────────────────

def test_relais_de_progression_cadence_et_dernier_evenement():
    from chatbot_app.turn.events import _prompt_progress_relay
    vus = []

    async def on_event(ev):
        vus.append(ev)

    async def go():
        relais = _prompt_progress_relay(on_event)
        await relais({"total": 1000, "processed": 300, "cache": 200, "time_ms": 10})
        await relais({"total": 1000, "processed": 500, "cache": 200})    # < 0,5 s : sauté
        await relais({"total": 1000, "processed": 1000, "cache": 200})   # 100 % : toujours
    asyncio.run(go())
    assert [e["processed"] for e in vus] == [300, 1000]
    assert vus[0] == {"type": "prompt_progress", "total": 1000, "processed": 300,
                      "cache": 200, "time_ms": 10, "iter": 1}


# ── Migration 0025 : jouée sur une base existante, quel que soit le moteur ───

def test_migration_0025_jouee_sur_une_base_existante(db):
    """Base serveur existante : ``_migrate`` tamponnait TOUT le schéma de
    référence à chaque démarrage, 0025 comprise — sans jamais la jouer. Une
    migration de données ``PORTABLE`` passe désormais par ``run_pending``.
    Couvre aussi la ligne d'un connecteur Anthropic SUPPRIMÉ (cache > entrée)."""
    from shared_infra.db._connection import _migrate, db_conn
    now = time.time()
    with db_conn() as c:
        c.execute("DELETE FROM schema_migrations WHERE name = '0025_usage_entree_inclusive'")
        c.execute("INSERT INTO usage_events(ts, source, connector, input_tokens, submitted_tokens, "
                  "cache_read_tokens) VALUES(?, 'chat', 'conn:999', 10, 10, 90)", (now,))
        c.execute("INSERT INTO usage_events(ts, source, connector, input_tokens, submitted_tokens, "
                  "cache_read_tokens) VALUES(?, 'chat', 'builtin', 1000, 1000, 600)", (now,))
        c.commit()
        _migrate(c, fresh=False)
        c.commit()
        rows = c.execute("SELECT connector, input_tokens, submitted_tokens FROM usage_events "
                         "ORDER BY connector").fetchall()
        done = c.execute("SELECT COUNT(*) FROM schema_migrations "
                         "WHERE name = '0025_usage_entree_inclusive'").fetchone()[0]
    assert [tuple(r) for r in rows] == [("builtin", 1000, 1000), ("conn:999", 100, 100)]
    assert done == 1


# ── Outils : part de l'ENTRÉE (convention OpenAI / Anthropic) ───────────────

def test_part_outils_d_un_prompt():
    from llm_core.context.tokens import tool_prompt_tokens
    msgs = [
        {"role": "system", "content": "x" * 3300},
        {"role": "user", "content": "liste les fichiers"},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "c1", "type": "function",
             "function": {"name": "list_files", "arguments": '{"path": "."}'}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "a.py\n" * 300},
    ]
    sans_defs = tool_prompt_tokens(msgs, None)
    assert sans_defs > 300                                  # résultat + appel re-soumis
    assert tool_prompt_tokens(msgs, None, defs_tokens=1000) == sans_defs + 1000
    assert tool_prompt_tokens([{"role": "user", "content": "x" * 999}], None) == 0


def test_cumul_outils_borne_par_l_entree_de_l_appel():
    from llm_core.engine.run import RunRecord
    rec = RunRecord()
    msgs = [{"role": "tool", "tool_call_id": "c", "content": "r" * 3300}]
    rec.note_tool_input(msgs, [{"type": "function", "function": {"name": "f"}}], "m", 10_000)
    premier = rec.cumul_tool_in
    assert premier > 1000 and rec.tool_defs_tokens > 0
    rec.note_tool_input(msgs, None, "m", 50)                # entrée réelle de 50
    assert rec.cumul_tool_in == premier + 50
    rec.note_tool_input(msgs, None, "m", 0)                 # usage absent : rien
    assert rec.cumul_tool_in == premier + 50


def test_registre_et_execution_portent_la_part_outils(db):
    import asyncio as _a

    from shared_infra.observability import runs as R
    from shared_infra.observability.usage_ctx import record_turn_usage, usage_scope
    from shared_infra.observability.usage_store import usage_totals

    async def tour():
        with usage_scope(user_id=1, source="chat"):
            async with R.run_scope("chat", sample_sandbox=False) as e:
                record_turn_usage(model="m", input_tokens=1000, output_tokens=10,
                                  usage={"tool_input_tokens": 400})
                record_turn_usage(model="m", input_tokens=100, output_tokens=10,
                                  usage={"tool_input_tokens": 900})   # borné à 100
        return e
    e = _a.run(tour())
    assert e.tool_tokens == 500 and e.row()["tool_tokens"] == 500       # 400 + 100
    assert usage_totals(time.time() - 60)["tool_tokens"] == 500


def test_metriques_du_message_portent_la_part_outils():
    from llm_core._metrics import calculate_metrics
    m = calculate_metrics({"usage": {"prompt_tokens": 5000, "completion_tokens": 10,
                                     "tool_input_tokens": 1200}}, 1.0)
    assert m["tool_input_tokens"] == 1200
