# SPDX-License-Identifier: MIT
"""
shared_infra.observability.file_bus — Journal JSONL partagé entre les workers.

Primitive COMMUNE aux deux bus inter-process qui passent par un fichier :
``metrics/broadcast.py`` (événements de contrôle : notification, restart,
session_revoked…) et le mode fichier de ``events_bus.PipelineEvents``. Chacun
avait sa copie du couple « append sous flock + tail par position » — avec les
mêmes défauts (audit moteur d'événements 2026-09-25, B3/B4) :

* **Rotation destructrice.** Le writer ajoutait sa ligne PUIS tronquait le
  fichier dès qu'il dépassait le seuil : la ligne qui déclenchait la rotation
  disparaissait avant qu'aucun tailer ne l'ait lue, avec tout ce que les
  autres workers n'avaient pas encore consommé. Un ``session_revoked`` tombé
  là n'était jamais appliqué.
* **Ligne à moitié écrite.** Le tailer lisait jusqu'à la fin SANS verrou et
  avançait sa position : une ligne en cours d'écriture était lue tronquée,
  échouait au décodage JSON, et sa fin échouait au tour suivant → événement
  perdu.

Ce module corrige les deux :

* rotation par RENOMMAGE (``x.jsonl`` → ``x.jsonl.1``) sous un verrou posé sur
  un fichier STABLE (``x.jsonl.lock``) : un tailer qui voit l'inode changer
  finit de lire l'ancien fichier avant de passer au nouveau — rien ne se perd ;
* le tailer ne consomme que jusqu'au dernier ``\\n`` : une ligne incomplète
  reste dans le fichier et sera lue entière au tour suivant ;
* droits : fichiers créés en 0600, et ``file_is_safe`` refuse un fichier qui
  appartient à un autre compte (un tiers qui écrit ici forgerait des
  révocations ou des annonces de redémarrage).

Pas de ``fsync`` : ces événements sont éphémères (aucun rejeu après un
redémarrage), le cache de pages suffit à les partager entre process.
"""
from __future__ import annotations

import fcntl
import json
import logging
import os
from pathlib import Path
from typing import Any, List, Optional, Tuple

from shared_infra.runtime.runtime_dir import file_is_safe

logger = logging.getLogger("uvicorn.error")


class FileBus:
    """Un journal JSONL append-only, partagé par tous les workers."""

    def __init__(self, path: Path, max_bytes: int = 5_000_000):
        self.path = Path(path)
        self.max_bytes = int(max_bytes)

    # Chemins dérivés — calculés à la volée : les tests (et certains
    # déploiements) repointent ``path`` après construction.
    @property
    def rotated_path(self) -> Path:
        return self.path.with_name(self.path.name + ".1")

    @property
    def lock_path(self) -> Path:
        return self.path.with_name(self.path.name + ".lock")

    # ── Écriture ──────────────────────────────────────────────────────────
    def append(self, payload: Any) -> bool:
        """Ajoute une ligne JSON. ``False`` si l'écriture est impossible
        (payload non sérialisable, disque, droits) — jamais d'exception."""
        try:
            line = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
        except (TypeError, ValueError):
            return False
        if not (file_is_safe(self.path) and file_is_safe(self.lock_path)):
            logger.error("[file_bus] %s n'est pas sûr (propriétaire/droits) — "
                         "événement ignoré", self.path)
            return False
        try:
            lock_fd = os.open(str(self.lock_path), os.O_RDWR | os.O_CREAT, 0o600)
        except OSError as exc:
            logger.debug("[file_bus] verrou %s indisponible : %r", self.lock_path, exc)
            return False
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            # Rotation AVANT l'écriture, sous le verrou : la ligne courante
            # part toujours dans le fichier vivant, et l'ancien reste lisible
            # (``.1``) le temps que les tailers le terminent.
            try:
                if self.path.stat().st_size > self.max_bytes:
                    os.replace(self.path, self.rotated_path)
            except FileNotFoundError:
                pass
            fd = os.open(str(self.path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            try:
                view = memoryview(line)
                while view:
                    n = os.write(fd, view)
                    view = view[n:]
            finally:
                os.close(fd)
            return True
        except OSError as exc:
            logger.debug("[file_bus] écriture %s échouée : %r", self.path, exc)
            return False
        finally:
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
            except OSError:
                pass
            os.close(lock_fd)

    def tail(self) -> "FileTail":
        """Curseur de lecture positionné à la FIN actuelle (pas de rejeu)."""
        t = FileTail(self)
        t.skip_to_end()
        return t


class FileTail:
    """Curseur de lecture d'un ``FileBus``. Non thread-safe : un seul lecteur
    (la boucle de tail d'un worker) l'utilise, séquentiellement."""

    def __init__(self, bus: FileBus, *, check_safe: bool = True):
        self.bus = bus
        # ``check_safe=False`` : lecteur d'un fichier qui n'est PAS un canal de
        # contrôle (journal applicatif) — on ne touche pas à ses droits.
        self.check_safe = check_safe
        self.ino: Optional[int] = None
        self.pos = 0
        # Inode déjà contrôlé par ``file_is_safe`` : le propriétaire d'un inode
        # ne change pas, et ses droits ne bougent que par nous. On ne repaie le
        # contrôle (un stat + éventuel chmod) qu'au changement d'inode
        # (rotation, recréation) — pas à chaque tour de boucle.
        self._safe_ino: Optional[int] = None

    def has_new(self) -> bool:
        """Y a-t-il quelque chose à lire ? Un seul ``stat`` (~2 µs) : assez
        léger pour la boucle d'événements. Les boucles de tail s'en servent
        pour ne payer le passage en thread de ``read_new`` que lorsqu'il y a
        réellement des octets — la très grande majorité des tours sont vides."""
        try:
            st = os.stat(self.bus.path)
        except OSError:
            return False
        return st.st_ino != self.ino or st.st_size != self.pos

    def skip_to_end(self) -> None:
        try:
            st = self.bus.path.stat()
            self.ino, self.pos = st.st_ino, st.st_size
        except OSError:
            self.ino, self.pos = None, 0

    @staticmethod
    def _read_complete(path: Path, pos: int) -> Tuple[int, List[bytes]]:
        """Lit à partir de ``pos`` jusqu'au DERNIER ``\\n`` seulement."""
        with open(path, "rb") as f:
            f.seek(pos)
            data = f.read()
        cut = data.rfind(b"\n")
        if cut < 0:
            return pos, []
        return pos + cut + 1, data[:cut].split(b"\n")

    def read_new(self) -> List[dict]:
        """Nouvelles lignes complètes, décodées. I/O bloquante : à appeler
        via ``asyncio.to_thread``."""
        path = self.bus.path
        raw: List[bytes] = []
        try:
            st = path.stat()
        except FileNotFoundError:
            return []
        if self.check_safe and st.st_ino != self._safe_ino:
            if not file_is_safe(path):
                return []
            self._safe_ino = st.st_ino
        if self.ino is not None and st.st_ino != self.ino:
            # Rotation : terminer l'ancien fichier (devenu ``.1``) avant de
            # basculer. Si ``.1`` n'est plus le nôtre (deux rotations entre
            # deux lectures — 10 Mo en un tour de boucle), il n'y a plus rien
            # à récupérer.
            old = self.bus.rotated_path
            try:
                if old.stat().st_ino == self.ino:
                    _, lines = self._read_complete(old, self.pos)
                    raw.extend(lines)
            except OSError:
                pass
            self.ino, self.pos = st.st_ino, 0
        elif self.ino is None:
            self.ino = st.st_ino
        if st.st_size < self.pos:
            self.pos = 0      # troncature externe (ancien writer) : repartir du début
        if st.st_size > self.pos:
            try:
                self.pos, lines = self._read_complete(path, self.pos)
                raw.extend(lines)
            except OSError:
                pass
        out: List[dict] = []
        for b in raw:
            b = b.strip()
            if not b:
                continue
            try:
                obj = json.loads(b.decode("utf-8", errors="replace"))
            except ValueError:
                continue
            if isinstance(obj, dict):
                out.append(obj)
        return out
