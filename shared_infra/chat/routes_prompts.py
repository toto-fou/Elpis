# SPDX-License-Identifier: MIT
"""
backend.routes.prompts — Saved & shared prompts CRUD.

Endpoints
---------
Personal prompts (owned by the requesting user)
- GET    /api/prompts                       — list mine
- POST   /api/prompts                       — save a new one
- DELETE /api/prompts/{prompt_id}           — delete one of mine

Shared prompts (received from / sent to other users)
- GET    /api/prompts/shared                — list those shared with me
- POST   /api/prompts/share                 — share one of mine to a list of users
- DELETE /api/prompts/shared/{prompt_id}    — drop one shared with me
- DELETE /api/prompts/shared/all            — drop all shared with me
- POST   /api/prompts/shared/delete-batch   — drop several shared with me

Prompt templates (2026-09-21, cf. docs/templates-prompt-design-2026-09-21.md)
- GET    /api/prompt-templates              — list mine
- POST   /api/prompt-templates              — create (409 if the name is taken)
- PUT    /api/prompt-templates/{id}         — update one of mine
- DELETE /api/prompt-templates/{id}         — delete one of mine

All endpoints require an authenticated session (``require_user_id``).
"""
from __future__ import annotations

import asyncio

from fastapi import HTTPException, Request

from shared_infra.security.deps import require_user_id
from shared_infra.accounts.users import (
    get_user_by_id,
    get_users_lite,
)
from shared_infra.chat.prompts_store import (
    clear_all_shared_prompts,
    delete_prompt,
    delete_shared_prompt,
    get_prompt_by_id,
    list_saved_prompts,
    list_shared_prompts,
    save_prompt,
    share_prompt_to_users,
)
from shared_infra.routes._state import router


# ─────────────────────────────────────────────────────────────────────────────
#  PERSONAL PROMPTS
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/api/prompts")
def api_list_prompts(request: Request):
    uid = require_user_id(request)
    return {"items": list_saved_prompts(uid)}


@router.post("/api/prompts")
async def api_save_prompt(request: Request):
    uid = require_user_id(request)
    data = await request.json()
    content = data.get("content", "").strip()
    title = data.get("title", "").strip()
    if not content:
        raise HTTPException(400, "Content required")
    if not title:
        title = (content[:30] + "...") if len(content) > 30 else content
    pid = save_prompt(uid, title, content)
    return {"id": pid, "ok": True}


@router.delete("/api/prompts/{prompt_id}")
def api_delete_prompt_route(prompt_id: int, request: Request):
    uid = require_user_id(request)
    if delete_prompt(uid, prompt_id):
        return {"ok": True}
    raise HTTPException(404, "Prompt not found")


# ─────────────────────────────────────────────────────────────────────────────
#  SHARED PROMPTS
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/api/prompts/shared")
def api_get_shared_prompts_route(request: Request):
    uid = require_user_id(request)
    return {"items": list_shared_prompts(uid)}


@router.post("/api/prompts/share")
async def api_share_prompt_route(request: Request):
    uid = require_user_id(request)
    data = await request.json()
    prompt_id = data.get("prompt_id")
    target_user_ids = data.get("user_ids", [])
    if not prompt_id or not target_user_ids:
        raise HTTPException(400, "Données manquantes")

    # BUG FIX #N (élevé) — Symétrique à #D sur /api/pipelines/share.
    # Même classe de problème : sans validation, un non-admin peut
    # pousser un prompt à n'importe quel ``user_id`` deviné, en
    # bypassant le filtrage par groupe de /api/users/lite.
    #   1) typage strict : list[int] uniquement.
    #   2) existence : refuser les user_id qui ne correspondent à
    #      personne en base.
    #   3) périmètre groupes : un non-admin ne peut cibler que les
    #      users visibles dans son /api/users/lite.
    if not isinstance(target_user_ids, list):
        raise HTTPException(400, "user_ids doit être une liste")
    try:
        target_ids_int = [int(x) for x in target_user_ids]
    except (TypeError, ValueError):
        raise HTTPException(400, "user_ids doit contenir uniquement des entiers")
    if not target_ids_int:
        raise HTTPException(400, "user_ids vide")
    if len(target_ids_int) > 500:
        raise HTTPException(400, "Trop de destinataires (max 500)")

    me = get_user_by_id(uid)
    # Audit 2026-09-22, M1 : admin PLEIN seulement ; le modérateur (2) reste
    # limité à son périmètre de groupes, comme /api/users/lite.
    is_admin = bool(me and me["is_admin"] == 1)
    if not is_admin:
        visible = get_users_lite(uid, respect_groups=True)
        allowed_ids = {int(u["id"]) for u in visible}
        bad = [t for t in target_ids_int if t not in allowed_ids]
        if bad:
            raise HTTPException(
                403,
                f"Destinataire(s) hors de votre périmètre : {bad[:5]}",
            )
    else:
        all_users = get_users_lite(uid, respect_groups=False)
        existing_ids = {int(u["id"]) for u in all_users} | {uid}
        bad = [t for t in target_ids_int if t not in existing_ids]
        if bad:
            raise HTTPException(404, f"Destinataire(s) introuvable(s) : {bad[:5]}")

    prompt = get_prompt_by_id(uid, int(prompt_id))
    if not prompt:
        raise HTTPException(404, "Prompt introuvable")
    share_prompt_to_users(uid, target_ids_int, prompt["title"], prompt["content"])
    return {"ok": True, "shared_count": len(target_ids_int)}


@router.delete("/api/prompts/shared/all")
def api_clear_shared_prompts_route(request: Request):
    uid = require_user_id(request)
    clear_all_shared_prompts(uid)
    return {"ok": True}


@router.delete("/api/prompts/shared/{prompt_id}")
def api_delete_shared_prompt_route(prompt_id: int, request: Request):
    uid = require_user_id(request)
    if delete_shared_prompt(uid, prompt_id):
        return {"ok": True}
    raise HTTPException(404, "Prompt partagé introuvable")


@router.post("/api/prompts/shared/delete-batch")
async def api_delete_shared_prompts_batch(request: Request):
    """Delete multiple shared prompts by IDs."""
    uid = require_user_id(request)
    data = await request.json()
    ids = data.get("ids", [])
    count = 0
    for pid in ids:
        if delete_shared_prompt(uid, int(pid)):
            count += 1
    return {"ok": True, "deleted": count}


# ─────────────────────────────────────────────────────────────────────────────
#  PROMPT TEMPLATES (2026-09-21) — appelés par « /template <nom> » dans le chat
# ─────────────────────────────────────────────────────────────────────────────
from shared_infra.chat import prompt_templates_store as _tpl


async def _tpl_body(request: Request) -> dict:
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(400, "Corps JSON attendu.")
    if not isinstance(data, dict):
        raise HTTPException(400, "Corps JSON attendu.")
    return data


@router.get("/api/prompt-templates")
async def api_list_prompt_templates(request: Request):
    uid = require_user_id(request)
    return {"items": await asyncio.to_thread(_tpl.list_templates, uid)}


@router.post("/api/prompt-templates")
async def api_create_prompt_template(request: Request):
    uid = require_user_id(request)
    data = await _tpl_body(request)
    try:
        item = await asyncio.to_thread(_tpl.create_template, uid, data)
    except _tpl.TemplateError as e:
        raise HTTPException(e.status, str(e))
    return {"ok": True, "item": item}


@router.put("/api/prompt-templates/{template_id}")
async def api_update_prompt_template(template_id: int, request: Request):
    uid = require_user_id(request)
    data = await _tpl_body(request)
    try:
        item = await asyncio.to_thread(_tpl.update_template, uid, template_id, data)
    except _tpl.TemplateError as e:
        raise HTTPException(e.status, str(e))
    if item is None:
        raise HTTPException(404, "Template introuvable.")
    return {"ok": True, "item": item}


@router.delete("/api/prompt-templates/{template_id}")
async def api_delete_prompt_template(template_id: int, request: Request):
    uid = require_user_id(request)
    if not await asyncio.to_thread(_tpl.delete_template, uid, template_id):
        raise HTTPException(404, "Template introuvable.")
    return {"ok": True}
