# SPDX-License-Identifier: MIT
"""Console › Exécutions (L5.7) : coût par compte (sous-agents compris, compte
des exécutions au premier niveau), liste filtrable, chronologie de
n'importe quel compte pour l'administrateur seul, secrets masqués."""
from __future__ import annotations

import json
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from shared_infra.observability import runs as R


@pytest.fixture()
def env(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    legacy.init_db()
    from shared_infra.accounts.users import create_user
    assert create_user("admin", "pw", is_admin=1) == 1
    assert create_user("modo", "pw", is_admin=2) == 2
    assert create_user("alice", "pw") == 3
    t0 = time.time() - 600
    R.upsert_run({"id": "chat-a1", "kind": "chat", "user_id": 3, "chat_id": "c1", "status": "ok",
                  "started_at": t0, "ended_at": t0 + 60, "input_tokens": 1000, "output_tokens": 100,
                  "prefill_ms": 2000, "decode_ms": 3000, "wait_ms": 500, "tool_calls": 2,
                  "tool_errors": 1, "files_changed": 1, "sandbox_cpu_peak": 80.0,
                  "sandbox_mem_peak_mb": 512.0})
    R.upsert_run({"id": "subagent-a2", "kind": "subagent", "user_id": 3, "parent_id": "chat-a1",
                  "status": "ok", "started_at": t0 + 10, "ended_at": t0 + 20,
                  "input_tokens": 400, "output_tokens": 40, "decode_ms": 1000})
    R.upsert_run({"id": "routine-a3", "kind": "routine", "user_id": 3, "status": "error",
                  "started_at": t0 + 100, "ended_at": t0 + 110})
    R.upsert_run({"id": "chat-old", "kind": "chat", "user_id": 3, "status": "ok",
                  "started_at": time.time() - 3 * 86400})
    with legacy.db_conn() as c:
        c.execute("INSERT INTO tool_call_metrics(run_id, user_id, tool_name, status, duration_ms, ts, "
                  "call_id, started_at, category) VALUES('chat-a1', 3, 'execute_shell', 'success', 10, ?, "
                  "'k1', ?, 'shell')", (t0 + 5, t0 + 4))
        c.commit()
    from shared_infra.chat import store
    store.upsert_chat(3, "c1", "t", [
        {"role": "user", "content": "q"},
        {"role": "assistant", "content": "r", "run_ids": ["chat-a1"], "tool_history": [
            {"role": "assistant", "tool_calls": [{"id": "k1", "function": {
                "name": "execute_shell", "arguments": json.dumps({"command": "export API_KEY=sk-abcdefghijklmnop"})}}]},
            {"role": "tool", "tool_call_id": "k1", "content": "password=hunter2"},
        ]},
    ], time.time())
    import shared_infra.routes.admin.observability as O
    uid = {"v": 1}
    monkeypatch.setattr(O, "require_user_id", lambda request: uid["v"])
    from shared_infra.routes.admin import admin_router
    app = FastAPI()
    app.include_router(admin_router)
    return TestClient(app), uid


def test_cout_par_compte(env):
    c, _ = env
    r = c.get("/api/admin/runs/accounts?hours=24")
    assert r.status_code == 200, r.text
    (a,) = r.json()["items"]
    assert a["username"] == "alice" and a["runs"] == 2 and a["subagents"] == 1 and a["failed"] == 1
    assert (a["input_tokens"], a["output_tokens"]) == (1400, 140)      # sous-agent compris
    assert a["llm_ms"] == 6000 and a["wait_ms"] == 500
    assert a["sandbox_mem_peak_mb"] == 512.0
    # Fenêtre de 7 jours : l'exécution d'il y a 3 jours compte.
    assert c.get("/api/admin/runs/accounts?hours=168").json()["items"][0]["runs"] == 3


def test_liste_filtrable(env):
    c, _ = env
    ids = [x["id"] for x in c.get("/api/admin/runs?hours=24").json()["items"]]
    assert ids == ["routine-a3", "chat-a1"]                                # premier niveau, récentes d'abord
    assert [x["id"] for x in c.get("/api/admin/runs?kind=subagent").json()["items"]] == ["subagent-a2"]
    assert [x["id"] for x in c.get("/api/admin/runs?status=error").json()["items"]] == ["routine-a3"]
    assert c.get("/api/admin/runs?user_id=2").json()["items"] == []
    assert c.get("/api/admin/runs?kind=inconnu").status_code == 400
    assert c.get("/api/admin/runs?status=x;drop").status_code == 400
    assert c.get("/api/admin/runs").json()["items"][0]["username"] == "alice"


def test_chronologie_admin_seul_secrets_masques(env):
    c, uid = env
    r = c.get("/api/admin/runs/chat-a1/timeline")
    assert r.status_code == 200, r.text
    texte = r.text
    assert "sk-abcdefghijklmnop" not in texte and "hunter2" not in texte
    assert [e["type"] for e in r.json()["events"]] == ["tool", "child"]
    exp = c.get("/api/admin/runs/chat-a1/export")
    assert exp.status_code == 200 and "hunter2" not in exp.text
    assert c.get("/api/admin/runs/chat-inconnu/timeline").status_code == 404
    # Modérateur : agrégats et liste oui, contenu des exécutions non.
    uid["v"] = 2
    assert c.get("/api/admin/runs/accounts").status_code == 200
    assert c.get("/api/admin/runs").status_code == 200
    assert c.get("/api/admin/runs/chat-a1/timeline").status_code == 403
    assert c.get("/api/admin/runs/chat-a1/export").status_code == 403
    # Utilisateur : rien.
    uid["v"] = 3
    for url in ("/api/admin/runs/accounts", "/api/admin/runs", "/api/admin/runs/chat-a1/timeline"):
        assert c.get(url).status_code == 403
