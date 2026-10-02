# SPDX-License-Identifier: MIT
"""Exécutions (L5.2) aux points d'entrée : tour de chat (identifiant sur le
message, plusieurs après un « Continuer »), sous-agent rattaché au tour
parent, run de routine qui prend le statut de son run."""
from __future__ import annotations

import asyncio
import json
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from chatbot_app.turn import execution
from shared_infra.observability import runs as R
from shared_infra.routes import _state
from shared_infra.runtime import chat_locks


@pytest.fixture()
def harnais(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    legacy.reset_pool()
    legacy.init_db()
    from shared_infra.accounts.users import create_user
    assert create_user("alice", "pw-alice-12") == 1
    monkeypatch.setattr(chat_locks, "LOCK_DIR", tmp_path / "locks")
    _state._cancelled_chats.clear()
    _state._active_chat_tasks.clear()
    import chatbot_app.routes.chats as chats_mod
    monkeypatch.setattr(chats_mod, "require_user_id", lambda request: 1)
    import llm_core
    import llm_core._queue as queue_mod

    async def _zero(_model=""):
        return 0

    async def _pas_de_file(_model=None):
        return {}
    monkeypatch.setattr(llm_core, "get_model_context_size", _zero)
    monkeypatch.setattr(queue_mod, "get_queue_status_for_async", _pas_de_file)
    yield chats_mod
    _state._cancelled_chats.clear()
    _state._active_chat_tasks.clear()
    legacy.reset_pool()


def _tour(body):
    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    events = []
    with TestClient(app).stream("POST", "/api/chat-saved-stream3", json=body) as r:
        assert r.status_code == 200
        events += [json.loads(line) for line in r.iter_lines() if line]
    return events


def _run_fini(run_id):
    for _ in range(300):
        r = R.get_run(run_id)
        if r and r["status"] != "running":
            return r
        time.sleep(0.01)
    raise AssertionError(R.get_run(run_id))


def test_tour_de_chat_et_continuer(harnais, monkeypatch):
    chats_mod = harnais
    from shared_infra.chat.store import get_chat
    from shared_infra.observability.usage_ctx import record_turn_usage

    async def _classique(msgs, **kw):
        record_turn_usage(model="stub", input_tokens=5, output_tokens=3)
        await kw["on_content_token"]("réponse")
        return "", "réponse", {"finish_reason": "stop"}
    monkeypatch.setattr(execution, "llama_chat_stream_tokens", _classique)

    q = {"role": "user", "content": "q"}
    ev = _tour({"messages": [q], "chat_id": "c1", "use_rag": False, "active_mcp_servers": []})
    (premier,) = get_chat(1, "c1")["messages"][-1]["run_ids"]
    assert [e for e in ev if e.get("type") == "final"][0]["run_ids"] == [premier]
    run = _run_fini(premier)
    assert premier.startswith("chat-")
    assert (run["kind"], run["user_id"], run["chat_id"], run["status"], run["engine"]) == \
        ("chat", 1, "c1", "ok", "builtin")
    # Tout ce que le tour consomme (réponse ET titre du chat neuf) lui revient.
    from shared_infra.db._connection import db_conn
    for _ in range(300):
        with db_conn() as conn:
            us = [dict(r) for r in conn.execute("SELECT * FROM usage_events")]
        if len(us) == 2:
            break
        time.sleep(0.01)
    assert {u["source"] for u in us} == {"chat", "title"}
    assert {(u["run_id"], u["connector"]) for u in us} == {(premier, "builtin")}
    assert (run["input_tokens"], run["output_tokens"]) == \
        (sum(u["input_tokens"] for u in us), sum(u["output_tokens"] for u in us))

    # « Continuer » : le message fusionné garde les deux exécutions, dans
    # l'ordre (le front renvoie ``run_ids`` avec le message tronqué).
    from shared_infra.chat.store import upsert_chat
    tronque = {"role": "assistant", "content": "début", "isTruncated": True,
               "run_ids": [premier]}
    upsert_chat(1, "c1", "t", [q, tronque], time.time())
    ev = _tour({"messages": [q, dict(tronque, isTruncated=False)], "chat_id": "c1",
                "is_continue": True, "use_rag": False, "active_mcp_servers": []})
    ids = get_chat(1, "c1")["messages"][-1]["run_ids"]
    assert len(ids) == 2 and ids[0] == premier and ids[1] != premier
    assert [e for e in ev if e.get("type") == "final"][0]["run_ids"] == ids


def test_sous_agent_rattache_au_tour_parent(harnais, monkeypatch):
    import llm_core._chat_with_tools as cwt
    from llm_core.tools import task_tool
    from shared_infra.observability.usage_ctx import record_turn_usage, usage_scope

    async def enfant(messages, **kw):
        record_turn_usage(model="stub", input_tokens=7, output_tokens=2)
        return "rapport", [], {}
    monkeypatch.setattr(cwt, "run_chat_multi_mcp", enfant)
    monkeypatch.setattr(cwt, "run_chat_multi_mcp_v2", enfant)
    handler = task_tool.build_task_builtin_tool(
        parent_mcp_configs=[], parent_builtin_tools=None, username="alice",
        chat_id="c9", model="m", sampling_override=None, memory_enabled=False,
        is_cancelled=lambda: False, on_event=None, scheduling_mode="classic",
        usage_sink=None, custom_agents=None, user_mcp_configs=None, user_id=1,
    )["task"]["handler"]

    async def tour():
        async with R.run_scope("chat", user_id=1, chat_id="c9", sample_sandbox=False) as p:
            with usage_scope("chat", user_id=1, origin_id="c9"):
                await handler({"subagent_type": "explore", "prompt": "p", "description": "d"})
        return p
    parent = asyncio.run(tour())
    from shared_infra.db._connection import db_conn
    for _ in range(300):
        with db_conn() as conn:
            filles = [dict(r) for r in conn.execute(
                "SELECT * FROM runs WHERE parent_id = ?", (parent.id,))]
        if filles and filles[0]["status"] != "running":
            break
        time.sleep(0.01)
    (fille,) = filles
    assert (fille["kind"], fille["status"], fille["input_tokens"], fille["user_id"]) == \
        ("subagent", "ok", 7, 1)
    assert fille["chat_id"].startswith("c9#task-")
    assert parent.input_tokens == 0                     # la conso de l'enfant reste à lui


def test_run_de_routine_prend_son_statut(harnais, monkeypatch):
    import shared_infra.scheduling.routines_scheduler as S
    import shared_infra.scheduling.routines_store as st
    from shared_infra.observability.usage_ctx import record_turn_usage, set_usage_context

    async def executer(routine, run_id, **kw):
        set_usage_context("routine", user_id=1, origin_id=S.run_chat_key(3, run_id))
        record_turn_usage(model="stub", input_tokens=4, output_tokens=1)
    monkeypatch.setattr(S, "execute_routine_run", executer)
    monkeypatch.setattr(st, "get_run", lambda run_id, uid: {"status": "skipped"})

    async def tour():
        await S._execute_routine_run_mesure({"id": 3, "owner_user_id": 1, "model": "m"}, 12)
    asyncio.run(tour())
    from shared_infra.db._connection import db_conn
    for _ in range(300):
        with db_conn() as conn:
            rows = [dict(r) for r in conn.execute("SELECT * FROM runs")]
        if rows and rows[0]["status"] != "running":
            break
        time.sleep(0.01)
    (run,) = rows
    assert (run["kind"], run["routine_id"], run["chat_id"], run["status"],
            run["input_tokens"], run["engine"]) == \
        ("routine", 3, "routine:3:run:12", "skipped", 4, "builtin")
