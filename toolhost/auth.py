# SPDX-License-Identifier: MIT
"""toolhost/auth.py — porte d'entrée de l'API sandbox de l'hôte d'outils.

Deux preuves, TOUTES DEUX requises hors ``/mcp*`` et ``/health`` :

* ``Authorization: Bearer <jeton de service>`` — le canal est l'app (ou un
  opérateur qui détient le jeton) ;
* ``X-Elpis-Identity: <enveloppe signée>`` — QUI agit (``shared_infra.accounts.
  identity.verify`` : HMAC avec le jeton de service, horodatage borné).

L'identité vérifiée est posée pour la requête : ``scope["session"] =
{"user_id"}`` (ce que lit ``require_user_id``), ``request.state.toolhost_identity``
(court-circuit des contrôles de session en base, cf. ``security/deps.py``) et le
``ContextVar`` du module identité (résolution username ⇄ id sans base).

``/mcp*`` garde son propre vérificateur Bearer (FastMCP) ; ``/health`` est ouvert.
"""
from __future__ import annotations

import hmac
import json
import logging
from typing import Any, Iterable

from shared_infra.accounts import identity as _identity

logger = logging.getLogger("uvicorn.error")

OPEN_PATHS = ("/health",)
MCP_PREFIXES = ("/mcp",)


def _header(scope: dict, name: str) -> str:
    want = name.lower().encode("latin-1")
    for k, v in scope.get("headers") or ():
        if k.lower() == want:
            try:
                return v.decode("latin-1")
            except Exception:
                return ""
    return ""


def bearer_matches(scope: dict, token: str) -> bool:
    if not token:
        return False
    auth = _header(scope, "authorization").strip()
    if not auth.lower().startswith("bearer "):
        return False
    return hmac.compare_digest(auth[7:].strip(), token)


class ToolhostAuthASGI:
    def __init__(self, app: Any, *, token: str, max_skew_s: float = 60.0,
                 open_paths: Iterable[str] = OPEN_PATHS,
                 mcp_prefixes: Iterable[str] = MCP_PREFIXES) -> None:
        self.app = app
        self.token = str(token or "")
        self.max_skew_s = float(max_skew_s)
        self.open_paths = tuple(open_paths)
        self.mcp_prefixes = tuple(mcp_prefixes)

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        typ = scope.get("type")
        if typ not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        path = scope.get("path", "") or ""
        if path in self.open_paths or path.startswith(self.mcp_prefixes):
            return await self.app(scope, receive, send)
        if not self.token:
            return await self._reject(scope, send, 503,
                                      "hôte d'outils sans jeton de service : API sandbox fermée")
        if not bearer_matches(scope, self.token):
            return await self._reject(scope, send, 401, "jeton de service requis")
        ident = _identity.verify(_header(scope, _identity.IDENTITY_HEADER), self.token,
                                 max_skew_s=self.max_skew_s)
        if ident is None:
            return await self._reject(scope, send, 401, "enveloppe d'identité absente ou invalide")
        scope["session"] = {"user_id": ident.user_id}
        state = scope.setdefault("state", {})
        state["toolhost_identity"] = ident
        tok = _identity.set_current(ident)
        try:
            await self.app(scope, receive, send)
        finally:
            _identity.reset_current(tok)

    @staticmethod
    async def _reject(scope: dict, send: Any, status: int, detail: str) -> None:
        if scope.get("type") == "websocket":
            await send({"type": "websocket.close", "code": 4401 if status == 401 else 4503,
                        "reason": detail[:120]})
            return
        body = json.dumps({"detail": detail}, ensure_ascii=False).encode("utf-8")
        headers = [(b"content-type", b"application/json; charset=utf-8"),
                   (b"content-length", str(len(body)).encode("ascii"))]
        if status == 401:
            headers.append((b"www-authenticate", b"Bearer"))
        await send({"type": "http.response.start", "status": status, "headers": headers})
        await send({"type": "http.response.body", "body": body})
