# SPDX-License-Identifier: MIT
"""GET /api/settings/agent-templates — les agents intégrés tels que livrés.

C'est ce que l'onglet Agents PRÉ-REMPLIT quand on ouvre un modèle : persona
entière, catégories, budget. Une surcharge (``custom_agents``) ne stocke que
les écarts par rapport à ceci — cf. docs/agents-bank-design-2026-09-11.md.

Même recette que test_settings_compaction_threshold.py : routeur partagé réel
monté sur une app nue, auth remplacée par un fake en mémoire.
"""
from __future__ import annotations

from contextvars import ContextVar

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

_CUR_UID: "ContextVar[str | None]" = ContextVar("_CUR_UID", default=None)


@pytest.fixture()
def client(monkeypatch):
    import shared_infra.accounts.routes_settings as routes_settings

    def _fake_require_user_id(request):
        uid = _CUR_UID.get()
        if not uid:
            raise HTTPException(401, "Authentification requise")
        return uid

    monkeypatch.setattr(routes_settings, "require_user_id", _fake_require_user_id)

    from shared_infra.routes._state import router
    app = FastAPI()

    @app.middleware("http")
    async def _inject_auth(request: Request, call_next):
        tok = _CUR_UID.set(request.headers.get("x-test-user") or None)
        try:
            return await call_next(request)
        finally:
            _CUR_UID.reset(tok)

    app.include_router(router)
    return TestClient(app)


def test_les_modeles_livres_avec_leur_persona(client):
    from llm_core.tools.task_tool import _AGENTS
    r = client.get("/api/settings/agent-templates", headers={"x-test-user": "alice"})
    assert r.status_code == 200
    tpl = r.json()["templates"]
    assert [t["name"] for t in tpl] == list(_AGENTS)
    for t in tpl:
        # La persona ENTIÈRE : c'est elle que le formulaire pré-remplit.
        assert t["prompt"].startswith("# Role"), t["name"]
        assert t["tool_categories"] and t["max_iters"] > 0 and t["summary"]


def test_sans_session_401(client):
    assert client.get("/api/settings/agent-templates").status_code == 401
