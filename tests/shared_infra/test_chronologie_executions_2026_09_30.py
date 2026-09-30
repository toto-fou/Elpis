# SPDX-License-Identifier: MIT
"""Chronologie d'une exécution (L5.3) : ``/api/runs/{id}``, ``/timeline`` et
``/export`` — réservées au compte propriétaire (404 sans oracle), événements
triés (tours du modèle, appels d'outils enrichis par ``call_id`` depuis la
``tool_history`` du message, sous-exécutions), export aux secrets masqués."""
from __future__ import annotations

import json
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from shared_infra.observability import runs as R, runs_timeline as T


@pytest.fixture()
def env(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    legacy.init_db()
    from shared_infra.accounts.users import create_user
    assert create_user("alice", "pw") == 1
    assert create_user("bob", "pw") == 2
    t0 = time.time() - 100
    R.upsert_run({"id": "chat-aaa", "kind": "chat", "user_id": 1, "chat_id": "c1",
                  "status": "ok", "started_at": t0, "ended_at": t0 + 30,
                  "input_tokens": 120, "output_tokens": 40, "tool_calls": 1})
    R.upsert_run({"id": "subagent-bbb", "kind": "subagent", "user_id": 1, "parent_id": "chat-aaa",
                  "status": "ok", "started_at": t0 + 10, "ended_at": t0 + 20})
    with legacy.db_conn() as c:
        c.execute("INSERT INTO usage_events(ts, user_id, source, model, input_tokens, "
                  "output_tokens, duration_ms, run_id) VALUES(?, 1, 'chat', 'm', 120, 40, 2000, 'chat-aaa')",
                  (t0 + 5,))
        c.execute("INSERT INTO tool_call_metrics(run_id, user_id, tool_name, status, duration_ms, "
                  "ts, call_id, started_at, category, exit_code) "
                  "VALUES('chat-aaa', 1, 'execute_shell', 'success', 1500, ?, 'call_1', ?, 'shell', 0)",
                  (t0 + 8, t0 + 6.5))
        c.commit()
    from shared_infra.chat import store
    store.upsert_chat(1, "c1", "t", [
        {"role": "user", "content": "q"},
        {"role": "assistant", "content": "r", "run_ids": ["chat-aaa"], "tool_history": [
            {"role": "assistant", "tool_calls": [{"id": "call_1", "function": {
                "name": "execute_shell",
                "arguments": json.dumps({"command": "curl -H 'Authorization: Bearer abc123' x"})}}]},
            {"role": "tool", "tool_call_id": "call_1", "content": "token=ghp_ABCDEFGHIJKLMNOPQRST ok"},
        ]},
    ], time.time())
    import shared_infra.observability.routes_runs as RR
    uid = {"v": 1}
    monkeypatch.setattr(RR, "require_user_id", lambda request: uid["v"])
    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app), uid


def test_chronologie_triee_et_enrichie(env):
    c, _uid = env
    r = c.get("/api/runs/chat-aaa/timeline")
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["run"]["id"] == "chat-aaa" and [e["id"] for e in d["children"]] == ["subagent-bbb"]
    types = [e["type"] for e in d["events"]]
    assert types == ["llm", "tool", "child"]                  # 3 s, 6,5 s, 10 s après le début
    outil = d["events"][1]
    assert outil["argument"].startswith("command: curl") and "ok" in outil["result"]
    assert outil["exit_code"] == 0 and outil["category"] == "shell"


def test_reserve_au_proprietaire_sans_oracle(env):
    c, uid = env
    uid["v"] = 2
    for url in ("/api/runs/chat-aaa", "/api/runs/chat-aaa/timeline", "/api/runs/chat-aaa/export"):
        assert c.get(url).status_code == 404
    assert c.get("/api/runs/chat-inconnu").status_code == 404
    assert c.get("/api/runs/..%2Fetc").status_code == 404


def test_export_masque_les_secrets(env):
    c, _uid = env
    r = c.get("/api/runs/chat-aaa/export")
    assert r.status_code == 200 and "attachment" in r.headers["content-disposition"]
    texte = r.text
    assert "abc123" not in texte and "ghp_ABCDEFGHIJKLMNOPQRST" not in texte
    d = json.loads(texte)
    assert d["format"] == "elpis-run/1" and d["children_timelines"][0]["run"]["id"] == "subagent-bbb"


def test_masquage():
    m = T.masquer
    assert "s3cr3t" not in m("password=s3cr3t&x=1")
    assert "tok" not in m('{"api_key": "tok-123456"}')
    assert "pwd" not in m("https://user:pwd@git.lan/r.git")
    assert m("pcr_" + "a" * 30) == "***"
    assert m("rien de secret") == "rien de secret"
