# SPDX-License-Identifier: MIT
"""Jetons personnels (EXT.1, 2026-09-30) : empreinte seule, trois types
(opencode ``pcr_``, outils ``ept_``, vision ``evt_``), politique de l'admin
relue à chaque vérification, « Connexions » cloisonnées par compte, appairage
sans jeton stocké en clair, vérificateur du service MCP et relais, migration
0022 et conversion DML des anciens jetons en clair."""
from __future__ import annotations

import asyncio
import importlib
import sqlite3
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import shared_infra.accounts.tokens as T


@pytest.fixture()
def base(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    legacy.init_db()
    from shared_infra.accounts.users import create_user
    alice, bob = create_user("alice", "pw-alice-1"), create_user("bob", "pw-bob-1")
    cfg = {}
    monkeypatch.setattr(T, "_cfg", lambda path, default: cfg.get(path, default))
    monkeypatch.setattr(T, "_opencode_enabled", lambda: cfg.get("opencode", True))
    T._touched.clear()
    return {"alice": alice, "bob": bob, "cfg": cfg, "db": str(tmp_path / "app.db")}


def _stocke(db: str) -> str:
    c = sqlite3.connect(db)
    try:
        return repr(c.execute("SELECT * FROM tool_tokens").fetchall())
    finally:
        c.close()


# ── Magasin ──────────────────────────────────────────────────────────────────

def test_empreinte_seule_et_types_distincts(base):
    tok, row = T.create(base["alice"], "tools", "Open WebUI", ["fs", "git"], 30)
    assert tok.startswith("ept_") and row["hint"] == tok[-4:]
    assert tok not in _stocke(base["db"])                    # jamais le clair en base
    assert T.digest(tok) in _stocke(base["db"])
    d = T.resolve(tok)
    assert d["user_id"] == base["alice"] and d["username"] == "alice"
    assert d["kind"] == "tools" and d["families"] == ["fs", "git"]
    # un type non demandé ne passe pas, même valide
    assert T.resolve(tok, kinds=("opencode",)) is None
    pcr, _ = T.create(base["alice"], "opencode")
    evt, _ = T.create(base["alice"], "vision")
    assert pcr.startswith("pcr_") and evt.startswith("evt_")
    assert T.resolve(pcr, kinds=("tools",)) is None and T.resolve(pcr, kinds=("opencode",))
    assert T.resolve(evt, kinds=("opencode", "tools")) is None and T.resolve(evt, kinds=("vision",))
    # la vision est masquée de la liste
    assert {t["kind"] for t in T.list_for(base["alice"])} == {"tools", "opencode"}
    assert T.resolve("ept_inconnu_xxxxxxxxxxxxxxxxx") is None and T.resolve("") is None


def test_politique_relue_a_chaque_verification(base):
    tok, _ = T.create(base["alice"], "tools", "", ["fs", "shell"], 10)
    base["cfg"]["mcp.tokens.tools_families"] = "fs,git"
    assert T.resolve(tok)["families"] == ["fs"]              # shell retiré à chaud
    base["cfg"]["mcp.tokens.tools_families"] = "git"
    assert T.resolve(tok) is None                            # plus aucune famille : refus
    base["cfg"]["mcp.tokens.tools_families"] = "fs,shell"
    base["cfg"]["mcp.tokens.tools_enabled"] = False
    assert T.resolve(tok) is None
    with pytest.raises(T.TokenError):
        T.create(base["alice"], "tools", "", ["fs"], 10)


def test_familles_duree_et_quota(base):
    with pytest.raises(T.TokenError):
        T.create(base["alice"], "tools", "", ["browser"], 10)   # jamais (0.B absent)
    base["cfg"]["mcp.tokens.tools_families"] = "fs,browser,desktop"
    assert T.policy()["tools_families"] == ["fs", "desktop"]    # browser ignoré même ajouté
    with pytest.raises(T.TokenError):
        T.create(base["alice"], "tools", "", ["chart"], 10)     # famille interne
    with pytest.raises(T.TokenError):
        T.create(base["alice"], "tools", "", [], 10)
    with pytest.raises(T.TokenError):
        T.create(base["alice"], "tools", "", ["fs"], 91)        # > max_days (90)
    _t, row = T.create(base["alice"], "tools", "", ["fs"], 0)   # 0 → borné au maximum
    assert 89 * 86400 < row["expires_at"] - time.time() <= 90 * 86400
    base["cfg"]["mcp.tokens.max_days"] = 0
    _t, row = T.create(base["alice"], "tools", "", ["fs"], 0)
    assert row["expires_at"] is None                           # 0 = sans limite permis
    base["cfg"]["mcp.tokens.max_per_user"] = 3
    T.create(base["alice"], "opencode")
    with pytest.raises(T.TokenError):
        T.create(base["alice"], "tools", "", ["fs"], 1)
    T.create(base["alice"], "vision")                          # la vision ne compte pas


def test_expiration_compte_supprime_et_regeneration(base, monkeypatch):
    tok, row = T.create(base["alice"], "tools", "x", ["fs"], 1)
    now = time.time()
    monkeypatch.setattr(T.time, "time", lambda: now + 2 * 86400)
    assert T.resolve(tok) is None
    monkeypatch.setattr(T.time, "time", lambda: now)
    new, row2 = T.regenerate(base["alice"], row["id"])
    assert T.resolve(tok) is None and T.resolve(new)["families"] == ["fs"]
    assert row2["name"] == "x" and T.get_for(base["alice"], row["id"]) is None
    assert T.regenerate(base["bob"], row2["id"]) is None        # autre compte : rien
    assert T.revoke(base["bob"], row2["id"]) is False
    from shared_infra.accounts.users import delete_user_full
    assert delete_user_full(base["alice"])
    assert T.resolve(new) is None
    assert T.list_for(base["alice"]) == []


def test_opencode_desactive(base):
    pcr, _ = T.create(base["alice"], "opencode")
    base["cfg"]["opencode"] = False
    assert T.resolve(pcr, kinds=("opencode",)) is None
    with pytest.raises(T.TokenError):
        T.create(base["alice"], "opencode")


# ── Anciens jetons en clair ─────────────────────────────────────────────────

def test_conversion_dml_des_anciens_jetons(base):
    c = sqlite3.connect(base["db"])
    c.execute("CREATE TABLE code_remote_tokens (user_id INTEGER PRIMARY KEY, token TEXT NOT NULL, created_at REAL)")
    c.execute("INSERT INTO code_remote_tokens VALUES(?, ?, ?)", (base["alice"], "pcr_ancien_jeton_en_clair_1234", 1.0))
    c.execute("INSERT INTO code_remote_tokens VALUES(?, ?, ?)", (999, "pcr_orphelin_xxxxxxxxxxxxxxxxxx", 1.0))
    c.commit()
    c.close()
    assert T.convert_legacy() == 1                            # l'orphelin n'a plus de compte
    assert T.resolve("pcr_ancien_jeton_en_clair_1234", kinds=("opencode",))["user_id"] == base["alice"]
    c = sqlite3.connect(base["db"])
    assert c.execute("SELECT COUNT(*) FROM code_remote_tokens").fetchone()[0] == 0
    c.close()
    assert T.convert_legacy() == 0                            # idempotent


def test_migration_0022_sur_une_base_heritee(tmp_path):
    mig = importlib.import_module("shared_infra.db._migrations.0022_tool_tokens")
    c = sqlite3.connect(str(tmp_path / "old.db"))
    c.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT)")
    c.execute("INSERT INTO users VALUES (1, 'alice')")
    c.execute("CREATE TABLE code_remote_tokens (user_id INTEGER PRIMARY KEY, token TEXT NOT NULL, created_at REAL)")
    c.execute("INSERT INTO code_remote_tokens VALUES (1, 'pcr_vieux_jeton_xxxxxxxxxxxxxx', 5.0)")
    c.execute("CREATE TABLE code_pairings (id TEXT PRIMARY KEY, code TEXT, ip TEXT, created_at REAL, "
              "expires_at REAL, confirmed_uid INTEGER, token TEXT)")
    c.execute("INSERT INTO code_pairings VALUES ('p', 'ABC', '', 0, 9e9, 1, 'pcr_en_clair')")
    mig.migrate(c)
    mig.migrate(c)                                           # idempotente
    tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert "code_remote_tokens" not in tables
    assert c.execute("SELECT COUNT(*) FROM code_pairings").fetchone()[0] == 0
    row = c.execute("SELECT user_id, kind, token_hash, hint FROM tool_tokens").fetchone()
    assert row == (1, "opencode", T.digest("pcr_vieux_jeton_xxxxxxxxxxxxxx"), "xxxx")
    c.close()


# ── API « Connexions » ───────────────────────────────────────────────────────

@pytest.fixture()
def api(base, monkeypatch):
    import shared_infra.accounts.routes_tokens as RT
    uid = {"v": base["alice"]}
    monkeypatch.setattr(RT, "require_user_id", lambda request: uid["v"])
    monkeypatch.setattr(RT, "_base", lambda request: "http://lan.test")
    app = FastAPI()
    app.include_router(RT.router)
    return TestClient(app), uid


def test_connexions_cloisonnees_par_compte(api, base):
    c, uid = api
    r = c.post("/api/tokens", json={"kind": "tools", "name": "VS Code", "families": ["fs"], "days": 7})
    assert r.status_code == 200, r.text
    tok, tid = r.json()["token"], r.json()["item"]["id"]
    lst = c.get("/api/tokens").json()
    assert lst["bridge_url"] == "http://lan.test/api/mcp-bridge"
    assert lst["tools_url"] == "http://lan.test/api/tools"
    assert [t["name"] for t in lst["tokens"]] == ["VS Code"]
    assert tok not in repr(lst) and "token_hash" not in repr(lst)   # jamais réaffiché
    assert {f["name"] for f in lst["policy"]["families"]} == {"fs", "shell", "git", "desktop", "skill_run"}
    uid["v"] = base["bob"]                                            # autre compte
    assert c.get("/api/tokens").json()["tokens"] == []
    assert c.post(f"/api/tokens/{tid}/regenerate").status_code == 404
    assert c.delete(f"/api/tokens/{tid}").status_code == 404
    assert T.resolve(tok) is not None
    uid["v"] = base["alice"]
    assert c.post("/api/tokens", json={"kind": "tools", "families": ["browser"]}).status_code == 422
    assert c.post("/api/tokens", json={"kind": "vision"}).status_code == 422
    r2 = c.post(f"/api/tokens/{tid}/regenerate")
    assert r2.status_code == 200 and T.resolve(tok) is None
    assert c.delete(f"/api/tokens/{r2.json()['item']['id']}").status_code == 200
    assert c.get("/api/tokens/schema/browser").status_code == 404


# ── Appairage : le jeton naît au poll, jamais stocké ─────────────────────────

def test_appairage_jeton_cree_au_poll(base, monkeypatch):
    import shared_infra.opencode.routes_code as code
    monkeypatch.setattr(code, "require_user_id", lambda r: base["alice"])
    monkeypatch.setattr(code, "feature_enabled", lambda name, default=True: True)
    app = FastAPI()
    app.include_router(code.router)
    c = TestClient(app)
    d = c.post("/api/code/pair/start").json()
    assert c.get("/api/code/pair/poll", params={"id": d["id"]}).json() == {"status": "pending"}
    assert c.post("/api/code/pair/confirm", json={"code": d["code"]}).status_code == 200
    db = sqlite3.connect(base["db"])
    assert db.execute("SELECT token, confirmed_uid FROM code_pairings").fetchone() == (None, base["alice"])
    db.close()
    r = c.get("/api/code/pair/poll", params={"id": d["id"]}).json()
    assert r["status"] == "ok" and r["token"].startswith("pcr_")
    assert code._resolve_token(r["token"]) == base["alice"]
    assert c.get("/api/code/pair/poll", params={"id": d["id"]}).status_code == 404   # usage unique


# ── Service MCP : vérificateur, familles, introspection ──────────────────────

@pytest.fixture(scope="module")
def srv():
    return importlib.import_module("server.local_mcp_server")


def test_verificateur_jeton_d_outils(monkeypatch, srv):
    monkeypatch.setattr(srv, "remote_token_lookup", lambda tok: {
        "ept_bon": {"username": "hugo", "kind": "tools", "families": ["fs", "browser"]},
        "pcr_bon": {"username": "hugo", "kind": "opencode", "families": []},
    }.get(tok))
    srv._remote_token_cache.clear()
    v = srv._make_verifier(srv.build_token_table("svc", {}))
    ok = asyncio.run(v.verify_token("ept_bon"))
    assert ok.client_id == "tools:hugo" and ok.claims["client_kind"] == "tools"
    assert ok.claims["families"] == ["fs"]                    # browser jamais visible
    assert ok.claims["trusted_meta"] is False
    assert asyncio.run(v.verify_token("pcr_bon")).claims["client_kind"] == "opencode"
    assert asyncio.run(v.verify_token("evt_bon")) is None     # la vision ne vaut pas Bearer MCP
    import fastmcp.server.dependencies as deps
    monkeypatch.setattr(deps, "get_access_token", lambda: ok)
    monkeypatch.setattr(srv, "path_family", lambda: None)
    hidden = srv.hidden_families_for_current_client()
    assert "fs" not in hidden and {"shell", "git", "desktop", "browser", "memory"} <= hidden


def test_verificateur_sans_famille_ne_montre_rien(monkeypatch, srv):
    from types import SimpleNamespace

    import fastmcp.server.dependencies as deps
    monkeypatch.setattr(deps, "get_access_token",
                        lambda: SimpleNamespace(claims={"client_kind": "tools", "families": []}))
    monkeypatch.setattr(srv, "path_family", lambda: None)
    assert set(srv.hidden_families_for_current_client()) >= {"fs", "shell", "git"}


def test_lookup_reel_en_base(base, srv):
    srv._remote_token_cache.clear()
    tok, _ = T.create(base["alice"], "tools", "", ["git"], 5)
    assert srv.remote_token_lookup(tok) == {"username": "alice", "kind": "tools", "families": ["git"]}
    evt, _ = T.create(base["alice"], "vision")
    assert srv.remote_token_lookup(evt) is None


def test_introspection_rend_type_et_familles(base, monkeypatch):
    import shared_infra.toolhost.routes_internal as RI
    monkeypatch.setattr(RI, "require_service_token", lambda request: None)
    app = FastAPI()
    app.include_router(RI.router)
    c = TestClient(app)
    tok, _ = T.create(base["alice"], "tools", "", ["fs", "shell"], 5)
    d = c.post("/api/internal/tokens/introspect", json={"token": tok}).json()
    assert d["ok"] and d["kind"] == "tools" and d["families"] == ["fs", "shell"]
    assert d["username"] == "alice"
    evt, _ = T.create(base["alice"], "vision")
    assert c.post("/api/internal/tokens/introspect", json={"token": evt}).json()["ok"] is False


# ── Relais MCP : pcr_ et ept_ réels, evt_ refusé ─────────────────────────────

def test_relais_accepte_opencode_et_outils(base, monkeypatch):
    import shared_infra.mcp.bridge as mp
    ept, _ = T.create(base["alice"], "tools", "", ["fs"], 5)
    pcr, _ = T.create(base["alice"], "opencode")
    evt, _ = T.create(base["alice"], "vision")
    assert mp._resolve_token(ept) and mp._resolve_token(pcr)
    assert mp._resolve_token(evt) is None


# ── opencode.json d'une session web : espace réservé ─────────────────────────

def test_opencode_json_session_sans_jeton(base, monkeypatch):
    from starlette.requests import Request

    importlib.import_module("shared_infra.routes")        # ordre d'import (routes_cli ↔ desktop)
    cli = importlib.import_module("shared_infra.opencode.routes_cli")
    monkeypatch.setattr("shared_infra.security.deps.require_user_id", lambda r: base["alice"])
    req = Request({"type": "http", "headers": [], "method": "GET", "path": "/"})
    assert cli._client_identity(req) == (None, base["alice"])
    req2 = Request({"type": "http", "method": "GET", "path": "/",
                    "headers": [(b"authorization", b"Bearer pcr_inconnu_xxxxxxxxxxxxxxxxx")]})
    assert cli._client_identity(req2) == (None, None)
    assert cli.TOKEN_PLACEHOLDER.startswith("pcr_")
