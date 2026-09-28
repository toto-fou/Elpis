# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_system_events_notifications.py — routage per-user du bus système.

Les events ``type="notification"`` ne doivent atteindre QUE les sessions du
destinataire (``data.user_id``) ; les ``type="log"`` restent staff-only ; tout
le reste est broadcast à tous. (Avant : filtrage client-side uniquement → tout
utilisateur authentifié recevait le user_id/kind/compteur non-lus des autres.)
"""
from __future__ import annotations

import asyncio

from shared_infra.observability.events_bus import SystemEvents


def _bus_with(*subs):
    """Bus + une queue par abonné (is_staff, uid) — câblées comme listen()."""
    bus = SystemEvents()
    queues = []
    for is_staff, uid in subs:
        q = asyncio.Queue()
        bus.clients[q] = {"staff": is_staff, "uid": uid}
        queues.append(q)
    return bus, queues


async def test_notification_routed_to_owner_only():
    bus, (qa, qb, qstaff) = _bus_with((False, 1), (False, 2), (True, 3))
    await bus.broadcast({"type": "notification",
                         "data": {"user_id": 1, "kind": "routine_ok", "unread": 3}})
    assert qa.qsize() == 1
    assert qb.qsize() == 0
    assert qstaff.qsize() == 0   # staff n'est pas destinataire → rien non plus


async def test_notification_without_valid_uid_dropped():
    """Payload sans user_id exploitable → DROP (privacy-first), pour personne."""
    bus, (qa, qstaff) = _bus_with((False, 1), (True, 2))
    await bus.broadcast({"type": "notification", "data": {"kind": "routine_ok"}})
    await bus.broadcast({"type": "notification", "data": {"user_id": "abc"}})
    await bus.broadcast({"type": "notification"})
    assert qa.qsize() == 0
    assert qstaff.qsize() == 0


async def test_logs_staff_only_et_reste_broadcast_a_tous():
    # La diffusion LOCALE (``_fanout``) filtre toujours les logs au staff ;
    # ``broadcast`` d'un log passe, lui, par le journal commun (test dédié :
    # test_moteur_evenements_2026_09_25).
    bus, (quser, qstaff) = _bus_with((False, 1), (True, 2))
    await bus._fanout({"type": "log", "message": "m", "level": "INFO"})
    assert quser.qsize() == 0 and qstaff.qsize() == 1
    await bus.broadcast({"type": "model_status", "data": {}})
    assert quser.qsize() == 1 and qstaff.qsize() == 2
