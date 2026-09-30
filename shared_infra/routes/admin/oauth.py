# SPDX-License-Identifier: MIT
"""shared_infra/routes/admin/oauth.py — console › Outils MCP : clients OAuth
des clients MCP (EXT.4). Liste (sans secret) et suppression d'un client avec
tout ce qu'il a obtenu. Administrateur seul."""
from __future__ import annotations

import asyncio
import time
from typing import Any, Dict, List

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from shared_infra.routes.admin._state import admin_router
from shared_infra.routes.admin.observability import _require_admin


def _clients() -> List[Dict[str, Any]]:
    from shared_infra.mcp import oauth as O
    items = O.list_clients()
    now = time.time()
    for it in items:
        it["age_days"] = int((now - it["created_at"]) // 86400)
    return items


@admin_router.get("/api/admin/oauth/clients")
async def api_admin_oauth_clients(request: Request):
    _require_admin(request)
    return JSONResponse({"items": await asyncio.to_thread(_clients)},
                        headers={"Cache-Control": "no-store"})


@admin_router.delete("/api/admin/oauth/clients")
async def api_admin_oauth_client_delete(request: Request, client_id: str):
    """``client_id`` en paramètre de requête : un client CIMD est une URL."""
    _require_admin(request)
    from shared_infra.mcp import oauth as O
    if not await asyncio.to_thread(O.delete_client, client_id):
        raise HTTPException(404, "Client introuvable.")
    return {"ok": True}


__all__: list = []
