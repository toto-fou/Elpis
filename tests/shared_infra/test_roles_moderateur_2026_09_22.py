# SPDX-License-Identifier: MIT
"""Rôle modérateur (is_admin = 2) — audit sécurité 2026-09-22, H6 + M1.

H6 : un modérateur ne doit plus ÉCRIRE la config de l'instance ni déclencher
de diagnostic sortant (SSRF). Il garde la LECTURE des GET de la console.

M1 : les tests de vérité ``bool(is_admin)`` traitaient le modérateur comme un
admin (périmètre de groupes, identité de service). Désormais ``== 1``.
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ADMIN, MODO, USER = 1, 2, 0


def _client(monkeypatch, module, role: int) -> TestClient:
    monkeypatch.setattr(module, "require_user_id", lambda request: 7, raising=False)
    monkeypatch.setattr(module, "get_user_by_id",
                        lambda uid: {"id": 7, "username": "u7", "is_admin": role},
                        raising=False)
    app = FastAPI()
    from shared_infra.routes.admin._state import admin_router
    app.include_router(admin_router)
    return TestClient(app, raise_server_exceptions=False)


# ── H6 : compression-config ──────────────────────────────────────────────────

@pytest.fixture()
def compression(monkeypatch):
    import shared_infra.routes.admin.config as adm
    written = {}
    monkeypatch.setattr(adm, "write_config_json",
                        lambda d: written.update({"cfg": d}), raising=False)
    monkeypatch.setattr(adm, "read_config_json", lambda: {}, raising=False)
    return adm, written


def test_modo_ne_peut_pas_ecrire_compression_config(monkeypatch, compression):
    adm, written = compression
    c = _client(monkeypatch, adm, MODO)
    r = c.post("/api/admin/compression-config",
               json={"endpoint_url": "http://attaquant.example:8081"})
    assert r.status_code == 403
    assert written == {}                     # rien n'a été persisté


def test_modo_garde_la_lecture_compression_config(monkeypatch, compression):
    adm, _ = compression
    c = _client(monkeypatch, adm, MODO)
    assert c.get("/api/admin/compression-config").status_code == 200


def test_admin_ecrit_compression_config(monkeypatch, compression):
    adm, written = compression
    c = _client(monkeypatch, adm, ADMIN)
    r = c.post("/api/admin/compression-config", json={"keep_recent_turns": 8})
    assert r.status_code == 200, r.text
    assert "cfg" in written


# ── H6 : autres écritures / diagnostics sortants ─────────────────────────────

@pytest.mark.parametrize("path, body", [
    ("/api/admin/llm-capabilities/probe", None),
    ("/api/admin/llm-scheduling-mode", {"mode": "classic"}),
    ("/api/admin/report/daily/generate", None),
    ("/api/admin/report/daily/auto", {"enabled": False}),
])
def test_modo_refuse_sur_les_ecritures_admin(monkeypatch, path, body):
    import shared_infra.routes.admin.llm as llm
    import shared_infra.routes.admin.metrics as metrics
    import shared_infra.routes.admin.observability as obs
    for mod in (llm, metrics, obs):
        _client(monkeypatch, mod, MODO)
    c = _client(monkeypatch, llm, MODO)
    r = c.post(path, json=body) if body is not None else c.post(path)
    assert r.status_code == 403, (path, r.status_code, r.text)


# ── M1 : le modérateur n'est pas admin ───────────────────────────────────────

@pytest.mark.parametrize("role, respect_groups", [
    (ADMIN, False), (MODO, True), (USER, True),
])
def test_users_lite_modo_reste_dans_ses_groupes(monkeypatch, role, respect_groups):
    import shared_infra.accounts.routes_settings as rs
    seen = {}
    monkeypatch.setattr(rs, "require_user_id", lambda request: 7)
    monkeypatch.setattr(rs, "get_user_by_id", lambda uid: {"id": 7, "is_admin": role})
    monkeypatch.setattr(rs, "get_users_lite",
                        lambda uid, respect_groups: seen.update(rg=respect_groups) or [])
    monkeypatch.setattr(rs, "get_user_groups", lambda uid: [])
    rs.api_get_users_lite_route(object())
    assert seen["rg"] is respect_groups


def test_partage_de_prompt_modo_limite_au_perimetre(monkeypatch):
    import shared_infra.chat.routes_prompts as rp
    calls = []
    monkeypatch.setattr(rp, "require_user_id", lambda request: 7)
    monkeypatch.setattr(rp, "get_user_by_id", lambda uid: {"id": 7, "is_admin": MODO})

    def _lite(uid, respect_groups):
        calls.append(respect_groups)
        return [{"id": 8}]
    monkeypatch.setattr(rp, "get_users_lite", _lite)
    app = FastAPI()
    app.include_router(rp.router)
    c = TestClient(app, raise_server_exceptions=False)
    r = c.post("/api/prompts/share", json={"prompt_id": 1, "user_ids": [99]})
    assert r.status_code == 403                 # 99 hors de ses groupes
    assert calls == [True]


def test_identite_de_service_modo_non_admin(monkeypatch):
    import shared_infra.accounts.users as users
    import shared_infra.toolhost.routes_internal as ri
    import shared_infra.sandbox.executors._user_sandbox as us
    monkeypatch.setattr(users, "get_user_by_id",
                        lambda uid: {"id": uid, "username": "modo", "is_admin": MODO})
    monkeypatch.setattr(users, "get_user_settings", lambda uid: {})
    monkeypatch.setattr(us, "resolve_network_profile_id", lambda s: "")
    assert ri._identity_dict(7)["is_admin"] is False
    monkeypatch.setattr(users, "get_user_by_id",
                        lambda uid: {"id": uid, "username": "adm", "is_admin": ADMIN})
    assert ri._identity_dict(7)["is_admin"] is True


@pytest.mark.parametrize("raw, expected", [
    (1, True), (True, True), (2, False), (0, False), (None, False), (False, False),
])
def test_identity_from_dict_modo_non_admin(raw, expected):
    from shared_infra.accounts.identity import Identity
    ident = Identity.from_dict({"user_id": 7, "username": "u7", "is_admin": raw})
    assert ident.is_admin is expected
    assert ident.as_row()["is_admin"] == (1 if expected else 0)
