# SPDX-License-Identifier: MIT
"""
shared_infra.runtime.ordered_io — exécuteur MONO-THREAD pour les écritures
« fire-and-forget » qui doivent rester ORDONNÉES.

(passe 7, R8) — ``loop.run_in_executor(None, …)`` a été utilisé pour sortir
de la boucle des écritures fichier courtes (``publish_cancel``,
``note_completion``). Or l'exécuteur par défaut est un ``ThreadPoolExecutor``
MULTI-thread : l'ordre de SOUMISSION est préservé, pas l'ordre d'EXÉCUTION —
deux écritures « last-write-wins » du même tour pouvaient se poser dans le
désordre (``completion_id`` périmé dans le magasin de reasoning-control). Et
le ``Future`` jamais consulté avalait toute exception (perte de comptabilité).

Un seul thread → FIFO strict ; un callback de fin journalise les échecs.
L'exécuteur est créé paresseusement PAR PROCESSUS (garde pid : un fork après
création laisserait un pool sans thread).
"""
from __future__ import annotations

import concurrent.futures
import logging
import os
import threading
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

_EXEC: Optional[concurrent.futures.ThreadPoolExecutor] = None
_EXEC_PID: Optional[int] = None
_LOCK = threading.Lock()


def _executor() -> concurrent.futures.ThreadPoolExecutor:
    global _EXEC, _EXEC_PID
    pid = os.getpid()
    if _EXEC is None or _EXEC_PID != pid:
        with _LOCK:
            if _EXEC is None or _EXEC_PID != pid:
                _EXEC = concurrent.futures.ThreadPoolExecutor(
                    max_workers=1, thread_name_prefix="elpis-ordered-io")
                _EXEC_PID = pid
    return _EXEC


def submit_ordered(tag: str, fn: Callable[..., Any], *args: Any
                   ) -> Optional[concurrent.futures.Future]:
    """Soumet ``fn(*args)`` au thread ordonné. Ne lève jamais : ``None`` si
    l'interpréteur s'arrête (executor fermé). Les exceptions de ``fn`` sont
    journalisées (DEBUG) sous ``tag``."""
    try:
        fut = _executor().submit(fn, *args)
    except RuntimeError:
        return None

    def _done(f: concurrent.futures.Future) -> None:
        try:
            f.result()
        except Exception:
            logger.debug("[ordered_io] %s a échoué", tag, exc_info=True)

    fut.add_done_callback(_done)
    return fut
