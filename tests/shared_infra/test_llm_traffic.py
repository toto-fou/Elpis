# SPDX-License-Identifier: MIT
"""Tests du viewer "Trafic LLM" : capture (table llm_calls), helper de tap, et
endpoints admin (gate strict is_admin==1).

Isolation : on redirige ``shared_infra.db._connection.DB_PATH`` vers un fichier temp
(``db()`` lit ce global à chaque appel) et on (ré)initialise la table.
"""
from __future__ import annotations

import json

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient


@pytest.fixture()
def tmpdb(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    from shared_infra.llm.debug import init_llm_debug_db
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "t.db"))
    init_llm_debug_db()
    return tmp_path


# ── Couche DB + capture ─────────────────────────────────────────────────────

def test_record_and_list_and_detail(tmpdb):
    from shared_infra.llm.debug import get_llm_call, list_llm_calls, record_llm_call
    record_llm_call(req_id="a1", user_id=7, chat_id="c1", model="qwen",
                    path="classic", status="ok", finish_reason="stop",
                    prompt_tokens=100, completion_tokens=20, duration_ms=450,
                    n_messages=3, request_json='{"messages":[]}',
                    response_json='{"content":"hi"}')
    rows = list_llm_calls(limit=10)
    assert len(rows) == 1
    r = rows[0]
    assert r["model"] == "qwen" and r["user_id"] == 7 and r["finish_reason"] == "stop"
    assert "request_json" not in r  # le listing n'expose pas les payloads
    full = get_llm_call(r["id"])
    assert full["request_json"] == '{"messages":[]}'
    assert full["response_json"] == '{"content":"hi"}'


def test_ring_prune(tmpdb):
    from shared_infra.llm.debug import list_llm_calls, record_llm_call
    for i in range(8):
        record_llm_call(req_id=f"r{i}", model="m", max_entries=5)
    rows = list_llm_calls(limit=100)
    assert len(rows) == 5                 # ring borné
    assert rows[0]["req_id"] == "r7"      # le plus récent en tête


def test_filters(tmpdb):
    from shared_infra.llm.debug import list_llm_calls, record_llm_call
    record_llm_call(user_id=1, model="a", status="ok")
    record_llm_call(user_id=2, model="b", status="error")
    assert len(list_llm_calls(user_id=1)) == 1
    assert len(list_llm_calls(status="error")) == 1
    assert list_llm_calls(status="error")[0]["user_id"] == 2


def test_capture_excludes_thinking(tmpdb, monkeypatch):
    import shared_infra.config as cfg
    monkeypatch.setattr(cfg, "LLM_DEBUG_ENABLED", True)
    from llm_core._llm_debug import capture_llm_exchange
    from shared_infra.llm.debug import get_llm_call, list_llm_calls
    capture_llm_exchange(
        req_id="x", user_id=3, chat_id="c", model="qwen", path="classic",
        request_payload={"messages": [{"role": "user", "content": "salut"}],
                         "temperature": 0.7},
        content="bonjour", usage={"prompt_tokens": 5, "completion_tokens": 2},
        timings={"prompt_ms": 10, "predicted_ms": 40}, finish_reason="stop",
    )
    rows = list_llm_calls(limit=5)
    assert len(rows) == 1
    assert rows[0]["n_messages"] == 1 and rows[0]["duration_ms"] == 50
    full = get_llm_call(rows[0]["id"])
    resp = json.loads(full["response_json"])
    assert resp["content"] == "bonjour"
    assert "thinking" not in resp           # le raisonnement n'est PAS capturé
    req = json.loads(full["request_json"])
    assert req["temperature"] == 0.7        # requête complète conservée


def test_capture_noop_when_disabled(tmpdb, monkeypatch):
    import shared_infra.config as cfg
    monkeypatch.setattr(cfg, "LLM_DEBUG_ENABLED", False)
    from llm_core._llm_debug import capture_llm_exchange
    from shared_infra.llm.debug import list_llm_calls
    capture_llm_exchange(req_id="y", request_payload={"messages": []}, content="x")
    assert list_llm_calls() == []           # rien capturé


# ── Endpoints admin (gate strict is_admin==1) ───────────────────────────────

@pytest.fixture()
def client(tmpdb, monkeypatch):
    import shared_infra.routes.admin.llm_traffic as rlt
    from shared_infra.routes.admin._state import admin_router

    def _fake_require_user_id(request):
        uid = request.headers.get("x-test-user")
        if not uid:
            raise HTTPException(401, "Unauthorized")
        return int(uid)

    def _fake_get_user_by_id(uid):
        # is_admin: header x-test-admin == "1" → admin strict ; "2" → modérateur.
        return {"id": uid, "is_admin": int(_CUR_ADMIN["v"])}

    monkeypatch.setattr(rlt, "require_user_id", _fake_require_user_id)
    monkeypatch.setattr(rlt, "get_user_by_id", _fake_get_user_by_id)

    app = FastAPI()

    @app.middleware("http")
    async def _auth(request: Request, call_next):
        _CUR_ADMIN["v"] = request.headers.get("x-test-admin") or "0"
        return await call_next(request)

    app.include_router(admin_router)
    return TestClient(app)


_CUR_ADMIN = {"v": "0"}


def _admin():
    return {"x-test-user": "1", "x-test-admin": "1"}


def _mod():
    return {"x-test-user": "2", "x-test-admin": "2"}


def test_route_requires_strict_admin(client):
    assert client.get("/api/admin/llm-traffic").status_code == 401
    # Modérateur (is_admin=2) refusé : gate strict.
    assert client.get("/api/admin/llm-traffic", headers=_mod()).status_code == 403


def test_route_list_detail_clear(client):
    from shared_infra.llm.debug import record_llm_call
    record_llm_call(req_id="z", user_id=9, model="qwen", path="tools",
                    request_json='{"messages":[{"role":"user","content":"hi"}]}',
                    response_json='{"content":"yo","tool_calls":[]}')
    r = client.get("/api/admin/llm-traffic", headers=_admin())
    assert r.status_code == 200
    data = r.json()
    assert data["count"] == 1 and data["enabled"] in (True, False)
    cid = data["calls"][0]["id"]
    # Détail : payloads parsés.
    d = client.get(f"/api/admin/llm-traffic/{cid}", headers=_admin()).json()
    assert d["request"]["messages"][0]["content"] == "hi"
    assert d["response"]["content"] == "yo"
    # Clear.
    assert client.delete("/api/admin/llm-traffic", headers=_admin()).json()["deleted"] == 1
    assert client.get("/api/admin/llm-traffic", headers=_admin()).json()["count"] == 0


def test_route_detail_404(client):
    assert client.get("/api/admin/llm-traffic/99999", headers=_admin()).status_code == 404
