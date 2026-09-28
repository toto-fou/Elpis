# SPDX-License-Identifier: MIT
"""
shared_infra.db._pool — pool BORNÉ de connexions aux moteurs serveur.

SQLite garde une connexion par thread (``_connection.db``) : elle ne coûte
rien au serveur. Une connexion PostgreSQL ou MySQL, elle, est un processus ou
un thread côté serveur (5 à 10 Mo) : avec ~40 threads par worker et 2 à 3
workers, une connexion par thread dépasserait vite ``max_connections``. Le
pool en garde au plus ``max_size`` par process ; un thread qui en demande une
de plus attend qu'une se libère, puis échoue proprement au bout de
``timeout`` secondes au lieu de bloquer sans fin.

LIFO : la connexion rendue en dernier ressert d'abord (chaude, et les autres
peuvent vieillir). Une connexion inutilisée depuis plus de ``idle_check``
secondes est vérifiée (``ping``) avant d'être resservie — le serveur a pu la
couper (redémarrage, ``wait_timeout`` MySQL). Une connexion marquée
``broken`` (erreur réseau) est détruite au lieu d'être rendue.
"""
from __future__ import annotations

import threading
import time
from typing import Any, Callable, List, Tuple

from shared_infra.db._server import ServerOperationalError


class Pool:
    def __init__(self, factory: Callable[[], Any], *, max_size: int = 8,
                 timeout: float = 10.0, idle_check: float = 30.0):
        self._factory = factory
        self.max_size = max(1, int(max_size))
        self.timeout = float(timeout)
        self.idle_check = float(idle_check)
        self._idle: List[Tuple[Any, float]] = []
        self._count = 0
        self._cond = threading.Condition()
        self.created = 0

    def get(self) -> Any:
        deadline = time.monotonic() + self.timeout
        while True:
            candidate = None
            with self._cond:
                while candidate is None:
                    if self._idle:
                        candidate = self._idle.pop()
                        break
                    if self._count < self.max_size:
                        self._count += 1
                        break
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise ServerOperationalError(
                            f"database is locked: pool de connexions épuisé "
                            f"({self.max_size} en usage depuis {self.timeout:.0f} s)")
                    self._cond.wait(remaining)
            if candidate is None:
                try:
                    conn = self._factory()
                except BaseException:
                    with self._cond:
                        self._count -= 1
                        self._cond.notify()
                    raise
                self.created += 1
                return conn
            conn, since = candidate
            if time.monotonic() - since > self.idle_check:
                ok = False
                try:
                    ok = conn.ping()
                except Exception:
                    ok = False
                if not ok:
                    self._discard(conn)
                    continue
            return conn

    def put(self, conn: Any) -> None:
        if getattr(conn, "broken", False):
            self._discard(conn)
            return
        with self._cond:
            self._idle.append((conn, time.monotonic()))
            self._cond.notify()

    def _discard(self, conn: Any) -> None:
        try:
            conn.hard_close()
        except Exception:
            pass
        with self._cond:
            self._count -= 1
            self._cond.notify()

    def close_all(self) -> None:
        with self._cond:
            idle, self._idle = self._idle, []
            self._count -= len(idle)
        for conn, _ in idle:
            try:
                conn.hard_close()
            except Exception:
                pass

    def stats(self) -> dict:
        with self._cond:
            return {"max": self.max_size, "open": self._count,
                    "idle": len(self._idle), "in_use": self._count - len(self._idle)}


__all__ = ["Pool"]
