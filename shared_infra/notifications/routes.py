# SPDX-License-Identifier: MIT
"""
shared_infra.notifications.routes — API du centre de notifications.

Tous les endpoints sont owner-gated via ``require_user_id`` + filtre
``owner_user_id`` côté DB : un user ne voit/altère jamais les notifications d'un
autre (mark/delete sur l'id d'autrui → no-op silencieux).

- GET    /api/notifications               — liste mes notifications + nb non-lus
                                            (pagination : ?before=<id>&limit=<n>)
- GET    /api/notifications/unread-count  — compteur léger (badge)
- PATCH  /api/notifications/{id}/read     — marquer une notif comme lue
- PATCH  /api/notifications/{id}/unread   — repasser une notif en non-lue
- POST   /api/notifications/read-all      — tout marquer lu
- DELETE /api/notifications/{id}          — supprimer une notif
- POST   /api/notifications/clear         — tout supprimer
"""
from __future__ import annotations

from typing import Optional

from fastapi import Request

from shared_infra.notifications.store import (
    clear_all,
    count_unread,
    delete_notification,
    list_notifications,
    mark_all_read,
    mark_read,
    mark_unread,
)
from shared_infra.routes._state import router
from shared_infra.security.deps import require_user_id


@router.get("/api/notifications")
def api_list_notifications(request: Request, before: Optional[int] = None, limit: int = 50):
    uid = require_user_id(request)
    # Borne le lot pour éviter une requête abusive ; 50 par défaut côté UI.
    limit = max(1, min(int(limit), 100))
    items = list_notifications(uid, limit=limit, before_id=before)
    return {"items": items, "unread": count_unread(uid)}


@router.get("/api/notifications/unread-count")
def api_notifications_unread_count(request: Request):
    uid = require_user_id(request)
    return {"count": count_unread(uid)}


@router.patch("/api/notifications/{notif_id}/read")
def api_mark_notification_read(notif_id: int, request: Request):
    uid = require_user_id(request)
    mark_read(uid, notif_id)
    return {"ok": True, "unread": count_unread(uid)}


@router.patch("/api/notifications/{notif_id}/unread")
def api_mark_notification_unread(notif_id: int, request: Request):
    uid = require_user_id(request)
    mark_unread(uid, notif_id)
    return {"ok": True, "unread": count_unread(uid)}


@router.post("/api/notifications/read-all")
def api_mark_all_notifications_read(request: Request):
    uid = require_user_id(request)
    n = mark_all_read(uid)
    return {"ok": True, "marked": n, "unread": 0}


@router.delete("/api/notifications/{notif_id}")
def api_delete_notification(notif_id: int, request: Request):
    uid = require_user_id(request)
    delete_notification(uid, notif_id)
    return {"ok": True, "unread": count_unread(uid)}


@router.post("/api/notifications/clear")
def api_clear_notifications(request: Request):
    uid = require_user_id(request)
    n = clear_all(uid)
    return {"ok": True, "cleared": n, "unread": 0}
