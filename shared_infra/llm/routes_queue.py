# SPDX-License-Identifier: MIT
"""
backend.routes.queue_status — v17.7 (polling) → v17.8 (SSE)
============================================================

Expose la charge LLM/pipeline/chat live aux clients agentic.

Endpoints
---------
1. **GET /api/llm/queue-status** (legacy v17.7)
   Poll one-shot. Lit ``LLM_SEMAPHORE.get_stats()`` + un COUNT SQL.
   Toujours dispo en fallback ou pour scripts externes.

2. **GET /api/llm/queue-status/stream** (v17.8, SSE)
   Stream Server-Sent Events. Le serveur produit un snapshot toutes les
   4 s et broadcast à tous les abonnés via une pub/sub asyncio. Une
   seule tâche de fond par worker, partagée entre tous les clients SSE.
   → N clients = 1 fetch SQL toutes les 4s (vs N/4 fetch en polling).

Architecture
------------
``_QueueStatusBroadcaster`` est un singleton par worker. Tant qu'aucun
client n'est abonné, la tâche de fond n'existe pas (zéro coût). Au
premier subscriber, elle démarre. Au dernier départ, elle s'arrête.

Limitations connues (multi-worker)
-----------------------------------
Chaque worker Gunicorn a sa propre instance de LLM_SEMAPHORE et de
broadcaster. Un SSE subscriber sur worker A voit seulement les holders
de worker A. Pour un agrégat cross-worker, il faudrait un message bus
externe (Redis pub/sub) — out-of-scope ici, et le signal "ce worker est
saturé" reste utile au user.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import Counter
from typing import Any, Dict, Optional, Set

from fastapi import Request
from fastapi.responses import JSONResponse, StreamingResponse

from llm_core._scheduling import LLM_SEMAPHORE
from shared_infra.routes._state import router
from shared_infra.security.deps import require_user_id

logger = logging.getLogger("uvicorn.error")

# Cadence d'émission server-side. À 4s, ça donne un signal "live" sans
# saturer ni la DB ni le réseau. Si on baisse à 1s, le SQL COUNT devient
# le poste de coût dominant — à éviter.
_SNAPSHOT_INTERVAL_SEC = 4.0

# Timeout sur l'attente d'événement côté SSE. Sans message, on émet un
# keep-alive pour éviter que les reverse-proxies ferment la connexion.
_SSE_KEEPALIVE_SEC = 30.0


# ────────────────────────────────────────────────────────────────────────
#  Helpers de snapshot
# ────────────────────────────────────────────────────────────────────────

def _build_snapshot() -> Dict[str, Any]:
    """Construit le payload qu'on broadcast.

    Logique extraite des deux endpoints (legacy poll + SSE) pour rester
    coherente. Pas async — lecture in-memory du sémaphore LLM.
    """
    stats = LLM_SEMAPHORE.get_stats()
    active_models   = stats.get("active_models") or []
    slot_waiters    = stats.get("slot_waiters") or []
    total_from_props = stats.get("total_slots_from_props")
    fallback_max     = stats.get("max_conversations_per_model_config_fallback") or 1

    waiters_by_model = Counter(w.get("model") or "" for w in slot_waiters
                               if not w.get("cancelled"))

    models_out = []
    total_in_flight = 0
    total_capacity  = 0
    for m in active_models:
        # Ce worker ne voit que ses détenteurs ; les créneaux pris par les
        # autres process se lisent dans les créneaux partagés.
        holders = max(int(m.get("holders") or 0), int(m.get("shared_busy") or 0))
        max_c   = int(m.get("effective_max_convs") or fallback_max)
        models_out.append({
            "model":   m.get("model") or "",
            "holders": holders,
            "max":     max_c,
            "waiters": int(waiters_by_model.get(m.get("model") or "", 0)),
        })
        total_in_flight += holders
        total_capacity  += max_c

    if isinstance(total_from_props, int) and total_from_props > total_capacity:
        total_capacity = total_from_props

    total_waiting = sum(1 for w in slot_waiters if not w.get("cancelled"))
    sat_ratio = (total_in_flight / total_capacity) if total_capacity > 0 else 0.0

    return {
        "llm": {
            "in_flight":        total_in_flight,
            "waiting":          total_waiting,
            "capacity":         total_capacity,
            "saturation_ratio": round(sat_ratio, 3),
            "models":           models_out,
        },
        "chat": {
            "active_estimate": total_in_flight,
        },
        "ts": time.time(),
    }


# ────────────────────────────────────────────────────────────────────────
#  Broadcaster pub/sub
# ────────────────────────────────────────────────────────────────────────

class _QueueStatusBroadcaster:
    """Singleton par worker : maintient les subscribers + tâche de
    snapshot périodique. Démarre la boucle à 1er subscriber, l'arrête
    quand le dernier part."""

    def __init__(self) -> None:
        self._subscribers: Set[asyncio.Queue] = set()
        self._task:        Optional[asyncio.Task] = None
        self._lock:        Optional[asyncio.Lock] = None
        self._last_payload: Optional[Dict[str, Any]] = None

    def _ensure_lock(self) -> asyncio.Lock:
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    async def subscribe(self) -> asyncio.Queue:
        """Enregistre un nouveau subscriber. Démarre la boucle si dormante.

        Retourne une queue bornee — si l'abonné est trop lent, ses
        anciens messages sont perdus (drop policy), pas de buildup.
        """
        q: asyncio.Queue = asyncio.Queue(maxsize=4)
        async with self._ensure_lock():
            self._subscribers.add(q)
            if self._task is None or self._task.done():
                self._task = asyncio.create_task(
                    self._loop(), name="queue_status_broadcaster",
                )
        # Push le dernier payload immediatement pour ne pas attendre 4s
        if self._last_payload is not None:
            try:
                q.put_nowait(self._last_payload)
            except asyncio.QueueFull:
                pass
        return q

    async def unsubscribe(self, q: asyncio.Queue) -> None:
        async with self._ensure_lock():
            self._subscribers.discard(q)

    async def _loop(self) -> None:
        """Boucle snapshot. Tourne tant qu'il y a au moins un subscriber."""
        try:
            while True:
                # Snapshot etat actuel
                try:
                    payload = await asyncio.get_event_loop().run_in_executor(
                        None, _build_snapshot,
                    )
                except Exception as e:
                    logger.warning("[queue-status] snapshot error: %s", e)
                    payload = None

                if payload is not None:
                    self._last_payload = payload
                    async with self._ensure_lock():
                        subs = list(self._subscribers)
                    for q in subs:
                        try:
                            q.put_nowait(payload)
                        except asyncio.QueueFull:
                            try:
                                _ = q.get_nowait()
                                q.put_nowait(payload)
                            except Exception:
                                pass

                await asyncio.sleep(_SNAPSHOT_INTERVAL_SEC)

                async with self._ensure_lock():
                    if not self._subscribers:
                        logger.debug("[queue-status] no subscribers - stop loop")
                        return
        except asyncio.CancelledError:
            logger.debug("[queue-status] broadcast loop cancelled")
            raise
        except Exception as e:
            logger.exception("[queue-status] broadcast loop crashed: %s", e)
        finally:
            # AUDIT 2026-08-31 (passe 4, B14) — TOCTOU : la décision de sortir
            # est prise sous le lock, mais ``task.done()`` ne devient True
            # qu'APRÈS le déroulement complet de la coroutine. Un subscribe()
            # concurrent voyait ``done() == False`` → ne relançait pas la
            # boucle → le nouvel abonné ne recevait que ``_last_payload``.
            # On efface la référence ICI, synchrone (pas d'await entre le
            # check et l'assignation → atomique vis-à-vis des coroutines) :
            # subscribe() voit ``None`` et redémarre. Couvre aussi le crash.
            if self._task is asyncio.current_task():
                self._task = None


_BROADCASTER = _QueueStatusBroadcaster()


# ────────────────────────────────────────────────────────────────────────
#  Endpoints
# ────────────────────────────────────────────────────────────────────────

@router.get("/api/llm/queue-status")
async def api_llm_queue_status(request: Request):
    """One-shot poll. Lit l'etat actuel sans s'abonner. Conserve en
    fallback (clients sans EventSource, scripts CLI, debug)."""
    require_user_id(request)
    payload = await asyncio.get_event_loop().run_in_executor(
        None, _build_snapshot,
    )
    return JSONResponse(payload, headers={"Cache-Control": "no-cache"})


@router.get("/api/llm/queue-status/stream")
async def api_llm_queue_status_stream(request: Request):
    """SSE stream. Envoie un snapshot immediat puis un par
    ``_SNAPSHOT_INTERVAL_SEC`` (typiquement 4 s).

    Format SSE standard :
      data: {"llm": {...}, ...}

    Keep-alive : si aucun message pendant ``_SSE_KEEPALIVE_SEC``, on
    emet un commentaire SSE pour empecher les reverse-proxies de
    fermer la connexion.
    """
    uid = require_user_id(request)
    logger.info("[queue-status/stream] subscribe uid=%s", uid)
    # Revalidation périodique (audit moteur d'événements 2026-09-25) — comme
    # les autres flux longs : valeurs de session capturées au handshake.
    _sess = request.scope.get("session") or {}
    _login_ts, _sid = _sess.get("_login_ts"), _sess.get("_sid")

    async def event_generator():
        # AUDIT 2026-08-02 (M6) — subscribe DANS le générateur, pas dans le
        # handler : un générateur jamais itéré (client parti au handshake,
        # exception middleware) n'exécute NI son corps NI son finally — la
        # queue restait donc abonnée à vie et maintenait la boucle de
        # snapshot (un run_in_executor(_build_snapshot) toutes les 4 s)
        # pour toujours, même sans aucun client réel.
        queue = await _BROADCASTER.subscribe()
        last_check = time.monotonic()
        try:
            while True:
                if await request.is_disconnected():
                    logger.debug("[queue-status/stream] client disconnected")
                    break
                if time.monotonic() - last_check >= 60.0:
                    last_check = time.monotonic()
                    try:
                        from shared_infra.security.deps import stream_session_still_valid
                        still = await asyncio.to_thread(
                            stream_session_still_valid, int(uid), _login_ts, _sid)
                    except Exception:
                        still = True      # transitoire → fail-open (cf. deps)
                    if not still:
                        yield f"data: {json.dumps({'type': 'session_expired'})}\n\n"
                        break
                # Recyclage invisible (audit 2026-08-02) — ce flux en
                # StreamingResponse nu ne s'arrêtait QUE sur déconnexion
                # client : il retenait le worker mourant pendant tout le
                # drain. Fin propre → l'EventSource du widget se rebranche
                # de lui-même sur un worker sain.
                try:
                    from sse_starlette.sse import AppStatus
                    if AppStatus.should_exit:
                        break
                except ImportError:
                    pass
                try:
                    payload = await asyncio.wait_for(
                        queue.get(), timeout=_SSE_KEEPALIVE_SEC,
                    )
                    yield f"data: {json.dumps(payload, separators=(',', ':'))}\n\n"
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
                except Exception as e:
                    logger.warning("[queue-status/stream] queue error: %s", e)
                    break
        finally:
            await _BROADCASTER.unsubscribe(queue)
            logger.info("[queue-status/stream] unsubscribed uid=%s", uid)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control":     "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection":        "keep-alive",
        },
    )
