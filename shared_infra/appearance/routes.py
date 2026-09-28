# SPDX-License-Identifier: MIT
"""shared_infra/appearance/routes.py — routes publiques des skins.

- ``GET /api/skins``                        skins ACTIVÉS + défaut + mascottes
                                             (tout compte connecté)
- ``GET /api/skins/{id}/skin.css``          feuille générée d'un skin
- ``GET /api/skins/{id}/assets/{name}``     image d'un skin importé

Feuille et images : servies si le skin est activé, ou à un administrateur
(aperçu d'un skin encore désactivé). Montées aussi sur le process admin
(``server/app.py`` › ``ALLOW_PATHS``) : la console suit le skin du compte.
Les routes d'administration sont dans ``shared_infra/routes/admin/skins.py``.
"""
from __future__ import annotations

import hashlib

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, Response

from shared_infra.appearance import skins as S
from shared_infra.routes._state import router
from shared_infra.security.deps import require_user_id


def _is_admin(uid: int) -> bool:
    from shared_infra.accounts.users import get_user_by_id
    me = get_user_by_id(uid)
    return bool(me) and me["is_admin"] == 1


def _may_read(request: Request, skin_id: str) -> None:
    uid = require_user_id(request)
    if S.is_enabled(skin_id):
        return
    if not _is_admin(uid):
        raise HTTPException(404, "Skin inconnu")


@router.get("/api/skins")
def api_list_skins(request: Request):
    require_user_id(request)
    return JSONResponse({
        "skins": S.list_skins(),
        "default": S.default_skin(),
        "mascottes": S.mascots_catalogue(),
    }, headers={"Cache-Control": "no-cache"})


@router.get("/api/skins/{skin_id}/skin.css")
def api_skin_css(skin_id: str, request: Request):
    if skin_id and not S.ID_RE.match(skin_id):
        raise HTTPException(404, "Skin inconnu")
    _may_read(request, skin_id)
    css = S.render_css(skin_id)
    if css is None:
        raise HTTPException(404, "Skin inconnu")
    etag = '"' + hashlib.sha1(css.encode("utf-8")).hexdigest()[:20] + '"'
    headers = {"ETag": etag, "Cache-Control": "private, max-age=60",
               "X-Content-Type-Options": "nosniff"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return Response(css, media_type="text/css; charset=utf-8", headers=headers)


@router.get("/api/skins/{skin_id}/assets/{name}")
def api_skin_asset(skin_id: str, name: str, request: Request):
    p = S.asset_path(skin_id, name)
    if p is None:
        raise HTTPException(404, "Image inconnue")
    _may_read(request, skin_id)
    try:
        data = p.read_bytes()
    except OSError:
        raise HTTPException(404, "Image inconnue")
    kind = S._detect_image(data[:16])
    if kind is None or kind != S.asset_type(name):
        raise HTTPException(404, "Image inconnue")
    etag = '"' + hashlib.sha1(data).hexdigest()[:20] + '"'
    headers = {"ETag": etag, "Cache-Control": "private, max-age=300",
               "X-Content-Type-Options": "nosniff",
               "Content-Security-Policy": "default-src 'none'"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return Response(data, media_type=S.IMAGE_MIME[kind], headers=headers)
