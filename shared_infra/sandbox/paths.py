# SPDX-License-Identifier: MIT
"""
shared_infra/sandbox/paths.py — chemins d'une sandbox, côté hôte.

Toute opération sur le contenu de ``/work`` passe par l'agent du conteneur
(L4) : ce module ne l'ouvre jamais. Il ramène les chemins que donnent le
modèle ou l'éditeur (``/work/x``, ``work/x``, ``./work/x``, ``~/x``) à un
chemin RELATIF à la racine, sur le texte seul (``lexical_rel``,
``rel_under``, ``strip_work_prefix``, ``to_container``) ; les liens, eux,
sont résolus par l'agent, qui les garde sous ``/work``.

Restent, pour les parties de ``P`` qui appartiennent à l'hôte (miroir des
skills, mémoire, instantanés — hors du montage) et que parcourent la
sauvegarde et la restauration, des accès par descripteurs qui ne suivent
aucun lien (``walk_beneath``, ``open_leaf``, ``write_beneath``), et la mise
en place de ``P/work`` (``ensure_work_subdir``).
"""
from __future__ import annotations

import errno
import logging
import os
import secrets
import shutil
import stat
from pathlib import Path, PurePosixPath
from typing import Any, Iterator, List, Optional, Tuple

try:
    import fcntl  # POSIX only
except ImportError:  # pragma: no cover - non-POSIX
    fcntl = None  # type: ignore[assignment]

logger = logging.getLogger("uvicorn.error")

CONTAINER_ROOT = "/work"

# The per-user host dir ``P`` is NO LONGER bind-mounted whole; only ``P/work``
# is mounted as the container ``/work``. The reserved siblings below stay at
# ``P`` (outside the mount) so the model can neither read nor delete them.
WORK_SUBDIR = "work"
_WORK_MARKER = ".work-migrated"
_WORK_LOCK = ".work-migrating.lock"
# Marqueur de la remise en ordre des droits de /work (L4.6 : arbre rendu à
# l'UID du conteneur, sans écriture pour le groupe et les autres) ; les
# marqueurs de l'ancien élargissement restent réservés à P.
_MODES_MARKER = ".work-modes-v1"
_PERMS_MARKER_LEGACY = (".perms-reconciled", ".perms-reconciled-v2", ".perms-reconciled-v3")
# Entries kept at ``P`` (never moved into ``P/work`` and never exposed in the
# container): the work subdir itself; the protected-skills mirror + its staging
# dir; the long-term memory store; the legacy ``.sandboxd`` socket dir; the
# optimistic-write lock sidecar; the /work modes marker; and the migration
# bookkeeping files.
_WORK_RESERVED = frozenset({
    WORK_SUBDIR,
    "skills",
    ".skills-mirror.tmp",
    "memory",       # long-term memory store (host-owned ``P/memory``)
    ".memory",      # legacy store (orphaned, owned 10001) — keep reserved too
    ".sandboxd",
    ".elpis-agent",  # socket de l'agent (agent_client.AGENT_RUN_DIR)
    ".write_locks",
    _MODES_MARKER,
    _WORK_MARKER,
    _WORK_LOCK,
} | set(_PERMS_MARKER_LEGACY))   # toutes les générations du marqueur restent à P

# The container-view prefixes the model emits for the sandbox root, longest
# (most specific) first so prefix stripping is unambiguous.
_WORK_PREFIXES = ("/work/", "./work/", "work/")
_WORK_ROOTS = ("/work", "./work", "work")


class SandboxPathError(ValueError):
    """A path that cannot be safely resolved under the sandbox root.

    Raised for: empty path when a path is required, NUL bytes, and any
    target that escapes the sandbox root (``..``, an absolute path outside
    it, or a symlink whose target is outside it).
    """


def strip_work_prefix(path: str) -> str:
    """Normalize the container view of a path (``/work``, ``work``,
    ``./work`` with or without a trailing component) to a path relative to
    the sandbox root. Idempotent for everything else.

    ``"/work"`` / ``"work"`` / ``"./work"`` → ``""`` (the root).
    ``"/work/src/x"`` / ``"work/src/x"`` / ``"./work/src/x"`` → ``"src/x"``.
    A path that does not start with a work-prefix is returned stripped of
    surrounding whitespace only.
    """
    if not path:
        return ""
    p = str(path).strip()
    if p in _WORK_ROOTS:
        return ""
    for pfx in _WORK_PREFIXES:
        if p.startswith(pfx):
            return p[len(pfx):]
    return p


def to_container(rel: str) -> str:
    """Map a sandbox-relative path to its in-container view.

    ``""`` / ``"."`` → ``"/work"``; ``"src/x"`` → ``"/work/src/x"``.
    """
    r = (rel or "").strip().strip("/")
    if r in ("", "."):
        return CONTAINER_ROOT
    return f"{CONTAINER_ROOT}/{r}"


# ── Parties de P qui appartiennent à l'hôte : accès par descripteurs ───────
# Chaque composant est ouvert RELATIVEMENT au descripteur de son parent avec
# ``O_NOFOLLOW`` : aucun lien n'est traversé, à aucun niveau.

_O_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
_O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_O_DIRECTORY = getattr(os, "O_DIRECTORY", 0)
_O_PATH = getattr(os, "O_PATH", 0)


def _rel_parts(rel: Any) -> List[str]:
    """Composants d'un chemin RELATIF à la racine ; refuse l'absolu et ``..``.
    ``\\`` est un caractère de nom ordinaire (Linux) : le convertir en ``/``
    faisait viser à ces primitives une autre entrée que celle demandée
    (2026-09-29)."""
    s = str(rel or "")
    if "\x00" in s:
        raise SandboxPathError("null byte in path")
    p = PurePosixPath(s)
    if p.is_absolute():
        raise SandboxPathError(f"absolute path refused: {s!r}")
    parts = [x for x in p.parts if x not in ("", ".")]
    if any(x == ".." for x in parts):
        raise SandboxPathError(f"'..' component refused: {s!r}")
    return parts


def open_dir_beneath(base: Any, rel: Any = "", *, create: bool = False,
                     dir_mode: Optional[int] = None, readable: bool = False) -> int:
    """Descripteur du dossier ``base/rel``, ouvert composant par composant
    SANS suivre de lien (``O_NOFOLLOW|O_DIRECTORY`` relatif au parent).

    Tout est ouvert en ``O_PATH`` : il suffit du droit de traverser, pas de
    lire — assez pour les appels ``*at()`` (ouvrir, créer, renommer,
    supprimer une entrée) et pour ``os.fwalk``. ``readable=True`` ouvre le
    dossier final en lecture, pour le lister directement (``os.scandir``).

    ``create`` : crée les dossiers manquants (``dir_mode`` posé sur ceux
    qu'on crée — le umask ne s'y applique donc pas). Lève
    :class:`SandboxPathError` si un composant est un lien ou n'est pas un
    dossier. L'appelant ferme le descripteur rendu."""
    parts = _rel_parts(rel)
    walk = (_O_PATH or os.O_RDONLY) | _O_DIRECTORY | _O_CLOEXEC
    last = (os.O_RDONLY if readable else (_O_PATH or os.O_RDONLY)) | _O_DIRECTORY | _O_CLOEXEC
    fd = os.open(str(Path(base).resolve()), walk if parts else last)
    try:
        for i, name in enumerate(parts):
            flags = (last if i == len(parts) - 1 else walk) | _O_NOFOLLOW
            created = False
            try:
                nfd = os.open(name, flags, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    raise
                try:
                    os.mkdir(name, 0o777, dir_fd=fd)
                    created = True
                except FileExistsError:
                    pass
                nfd = os.open(name, flags, dir_fd=fd)
            if created and dir_mode is not None:
                try:
                    os.chmod(f"/proc/self/fd/{nfd}", dir_mode)
                except OSError:
                    pass
            os.close(fd)
            fd = nfd
    except OSError as e:
        os.close(fd)
        if e.errno in (errno.ELOOP, errno.ENOTDIR, errno.EMLINK):
            raise SandboxPathError(
                f"symlink or non-directory on the path: {'/'.join(parts)!r}") from e
        raise
    except BaseException:
        os.close(fd)
        raise
    return fd


# Une entrée est saisie par ``O_PATH | O_NOFOLLOW`` — ce qui n'ouvre rien —,
# son type vérifié sur ce descripteur, puis elle est rouverte par
# ``/proc/self/fd`` : le même inode, quoi qu'il arrive au chemin.


def open_path_at(dir_fd: int, name: str) -> int:
    """Descripteur ``O_PATH`` de l'entrée ``name`` de ``dir_fd`` elle-même —
    un lien est saisi, jamais suivi — : de quoi ``fstat``, changer ses droits
    ou la rouvrir (:func:`reopen`) sans relire de chemin."""
    return os.open(name, _O_PATH | _O_NOFOLLOW | _O_CLOEXEC, dir_fd=dir_fd)


def reopen(pfd: int, flags: int = os.O_RDONLY) -> int:
    """Rouvre l'inode d'un descripteur ``O_PATH`` (``/proc/self/fd``)."""
    return os.open(f"/proc/self/fd/{pfd}", flags | _O_CLOEXEC)


def open_leaf(dir_fd: int, name: str, *, allow_dir: bool = False) -> int:
    """Descripteur en lecture de l'entrée ``name`` de ``dir_fd`` : un fichier
    régulier, ou un dossier si ``allow_dir``. Un lien, une FIFO, un socket ou
    un périphérique lèvent :class:`SandboxPathError` sans avoir été ouverts ;
    un dossier non demandé lève ``IsADirectoryError``."""
    pfd = open_path_at(dir_fd, name)
    try:
        mode = os.fstat(pfd).st_mode
        if stat.S_ISREG(mode):
            return reopen(pfd)
        if stat.S_ISDIR(mode) and allow_dir:
            return reopen(pfd, os.O_RDONLY | _O_DIRECTORY)
        if stat.S_ISDIR(mode):
            raise IsADirectoryError(errno.EISDIR, "Is a directory", name)
        raise SandboxPathError(f"symlink or special file refused: {name!r}")
    finally:
        os.close(pfd)


def rel_under(base: Any, target: Any) -> str:
    """``target`` (relatif, ou chemin hôte déjà résolu sous ``base``) rendu
    relatif à ``base`` — sans relire le disque. Hors de ``base`` :
    :class:`SandboxPathError`."""
    t = Path(target)
    if not t.is_absolute():
        return t.as_posix()
    try:
        return t.relative_to(Path(base)).as_posix()
    except ValueError:
        pass
    try:
        return t.relative_to(Path(base).resolve()).as_posix()
    except ValueError:
        raise SandboxPathError(f"path outside the sandbox root: {str(target)!r}") from None



def lexical_rel(base: Any, user_path: Any, *, allow_root: bool = True,
                tilde: bool = True) -> str:
    """Chemin relatif à ``base`` d'un chemin fourni (modèle, route), SANS lire
    le disque : préfixe ``/work`` retiré, ``.`` et ``..`` résolus sur le
    texte, ``~`` = la racine (vue du modèle ; ``tilde=False`` pour l'éditeur,
    dont les chemins viennent de l'arbre : ``~`` y est un nom). Les liens,
    eux, sont résolus par l'agent de la sandbox, qui les garde sous
    ``/work`` (L4). Sortie de la racine, NUL, ou racine alors que
    ``allow_root`` est faux : :class:`SandboxPathError`."""
    raw = "" if user_path is None else str(user_path)
    if "\x00" in raw:
        raise SandboxPathError("null byte in path")
    s = strip_work_prefix(raw)
    if tilde and (s == "~" or s.startswith("~/")):
        s = s[1:].lstrip("/")
    if s.startswith("/"):                               # chemin hôte sous la racine
        for b in (str(Path(base)), str(Path(base).resolve())):
            if s == b or s.startswith(b + "/"):
                s = s[len(b):]
                break
        else:
            raise SandboxPathError(f"path outside the sandbox root: {raw!r}")
    parties: List[str] = []
    for c in s.split("/"):
        if c in ("", "."):
            continue
        if c == "..":
            if not parties:
                raise SandboxPathError(f"path outside the sandbox root: {raw!r}")
            parties.pop()
        else:
            parties.append(c)
    if not parties and not allow_root:
        raise SandboxPathError("operation requires a path inside the sandbox, not its root")
    return "/".join(parties)

def leaf_mode(dir_fd: int, name: str) -> int:
    """``st_mode`` de l'entrée ``name`` de ``dir_fd``, lien non suivi ; ``0``
    si elle a disparu ou est inaccessible (entrée d'un parcours en cours)."""
    try:
        return os.stat(name, dir_fd=dir_fd, follow_symlinks=False).st_mode
    except OSError:
        return 0


def walk_beneath(base: Any, rel: Any = "", *,
                 onerror=None) -> Iterator[Tuple[str, List[str], List[str], int]]:
    """``os.fwalk`` de ``base/rel`` qui ne suit aucun lien : racine ouverte par
    :func:`open_dir_beneath`, liens vers des dossiers retirés de ``dirnames``,
    et un dossier remplacé par un lien pendant le parcours n'est pas descendu
    (contrôle d'inode d'``os.fwalk``).

    Rend ``(rel_dir, dirnames, filenames, dir_fd)`` ; ``rel_dir`` est relatif à
    ``base`` et ``dirnames`` s'élague sur place. ``filenames`` peut contenir
    des liens et des fichiers spéciaux : les ouvrir par :func:`open_leaf`."""
    top_rel = "/".join(_rel_parts(rel))
    top = open_dir_beneath(base, top_rel)
    try:
        for cur, dirnames, filenames, dfd in os.fwalk(".", dir_fd=top, follow_symlinks=False,
                                                      onerror=onerror):
            dirnames[:] = [d for d in dirnames if stat.S_ISDIR(leaf_mode(dfd, d))]
            sub = "" if cur == "." else cur[2:]
            yield "/".join(x for x in (top_rel, sub) if x), dirnames, filenames, dfd
    finally:
        os.close(top)


def _short_leaf(leaf: str, max_bytes: int = 120) -> str:
    """Préfixe de ``leaf`` d'au plus ``max_bytes`` octets UTF-8, sans couper
    un caractère. Passe sandbox 2026-09-26 — la troncature en CARACTÈRES
    (``leaf[:80]``) donnait jusqu'à 320 octets pour 80 caractères CJK : un nom
    légal de 244 octets produisait un temporaire > 255 octets (ENAMETOOLONG)
    et copie / .bak / save_stdout échouaient sur ce nom."""
    b = leaf.encode("utf-8", "surrogateescape")[:max_bytes]
    return b.decode("utf-8", "ignore")


def write_beneath(base: Any, rel: Any, data: Any, *,
                  file_mode: Optional[int] = None,
                  default_mode: int = 0o644,
                  dir_mode: Optional[int] = None,
                  make_parents: bool = True,
                  mtime_ns: Optional[int] = None) -> int:
    """Écrit ``data`` (``bytes`` ou objet fichier binaire lisible) dans
    ``base/rel`` sans jamais suivre de lien, dossiers intermédiaires compris.

    Atomique : temporaire exclusif (``O_CREAT|O_EXCL|O_NOFOLLOW``) dans le
    dossier final, puis ``rename`` relatif à ce dossier. Mode du fichier :
    ``file_mode`` s'il est donné, sinon celui du fichier REMPLACÉ (régulier),
    sinon ``default_mode``. ``mtime_ns`` : date de modification à reporter
    (copie). Retourne le nombre d'octets écrits."""
    parts = _rel_parts(rel)
    if not parts:
        raise SandboxPathError("a file path is required, not the root")
    dfd = open_dir_beneath(base, "/".join(parts[:-1]), create=make_parents,
                           dir_mode=dir_mode)
    leaf = parts[-1]
    written = 0
    try:
        mode = file_mode
        if mode is None:
            try:
                st = os.stat(leaf, dir_fd=dfd, follow_symlinks=False)
                if stat.S_ISREG(st.st_mode):
                    mode = st.st_mode & 0o777
            except FileNotFoundError:
                pass
        if mode is None:
            mode = default_mode
        tmp = f".{_short_leaf(leaf)}.{secrets.token_hex(6)}.tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | _O_NOFOLLOW | _O_CLOEXEC,
                     0o600, dir_fd=dfd)
        try:
            with os.fdopen(fd, "wb") as fh:
                if isinstance(data, (bytes, bytearray, memoryview)):
                    fh.write(data)
                    written = len(data)
                else:
                    while True:
                        chunk = data.read(1024 * 1024)
                        if not chunk:
                            break
                        fh.write(chunk)
                        written += len(chunk)
                fh.flush()
                os.fchmod(fh.fileno(), mode & 0o777)
                if mtime_ns is not None:
                    os.utime(fh.fileno(), ns=(mtime_ns, mtime_ns))
                try:
                    os.fsync(fh.fileno())
                except OSError:
                    pass
            os.replace(tmp, leaf, src_dir_fd=dfd, dst_dir_fd=dfd)
        except BaseException:
            try:
                os.unlink(tmp, dir_fd=dfd)
            except OSError:
                pass
            raise
    finally:
        os.close(dfd)
    return written


def ensure_work_subdir(per_user_dir) -> Path:
    """Return the mounted work root ``<per_user_dir>/work``, migrating a legacy
    flat layout into it ONCE.

    Historically the WHOLE per-user dir ``P`` was bind-mounted as the container
    ``/work``, so ``P/skills`` (skills mirror) and ``P/.memory`` (long-term
    memory) were exposed and ``rm``-deletable by the model. We now mount only
    ``P/work``; the reserved siblings (:data:`_WORK_RESERVED`) stay at ``P``,
    outside the mount. For an existing user this moves every top-level entry of
    ``P`` — EXCEPT the reserved set — into ``P/work/``.

    Idempotent and resumable: ``.work-migrated`` is written LAST, under an
    exclusive ``flock`` on ``P/.work-migrating.lock`` (fail-open if ``fcntl``
    is unavailable). Each move is an intra-filesystem rename, so an interrupted
    run resumes naturally — an already-moved entry is no longer a top-level
    sibling — and an existing destination is never overwritten.
    """
    P = Path(per_user_dir)
    work = P / WORK_SUBDIR
    marker = P / _WORK_MARKER

    # Fast path: already migrated (no lock, no scan). Recreate the dir if it
    # was removed out from under us (defensive).
    if marker.exists():
        work.mkdir(parents=True, exist_ok=True)
        return work

    P.mkdir(parents=True, exist_ok=True)

    fh = None
    try:
        fh = open(P / _WORK_LOCK, "a")  # noqa: SIM115 (verrou flock tenu)
        if fcntl is not None:
            try:
                fcntl.flock(fh.fileno(), fcntl.LOCK_EX)  # blocking: peer waits
            except OSError:
                pass  # fail-open (lock unsupported on this FS)

        # Re-check under the lock: a peer worker may have just finished.
        if marker.exists():
            work.mkdir(parents=True, exist_ok=True)
            return work

        # Collision guard: a pre-existing non-directory ``work`` with no marker
        # is ambiguous (and effectively impossible — routes and the path
        # normalizer both collapse ``work/`` to the root). Abort without
        # touching any data.
        if work.exists() and not work.is_dir():
            logger.error("[sandbox] %s exists and is not a directory — "
                         "skipping work-subdir migration", work)
            return work

        work.mkdir(parents=True, exist_ok=True)

        for entry in list(P.iterdir()):
            if entry.name in _WORK_RESERVED:
                continue
            dest = work / entry.name
            if dest.exists():  # partial prior run / clash — never overwrite
                logger.warning("[sandbox] work-subdir: destination exists, "
                               "leaving %s in place", entry)
                continue
            try:
                shutil.move(str(entry), str(dest))
            except Exception as e:  # noqa: BLE001 - best-effort, keep going
                logger.warning("[sandbox] work-subdir: could not move %s → %s: %s",
                               entry, dest, e)

        # Done-signal written LAST, so a crash mid-move never looks complete.
        try:
            marker.write_text("1", encoding="utf-8")
        except OSError as e:  # pragma: no cover - disk full / perms
            logger.warning("[sandbox] work-subdir: marker write failed (%s): %s",
                           marker, e)
        return work
    finally:
        if fh is not None:
            try:
                if fcntl is not None:
                    fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
            except Exception:
                pass
            fh.close()


__all__ = [
    "CONTAINER_ROOT",
    "SandboxPathError",
    "WORK_SUBDIR",
    "ensure_work_subdir",
    "lexical_rel",
    "open_dir_beneath",
    "open_leaf",
    "rel_under",
    "strip_work_prefix",
    "to_container",
    "walk_beneath",
    "write_beneath",
]
