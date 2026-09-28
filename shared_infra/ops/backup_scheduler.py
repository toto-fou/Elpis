# SPDX-License-Identifier: MIT
"""
shared_infra.ops.backup_scheduler — Sauvegarde distante AUTOMATIQUE (2026-09-21).

Réglage admin (Maintenance → Sauvegarde distante → Planification) : « toutes les
N heures/jours ». Le calcul de l'échéance est PUR (``backup_remote.next_run_at``) ;
ce module n'est que la boucle qui l'honore.

Même patron que ``maintenance.py`` :
  • boucle de fond démarrée au lifespan, leader-only (élection ``cron_lock``
    réutilisée : un seul worker envoie) ;
  • résiliente (toute exception est journalisée, la boucle continue) ;
  • état dans ``config.json`` (``backup.remote.last_send``) : un redémarrage ne
    perd pas le rythme, et la config est relue à chaque tour (un changement dans
    l'admin s'applique sans redémarrer).
L'envoi lui-même passe par ``run_send(trigger="schedule")``, qui prend le verrou
« un envoi à la fois » partagé avec le bouton « Envoyer maintenant ».
"""
from __future__ import annotations

import asyncio
import logging
import time

from shared_infra.scheduling.cron_lock import try_acquire_cron_lock

logger = logging.getLogger("uvicorn.error")

TICK_SECONDS = 60
_scheduler_started = False


def due_now(now: float | None = None) -> bool:
    """Vrai si un envoi planifié est dû (config relue, validée)."""
    from shared_infra.ops import backup_remote as br
    cfg = br.get_remote_config()
    ok, _err = br.validate_remote_config(cfg)
    if not ok:
        return False
    nxt = br.next_run_at(cfg, now=now)
    return nxt is not None and (time.time() if now is None else now) >= nxt


async def run_if_due() -> bool:
    """Un tour de boucle : envoie si c'est l'heure. Renvoie True si un envoi a
    été tenté. Extrait pour les tests."""
    if not await asyncio.to_thread(due_now):
        return False
    from shared_infra.ops import backup_remote as br
    res = await br.run_send(trigger="schedule")
    if res.get("ok"):
        logger.info("[backup] envoi planifié réussi : %s", res.get("filename", ""))
    else:
        logger.warning("[backup] envoi planifié en échec : %s", res.get("error", ""))
    return True


async def _backup_loop() -> None:
    while True:
        try:
            await asyncio.sleep(TICK_SECONDS)
            if not try_acquire_cron_lock():
                continue
            await run_if_due()
        except asyncio.CancelledError:
            break
        except Exception as e:                                  # noqa: BLE001
            logger.warning("[backup] erreur de boucle : %s", e)


def start_backup_scheduler() -> None:
    """Démarre la boucle (idempotent par worker), annulée au shutdown."""
    global _scheduler_started
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    if _scheduler_started:
        return
    _scheduler_started = True
    from shared_infra.observability.events_bus import _register_bg_task
    _register_bg_task(loop.create_task(_backup_loop()))
    logger.info("[backup] planificateur de sauvegarde distante démarré.")
