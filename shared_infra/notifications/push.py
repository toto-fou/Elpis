# SPDX-License-Identifier: MIT
"""shared_infra.notifications.push — point d'entrée unique pour ÉMETTRE une
notification : persiste en DB (centre de notifications) ET pousse l'event SSE
*enrichi* (badge + aperçu pour toast / notification OS), en best-effort.

Avant, chaque producteur (routines, scénarios, rapport quotidien) refaisait à la
main le couple ``create_notification`` + ``publish_event`` avec un payload réduit
à ``{user_id, kind, unread}``. Le frontend ne pouvait donc ni afficher un toast
d'aperçu ni une notification OS sans un aller-retour HTTP. Ce helper centralise
l'émission et garantit un payload live uniforme :

    {"type": "notification",
     "data": {user_id, id, kind, title, body, ref_type, ref_id, unread}}

Best-effort de bout en bout : une notif est du *sucre*, elle ne doit jamais
faire échouer l'action qui l'a déclenchée — toute exception est avalée (debug).
Imports tardifs (``shared_infra.db`` / ``broadcast``) pour éviter les cycles au
chargement ET pour rester compatible avec les tests qui patchent la façade
``shared_infra.db.create_notification``.
"""
from __future__ import annotations

import logging
from typing import Optional

logger = logging.getLogger(__name__)

# Aperçu transporté dans l'event live : on borne le corps pour garder la ligne
# SSE légère (le corps complet reste en DB, relu à l'ouverture du panneau).
_LIVE_BODY_MAX = 280


def push_notification(
    owner_user_id: int,
    kind: str,
    title: str,
    body: str = "",
    ref_type: str = "",
    ref_id: int | str | None = None,
    *,
    live: bool = True,
) -> Optional[int]:
    """Crée la notification puis pousse l'event SSE enrichi.

    Retourne l'``id`` de la notif créée, ou ``None`` si la création a échoué.
    """
    try:
        # Façade ``shared_infra.db`` (et non le sous-module) : c'est ce que les
        # tests patchent, et c'est l'API publique des producteurs existants.
        from shared_infra.notifications.store import create_notification
        nid = create_notification(
            owner_user_id, kind, title, body=body,
            ref_type=ref_type, ref_id=ref_id,
        )
    except Exception:  # noqa: BLE001 — best-effort
        logger.debug("[notif] create_notification a échoué (uid=%s kind=%s)",
                     owner_user_id, kind, exc_info=True)
        return None

    if live:
        _publish_live(owner_user_id, nid, kind, title, body, ref_type, ref_id)
    return nid


def _publish_live(owner_user_id, nid, kind, title, body, ref_type, ref_id) -> None:
    """Pousse l'event live enrichi (badge + aperçu). Best-effort."""
    try:
        from shared_infra.notifications.store import count_unread
        from shared_infra.observability.metrics.broadcast import publish_event
        publish_event({
            "type": "notification",
            "data": {
                "user_id": int(owner_user_id),
                "id": nid,
                "kind": kind,
                "title": (title or "")[:300],
                "body": (body or "")[:_LIVE_BODY_MAX],
                "ref_type": ref_type or "",
                "ref_id": ref_id,
                "unread": count_unread(owner_user_id),
            },
        })
    except Exception:  # noqa: BLE001 — best-effort
        logger.debug("[notif] push live a échoué (uid=%s kind=%s)",
                     owner_user_id, kind, exc_info=True)
