# SPDX-License-Identifier: MIT
"""
shared_infra/sandbox/executors/_readiness.py — a best-effort cache of per-container
running state, fed by a single ``docker events`` subscription, so
``UserSandbox.ensure_running()`` can skip the per-exec ``docker container
inspect`` on the hot path.

Why
---
Every ``UserSandbox.exec()`` calls ``ensure_running()`` → ``status()`` =
one ``docker container inspect`` subprocess, THEN spawns the ``docker exec``
itself. That's two docker CLI round-trips per tool call. The inspect is
redundant whenever the container is already up — which is the overwhelmingly
common case. Removing it cuts fixed per-call latency and, importantly, host
CPU contention with the co-located llama.cpp process.

Safety contract (this can only remove work, never change correctness)
---------------------------------------------------------------------
``confirmed_running(name)`` returns True ONLY when ALL hold:
  1. we hold a "running" signal for ``name`` recorded within the TTL, AND
  2. the ``docker events`` stream is currently healthy (so a stop/die/kill
     would have invalidated the entry within milliseconds).
On ANY uncertainty — no signal, stale signal, events stream down, cache
disabled — it returns False and the caller falls through to exactly today's
``status()`` + repair path. The cache is populated from the result of the
real ``status()`` calls the caller still makes on a miss, and invalidated
immediately by stop/die/kill/pause events and by our own stop/destroy.

Residual window: a container that vanishes in the sub-millisecond gap
between its state-change event and a concurrent call could be served a stale
"running" once, causing that one ``docker exec`` to fail (rc != 0 / ExecError
— the same surface as any transient docker error). The caller records the
failure as "stopped" so the NEXT call repairs via the full path. We never
auto-retry an exec (the command may have side effects). Set
``SANDBOX_READINESS_CACHE=0`` to disable the optimization entirely.
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
import threading
import time
from typing import Callable, Dict, Optional, Tuple

logger = logging.getLogger("uvicorn.error")

# docker event actions that mean "this container is now usable / not usable".
_UP_ACTIONS = {"start", "unpause", "restart"}
_DOWN_ACTIONS = {"die", "stop", "kill", "pause", "destroy", "oom"}


def _enabled() -> bool:
    return (os.environ.get("SANDBOX_READINESS_CACHE", "1").strip() or "1") not in ("0", "false", "no", "off")


class ReadinessCache:
    """In-memory {container_name -> (running, ts)} cache.

    Pure and unit-testable: the clock is injectable and the ``docker events``
    subscriber is opt-in (``start_events()``), so tests exercise the logic
    without Docker.
    """

    def __init__(self, ttl_s: float = 15.0, clock: Callable[[], float] = time.monotonic) -> None:
        self._ttl = ttl_s
        self._clock = clock
        self._state: Dict[str, Tuple[bool, float]] = {}
        self._lock = threading.Lock()
        # Events-stream health. Until the subscriber proves itself healthy we
        # stay False, so confirmed_running() degrades to the safe fallback.
        self._events_healthy = False
        self._events_thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        # Processus ``docker events`` courant, pour que ``stop_events`` puisse
        # le tuer sans attendre que la boucle de lecture débloque (M1).
        self._events_proc = None

    # ── recording ────────────────────────────────────────────────────────
    def record_running(self, name: str) -> None:
        if not name:
            return
        with self._lock:
            self._state[name] = (True, self._clock())

    def record_stopped(self, name: str) -> None:
        if not name:
            return
        with self._lock:
            self._state[name] = (False, self._clock())

    def invalidate(self, name: str) -> None:
        with self._lock:
            self._state.pop(name, None)

    # ── querying ─────────────────────────────────────────────────────────
    def confirmed_running(self, name: str) -> bool:
        """True only if a fresh authoritative running signal exists AND the
        events stream is healthy. False on any uncertainty."""
        if not name or not _enabled() or not self._events_healthy:
            return False
        with self._lock:
            entry = self._state.get(name)
            if not entry:
                return False
            running, ts = entry
            if not running:
                return False
            if (self._clock() - ts) > self._ttl:
                return False
            return True

    def state_stamp(self, name: str) -> Optional[Tuple[bool, float]]:
        """Dernier signal ``(running, ts)`` connu pour ``name``, ou ``None`` si
        le flux d'événements n'est pas sain. Un redémarrage (``die`` puis
        ``start``) change ``ts`` : c'est ce qui permet à un cache dérivé (IP
        d'aperçu) de se savoir périmé sans reposer la question à Docker."""
        if not name or not self._events_healthy:
            return None
        with self._lock:
            return self._state.get(name)

    # ── docker events ingestion (pure: feed it a parsed line) ────────────
    def apply_event(self, name: str, action: str) -> None:
        """Apply one container lifecycle event. ``action`` is the docker
        event Action (``start``/``die``/``kill``/...)."""
        if not name or not action:
            return
        act = action.strip().lower()
        if act in _UP_ACTIONS:
            self.record_running(name)
        elif act in _DOWN_ACTIONS:
            self.record_stopped(name)

    def set_events_healthy(self, healthy: bool) -> None:
        self._events_healthy = bool(healthy)

    # ── docker events subscriber (best-effort, supervised) ───────────────
    def start_events(self, label_filter: str = "label=elpis.user_id") -> None:
        """Start (once) a daemon thread that subscribes to ``docker events``
        for the user containers and keeps the cache fresh. No-op if docker is
        absent or the cache is disabled."""
        if not _enabled() or self._events_thread is not None:
            return
        if not shutil.which("docker"):
            return
        t = threading.Thread(
            target=self._events_loop, args=(label_filter,),
            name="sandbox-readiness-events", daemon=True,
        )
        self._events_thread = t
        t.start()

    def stop_events(self, join_timeout: float = 2.0) -> None:
        """Arrête l'abonnement ``docker events`` — thread ET processus.

        AUDIT 2026-08-01 (M1) : cette méthode n'avait AUCUN appelant, et poser
        ``_stop`` seul ne suffit pas — la boucle est bloquée dans
        ``for line in proc.stdout``, qui ne rend la main qu'à la ligne
        suivante. Le thread étant ``daemon``, il est tué à la sortie de
        l'interpréteur sans exécuter son ``finally`` : le ``docker events``,
        processus séparé, survivait alors réparenté à init — un de plus à
        chaque recyclage de worker (``max_requests=2000``).
        On termine donc le processus explicitement, ce qui débloque aussi la
        lecture et laisse le thread sortir proprement.
        """
        self._stop.set()
        self.set_events_healthy(False)
        proc = self._events_proc
        if proc is not None:
            for _kill in (proc.terminate, proc.kill):
                try:
                    if proc.poll() is None:
                        _kill()
                except Exception:
                    pass
        t = self._events_thread
        if t is not None and t.is_alive():
            try:
                t.join(timeout=join_timeout)
            except Exception:
                pass
        self._events_thread = None
        self._events_proc = None

    def _events_loop(self, label_filter: str) -> None:
        """Supervised: (re)spawn ``docker events`` with backoff; mark the
        stream unhealthy whenever it is not actively connected so the cache
        falls back to inspect during any gap."""
        backoff = 1.0
        docker = shutil.which("docker") or "docker"
        while not self._stop.is_set():
            proc = None
            try:
                proc = subprocess.Popen(
                    [docker, "events", "--filter", "type=container",
                     "--filter", label_filter,
                     "--format", "{{.Actor.Attributes.name}}\t{{.Action}}"],
                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                    text=True, bufsize=1,
                )
                # Publié pour que ``stop_events`` puisse le terminer (M1).
                self._events_proc = proc
                # Connected. Reconcile current truth once, then trust the
                # stream. We do NOT pre-populate running state here (the
                # caller's status() calls do that on miss); we only need the
                # stream live so invalidation is timely.
                self.set_events_healthy(True)
                backoff = 1.0
                for line in proc.stdout:  # blocks until a line or EOF
                    if self._stop.is_set():
                        break
                    parts = line.rstrip("\n").split("\t")
                    if len(parts) >= 2:
                        self.apply_event(parts[0], parts[1])
            except Exception as e:  # pragma: no cover - defensive
                logger.debug("[readiness] events stream error: %s", e)
            finally:
                self.set_events_healthy(False)
                if proc is not None:
                    try:
                        proc.terminate()
                    except Exception:
                        pass
                    # AUDIT 2026-08-02 (M8) — terminate() seul laissait le
                    # pipe stdout ouvert et le statut d'exit non consommé
                    # jusqu'au GC de l'objet Popen : à chaque flap réseau
                    # Docker (backoff 1 s → 30 s), un Popen + un fd de plus
                    # retenus. wait(5) reape le process (on tourne dans un
                    # thread dédié, bloquer 5 s max est sans effet de bord).
                    try:
                        proc.wait(timeout=5)
                    except Exception:
                        try:
                            proc.kill()
                            proc.wait(timeout=2)
                        except Exception:
                            pass
                    try:
                        if proc.stdout is not None:
                            proc.stdout.close()
                    except Exception:
                        pass
            if self._stop.is_set():
                break
            self._stop.wait(backoff)
            backoff = min(backoff * 2, 30.0)


# Process-wide singleton used by UserSandbox.
_cache: Optional[ReadinessCache] = None
_cache_lock = threading.Lock()


def get_readiness_cache() -> ReadinessCache:
    global _cache
    if _cache is not None:
        return _cache
    with _cache_lock:
        if _cache is None:
            _cache = ReadinessCache()
            # Best-effort: bring the events stream up lazily on first use.
            try:
                _cache.start_events()
            except Exception:  # pragma: no cover - defensive
                pass
        return _cache


__all__ = ["ReadinessCache", "get_readiness_cache"]
