# SPDX-License-Identifier: MIT
"""
Admin group-management endpoints (CRUD + members).

Auto-extracted from the former monolithic ``backend/routes/admin.py``.
The endpoint bodies are byte-for-byte identical to the originals.
"""
from __future__ import annotations

import asyncio
import logging

from fastapi import HTTPException, Request

from shared_infra.accounts.groups import (
    create_group,
    get_group,
    list_groups,
    update_group,
    delete_group,
    set_user_groups,
)
from shared_infra.accounts.users import (
    get_user_by_id,
)
from shared_infra.security.audit import audit_event
from shared_infra.security.deps import require_user_id
from shared_infra.routes._helpers import _require_admin

# Helpers shared with _legacy. Single source of truth.

# Routers — owned by ``_state``. We import them so endpoint decorators
# below register on the SAME singleton router instances mounted by
# ``app.py`` / ``admin_app.py``.
from shared_infra.routes.admin._state import admin_router

logger = logging.getLogger("uvicorn.error")


@admin_router.get("/api/admin/groups")
def api_list_groups(request: Request):
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    if not me or me["is_admin"] != 1: raise HTTPException(403, "Admin required")
    groups = list_groups()
    # Accès aux serveurs d'inférence réglé sur le groupe (lot B4, 2026-09-16).
    from shared_infra.llm import engine_access as _ea
    try:
        pols = _ea.list_policies("group")
    except Exception:                                            # noqa: BLE001
        pols = {}
    for g in groups:
        pol = pols.get(("group", int(g["id"]))) or {}
        g["llm_engine_keys"] = pol.get("engine_keys")
        g["llm_can_manage_models"] = pol.get("can_manage_models")
    return {"groups": groups}


@admin_router.post("/api/admin/groups")
async def api_create_group(request: Request):
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    if not me or me["is_admin"] != 1: raise HTTPException(403, "Admin required")
    data = await request.json()
    name = (data.get("name") or "").strip()
    description = (data.get("description") or "").strip()
    if not name: raise HTTPException(400, "Nom requis")
    gid = create_group(name, description)
    return {"ok": True, "id": gid}


@admin_router.put("/api/admin/groups/{group_id}")
async def api_update_group(group_id: int, request: Request):
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    if not me or me["is_admin"] != 1: raise HTTPException(403, "Admin required")
    data = await request.json()
    name = (data.get("name") or "").strip()
    description = (data.get("description") or "").strip()
    if not name: raise HTTPException(400, "Nom requis")
    if not update_group(group_id, name, description): raise HTTPException(404, "Groupe introuvable")
    return {"ok": True}


@admin_router.delete("/api/admin/groups/{group_id}")
def api_delete_group(group_id: int, request: Request):
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    if not me or me["is_admin"] != 1: raise HTTPException(403, "Admin required")
    if not delete_group(group_id): raise HTTPException(404, "Groupe introuvable")
    return {"ok": True}


# NOTE — GET /api/admin/groups/{group_id}/members retiré (réalignement
# admin 2026-06) : la modale « Gérer membres » passe par
# /api/admin/users-with-groups (app-admin.js loadAllUsersWithGroups).


@admin_router.put("/api/admin/users/{target_id}/groups")
async def api_set_user_groups(target_id: int, request: Request):
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    if not me or me["is_admin"] != 1: raise HTTPException(403, "Admin required")
    data = await request.json()
    try:
        group_ids = [int(x) for x in data.get("group_ids", [])]
    except (TypeError, ValueError):
        raise HTTPException(400, "group_ids : identifiants entiers attendus")
    if not get_user_by_id(target_id):
        raise HTTPException(404, "Compte introuvable")
    # Un id inconnu est un ÉCHEC, plus un silence : l'appartenance (et donc
    # l'accès hérité aux serveurs d'inférence) doit être celle qu'on croit
    # avoir enregistrée. ``set_user_groups`` invalide lui-même le cache d'accès.
    try:
        set_user_groups(target_id, group_ids)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "group_ids": list(dict.fromkeys(group_ids))}


# ── Accès aux serveurs d'inférence d'un groupe (lot B4, 2026-09-16) ───────────
# Même contrat que ``/api/admin/users/{id}/llm-access`` (cf. users.py) ; un
# groupe n'a pas de valeur « effective » : il ne fait que contribuer à celle
# de ses membres.
@admin_router.get("/api/admin/groups/{group_id}/llm-access")
def api_get_group_llm_access(group_id: int, request: Request):
    _require_admin(request)
    if not get_group(group_id):
        raise HTTPException(404, "Groupe introuvable")
    from shared_infra.llm import engine_access as _ea
    return _ea.get_policy("group", group_id)


@admin_router.put("/api/admin/groups/{group_id}/llm-access")
async def api_set_group_llm_access(group_id: int, request: Request):
    _require_admin(request)
    group = get_group(group_id)
    if not group:
        raise HTTPException(404, "Groupe introuvable")
    from shared_infra.llm import engine_access as _ea
    from shared_infra.routes.admin.users import _read_llm_access_body
    new = await _read_llm_access_body(request, _ea.get_policy("group", group_id))
    saved = await asyncio.to_thread(_ea.set_policy, "group", group_id,
                                    engine_keys=new["engine_keys"],
                                    can_manage_models=new["can_manage_models"])
    audit_event(
        user_id=getattr(request.state, "user_id", None),
        username=getattr(request.state, "username", None),
        action="admin.group.llm_access",
        details={"group_id": group_id, "group_name": group["name"], **saved},
    )
    return {"ok": True, **saved}
