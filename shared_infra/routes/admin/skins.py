# SPDX-License-Identifier: MIT
"""shared_infra/routes/admin/skins.py — console › Système › Apparence.

Endpoints (``admin_router``, administrateur seulement) :

  GET    /api/admin/skins               tous les skins, état et source
  PUT    /api/admin/skins               état : {"enabled": {id: bool}, "default": id}
  GET    /api/admin/skins/{id}          définition d'un skin importé (formulaire)
  POST   /api/admin/skins               créer / modifier (JSON du formulaire ;
                                        ``update: true`` pour modifier)
  POST   /api/admin/skins/import        zip multipart (champ ``file``, ``overwrite``)
  GET    /api/admin/skins/{id}/export   zip (un intégré s'exporte comme modèle)
  DELETE /api/admin/skins/{id}          supprimer un skin importé

Chaque action s'applique tout de suite (pas de barre d'enregistrement) :
elles écrivent un dossier ou ``config.json`` › ``skins`` par leur propre
chemin, sous le verrou de ``PATCH /api/admin/config``. La logique et la
validation vivent dans ``shared_infra/appearance/skins.py``.
"""
from __future__ import annotations

import asyncio

from fastapi import File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, Response

from shared_infra.appearance import skins as S
from shared_infra.routes._helpers import _require_admin
from shared_infra.routes.admin._state import admin_router


def _payload() -> dict:
    return {"skins": S.list_skins(include_disabled=True), "default": S.default_skin()}


def _err(e: S.SkinError) -> HTTPException:
    if isinstance(e, S.SkinNotFoundError):
        return HTTPException(404, str(e))
    if isinstance(e, S.SkinExistsError):
        return HTTPException(409, str(e))
    return HTTPException(400, str(e))


@admin_router.get("/api/admin/skins")
def api_admin_skins(request: Request):
    _require_admin(request)
    return JSONResponse(_payload(), headers={"Cache-Control": "no-cache"})


@admin_router.put("/api/admin/skins")
async def api_admin_skins_state(request: Request):
    _require_admin(request)
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(400, "Objet JSON attendu.")
    try:
        await asyncio.to_thread(S.set_state, body.get("enabled"), body.get("default"))
    except S.SkinError as e:
        raise _err(e)
    return _payload()


@admin_router.post("/api/admin/skins/import")
async def api_admin_skins_import(request: Request, file: UploadFile = File(...),
                                 overwrite: bool = Form(False)):
    _require_admin(request)
    data = await file.read(S.MAX_ZIP_BYTES + 1)
    try:
        skin = await asyncio.to_thread(S.import_zip, data, bool(overwrite))
    except S.SkinError as e:
        raise _err(e)
    return {"ok": True, "skin": skin, **_payload()}


@admin_router.post("/api/admin/skins")
async def api_admin_skins_save(request: Request):
    _require_admin(request)
    body = await request.json()
    try:
        skin = await asyncio.to_thread(S.save_from_editor, body)
    except S.SkinError as e:
        raise _err(e)
    return {"ok": True, "skin": skin, **_payload()}


@admin_router.get("/api/admin/skins/{skin_id}/export")
def api_admin_skins_export(skin_id: str, request: Request):
    _require_admin(request)
    try:
        name, data = S.export_zip(skin_id)
    except S.SkinError as e:
        raise _err(e)
    return Response(data, media_type="application/zip", headers={
        "Content-Disposition": f'attachment; filename="{name}"',
        "Cache-Control": "no-store"})


@admin_router.get("/api/admin/skins/{skin_id}")
def api_admin_skin_detail(skin_id: str, request: Request):
    _require_admin(request)
    try:
        return S.skin_detail(skin_id)
    except S.SkinError as e:
        raise _err(e)


@admin_router.delete("/api/admin/skins/{skin_id}")
async def api_admin_skins_delete(skin_id: str, request: Request):
    _require_admin(request)
    try:
        await asyncio.to_thread(S.delete, skin_id)
    except S.SkinError as e:
        raise _err(e)
    return {"ok": True, **_payload()}
