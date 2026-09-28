# SPDX-License-Identifier: MIT
"""
shared_infra/security/local_request.py — « cette requête vient-elle de la
machine elle-même, sans proxy ? »

Un reverse proxy local (Caddy) fait apparaître tout le LAN comme
``127.0.0.1`` : une requête n'est « locale » que si l'adresse du pair est la
boucle locale ET qu'aucun en-tête de relais n'est présent. Uvicorn ne réécrit
l'adresse depuis ``X-Forwarded-For`` que pour un pair de confiance
(``forwarded_allow_ips``) : un client du LAN ne peut pas se faire passer pour
la boucle locale.
"""
from __future__ import annotations

_LOOPBACK = frozenset({"127.0.0.1", "::1", "localhost"})
_PROXY_HEADERS = ("x-forwarded-for", "x-real-ip", "forwarded", "via")


def is_direct_local(request) -> bool:
    host = request.client.host if getattr(request, "client", None) else ""
    return host in _LOOPBACK and not any(h in request.headers for h in _PROXY_HEADERS)


__all__ = ["is_direct_local"]
