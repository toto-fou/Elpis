# SPDX-License-Identifier: MIT
"""Créneaux de génération partagés par TOUS les workers.

Un service compatible OpenAI calcule en synchrone et n'a pas de file
visible : sans borne commune, N workers gunicorn × ``max_concurrent``
requêtes partiraient en même temps vers un GPU qui n'en traite qu'une. Un
créneau = un fichier verrouillé (``flock``) dans le répertoire d'exécution,
``max_concurrent`` fichiers par adresse ; le verrou tombe avec le descripteur,
même si le worker meurt.

Après un Stop, le calcul distant continue : :meth:`Slot.release_after` garde
le créneau jusqu'à la fin estimée, pour que la génération suivante n'aille pas
s'empiler sur un GPU encore occupé.

sd-server n'en a pas besoin : il tient sa propre file et en publie la
position.
"""
from __future__ import annotations

import asyncio
import fcntl
import hashlib
import logging
import os
from pathlib import Path
from typing import Awaitable, Callable, Optional

from llm_core.imagegen.base import ImageError
from shared_infra.runtime.runtime_dir import runtime_path

logger = logging.getLogger("uvicorn.error")

SLOT_DIR: Path = runtime_path("image_slots", "ELPIS_IMAGE_SLOTS_DIR", "/tmp/elpis_image_slots")
_POLL_S = 0.5


class Slot:
    def __init__(self, fd: int) -> None:
        self._fd: Optional[int] = fd

    def release(self) -> None:
        fd, self._fd = self._fd, None
        if fd is None:
            return
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)

    def release_after(self, seconds: float) -> None:
        """Rend le créneau dans ``seconds`` (0 : tout de suite)."""
        if seconds <= 0:
            self.release()
            return
        try:
            asyncio.get_running_loop().call_later(seconds, self.release)
        except RuntimeError:
            self.release()


def _try(path: Path) -> Optional[int]:
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        return None
    return fd


async def acquire(url: str, cap: int, *, on_wait: Callable[[], Awaitable[None]],
                  cancelled: Callable[[], bool]) -> Slot:
    """Prend un des ``cap`` créneaux de l'adresse ; ``on_wait`` est appelé une
    fois si tous sont pris. :class:`ImageError` ``cancelled`` sur un Stop."""
    SLOT_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    key = hashlib.sha256((url or "").encode("utf-8")).hexdigest()[:16]
    paths = [SLOT_DIR / f"{key}-{k}.lock" for k in range(max(1, int(cap)))]
    waited = False
    while True:
        for p in paths:
            fd = await asyncio.to_thread(_try, p)
            if fd is not None:
                return Slot(fd)
        if not waited:
            waited = True
            await on_wait()
        if cancelled():
            raise ImageError("Génération annulée.", code="cancelled")
        await asyncio.sleep(_POLL_S)
