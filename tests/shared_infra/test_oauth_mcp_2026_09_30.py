# SPDX-License-Identifier: MIT
"""Autorisation OAuth 2.1 des clients MCP (EXT.4, 2026-09-30).

De bout en bout, avec le CLIENT OAUTH OFFICIEL du SDK ``mcp``
(``OAuthClientProvider`` + ``streamable_http_client``) contre le VRAI relais et
un VRAI service d'outils servis en boucle locale : le client ne reçoit que
l'URL du relais ; il découvre l'autorisation (RFC 9728 puis RFC 8414),
s'enregistre (RFC 7591), passe par l'écran de consentement (l'étape
« navigateur » est simulée : compte connecté + POST du consentement),
échange le code (PKCE S256, ``resource``), appelle un outil sous le bon
compte, rafraîchit, puis perd l'accès à la révocation.

Puis, au client de test HTTP : PKCE absent ou faux, ``resource`` absente ou
étrangère, redirection non enregistrée, code rejoué, rafraîchissement rejoué,
portée hors politique, compte supprimé, enregistrement dynamique coupé,
famille non accordée (403 ``insufficient_scope``).
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import re
import secrets
import socket
import threading
import time
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
import uvicorn
from fastapi import FastAPI
from fastapi.testclient import TestClient

SVC = "svc-banc-oauth-2026"
FAMILLES = ["fs", "git"]


def _port_libre() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _servir(app):
    import logging
    port = _port_libre()
    niveaux = {n: logging.getLogger(n).level for n in ("uvicorn", "uvicorn.error", "uvicorn.access")}
    srv = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_config=None,
                                        log_level="warning", lifespan="on"))
    fil = threading.Thread(target=srv.run, daemon=True)
    fil.start()
    for _ in range(200):
        try:
            socket.create_connection(("127.0.0.1", port), 0.2).close()
            break
        except OSError:
            time.sleep(0.05)

    def arreter():
        srv.should_exit = True
        fil.join(10)
        for n, lvl in niveaux.items():
            logging.getLogger(n).setLevel(lvl)
    return f"http://127.0.0.1:{port}", arreter


def _consentir(html_page: str, familles=None, decision="allow") -> dict:
    req = re.search(r'name="req" value="([^"]+)"', html_page).group(1)
    data = {"req": req.replace("&amp;", "&"), "decision": decision}
    offertes = re.findall(r'name="fam" value="([^"]+)"', html_page)
    choisies = offertes if familles is None else [f for f in offertes if f in familles]
    return {"data": data, "fams": choisies}


# ── Banc de bout en bout ─────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def banc(tmp_path_factory):
    mp = pytest.MonkeyPatch()
    arrets = []
    try:
        # Répertoire PROPRE au banc (base comprise) : un autre banc du même
        # worker xdist ne partage ni la base ni les sandboxes.
        base = tmp_path_factory.mktemp("banc_oauth")
        racine = base / "sandboxes"
        racine.mkdir()
        mp.setenv("APP_SANDBOX_DIR", str(racine))
        import shared_infra.db._connection as legacy
        mp.setattr(legacy, "DB_PATH", str(base / "app.db"))
        legacy.init_db()
        from shared_infra.accounts.users import create_user
        ids = {"alice": create_user("alice", "pw-alice-1"), "bob": create_user("bob", "pw-bob-1")}

        import server.local_mcp_server as S
        mp.setattr(S, "SANDBOX_ROOT", racine)
        mp.setattr(S, "remote_token_lookup", lambda t: None)
        S._remote_token_cache.clear()
        serveur = S.LocalToolsMCP("elpis-banc-oauth", auth=S._make_verifier(S.build_token_table(SVC, {})),
                                  version=S._app_version(), instructions=S.SERVER_INSTRUCTIONS)
        S.install_middlewares(serveur)
        S.register_families_on(serveur, FAMILLES)
        from starlette.middleware import Middleware
        app_service = serveur.http_app(path="/mcp", middleware=[
            Middleware(S.McpGateASGI), Middleware(S.FamilyScopeASGI, base_path="/mcp")])
        url_service, stop = _servir(app_service)
        arrets.append(stop)

        import shared_infra.mcp.local_registry as LR
        mp.setattr(LR, "service_upstream", lambda: (f"{url_service}/mcp", SVC))
        import shared_infra.mcp.routes_oauth as RO
        connecte = {"uid": ids["alice"]}
        mp.setattr(RO, "_session_user_id", lambda request: connecte["uid"])
        from shared_infra.routes._state import router
        relais = FastAPI()
        relais.include_router(router)
        url_relais, stop = _servir(relais)
        arrets.append(stop)
        yield {"base": url_relais, "relais": url_relais + "/api/mcp-bridge", "ids": ids,
               "connecte": connecte, "racine": racine}
    finally:
        for stop in reversed(arrets):
            stop()
        mp.undo()


class _Memoire:
    def __init__(self):
        self.tokens = None
        self.client = None

    async def get_tokens(self):
        return self.tokens

    async def set_tokens(self, tokens):
        self.tokens = tokens

    async def get_client_info(self):
        return self.client

    async def set_client_info(self, info):
        self.client = info


def _fournisseur(banc, url, stockage, familles=None, vus=None):
    """``OAuthClientProvider`` officiel ; l'étape navigateur = GET de la page
    de consentement (compte « connecté ») + POST de la décision."""
    from mcp.client.auth import OAuthClientProvider
    from mcp.shared.auth import OAuthClientMetadata
    etat = {}

    async def redirect_handler(auth_url: str) -> None:
        etat["url"] = auth_url
        if vus is not None:
            vus.append(auth_url)

    async def callback_handler():
        async with httpx.AsyncClient(base_url=banc["base"], follow_redirects=False) as h:
            p = urlsplit(etat["url"])
            page = await h.get(p.path + "?" + p.query)
            assert page.status_code == 200, page.text
            c = _consentir(page.text, familles)
            params = [("req", c["data"]["req"]), ("decision", "allow")] + [("fam", f) for f in c["fams"]]
            r = await h.post("/oauth/authorize", content=str(httpx.QueryParams(params)),
                             headers={"Content-Type": "application/x-www-form-urlencoded"})
            assert r.status_code == 302, r.text
            q = parse_qs(urlsplit(r.headers["location"]).query)
            assert q["iss"] == [banc["base"]]
            return q["code"][0], q.get("state", [None])[0]

    meta = OAuthClientMetadata(client_name="Client de recette", redirect_uris=["http://127.0.0.1:1/cb"],
                               grant_types=["authorization_code", "refresh_token"],
                               response_types=["code"], token_endpoint_auth_method="none")
    return OAuthClientProvider(url, meta, stockage, redirect_handler, callback_handler)


async def _session(url, fournisseur, fn):
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client
    async with httpx.AsyncClient(auth=fournisseur, timeout=30) as h:
        async with streamable_http_client(url, http_client=h) as (lire, ecrire, _sid):
            async with ClientSession(lire, ecrire) as s:
                await s.initialize()
                return await fn(s)


def test_client_officiel_de_bout_en_bout(banc):
    stockage = _Memoire()
    vus: list = []
    url = banc["relais"] + "/fs"

    async def ecrire_puis_lire(s):
        noms = {t.name for t in (await s.list_tools()).tools}
        r = await s.call_tool("write_file", {"path": "oauth.txt", "content": "via OAuth"})
        assert not r.isError, r
        r = await s.call_tool("read_file", {"path": "oauth.txt"})
        return noms, r

    noms, lu = asyncio.run(_session(url, _fournisseur(banc, url, stockage, vus=vus), ecrire_puis_lire))
    assert {"write_file", "read_file"} <= noms and not any(n.startswith("git") for n in noms)
    assert not lu.isError and "via OAuth" in str(lu.content)
    # La demande d'autorisation portait PKCE S256 et la ressource annoncée pour
    # l'URL jointe (RFC 9728 §3.3 : celle de la famille).
    q = parse_qs(urlsplit(vus[0]).query)
    assert q["code_challenge_method"] == ["S256"] and q["resource"] == [url]
    assert q["scope"] == ["tools:fs"]
    # Exécuté dans la sandbox d'alice (compte du consentement).
    assert list(banc["racine"].rglob("oauth.txt"))
    assert stockage.tokens.access_token.startswith("eoa_")
    assert stockage.tokens.refresh_token.startswith("eor_")

    # Rafraîchissement (rotation) puis révocation → le relais refuse.
    async def rafraichir():
        async with httpx.AsyncClient(base_url=banc["base"]) as h:
            r = await h.post("/oauth/token", data={
                "grant_type": "refresh_token", "refresh_token": stockage.tokens.refresh_token,
                "client_id": stockage.client.client_id})
            assert r.status_code == 200, r.text
            neuf = r.json()
            assert neuf["refresh_token"] != stockage.tokens.refresh_token
            rejeu = await h.post("/oauth/token", data={
                "grant_type": "refresh_token", "refresh_token": stockage.tokens.refresh_token,
                "client_id": stockage.client.client_id})
            assert rejeu.status_code == 400 and rejeu.json()["error"] == "invalid_grant"
            # Rejeu détecté : toute l'autorisation est révoquée, le neuf aussi.
            r = await h.post(url, headers={"Authorization": f"Bearer {neuf['access_token']}",
                                           "Accept": "application/json, text/event-stream"}, json={})
            assert r.status_code == 401
            assert 'error="invalid_token"' in r.headers["www-authenticate"]
    asyncio.run(rafraichir())


def test_decouverte_et_defi(banc):
    with httpx.Client(base_url=banc["base"]) as h:
        r = h.post("/api/mcp-bridge/git", json={})
        assert r.status_code == 401
        defi = r.headers["www-authenticate"]
        assert f'resource_metadata="{banc["base"]}/.well-known/oauth-protected-resource/api/mcp-bridge/git"' in defi
        assert 'scope="tools:git"' in defi
        prm = h.get("/.well-known/oauth-protected-resource/api/mcp-bridge/git").json()
        assert prm["resource"] == banc["relais"] + "/git" and prm["authorization_servers"] == [banc["base"]]
        assert h.get("/.well-known/oauth-protected-resource/api/mcp-bridge").json()["resource"] == banc["relais"]
        assert "tools:git" in prm["scopes_supported"] and "tools:chart" not in prm["scopes_supported"]
        asm = h.get("/.well-known/oauth-authorization-server").json()
        assert asm["code_challenge_methods_supported"] == ["S256"]
        assert asm["registration_endpoint"].endswith("/oauth/register")
        assert asm["client_id_metadata_document_supported"] is True
        from mcp.shared.auth import OAuthMetadata, ProtectedResourceMetadata
        OAuthMetadata.model_validate(asm)
        ProtectedResourceMetadata.model_validate(prm)


def test_famille_non_accordee_403_insufficient_scope(banc):
    stockage = _Memoire()
    url = banc["relais"]

    async def lister(s):
        return {t.name for t in (await s.list_tools()).tools}
    # Toutes familles demandées, git seul accordé au consentement.
    noms = asyncio.run(_session(url, _fournisseur(banc, url, stockage, familles=["git"]), lister))
    assert noms and all(not n.endswith("_file") for n in noms)
    with httpx.Client(base_url=banc["base"]) as h:
        r = h.post("/api/mcp-bridge/fs", json={}, headers={
            "Authorization": f"Bearer {stockage.tokens.access_token}",
            "Accept": "application/json, text/event-stream"})
        assert r.status_code == 403
        assert 'error="insufficient_scope"' in r.headers["www-authenticate"]
        assert 'scope="tools:fs"' in r.headers["www-authenticate"]


# ── Règles, au client de test HTTP ───────────────────────────────────────────

@pytest.fixture()
def api(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    legacy.init_db()
    from shared_infra.accounts.users import create_user
    ids = {"alice": create_user("alice", "pw-alice-1"), "bob": create_user("bob", "pw-bob-1")}
    cfg: dict = {}
    import shared_infra.accounts.tokens as T
    import shared_infra.mcp.oauth as O
    monkeypatch.setattr(T, "_cfg", lambda path, default: cfg.get(path, default))
    monkeypatch.setattr(O, "_cfg", lambda path, default: cfg.get(path, default))
    import shared_infra.mcp.routes_oauth as RO
    connecte = {"uid": ids["alice"]}
    monkeypatch.setattr(RO, "_session_user_id", lambda request: connecte["uid"])
    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app, base_url="http://testserver"), ids, cfg, connecte


RES = "http://testserver/api/mcp-bridge"
REDIRECT = "http://127.0.0.1:4242/cb"


def _pkce():
    v = secrets.token_urlsafe(48)
    return v, base64.urlsafe_b64encode(hashlib.sha256(v.encode()).digest()).decode().rstrip("=")


def _enregistrer(c, **extra):
    meta = {"client_name": "Test", "redirect_uris": [REDIRECT], "token_endpoint_auth_method": "none"}
    meta.update(extra)
    r = c.post("/oauth/register", json=meta)
    assert r.status_code == 201, r.text
    return r.json()


def _autoriser(c, cid, challenge, *, resource=RES, scope="tools", familles=None, redirect=REDIRECT):
    params = {"response_type": "code", "client_id": cid, "redirect_uri": redirect, "state": "st",
              "code_challenge": challenge, "code_challenge_method": "S256", "scope": scope}
    if resource is not None:
        params["resource"] = resource
    page = c.get("/oauth/authorize", params=params, follow_redirects=False)
    if page.status_code != 200:
        return page
    cons = _consentir(page.text, familles)
    body = [("req", cons["data"]["req"]), ("decision", "allow")] + [("fam", f) for f in cons["fams"]]
    return c.post("/oauth/authorize", content=str(httpx.QueryParams(body)), follow_redirects=False,
                  headers={"Content-Type": "application/x-www-form-urlencoded"})


def _code(r):
    assert r.status_code == 302, r.text
    return parse_qs(urlsplit(r.headers["location"]).query)


def _jetons(c, cid, code, verifier, **extra):
    data = {"grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT,
            "client_id": cid, "code_verifier": verifier, "resource": RES}
    data.update(extra)
    return c.post("/oauth/token", data=data)


def test_pkce_obligatoire_et_juste(api):
    c, _ids, _cfg, _ = api
    cid = _enregistrer(c)["client_id"]
    v, ch = _pkce()
    r = c.get("/oauth/authorize", params={"response_type": "code", "client_id": cid, "redirect_uri": REDIRECT,
                                          "state": "st", "resource": RES}, follow_redirects=False)
    assert _code(r)["error"] == ["invalid_request"] and _code(r)["state"] == ["st"]
    code = _code(_autoriser(c, cid, ch))["code"][0]
    r = _jetons(c, cid, code, "x" * 50)
    assert r.status_code == 400 and r.json()["error"] == "invalid_grant"
    code = _code(_autoriser(c, cid, ch))["code"][0]
    assert _jetons(c, cid, code, v).status_code == 200


def test_resource_absente_ou_etrangere(api):
    c, *_ = api
    cid = _enregistrer(c)["client_id"]
    _v, ch = _pkce()
    assert _code(_autoriser(c, cid, ch, resource=None))["error"] == ["invalid_target"]
    assert _code(_autoriser(c, cid, ch, resource="http://ailleurs/api/mcp-bridge"))["error"] == ["invalid_target"]
    assert _code(_autoriser(c, cid, ch, resource=RES + "/memory"))["error"] == ["invalid_target"]


def test_redirection_non_enregistree_ou_interdite(api):
    c, *_ = api
    cid = _enregistrer(c)["client_id"]
    _v, ch = _pkce()
    r = _autoriser(c, cid, ch, redirect="https://attaquant.example/cb")
    assert r.status_code == 400 and "location" not in r.headers          # jamais de redirection
    # Boucle locale : port libre (RFC 8252), même chemin.
    assert _code(_autoriser(c, cid, ch, redirect="http://127.0.0.1:5555/cb")).get("code")
    bad = c.post("/oauth/register", json={"redirect_uris": ["http://lan.example/cb"]})
    assert bad.status_code == 400 and bad.json()["error"] == "invalid_redirect_uri"
    bad = c.post("/oauth/register", json={"redirect_uris": ["monapp://cb"]})
    assert bad.status_code == 400


def test_code_rejoue_revoque_les_jetons(api):
    c, *_ = api
    cid = _enregistrer(c)["client_id"]
    v, ch = _pkce()
    code = _code(_autoriser(c, cid, ch))["code"][0]
    tok = _jetons(c, cid, code, v).json()
    from shared_infra.mcp import oauth as O
    assert O.verify_access_token(tok["access_token"])
    r = _jetons(c, cid, code, v)
    assert r.status_code == 400 and r.json()["error"] == "invalid_grant"
    assert O.verify_access_token(tok["access_token"]) is None


def test_portee_bornee_par_la_politique_et_consentement(api):
    c, ids, cfg, _ = api
    cid = _enregistrer(c)["client_id"]
    v, ch = _pkce()
    cfg["mcp.tokens.tools_families"] = "fs,git"
    page = c.get("/oauth/authorize", params={
        "response_type": "code", "client_id": cid, "redirect_uri": REDIRECT, "state": "st",
        "code_challenge": ch, "code_challenge_method": "S256", "scope": "tools", "resource": RES})
    assert re.findall(r'name="fam" value="([^"]+)"', page.text) == ["fs", "git"]
    assert _code(_autoriser(c, cid, ch, scope="tools:desktop"))["error"] == ["invalid_scope"]
    cfg["mcp.tokens.tools_families"] = "fs,git,desktop,browser"
    page = c.get("/oauth/authorize", params={
        "response_type": "code", "client_id": cid, "redirect_uri": REDIRECT, "state": "st",
        "code_challenge": ch, "code_challenge_method": "S256", "scope": "tools", "resource": RES})
    for fam in ("desktop", "browser"):                                  # jamais cochées d'office
        assert re.search(rf'value="{fam}">', page.text) and not re.search(rf'value="{fam}" checked', page.text)
    code = _code(_autoriser(c, cid, ch, familles=["git"]))["code"][0]
    tok = _jetons(c, cid, code, v).json()
    assert tok["scope"] == "tools:git"
    from shared_infra.mcp import oauth as O
    assert O.verify_access_token(tok["access_token"])["families"] == ["git"]
    cfg["mcp.tokens.tools_families"] = "fs"                            # l'admin retire git
    assert O.verify_access_token(tok["access_token"]) is None


def test_compte_supprime_et_connexions(api, monkeypatch):
    c, ids, _cfg, connecte = api
    cid = _enregistrer(c)["client_id"]
    v, ch = _pkce()
    tok = _jetons(c, cid, _code(_autoriser(c, cid, ch))["code"][0], v).json()
    import shared_infra.security.deps as deps
    from shared_infra.mcp import oauth as O
    monkeypatch.setattr(deps, "require_user_id", lambda request: connecte["uid"])
    items = c.get("/api/oauth/grants").json()["items"]
    assert len(items) == 1 and items[0]["families"]
    connecte["uid"] = ids["bob"]
    assert c.get("/api/oauth/grants").json()["items"] == []
    assert c.delete(f"/api/oauth/grants/{items[0]['grant_id']}").status_code == 404   # pas à lui
    connecte["uid"] = ids["alice"]
    lst = O.list_grants(ids["alice"])
    assert len(lst) == 1 and lst[0]["client_name"] == "Test"
    assert O.list_grants(ids["bob"]) == []
    assert O.revoke_grant(ids["bob"], lst[0]["grant_id"]) is False       # autre compte : rien
    from shared_infra.accounts.users import delete_user_full
    assert delete_user_full(ids["alice"])
    assert O.verify_access_token(tok["access_token"]) is None
    r = c.post("/oauth/token", data={"grant_type": "refresh_token", "refresh_token": tok["refresh_token"],
                                     "client_id": cid})
    assert r.status_code == 400


def test_consentement_lie_au_compte_connecte(api):
    c, ids, _cfg, connecte = api
    cid = _enregistrer(c)["client_id"]
    _v, ch = _pkce()
    page = c.get("/oauth/authorize", params={
        "response_type": "code", "client_id": cid, "redirect_uri": REDIRECT, "state": "st",
        "code_challenge": ch, "code_challenge_method": "S256", "scope": "tools", "resource": RES})
    assert "frame-ancestors 'none'" in page.headers["content-security-policy"]
    cons = _consentir(page.text)
    connecte["uid"] = ids["bob"]                                         # autre session
    r = c.post("/oauth/authorize", content=str(httpx.QueryParams([("req", cons["data"]["req"]),
                                                                  ("decision", "allow"), ("fam", "fs")])),
               headers={"Content-Type": "application/x-www-form-urlencoded"}, follow_redirects=False)
    assert r.status_code == 400 and "location" not in r.headers
    connecte["uid"] = None
    r = c.get("/oauth/authorize", params={
        "response_type": "code", "client_id": cid, "redirect_uri": REDIRECT, "state": "st",
        "code_challenge": ch, "code_challenge_method": "S256", "scope": "tools", "resource": RES},
        follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"].startswith("/?oauth_next=%2Foauth%2Fauthorize")


def test_refus_de_l_utilisateur(api):
    c, *_ = api
    cid = _enregistrer(c)["client_id"]
    _v, ch = _pkce()
    page = c.get("/oauth/authorize", params={
        "response_type": "code", "client_id": cid, "redirect_uri": REDIRECT, "state": "st",
        "code_challenge": ch, "code_challenge_method": "S256", "resource": RES})
    cons = _consentir(page.text)
    r = c.post("/oauth/authorize", content=str(httpx.QueryParams([("req", cons["data"]["req"]),
                                                                  ("decision", "deny")])),
               headers={"Content-Type": "application/x-www-form-urlencoded"}, follow_redirects=False)
    assert _code(r)["error"] == ["access_denied"] and _code(r)["state"] == ["st"]


def test_enregistrement_dynamique_coupe_et_client_confidentiel(api):
    c, _ids, cfg, _ = api
    conf = _enregistrer(c, token_endpoint_auth_method="client_secret_basic")
    assert conf["client_secret"].startswith("ecs_")
    v, ch = _pkce()
    code = _code(_autoriser(c, conf["client_id"], ch))["code"][0]
    r = _jetons(c, conf["client_id"], code, v)                           # sans secret
    assert r.status_code == 401 and r.json()["error"] == "invalid_client"
    code = _code(_autoriser(c, conf["client_id"], ch))["code"][0]
    basic = base64.b64encode(f"{conf['client_id']}:{conf['client_secret']}".encode()).decode()
    r = c.post("/oauth/token", headers={"Authorization": f"Basic {basic}"}, data={
        "grant_type": "authorization_code", "code": code, "redirect_uri": REDIRECT,
        "code_verifier": v, "resource": RES})
    assert r.status_code == 200, r.text
    cfg["mcp.oauth.dcr_enabled"] = False
    assert c.post("/oauth/register", json={"redirect_uris": [REDIRECT]}).status_code == 403
    assert "registration_endpoint" not in c.get("/.well-known/oauth-authorization-server").json()
    cfg["mcp.oauth.enabled"] = False
    assert c.get("/.well-known/oauth-authorization-server").status_code == 404
    assert c.get("/.well-known/oauth-protected-resource").status_code == 404


def test_revocation_rfc7009(api):
    c, *_ = api
    cid = _enregistrer(c)["client_id"]
    v, ch = _pkce()
    tok = _jetons(c, cid, _code(_autoriser(c, cid, ch))["code"][0], v).json()
    from shared_infra.mcp import oauth as O
    assert c.post("/oauth/revoke", data={"token": "inconnu", "client_id": cid}).status_code == 200
    assert c.post("/oauth/revoke", data={"token": tok["refresh_token"], "client_id": cid}).status_code == 200
    assert O.verify_access_token(tok["access_token"]) is None           # tout le lot


# ── Correctifs de la relecture finale ────────────────────────────────────────

def test_page_de_consentement_garde_l_origine(api):
    """same-origin : en http sur le LAN, le formulaire garde son Origin (le
    garde CSRF refuserait « Origin: null »)."""
    c, _ids, _cfg, _ = api
    cid = _enregistrer(c)["client_id"]
    _v, ch = _pkce()
    page = c.get("/oauth/authorize", params={"response_type": "code", "client_id": cid, "redirect_uri": REDIRECT,
                                             "state": "st", "code_challenge": ch, "code_challenge_method": "S256",
                                             "scope": "tools", "resource": RES}, follow_redirects=False)
    assert page.status_code == 200 and page.headers["referrer-policy"] == "same-origin"


def test_rafraichissements_concurrents_un_seul_gagne(api, monkeypatch):
    import threading

    import shared_infra.mcp.oauth as O
    c, *_ = api
    cid = _enregistrer(c)["client_id"]
    v, ch = _pkce()
    tok = _jetons(c, cid, _code(_autoriser(c, cid, ch))["code"][0], v).json()
    real = O._families_list
    bar = threading.Barrier(2, timeout=5)

    def lent(csv):
        try:
            bar.wait()
        except threading.BrokenBarrierError:
            pass
        return real(csv)
    monkeypatch.setattr(O, "_families_list", lent)
    client = O.get_client(cid)
    out = []

    def run():
        try:
            out.append(O.refresh(refresh_token=tok["refresh_token"], client=client, scope=None,
                                 resource=None, app_url="http://testserver"))
        except O.OAuthError:
            out.append(None)
    ts = [threading.Thread(target=run) for _ in range(2)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    monkeypatch.setattr(O, "_families_list", real)
    gagnants = [o for o in out if o]
    # Au plus un succès, et la réutilisation révoque tout le lot.
    assert len(gagnants) <= 1
    assert not any(O.verify_access_token(o["access_token"]) for o in gagnants)


def test_enregistrements_en_masse_n_empechent_pas_un_vrai_client(api, monkeypatch):
    import shared_infra.mcp.oauth as O
    c, *_ = api
    monkeypatch.setattr(O, "_MAX_CLIENTS", 3)
    for _ in range(5):
        _enregistrer(c)                                          # plus ancien inutilisé évincé
    import sqlite3

    import shared_infra.db._connection as legacy
    db = sqlite3.connect(legacy.DB_PATH)
    assert db.execute("SELECT COUNT(*) FROM oauth_clients WHERE kind='dcr'").fetchone()[0] == 3
    db.close()


def test_document_client_jamais_recupere_sans_connexion(api, monkeypatch):
    import shared_infra.mcp.oauth as O
    c, _ids, _cfg, connecte = api
    appels = []
    monkeypatch.setattr(O, "fetch_cimd", lambda *a, **k: appels.append(a) or (_ for _ in ()).throw(
        O.OAuthError("invalid_client", "x")))
    connecte["uid"] = None
    r = c.get("/oauth/authorize", params={"response_type": "code", "client_id": "https://app.example/client.json",
                                          "redirect_uri": REDIRECT, "code_challenge": "x" * 43,
                                          "code_challenge_method": "S256", "resource": RES},
              follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"].startswith("/?oauth_next=")
    assert appels == []


def test_redirection_implicite_non_exigee_au_jeton(api):
    """redirect_uri absente de la demande (une seule enregistrée) : pas exigée
    au point de jeton (RFC 6749 §4.1.3)."""
    c, *_ = api
    cid = _enregistrer(c)["client_id"]
    v, ch = _pkce()
    page = c.get("/oauth/authorize", params={"response_type": "code", "client_id": cid, "state": "st",
                                             "code_challenge": ch, "code_challenge_method": "S256",
                                             "scope": "tools", "resource": RES}, follow_redirects=False)
    cons = _consentir(page.text, None)
    body = [("req", cons["data"]["req"]), ("decision", "allow")] + [("fam", f) for f in cons["fams"]]
    r = c.post("/oauth/authorize", content=str(httpx.QueryParams(body)), follow_redirects=False,
               headers={"Content-Type": "application/x-www-form-urlencoded"})
    code = _code(r)["code"][0]
    t = c.post("/oauth/token", data={"grant_type": "authorization_code", "code": code, "client_id": cid,
                                      "code_verifier": v, "resource": RES})
    assert t.status_code == 200, t.text
