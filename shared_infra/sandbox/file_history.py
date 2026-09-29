# SPDX-License-Identifier: MIT
"""
shared_infra/sandbox/file_history.py — historique des fichiers modifiés
pendant une SESSION de travail (2026-09-23).

Besoin : quand l'éditeur, l'assistant (``write_file``/``edit_file``), le
remplacement multi-fichiers ou un import réécrivent un fichier plusieurs fois
dans la session, rien ne doit se perdre : on garde l'ORIGINAL (l'état avant la
première modification de la session) et CHAQUE version écrite ensuite, pour
comparer à l'original ou restaurer n'importe quelle étape.

Session : ouverte à chaque connexion (``start_session`` depuis le login),
sinon créée au premier besoin. Les écritures de l'assistant (process MCP)
tombent dans la session courante du compte. Les 3 dernières sessions sont
gardées, dans la limite de ``_USER_CAP`` octets par compte.

Stockage (hors sandbox, jamais visible du conteneur) :
    user_db/file_history/<uid>/session.json            {"id", "started"}
    user_db/file_history/<uid>/<session>/index.json    {chemin: entrée}
    user_db/file_history/<uid>/<session>/blobs/<sha>   contenu zlib, dédoublonné
Entrée : ``{"original": {"exists", "sha", "size"}, "versions": [{"sha",
"size", "ts", "source"}], "created": ts}``. ``sha`` = sha256 des octets
(``None`` = fichier absent / supprimé ; ``too_big`` = trop gros pour être gardé).

Tout échec est avalé et journalisé : l'historique ne doit JAMAIS empêcher une
écriture.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import os
import shutil
import time
import zlib
from pathlib import Path, PurePosixPath
from typing import Any, Dict, List, Optional

logger = logging.getLogger("uvicorn.error")

MAX_FILE = 5 * 1024 * 1024          # au-delà : version notée, contenu non gardé
MAX_VERSIONS = 100                  # par fichier et par session (l'original reste)
_KEEP_SESSIONS = 3
_USER_CAP = 300 * 1024 * 1024

SOURCES = ("editor", "assistant", "replace", "upload", "restore", "git", "shell", "other")


# ── Emplacements ─────────────────────────────────────────────────────────────
def _root() -> Path:
    env = os.environ.get("APP_FILE_HISTORY_DIR")
    if env:
        return Path(env)
    from shared_infra.config import PROJECT_ROOT
    return Path(PROJECT_ROOT) / "user_db" / "file_history"


def _user_dir(uid: int) -> Path:
    return _root() / str(int(uid))


def norm_rel(rel: str) -> str:
    """Clé canonique d'un chemin de sandbox : POSIX, sans ``/``, ``./``,
    ``work/`` ni ``..`` (refusé). ``\\`` reste un caractère de nom, comme
    pour les primitives de ``paths`` : ``a\\b`` n'est pas ``a/b``."""
    s = str(rel or "").strip()
    while s.startswith("/"):
        s = s[1:]
    parts = [p for p in PurePosixPath(s).parts if p not in ("", ".")]
    if parts and parts[0] == "work":
        parts = parts[1:]
    if not parts or ".." in parts:
        return ""
    return "/".join(parts)


@contextlib.contextmanager
def _user_lock(uid: int):
    d = _user_dir(uid)
    d.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(d / ".lock"), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        import fcntl
        deadline = time.monotonic() + 5.0
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    break                          # fail-open
                time.sleep(0.02)
        yield
    finally:
        os.close(fd)


def _read_json(p: Path, default):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _write_json(p: Path, data) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(f"{p.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, p)


# ── Sessions ─────────────────────────────────────────────────────────────────
def _new_session_id() -> str:
    return time.strftime("%Y%m%d-%H%M%S") + "-" + os.urandom(3).hex()


def _start_unlocked(uid: int) -> str:
    sid = _new_session_id()
    _write_json(_user_dir(uid) / "session.json", {"id": sid, "started": time.time()})
    _prune(uid, keep=sid)
    return sid


def _current_unlocked(uid: int) -> str:
    """Session courante, créée au besoin — À APPELER VERROU TENU (le flock
    n'est pas réentrant : le reprendre depuis un autre descripteur attendait
    tout le délai)."""
    cur = _read_json(_user_dir(uid) / "session.json", {})
    sid = cur.get("id") if isinstance(cur, dict) else None
    return sid if isinstance(sid, str) and sid else _start_unlocked(uid)


def start_session(uid: int) -> str:
    """Nouvelle session (appelée au login). Élague les anciennes."""
    try:
        with _user_lock(uid):
            return _start_unlocked(uid)
    except Exception:                                           # noqa: BLE001
        logger.exception("[file_history] start_session uid=%s", uid)
        return _new_session_id()


def current_session(uid: int) -> str:
    cur = _read_json(_user_dir(uid) / "session.json", {})
    sid = cur.get("id") if isinstance(cur, dict) else None
    if isinstance(sid, str) and sid:
        return sid
    with _user_lock(uid):
        return _current_unlocked(uid)


def _session_dir(uid: int, sid: str) -> Path:
    return _user_dir(uid) / sid


def _sessions(uid: int) -> List[str]:
    d = _user_dir(uid)
    try:
        return sorted(p.name for p in d.iterdir() if p.is_dir())
    except OSError:
        return []


def _dir_size(p: Path) -> int:
    total = 0
    for root, _, files in os.walk(p):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


def _prune(uid: int, keep: str) -> None:
    olds = [s for s in _sessions(uid) if s != keep]
    for s in olds[:max(0, len(olds) - (_KEEP_SESSIONS - 1))]:
        shutil.rmtree(_session_dir(uid, s), ignore_errors=True)
    # Plafond disque : on retire les plus anciennes (jamais la courante).
    olds = [s for s in _sessions(uid) if s != keep]
    while olds and _dir_size(_user_dir(uid)) > _USER_CAP:
        shutil.rmtree(_session_dir(uid, olds.pop(0)), ignore_errors=True)


# ── Contenus ─────────────────────────────────────────────────────────────────
def _store_blob(sdir: Path, data: bytes) -> str:
    sha = hashlib.sha256(data).hexdigest()
    p = sdir / "blobs" / sha
    if not p.exists():
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(f"{sha}.{os.getpid()}.tmp")
        tmp.write_bytes(zlib.compress(data, 6))
        os.replace(tmp, p)
    return sha


def get_blob(uid: int, sha: str) -> Optional[bytes]:
    if not isinstance(sha, str) or len(sha) != 64 or not all(c in "0123456789abcdef" for c in sha):
        return None
    for s in reversed(_sessions(uid)):
        p = _session_dir(uid, s) / "blobs" / sha
        if p.is_file():
            try:
                return zlib.decompress(p.read_bytes())
            except (OSError, zlib.error):
                return None
    return None


def read_before(root, path) -> Optional[bytes]:
    """Contenu actuel de ``path`` (relatif à la zone de travail ``root``, ou
    chemin hôte déjà résolu dessous), à lire AVANT de l'écrire : octets,
    ``None`` s'il n'existe pas ou n'est pas un fichier régulier, ``TOO_BIG``
    au-delà de ``MAX_FILE``. Lu sans suivre de lien (2026-09-29) : sinon un
    lien posé depuis le conteneur ferait entrer un fichier de l'hôte dans
    l'historique, que l'utilisateur peut relire."""
    from shared_infra.sandbox.paths import SandboxPathError, open_beneath, rel_under
    try:
        with os.fdopen(open_beneath(root, rel_under(root, path)), "rb") as f:
            if os.fstat(f.fileno()).st_size > MAX_FILE:
                return TOO_BIG
            return f.read()
    except (OSError, SandboxPathError):
        return None


class _TooBig(bytes):
    """Marqueur : fichier existant mais trop gros pour être gardé."""


TOO_BIG = _TooBig(b"")


class _Unknown(bytes):
    """Marqueur : fichier existant dont le contenu d'avant n'a pas pu être lu
    (modifié par une commande, contenu non relevé au préalable)."""


UNKNOWN = _Unknown(b"")


def sha_of(data: Optional[bytes]) -> Optional[str]:
    """Clé de blob d'un contenu (``None`` : absent, trop gros ou inconnu)."""
    if data is None or isinstance(data, (_TooBig, _Unknown)) or len(data) > MAX_FILE:
        return None
    return hashlib.sha256(data).hexdigest()


def _snap(sdir: Path, data: Optional[bytes]) -> Dict[str, Any]:
    if data is None:
        return {"exists": False, "sha": None, "size": 0}
    if isinstance(data, _Unknown):
        return {"exists": True, "sha": None, "size": -1, "unknown": True}
    if isinstance(data, _TooBig) or len(data) > MAX_FILE:
        return {"exists": True, "sha": None, "size": -1, "too_big": True}
    return {"exists": True, "sha": _store_blob(sdir, data), "size": len(data)}


# ── Écriture de l'historique ────────────────────────────────────────────────
def record_write(uid: int, rel: str, before: Optional[bytes], after: Optional[bytes],
                 source: str = "other") -> None:
    """Note une écriture : ``before`` = contenu juste avant (sert d'original à
    la première écriture de la session), ``after`` = contenu écrit (``None``
    = suppression). Ne lève jamais."""
    try:
        key = norm_rel(rel)
        if not key or uid is None:
            return
        src = source if source in SOURCES else "other"
        with _user_lock(uid):
            sid = _current_unlocked(uid)
            sdir = _session_dir(uid, sid)
            idx_p = sdir / "index.json"
            idx = _read_json(idx_p, {})
            ent = idx.get(key)
            if ent is None:
                ent = {"original": _snap(sdir, before), "versions": [], "created": time.time()}
            else:
                # Le fichier a changé HORS de l'historique depuis la dernière
                # version (commande, programme, autre process) : cet état
                # intermédiaire est gardé comme version « other ». Sans lui, le
                # diff de CETTE écriture (avant → après) n'avait pas de blob
                # « avant » à relire.
                prev = ent["versions"][-1] if ent["versions"] else ent.get("original") or {}
                bsnap = _snap(sdir, before)
                if (bsnap.get("sha") is not None and bsnap["sha"] != prev.get("sha")) or \
                        (before is None and prev.get("exists")):
                    bsnap.update(ts=time.time(), source="other")
                    ent["versions"].append(bsnap)
            ver = _snap(sdir, after)
            last = ent["versions"][-1] if ent["versions"] else None
            same_as_last = last is not None and last.get("sha") == ver["sha"] and ver["sha"] is not None
            if not same_as_last:
                ver.update(ts=time.time(), source=src)
                ent["versions"].append(ver)
                if len(ent["versions"]) > MAX_VERSIONS:
                    # On garde la première et les plus récentes.
                    ent["versions"] = ent["versions"][:1] + ent["versions"][-(MAX_VERSIONS - 1):]
            idx[key] = ent
            _write_json(idx_p, idx)
    except Exception:                                           # noqa: BLE001
        logger.exception("[file_history] record_write uid=%s path=%s", uid, rel)


def record_move(uid: int, old_rel: str, new_rel: str) -> None:
    """Un fichier renommé garde son historique sous son nouveau nom."""
    try:
        a, b = norm_rel(old_rel), norm_rel(new_rel)
        if not a or not b or a == b:
            return
        with _user_lock(uid):
            sdir = _session_dir(uid, _current_unlocked(uid))
            idx_p = sdir / "index.json"
            idx = _read_json(idx_p, {})
            moved = False
            for k in list(idx):
                if k == a or k.startswith(a + "/"):
                    nk = b + k[len(a):]
                    if nk not in idx:
                        idx[nk] = idx.pop(k)
                        idx[nk]["moved_from"] = k
                        moved = True
            if moved:
                _write_json(idx_p, idx)
    except Exception:                                           # noqa: BLE001
        logger.exception("[file_history] record_move uid=%s", uid)


# ── Lecture ─────────────────────────────────────────────────────────────────
def session_info(uid: int) -> Dict[str, Any]:
    sid = current_session(uid)
    meta = _read_json(_user_dir(uid) / "session.json", {})
    idx = _read_json(_session_dir(uid, sid) / "index.json", {})
    files = []
    for k, e in idx.items():
        vs = e.get("versions") or []
        last = vs[-1] if vs else {}
        files.append({"path": k, "versions": len(vs),
                      "original_exists": bool((e.get("original") or {}).get("exists")),
                      "deleted": bool(last) and not last.get("exists", True),
                      "last_ts": last.get("ts"), "last_source": last.get("source")})
    files.sort(key=lambda f: -(f["last_ts"] or 0))
    return {"session": sid, "started": meta.get("started"), "files": files}


def file_entry(uid: int, rel: str) -> Optional[Dict[str, Any]]:
    key = norm_rel(rel)
    if not key:
        return None
    idx = _read_json(_session_dir(uid, current_session(uid)) / "index.json", {})
    e = idx.get(key)
    return dict(e, path=key) if e else None


__all__ = ["MAX_FILE", "SOURCES", "TOO_BIG", "UNKNOWN", "sha_of", "start_session", "current_session", "norm_rel",
           "read_before", "record_write", "record_move",
           "session_info", "file_entry", "get_blob"]
