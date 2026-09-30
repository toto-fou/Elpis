# SPDX-License-Identifier: MIT
"""rag_app.ocr._common — exception et primitives partagées du paquet OCR.

Dans un module dédié (et non ``__init__``) pour que les sous-modules
puissent l'importer sans dépendre de l'ordre d'import du paquet.
"""
from __future__ import annotations

import fcntl
import json
import os
import re
import secrets
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any


class OcrError(Exception):
    """Erreur métier du pipeline OCR (conversion, endpoint, format).

    Le message est destiné à l'utilisateur (affiché dans l'onglet Documents
    et stocké dans ``meta.error``) — pas de détails internes sensibles.
    """


# Format d'identifiant des documents : horodatage + aléa.
ID_RE = re.compile(r"^[0-9]{8}-[0-9]{6}-[0-9a-f]{8}$")


def new_id() -> str:
    """Identifiant horodaté-aléatoire (format validé par :data:`ID_RE`)."""
    return time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(4)


# Délai maximal d'attente d'un flock : au-delà, TimeoutError (sous-classe
# d'OSError) plutôt qu'un gel indéfini du thread — et, si l'appel venait de
# la boucle, du service entier (passe RAG 2, 2026-09-26).
LOCK_TIMEOUT_SEC = 30.0


@contextmanager
def file_lock(path: Path, timeout: float | None = None):
    """flock exclusif inter-process sur ``path`` (créé à la demande).

    Conservé malgré le service mono-process : les mutations de meta.json /
    queue.json arrivent depuis l'event loop ET le threadpool FastAPI —
    flock est sûr entre threads d'un même process (et survivrait à un
    passage multi-worker). Attente BORNÉE (``LOCK_TIMEOUT_SEC``) :
    :class:`TimeoutError` au-delà.
    """
    limit = LOCK_TIMEOUT_SEC if timeout is None else float(timeout)
    deadline = time.monotonic() + limit
    with open(path, "a") as fh:
        delay = 0.005
        while True:
            try:
                fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"verrou {path.name} occupé depuis {limit:.0f} s")
                time.sleep(delay)
                delay = min(delay * 2, 0.1)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def _fsync_dir(d: Path) -> None:
    try:
        fd = os.open(str(d), os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def write_bytes_atomic(path: Path, data: bytes) -> None:
    """Écriture atomique ET durable : tmp unique + fsync + replace + fsync du
    dossier. Une coupure de courant laisse l'ancien contenu ou le nouveau,
    jamais un fichier vide ou tronqué (passe RAG 2, 2026-09-26). Le dossier
    parent doit exister (jamais recréé : un document supprimé pendant une
    écriture ne renaît pas en dossier fantôme)."""
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        with open(tmp, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise
    _fsync_dir(path.parent)


def write_text_atomic(path: Path, text: str) -> None:
    write_bytes_atomic(path, text.encode("utf-8"))


def write_json_atomic(path: Path, obj: Any) -> None:
    """Écriture atomique et durable d'un JSON lisible (indent=1)."""
    write_text_atomic(path, json.dumps(obj, ensure_ascii=False, indent=1))
