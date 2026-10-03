# SPDX-License-Identifier: MIT
"""Endpoints utilisateur de la génération d'images.

    GET    /api/image/status   ce que le compte peut se voir proposer
    GET    /api/images         sa galerie (paginée, filtrable par conversation)
    GET    /api/images/{id}    le fichier (``?thumb=1`` : la vignette)
    DELETE /api/images/{id}    l'effacer

La génération elle-même passe par le flux du chat (``chat-saved-stream3`` avec
``image_gen`` dans le corps : ``chatbot_app/turn/image.py``) ou par l'outil du
modèle. Lire et effacer SES images ne demande que d'en être le propriétaire :
une image d'un autre compte répond 404, comme une image inexistante ; un
compte retiré des groupes autorisés garde ses images passées.
"""
from __future__ import annotations

import asyncio
import json
import math
import re
from typing import Any, Dict, Optional

from fastapi import HTTPException, Request
from fastapi.responses import FileResponse

from shared_infra.image import access, store
from shared_infra.image.config import get_image_config, public_status
from shared_infra.routes._state import router
from shared_infra.security.deps import require_user_id

_EXT = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}


def download_name(prompt: str, seed: Any, mime: str, image_id: str = "") -> str:
    """Nom de fichier proposé au téléchargement, le même que l'interface
    (``imageFileName`` de ``chat/_image.js``) : ``<description>-<graine>.<ext>``,
    les 8 premiers caractères de l'id à défaut de graine."""
    slug = re.sub(r"[\W_]+", "-", prompt or "").strip("-")[:40].rstrip("-") or "image"
    tag = str(seed) if isinstance(seed, int) else (image_id or "")[:8]
    return f"{slug}-{tag}.{_EXT.get(mime, 'png')}" if tag else f"{slug}.{_EXT.get(mime, 'png')}"


def status_for(user_id: int) -> Dict[str, Any]:
    """Synchrone (lit groupes, réglages et compteur en base)."""
    cfg = get_image_config()
    if not access.ready_for(user_id, cfg):
        return {"ready": False, "available": False}
    settings = access.read_settings(user_id)
    out: Dict[str, Any] = {"ready": True, "available": access.enabled_in(settings),
                           "tool_enabled": access.tool_enabled_in(settings)}
    out.update(public_status(cfg))
    out["prefs"] = access.clean_prefs((settings or {}).get("image_prefs"), cfg)
    out["stored"] = store.count_for_user(user_id)
    return out


@router.get("/api/image/status")
async def api_image_status(request: Request) -> Dict[str, Any]:
    uid = require_user_id(request)
    return await asyncio.to_thread(status_for, uid)


@router.get("/api/images")
async def api_images_list(request: Request, before: Optional[float] = None,
                          limit: int = 50, chat_id: Optional[str] = None) -> Dict[str, Any]:
    uid = require_user_id(request)
    if chat_id is not None and not (0 < len(chat_id) <= 191):
        raise HTTPException(400, "Conversation invalide.")
    if before is not None and not math.isfinite(before):
        raise HTTPException(400, "Curseur invalide.")
    items, suite, total = await asyncio.to_thread(
        store.list_images, uid, before=before, limit=limit, chat_id=chat_id)
    return {"items": items, "next_before": suite, "total": total,
            "keep": get_image_config()["keep_per_user"]}


@router.get("/api/images/{image_id}")
async def api_image_file(image_id: str, request: Request, thumb: int = 0):
    uid = require_user_id(request)
    row = await asyncio.to_thread(store.get_image, uid, image_id)
    if not row:
        raise HTTPException(404, "Image introuvable ou expirée.")
    # Contenu immuable (id jamais réutilisé), mais privé : pas de cache partagé
    # entre comptes derrière un proxy.
    headers = {"Cache-Control": "private, max-age=31536000, immutable",
               "X-Content-Type-Options": "nosniff"}
    if thumb and row.get("thumb_path"):
        return FileResponse(row["thumb_path"], media_type="image/webp", headers=headers)
    try:
        seed = json.loads(row.get("params_json") or "{}").get("seed")
    except ValueError:
        seed = None
    return FileResponse(row["path"], media_type=row["mime"],
                        filename=download_name(row.get("prompt") or "", seed, row["mime"], image_id),
                        content_disposition_type="inline", headers=headers)


@router.delete("/api/images/{image_id}")
async def api_image_delete(image_id: str, request: Request) -> Dict[str, Any]:
    uid = require_user_id(request)
    if not await asyncio.to_thread(store.delete_image, uid, image_id):
        raise HTTPException(404, "Image introuvable ou expirée.")
    return {"ok": True}
