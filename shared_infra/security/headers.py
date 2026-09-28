# SPDX-License-Identifier: MIT
"""
shared_infra/security/headers.py — en-têtes de sécurité par défaut.

Audit 2026-09-22 (M4) : aucune réponse ne portait ``nosniff``,
``Referrer-Policy`` ni ``frame-ancestors`` — l'admin pouvait être encadré
par un site tiers (clickjacking) et rien ne bornait un type MIME deviné.

Posés seulement s'ils sont ABSENTS : une route qui fixe les siens (aperçu de
sandbox : ``CSP: sandbox``, ``Referrer-Policy`` propre) les garde.
Une CSP ``script-src`` complète demanderait d'inventorier les scripts inline
des gabarits Vue en DOM : elle reste à faire, ``frame-ancestors`` seul ici.

ASGI pur (pas ``BaseHTTPMiddleware``) : ne tamponne pas les flux SSE.
"""
from __future__ import annotations

_DEFAULTS = (
    (b"x-content-type-options", b"nosniff"),
    (b"referrer-policy", b"strict-origin-when-cross-origin"),
    (b"x-frame-options", b"SAMEORIGIN"),
    (b"content-security-policy", b"frame-ancestors 'self'"),
)


class SecurityHeadersASGI:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        async def _send(message):
            if message.get("type") == "http.response.start":
                headers = list(message.get("headers") or [])
                present = {k.lower() for k, _ in headers}
                headers += [(k, v) for k, v in _DEFAULTS if k not in present]
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, _send)


__all__ = ["SecurityHeadersASGI"]
