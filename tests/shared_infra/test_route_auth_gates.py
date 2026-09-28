# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_route_auth_gates.py

Ces endpoints lisaient ``request.session.get('user_id')`` en direct, shuntant
la porte de validité centralisée (``require_user_id`` : révocation, max-age,
idle-timeout, must_change_pwd). Un cookie révoqué gardait donc l'accès (flux SSE
staff type=log, logs admin). Régression du fix : chaque handler DOIT passer par
``require_user_id``.

Stratégie : on remplace ``require_user_id`` par un mock qui compte ses appels et
lève 401 (= session révoquée). Un handler correct → 401 + mock appelé 1×. Un
retour à ``request.session.get`` → mock JAMAIS appelé → le test échoue.
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient


def _mk_gate():
    calls = {"n": 0}

    def gate(request):
        calls["n"] += 1
        raise HTTPException(401, "revoked")

    return gate, calls


@pytest.mark.parametrize("path", [
    "/api/system-events",
])
def test_events_endpoints_go_through_require_user_id(monkeypatch, path):
    import shared_infra.observability.routes_events as ev
    gate, calls = _mk_gate()
    monkeypatch.setattr(ev, "require_user_id", gate)
    app = FastAPI(); app.include_router(ev.router)
    resp = TestClient(app).get(path)
    assert resp.status_code == 401
    assert calls["n"] == 1, "l'endpoint doit appeler require_user_id (pas session.get)"


def test_admin_logs_recent_goes_through_require_user_id(monkeypatch):
    import shared_infra.routes.admin.logs as lg
    gate, calls = _mk_gate()
    monkeypatch.setattr(lg, "require_user_id", gate)
    app = FastAPI(); app.include_router(lg.admin_router)
    resp = TestClient(app).get("/api/admin/logs/recent")
    assert resp.status_code == 401
    assert calls["n"] == 1


def test_rag_collections_requires_auth(monkeypatch):
    """Avant le fix : pas de param request → 200 {"collections": []} sans cookie."""
    import shared_infra.routes.tools as tl
    gate, calls = _mk_gate()
    monkeypatch.setattr(tl, "require_user_id", gate)
    app = FastAPI(); app.include_router(tl.router)
    resp = TestClient(app).get("/api/rag/collections")
    assert resp.status_code == 401
    assert calls["n"] == 1
