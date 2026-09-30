# SPDX-License-Identifier: MIT
"""Banc de conformité MCP (EXT.2 + EXT.3, 2026-09-30).

Un VRAI service d'outils (familles réelles ``fs``, ``git`` et ``chart`` — cette
dernière sans sandbox) servi en HTTP streamable, le VRAI relais de l'app
devant, et les clients de référence — SDK officiel ``mcp`` (ClientSession +
streamable_http_client) et client FastMCP — contre ``/api/mcp-bridge[/<famille>]``.
Aucun appel réseau externe : tout est sur la boucle locale.

Ce que le banc verrouille :
  • ``initialize`` pour CHAQUE version de la spécification prise en charge
    (version négociée, capacités honnêtes, ``serverInfo`` d'Elpis) ;
  • ``tools/list`` paginé (``nextCursor``), noms, titres, annotations,
    ``inputSchema`` sans schéma booléen hors ``additionalProperties``,
    ``outputSchema`` ; mêmes outils vus par les deux clients ;
  • ``tools/call`` : succès avec ``structuredContent`` VALIDE contre
    ``outputSchema``, échec d'outil = ``isError``, arguments invalides =
    ``isError`` (2025-11-25), outil inconnu ou caché = erreur JSON-RPC -32602 ;
  • session : ``Mcp-Session-Id``, ``DELETE`` qui la ferme ;
  • transport : ``MCP-Protocol-Version`` inconnue = 400, ``Origin`` étranger =
    403 (relais ET service), et le relais ne retransmet jamais le jeton du
    client (délégation ``dlg_``).
"""
from __future__ import annotations

import asyncio
import json
import re
import socket
import threading
import time

import httpx
import pytest
import uvicorn
from jsonschema import Draft202012Validator

SVC = "svc-banc-conformite-2026"
PAGE = 4
FAMILLES = ["fs", "git", "chart"]
ACCEPT = "application/json, text/event-stream"


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


@pytest.fixture(scope="module")
def banc(tmp_path_factory):
    mp = pytest.MonkeyPatch()
    arrets = []
    try:
        racine = tmp_path_factory.mktemp("sandboxes")
        mp.setenv("APP_SANDBOX_DIR", str(racine))
        import shared_infra.db._connection as legacy
        mp.setattr(legacy, "DB_PATH", str(racine.parent / "app.db"))
        legacy.init_db()
        from shared_infra.accounts.users import create_user
        ids = {"alice": create_user("alice", "pw-alice-1"), "bob": create_user("bob", "pw-bob-1")}

        import server.local_mcp_server as S
        mp.setattr(S, "SANDBOX_ROOT", racine)
        personnels = {"ept_alice_direct": {"username": "alice", "kind": "tools", "families": ["fs"]}}
        mp.setattr(S, "remote_token_lookup", lambda t: personnels.get(t))
        S._remote_token_cache.clear()
        serveur = S.LocalToolsMCP("elpis-banc", auth=S._make_verifier(S.build_token_table(SVC, {})),
                                  version=S._app_version(), instructions=S.SERVER_INSTRUCTIONS,
                                  list_page_size=PAGE)
        S.install_middlewares(serveur)
        S.register_families_on(serveur, FAMILLES)
        from starlette.middleware import Middleware
        app_service = serveur.http_app(path="/mcp", middleware=[
            Middleware(S.McpGateASGI), Middleware(S.FamilyScopeASGI, base_path="/mcp")])
        url_service, stop = _servir(app_service)
        arrets.append(stop)

        import shared_infra.mcp.bridge as B
        import shared_infra.mcp.local_registry as LR
        mp.setattr(LR, "service_upstream", lambda: (f"{url_service}/mcp", SVC))
        clients = {
            "ept_alice": {"user_id": ids["alice"], "username": "alice", "kind": "tools",
                          "families": list(FAMILLES)},
            "pcr_bob": {"user_id": ids["bob"], "username": "bob", "kind": "opencode", "families": []},
        }
        mp.setattr(B, "_resolve_token", lambda t: clients.get(t))
        from fastapi import FastAPI

        from shared_infra.routes._state import router
        relais = FastAPI()
        relais.include_router(router)
        url_relais, stop = _servir(relais)
        arrets.append(stop)
        yield {"relais": url_relais + "/api/mcp-bridge", "service": url_service + "/mcp",
               "S": S, "racine": racine}
    finally:
        for stop in reversed(arrets):
            stop()
        mp.undo()


def _h(tok="ept_alice", **extra):
    h = {"Authorization": f"Bearer {tok}", "Accept": ACCEPT, "Content-Type": "application/json"}
    h.update(extra)
    return h


def _rpc(r: httpx.Response) -> dict:
    """Réponse JSON-RPC d'un POST (JSON direct ou flux SSE d'un seul message)."""
    if r.headers.get("content-type", "").startswith("application/json"):
        return r.json()
    for ligne in r.text.splitlines():
        if ligne.startswith("data:"):
            return json.loads(ligne[5:].strip())
    raise AssertionError(f"pas de message JSON-RPC : {r.status_code} {r.text[:200]}")


def _init(url, version, tok="ept_alice"):
    corps = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
             "params": {"protocolVersion": version, "capabilities": {},
                        "clientInfo": {"name": "banc", "version": "1"}}}
    r = httpx.post(url, json=corps, headers=_h(tok), timeout=20)
    assert r.status_code == 200, r.text
    sid = r.headers.get("mcp-session-id")
    assert sid
    h = _h(tok, **{"Mcp-Session-Id": sid, "MCP-Protocol-Version": version})
    httpx.post(url, json={"jsonrpc": "2.0", "method": "notifications/initialized"}, headers=h, timeout=20)
    return _rpc(r)["result"], h


def _avec_session(url, fn, tok="ept_alice"):
    """Exécute ``fn(session)`` dans une session du client officiel."""
    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client
    from mcp.shared._httpx_utils import create_mcp_http_client

    async def go():
        async with create_mcp_http_client(headers={"Authorization": f"Bearer {tok}"}) as hc:
            async with streamable_http_client(url, http_client=hc) as (r, w, _):
                async with ClientSession(r, w) as s:
                    init = await s.initialize()
                    return await fn(s, init)
    return asyncio.run(go())


async def _toutes_les_pages(s):
    outils, curseur, pages = [], None, 0
    while True:
        res = await s.list_tools(cursor=curseur) if curseur else await s.list_tools()
        outils += res.tools
        pages += 1
        curseur = res.nextCursor
        if not curseur:
            return outils, pages


def _schemas_booleens(x, chemin=""):
    """Chemins des sous-schémas booléens, hors ``additionalProperties`` (qui
    est du JSON Schema lu par tous les clients)."""
    out = []
    if isinstance(x, bool):
        out.append(chemin)
    elif isinstance(x, dict):
        for k, v in x.items():
            if k in ("default", "const", "enum", "examples", "additionalProperties"):
                continue
            out += _schemas_booleens(v, f"{chemin}/{k}")
    elif isinstance(x, list):
        for i, v in enumerate(x):
            out += _schemas_booleens(v, f"{chemin}[{i}]")
    return out


# ── initialize ───────────────────────────────────────────────────────────────

def test_initialize_pour_chaque_version(banc):
    from mcp.shared.version import SUPPORTED_PROTOCOL_VERSIONS
    S = banc["S"]
    for v in SUPPORTED_PROTOCOL_VERSIONS:
        res, _h2 = _init(banc["relais"], v)
        assert res["protocolVersion"] == v
        assert res["serverInfo"]["version"] == S._app_version()
        assert res["capabilities"]["tools"]["listChanged"] is False
        assert "Elpis" in res.get("instructions", "")


def test_initialize_client_officiel_negocie_la_derniere(banc):
    from mcp.types import LATEST_PROTOCOL_VERSION

    async def fn(s, init):
        return init
    init = _avec_session(banc["relais"], fn)
    assert init.protocolVersion == LATEST_PROTOCOL_VERSION
    assert init.capabilities.tools is not None and init.capabilities.tools.listChanged is False


# ── tools/list ───────────────────────────────────────────────────────────────

def test_liste_paginee_et_conforme(banc):
    S = banc["S"]

    async def fn(s, _init):
        return await _toutes_les_pages(s)
    outils, pages = _avec_session(banc["relais"], fn)
    noms = {t.name for t in outils}
    attendus = {n for n, f in S.TOOL_FAMILY_OF.items() if f in FAMILLES}
    assert noms == attendus and len(outils) == len(noms)
    assert pages > 1                                                  # PAGE = 4
    for t in outils:
        assert re.fullmatch(r"[A-Za-z0-9_-]{1,64}", t.name), t.name
        assert t.title or (t.annotations and t.annotations.title), t.name
        a = t.annotations
        assert a is not None and all(isinstance(getattr(a, k), bool) for k in (
            "readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint")), t.name
        assert t.inputSchema.get("type") == "object", t.name
        assert _schemas_booleens(t.inputSchema) == [], t.name
        Draft202012Validator.check_schema(t.inputSchema)
        if t.outputSchema is not None:
            assert t.outputSchema.get("type") == "object", t.name
            Draft202012Validator.check_schema(t.outputSchema)


def test_endpoint_de_famille_et_client_fastmcp(banc):
    from fastmcp import Client
    from fastmcp.client.transports import StreamableHttpTransport
    S = banc["S"]

    async def go():
        tr = StreamableHttpTransport(banc["relais"] + "/git", headers={"Authorization": "Bearer ept_alice"})
        async with Client(tr) as c:
            return await c.list_tools()
    outils = asyncio.run(go())
    assert {t.name for t in outils} == {n for n, f in S.TOOL_FAMILY_OF.items() if f == "git"}


def test_le_type_de_client_restreint_la_liste(banc):
    """Jeton opencode délégué : seules les familles opencode (git ici)."""
    S = banc["S"]

    async def fn(s, _init):
        return await _toutes_les_pages(s)
    outils, _p = _avec_session(banc["relais"], fn, tok="pcr_bob")
    assert {S.TOOL_FAMILY_OF[t.name] for t in outils} == {"git"}


# ── tools/call ───────────────────────────────────────────────────────────────

def _valide_structure(outils, res):
    t = next(t for t in outils if t.name == res[0])
    r = res[1]
    assert r.isError is False
    if t.outputSchema is not None:
        assert isinstance(r.structuredContent, dict)
        Draft202012Validator(t.outputSchema).validate(r.structuredContent)
    assert r.content and r.content[0].type == "text"            # repli texte


def test_appels_reussis_structures_valides(banc):
    from tests._git_amont import _git
    depot = banc["racine"] / "alice" / "work" / "proj"

    async def fn(s, _init):
        outils, _p = await _toutes_les_pages(s)
        out = []
        out.append(("write_file", await s.call_tool("write_file", {"path": "note.txt", "content": "bonjour\n"})))
        out.append(("read_file", await s.call_tool("read_file", {"path": "note.txt"})))
        depot.mkdir(parents=True, exist_ok=True)
        _git(depot, "init", "-q", "-b", "main")
        (depot / "a.txt").write_text("un\n")
        _git(depot, "add", "a.txt")
        _git(depot, "commit", "-q", "-m", "init")
        out.append(("git_query", await s.call_tool("git_query", {"repo": "proj", "action": "log"})))
        out.append(("chart_trend", await s.call_tool("chart_trend", {
            "chart_type": "line", "labels": ["a", "b"],
            "datasets": [{"label": "x", "data": [1, 2]}]})))
        return outils, out
    outils, res = _avec_session(banc["relais"], fn)
    for r in res:
        _valide_structure(outils, r)
    assert (banc["racine"] / "alice" / "work" / "note.txt").read_text() == "bonjour\n"
    assert "bonjour" in res[1][1].content[0].text


def test_echec_d_outil_et_arguments_invalides_sont_is_error(banc):
    async def fn(s, _init):
        manquant = await s.call_tool("read_file", {"path": "absent/nulle-part.txt"})
        invalide = await s.call_tool("chart_trend", {"inconnu": 1})
        return manquant, invalide
    manquant, invalide = _avec_session(banc["relais"], fn)
    assert manquant.isError is True
    env = json.loads(manquant.content[0].text)
    assert env.get("ok") is False
    assert invalide.isError is True                                  # 2025-11-25 : exécution


@pytest.mark.parametrize("outil", ["outil_inexistant", "execute_shell"])
def test_outil_inconnu_ou_cache_erreur_de_protocole(banc, outil):
    """``execute_shell`` existe, mais pas dans les familles du client."""
    from mcp.shared.exceptions import McpError

    async def fn(s, _init):
        try:
            await s.call_tool(outil, {})
        except McpError as e:
            return e.error
        return None
    err = _avec_session(banc["relais"], fn)
    assert err is not None and err.code == -32602 and "Unknown tool" in err.message


# ── Session et transport ─────────────────────────────────────────────────────

def test_session_fermee_par_delete(banc):
    url = banc["relais"]
    _res, h = _init(url, "2025-11-25")
    r = httpx.post(url, json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, headers=h, timeout=20)
    assert r.status_code == 200 and "tools" in _rpc(r)["result"]
    assert httpx.delete(url, headers=h, timeout=20).status_code in (200, 204)
    r = httpx.post(url, json={"jsonrpc": "2.0", "id": 3, "method": "tools/list"}, headers=h, timeout=20)
    assert r.status_code == 404


def test_version_de_protocole_inconnue_400(banc):
    for url in (banc["relais"], banc["service"]):
        tok = "ept_alice" if url == banc["relais"] else "ept_alice_direct"
        r = httpx.post(url, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                       headers=_h(tok, **{"MCP-Protocol-Version": "1999-01-01"}), timeout=20)
        assert r.status_code == 400, url


def test_origin_etranger_refuse_relais_et_service(banc, monkeypatch):
    corps = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
             "params": {"protocolVersion": "2025-11-25", "capabilities": {},
                        "clientInfo": {"name": "banc", "version": "1"}}}
    etranger = {"Origin": "http://evil.example"}
    assert httpx.post(banc["relais"], json=corps, headers=_h(**etranger), timeout=20).status_code == 403
    assert httpx.post(banc["service"], json=corps, headers=_h("ept_alice_direct", **etranger),
                      timeout=20).status_code == 403
    # Origine propre du relais : acceptée ; origine autorisée par la config : acceptée.
    propre = banc["relais"].split("/api/")[0]
    assert httpx.post(banc["relais"], json=corps, headers=_h(Origin=propre), timeout=20).status_code == 200
    monkeypatch.setenv("LOCAL_MCP_ALLOWED_ORIGINS", "http://outil.lan:*")
    assert httpx.post(banc["service"], json=corps,
                      headers=_h("ept_alice_direct", Origin="http://outil.lan:8080"),
                      timeout=20).status_code == 200


def test_jeton_personnel_direct_au_service(banc):
    """Clients locaux (opencode local, scripts) : un jeton personnel présenté
    directement au service marche toujours, avec ses familles."""
    S = banc["S"]

    async def fn(s, _init):
        return await _toutes_les_pages(s)
    outils, _p = _avec_session(banc["service"], fn, tok="ept_alice_direct")
    assert {S.TOOL_FAMILY_OF[t.name] for t in outils} == {"fs"}
