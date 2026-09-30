# SPDX-License-Identifier: MIT
"""Compteurs fiables (L5.1) : moteur et exécution sur chaque ligne d'usage,
compaction rattachée à sa conversation, cache KV de llama.cpp, appels
d'outils détaillés (identifiant, début, famille, code de sortie, tailles,
statuts ``timeout`` et ``blocked``), fichiers modifiés, attente du moteur."""
from __future__ import annotations

import asyncio
import json

import pytest

from shared_infra.observability import runs as R


@pytest.fixture()
def db(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    legacy.init_db()
    from shared_infra.accounts.users import create_user
    assert create_user("alice", "pw") == 1
    return legacy


def _lignes(db, table):
    with db.db_conn() as conn:
        return [dict(r) for r in conn.execute(f"SELECT * FROM {table} ORDER BY id")]


# ── usage_events ─────────────────────────────────────────────────────────────

def test_moteur_et_execution_sur_la_ligne_d_usage(db):
    from llm_core._target import LlmTarget, reset_llm_target, set_llm_target
    from shared_infra.observability.usage_ctx import record_turn_usage, usage_scope

    async def tour():
        async with R.run_scope("chat", user_id=1, sample_sandbox=False) as e:
            with usage_scope("chat", user_id=1, origin_id="c1"):
                record_turn_usage(model="m", input_tokens=10, output_tokens=4,
                                  usage={"cache_read_input_tokens": 3})
                tok = set_llm_target(LlmTarget(base_url="http://x:1/v1", connector_id=5,
                                               is_default=False))
                try:
                    record_turn_usage(model="m", input_tokens=1, output_tokens=1)
                finally:
                    reset_llm_target(tok)
                with usage_scope("compression"):         # hérite origine et compte
                    record_turn_usage(model="m", input_tokens=2, output_tokens=2)
            return e
    e = asyncio.run(tour())
    import time
    for _ in range(200):
        rows = _lignes(db, "usage_events")
        if len(rows) == 3:
            break
        time.sleep(0.01)
    par_entree = {r["input_tokens"]: r for r in rows}    # écrites par des fils, sans ordre
    assert {n: r["connector"] for n, r in par_entree.items()} == \
        {10: "builtin", 1: "conn:5", 2: "builtin"}
    assert {r["run_id"] for r in rows} == {e.id}
    c = par_entree[2]
    assert (c["source"], c["origin_id"], c["user_id"]) == ("compression", "c1", 1)
    assert (e.input_tokens, e.output_tokens, e.cache_read_tokens) == (13, 7, 3)


def test_connecteur_explicite_garde_la_priorite(db):
    from shared_infra.observability.usage_ctx import record_turn_usage
    assert record_turn_usage(model="m", connector="conn:9", input_tokens=1, output_tokens=1)
    assert _lignes(db, "usage_events")[0]["connector"] == "conn:9"


# ── llama.cpp : cache KV ─────────────────────────────────────────────────────

@pytest.mark.parametrize("usage,timings,attendu", [
    ({"prompt_tokens": 90, "prompt_tokens_details": {"cached_tokens": 60}}, {"cache_n": 50}, 60),
    ({"prompt_tokens": 90}, {"cache_n": 50, "prompt_ms": 1}, 50),
    ({"prompt_tokens": 90}, {}, None),
    ({"prompt_tokens": 90, "cache_read_input_tokens": 7}, {"cache_n": 50}, 7),
])
def test_cache_kv_de_llamacpp(usage, timings, attendu):
    from llm_core.providers.llamacpp import SseStreamResult, _fin_de_flux
    r = SseStreamResult(usage=dict(usage), timings=dict(timings))
    _fin_de_flux(r)
    assert r.usage.get("cache_read_input_tokens") == attendu


def test_fin_de_flux_compte_l_appel():
    from llm_core.providers.llamacpp import SseStreamResult, _fin_de_flux

    async def tour():
        async with R.run_scope("chat", sample_sandbox=False) as e:
            _fin_de_flux(SseStreamResult(usage={"prompt_tokens": 1},
                                         timings={"prompt_ms": 10.4, "predicted_ms": 20.9}))
            _fin_de_flux(SseStreamResult())
        return e
    e = asyncio.run(tour())
    assert (e.llm_calls, e.prefill_ms, e.decode_ms) == (2, 10, 20)


# ── appels d'outils ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("p,resultat,statut,attendu", [
    ({}, '{"ok": true}', "ok", "success"),
    ({}, '{"ok": false, "returncode": 1, "stdout": ""}', "ok", "success"),
    ({}, json.dumps({"ok": False, "error": "timeout", "message": "x"}), "error", "timeout"),
    ({}, '{"error": "boom"}', "error", "error"),
    ({"args_error": "JSON illisible"}, '{"ok": false, "error": "JSON illisible"}', "error",
     "blocked"),
])
def test_statut_d_un_appel(p, resultat, statut, attendu):
    from llm_core.engine.tool_exec import _call_status
    assert _call_status(p, resultat, statut) == attendu


def test_code_de_sortie():
    from llm_core.engine.tool_exec import _exit_code
    assert _exit_code('{"ok": false, "returncode": 2}') == 2
    assert _exit_code('{"returncode": true}') is None
    assert _exit_code('{"ok": true}') is None and _exit_code('pas du json "returncode"') is None


def test_ligne_d_appel_rattachee_a_l_execution(db, monkeypatch):
    import llm_core._chat_with_tools as C
    import llm_core._mcp_categories as cats
    monkeypatch.setattr(cats, "categorize", lambda name: "shell")
    C._TCM_UID_CACHE.clear()

    async def tour():
        async with R.run_scope("chat", user_id=1, sample_sandbox=False) as e:
            C._record_tool_call_metric_safe(
                "alice", "c1", "execute_shell", "success", 40, call_id="call_7",
                started_at=123.5, exit_code=3, args_bytes=10, result_bytes=200)
            C._record_tool_call_metric_safe("alice", "c1", "execute_shell", "timeout", 5)
        return e
    e = asyncio.run(tour())
    C._record_tool_call_metric_safe("alice", "c1", "read_file", "success", 1)   # hors exécution
    a, b, c = _lignes(db, "tool_call_metrics")
    assert (a["run_id"], a["call_id"], a["started_at"], a["exit_code"], a["args_bytes"],
            a["result_bytes"], a["category"]) == (e.id, "call_7", 123.5, 3, 10, 200, "shell")
    assert (b["status"], b["call_id"], b["exit_code"]) == ("timeout", None, None)
    assert c["run_id"] == "c1"                           # conversation, faute d'exécution
    assert (e.tool_calls, e.tool_errors, e.tool_families) == (2, 1, {"shell": 2})


def test_fichiers_et_attente_de_l_execution():
    import llm_core._chat_with_tools as C

    async def tour():
        async with R.run_scope("chat", sample_sandbox=False) as e:
            C._noter_fichiers([{"path": "a.py"}, {"path": "b.py"}])
            C._noter_fichiers([{"path": "a.py"}])
            C._noter_fichiers(None)
            C._noter_attente(25)
        return e
    e = asyncio.run(tour())
    assert (e.files_changed, e.wait_ms) == (2, 25)


def test_part_du_cache_moteur_par_moteur(db):
    """llama.cpp : cache lu COMPRIS dans l'entrée ; Anthropic : AJOUTÉ à elle.
    La part servie par le cache se calcule sur l'entrée totale."""
    from shared_infra.llm.connectors import connector_ids_by_wire, create_connector
    from shared_infra.observability.metrics._usage_providers import KPIUsageCacheProvider
    from shared_infra.observability.usage_store import record_usage
    cid = create_connector(scope="shared", provider_type="anthropic", wire="anthropic",
                           base_url="https://api.anthropic.com", label="c")
    assert connector_ids_by_wire("anthropic") == [cid]
    assert record_usage(user_id=1, source="chat", connector="builtin",
                        input_tokens=100, output_tokens=1, cache_read_tokens=60)
    assert record_usage(user_id=1, source="chat", connector=f"conn:{cid}",
                        input_tokens=10, output_tokens=1, cache_read_tokens=90)
    d = KPIUsageCacheProvider().get_data(scope_hours=24)
    assert d["value"] == "75.0 %"                         # 150 / (100 + 10 + 90)
