# SPDX-License-Identifier: MIT
"""shared_infra/toolhost/routes_internal.py — rappels de l'hôte d'outils
(``/api/internal/*``, 2026-09-11, P4).

Jeton de SERVICE requis (``Authorization: Bearer``, celui de l'entrée
``toolhost`` du manifeste — le même que l'app présente au service MCP).
Aucune session web, aucun cookie : ces routes ne servent qu'à un hôte
d'outils DISTANT qui n'ouvre pas la base de l'app. Sans jeton de service
configuré, elles répondent 503 (jamais un accès ouvert « par défaut »).

* ``POST /api/internal/tokens/introspect`` ``{token}`` → compte d'un jeton
  elpis-remote (``pcr_…``) — vérification opencode côté hôte ;
* ``GET  /api/internal/identity?username=`` → ``{user_id, username,
  network_profile_id, is_admin}`` ;
* ``GET  /api/internal/git/credential?user_id=&remote_url=`` → identifiant git
  résolu pour ce dépôt (SECRET : à ne servir qu'en TLS vers un hôte de confiance) ;
* ``GET  /api/internal/git/connector-hosts?user_id=`` → allowlist SSRF.
"""
from __future__ import annotations

import hmac
import logging
from typing import Any, Dict, Optional

from fastapi import HTTPException, Request

from shared_infra.routes._state import router

logger = logging.getLogger("uvicorn.error")


def _service_token() -> str:
    try:
        from shared_infra.mcp import manifest as _mf
        th = _mf.toolhost_entry()
        tok = th.token if th is not None else ""
    except Exception:
        tok = ""
    if not tok:
        try:
            from shared_infra import config as cfg
            tok = str(getattr(cfg, "LOCAL_MCP_TOKEN", "") or "").strip()
        except Exception:
            tok = ""
    return tok


def require_service_token(request: Request) -> None:
    tok = _service_token()
    if not tok:
        raise HTTPException(503, "aucun jeton de service configuré")
    auth = (request.headers.get("authorization") or "").strip()
    if not auth.lower().startswith("bearer ") or not hmac.compare_digest(auth[7:].strip(), tok):
        raise HTTPException(401, "jeton de service requis", headers={"WWW-Authenticate": "Bearer"})


def _identity_dict(uid: int) -> Optional[Dict[str, Any]]:
    from shared_infra.accounts.users import get_user_by_id, get_user_settings
    from shared_infra.sandbox.executors._user_sandbox import resolve_network_profile_id
    row = get_user_by_id(int(uid))
    if not row:
        return None
    try:
        settings = get_user_settings(int(uid)) or {}
    except Exception:
        settings = {}
    try:
        # Audit 2026-09-22, M1 : admin PLEIN (1), jamais le modérateur (2).
        is_admin = row["is_admin"] == 1
    except Exception:
        is_admin = False
    return {"user_id": int(row["id"]), "username": str(row["username"]),
            "network_profile_id": resolve_network_profile_id(settings),
            "is_admin": is_admin}


@router.post("/api/internal/tokens/introspect")
async def api_internal_introspect(request: Request):
    require_service_token(request)
    try:
        body = await request.json()
    except Exception:
        body = {}
    tok = str((body or {}).get("token") or "").strip()
    if not tok:
        raise HTTPException(400, "token requis")
    from shared_infra.config import feature_enabled
    from shared_infra.opencode.routes_code import _resolve_token
    if not feature_enabled("opencode"):
        return {"ok": False, "reason": "opencode désactivé"}
    uid = _resolve_token(tok)
    if uid is None:
        return {"ok": False}
    ident = _identity_dict(int(uid))
    if not ident:
        return {"ok": False}
    return {"ok": True, "kind": "opencode", **ident}


@router.get("/api/internal/identity")
def api_internal_identity(request: Request, username: str = ""):
    require_service_token(request)
    name = (username or "").strip()
    if not name:
        raise HTTPException(400, "username requis")
    from shared_infra.accounts.users import get_user
    row = get_user(name)
    if not row:
        return {"ok": False}
    ident = _identity_dict(int(row["id"]))
    return {"ok": True, **ident} if ident else {"ok": False}


@router.get("/api/internal/git/credential")
def api_internal_git_credential(request: Request, user_id: int = 0, remote_url: str = ""):
    require_service_token(request)
    if not user_id or not remote_url:
        raise HTTPException(400, "user_id et remote_url requis")
    from shared_infra.git.resolver import resolve_git_credential
    try:
        cred = resolve_git_credential(int(user_id), remote_url)
    except Exception as e:                                        # noqa: BLE001
        logger.warning("[internal] résolution d'identifiant git impossible : %r", e)
        cred = None
    if not cred:
        return {"ok": True, "credential": None}
    return {"ok": True, "credential": {"username": str(cred.get("username") or ""),
                                       "token": str(cred.get("token") or ""),
                                       "host": str(cred.get("host") or "")}}


@router.get("/api/internal/git/connector-hosts")
def api_internal_connector_hosts(request: Request, user_id: int = 0):
    require_service_token(request)
    if not user_id:
        raise HTTPException(400, "user_id requis")
    from shared_infra.git.connectors import list_connector_hosts
    try:
        hosts = list(list_connector_hosts(int(user_id)))
    except Exception:
        hosts = []
    return {"ok": True, "hosts": hosts}
