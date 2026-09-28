# SPDX-License-Identifier: MIT
"""llm_core/tools/_work_changes.py — fichiers modifiés par une COMMANDE
(shell, script de skill, action git) : relevé avant / après (2026-09-26).

Les outils d'écriture (write_file, edit_file…) savent quel fichier ils
touchent et gardent l'avant / l'après dans l'historique de session
(``shared_infra.sandbox.file_history``). Une commande, elle, peut modifier
n'importe quoi (``sed -i``, ``git checkout``, script Python…) : sans relevé,
ni l'historique ni le chat n'en voyaient rien, donc aucun diff.

Principe :
  * avant la commande : parcours borné de la sandbox (lstat seulement) ; le
    contenu des petits fichiers texte est gardé en mémoire, par compte, et
    relu SEULEMENT quand leur (mtime, taille, inode) a changé depuis le
    dernier relevé — la première commande paie la lecture, les suivantes
    presque rien ;
  * après : second parcours ; chaque fichier créé / modifié / supprimé est
    noté dans l'historique (``source="shell"``, avant = contenu gardé, sinon
    ``UNKNOWN``) et décrit dans ``files_changed`` pour le chat.

Bornes : dossiers lourds ou internes ignorés (``.git``, ``node_modules``,
environnements virtuels, caches, sorties d'outils), 20 000 entrées et 1,5 s
par parcours (au-delà : ``complete=False``, rien n'est déduit pour les
fichiers non vus), 512 Kio par fichier gardé, 24 Mio par compte et 96 Mio
pour le process. Ne lève jamais : un relevé raté ne doit pas faire échouer
la commande.
"""
from __future__ import annotations

import os
import stat as _stat
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

SKIP_DIRS = frozenset({
    ".git", ".hg", ".svn", "node_modules", ".venv", "venv", "env", "__pycache__",
    ".mypy_cache", ".pytest_cache", ".ruff_cache", ".tox", ".cache", ".npm",
    ".yarn", ".gradle", ".m2", "target", "dist", "build", ".next", ".nuxt",
    ".tool-output", ".bg", ".trash", ".Trash",
})
MAX_ENTRIES = 20_000
SCAN_BUDGET_S = 1.5
KEEP_FILE_MAX = 512 * 1024
USER_CAP = 24 * 1024 * 1024
PROCESS_CAP = 96 * 1024 * 1024
MAX_RECORDED = 200           # fichiers notés dans l'historique par commande
MAX_REPORTED = 50            # entrées ``files_changed`` renvoyées

StatKey = Tuple[int, int, int]          # (mtime_ns, size, inode)


class _UserCache:
    __slots__ = ("files", "bytes", "lock")

    def __init__(self):
        self.files: Dict[str, Tuple[StatKey, bytes]] = {}
        self.bytes = 0
        self.lock = threading.Lock()


_CACHES: "OrderedDict[str, _UserCache]" = OrderedDict()
_CACHES_LOCK = threading.Lock()


def _cache_for(key: str) -> _UserCache:
    with _CACHES_LOCK:
        c = _CACHES.get(key)
        if c is None:
            c = _CACHES[key] = _UserCache()
        _CACHES.move_to_end(key)
        # Plafond du process : les comptes les moins récents sont oubliés.
        while len(_CACHES) > 1 and sum(x.bytes for x in _CACHES.values()) > PROCESS_CAP:
            _CACHES.popitem(last=False)
        return c


def _scan(root: Path) -> Tuple[Dict[str, StatKey], bool]:
    """{chemin relatif POSIX: clé de stat} des fichiers réguliers ; bool =
    parcours complet."""
    out: Dict[str, StatKey] = {}
    deadline = time.monotonic() + SCAN_BUDGET_S
    stack = [("", str(root))]
    n = 0
    while stack:
        rel_dir, abs_dir = stack.pop()
        try:
            it = os.scandir(abs_dir)
        except OSError:
            continue
        with it:
            for e in it:
                n += 1
                if n > MAX_ENTRIES or (n & 255) == 0 and time.monotonic() > deadline:
                    return out, False
                try:
                    st = e.stat(follow_symlinks=False)
                except OSError:
                    continue
                rel = f"{rel_dir}/{e.name}" if rel_dir else e.name
                if _stat.S_ISDIR(st.st_mode):
                    if e.name not in SKIP_DIRS:
                        stack.append((rel, e.path))
                elif _stat.S_ISREG(st.st_mode):
                    out[rel] = (st.st_mtime_ns, st.st_size, st.st_ino)
    return out, True


def _looks_text(data: bytes) -> bool:
    return b"\x00" not in data[:8192]


def _open_dir_beneath(root: Path, rel_dir: str) -> Optional[int]:
    """Descripteur de ``root/rel_dir`` ouvert composant par composant, sans
    suivre de lien (``None`` si un composant manque, est un lien ou n'est pas
    un dossier)."""
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_CLOEXEC", 0)
    try:
        fd = os.open(str(Path(root).resolve()), flags)
    except OSError:
        return None
    for name in [x for x in rel_dir.split("/") if x]:
        if name in (".", ".."):
            os.close(fd)
            return None
        try:
            nfd = os.open(name, flags | os.O_NOFOLLOW, dir_fd=fd)
        except OSError:
            os.close(fd)
            return None
        os.close(fd)
        fd = nfd
    return fd


def _read(root: Path, rel: str, limit: int) -> Optional[bytes]:
    """Octets de ``root/rel`` (``None`` : absent, illisible ou > ``limit``).

    Ouvert SOUS la racine, composant par composant, sans suivre aucun lien :
    le conteneur peut remplacer un dossier par un lien entre le parcours et
    la lecture, et ce contenu finit dans l'historique (lisible du compte)."""
    parent, _, leaf = rel.rpartition("/")
    dfd = _open_dir_beneath(root, parent)
    if dfd is None:
        return None
    try:
        fd = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0), dir_fd=dfd)
    except OSError:
        return None
    finally:
        os.close(dfd)
    try:
        if not _stat.S_ISREG(os.fstat(fd).st_mode):
            return None
        with os.fdopen(fd, "rb") as f:
            fd = -1
            data = f.read(limit + 1)
    except OSError:
        return None
    finally:
        if fd >= 0:
            os.close(fd)
    return data if len(data) <= limit else None


def _refresh(cache: _UserCache, root: Path, seen: Dict[str, StatKey]) -> None:
    """Relit les petits fichiers texte dont la clé de stat a changé, oublie
    les disparus. Borné par ``USER_CAP``."""
    with cache.lock:
        for rel in [r for r in cache.files if r not in seen]:
            cache.bytes -= len(cache.files.pop(rel)[1])
        for rel, key in seen.items():
            hit = cache.files.get(rel)
            if hit is not None and hit[0] == key:
                continue
            if hit is not None:
                cache.bytes -= len(cache.files.pop(rel)[1])
            if key[1] > KEEP_FILE_MAX or cache.bytes + key[1] > USER_CAP:
                continue
            data = _read(root, rel, KEEP_FILE_MAX)
            if data is None or not _looks_text(data):
                continue
            cache.files[rel] = (key, data)
            cache.bytes += len(data)


def _known(data) -> bool:
    """Contenu réellement lu (ni absent, ni trop gros, ni inconnu)."""
    from shared_infra.sandbox import file_history as fh
    return isinstance(data, bytes) and not isinstance(data, (type(fh.TOO_BIG), type(fh.UNKNOWN)))


def _line_stats(before: bytes, after: bytes) -> Optional[Tuple[int, int]]:
    try:
        a = before.decode("utf-8")
        b = after.decode("utf-8")
    except UnicodeDecodeError:
        return None
    if len(a) + len(b) > 4 * 1024 * 1024:
        return None
    import difflib
    add = rem = 0
    for line in difflib.unified_diff(a.splitlines(), b.splitlines(), n=0):
        if line.startswith("+") and not line.startswith("+++"):
            add += 1
        elif line.startswith("-") and not line.startswith("---"):
            rem += 1
    return add, rem


class WorkChanges:
    """``with WorkChanges(uid, username, root, "shell") as wc: …`` puis
    ``wc.changes`` (liste pour ``files_changed``) et ``wc.total``."""

    def __init__(self, uid: Optional[int], cache_key: str, root: Path,
                 source: str = "shell", container_prefix: str = "/work"):
        self.uid = uid
        self.root = Path(root)
        self.source = source
        self.prefix = container_prefix.rstrip("/")
        self.cache = _cache_for(f"{cache_key}:{self.root}")
        self.before: Dict[str, StatKey] = {}
        self.complete = False
        self.changes: List[Dict[str, Any]] = []
        self.total = 0

    def __enter__(self):
        try:
            self.before, self.complete = _scan(self.root)
            _refresh(self.cache, self.root, self.before)
        except Exception:                                       # noqa: BLE001
            self.before, self.complete = {}, False
        return self

    def __exit__(self, *exc):
        try:
            self._collect()
        except Exception:                                       # noqa: BLE001
            pass
        return False

    def _collect(self) -> None:
        if not self.before and not self.complete:
            return
        after, complete = _scan(self.root)
        changed: List[Tuple[str, str]] = []
        for rel, key in after.items():
            old = self.before.get(rel)
            if old is None:
                # Non vu avant : créé… seulement si le premier parcours était
                # complet (sinon il a pu simplement être hors du budget).
                if self.complete:
                    changed.append((rel, "created"))
            elif old != key:
                changed.append((rel, "modified"))
        if complete and self.complete:
            changed.extend((rel, "deleted") for rel in self.before if rel not in after)
        self.total = len(changed)
        if not changed:
            _refresh(self.cache, self.root, after)
            return
        from shared_infra.sandbox import file_history as fh
        if self.uid is not None:
            try:
                fh.current_session(self.uid)
            except Exception:                                   # noqa: BLE001
                pass
        changed.sort()
        with self.cache.lock:
            kept = {rel: v for rel, v in self.cache.files.items()}
        for i, (rel, kind) in enumerate(changed):
            if i >= MAX_RECORDED:
                break
            old_key = self.before.get(rel)
            hit = kept.get(rel)
            if kind == "created":
                before = None
            elif hit is not None and hit[0] == old_key:
                before = hit[1]
            else:
                before = fh.UNKNOWN
            after_b: Optional[bytes] = None
            if kind != "deleted":
                size = after.get(rel, (0, 0, 0))[1]
                after_b = fh.TOO_BIG if size > fh.MAX_FILE else _read(self.root, rel, fh.MAX_FILE)
                if after_b is None:
                    continue                                    # disparu ou illisible
            if _known(before) and _known(after_b) and before == after_b:
                continue                                        # touché, contenu identique
            if self.uid is not None:
                fh.record_write(self.uid, rel, before, after_b, self.source)
            if len(self.changes) < MAX_REPORTED:
                ent: Dict[str, Any] = {"path": f"{self.prefix}/{rel}", "change": kind,
                                       "old_sha256": fh.sha_of(before),
                                       "new_sha256": fh.sha_of(after_b)}
                if (before is None or _known(before)) and _known(after_b):
                    st = _line_stats(before or b"", after_b)
                    if st is not None:
                        ent["lines_added"], ent["lines_removed"] = st
                self.changes.append(ent)
        _refresh(self.cache, self.root, after)

    def attach(self, result: Dict[str, Any]) -> Dict[str, Any]:
        """Ajoute ``files_changed`` (et le total si tronqué) à un résultat."""
        if self.changes and isinstance(result, dict):
            result["files_changed"] = self.changes
            if self.total > len(self.changes):
                result["files_changed_total"] = self.total
        return result


__all__ = ["WorkChanges", "SKIP_DIRS", "uid_for", "attach_any", "tracked"]


def uid_for(username: str) -> Optional[int]:
    """id du compte, ``None`` si inconnu (même cache que les outils fichiers)."""
    try:
        from llm_core.tools.fs_tools import _history_uid
        return _history_uid(username)
    except Exception:                                           # noqa: BLE001
        return None


def attach_any(wc: "WorkChanges", res: Any) -> Any:
    """``files_changed`` ajouté à un résultat dict OU modèle pydantic (extras
    permis) ; tout autre résultat est rendu tel quel."""
    if not wc.changes:
        return res
    if isinstance(res, dict):
        return wc.attach(res)
    try:
        setattr(res, "files_changed", wc.changes)
        if wc.total > len(wc.changes):
            setattr(res, "files_changed_total", wc.total)
    except Exception:                                           # noqa: BLE001
        pass
    return res


def tracked(source: str, root_for):
    """Décorateur d'outil SYNCHRONE : ``root_for(bound_args) -> (uid, clé,
    racine) | None`` choisit s'il faut relever et où. Placé SOUS
    ``@mcp.tool`` ; ``functools.wraps`` garde la signature (FastMCP lit
    ``__wrapped__``)."""
    import functools
    import inspect

    def deco(fn):
        sig = inspect.signature(fn)

        @functools.wraps(fn)
        def wrapper(*a, **kw):
            spec = None
            try:
                ba = sig.bind_partial(*a, **kw)
                ba.apply_defaults()
                spec = root_for(ba.arguments)
            except Exception:                                   # noqa: BLE001
                spec = None
            if not spec:
                return fn(*a, **kw)
            uid, key, root = spec
            wc = WorkChanges(uid, key, root, source)
            wc.__enter__()
            try:
                res = fn(*a, **kw)
            finally:
                wc.__exit__(None, None, None)
            return attach_any(wc, res)
        return wrapper
    return deco
