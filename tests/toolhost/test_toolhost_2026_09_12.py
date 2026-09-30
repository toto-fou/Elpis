# SPDX-License-Identifier: MIT
"""P4 (2026-09-12) — hôte d'outils déportable : enveloppe d'identité signée,
porte d'entrée de l'API sandbox, relais de l'app, composition de l'hôte."""
from __future__ import annotations

import asyncio
import json
import os
import socket
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

# Au niveau module : ``from __future__ import annotations`` rend les annotations
# des handlers FastAPI (``request: Request``) des CHAÎNES résolues dans les
# globals du module — importées localement, FastAPI les prenait pour des
# paramètres de requête (422).
from fastapi import FastAPI, Request, WebSocket

from shared_infra.accounts import identity as I

# ── 1. Enveloppe d'identité ──────────────────────────────────────────────────

def test_enveloppe_signee_et_bornee():
    ident = I.Identity(user_id=7, username="hugo", roles=["user"], network_profile_id="bridge")
    h = I.sign(ident, "svc")
    assert I.verify(h, "svc") == ident
    assert I.verify(h, "autre") is None                        # mauvaise clé
    assert I.verify(h, "svc", now=time.time() + 120) is None    # rejeu périmé
    assert I.verify(h + "x", "svc") is None                      # altérée
    assert I.verify("", "svc") is None and I.verify(h, "") is None
    with pytest.raises(ValueError):
        I.sign(ident, "")


def test_contexte_et_registre():
    I.forget_all()
    ident = I.Identity(user_id=42, username="zoe", network_profile_id="isolated")
    assert I.resolve_username(42) is None
    tok = I.set_current(ident)
    try:
        assert I.current() is ident and I.resolve_username(42) == "zoe"
        assert I.resolve_user("zoe").user_id == 42
        assert I.resolve_network_profile_id(42) == "isolated"
    finally:
        I.reset_current(tok)
    # hors contexte : le registre garde la dernière identité vue (threads, GC)
    assert I.current() is None and I.resolve_username(42) == "zoe"
    assert I.resolve_username("x") is None and I.resolve_user("") is None
    I.forget_all()


def test_from_meta():
    m = I.from_meta({"username": "hugo", "user_id": "7", "chat_id": "c1"})
    assert m.user_id == 7 and m.chat_id == "c1"
    assert I.from_meta({"username": ""}) is None and I.from_meta(None) is None
    assert I.from_meta({"username": "x", "user_id": "abc"}).user_id == 0


# ── 2. Porte d'entrée de l'hôte (ToolhostAuthASGI) ──────────────────────────

@pytest.fixture
def guarded_app():
    from fastapi import Request
    from fastapi.testclient import TestClient

    from shared_infra.security.deps import require_user_id
    from toolhost.auth import ToolhostAuthASGI
    app = FastAPI()

    @app.get("/health")
    def health():
        return {"ok": True}

    @app.get("/mcp")
    def mcp_probe():
        return {"mcp": True}

    @app.get("/api/sandbox/whoami")
    def whoami(request: Request):
        uid = require_user_id(request)
        return {"uid": uid, "ctx": (I.current().username if I.current() else None),
                "state": request.state.toolhost_identity.username}

    app.add_middleware(ToolhostAuthASGI, token="svc", max_skew_s=60)
    return TestClient(app)


def _hdrs(uid=7, username="hugo", token="svc", key="svc"):
    return {"Authorization": f"Bearer {token}",
            I.IDENTITY_HEADER: I.sign(I.Identity(user_id=uid, username=username), key)}


def test_porte_refuse_sans_preuves_et_laisse_health_mcp(guarded_app):
    c = guarded_app
    assert c.get("/health").status_code == 200                   # ouvert
    assert c.get("/mcp").status_code == 200                      # FastMCP a son propre Bearer
    assert c.get("/api/sandbox/whoami").status_code == 401
    assert c.get("/api/sandbox/whoami", headers={"Authorization": "Bearer svc"}).status_code == 401
    assert c.get("/api/sandbox/whoami", headers=_hdrs(token="faux")).status_code == 401
    assert c.get("/api/sandbox/whoami", headers=_hdrs(key="faux")).status_code == 401
    r = c.get("/api/sandbox/whoami", headers=_hdrs())
    assert r.status_code == 200 and r.json() == {"uid": 7, "ctx": "hugo", "state": "hugo"}


def test_porte_sans_jeton_ferme_l_api(guarded_app):
    from fastapi.testclient import TestClient

    from toolhost.auth import ToolhostAuthASGI
    app = FastAPI()

    @app.get("/api/sandbox/x")
    def x():
        return {}
    app.add_middleware(ToolhostAuthASGI, token="")
    assert TestClient(app).get("/api/sandbox/x", headers=_hdrs()).status_code == 503


def test_require_user_id_court_circuite_l_identite_toolhost():
    from shared_infra.security.deps import require_user_id
    req = SimpleNamespace(state=SimpleNamespace(toolhost_identity=I.Identity(user_id=9, username="n")),
                          session={})
    assert require_user_id(req) == 9 and req.state.username == "n"


def test_ws_auth_lit_l_identite_toolhost():
    import shared_infra.routes  # noqa: F401 — ordre d'import du chef d'orchestre (pty ↔ _legacy)
    from shared_infra.terminal.pty import _ws_auth_uid
    ws = SimpleNamespace(scope={"state": {"toolhost_identity": I.Identity(user_id=5, username="w")}})
    assert _ws_auth_uid(ws) == 5


# ── 3. Résolveurs : identité d'abord, base ensuite ──────────────────────────

def test_get_sandbox_path_prefere_l_enveloppe(tmp_path, monkeypatch):
    from shared_infra.routes import _helpers as H
    monkeypatch.setattr(H, "SANDBOX_DIR", tmp_path)
    monkeypatch.setattr(H, "get_username_by_id", lambda uid: (_ for _ in ()).throw(AssertionError("base interrogée")))
    tok = I.set_current(I.Identity(user_id=77, username="remote-user"))
    try:
        p = H._get_sandbox_path(77)
    finally:
        I.reset_current(tok); I.forget_all()
    assert p == (tmp_path / "remote-user").resolve()


def test_profil_reseau_depuis_l_enveloppe(monkeypatch):
    from shared_infra.sandbox.executors import _user_sandbox as U
    tok = I.set_current(I.Identity(user_id=8, username="r", network_profile_id="bridge"))
    try:
        assert U.user_network_profile_id(8) == "bridge"
    finally:
        I.reset_current(tok); I.forget_all()


# ── 4. Relais côté app ──────────────────────────────────────────────────────

@pytest.fixture
def manifest_hosts(tmp_path, monkeypatch):
    from shared_infra.mcp import manifest as M

    def _write(hosts, placement=None):
        doc = {"mcpServers": {"elpis-tools": {"type": "http", "url": "http://127.0.0.1:8765/mcp",
                                              "x-elpis": {"role": "toolhost"}}},
               "sandboxHosts": hosts, "placement": placement or {"strategy": "single", "host": next(iter(hosts))}}
        p = tmp_path / "mcp.json"; p.write_text(json.dumps(doc), encoding="utf-8")
        monkeypatch.setenv("APP_MCP_MANIFEST", str(p)); M.reload()
    yield _write
    M.reload()


def test_hote_de_sandbox_local_ou_distant(manifest_hosts):
    from shared_infra.sandbox import relay as R
    manifest_hosts({"main": {"url": "http://127.0.0.1:8765", "token": "t"}})
    h = R.sandbox_host_for(1)
    assert h is not None and h.relay is False and R.relay_active_for(1) is False
    manifest_hosts({"vm": {"url": "https://vm-outils:8765", "token": "t"}})
    h = R.sandbox_host_for(1)
    assert h.relay is True and h.ws_url() == "wss://vm-outils:8765" and R.relay_active_for(1)
    manifest_hosts({"lan": {"url": "http://127.0.0.1:9000", "token": "t", "relay": True}})
    assert R.sandbox_host_for(1).relay is True                    # explicite
    manifest_hosts({"vm": {"url": "https://vm-outils:8765"}})    # sans jeton : rien ne part
    assert R.relay_active_for(1) is False
    assert R.is_relayed_path("/api/sandbox/tree") and R.is_relayed_path("/ws/terminal/abc")
    assert not R.is_relayed_path("/api/chat-saved-stream3") and not R.is_relayed_path("/api/mcp/categories")


def test_relais_transparent_en_mode_local(manifest_hosts):
    from fastapi.testclient import TestClient

    from shared_infra.sandbox.relay import SandboxRelayASGI
    manifest_hosts({"main": {"url": "http://127.0.0.1:8765", "token": "t"}})
    app = FastAPI()

    @app.get("/api/sandbox/tree")
    def tree():
        return {"local": True}
    app.add_middleware(SandboxRelayASGI)
    assert TestClient(app).get("/api/sandbox/tree").json() == {"local": True}


def _free_port() -> int:
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def _serve(app):
    """Serveur uvicorn de test dans un thread (logging global préservé)."""
    import logging

    import uvicorn
    names = ("uvicorn", "uvicorn.error", "uvicorn.access")
    levels = {n: logging.getLogger(n).level for n in names}
    port = _free_port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_config=None))
    t = threading.Thread(target=server.run, daemon=True); t.start()
    for _ in range(100):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                break
        except OSError:
            time.sleep(0.05)

    def _stop():
        server.should_exit = True; t.join(timeout=5)
        for n, lvl in levels.items():
            logging.getLogger(n).setLevel(lvl)
    return port, _stop


@pytest.fixture
def upstream():
    """Un faux hôte d'outils : porte d'entrée réelle + échos HTTP et WS."""
    from fastapi import Request, WebSocket

    from toolhost.auth import ToolhostAuthASGI
    up = FastAPI()

    @up.get("/api/sandbox/tree")
    def tree(request: Request):
        return {"who": request.state.toolhost_identity.username, "q": request.query_params.get("path")}

    @up.post("/api/sandbox/save")
    async def save(request: Request):
        body = await request.body()
        return {"got": len(body), "ctype": request.headers.get("content-type")}

    @up.websocket("/ws/terminal/{sid}")
    async def ws(ws: WebSocket, sid: str):
        await ws.accept()
        who = ws.scope["state"]["toolhost_identity"].username
        await ws.send_text(f"hello {who} {sid}")
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if msg.get("text") is not None:
                await ws.send_text("echo:" + msg["text"])
            elif msg.get("bytes") is not None:
                await ws.send_bytes(b"bin:" + msg["bytes"])
    up.add_middleware(ToolhostAuthASGI, token="svc-remote")
    port, stop = _serve(up)
    yield port
    stop()


def test_relais_http_et_ws_vers_un_hote_distant(manifest_hosts, upstream, monkeypatch):
    from fastapi.testclient import TestClient

    from shared_infra.sandbox import relay as R
    manifest_hosts({"vm": {"url": f"http://127.0.0.1:{upstream}", "token": "svc-remote", "relay": True}})
    monkeypatch.setattr(R.SandboxRelayASGI, "_session_uid", staticmethod(lambda scope: 7))
    monkeypatch.setattr(R, "_identity_for", lambda uid: I.Identity(user_id=uid, username="hugo"))
    app = FastAPI()

    @app.get("/api/sandbox/tree")
    def local_tree():
        return {"local": True}                                    # ne doit PAS être servi
    app.add_middleware(R.SandboxRelayASGI)
    c = TestClient(app)
    r = c.get("/api/sandbox/tree?path=/work")
    assert r.status_code == 200 and r.json() == {"who": "hugo", "q": "/work"}
    r = c.post("/api/sandbox/save", content=b"x" * 5000, headers={"content-type": "application/octet-stream"})
    assert r.json() == {"got": 5000, "ctype": "application/octet-stream"}
    with c.websocket_connect("/ws/terminal/s1") as ws:
        assert ws.receive_text() == "hello hugo s1"
        ws.send_text("ping"); assert ws.receive_text() == "echo:ping"
        ws.send_bytes(b"\x01\x02"); assert ws.receive_bytes() == b"bin:\x01\x02"
    # un en-tête d'identité forgé par le navigateur n'est JAMAIS retransmis
    r = c.get("/api/sandbox/tree", headers={I.IDENTITY_HEADER: I.sign(I.Identity(user_id=1, username="admin"), "svc-remote")})
    assert r.json()["who"] == "hugo"


def test_relais_hote_injoignable_repond_502(manifest_hosts, monkeypatch):
    from fastapi.testclient import TestClient

    from shared_infra.sandbox import relay as R
    manifest_hosts({"vm": {"url": "http://127.0.0.1:1", "token": "t", "relay": True}})
    monkeypatch.setattr(R.SandboxRelayASGI, "_session_uid", staticmethod(lambda scope: 7))
    monkeypatch.setattr(R, "_identity_for", lambda uid: I.Identity(user_id=uid, username="hugo"))
    app = FastAPI(); app.add_middleware(R.SandboxRelayASGI)
    assert TestClient(app).get("/api/sandbox/tree").status_code == 502


# ── 5. Routes internes (rappels de l'hôte) ──────────────────────────────────

def test_routes_internes_exigent_le_jeton_de_service(monkeypatch):
    from fastapi.testclient import TestClient

    import shared_infra.toolhost.routes_internal as RI
    from shared_infra.routes._state import router
    monkeypatch.setattr(RI, "_service_token", lambda: "svc")
    app = FastAPI(); app.include_router(router)
    c = TestClient(app)
    assert c.get("/api/internal/identity?username=x").status_code == 401
    assert c.get("/api/internal/identity?username=x", headers={"Authorization": "Bearer faux"}).status_code == 401
    r = c.get("/api/internal/identity?username=compte-inexistant", headers={"Authorization": "Bearer svc"})
    assert r.status_code == 200 and r.json() == {"ok": False}
    monkeypatch.setattr(RI, "_service_token", lambda: "")
    assert c.get("/api/internal/identity?username=x", headers={"Authorization": "Bearer svc"}).status_code == 503


def test_client_de_rappel_inactif_sans_url(monkeypatch):
    from shared_infra.toolhost import client as C
    monkeypatch.delenv("TOOLHOST_APP_URL", raising=False)
    C.clear_cache()
    assert C.enabled() is False and C.introspect_token("pcr_x") is None \
        and C.identity_for_username("a") is None and C.connector_hosts(1) == []


# ── 6. Composition de l'hôte ────────────────────────────────────────────────

def test_hote_compose_mcp_et_api_sandbox(tmp_path, monkeypatch):
    """``build_app`` : /health ouvert, API sandbox derrière la porte, /mcp servi
    par FastMCP avec le Bearer de service, ``/manifest`` auto-descriptif."""
    from fastapi.testclient import TestClient

    from toolhost import config as TC
    tc = TC.ToolhostConfig(host="127.0.0.1", port=1, transport="streamable-http", token="svc",
                           families=["fs", "chart"], sandbox_dir=str(tmp_path / "sb"),
                           db_path=str(tmp_path / "th.db"), source="file")
    monkeypatch.setenv("LOCAL_MCP_TOKEN", "svc")
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "th.db"))
    from shared_infra.routes import _helpers as H
    monkeypatch.setattr(H, "SANDBOX_DIR", tmp_path / "sb")
    from toolhost.app import build_app
    # ``apply_environment`` pose LOCAL_MCP_*/APP_* dans os.environ : restauré
    # à la sortie pour ne pas contaminer les tests suivants.
    _env = dict(os.environ)
    try:
        app = build_app(tc)
    finally:
        os.environ.clear(); os.environ.update(_env)
    with TestClient(app) as c:
        h = c.get("/health").json()
        assert h["ok"] and h["auth"] is True and "fs" in h["families"]
        assert c.get("/manifest").status_code == 401
        m = c.get("/manifest", headers=_hdrs()).json()
        assert m["ok"] and m["config"]["has_token"] and m["families"].get("fs") == 6
        assert c.get("/api/sandbox/tree").status_code == 401
        r = c.get("/api/sandbox/tree", headers=_hdrs(uid=7, username="hugo"))
        assert r.status_code == 200, r.text
        assert (tmp_path / "sb" / "hugo" / "work").is_dir()      # racine créée depuis l'enveloppe
        # /mcp : servi par FastMCP (sa propre porte Bearer / négociation MCP),
        # jamais par la nôtre — la réponse n'est PAS le refus d'identité de
        # ToolhostAuthASGI (401 « enveloppe … »), et un ping sans session
        # n'est pas 200.
        r = c.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"})
        assert r.status_code != 200 and "enveloppe" not in r.text
