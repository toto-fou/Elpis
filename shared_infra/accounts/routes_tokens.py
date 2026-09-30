# SPDX-License-Identifier: MIT
"""shared_infra/accounts/routes_tokens.py — Paramètres › Connexions (EXT.1).

Jetons personnels du compte connecté (session web) :

* ``GET /api/tokens`` : jetons (sans secret), politique, familles autorisées,
  URL du relais MCP et de la façade OpenAPI ;
* ``POST /api/tokens`` : ``{kind, name, families, days}`` → le jeton, montré
  UNE fois ;
* ``POST /api/tokens/{id}/regenerate`` : nouveau jeton, l'ancien est révoqué ;
* ``DELETE /api/tokens/{id}`` ;
* ``GET /api/tokens/schema/{famille}`` : ``tools/list`` de la famille (jeton de
  service de l'app), pour copier ou télécharger le schéma JSON.

Un identifiant d'un autre compte répond 404, comme un inconnu (pas d'oracle).
"""
from __future__ import annotations

import asyncio
from typing import Any, Dict, List

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from shared_infra.accounts import tokens as T
from shared_infra.routes._state import router
from shared_infra.security.deps import require_user_id

_KINDS_CREATABLE = ("tools", "opencode")


def _families_info(allowed: List[str]) -> List[Dict[str, str]]:
    labels: Dict[str, str] = {}
    try:
        from llm_core._mcp_categories import get_categories
        labels = {c["name"]: c.get("label") or c["name"] for c in get_categories(include_hidden=True)}
    except Exception:                                             # noqa: BLE001
        pass
    from shared_infra.mcp.families import FAMILY_CATEGORY
    return [{"name": f, "label": labels.get(FAMILY_CATEGORY.get(f, f)) or f} for f in allowed]


def _base(request: Request) -> str:
    from shared_infra.opencode.routes_cli import _base_url
    return _base_url(request)


def _opencode_on() -> bool:
    from shared_infra.config import feature_enabled
    return bool(feature_enabled("opencode"))


@router.get("/api/tokens")
async def api_tokens_list(request: Request):
    uid = int(require_user_id(request))
    items = await asyncio.to_thread(T.list_for, uid)
    pol = T.policy()
    base = _base(request)
    return JSONResponse({
        "tokens": items,
        "policy": {**pol, "families": _families_info(pol["tools_families"])},
        "opencode_enabled": _opencode_on(),
        "bridge_url": f"{base}/api/mcp-bridge",
        "tools_url": f"{base}/api/tools",
    })


async def _json(request: Request) -> Dict[str, Any]:
    try:
        d = await request.json()
    except Exception:
        return {}
    return d if isinstance(d, dict) else {}


@router.post("/api/tokens")
async def api_tokens_create(request: Request):
    uid = int(require_user_id(request))
    body = await _json(request)
    kind = str(body.get("kind") or "tools")
    if kind not in _KINDS_CREATABLE:
        raise HTTPException(422, "Type de jeton inconnu.")
    fams = body.get("families") if isinstance(body.get("families"), list) else []
    try:
        tok, row = await asyncio.to_thread(
            T.create, uid, kind, str(body.get("name") or ""), fams,
            body.get("days") if body.get("days") not in ("", None) else None)
    except T.TokenError as e:
        raise HTTPException(422, str(e))
    return JSONResponse({"token": tok, "item": row})


@router.post("/api/tokens/{token_id}/regenerate")
async def api_tokens_regenerate(request: Request, token_id: int):
    uid = int(require_user_id(request))
    try:
        out = await asyncio.to_thread(T.regenerate, uid, int(token_id))
    except T.TokenError as e:
        raise HTTPException(422, str(e))
    if not out:
        raise HTTPException(404, "Jeton introuvable.")
    tok, row = out
    return JSONResponse({"token": tok, "item": row})


@router.delete("/api/tokens/{token_id}")
async def api_tokens_delete(request: Request, token_id: int):
    uid = int(require_user_id(request))
    if not await asyncio.to_thread(T.revoke, uid, int(token_id)):
        raise HTTPException(404, "Jeton introuvable.")
    return JSONResponse({"ok": True})


_SCHEMA_TTL_S = 60.0
_schema_cache: Dict[str, Any] = {}


def _tool_dict(t: Any) -> Dict[str, Any]:
    if hasattr(t, "model_dump"):
        d = t.model_dump(by_alias=True, exclude_none=True, mode="json")
    elif isinstance(t, dict):
        d = dict(t)
    else:
        d = {"name": getattr(t, "name", "")}
    keep = ("name", "title", "description", "inputSchema", "outputSchema", "annotations")
    return {k: d[k] for k in keep if k in d}


async def list_family_tools(family: str) -> List[Dict[str, Any]]:
    """``tools/list`` de l'endpoint ``/mcp/<famille>`` du service partagé,
    avec le jeton de SERVICE de l'app — même amont que le relais : la portée
    par famille est appliquée par le service lui-même. Cache 60 s."""
    import time as _time
    ent = _schema_cache.get(family)
    if ent and ent[0] > _time.monotonic():
        return ent[1]
    from fastmcp import Client
    from fastmcp.client.transports import StreamableHttpTransport

    from shared_infra.mcp.local_registry import service_upstream
    base, svc = service_upstream()
    if not base or not svc:
        raise HTTPException(503, "Service d'outils partagé non configuré.")
    transport = StreamableHttpTransport(f"{base.rstrip('/')}/{family}",
                                        headers={"Authorization": f"Bearer {svc}"})

    async def _list():
        async with Client(transport) as c:
            return await c.list_tools()
    try:
        tools = await asyncio.wait_for(_list(), timeout=15.0)
    except Exception:
        raise HTTPException(502, "Service d'outils injoignable.")
    items = [t for t in (_tool_dict(x) for x in tools or []) if t.get("name")]
    _schema_cache[family] = (_time.monotonic() + _SCHEMA_TTL_S, items)
    return items


@router.get("/api/tokens/schema/{family}")
async def api_tokens_schema(request: Request, family: str):
    """``tools/list`` d'une famille autorisée par la politique (même source
    que la façade OpenAPI)."""
    require_user_id(request)
    if family not in T.policy()["tools_families"]:
        raise HTTPException(404, "Famille d'outils inconnue.")
    return JSONResponse({"family": family, "tools": await list_family_tools(family)})


__all__: list = []
