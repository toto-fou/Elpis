# SPDX-License-Identifier: MIT
"""Tests GET/PUT /api/settings pour le toggle « Compaction automatique »
(``compression_enabled``, 2026-07-29).

Réglage per-user OPT-IN : beaucoup d'utilisateurs préfèrent décider eux-mêmes
du moment où l'historique est résumé (commande /compact), qui reste disponible
quel que soit ce toggle. Défaut OFF — contrairement à ``live_shell_enabled``
qui est un simple réglage d'affichage (défaut ON).

Même recette que test_settings_agents.py : router partagé réel monté sur une
app nue, auth et store settings_json remplacés par des fakes en mémoire.
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


def test_get_default_is_off(client):
    """Capacité qui RÉÉCRIT l'historique → strictement opt-in, défaut OFF
    (même gabarit que memory_enabled / agents_enabled)."""
    r = client.get("/api/settings", headers=_user())
    assert r.status_code == 200
    assert r.json()["compression_enabled"] is False


def test_put_coerced_bool(client, store):
    r = client.put("/api/settings", headers=_user(),
                   json={"compression_enabled": 0})
    assert r.status_code == 200
    assert store["alice"]["compression_enabled"] is False
    r = client.put("/api/settings", headers=_user(),
                   json={"compression_enabled": "truthy"})
    assert r.status_code == 200
    assert store["alice"]["compression_enabled"] is True


def test_put_partial_merge_non_destructif(client, store):
    client.put("/api/settings", headers=_user(),
               json={"hide_thinking": True, "chat_width": 80})
    client.put("/api/settings", headers=_user(),
               json={"compression_enabled": False})
    s = store["alice"]
    assert s["compression_enabled"] is False
    assert s["hide_thinking"] is True
    assert s["chat_width"] == 80


def test_get_reflects_saved_on(client, store):
    store["alice"] = {"compression_enabled": True}
    r = client.get("/api/settings", headers=_user())
    assert r.json()["compression_enabled"] is True


def test_toggle_par_utilisateur_independant(client, store):
    """Le choix est PAR UTILISATEUR : activer chez l'un ne touche pas l'autre."""
    client.put("/api/settings", headers=_user("alice"),
               json={"compression_enabled": True})
    client.put("/api/settings", headers=_user("bob"),
               json={"hide_thinking": True})
    assert store["alice"]["compression_enabled"] is True
    assert client.get("/api/settings", headers=_user("bob")
                      ).json()["compression_enabled"] is False
