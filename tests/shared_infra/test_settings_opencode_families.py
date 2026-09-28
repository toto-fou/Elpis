# SPDX-License-Identifier: MIT
"""Tests GET/PUT /api/settings pour ``opencode_mcp_families`` (2026-09-03) —
familles d'outils publiées à opencode, une entrée MCP (donc une bascule) par
famille. Ce réglage est le SEUL endroit où le choix survit : la bascule du TUI
d'opencode n'est pas persistée et un re-sync réécrit ``opencode.json``.

Même recette que test_settings_live_shell.py : router partagé réel monté sur
une app nue, auth et store settings_json remplacés par des fakes en mémoire.
"""
from __future__ import annotations

from contextvars import ContextVar

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

_CUR_UID: "ContextVar[str | None]" = ContextVar("_CUR_UID", default=None)


@pytest.fixture()
def store():
    return {}


@pytest.fixture()
def client(monkeypatch, store):
    import shared_infra.accounts.routes_settings as routes_settings

    def _fake_require_user_id(request):
        uid = _CUR_UID.get()
        if not uid:
            raise HTTPException(401, "Authentification requise")
        return uid

    monkeypatch.setattr(routes_settings, "require_user_id", _fake_require_user_id)
    monkeypatch.setattr(routes_settings, "get_user_settings",
                        lambda uid: dict(store.get(uid) or {}))
    monkeypatch.setattr(routes_settings, "update_user_settings",
                        lambda uid, s: store.__setitem__(uid, dict(s)))
    # AUDIT 2026-08-02 (E5) — le handler PUT fusionne désormais via
    # merge_user_settings (atomique) ; on le mocke sur le store en mémoire.
    def _fake_merge_user_settings(uid, mutate, _st=store):
        s = dict(_st.get(uid) or {})
        mutate(s)
        _st[uid] = dict(s)
        return dict(s)
    monkeypatch.setattr(routes_settings, "merge_user_settings", _fake_merge_user_settings)
    monkeypatch.setattr(routes_settings, "get_username_by_id", lambda uid: str(uid))
    monkeypatch.setattr(routes_settings, "read_config_json", lambda: {})

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


def _user(uid="alice"):
    return {"x-test-user": uid}


def test_defaut_absent_donc_tout_actif(client):
    """Clé absente = toutes les familles actives (le serveur publie
    ``enabled: true``) : pas de réglage fantôme dans la réponse."""
    r = client.get("/api/settings", headers=_user())
    assert r.status_code == 200
    assert "opencode_mcp_families" not in r.json()


def test_put_normalise_les_familles(client, store):
    r = client.put("/api/settings", headers=_user(), json={
        "opencode_mcp_families": {"git": False, "browser": 1, "inconnue": False}})
    assert r.status_code == 200
    # familles inconnues rejetées, valeurs coercées en booléens
    assert store["alice"]["opencode_mcp_families"] == {"git": False, "browser": True}


def test_put_type_invalide_ignore(client, store):
    """Un payload d'un autre type finirait dans un ``opencode.json`` servi à un
    poste : la clé est retirée, pas stockée telle quelle."""
    store["alice"] = {"opencode_mcp_families": {"git": False}}
    for bad in (["git"], "git", 3, None):
        r = client.put("/api/settings", headers=_user(),
                       json={"opencode_mcp_families": bad})
        assert r.status_code == 200
        assert store["alice"]["opencode_mcp_families"] == {"git": False}   # inchangé


def test_get_relit_le_choix(client, store):
    store["alice"] = {"opencode_mcp_families": {"desktop": False}}
    assert client.get("/api/settings", headers=_user()).json()["opencode_mcp_families"] \
        == {"desktop": False}


def test_merge_non_destructif(client, store):
    client.put("/api/settings", headers=_user(), json={"chat_width": 80})
    client.put("/api/settings", headers=_user(),
               json={"opencode_mcp_families": {"git": False}})
    assert store["alice"]["chat_width"] == 80
    assert store["alice"]["opencode_mcp_families"] == {"git": False}
