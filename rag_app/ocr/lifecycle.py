# SPDX-License-Identifier: MIT
"""rag_app.ocr.lifecycle — démarrage / arrêt du paquet OCR (passe RAG 2).

Câblé par le lifespan d'``app.py`` (et avant ``/api/restart``) :

- :func:`on_startup` — reprise APRÈS REDÉMARRAGE. Dans un process neuf, rien
  ne tourne : le registre RAM fait foi, le heartbeat n'est pas consulté
  (un heartbeat encore frais bloquait la file ~5 min et renvoyait 409 sur
  « Lancer »). Un document actif de la file est remis en tête (compté comme
  plantage seulement s'il n'a pas été rendu par un arrêt propre) ; un statut
  terminal n'est jamais remis en file ; les documents orphelins hors file
  sont requalifiés ; les préparations interrompues sont relancées ; les
  restes de suppressions interrompues sont purgés ; puis la pompe repart.
- :func:`on_shutdown` — arrêt PROPRE : la pompe remet son document actif en
  tête de file, jobs et préparations sont annulés (threads arrêtés et
  attendus), les indexations en vol sont attendues (bornées).
- :func:`busy` — un travail OCR tourne-t-il ? (refus d'un redémarrage).
"""
from __future__ import annotations

import asyncio
import logging
from typing import Dict, List, Set

from . import jobs as ocr_jobs
from . import queue as ocr_queue
from . import store as ocr_store
from .config import ocr_feature_enabled

logger = logging.getLogger("uvicorn.error")

# Attente maximale de la fin des travaux à l'arrêt.
_SHUTDOWN_WAIT_SEC = 15.0

_INTERRUPTED = ("Traitement interrompu par un redémarrage du service — "
                "relancez le document.")


def busy() -> bool:
    """Job, préparation, indexation ou pompe de file OCR en cours ?"""
    return ocr_jobs.busy_any()


def _recover_docs(queued: Set[str]) -> List[str]:
    """Requalifie les documents laissés « en cours » par l'ancien process.

    Retourne les documents dont la PRÉPARATION est à relancer (dépôt dont
    les aperçus n'ont jamais été finis). Les documents de la file sont
    laissés à la pompe (elle les reprend, préparation comprise).
    """
    to_prepare: List[str] = []
    for child in ocr_store.ocr_root().iterdir():
        doc_id = child.name
        if doc_id in queued or not ocr_store._DOC_ID_RE.match(doc_id):
            continue
        try:
            meta = ocr_store.read_meta(child)
        except (OSError, ValueError):
            continue
        status = meta.get("status")
        if status == "uploaded" or (status == "preparing"
                                    and not ocr_store.pages_ready(child, meta)):
            if status == "preparing":
                try:
                    ocr_store.update_meta(child, lambda m: m.__setitem__(
                        "status", "uploaded"))
                except (OSError, ValueError):
                    continue
            to_prepare.append(doc_id)
            continue
        if status not in ("preparing", "running"):
            continue

        def _mut(m: Dict) -> None:
            if m.get("status") not in ("preparing", "running"):
                return
            m["status"] = "error"
            m["error"] = _INTERRUPTED
            for p in m.get("pages") or []:
                if p.get("status") == "running":
                    p["status"] = "pending"   # à refaire, pas « en erreur »
            ocr_store.recount(m)
        try:
            ocr_store.update_meta(child, _mut)
        except (OSError, ValueError):
            continue
    return to_prepare


async def on_startup() -> None:
    """Reprise après (re)démarrage — best-effort, ne lève jamais."""
    ocr_jobs._SHUTTING_DOWN[0] = False
    if not ocr_feature_enabled():
        ocr_jobs._STARTUP_DONE[0] = True
        return
    try:
        purged = await asyncio.to_thread(ocr_store.purge_trash)
        if purged:
            logger.info("[ocr] %d suppression(s) interrompue(s) purgée(s)", purged)
        # 1) La file d'abord : son document actif est remis en tête (ou soldé
        #    s'il était déjà terminé) AVANT la requalification des documents.
        # Sonde RAM quand même (ceinture) : un document qui tournerait déjà
        # n'est ni compté en plantage ni remis en tête.
        rq = await asyncio.to_thread(ocr_queue.reconcile, ocr_jobs.running_probe(),
                                     startup=True)
        if rq.get("closed_batch"):
            ocr_jobs._notify_batch(rq["closed_batch"])
        queued = {it["doc"] for it in rq.get("items") or []}
        if rq.get("active"):
            queued.add(rq["active"])
        # 2) Les autres documents laissés « en cours ».
        to_prepare = await asyncio.to_thread(_recover_docs, queued)
        for doc_id in to_prepare:
            ocr_jobs.start_prepare(doc_id)
        # 3) Reflet RAM de la file puis relance de la pompe.
        await asyncio.to_thread(ocr_queue.read_queue)
    except Exception:  # noqa: BLE001 — le service démarre quoi qu'il arrive
        logger.warning("[ocr] reprise au démarrage incomplète", exc_info=True)
    finally:
        ocr_jobs._STARTUP_DONE[0] = True
    ocr_jobs.ensure_queue_runner()


async def on_shutdown() -> None:
    """Arrêt propre — best-effort, borné, ne lève jamais."""
    ocr_jobs._SHUTTING_DOWN[0] = True
    tasks = []
    pump = ocr_jobs._QUEUE_TASK[0]
    if pump is not None and not pump.done():
        pump.cancel()
        tasks.append(pump)
    for reg in (ocr_jobs._TASKS, ocr_jobs._PREP_TASKS):
        for doc_id, task in list(reg.items()):
            if not task.done():
                ocr_jobs.cancel_job(doc_id)
                tasks.append(task)
    # Indexations : threads d'embedding non interruptibles — attendues.
    tasks += [t for t in ocr_jobs._INDEX_TASKS.values() if not t.done()]
    if not tasks:
        return
    try:
        _done, pending = await asyncio.wait(tasks, timeout=_SHUTDOWN_WAIT_SEC)
        if pending:
            logger.warning("[ocr] arrêt : %d tâche(s) encore actives après %.0f s",
                           len(pending), _SHUTDOWN_WAIT_SEC)
    except Exception:  # noqa: BLE001
        logger.warning("[ocr] arrêt incomplet", exc_info=True)
