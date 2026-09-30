# SPDX-License-Identifier: MIT
"""
shared_infra/mcp/routes_openapi.py — routes de la façade OpenAPI (EXT.5).

* ``GET  /api/tools/{famille}/openapi.json`` — spec OpenAPI 3.1 de la famille ;
* ``POST /api/tools/{famille}/{outil}``      — appel d'un outil.

AUTHENTIFICATION : ``Authorization: Bearer ept_…`` (jeton d'outils créé dans
Paramètres › Connexions) et RIEN d'autre. Le cookie de session n'est pas lu
(pas de CSRF possible, et un navigateur n'a rien à faire ici) ; un jeton
opencode (``pcr_``) ou de vision (``evt_``) est refusé comme un jeton inconnu.

PORTÉE : famille demandée ∩ familles exposables (``openapi.EXPOSABLE_FAMILIES``)
∩ politique de l'admin (``mcp.tokens.tools_families``) ∩ familles cochées sur
le jeton. Hors portée = 404, identique à une famille ou un outil inexistant
(aucun oracle). Fonction coupée par l'admin (``mcp.tokens.tools_enabled``) =
404 sur toute la façade.

Les routes ne recouvrent rien : ``/api/tools/extract-text`` et
``/api/tools/parse-file`` (un seul segment) restent à ``shared_infra.routes.tools``
(verrouillé par tests/shared_infra/test_openapi_facade_2026_09_30.py).
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict, List, Optional

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from shared_infra.mcp import openapi as oa
from shared_infra.routes._state import router

logger = logging.getLogger(__name__)

_TOKEN_PREFIX = "ept_"
_CHALLENGE = {"WWW-Authenticate": "Bearer"}
_BODY_MAX = 8 * 1024 * 1024       # 8 Mio : arguments d'outil, pas de transfert de fichier

# Appels simultanés par compte. # PAR WORKER : chaque processus tient son
# propre compteur (N workers → N × 4 au pire) ; le toolhost garde de toute façon
# sa propre file bornée (``MCPQueueSaturated`` → 429).
MAX_CONCURRENT_PER_USER = 4
_in_flight: Dict[int, int] = {}


def _tokens():
    # Import paresseux : le module des jetons (EXT.1) dépend de la base.
    from shared_infra.accounts import tokens
    return tokens


def _policy() -> Dict[str, Any]:
    try:
        return dict(_tokens().policy() or {})
    except Exception:                                            # noqa: BLE001
        logger.warning("[openapi] politique des jetons illisible", exc_info=True)
        return {"tools_enabled": False}


def _bearer(request: Request) -> str:
    auth = (request.headers.get("authorization") or "").strip()
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return ""


async def _authorize(request: Request, family: str) -> Dict[str, Any]:
    """→ jeton résolu ``{id, user_id, username, kind, families}``, ou lève
    404 (façade coupée, famille hors portée) / 401 (jeton)."""
    pol = await asyncio.to_thread(_policy)
    if not pol.get("tools_enabled"):
        raise HTTPException(404, "Not Found")
    token = _bearer(request)
    if not token:
        raise HTTPException(401, "Jeton d'outils requis (Authorization: Bearer ept_…).",
                            headers=_CHALLENGE)
    info: Optional[Dict[str, Any]] = None
    if token.startswith(_TOKEN_PREFIX):
        try:
            info = await asyncio.to_thread(_tokens().resolve, token, kinds=("tools",))
        except Exception:                                        # noqa: BLE001
            logger.warning("[openapi] résolution du jeton en échec", exc_info=True)
            raise HTTPException(503, "Vérification du jeton indisponible.")
    if not info:
        raise HTTPException(401, "Jeton d'outils invalide, expiré ou révoqué.",
                            headers=_CHALLENGE)
    allowed = (set(oa.EXPOSABLE_FAMILIES)
               & set(pol.get("tools_families") or ())
               & set(info.get("families") or ()))
    if family not in allowed:
        raise HTTPException(404, "Famille d'outils inconnue.")
    try:
        await asyncio.to_thread(_tokens().touch_last_used, info["id"])
    except Exception:                                            # noqa: BLE001
        logger.debug("[openapi] last_used_at non mis à jour", exc_info=True)
    return info


async def _tools_or_502(family: str) -> List[Dict[str, Any]]:
    try:
        return await oa.family_tools(family)
    except oa.FamilyUnavailable:
        raise HTTPException(502, "Le service d'outils ne répond pas.")


def _server_url(request: Request, family: str) -> str:
    """Origine PUBLIQUE de l'app (frontal https compris), comme les URL MCP
    publiées dans ``opencode.json``."""
    try:
        from shared_infra.opencode.routes_cli import _app_url
        base = _app_url(request).rstrip("/")
    except Exception:                                            # noqa: BLE001
        # Hôte non reconnu (IPv6 littérale, nom exotique…) : URL relative,
        # valide en 3.1 — l'URL n'est qu'indicative, le client appelle
        # celle qu'on lui a configurée.
        base = ""
    return f"{base}{oa.OPENAPI_PREFIX}/{family}"


@router.get(oa.OPENAPI_PREFIX + "/{family}/openapi.json")
async def api_tools_openapi(request: Request, family: str):
    await _authorize(request, family)
    tools = await _tools_or_502(family)
    spec = oa.build_spec(family, tools, server_url=_server_url(request, family))
    return JSONResponse(spec, headers={"Cache-Control": "no-store"})


@router.post(oa.OPENAPI_PREFIX + "/{family}/{tool}")
async def api_tools_call(request: Request, family: str, tool: str):
    info = await _authorize(request, family)
    tools = await _tools_or_502(family)
    spec_tool = next((t for t in tools if t.get("name") == tool), None)
    if spec_tool is None:
        raise HTTPException(404, "Outil inconnu.")

    # Corps borné : arguments d'outil, jamais un transfert de fichier.
    try:
        declared = int(request.headers.get("content-length") or 0)
    except ValueError:
        declared = 0
    if declared > _BODY_MAX:
        raise HTTPException(413, "Corps trop volumineux.")
    chunks, total = [], 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > _BODY_MAX:
            raise HTTPException(413, "Corps trop volumineux.")
        chunks.append(chunk)
    raw = b"".join(chunks)
    try:
        args = json.loads(raw) if raw.strip() else {}
    except ValueError:
        raise HTTPException(422, "Corps JSON invalide.")
    if not isinstance(args, dict):
        raise HTTPException(422, "Le corps doit être un objet JSON (les arguments de l'outil).")
    errs = oa.validation_errors(spec_tool, args)
    if errs:
        return JSONResponse({"detail": "Arguments non conformes au schéma de l'outil.",
                             "errors": errs}, status_code=422)

    uid = int(info["user_id"])
    if _in_flight.get(uid, 0) >= MAX_CONCURRENT_PER_USER:
        raise HTTPException(429, f"Trop d'appels simultanés (max {MAX_CONCURRENT_PER_USER}).",
                            headers={"Retry-After": "5"})
    _in_flight[uid] = _in_flight.get(uid, 0) + 1
    try:
        body = await oa.call_tool(family, spec_tool, args,
                                  username=str(info["username"]), user_id=uid)
    except oa.ServiceSaturated:
        raise HTTPException(429, "Service d'outils saturé : l'outil n'a pas été exécuté.",
                            headers={"Retry-After": "10"})
    except oa.FamilyUnavailable:
        raise HTTPException(502, "Le service d'outils ne répond pas.")
    finally:
        n = _in_flight.get(uid, 1) - 1
        if n > 0:
            _in_flight[uid] = n
        else:
            _in_flight.pop(uid, None)
    return JSONResponse(body, headers={"Cache-Control": "no-store"})


__all__: list = []
