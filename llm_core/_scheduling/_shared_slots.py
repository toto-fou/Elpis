# SPDX-License-Identifier: MIT
"""Créneaux du llama-server partagés par TOUS les process de l'application.

Le ``-np`` du llama-server est une ressource de MACHINE, mais l'ordonnanceur
(``_concurrency.LLMConcurrencyManager``) vit dans chaque worker gunicorn. Il se
contentait donc d'une part arithmétique, ``max(1, slots // workers)`` : sept
workers sur quatre créneaux lançaient sept générations (surplus empilé dans la
file interne de llama.cpp, caches KV évincés), trois workers sur quatre
créneaux en laissaient un inutilisé pendant qu'un utilisateur attendait.

Ici, un créneau = un fichier verrouillé (``flock``) dans le répertoire
d'exécution, ``cap`` fichiers par serveur (par serveur ET modèle quand le
serveur tient plusieurs modèles à la fois) — même principe que les créneaux
d'images (``llm_core/imagegen/slots.py``). Le verrou tombe avec le
descripteur, même si le process meurt ; le process admin, qui lance aussi des
générations, prend les mêmes fichiers. Le ``-np`` lu dans ``/props`` est noté
dans ``<serveur>.np`` : un process qui n'a pas pu le lire (moteur en
chargement) ne s'autorise pas plus que les autres.

Ordre :

* dans un process, seul le premier en file (``high`` avant ``low``, puis ordre
  d'arrivée) essaie les fichiers ; les suivants attendent leur tour ;
* entre process, un ``high`` en attente tient un verrou PARTAGÉ sur
  ``<clé>.high`` ; un ``low`` n'essaie pas tant qu'il ne peut pas le prendre en
  exclusif ;
* au-delà de ``low_cap_s`` secondes, un ``low`` passe au rang des ``high``
  (dans le process comme entre process) : jamais affamé, comme le reste de
  l'ordonnanceur.

Les fichiers servis sont « touchés » à chaque prise : le ménage de ``/tmp``
(systemd-tmpfiles, 10 jours) ne supprime donc pas un créneau en usage.

La prise (``open`` + ``flock`` non bloquant) est instantanée et se fait sur la
boucle : un descripteur pris dans un thread serait perdu si la tâche était
annulée pendant l'appel, et le créneau resterait tenu.

Repli : un dossier inutilisable (pas à nous, erreur disque) rend
:func:`available` faux ; l'appelant revient alors au partage arithmétique.
"""
from __future__ import annotations

import asyncio
import fcntl
import hashlib
import itertools
import logging
import os
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from shared_infra.runtime.runtime_dir import runtime_path

logger = logging.getLogger("uvicorn.error")

SLOT_DIR: Path = runtime_path("llm_slots", "ELPIS_LLM_SLOTS_DIR", "/tmp/elpis_llm_slots")
POLL_S = 0.1
_RECHECK_S = 60.0

# Dossier validé (chemin, verdict, instant) : revérifié après un échec, et
# quand ``SLOT_DIR`` change (les tests le redirigent).
_checked: Tuple[Optional[Path], bool, float] = (None, False, 0.0)
# File locale par clé : tickets (rang de priorité, numéro d'arrivée).
_queues: Dict[str, List[Tuple[int, int]]] = {}
_seq = itertools.count()
# Dernier ``-np`` noté par ce process, par serveur (évite de réécrire).
_noted: Dict[str, int] = {}


class Slot:
    """Un créneau tenu ; :meth:`release` est idempotent."""

    def __init__(self, fd: int) -> None:
        self._fd: Optional[int] = fd

    def release(self) -> None:
        fd, self._fd = self._fd, None
        if fd is None:
            return
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass
        finally:
            os.close(fd)


def available() -> bool:
    """Le dossier des créneaux est-il utilisable ? (à nous, privé)"""
    global _checked
    path, ok, at = _checked
    if path == SLOT_DIR and (ok or time.monotonic() - at < _RECHECK_S):
        return ok
    ok = _validate(SLOT_DIR)
    _checked = (SLOT_DIR, ok, time.monotonic())
    return ok


def _validate(d: Path) -> bool:
    try:
        d.mkdir(parents=True, exist_ok=True, mode=0o700)
        st = d.stat()
        if st.st_uid != os.geteuid():
            logger.error("[llm-slots] %s appartient à un autre compte : créneaux partagés "
                         "désactivés, partage par worker à la place.", d)
            return False
        if st.st_mode & 0o077:
            os.chmod(d, 0o700)
        return True
    except OSError as exc:
        logger.warning("[llm-slots] %s inutilisable (%r) : partage par worker à la place.", d, exc)
        return False


def _key(engine_key: str, model_key: str) -> str:
    return hashlib.sha256(f"{engine_key}\0{model_key}".encode("utf-8")).hexdigest()[:16]


def _paths(engine_key: str, model_key: str, cap: int) -> List[Path]:
    key = _key(engine_key, model_key)
    shared = _shared_capacity(engine_key)
    n = max(1, min(int(cap), shared) if shared else int(cap))
    return [SLOT_DIR / f"{key}-{k}.lock" for k in range(n)]


def _np_path(engine_key: str) -> Path:
    return SLOT_DIR / f"{_key(engine_key, '')}.np"


def note_capacity(engine_key: str, total_slots: int) -> None:
    """Note le ``-np`` lu dans ``/props`` pour tous les process."""
    n = int(total_slots or 0)
    if n <= 0 or not available():
        return
    path = _np_path(engine_key)
    if _noted.get(engine_key) == n and path.exists():
        return
    tmp = path.with_name(f"{path.name}.{os.getpid()}")
    try:
        tmp.write_text(str(n), encoding="utf-8")
        os.replace(tmp, path)
        _noted[engine_key] = n
    except OSError:
        pass


def _shared_capacity(engine_key: str) -> Optional[int]:
    try:
        n = int(_np_path(engine_key).read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return None
    return n if n > 0 else None


def _touch(fd: int) -> None:
    try:
        os.utime(fd)
    except OSError:
        pass


def _try_any(paths: List[Path]) -> Optional[int]:
    for p in paths:
        fd = os.open(p, os.O_CREAT | os.O_RDWR | os.O_CLOEXEC, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            continue
        except BaseException:
            os.close(fd)
            raise
        _touch(fd)
        return fd
    return None


def busy(engine_key: str, model_key: str, cap: int) -> int:
    """Créneaux pris en ce moment, tous process confondus (sonde en lecture,
    relâchée aussitôt). 0 si les créneaux partagés sont indisponibles."""
    if not available():
        return 0
    n = 0
    for p in _paths(engine_key, model_key, cap):
        try:
            fd = os.open(p, os.O_RDONLY | os.O_CLOEXEC)
        except FileNotFoundError:
            continue
        except OSError:
            return 0
        try:
            fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
            fcntl.flock(fd, fcntl.LOCK_UN)
        except BlockingIOError:
            n += 1
        except OSError:
            pass
        finally:
            os.close(fd)
    return n


def _flag_high(path: Path) -> Optional[int]:
    """Signale un ``high`` en attente (verrou partagé) ; ``None`` si un ``low``
    sonde le fichier à cet instant — réessayé au tour suivant."""
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_CLOEXEC, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        return None
    except BaseException:
        os.close(fd)
        raise
    _touch(fd)
    return fd


def _high_waiting(path: Path) -> bool:
    """Un ``high`` attend-il ailleurs ? (exclusif impossible = oui)"""
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_CLOEXEC, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return True
    finally:
        os.close(fd)
    return False


async def acquire(engine_key: str, model_key: str, cap: int, *, priority: str = "high",
                  low_cap_s: float = 30.0) -> Optional[Slot]:
    """Prend un des ``cap`` créneaux de (serveur, ``model_key``) — ``model_key``
    vide : le serveur entier ; attend sans limite (l'appelant rend compte de
    l'attente et gère le Stop). ``None`` : créneaux partagés indisponibles,
    l'appelant continue sans."""
    global _checked
    if not available():
        return None
    key = _key(engine_key, model_key)
    high_path = SLOT_DIR / f"{key}.high"
    is_high = priority != "low"
    queue = _queues.setdefault(key, [])
    ticket = (0 if is_high else 1, next(_seq))
    flag_fd: Optional[int] = None
    started = time.monotonic()
    queue.append(ticket)
    try:
        paths = _paths(engine_key, model_key, cap)
        while True:
            if not is_high and time.monotonic() - started > low_cap_s:
                # Plafond d'attente : le low prend rang de high, à son
                # numéro d'arrivée (ni doublé indéfiniment, ni doublant).
                queue[queue.index(ticket)] = ticket = (0, ticket[1])
                is_high = True
            if is_high and flag_fd is None and min(queue) != ticket:
                flag_fd = _flag_high(high_path)
            if min(queue) == ticket and (is_high or not _high_waiting(high_path)):
                fd = _try_any(paths)
                if fd is not None:
                    return Slot(fd)
                if is_high and flag_fd is None:
                    flag_fd = _flag_high(high_path)
            await asyncio.sleep(POLL_S)
    except OSError as exc:
        _checked = (None, False, 0.0)          # dossier revalidé (recréé) au prochain appel
        logger.warning("[llm-slots] créneau partagé impossible (%r) : génération lancée sans.", exc)
        return None
    finally:
        queue.remove(ticket)
        if not queue:
            _queues.pop(key, None)
        if flag_fd is not None:
            os.close(flag_fd)


__all__ = ["SLOT_DIR", "Slot", "acquire", "available", "busy", "note_capacity"]
