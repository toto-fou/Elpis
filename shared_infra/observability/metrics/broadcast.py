# SPDX-License-Identifier: MIT
"""
backend.metric_broadcast — Cross-process broadcast bus for app events.

Despite the historical name, this module is a generic SSE event bridge
between processes. It started life as a metric refresh notifier and
still exposes ``publish(event_type, affected_ids)`` for that specific
use case, but it now also serves arbitrary control events
(restart, app_restarting, …) via ``publish_event(payload)``.

Wire format
-----------
Each line of the shared JSONL file is a complete SSE payload — the
tailer broadcasts it AS-IS onto its local ``system_events`` bus, and
front-end clients receive it through their existing /api/system-events
EventSource. The only requirement is that each payload carries a
``"type"`` field the front-end recognises ("log", "restart",
"metric_dirty", …).

Why file-based and not HTTP/Redis
---------------------------------
  • No new daemon (Redis), no new auth surface (HTTP loopback).
  • Multi-worker safe via fcntl write-lock.
  • Crash-tolerant: a worker that dies leaves the file readable; the
    survivor keeps tailing.
  • Latency ~100 ms (tailer poll), good enough for everything outside
    sub-second trading.

Failure modes
-------------
  • /tmp full / unwritable → publish swallows the error. The local
    process can still broadcast on its own bus directly if it wants.
  • Rotation (cap 5 MB) par RENOMMAGE, via ``file_bus.FileBus`` : les
    tailers finissent l'ancien fichier avant de basculer — plus aucune perte
    à la frontière (audit moteur d'événements 2026-09-25, B3), et une ligne
    en cours d'écriture n'est plus lue à moitié (B4).
  • Stale tailer (worker restart) seeks to end-of-file at boot, never
    replays old events.

Événements de CONTRÔLE (appliqués par chaque worker, jamais rediffusés) :
  • ``session_revoked``      → ``apply_session_revocation`` ;
  • ``model_cache_refresh``  → ``_refresh_model_cache`` : après un
    chargement/déchargement, chaque worker repousse l'état des modèles à SES
    clients tout de suite, au lieu d'attendre son poller (≤ 10 s).

``metric_dirty`` (retiré le 2026-09-25) : diffusé à tous les utilisateurs à
chaque métrique, jamais consommé par le front — pur bruit qui accélérait la
rotation de ce fichier.
"""
from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path
from typing import Any, Dict, Optional

from shared_infra.observability.file_bus import FileBus
from shared_infra.runtime.runtime_dir import runtime_path

logger = logging.getLogger("uvicorn.error")

# (2026-09-20) Sous la racine runtime quand elle est posée (PrivateTmp scindait
# ce canal en silence) ; chemin historique sinon.
EVENTS_FILE = runtime_path("metric_events.jsonl", "ELPIS_METRIC_EVENTS_FILE",
                           "/tmp/elpis_metric_events.jsonl")
_MAX_FILE_SIZE_BYTES = 5_000_000
_TAIL_POLL_SEC = 0.1


_bus: Optional[FileBus] = None


def _get_bus() -> FileBus:
    """Bus du fichier courant (``EVENTS_FILE`` peut être repointé par les tests)."""
    global _bus
    if _bus is None or _bus.path != Path(EVENTS_FILE):
        _bus = FileBus(Path(EVENTS_FILE), _MAX_FILE_SIZE_BYTES)
    return _bus


# Types traités par les tailers eux-mêmes, jamais poussés aux navigateurs.
CONTROL_TYPES = frozenset({"session_revoked", "model_cache_refresh"})


def publish_event(payload: Dict[str, Any]) -> None:
    """
    Publish an arbitrary SSE-shaped event to every connected process.

    The payload is appended to the shared JSONL file (``file_bus``). Every
    process running the FastAPI app has a background tailer that reads new
    lines and re-broadcasts them on its local ``system_events`` bus, where the
    front-end's EventSource pipes them to the chat / admin UIs — except the
    control types (``CONTROL_TYPES``), applied locally by each tailer.

    The payload MUST contain a ``"type"`` field. Blocking I/O (flock + write):
    from async code, prefer ``asyncio.to_thread(publish_event, …)`` on hot paths.
    Never raises.
    """
    if not payload or "type" not in payload:
        logger.debug("[metric_broadcast] publish_event ignored: missing 'type'")
        return
    if not _get_bus().append(payload):
        logger.debug("[metric_broadcast] publish_event failed (type=%s)",
                     payload.get("type"))


# ─────────────────────────────────────────────────────────────────────
#  TAILER — re-broadcast file events onto the local system_events bus
# ─────────────────────────────────────────────────────────────────────

_tailer_task: Optional[asyncio.Task] = None


async def _apply_control(payload: Dict[str, Any]) -> None:
    kind = payload.get("type")
    if kind == "session_revoked":
        # AUDIT 2026-08-02 (S1) — APPLIQUÉ (flux SSE fermés + PTY tués) et non
        # re-broadcasté : les clients visés reçoivent ``session_expired`` via
        # disconnect_user, les autres n'ont pas à savoir qui est révoqué.
        from shared_infra.observability.events_bus import apply_session_revocation
        await apply_session_revocation(payload)
    elif kind == "model_cache_refresh":
        from shared_infra.observability.events_bus import _refresh_model_cache
        await _refresh_model_cache()


async def _tail_loop(system_events) -> None:
    """
    Tail the JSONL file from the current end-of-file. Each new line is
    re-broadcast as-is onto the in-process system_events SSE bus (control
    types excepted). I/O in a thread; broadcasting stays on the loop.
    """
    tail = await asyncio.to_thread(_get_bus().tail)
    while True:
        try:
            bus = _get_bus()
            if tail.bus is not bus:
                tail = await asyncio.to_thread(bus.tail)
            # Ce tailer tourne à 10 Hz sur CHAQUE worker, en permanence (les
            # contrôles doivent s'appliquer même sans client SSE). Un ``stat``
            # sur la boucle écarte les tours vides sans passer par un thread.
            if not tail.has_new():
                await asyncio.sleep(_TAIL_POLL_SEC)
                continue
            for payload in await asyncio.to_thread(tail.read_new):
                if payload.get("type") in CONTROL_TYPES:
                    try:
                        await _apply_control(payload)
                    except Exception:
                        logger.exception("[metric_broadcast] contrôle %r",
                                         payload.get("type"))
                    continue
                try:
                    await system_events.broadcast(payload)
                except Exception as exc:
                    logger.debug("[metric_broadcast] broadcast failed: %r", exc)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # AUDIT 2026-08-02 (E9) — on attrape tout sauf l'annulation, en
            # WARNING : un tailer mort = plus aucun event inter-worker.
            logger.warning("[metric_broadcast] tail iteration failed: %r", exc)
        await asyncio.sleep(_TAIL_POLL_SEC)


def start_metric_tailer(system_events) -> None:
    """
    Schedule the tailer task on the running event loop. Idempotent —
    multiple calls are safe (the second one just returns).

    Called from the FastAPI startup handler in app.py once per worker. The
    task is registered in the background-task registry: cancelled at
    shutdown, and its death (if any) is logged.
    """
    global _tailer_task
    if _tailer_task is not None and not _tailer_task.done():
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError as exc:
        logger.warning("[metric_broadcast] no event loop: %r", exc)
        return
    _tailer_task = loop.create_task(_tail_loop(system_events))
    try:
        from shared_infra.observability.events_bus import _register_bg_task
        _register_bg_task(_tailer_task)
    except Exception:
        pass
    logger.info("[metric_broadcast] tailer started, file=%s pid=%d",
                EVENTS_FILE, os.getpid())
