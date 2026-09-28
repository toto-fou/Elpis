# SPDX-License-Identifier: MIT
"""
Console admin sur son propre processus (``APP_MODE=admin``) : le menu
« Compte et apparence » et Ctrl+K changent le skin et le mode sombre via
``/api/settings``. La route n'était pas montée sur ce port → 404 à chaque
clic. Elle y est désormais, mais l'écriture se limite à l'apparence.
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture()
def client(monkeypatch):
    import shared_infra.accounts.routes_settings as rs
    store: dict = {}
    monkeypatch.setattr(rs, "require_user_id", lambda request: 7)
    monkeypatch.setattr(rs, "get_user_settings", lambda uid: dict(store.get(uid) or {}))
    monkeypatch.setattr(rs, "update_user_settings", lambda uid, s: store.__setitem__(uid, dict(s)))

    def _merge(uid, mutate):
        s = dict(store.get(uid) or {}); mutate(s); store[uid] = dict(s); return dict(s)
    monkeypatch.setattr(rs, "merge_user_settings", _merge)
    monkeypatch.setattr(rs, "get_username_by_id", lambda uid: str(uid))
    monkeypatch.setattr(rs, "read_config_json", lambda: {})
    monkeypatch.setattr(rs, "get_user_by_id", lambda uid: {"is_admin": 1})
    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app), store


def test_port_admin_accepte_l_apparence(client, monkeypatch):
    c, store = client
    monkeypatch.setenv("APP_MODE", "admin")
    r = c.put("/api/settings", json={"skin": "emeraude", "dark_mode": True, "dark_mode_auto": False})
    assert r.status_code == 200, r.text
    assert store[7]["skin"] == "emeraude" and store[7]["dark_mode"] is True


def test_port_admin_refuse_le_reste(client, monkeypatch):
    c, store = client
    monkeypatch.setenv("APP_MODE", "admin")
    r = c.put("/api/settings", json={"skin": "emeraude", "mcp_servers": []})
    assert r.status_code == 403
    assert "mcp_servers" in r.json()["detail"]
    assert 7 not in store


def test_port_principal_inchange(client, monkeypatch):
    c, store = client
    monkeypatch.setenv("APP_MODE", "main")
    r = c.put("/api/settings", json={"skin": "emeraude", "mcp_servers": []})
    assert r.status_code == 200, r.text


def test_route_montee_sur_le_processus_admin():
    import inspect
    from server import app as srv
    src = inspect.getsource(srv._mount_admin_required_subset)
    assert '"/api/settings"' in src
