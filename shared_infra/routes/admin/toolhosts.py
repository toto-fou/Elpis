# SPDX-License-Identifier: MIT
"""shared_infra/routes/admin/toolhosts.py — console d'administration des
HÔTES D'OUTILS (2026-09-12, P5).

* ``GET  /api/admin/toolhosts`` — hôtes déclarés (``mcp.json › sandboxHosts``),
  stratégie de placement, santé de chaque hôte (``/health`` sondé), nombre de
  comptes affectés, liste des affectations ;
* ``POST /api/admin/toolhosts/placements/{user_id}`` ``{host_id}`` — affecter ;
* ``POST /api/admin/toolhosts/placements/{user_id}/migrate`` ``{host_id}`` —
  déplacer le ``/work`` du compte puis réaffecter ;
* ``DELETE /api/admin/toolhosts/placements/{user_id}`` — retirer l'affectation
  (le compte reprendra l'hôte le moins chargé à sa prochaine utilisation).
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict

from fastapi import HTTPException, Request

from shared_infra.routes._legacy import _require_admin
from shared_infra.routes.admin._state import admin_router
from shared_infra.security.audit import audit_event

logger = logging.getLogger("uvicorn.error")


def _hosts() -> Dict[str, Dict[str, Any]]:
    from shared_infra.mcp import manifest as _mf
    m = _mf.load()
    return {k: dict(v) for k, v in (m.sandbox_hosts or {}).items() if isinstance(v, dict)}, dict(m.placement or {})


async def _probe(host_id: str, spec: Dict[str, Any]) -> Dict[str, Any]:
    url = str(spec.get("url") or "").rstrip("/")
    out: Dict[str, Any] = {"id": host_id, "url": url, "has_token": bool(spec.get("token")),
                           "relay": spec.get("relay"), "reachable": None, "health": None}
    if not url:
        return out
    try:
        import httpx
        async with httpx.AsyncClient(timeout=2.5) as c:
            r = await c.get(url + "/health")
        out["reachable"] = (r.status_code == 200)
        if r.status_code == 200:
            h = r.json()
            out["health"] = {k: h.get(k) for k in ("families", "tools", "uptime_s", "auth", "service")}
    except Exception as e:                                        # noqa: BLE001
        out["reachable"] = False
        out["error"] = str(e)[:160]
    return out


@admin_router.get("/api/admin/toolhosts")
async def admin_toolhosts(request: Request):
    _require_admin(request)
    from shared_infra.sandbox import placement as P
    hosts, placement = _hosts()
    probes = await asyncio.gather(*(_probe(h, s) for h, s in hosts.items()))
    counts = P.counts_by_host()
    rows = []
    for p in probes:
        p["accounts"] = counts.get(p["id"], 0)
        rows.append(p)
    from shared_infra.accounts.users import get_username_by_id
    placements = P.list_placements()
    for pl in placements:
        try:
            pl["username"] = get_username_by_id(int(pl["user_id"])) or ""
        except Exception:
            pl["username"] = ""
    return {"ok": True, "hosts": rows, "placement": placement, "placements": placements}


def _check_host(host_id: str) -> None:
    hosts, _ = _hosts()
    if host_id not in hosts:
        raise HTTPException(404, f"hôte inconnu : {host_id}")


@admin_router.post("/api/admin/toolhosts/placements/{user_id}")
async def admin_toolhost_assign(request: Request, user_id: int):
    _require_admin(request)
    body = await request.json()
    host_id = str((body or {}).get("host_id") or "").strip()
    _check_host(host_id)
    from shared_infra.sandbox import placement as P
    await asyncio.to_thread(P.assign, int(user_id), host_id)
    audit_event(user_id=getattr(request.state, "user_id", None),
                username=getattr(request.state, "username", None),
                action="admin.toolhosts.assign", details={"user_id": int(user_id), "host_id": host_id})
    return {"ok": True, "user_id": int(user_id), "host_id": host_id}


@admin_router.post("/api/admin/toolhosts/placements/{user_id}/migrate")
async def admin_toolhost_migrate(request: Request, user_id: int):
    _require_admin(request)
    body = await request.json()
    host_id = str((body or {}).get("host_id") or "").strip()
    _check_host(host_id)
    from shared_infra.sandbox import placement as P
    try:
        res = await asyncio.to_thread(P.migrate_user, int(user_id), host_id)
    except Exception as e:                                        # noqa: BLE001
        logger.warning("[toolhosts] migration de %s vers %s : %r", user_id, host_id, e)
        raise HTTPException(502, f"migration impossible : {e}")
    audit_event(user_id=getattr(request.state, "user_id", None),
                username=getattr(request.state, "username", None),
                action="admin.toolhosts.migrate",
                details={"user_id": int(user_id), **{k: v for k, v in res.items() if k != "ok"}})
    return res


@admin_router.delete("/api/admin/toolhosts/placements/{user_id}")
async def admin_toolhost_unassign(request: Request, user_id: int):
    _require_admin(request)
    from shared_infra.sandbox import placement as P
    await asyncio.to_thread(P.unassign, int(user_id))
    audit_event(user_id=getattr(request.state, "user_id", None),
                username=getattr(request.state, "username", None),
                action="admin.toolhosts.unassign", details={"user_id": int(user_id)})
    return {"ok": True}
