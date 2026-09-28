# SPDX-License-Identifier: MIT
"""
Connecteurs LLM — store DB chiffré + routes user/admin + allowlist.

Couvre : CRUD owner-scoped, clé API chiffrée au repos (Fernet) et JAMAIS
sérialisée HTTP, séparation user/shared (IDOR), allowlist admin, verrouillage de
la base_url côté utilisateur (anti-SSRF), et les endpoints test/models mockés.
"""
from __future__ import annotations

import importlib

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture()
def lc(tmp_path, monkeypatch):
    """Temp DB (users + migration 0007) + clé de chiffrement déterministe."""
    # Clé Fernet déterministe : on réinitialise le cache du cipher pour qu'il
    # relise l'env (résolution paresseuse mémoïsée).
    import shared_infra.security.encryption as enc
    monkeypatch.setenv("APP_ENCRYPTION_KEY", "unit-test-master-key")
    enc._resolved = False
    enc._cipher = None

    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    from shared_infra.db._connection import db_conn
    with db_conn() as conn:
        conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT)")
        conn.executemany("INSERT INTO users(id, username) VALUES (?,?)",
                         [(1, "alice"), (2, "bob")])
        importlib.import_module(
            "shared_infra.db._migrations.0007_llm_connectors").migrate(conn)
        conn.commit()
    import shared_infra.llm.connectors as _lc
    return _lc


# ── DB : chiffrement au repos + write-only ────────────────────────────────────
def test_key_encrypted_at_rest_and_writeonly(lc):
    cid = lc.create_connector(scope="user", owner_user_id=1, provider_type="anthropic",
                              wire="anthropic", base_url="https://api.anthropic.com",
                              api_key="sk-ant-SECRET", label="claude")
    # Vue publique : pas de clé, juste has_key.
    pub = lc.list_user_connectors(1)[0]
    assert "api_key" not in pub and "api_key_enc" not in pub and pub["has_key"] is True
    # Stockage : api_key_enc != plaintext (Fernet), déchiffrable host-side.
    from shared_infra.db._connection import db_conn
    with db_conn() as conn:
        raw = conn.execute("SELECT api_key_enc, key_scheme FROM llm_connectors WHERE id=?",
                           (cid,)).fetchone()
    assert raw["key_scheme"] == "fernet"
    assert raw["api_key_enc"] and "sk-ant-SECRET" not in raw["api_key_enc"]
    assert lc.get_secret_for_user(1, cid)["api_key"] == "sk-ant-SECRET"


def test_crud_and_idor(lc):
    cid = lc.create_connector(scope="user", owner_user_id=1, provider_type="openai",
                              wire="openai", base_url="https://api.openai.com/v1",
                              api_key="k", label="gpt")
    sid = lc.create_connector(scope="shared", provider_type="vllm", wire="openai",
                              base_url="http://x:8000/v1", label="vLLM")
    # alice voit le sien + le partagé ; bob voit seulement le partagé.
    assert {c["id"] for c in lc.list_user_connectors(1)} == {cid}
    assert lc.list_user_connectors(2) == []
    assert {c["id"] for c in lc.list_shared_connectors()} == {sid}
    # bob ne peut ni lire ni modifier ni supprimer le connecteur d'alice.
    assert lc.get_user_secret(2, cid) is None
    assert lc.update_user_connector(2, cid, label="hax") is False
    assert lc.delete_user_connector(2, cid) is False
    assert lc.get_secret_for_user(2, cid) is None
    # …mais peut utiliser le partagé.
    assert lc.get_secret_for_user(2, sid) is not None
    # update sans nouvelle clé = clé inchangée.
    assert lc.update_user_connector(1, cid, label="renamed")
    assert lc.get_secret_for_user(1, cid)["api_key"] == "k"
    assert [c["label"] for c in lc.list_user_connectors(1)] == ["renamed"]


# ── Routes UTILISATEUR ────────────────────────────────────────────────────────
@pytest.fixture()
def uclient(lc, monkeypatch):
    import shared_infra.llm.routes_connectors as routes
    holder = {"uid": 1}
    monkeypatch.setattr(routes, "require_user_id", lambda request: holder["uid"])
    monkeypatch.setattr(routes, "audit_event", lambda **k: None)
    # config.json absent en test → allowlist par défaut (tous les cloud).
    monkeypatch.setattr(routes, "read_config_json", lambda: {})
    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app), holder, monkeypatch, routes


def test_user_create_locks_base_url_and_writeonly(uclient):
    c, holder, _, _ = uclient
    # base_url fournie par l'utilisateur IGNORÉE → preset officiel (anti-SSRF).
    r = c.post("/api/llm/connectors", json={
        "provider_type": "anthropic", "api_key": "sk-ant-x",
        "base_url": "http://169.254.169.254/v1", "label": "claude"})
    assert r.status_code == 200
    cid = r.json()["id"]
    listed = c.get("/api/llm/connectors").json()
    conn = listed["connectors"][0]
    assert conn["base_url"] == "https://api.anthropic.com"   # verrouillé
    assert conn["wire"] == "anthropic" and conn["has_key"] is True
    assert "api_key" not in conn
    # presets exposés au front
    assert "anthropic" in listed["presets"] and "anthropic" in listed["allowed_provider_types"]


def test_user_cannot_add_admin_only_or_disallowed(uclient):
    c, _, _, routes = uclient
    # llamacpp = admin_only → refus pour un user.
    assert c.post("/api/llm/connectors", json={"provider_type": "llamacpp", "api_key": "k"}).status_code == 403
    # clé manquante → 400
    assert c.post("/api/llm/connectors", json={"provider_type": "openai"}).status_code == 400
    # provider hors allowlist → 403 (allowlist restreinte à anthropic seul)
    routes.read_config_json = lambda: {"llm": {"allowed_provider_types": ["anthropic"]}}
    assert c.post("/api/llm/connectors", json={"provider_type": "groq", "api_key": "k"}).status_code == 403
    assert c.post("/api/llm/connectors", json={"provider_type": "anthropic", "api_key": "k"}).status_code == 200


def test_user_crud_owner_scoped_via_routes(uclient):
    c, holder, _, _ = uclient
    cid = c.post("/api/llm/connectors", json={"provider_type": "openai", "api_key": "k"}).json()["id"]
    holder["uid"] = 2
    assert c.get("/api/llm/connectors").json()["connectors"] == []
    assert c.delete(f"/api/llm/connectors/{cid}").status_code == 404
    holder["uid"] = 1
    assert c.put(f"/api/llm/connectors/{cid}", json={"label": "x"}).status_code == 200
    assert c.delete(f"/api/llm/connectors/{cid}").status_code == 200


def test_user_test_and_models_endpoints_mocked(uclient, monkeypatch):
    c, _, _, _ = uclient
    cid = c.post("/api/llm/connectors", json={"provider_type": "openai", "api_key": "k"}).json()["id"]
    import llm_core.providers.discovery as disc

    async def _fake_test(row, **k):
        assert row["api_key"] == "k"  # clé déchiffrée host-side
        return {"ok": True, "status": 200, "models_count": 3}

    async def _fake_models(row, **k):
        return {"ok": True, "status": 200, "models": ["gpt-a", "gpt-b"]}

    monkeypatch.setattr(disc, "test_connector", _fake_test)
    monkeypatch.setattr(disc, "fetch_models", _fake_models)
    assert c.post(f"/api/llm/connectors/{cid}/test").json()["ok"] is True
    md = c.get(f"/api/llm/connectors/{cid}/models").json()
    assert md["models"] == ["gpt-a", "gpt-b"] and md["connector_id"] == cid


# ── Routes ADMIN ──────────────────────────────────────────────────────────────
@pytest.fixture()
def aclient(lc, monkeypatch):
    import shared_infra.routes.admin.llm_connectors as admin_routes
    import shared_infra.llm.routes_connectors as user_routes
    monkeypatch.setattr(admin_routes, "_require_admin", lambda request: 1)
    monkeypatch.setattr(admin_routes, "audit_event", lambda **k: None)
    monkeypatch.setattr(user_routes, "read_config_json", lambda: {})
    cfg_holder = {"cfg": {}}
    monkeypatch.setattr(admin_routes, "read_config_json", lambda: dict(cfg_holder["cfg"]))
    monkeypatch.setattr(admin_routes, "write_config_json", lambda c: cfg_holder.__setitem__("cfg", c))
    from shared_infra.routes.admin._state import admin_router
    app = FastAPI()
    app.include_router(admin_router)
    return TestClient(app), cfg_holder


def test_admin_shared_connector_free_base_url(aclient):
    c, _ = aclient
    # admin : base_url libre (backend local interne) autorisée.
    r = c.post("/api/admin/llm/connectors", json={
        "provider_type": "vllm", "base_url": "http://10.168.1.9:8000/v1", "label": "vLLM"})
    assert r.status_code == 200
    lst = c.get("/api/admin/llm/connectors").json()["connectors"]
    assert lst[0]["base_url"] == "http://10.168.1.9:8000/v1" and lst[0]["scope"] == "shared"


def test_admin_allowlist_roundtrip(aclient):
    c, cfg = aclient
    r = c.put("/api/admin/llm/allowed-providers", json={"allowed": ["anthropic", "openai", "llamacpp"]})
    # llamacpp (admin-only) filtré : seuls les cloud passent.
    assert r.status_code == 200 and set(r.json()["allowed"]) == {"anthropic", "openai"}
    assert cfg["cfg"]["llm"]["allowed_provider_types"] == ["anthropic", "openai"]
