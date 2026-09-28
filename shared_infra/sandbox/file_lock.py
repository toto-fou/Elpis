# SPDX-License-Identifier: MIT
"""
shared_infra/sandbox/file_lock.py — verrou d'écriture PAR FICHIER, commun à
l'éditeur (``/api/sandbox/save``, ``/replace``, uploads) et aux outils fs de
l'assistant (``llm_core/tools/fs_tools.py``).

Audit éditeur 2026-09-23 (E7) : ``/save`` vérifiait sa précondition sous un
verrou PAR COMPTE que les outils de l'assistant ne prenaient pas ; une
écriture de l'agent tombée entre le contrôle et le ``mv`` était écrasée sans
un mot. Les deux chemins prennent désormais ce verrou-ci.

flock advisory sur un fichier sidecar à inode stable (jamais supprimé),
HORS de la sandbox : ``<APP_SANDBOX_DIR>/.write_locks/<sha1(chemin résolu)>.lock``
— le même emplacement que l'ancien verrou des outils fs, qui en devient un
simple alias. Fail-open borné (flock indisponible ou contention > timeout) :
l'écriture atomique reste la protection de base. Le terminal et git ne le
prennent pas (limite connue ; le hash de contenu les rattrape à l'écriture
suivante).
"""
from __future__ import annotations

import contextlib
import hashlib
import os
import time
from pathlib import Path
from typing import Iterator, Optional

_ENABLED = os.environ.get("FSTOOLS_FLOCK", "1") != "0"


def _locks_base() -> Optional[Path]:
    try:
        base = os.environ.get("APP_SANDBOX_DIR")
        if not base:
            from shared_infra.config import SANDBOX_DIR
            base = str(SANDBOX_DIR)
        return Path(base).resolve() / ".write_locks"
    except Exception:
        return None


def lock_name(path) -> str:
    return hashlib.sha1(str(path).encode("utf-8", "replace")).hexdigest() + ".lock"


@contextlib.contextmanager
def file_write_lock(path, timeout_s: float = 3.0) -> Iterator[bool]:
    """flock exclusif sur ``path`` (chemin RÉSOLU). Yield True si obtenu."""
    fd = None
    got = False
    base = _locks_base() if _ENABLED else None
    if base is not None:
        try:
            import fcntl
            base.mkdir(parents=True, exist_ok=True)
            fd = os.open(str(base / lock_name(path)), os.O_CREAT | os.O_RDWR, 0o644)
            deadline = time.monotonic() + timeout_s
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    got = True
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        break
                    time.sleep(0.03)
        except Exception:
            got = False
    try:
        yield got
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path, limit: int = 64 * 1024 * 1024) -> Optional[str]:
    """sha256 du contenu, ``None`` si illisible ou plus gros que ``limit``."""
    try:
        p = Path(path)
        if p.stat().st_size > limit:
            return None
        h = hashlib.sha256()
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


__all__ = ["file_write_lock", "lock_name", "sha256_bytes", "sha256_file"]
