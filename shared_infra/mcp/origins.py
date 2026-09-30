# SPDX-License-Identifier: MIT
"""shared_infra/mcp/origins.py — contrôle de l'en-tête ``Origin`` des requêtes
MCP (EXT.2, 2026-09-30).

La spécification MCP (transport HTTP streamable) exige que le serveur valide
``Origin`` : sans ce contrôle, une page web servie par un nom de domaine qui
se met à pointer vers l'hôte (« DNS rebinding ») pourrait parler au service
d'outils depuis le navigateur d'un utilisateur du réseau local.

Règle commune au relais de l'app et au service d'outils :

* ``Origin`` ABSENT → accepté : c'est le cas de tous les clients natifs (CLI,
  éditeurs, agents, SDK) ; seul un navigateur en pose un ;
* ``Origin`` présent → accepté seulement s'il figure dans ``mcp.allowed_origins``
  (config, relue à chaud), ``app.cors_origins`` ou ``LOCAL_MCP_ALLOWED_ORIGINS``
  (env, séparées par des virgules) ; le relais accepte EN PLUS sa propre
  origine (même hôte que la requête) ;
* ``null`` (iframe isolée, fichier local) n'est jamais une origine autorisée.

Comparaison exacte après normalisation (minuscules, sans ``/`` final) ; un
motif ``scheme://hote:*`` accepte n'importe quel port de cet hôte.
"""
from __future__ import annotations

import os
from typing import Iterable, Optional, Set


def _norm(origin: str) -> str:
    return str(origin or "").strip().rstrip("/").lower()


def _as_list(v) -> list:
    if isinstance(v, str):
        return [p for p in (x.strip() for x in v.split(",")) if p]
    if isinstance(v, (list, tuple, set)):
        return [str(x).strip() for x in v if str(x).strip()]
    return []


def allowed_origins() -> Set[str]:
    """Origines explicitement autorisées (config relue à chaque appel + env)."""
    out: Set[str] = set()
    try:
        from shared_infra.config import live_config_value
        out |= {_norm(o) for o in _as_list(live_config_value("mcp.allowed_origins", []))}
        out |= {_norm(o) for o in _as_list(live_config_value("app.cors_origins", []))}
    except Exception:                                             # noqa: BLE001
        pass
    out |= {_norm(o) for o in _as_list(os.environ.get("LOCAL_MCP_ALLOWED_ORIGINS", ""))}
    out.discard("")
    out.discard("null")
    return out


def _match(origin: str, patterns: Iterable[str]) -> bool:
    if origin in patterns:
        return True
    for p in patterns:
        if p.endswith(":*"):
            base = p[:-2]
            if origin.startswith(base + ":") and origin[len(base) + 1:].isdigit():
                return True
    return False


def origin_allowed(origin: Optional[str], *, own_host: str = "") -> bool:
    """``True`` si la requête peut passer au vu de son ``Origin``.

    ``own_host`` : valeur de l'en-tête ``Host`` de la requête, quand l'appelant
    (le relais de l'app) veut aussi accepter sa propre origine."""
    if origin is None or str(origin).strip() == "":
        return True
    o = _norm(origin)
    if o == "null" or "://" not in o:
        return False
    if own_host:
        host = o.split("://", 1)[1]
        if host == _norm(own_host):
            return True
    return _match(o, allowed_origins())


__all__ = ["allowed_origins", "origin_allowed"]
