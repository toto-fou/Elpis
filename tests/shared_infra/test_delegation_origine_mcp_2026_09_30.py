# SPDX-License-Identifier: MIT
"""Délégation du relais MCP et contrôle d'Origin (EXT.2, 2026-09-30).

* le jeton ``dlg_`` n'est valide qu'avec la bonne clé (jeton de service), la
  bonne audience, un horodatage frais et un compte ;
* le service en tire les restrictions du client délégué — jamais la
  confiance du service ; une liste de familles vide ne montre rien ;
* ``Origin`` : absent accepté, ``null`` et étrangers refusés, liste et motif
  ``:*`` de la configuration, origine propre du relais ;
* le relais accepte des vérificateurs de client supplémentaires (OAuth demain).
"""
from __future__ import annotations

import asyncio
import importlib
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from shared_infra.mcp import delegation as D, origins as O

CLE = "cle-de-service"
ALICE = {"username": "alice", "user_id": 7, "kind": "tools", "families": ["fs", "git"]}


@pytest.fixture(scope="module")
def srv():
    return importlib.import_module("server.local_mcp_server")


def test_jeton_de_delegation_signe_et_borne():
    tok = D.delegation_token(ALICE, CLE)
    assert tok.startswith("dlg_") and "alice" not in tok.split(".")[1]
    c = D.verify_delegation(tok, CLE)
    assert (c["sub"], c["uid"], c["kind"], c["families"]) == ("alice", 7, "tools", ["fs", "git"])
    assert D.verify_delegation(tok, "autre") is None                         # clé
    assert D.verify_delegation(tok, CLE, now=time.time() + 600) is None      # périmé
    assert D.verify_delegation(tok[4:], CLE) is None                          # sans préfixe
    from shared_infra.accounts import identity as ident
    autre_aud = "dlg_" + ident.sign_claims({"sub": "alice"}, CLE, aud="elpis-sandbox")
    assert D.verify_delegation(autre_aud, CLE) is None                       # audience
    assert D.verify_delegation(D.delegation_token({**ALICE, "username": ""}, CLE), CLE) is None


def test_le_verificateur_du_service_honore_la_delegation(srv):
    v = srv._make_verifier(srv.build_token_table(CLE, {}))
    ok = asyncio.run(v.verify_token(D.delegation_token(ALICE, CLE)))
    assert ok.client_id == "tools:alice"
    assert ok.claims["trusted_meta"] is False and ok.claims["delegated"] is True
    assert ok.claims["families"] == ["fs", "git"] and ok.claims["client_kind"] == "tools"
    assert asyncio.run(v.verify_token(D.delegation_token(ALICE, "autre"))) is None
    service = asyncio.run(v.verify_token(CLE))
    assert service.claims["trusted_meta"] is True                           # inchangé
    # Sans jeton de service, aucune délégation n'est recevable.
    v2 = srv._make_verifier(srv.build_token_table("", {"ext-tok": "bob"}))
    assert asyncio.run(v2.verify_token(D.delegation_token(ALICE, "x"))) is None


def test_familles_d_un_client_delegue(monkeypatch, srv):
    import fastmcp.server.dependencies as deps
    monkeypatch.setattr(srv, "path_family", lambda: None)

    def cache(claims):
        tok = srv.delegated_access_token("dlg_x", claims)
        monkeypatch.setattr(deps, "get_access_token", lambda: tok)
        return srv.hidden_families_for_current_client()

    tout = set(srv._FAMILY_NAMES)
    assert cache({"sub": "a", "kind": "tools", "families": []}) == tout          # jamais « tout »
    assert tout - cache({"sub": "a", "kind": "tools", "families": ["git"]}) == {"git"}
    assert cache({"sub": "a", "kind": "oauth", "families": []}) == tout
    oc = cache({"sub": "a", "kind": "opencode", "families": []})
    assert tout - oc == srv.OPENCODE_FAMILIES


def test_regles_d_origine(monkeypatch):
    monkeypatch.delenv("LOCAL_MCP_ALLOWED_ORIGINS", raising=False)
    monkeypatch.setattr(O, "allowed_origins", lambda: {"https://ide.lan", "http://outil.lan:*"})
    assert O.origin_allowed(None) and O.origin_allowed("")
    assert not O.origin_allowed("null") and not O.origin_allowed("http://evil.example")
    assert O.origin_allowed("https://IDE.lan/")                              # normalisée
    assert O.origin_allowed("http://outil.lan:8080") and not O.origin_allowed("http://outil.lan")
    assert not O.origin_allowed("http://outil.lan:80x")
    assert O.origin_allowed("http://elpis.lan:8001", own_host="elpis.lan:8001")
    assert not O.origin_allowed("http://elpis.lan:9999", own_host="elpis.lan:8001")


def test_liste_d_origines_de_l_environnement(monkeypatch):
    monkeypatch.setenv("LOCAL_MCP_ALLOWED_ORIGINS", "https://a.lan, https://b.lan")
    assert {"https://a.lan", "https://b.lan"} <= O.allowed_origins()


def test_porte_du_service_refuse_une_origine_etrangere(srv):
    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})
    c = TestClient(srv.McpGateASGI(app, prefixes=("/mcp",)))
    assert c.post("/mcp", headers={"Origin": "http://evil.example"}).status_code == 403
    assert c.post("/mcp").status_code == 200
    assert c.post("/api/sandbox/x", headers={"Origin": "http://evil.example"}).status_code == 200


def test_le_relais_accepte_un_verificateur_supplementaire(monkeypatch):
    """Point de raccord d'EXT.4 : un vérificateur OAuth s'ajoute à la liste."""
    import httpx

    import shared_infra.config as cfg
    import shared_infra.mcp.bridge as B
    monkeypatch.setattr(cfg, "LOCAL_MCP_URL", "http://127.0.0.1:8765/mcp")
    monkeypatch.setattr(cfg, "LOCAL_MCP_TOKEN", CLE)
    monkeypatch.setattr(B, "_resolve_token", lambda t: None)
    monkeypatch.setattr(B, "CLIENT_VERIFIERS", B.CLIENT_VERIFIERS + [
        lambda t: {"user_id": 9, "username": "zoe", "kind": "oauth", "families": ["git"]}
        if t == "oat_ok" else None])
    vues = []
    _vrai = httpx.AsyncClient

    def _patched(*a, **kw):
        kw["transport"] = httpx.MockTransport(
            lambda r: (vues.append(r), httpx.Response(200, json={}))[1])
        return _vrai(*a, **kw)
    monkeypatch.setattr(httpx, "AsyncClient", _patched)
    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    c = TestClient(app)
    assert c.post("/api/mcp-bridge/git", json={}, headers={"Authorization": "Bearer oat_ok"}).status_code == 200
    claims = D.verify_delegation(vues[0].headers["authorization"][7:], CLE)
    assert claims["sub"] == "zoe" and claims["kind"] == "oauth"
    assert c.post("/api/mcp-bridge/git", json={}, headers={"Authorization": "Bearer oat_ko"}).status_code == 401
