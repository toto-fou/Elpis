# SPDX-License-Identifier: MIT
"""shared_infra/sandbox/relay.py — relais de l'app vers un hôte d'outils DISTANT
(2026-09-11, P4).

Quand le sandbox de l'utilisateur vit sur un autre hôte (``mcp.json ›
sandboxHosts`` + ``placement``), les chemins que le navigateur utilise déjà —
``/api/sandbox/*`` (éditeur, fichiers, git, cycle de vie, instantanés),
``/api/terminal/*`` et ``/ws/terminal*`` (terminal), ``/api/playwright/
screenshot/*`` et ``/api/desktop/frame/*`` (captures, trames), ``/api/memory/ax*``
(cartographie AX) — sont RELAYÉS tels quels vers l'hôte, avec le jeton de
service et l'enveloppe d'identité signée de la session (``X-Elpis-Identity``).
Le contrat front ne change pas. En mode local (hôte en loopback, ou sans hôte
déclaré) le relais est INACTIF : les routeurs restent servis en direct.

Middleware ASGI, monté INTÉRIEUR à ``SessionMiddleware`` et à la garde CSRF
(qui ont déjà fait leur travail quand il s'exécute) — cf. ``server/app.py``.
Un en-tête d'identité venu du NAVIGATEUR n'est jamais retransmis : l'enveloppe
est toujours fabriquée ici, depuis la session vérifiée.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, Optional, Tuple

from shared_infra.accounts import identity as _identity

logger = logging.getLogger("uvicorn.error")

RELAY_PREFIXES: Tuple[str, ...] = (
    "/api/sandbox/", "/api/terminal/", "/ws/terminal",
    "/api/playwright/screenshot/", "/api/desktop/frame/", "/api/memory/ax",
)
_HOP_BY_HOP = frozenset({
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length",
})
_FWD_REQ_HEADERS = (
    "accept", "content-type", "content-length", "range", "if-none-match",
    "if-modified-since", "last-event-id", "x-requested-with", "cache-control",
)
_CONNECT_TIMEOUT_S = 5.0


# ── Hôte de sandbox de l'utilisateur ────────────────────────────────────────
def _is_loopback(url: str) -> bool:
    from urllib.parse import urlparse
    try:
        h = (urlparse(url).hostname or "").lower()
    except Exception:
        return True
    return h in ("127.0.0.1", "localhost", "::1", "")


class SandboxHost:
    __slots__ = ("id", "url", "token", "relay")

    def __init__(self, id: str, url: str, token: str, relay: bool) -> None:
        self.id, self.url, self.token, self.relay = id, url.rstrip("/"), token, relay

    def ws_url(self) -> str:
        u = self.url
        if u.startswith("https://"):
            return "wss://" + u[len("https://"):]
        if u.startswith("http://"):
            return "ws://" + u[len("http://"):]
        return u


def sandbox_host_for(user_id: Optional[int] = None) -> Optional[SandboxHost]:
    """Hôte de sandbox de ce compte d'après le manifeste, ou ``None`` (aucun
    hôte déclaré). ``relay`` = explicite (``relay: true|false``) sinon
    « pas en loopback ». Placement : ``single`` (P4) ; ``by_user`` (P5) via la
    table de placement, avec repli sur l'hôte par défaut."""
    try:
        from shared_infra.mcp import manifest as _mf
        m = _mf.load()
    except Exception:
        return None
    hosts = m.sandbox_hosts or {}
    if not hosts:
        return None
    pl = m.placement or {}
    hid = str(pl.get("host") or "")
    if str(pl.get("strategy") or "single") == "by_user" and user_id:
        try:
            from shared_infra.sandbox.placement import host_for_user
            hid = host_for_user(int(user_id), hosts, default=hid) or hid
        except Exception:
            pass
    if not hid or hid not in hosts:
        hid = next(iter(hosts))
    spec = hosts.get(hid) or {}
    url = str(spec.get("url") or "").strip()
    if not url:
        return None
    relay = spec.get("relay")
    relay = bool(relay) if isinstance(relay, bool) else (not _is_loopback(url))
    return SandboxHost(hid, url, str(spec.get("token") or ""), relay)


def relay_active_for(user_id: Optional[int] = None) -> bool:
    h = sandbox_host_for(user_id)
    return bool(h and h.relay and h.token)


def is_relayed_path(path: str) -> bool:
    return any(path.startswith(p) for p in RELAY_PREFIXES)


def _identity_for(uid: int) -> _identity.Identity:
    from shared_infra.accounts.users import get_user_by_id, get_user_settings, get_username_by_id
    username = get_username_by_id(uid) or f"user_{uid}"
    is_admin = False
    try:
        row = get_user_by_id(uid)
        is_admin = bool(row and row["is_admin"] == 1)   # 2 = modérateur (audit 2026-09-22, M1)
    except Exception:
        pass
    npid = ""
    try:
        from shared_infra.sandbox.executors._user_sandbox import resolve_network_profile_id
        npid = resolve_network_profile_id(get_user_settings(uid) or {})
    except Exception:
        pass
    return _identity.Identity(user_id=uid, username=username, is_admin=is_admin,
                              network_profile_id=npid)


def relay_headers(host: SandboxHost, uid: int) -> Dict[str, str]:
    ident = _identity_for(uid)
    return {"authorization": f"Bearer {host.token}",
            _identity.IDENTITY_HEADER: _identity.sign(ident, host.token)}


# ── Middleware ──────────────────────────────────────────────────────────────
class SandboxRelayASGI:
    def __init__(self, app: Any) -> None:
        self.app = app
        # Un client httpx PAR BOUCLE d'événements (un client asyncio est lié à
        # sa boucle : partagé entre boucles — TestClient, redémarrage de
        # worker — il lève « Event loop is closed »).
        self._clients: Dict[tuple, Any] = {}

    def _client(self, host: SandboxHost):
        import httpx
        try:
            loop_key = id(asyncio.get_running_loop())
        except RuntimeError:
            loop_key = 0
        key = (loop_key, host.url)
        c = self._clients.get(key)
        if c is None or c.is_closed:
            for k in [k for k, v in self._clients.items() if k[0] != loop_key]:
                self._clients.pop(k, None)               # boucles disparues
            c = httpx.AsyncClient(timeout=httpx.Timeout(None, connect=_CONNECT_TIMEOUT_S),
                                  follow_redirects=False)
            self._clients[key] = c
        return c

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        typ = scope.get("type")
        if typ not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        path = scope.get("path", "") or ""
        if not is_relayed_path(path):
            return await self.app(scope, receive, send)
        uid = self._session_uid(scope)
        host = sandbox_host_for(uid)
        if host is None or not host.relay:
            return await self.app(scope, receive, send)      # mode local : routeurs en direct
        if uid is None:
            return await self._reject(scope, send, 401, "not logged in")
        if not host.token:
            return await self._reject(scope, send, 503, "hôte d'outils sans jeton de service")
        if typ == "websocket":
            # Contrôle d'origine AVANT le relais (audit 2026-09-22, M3) : la
            # route locale /ws/terminal applique ``ws_is_cross_site``, mais en
            # mode relais le handshake n'y arrive jamais — un site same-site
            # cross-origin ouvrait le terminal de la victime.
            from starlette.requests import HTTPConnection

            from shared_infra.security.csrf import ws_is_cross_site
            if ws_is_cross_site(HTTPConnection(scope)):
                await send({"type": "websocket.close", "code": 4403})
                return
            return await self._relay_ws(scope, receive, send, host, uid)
        return await self._relay_http(scope, receive, send, host, uid)

    @staticmethod
    def _session_uid(scope: dict) -> Optional[int]:
        try:
            from starlette.requests import HTTPConnection

            from shared_infra.security.deps import require_user_id
            conn = HTTPConnection(scope)
            return int(require_user_id(conn))  # type: ignore[arg-type]
        except Exception:
            return None

    @staticmethod
    async def _reject(scope: dict, send: Any, status: int, detail: str) -> None:
        import json as _json
        if scope.get("type") == "websocket":
            await send({"type": "websocket.close", "code": 4401 if status == 401 else 4503})
            return
        body = _json.dumps({"detail": detail}).encode("utf-8")
        await send({"type": "http.response.start", "status": status,
                    "headers": [(b"content-type", b"application/json; charset=utf-8"),
                                (b"content-length", str(len(body)).encode("ascii"))]})
        await send({"type": "http.response.body", "body": body})

    # ── HTTP ────────────────────────────────────────────────────────────────
    async def _relay_http(self, scope: dict, receive: Any, send: Any,
                          host: SandboxHost, uid: int) -> None:
        import httpx
        path = scope["path"]
        qs = (scope.get("query_string") or b"").decode("latin-1")
        url = host.url + path + (f"?{qs}" if qs else "")
        req_headers: Dict[str, str] = {}
        for k, v in scope.get("headers") or ():
            name = k.decode("latin-1").lower()
            if name in _FWD_REQ_HEADERS:
                req_headers[name] = v.decode("latin-1")
        req_headers.update(relay_headers(host, uid))
        client_ip = (scope.get("client") or ("", 0))[0]
        if client_ip:
            req_headers["x-forwarded-for"] = str(client_ip)
        method = scope.get("method", "GET")

        async def _body():
            while True:
                msg = await receive()
                if msg["type"] == "http.request":
                    chunk = msg.get("body") or b""
                    if chunk:
                        yield chunk
                    if not msg.get("more_body"):
                        return
                elif msg["type"] == "http.disconnect":
                    return

        client = self._client(host)
        content: Any = _body() if method in ("POST", "PUT", "PATCH", "DELETE") else None
        try:
            upstream = await client.send(
                client.build_request(method, url, headers=req_headers, content=content),
                stream=True)
        except httpx.RequestError as exc:
            logger.warning("[sandbox-relay] hôte %s injoignable (%s) : %r", host.id, url, exc)
            return await self._reject(scope, send, 502,
                                      "L'hôte d'outils ne répond pas. Vérifiez qu'il tourne et que mcp.json pointe dessus.")
        headers = [(k.lower().encode("latin-1"), v.encode("latin-1"))
                   for k, v in upstream.headers.multi_items()
                   if k.lower() not in _HOP_BY_HOP]
        headers.append((b"x-accel-buffering", b"no"))
        await send({"type": "http.response.start", "status": upstream.status_code,
                    "headers": headers})
        try:
            async for chunk in upstream.aiter_raw():
                if chunk:
                    await send({"type": "http.response.body", "body": chunk, "more_body": True})
        except (httpx.HTTPError, OSError) as exc:
            logger.info("[sandbox-relay] flux amont interrompu (%s) : %r", url, exc)
        finally:
            await upstream.aclose()
        await send({"type": "http.response.body", "body": b"", "more_body": False})

    # ── WebSocket (terminal) ────────────────────────────────────────────────
    async def _relay_ws(self, scope: dict, receive: Any, send: Any,
                        host: SandboxHost, uid: int) -> None:
        import websockets
        path = scope["path"]
        qs = (scope.get("query_string") or b"").decode("latin-1")
        url = host.ws_url() + path + (f"?{qs}" if qs else "")
        hdrs = relay_headers(host, uid)
        # Le handshake du navigateur est ACCEPTÉ d'abord (sinon un refus amont
        # ferait répondre 403 au client sans code lisible), puis fermé proprement.
        await send({"type": "websocket.accept"})
        try:
            upstream = await websockets.connect(url, additional_headers=list(hdrs.items()),
                                                open_timeout=_CONNECT_TIMEOUT_S, max_size=None)
        except Exception as exc:                                  # noqa: BLE001
            logger.warning("[sandbox-relay] WS amont %s : %r", url, exc)
            await send({"type": "websocket.close", "code": 1011, "reason": "tool host unreachable"})
            return

        async def _to_upstream() -> None:
            while True:
                msg = await receive()
                t = msg["type"]
                if t == "websocket.receive":
                    if msg.get("bytes") is not None:
                        await upstream.send(msg["bytes"])
                    elif msg.get("text") is not None:
                        await upstream.send(msg["text"])
                elif t == "websocket.disconnect":
                    return

        async def _to_client() -> None:
            async for data in upstream:
                if isinstance(data, (bytes, bytearray)):
                    await send({"type": "websocket.send", "bytes": bytes(data)})
                else:
                    await send({"type": "websocket.send", "text": data})

        t1 = asyncio.create_task(_to_upstream())
        t2 = asyncio.create_task(_to_client())
        try:
            done, pending = await asyncio.wait({t1, t2}, return_when=asyncio.FIRST_COMPLETED)
            for t in pending:
                t.cancel()
            for t in done:
                exc = t.exception()
                if exc is not None and not isinstance(exc, asyncio.CancelledError):
                    logger.info("[sandbox-relay] WS %s terminé : %r", path, exc)
        finally:
            try:
                await upstream.close()
            except Exception:
                pass
            try:
                await send({"type": "websocket.close", "code": 1000})
            except Exception:
                pass


# ── Actifs (captures, trames) lus par la boucle de chat (vision) ────────────
async def fetch_relayed_bytes(uid: int, path: str, *, timeout_s: float = 10.0) -> Optional[bytes]:
    """Octets d'un chemin relayé (``/api/playwright/screenshot/<f>``,
    ``/api/desktop/frame/<token>``) pour ce compte — ``None`` en mode local
    (l'appelant lit alors le fichier partagé comme avant) ou en cas d'échec."""
    host = sandbox_host_for(uid)
    if host is None or not host.relay or not host.token:
        return None
    try:
        import httpx
        async with httpx.AsyncClient(timeout=timeout_s) as c:
            r = await c.get(host.url + path, headers=relay_headers(host, uid))
            if r.status_code != 200:
                return None
            return r.content
    except Exception as exc:                                      # noqa: BLE001
        logger.info("[sandbox-relay] actif %s : %r", path, exc)
        return None


def push_skills_mirror(user_id: int, store_dir: Any, *, timeout_s: float = 30.0) -> bool:
    """Pousse le store de skills du compte vers son hôte d'outils DISTANT
    (``POST /api/sandbox/skills-mirror``, tar.gz) — appelé après chaque
    mutation du store. Synchrone, best-effort ; ``False`` en mode local ou en
    cas d'échec (le prochain ``skill_run_script`` le dira)."""
    host = sandbox_host_for(user_id)
    if host is None or not host.relay or not host.token:
        return False
    import io as _io
    import tarfile as _tarfile
    from pathlib import Path as _P
    d = _P(str(store_dir))
    if not d.is_dir():
        return False
    buf = _io.BytesIO()
    try:
        with _tarfile.open(fileobj=buf, mode="w:gz") as tf:
            for p in sorted(d.rglob("*")):
                if p.is_file() and "__pycache__" not in p.parts:
                    tf.add(p, arcname=str(p.relative_to(d)))
        import httpx
        r = httpx.post(host.url + "/api/sandbox/skills-mirror",
                       headers=relay_headers(host, int(user_id)),
                       files={"archive": ("skills.tar.gz", buf.getvalue(), "application/gzip")},
                       timeout=timeout_s)
        return r.status_code == 200
    except Exception as exc:                                      # noqa: BLE001
        logger.warning("[sandbox-relay] miroir des skills non poussé (%s) : %r", host.id, exc)
        return False

