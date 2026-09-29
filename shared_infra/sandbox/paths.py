# SPDX-License-Identifier: MIT
"""
shared_infra/sandbox/paths.py — the ONE place that turns a model/route
supplied path into a resolved, contained location under a per-user sandbox
root.

Why this exists
---------------
The same "normalize the container view of a path, then prove it does not
escape the sandbox root" logic was reimplemented 6-8 times and DRIFTED:

  * ``fs_tools._translate_container_path`` / ``_to_container`` / ``_safe_path``
    (depuis L4.2 : ``lexical_rel``, les liens résolus par l'agent)
  * ``_exec_bridge._path_to_container`` (depuis L4.2 : ``to_container``)
  * ``routes/_helpers._strip_work_prefix`` / ``_path_inside``
  * ``routes/_sandbox_exec._validate_rel_path``  (pure-string ``..`` reject,
    NO ``resolve()`` — strictly weaker than the tool-side check)
  * ``shell_tools`` rolled its own copy

A fix to one did not propagate, and the route check could be laxer than the
tool check for the same logical operation. This module collapses them into a
single, fuzz/property-tested resolver.

Security note
-------------
On the host this is a *defense-in-depth* containment check and a UX
normalizer, NOT the kernel security boundary — that is the per-user Docker
container. ``resolve_under`` calls ``Path.resolve()`` so a symlink that
points OUT of the sandbox root resolves to its target and is then rejected
by the containment check (it never silently follows a link out). It uses
``relative_to`` (not ``str.startswith``) so sibling-prefix names like
``/sandbox/bob`` vs ``/sandbox/bob2`` cannot be confused.

Path vocabulary
---------------
* ``rel``       — POSIX path relative to the sandbox root. ``""`` == the root.
* ``host``      — absolute host path, guaranteed at/under the resolved root.
* ``container`` — the in-container view: ``/work`` or ``/work/<rel>``.

The model reasons in the container's path space (its shell runs in
``/work``) and routinely re-emits paths as ``/work/x``, ``work/x`` or
``./work/x``; all three collapse to ``rel == "x"``.
"""
from __future__ import annotations

import errno
import logging
import os
import secrets
import shutil
import stat
from contextlib import contextmanager
from dataclasses import dataclass
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
# Chaque nouvelle version du marqueur re-déclenche UNE passe ``chmod -R o+rwX``
# par sandbox — c'est le levier de résorption du backlog, dans LES DEUX SENS
# (o+rw ouvre aussi bien un arbre 10001 à l'hôte qu'un arbre host-owned au
# conteneur) :
#   v2 (2026-07-21) : clones faits dans le TERMINAL avant son wrapper umask.
#   v3 (2026-07-30) : clones/init/pull host-side pendant que
#                     ``sandbox_grant_access`` était inerte (il appelait
#                     ``get_user_sandbox`` avec la mauvaise arité → TypeError
#                     avalé → ni ACL, ni chmod, ni chown). Ces dépôts sont
#                     restés en 0644/0755 à l'UID de l'app, donc non éditables
#                     depuis le conteneur.
_PERMS_MARKER = ".perms-reconciled-v3"
_PERMS_MARKER_LEGACY = (".perms-reconciled", ".perms-reconciled-v2")
# Entries kept at ``P`` (never moved into ``P/work`` and never exposed in the
# container): the work subdir itself; the protected-skills mirror + its staging
# dir; the long-term memory store; the legacy ``.sandboxd`` socket dir; the
# optimistic-write lock sidecar; the cross-UID perms-repair marker; and the
# migration bookkeeping files.
_WORK_RESERVED = frozenset({
    WORK_SUBDIR,
    "skills",
    ".skills-mirror.tmp",
    "memory",       # long-term memory store (host-owned ``P/memory``)
    ".memory",      # legacy store (orphaned, owned 10001) — keep reserved too
    ".sandboxd",
    ".elpis-agent",  # socket de l'agent (agent_client.AGENT_RUN_DIR)
    ".write_locks",
    _PERMS_MARKER,
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


@dataclass(frozen=True)
class ResolvedPath:
    rel: str        # POSIX, relative to the sandbox root; "" == root
    host: Path      # absolute host path at/under the root
    container: str  # "/work" or "/work/<rel>"

    @property
    def is_root(self) -> bool:
        return self.rel == ""


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


def resolve_under(base, user_path, *, allow_root: bool = True) -> ResolvedPath:
    """Resolve ``user_path`` under sandbox root ``base`` and prove containment.

    Args:
        base:       the sandbox root (host path). Resolved with ``.resolve()``.
        user_path:  a model/route supplied path. May be relative, a
                    container-view path (``/work/...``), or (rejected unless
                    it lands back under ``base``) absolute.
        allow_root: if False, refuse a path that resolves to the root itself
                    (used by destructive ops that must target a child, e.g.
                    delete/rename).

    Returns:
        ResolvedPath(rel, host, container).

    Raises:
        SandboxPathError: empty (when a path is required), NUL byte, or any
        target that escapes ``base`` (``..``, outside-absolute, symlink-out),
        or the root when ``allow_root`` is False.
    """
    base_resolved = Path(base).resolve()

    raw = "" if user_path is None else str(user_path)
    if "\x00" in raw:
        raise SandboxPathError("null byte in path")

    rel_in = strip_work_prefix(raw)

    # Empty after normalization → the sandbox root.
    if rel_in.strip() in ("", "."):
        if not allow_root:
            raise SandboxPathError("operation requires a path inside the sandbox, not its root")
        return ResolvedPath(rel="", host=base_resolved, container=CONTAINER_ROOT)

    # AUDIT 2026-06 — ``~`` est mappé sur la RACINE SANDBOX, plus
    # d'expanduser() : avant, ``~/x`` se résolvait vers le HOME de l'hôte
    # puis était rejeté par le containment — pas un escape, mais une 403
    # surprenante alors que le modèle veut dire « mon home conteneur »
    # (la vue conteneur n'a qu'un home utile : /work). ``~autre`` (un
    # utilisateur nommé) reste littéral, comme n'importe quel nom de fichier.
    if rel_in == "~" or rel_in.startswith("~/"):
        rel_in = rel_in[1:].lstrip("/") or "."
    p = Path(rel_in)
    candidate = (base_resolved / p if not p.is_absolute() else p).resolve()

    # Containment via relative_to (NOT startswith): handles sibling-prefix
    # names (bob vs bob2) and, because we resolved both sides, rejects ``..``
    # escapes and symlinks whose target is outside the root.
    if candidate != base_resolved:
        try:
            candidate.relative_to(base_resolved)
        except ValueError:
            raise SandboxPathError(f"path escapes the sandbox root: {raw!r}")

    rel_out = "" if candidate == base_resolved else candidate.relative_to(base_resolved).as_posix()
    if rel_out == "" and not allow_root:
        raise SandboxPathError("operation requires a path inside the sandbox, not its root")

    return ResolvedPath(rel=rel_out, host=candidate, container=to_container(rel_out))


# ── Écriture SOUS la racine, sans jamais suivre de lien ─────────────────────
#
# AUDIT 2026-09-25 — ``resolve_under`` valide un chemin À UN INSTANT ; l'hôte
# écrivait ensuite par un ``open()`` ordinaire, qui suit les liens. Or le
# bac à sable est monté en écriture dans le conteneur : entre la validation et
# l'écriture, un lien symbolique peut apparaître à la place de la cible (ou
# d'un dossier du chemin) — posé par la commande shell dont on sauve la sortie,
# ou déjà présent sur un chemin DÉRIVÉ jamais validé (``x.bak``, ``dest/nom``).
# L'écriture partait alors hors du bac à sable, avec les droits de l'app.
#
# Ici, chaque composant est ouvert RELATIVEMENT au descripteur de son parent
# avec ``O_NOFOLLOW`` : aucun lien n'est traversé, à aucun niveau, quel que
# soit le moment où il apparaît. Le fichier est écrit dans un temporaire
# exclusif puis renommé dans le MÊME dossier ouvert : un lien posé à la place
# de la cible est remplacé, jamais suivi.

_O_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
_O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_O_DIRECTORY = getattr(os, "O_DIRECTORY", 0)
_O_PATH = getattr(os, "O_PATH", 0)


def _rel_parts(rel: Any) -> List[str]:
    """Composants d'un chemin RELATIF à la racine ; refuse l'absolu et ``..``.
    ``\\`` est un caractère de nom ordinaire (Linux) : le convertir en ``/``
    faisait viser à ces primitives une autre entrée que celle contrôlée par
    ``resolve_under`` (2026-09-29)."""
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


# ── Lecture SOUS la racine, sans jamais suivre de lien (2026-09-29) ─────────
#
# Même fenêtre qu'à l'écriture (cf. plus bas) : l'hôte validait un chemin puis
# le rouvrait par son nom ; un dossier du chemin remplacé par un lien entre les
# deux faisait lire, avec les droits de l'app, un fichier hors du bac à sable.
# Et un nœud de périphérique posé dans /work (quand le root du conteneur avait
# MKNOD) aurait été lu tel quel. Ici l'entrée est saisie par ``O_PATH | O_NOFOLLOW`` — ce qui
# n'ouvre rien —, son type est vérifié sur ce descripteur, puis elle est
# rouverte par ``/proc/self/fd`` : le même inode, quoi qu'il arrive au chemin.


def open_path_at(dir_fd: int, name: str) -> int:
    """Descripteur ``O_PATH`` de l'entrée ``name`` de ``dir_fd`` elle-même —
    un lien est saisi, jamais suivi — : de quoi ``fstat``, changer ses droits
    ou la rouvrir (:func:`reopen`) sans relire de chemin."""
    return os.open(name, _O_PATH | _O_NOFOLLOW | _O_CLOEXEC, dir_fd=dir_fd)


def reopen(pfd: int, flags: int = os.O_RDONLY) -> int:
    """Rouvre l'inode d'un descripteur ``O_PATH`` (``/proc/self/fd``)."""
    return os.open(f"/proc/self/fd/{pfd}", flags | _O_CLOEXEC)


def open_path_beneath(base: Any, rel: Any) -> int:
    """:func:`open_path_at` de ``base/rel`` (``rel`` vide : la racine),
    dossiers du chemin ouverts sans suivre de lien. L'appelant le ferme."""
    parts = _rel_parts(rel)
    if not parts:
        return open_dir_beneath(base)
    dfd = open_dir_beneath(base, "/".join(parts[:-1]))
    try:
        return open_path_at(dfd, parts[-1])
    finally:
        os.close(dfd)


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


def open_beneath(base: Any, rel: Any, *, allow_dir: bool = False) -> int:
    """Descripteur en lecture de ``base/rel`` : dossiers ouverts par
    :func:`open_dir_beneath`, feuille par :func:`open_leaf`. ``rel`` vide =
    la racine (dossier). L'appelant ferme le descripteur rendu."""
    parts = _rel_parts(rel)
    if not parts:
        if not allow_dir:
            raise IsADirectoryError(errno.EISDIR, "Is a directory", str(base))
        return open_dir_beneath(base, readable=True)
    dfd = open_dir_beneath(base, "/".join(parts[:-1]))
    try:
        return open_leaf(dfd, parts[-1], allow_dir=allow_dir)
    finally:
        os.close(dfd)


def stat_beneath(base: Any, rel: Any) -> os.stat_result:
    """``lstat`` de ``base/rel`` — un lien lui-même, jamais sa cible —,
    dossiers du chemin ouverts sans suivre de lien."""
    pfd = open_path_beneath(base, rel)
    try:
        return os.fstat(pfd)
    finally:
        os.close(pfd)


def chmod_beneath(base: Any, rel: Any, mode_fn) -> Tuple[int, int]:
    """Applique ``mode_fn(mode actuel)`` au fichier régulier ou au dossier
    ``base/rel`` (``rel`` vide : la racine) sans l'ouvrir en lecture ni
    suivre de lien. Rend ``(ancien mode, nouveau mode)`` ; un lien ou un
    fichier spécial lève :class:`SandboxPathError`."""
    pfd = open_path_beneath(base, rel)
    try:
        mode = os.fstat(pfd).st_mode
        if not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
            raise SandboxPathError(f"symlink or special file refused: {str(rel)!r}")
        new = mode_fn(mode)
        os.chmod(f"/proc/self/fd/{pfd}", new & 0o7777)
        return mode, new
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



def lexical_rel(base: Any, user_path: Any, *, allow_root: bool = True) -> str:
    """Chemin relatif à ``base`` d'un chemin fourni (modèle, route), SANS lire
    le disque : préfixe ``/work`` retiré, ``~`` = la racine, ``.`` et ``..``
    résolus sur le texte. Les liens, eux, sont résolus par l'agent de la
    sandbox, qui les garde sous ``/work`` (L4). Sortie de la racine, NUL, ou
    racine alors que ``allow_root`` est faux : :class:`SandboxPathError`."""
    raw = "" if user_path is None else str(user_path)
    if "\x00" in raw:
        raise SandboxPathError("null byte in path")
    s = strip_work_prefix(raw)
    if s == "~" or s.startswith("~/"):
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

@contextmanager
def pinned_beneath(base: Any, target: Any, *, allow_dir: bool = False) -> Iterator[Path]:
    """``/proc/self/fd/<n>`` de ``base/target`` ouvert par :func:`open_beneath` :
    un chemin que les fonctions ordinaires (``open``, ``Path.read_bytes``,
    ``stat``) acceptent et qui désigne CET inode, même si le chemin d'origine
    change ensuite. Pour un dossier, seul le dossier est figé : un parcours
    passe par :func:`walk_beneath`."""
    fd = open_beneath(base, rel_under(base, target), allow_dir=allow_dir)
    try:
        yield Path(f"/proc/self/fd/{fd}")
    finally:
        os.close(fd)


def leaf_mode(dir_fd: int, name: str) -> int:
    """``st_mode`` de l'entrée ``name`` de ``dir_fd``, lien non suivi ; ``0``
    si elle a disparu ou est inaccessible (entrée d'un parcours en cours)."""
    try:
        return os.stat(name, dir_fd=dir_fd, follow_symlinks=False).st_mode
    except OSError:
        return 0


def read_leaf(dir_fd: int, name: str, max_bytes: int) -> Optional[bytes]:
    """Contenu du fichier régulier ``name`` de ``dir_fd`` s'il fait au plus
    ``max_bytes`` octets ; ``None`` sinon (lien, fichier spécial, trop gros,
    disparu, illisible)."""
    try:
        fd = open_leaf(dir_fd, name)
    except (OSError, SandboxPathError):
        return None
    with os.fdopen(fd, "rb") as f:
        if os.fstat(f.fileno()).st_size > max_bytes:
            return None
        data = f.read(max_bytes + 1)
    return None if len(data) > max_bytes else data


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


# ── Élargissement des droits (invariant /work « cross-writable ») ──────────
#
# L'hôte et le conteneur (UID 10001) n'ont aucun groupe commun : ce que l'hôte
# écrit dans /work doit être 0666 / 0777 pour rester modifiable dans le
# conteneur. ``os.chmod`` suit les liens : un contrôle ``islink`` puis un
# ``chmod`` par chemin laissait le conteneur glisser un lien entre les deux et
# faire passer un fichier de l'hôte en 0666 (2026-09-29). Chaque entrée est
# donc saisie par ``O_PATH | O_NOFOLLOW`` puis modifiée par ``/proc/self/fd``.

def _widen_fd(pfd: int) -> bool:
    """Fichier régulier → 0666 (0777 s'il avait un bit x), dossier → 0777 ;
    setuid, setgid et sticky retirés ; lien ou fichier spécial : rien. Rend
    ``True`` pour un dossier."""
    st = os.fstat(pfd)
    if stat.S_ISDIR(st.st_mode):
        new = 0o777
    elif stat.S_ISREG(st.st_mode):
        new = 0o777 if st.st_mode & 0o111 else 0o666
    else:
        return False
    if stat.S_IMODE(st.st_mode) != new:
        try:
            os.chmod(f"/proc/self/fd/{pfd}", new)
        except OSError:
            pass            # entrée étrangère (EPERM) : les autres sont élargies quand même
    return stat.S_ISDIR(st.st_mode)


def _widen_entry(dir_fd: int, name: str) -> bool:
    pfd = open_path_at(dir_fd, name)
    try:
        return _widen_fd(pfd)
    finally:
        os.close(pfd)


def widen_beneath(base: Any, rel: Any = "", *, recursive: bool = False) -> None:
    """Élargit les droits de ``base/rel`` pour l'UID du conteneur — et de tout
    son contenu si ``recursive`` — sans jamais suivre de lien. Best-effort :
    une entrée absente, étrangère (EPERM) ou disparue est sautée."""
    parts = _rel_parts(rel)
    try:
        dfd = open_dir_beneath(base, "/".join(parts[:-1]) if parts else "")
        try:
            is_dir = _widen_entry(dfd, parts[-1]) if parts else _widen_fd(dfd)
        finally:
            os.close(dfd)
        if not (recursive and is_dir):
            return
        for _rel_dir, dirnames, filenames, wdfd in walk_beneath(base, "/".join(parts)):
            for name in dirnames + filenames:
                try:
                    _widen_entry(wdfd, name)
                except OSError:
                    continue
    except (OSError, SandboxPathError):
        return


# ── Suppression et renommage SOUS la racine (2026-09-29) ────────────────────
# Même fenêtre qu'à la lecture : ``unlink``/``rmtree``/``replace`` par chemin
# suivaient un dossier du chemin remplacé par un lien après validation, et
# supprimaient ou déplaçaient alors une entrée de l'hôte. Ici l'entrée est
# désignée RELATIVEMENT au descripteur de son dossier : un lien est supprimé
# ou déplacé lui-même, jamais sa cible.

def remove_beneath(base: Any, rel: Any, *, recursive: bool = False) -> None:
    """Supprime l'entrée ``base/rel`` : fichier ou lien (jamais sa cible), ou
    dossier si ``recursive`` (sinon ``IsADirectoryError``)."""
    parts = _rel_parts(rel)
    if not parts:
        raise SandboxPathError("refusing to remove the sandbox root")
    dfd = open_dir_beneath(base, "/".join(parts[:-1]))
    try:
        name = parts[-1]
        if stat.S_ISDIR(os.stat(name, dir_fd=dfd, follow_symlinks=False).st_mode):
            if not recursive:
                raise IsADirectoryError(errno.EISDIR, "Is a directory", str(rel))
            shutil.rmtree(name, dir_fd=dfd)
        else:
            os.unlink(name, dir_fd=dfd)
    finally:
        os.close(dfd)


def rename_beneath(base: Any, src_rel: Any, dst_rel: Any, *,
                   dir_mode: Optional[int] = None) -> None:
    """Renomme l'entrée ``src_rel`` en ``dst_rel`` (une entrée existante qui
    n'est pas un dossier est remplacée) ; dossier parent de destination créé
    au besoin (``dir_mode`` sur ceux qu'on crée)."""
    sp, dp = _rel_parts(src_rel), _rel_parts(dst_rel)
    if not sp or not dp:
        raise SandboxPathError("the sandbox root cannot be renamed or replaced")
    sfd = open_dir_beneath(base, "/".join(sp[:-1]))
    try:
        dfd = open_dir_beneath(base, "/".join(dp[:-1]), create=True, dir_mode=dir_mode)
        try:
            os.replace(sp[-1], dp[-1], src_dir_fd=sfd, dst_dir_fd=dfd)
        finally:
            os.close(dfd)
    finally:
        os.close(sfd)


def walk_under(base: Any, top: Any) -> Iterator[Tuple[str, List[str], List[str], int]]:
    """:func:`walk_beneath` du dossier ``top`` (relatif, ou chemin hôte déjà
    résolu sous ``base``), le chemin de chaque dossier rendu RELATIF à
    ``top`` (``""`` pour ``top`` lui-même)."""
    top_rel = rel_under(base, top)
    top_rel = "" if top_rel == "." else top_rel
    for cur, dirs, files, dfd in walk_beneath(base, top_rel):
        yield (cur[len(top_rel):].lstrip("/") if top_rel else cur), dirs, files, dfd


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


def copytree_beneath(src: Any, base: Any, dst_rel: Any, *,
                     file_mode_fn=None, dir_mode: Optional[int] = None) -> int:
    """Copie l'arbre ``src`` (chemin, ou descripteur de dossier déjà ouvert
    sans suivre de lien, cf. :func:`open_beneath`) vers ``base/dst_rel`` (qui
    ne doit pas exister)
    sans jamais suivre de lien CÔTÉ DESTINATION ; les liens de la source sont
    recopiés TELS QUELS (comme ``copytree(symlinks=True)``), jamais
    déréférencés. ``file_mode_fn(mode_source) -> mode`` : mode des fichiers
    copiés. Retourne le nombre de fichiers copiés.

    Passe sandbox 2026-09-26 :
      • SOURCE parcourue par descripteurs (``os.fwalk``) et fichiers ouverts
        en ``O_NOFOLLOW`` relatifs à leur dossier, inode contrôlé : un lien
        substitué entre le test et l'ouverture (process concurrent dans le
        conteneur) ne peut plus faire copier un fichier de l'HÔTE ;
      • copie dans un dossier temporaire voisin, RENOMMÉ à la fin : un échec
        en cours de route ne laisse plus d'arbre à moitié copié (qu'un nouvel
        essai refusait ensuite comme « destination existante ») ;
      • destination existante refusée D'EMBLÉE (``FileExistsError`` explicite,
        y compris un fichier à la place du dossier) ; erreurs de parcours
        remontées au lieu d'être avalées (sous-dossier illisible)."""
    own_fd = not isinstance(src, int)
    root_parts = _rel_parts(dst_rel)
    if not root_parts:
        raise SandboxPathError("a destination directory is required, not the root")
    parent_rel = "/".join(root_parts[:-1])
    name = root_parts[-1]
    pfd = open_dir_beneath(base, parent_rel, create=True, dir_mode=dir_mode)
    tmp = f".{_short_leaf(name)}.{secrets.token_hex(6)}.cptmp"
    tmp_rel = f"{parent_rel}/{tmp}" if parent_rel else tmp
    try:
        try:
            os.stat(name, dir_fd=pfd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise FileExistsError(errno.EEXIST, "destination already exists", str(dst_rel))
        os.mkdir(tmp, 0o777, dir_fd=pfd)
        n = 0
        try:
            if dir_mode is not None:
                _dfd = os.open(tmp, os.O_RDONLY | _O_DIRECTORY | _O_NOFOLLOW | _O_CLOEXEC,
                               dir_fd=pfd)
                try:
                    os.fchmod(_dfd, dir_mode)
                finally:
                    os.close(_dfd)
            walk_errors: List[OSError] = []
            sfd = (os.open(str(src), os.O_RDONLY | _O_DIRECTORY | _O_NOFOLLOW | _O_CLOEXEC)
                   if own_fd else src)
            try:
                for cur, dirs, files, sdfd in os.fwalk(".", dir_fd=sfd, follow_symlinks=False,
                                                       onerror=walk_errors.append):
                    rel_cur = "" if cur == "." else cur[2:]
                    dst_cur = tmp_rel if not rel_cur else f"{tmp_rel}/{rel_cur}"
                    for nm in list(dirs) + list(files):
                        try:
                            st = os.stat(nm, dir_fd=sdfd, follow_symlinks=False)
                        except FileNotFoundError:
                            continue                       # disparu entre-temps
                        if stat.S_ISLNK(st.st_mode):
                            dfd = open_dir_beneath(base, dst_cur, create=True, dir_mode=dir_mode)
                            try:
                                os.symlink(os.readlink(nm, dir_fd=sdfd), nm, dir_fd=dfd)
                            finally:
                                os.close(dfd)
                            if nm in dirs:
                                dirs.remove(nm)
                        elif stat.S_ISDIR(st.st_mode):
                            dfd = open_dir_beneath(base, f"{dst_cur}/{nm}", create=True,
                                                   dir_mode=dir_mode)
                            os.close(dfd)
                        elif stat.S_ISREG(st.st_mode):
                            try:
                                ffd = os.open(nm, os.O_RDONLY | _O_NOFOLLOW | _O_CLOEXEC,
                                              dir_fd=sdfd)
                            except OSError as e:
                                if e.errno == errno.ELOOP:
                                    continue               # devenu un lien : ignoré
                                raise
                            with os.fdopen(ffd, "rb") as fh:
                                fst = os.fstat(fh.fileno())
                                if (fst.st_ino, fst.st_dev) != (st.st_ino, st.st_dev) \
                                        or not stat.S_ISREG(fst.st_mode):
                                    continue               # substitué entre-temps
                                mode = (file_mode_fn(fst.st_mode & 0o777) if file_mode_fn
                                        else fst.st_mode & 0o777)
                                write_beneath(base, f"{dst_cur}/{nm}", fh, file_mode=mode,
                                              dir_mode=dir_mode, mtime_ns=fst.st_mtime_ns)
                            n += 1
            finally:
                if own_fd:
                    os.close(sfd)
            if walk_errors:
                raise walk_errors[0]
            os.rename(tmp, name, src_dir_fd=pfd, dst_dir_fd=pfd)
        except BaseException:
            shutil.rmtree(Path(base).resolve() / tmp_rel, ignore_errors=True)
            raise
    finally:
        os.close(pfd)
    return n


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
    "ResolvedPath",
    "SandboxPathError",
    "WORK_SUBDIR",
    "chmod_beneath",
    "copytree_beneath",
    "ensure_work_subdir",
    "leaf_mode",
    "open_beneath",
    "open_dir_beneath",
    "open_leaf",
    "open_path_at",
    "open_path_beneath",
    "pinned_beneath",
    "read_leaf",
    "rel_under",
    "remove_beneath",
    "rename_beneath",
    "reopen",
    "resolve_under",
    "stat_beneath",
    "strip_work_prefix",
    "to_container",
    "walk_beneath",
    "walk_under",
    "widen_beneath",
    "write_beneath",
]
