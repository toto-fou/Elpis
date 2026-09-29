# SPDX-License-Identifier: MIT
"""
backend.routes._helpers — Cross-cutting helpers shared by every route module.

Why this exists
---------------
The old monolithic ``_legacy.py`` mixed routes and helpers. After the
incremental extraction, the routes are gone but ~25 helper functions
remained behind. They are now imported directly from this module by every
new route module, and from ``backend/routes/admin.py``. The legacy module
``backend/routes/_legacy.py`` re-exports them for any straggler caller.

This file groups the genuinely small, pure helpers (auth gates, JSON file
I/O, sandbox path resolution, git subprocess wrappers, password policy,
backup-zip builder). They have no module-level state and are cheap to
import.

Things that DO carry state stay in their own modules:
  - ``_events_bus.py`` — SystemEvents/PipelineEvents instances + cron loop +
    model poller + their backing maps and locks
  - ``_pty.py``        — PTY map + global lock + session-row helpers + the
    long ``_terminal_ws_loop``

Public re-export contract
-------------------------
``backend.routes._legacy`` re-imports every name defined here so the
historical import surface (``from backend.routes._legacy import _no_cache``,
etc.) keeps working unchanged. Callers that still go through the package
façade (``from backend.routes import _no_cache``) keep working too because
the auto-export loop in ``__init__.py`` walks every submodule.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import HTTPException, Request

from shared_infra.config import (
    CONFIG_JSON_PATH,
    PROJECT_ROOT,
    SANDBOX_DIR,
    config_view,
)
from shared_infra.accounts.users import get_user_by_id, get_username_by_id
from shared_infra.security.deps import require_user_id
from shared_infra.sandbox.git_env import host_git_env, repo_refusal, run_host_git, unsafe_git_dir
from shared_infra.sandbox.paths import open_dir_beneath, rel_under

logger = logging.getLogger("uvicorn.error")


# ─────────────────────────────────────────────────────────────────────────────
#  ROLE / AUTH GATES
# ─────────────────────────────────────────────────────────────────────────────
# is_admin values: 0=user, 1=admin, 2=moderator
ROLE_LABELS = {0: "user", 1: "admin", 2: "moderator"}


def _require_admin(request) -> int:
    """Require full admin (is_admin=1). Returns user_id."""
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    if not me or me["is_admin"] != 1:
        raise HTTPException(403, "Admin required")
    return uid


def _require_staff(request) -> int:
    """Require admin or moderator (is_admin in 1,2). Returns user_id."""
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    if not me or me["is_admin"] not in (1, 2):
        raise HTTPException(403, "Staff required")
    return uid


def _get_session_cfg() -> dict:
    """
    Return the merged ``security.session`` block from config.json with
    safe defaults. Read on every call so a hot reconfigure via the admin
    Sauvegarder button takes effect immediately.

    Kept for backward compat: a few legacy callers import this directly.
    The validity checks themselves now live in backend.deps so they're
    shared with require_user_id (the universal auth dep).
    """
    try:
        sec = (config_view() or {}).get("security") or {}
        sess = sec.get("session") or {}
    except Exception:
        sess = {}
    return {
        "max_age_sec":      int(sess.get("max_age_sec",      86400)),
        "idle_timeout_sec": int(sess.get("idle_timeout_sec", 0)),
        "global_min_ts":    float(sess.get("global_min_ts",  0.0)),
    }


def _session_uid_any(request: Request):
    """
    Resolve the authenticated user-id stored in the session cookie, OR
    return None when the session is invalid/expired/revoked.

    Thin wrapper around backend.deps._session_validity_checks — keeps
    a single source of truth for the revocation logic. Historically
    this function had the checks inline, but require_user_id (a
    different code path used by 204 endpoints) didn't, which let
    revoked sessions keep posting. The shared helper in deps.py
    closes that gap.

    Returns the int uid on success, or None on any failure. Does NOT
    raise — callers branch on the None.
    """
    from shared_infra.security.deps import _session_validity_checks  # local import: avoids cycles

    # Resolve uid from the legacy session keys.
    uid: Optional[int] = None
    for key in ("user_id", "uid", "user"):
        v = request.session.get(key)
        if v is None:
            continue
        try:
            uid = int(v)
            break
        except Exception:
            return None
    if uid is None:
        return None

    if not _session_validity_checks(request, uid):
        return None

    # AUDIT 2026-08-02 (F1) — partager la gate ``must_change_pwd`` avec
    # ``require_user_id`` : sans elle, un compte en mot de passe temporaire
    # pouvait MUTER via les endpoints résolus par ce helper (ex. PUT /api/config).
    # Bornée aux méthodes mutantes et aux chemins hors whitelist, pour ne pas
    # bloquer les GET dont l'écran de changement de mot de passe a besoin.
    if request.method in ("POST", "PUT", "PATCH", "DELETE"):
        try:
            from shared_infra.accounts.users import get_user_by_id as _gub
            from shared_infra.security.deps import _MUST_CHANGE_PWD_ALLOWED_PATHS
            _row = _gub(uid)
            if (_row and bool(_row["must_change_pwd"])
                    and request.url.path not in _MUST_CHANGE_PWD_ALLOWED_PATHS):
                return None
        except Exception:
            pass  # fail-open : ne jamais bloquer un user normal sur un hoquet DB
    return uid


# ─────────────────────────────────────────────────────────────────────────────
#  HTTP HELPERS
# ─────────────────────────────────────────────────────────────────────────────
def _no_cache(response):
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


def _ndjson_line(obj: Dict[str, Any]) -> bytes:
    # default=str : un champ non-sérialisable (objet, bytes, datetime, Path,
    # set, Exception…) glissé dans un event NDJSON ne doit JAMAIS lever de
    # TypeError ici. Sinon, dans le générateur d'une StreamingResponse derrière
    # un BaseHTTPMiddleware, l'exception remonte et crashe l'ASGI en
    # « Response content shorter than Content-Length » (en masquant l'erreur
    # réelle). On dégrade le champ fautif en repr plutôt que de tout casser.
    return (json.dumps(obj, ensure_ascii=False, default=str) + "\n").encode("utf-8")


async def _shutdown_stream_worker(
    task: "asyncio.Task",
    get_task: "Optional[asyncio.Future]" = None,
    timeout: float = 5.0,
    label: str = "stream",
) -> None:
    """
    Cleanup safe pour les workers de streaming SSE/NDJSON.

    Garantit que :
    1. La tâche `get_task` (await q.get()) est annulée → pas d'orphan task
       warning, pas de coroutine en attente sur une queue morte.
    2. La tâche `task` (worker) reçoit le signal cancel ET a le temps
       de dérouler ses `finally` / `__aexit__` → le slot LLM_SEMAPHORE
       est correctement libéré (slot conv + slot modèle) avant que la
       fonction ne retourne.

    Sans ce helper, `task.cancel()` schedule juste le CancelledError mais
    ne garantit pas que le `__aexit__` du context manager LLM s'exécute
    AVANT que le générateur `gen()` ne retourne. Résultat : un slot LLM
    pouvait rester compté comme occupé pendant plusieurs ms à plusieurs
    secondes après une déconnexion client.

    En cas de double-cancel (ex: gunicorn worker timeout pendant le
    cleanup), on n'aggrave pas la situation : asyncio.wait ne propage
    pas les exceptions de la tâche surveillée.

    Args:
        task: Le worker principal (à attendre absolument).
        get_task: La tâche secondaire q.get() (annulation suffit).
        timeout: Délai max d'attente du cleanup du worker (défaut 5s).
        label: Étiquette pour les logs en cas de timeout.
    """
    # 1. Annuler le get_task — pas besoin d'attendre, c'est juste un q.get()
    if get_task is not None and not get_task.done():
        get_task.cancel()
        try:
            # Best-effort : laisser la cancel se propager rapidement
            await asyncio.wait({get_task}, timeout=0.1)
        except Exception:
            pass

    # 2. Annuler le worker s'il tourne encore
    if not task.done():
        task.cancel()

    # 3. ATTENDRE que le worker termine son unwinding (finally/__aexit__)
    #    pour garantir la libération du slot LLM. asyncio.wait ne lève
    #    pas TimeoutError ; il retourne juste un set vide pour `done`
    #    si le timeout expire — exactement ce qu'on veut ici.
    # BUG FIX — on honore le paramètre `timeout` au lieu de 15.0 en dur.
    if not task.done():
        await asyncio.wait({task}, timeout=timeout)
        if not task.done():
            logger.warning(
                "[%s_shutdown] Worker n'a pas terminé son cleanup en %ss — "
                "le slot LLM peut rester occupé temporairement",
                label, timeout,
            )

    # 4. Récupérer une éventuelle exception du worker pour ne pas
    #    laisser de "Task exception was never retrieved" dans les logs
    if task.done() and not task.cancelled():
        try:
            task.exception()
        except (asyncio.CancelledError, asyncio.InvalidStateError):
            pass


def _msg_text(content_field) -> str:
    """Normalize a message content field to plain text.
    Handles both string content and multipart vision lists."""
    if content_field is None:
        return ""
    if isinstance(content_field, str):
        return content_field
    if isinstance(content_field, list):
        return " ".join(
            p.get("text", "") for p in content_field
            if isinstance(p, dict) and p.get("type") == "text"
        )
    return str(content_field)


def last_user_text(messages) -> str:
    """Texte du DERNIER message ``role=user`` de la conversation.

    Utilisé par la route chat pour (a) le matching déterministe des skills et
    (b) l'indexation mémoire (sync_turn). Best-effort : "" si aucun message
    user.

    BUG FIX — gère un ``content`` MULTIMODAL (liste de blocs texte+image) via
    ``_msg_text``. Avant, la route ne récupérait le texte que si ``content``
    était une ``str`` ; un message ``[{"type":"text",...},{"image_url"}]``
    laissait ``_last_user_text`` VIDE → les skills ne matchaient pas et la
    mémoire indexait un tour user vide.
    """
    if not isinstance(messages, list):
        return ""
    for m in reversed(messages):
        if isinstance(m, dict) and m.get("role") == "user":
            return _msg_text(m.get("content")).strip()
    return ""


def recent_user_text(messages, k: int = 3) -> str:
    """Concatène le texte des ``k`` DERNIERS messages ``role=user`` (récent →
    ancien), pour le matching des skills.

    Pourquoi : un matching sur le SEUL dernier message perd le skill au tour où
    l'utilisateur dit « fais-le » / « continue » / « oui » (zéro mot-clé). En
    incluant quelques tours user récents, le corps de la procédure reste matché
    tant que la conversation ne dévie pas. Best-effort : "" si aucun message
    user. (La mémoire continue d'utiliser ``last_user_text`` — un seul tour.)
    """
    if not isinstance(messages, list) or k <= 0:
        return ""
    texts: list = []
    for m in reversed(messages):
        if isinstance(m, dict) and m.get("role") == "user":
            t = _msg_text(m.get("content")).strip()
            if t:
                texts.append(t)
            if len(texts) >= k:
                break
    return "\n".join(texts)


# ─────────────────────────────────────────────────────────────────────────────
#  ON-DISK PATHS
# ─────────────────────────────────────────────────────────────────────────────
# AUDIT 2026-08-01 (M4) — ALIAS de CONFIG_JSON_PATH, plus un chemin en dur.
#
# Ce chemin était figé à ``PROJECT_ROOT/shared_infra/config.json`` alors que
# ``config.CONFIG_JSON_PATH`` honore ``APP_CONFIG_PATH``. Les deux coïncident
# tant que la variable n'est pas posée — mais le déploiement la prévoit
# (``server/gunicorn_conf.py`` et ``gunicorn_admin_conf.py`` la consultent).
# Dans ce cas l'éditeur « Config principale » de l'admin (``admin/config.py``,
# GET et POST) lisait et écrivait un FICHIER FANTÔME : « ok: true », relecture
# cohérente dans l'onglet, puis retour aux anciennes valeurs au redémarrage —
# exactement le bug « refresh à chaque redémarrage » que le commentaire de
# ``admin/config.py`` dit avoir corrigé, réintroduit par cette seconde
# constante. Les panneaux spécialisés (compression, scheduling, executors,
# security) passaient eux par ``write_config_json`` → le bon fichier.
DEFAULT_CONFIG_PATH = CONFIG_JSON_PATH
USER_CONFIG_DIR = PROJECT_ROOT / "user_db" / "configs"
AVATAR_DIR = PROJECT_ROOT / "user_db" / "avatars"
RAG_CONFIG_PATH = PROJECT_ROOT / "rag_app" / "rag_config.json"
if not RAG_CONFIG_PATH.parent.exists():
    RAG_CONFIG_PATH = PROJECT_ROOT / "rag_config.json"


# ─────────────────────────────────────────────────────────────────────────────
#  JSON FILE I/O
# ─────────────────────────────────────────────────────────────────────────────
def _read_json_file(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _write_json_atomic(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _user_cfg_path(user_id: int) -> Path:
    return USER_CONFIG_DIR / f"{int(user_id)}.json"


# ─────────────────────────────────────────────────────────────────────────────
#  PASSWORD POLICY
# ─────────────────────────────────────────────────────────────────────────────
def validate_password(password: str):
    config = config_view() or {}
    sec_config = config.get("security", {}).get("password_policy", {})

    min_length = int(sec_config.get("min_length", 0))
    req_upper = bool(sec_config.get("require_uppercase", False))
    req_lower = bool(sec_config.get("require_lowercase", False))
    req_number = bool(sec_config.get("require_numbers", False))
    req_special = bool(sec_config.get("require_special", False))

    if min_length > 0 and len(password) < min_length:
        raise HTTPException(400, f"Le mot de passe doit faire au moins {min_length} caractères.")
    if req_upper and not re.search(r"[A-Z]", password):
        raise HTTPException(400, "Le mot de passe doit contenir au moins une majuscule (A-Z).")
    if req_lower and not re.search(r"[a-z]", password):
        raise HTTPException(400, "Le mot de passe doit contenir au moins une minuscule (a-z).")
    if req_number and not re.search(r"\d", password):
        raise HTTPException(400, "Le mot de passe doit contenir au moins un chiffre (0-9).")
    if req_special and not re.search(r"[!@#$%^&*(),.?\":{}|<>\-_\[\]\+=\\\\/~`]", password):
        raise HTTPException(400, "Le mot de passe doit contenir au moins un caractère spécial.")


# ─────────────────────────────────────────────────────────────────────────────
#  PATH-CONTAINMENT HELPER (anti path-traversal)
# ─────────────────────────────────────────────────────────────────────────────
# BUG FIX (sécurité critique) — l'ancien pattern
#     if not str(target).startswith(str(root)):
# était cassé pour les noms partageant un préfixe : si le sandbox de
# ``bob`` est ``/sandboxes/bob`` et que ``bob2`` existe à
# ``/sandboxes/bob2``, alors ``"/sandboxes/bob2/x".startswith("/sandboxes/bob")``
# retourne True. Un user pouvait faire un GET sur un path tel que
# ``../bob2/secret`` et accéder au sandbox d'un autre user.
#
# ``Path.relative_to`` lève ValueError si target n'est pas dans root,
# ce qui est la sémantique correcte (équivalent à ``is_relative_to`` en 3.9+
# mais dispo dès 3.6). Les deux chemins sont déjà résolus par les call sites
# (chaque site fait ``(root / rel).resolve()`` avant d'appeler le check).
def _path_inside(target: Path, root: Path) -> bool:
    """Return True iff ``target`` is ``root`` itself or strictly under it.

    Both paths must already be resolved/absolute. Symlinks are NOT
    re-traversed here — call ``.resolve()`` on inputs first.
    """
    try:
        target.relative_to(root)
        return True
    except ValueError:
        return False


# ─────────────────────────────────────────────────────────────────────────────
#  SANDBOX
# ─────────────────────────────────────────────────────────────────────────────
def _strip_work_prefix(path: str) -> str:
    """Normalise la vue conteneur d'un chemin (``/work``, ``work``, ``./work``)
    en chemin RELATIF à la racine sandbox.

    Miroir de ``tools/fs_tools._translate_container_path`` : l'agent raisonne
    dans l'espace de chemins du conteneur (``/work/src/x`` car son shell tourne
    dans ``/work``) et renvoie souvent ces chemins tels quels. Sans cette
    normalisation, les routes faisaient ``root / "/work/src/x"`` — or un chemin
    ABSOLU écrase le préfixe en pathlib → on sortait de la sandbox → 404 sur les
    chemins « complets » (``/work/...``) alors que les « partiels » (relatifs)
    marchaient. C'était l'incohérence complet/partiel signalée.

    Idempotent pour tout le reste (un chemin relatif normal ressort inchangé).

    Single source of truth: delegates to ``shared_infra.sandbox.paths``. This
    module-local wrapper is kept only because callers import it by this name;
    the normalization rules live (and are fuzz-tested) in one place now.
    """
    from shared_infra.sandbox.paths import strip_work_prefix
    return strip_work_prefix(path)


def _get_sandbox_path(user_id: int) -> Path:
    """Racine PAR-UTILISATEUR ``P = <SANDBOX_DIR>/<safe_user>``.

    ⚠ ``P`` n'est PLUS montée telle quelle sur ``/work`` : elle CONTIENT le
    sous-dossier ``work/`` (le seul monté) à côté des dossiers protégés
    ``skills/`` et ``.memory/`` (hors conteneur). Utiliser ``P`` UNIQUEMENT
    pour ce qui doit voir tout le dossier user (skills, mémoire, suppression
    de compte). Pour les opérations de fichiers visibles par l'agent, passer
    par :func:`_get_work_path`.
    """
    from shared_infra.config import safe_sandbox_name
    # (2026-09-11, P4) l'enveloppe d'identité (hôte d'outils : pas de base des
    # comptes) prime ; sinon la base, comme avant.
    from shared_infra.accounts.identity import resolve_username as _ident_name
    username = _ident_name(user_id) or get_username_by_id(user_id) or f"user_{user_id}"
    safe_name = safe_sandbox_name(username)
    sb_path = (SANDBOX_DIR / safe_name).resolve()
    sb_path.mkdir(parents=True, exist_ok=True)
    return sb_path


def _get_work_path(user_id: int) -> Path:
    """Racine de TRAVAIL ``P/work`` — le dossier réellement monté sur ``/work``.

    C'est la racine que voit l'agent (fs/shell/git/éditeur/terminal). Migre
    une-fois l'ancienne arbo « plate » de ``P`` dans ``P/work`` (cf.
    ``shared_infra.sandbox.ensure_work_subdir``). Les dossiers ``skills/`` et
    ``.memory/`` restent à ``P``, hors du mont.
    """
    from shared_infra.sandbox import ensure_work_subdir
    return ensure_work_subdir(_get_sandbox_path(user_id))


# ─────────────────────────────────────────────────────────────────────────────
#  Per-user sandbox quota lock (anti-TOCTOU)
# ─────────────────────────────────────────────────────────────────────────────
# BUG FIX (medium) : avant, le check de quota et l'écriture n'étaient pas
# atomiques — deux requêtes save/upload concurrentes du même user pouvaient
# toutes deux passer le check (size+net_new <= quota) puis toutes deux
# écrire, dépassant le quota. Avec un lock asyncio par-uid, les opérations
# de quota d'un même user sont sérialisées au sein d'un worker.
#
# AUDIT 2026-09-16 — la sérialisation était INTRA-WORKER : sous gunicorn (N
# workers, aucune affinité de requête), deux imports simultanés du même compte
# atterrissaient volontiers sur deux process, passaient tous deux le contrôle
# de capacité, puis écrivaient : quota dépassé. Le verrou est donc double —
# ``asyncio.Lock`` pour les coroutines d'un même process, ``flock`` sur un
# fichier du répertoire d'exécution partagé pour les process entre eux (même
# mécanique que ``shared_infra.runtime.chat_locks``, et un worker qui meurt
# libère tout seul).
#
# Le ``flock`` est BLOQUANT (pris dans un thread) : deux imports du même compte
# doivent s'attendre, pas se refuser. Répertoire indisponible ⇒ on retombe sur
# le verrou intra-worker d'avant (fail-open : un garde-fou de confort ne coupe
# jamais un import).
import asyncio as _aio_quota
import contextlib as _ctx_quota
import fcntl as _fcntl_quota
_quota_locks: "dict[int, _aio_quota.Lock]" = {}


def _quota_lock_path(user_id: int) -> "Optional[Path]":
    try:
        from shared_infra.runtime.runtime_dir import runtime_path
        d = runtime_path("quota_locks", "ELPIS_QUOTA_LOCK_DIR", "/tmp/elpis_quota_locks")
        d.mkdir(parents=True, exist_ok=True)
        return d / f"u{int(user_id)}.lock"
    except Exception:                                            # noqa: BLE001
        return None


def _quota_flock_acquire(user_id: int):
    path = _quota_lock_path(user_id)
    if path is None:
        return None
    try:
        fd = os.open(str(path), os.O_CREAT | os.O_RDWR, 0o600)
    except OSError:
        return None
    try:
        _fcntl_quota.flock(fd, _fcntl_quota.LOCK_EX)
        return fd
    except OSError:
        try:
            os.close(fd)
        except OSError:
            pass
        return None


def _quota_flock_release(fd) -> None:
    if fd is None:
        return
    try:
        _fcntl_quota.flock(fd, _fcntl_quota.LOCK_UN)
    except OSError:
        pass
    try:
        os.close(fd)
    except OSError:
        pass


@_ctx_quota.asynccontextmanager
async def _quota_lock_for(user_id: int):
    """Sérialise « contrôle de capacité puis écriture » pour un compte, dans ce
    process ET entre les process. S'utilise en ``async with``."""
    lk = _quota_locks.get(user_id)
    if lk is None:
        lk = _aio_quota.Lock()
        _quota_locks[user_id] = lk
    async with lk:
        fd = await asyncio.to_thread(_quota_flock_acquire, user_id)
        try:
            yield
        finally:
            await asyncio.to_thread(_quota_flock_release, fd)


def _sandbox_size_bytes(sandbox_root: Path) -> int:
    """Return total size in bytes of all files inside sandbox_root.

    Stratégie en deux temps :

    1. **Fast path — ``du -sb``** : l'outil système ``du`` parcourt
       l'arbre en code natif, BEAUCOUP plus rapide que ``os.walk`` +
       ``getsize`` en Python (qui fait un appel système par fichier
       depuis l'interpréteur). Sur un sandbox de plusieurs milliers de
       fichiers, ``du`` répond en quelques ms là où la boucle Python
       prend des centaines de ms — ce qui compte maintenant que le
       quota est rafraîchi périodiquement (polling 12s côté frontend).

       ``-s`` = résumé (total uniquement), ``-b`` = apparent size en
       octets (somme des ``st_size``) — même sémantique que
       ``os.path.getsize`` employé dans le fallback, donc la valeur
       reportée ne change pas pour l'utilisateur.

    2. **Fallback — ``os.walk``** : si ``du`` est absent (Windows,
       conteneur minimal) ou échoue (timeout, permission), on retombe
       sur la boucle Python. Robuste mais lent.
    """
    # ── Fast path : du -sb ───────────────────────────────────────────
    du_bin = shutil.which("du")
    if du_bin:
        try:
            result = subprocess.run(
                [du_bin, "-sb", str(sandbox_root)],
                capture_output=True,
                text=True,
                timeout=15,
            )
            if result.returncode == 0 and result.stdout.strip():
                # Format : "<bytes>\t<path>" — on prend le 1er champ.
                first_field = result.stdout.split()[0]
                return int(first_field)
        except (OSError, ValueError, IndexError, subprocess.TimeoutExpired):
            # du indisponible / sortie inattendue / trop lent → fallback
            pass

    # ── Fallback : os.walk Python ────────────────────────────────────
    total = 0
    try:
        for dirpath, _, filenames in os.walk(sandbox_root):
            for fname in filenames:
                try:
                    total += os.path.getsize(os.path.join(dirpath, fname))
                except OSError:
                    pass
    except Exception:
        pass
    return total


# ─────────────────────────────────────────────────────────────────────────────
#  Usage disque de la sandbox — cache + single-flight (audit perf 2026-08-08)
# ─────────────────────────────────────────────────────────────────────────────
# ``_sandbox_size_bytes`` lance un ``du -sb`` : un sous-process qui parcourt
# TOUT l'arbre. Mesuré à 37 ms sur une sandbox de 42 Mo / 1 767 entrées, mais
# c'est linéaire en nombre de fichiers — plusieurs centaines de ms à quelques
# secondes dès qu'il y a un ``node_modules``.
#
# Il était appelé :
#   * à chaque ``GET /api/sandbox/quota``, lui-même déclenché par CHAQUE chunk
#     de sortie du terminal (le PTY fait l'écho de chaque frappe) → un ``du``
#     par pause de frappe et par utilisateur ;
#   * à chaque ``POST /api/sandbox/save`` (donc à chaque autosave) ;
#   * au 1er chunk de chaque upload.
#
# Trois leviers, dans l'ordre d'efficacité :
#   1. CACHE par utilisateur (TTL court) — les lectures répétées ne coûtent rien.
#   2. SINGLE-FLIGHT — N requêtes concurrentes du même user ne lancent qu'UN
#      ``du`` ; les autres attendent son résultat au lieu d'en lancer un chacune.
#   3. MISE À JOUR INCRÉMENTALE (``bump``) — une écriture dont on connaît le
#      delta ajuste le compteur au lieu de tout invalider, donc l'autosave ne
#      re-déclenche jamais de ``du``.
#
# Le quota est un garde-fou SOUPLE (le code le dit déjà : « une légère dérive
# sous écritures concurrentes est tolérable »). Les écritures faites hors app
# (terminal, outils du modèle) ne sont pas tracées : elles sont rattrapées à
# l'expiration du TTL. Les chemins qui ENFORCENT le quota rechargent en exact
# dès qu'on approche de la limite (cf. ``sandbox_usage_bytes(near_limit=…)``),
# donc on ne laisse jamais passer un dépassement par excès de cache.
#
# ⚠ Cache PAR WORKER (comme ``_quota_locks``) : deux workers peuvent détenir
# des valeurs légèrement différentes. Sans effet pour une jauge souple.
import threading as _threading_usage

_USAGE_TTL_S = 30.0
#: Au-delà de ce taux de remplissage, les chemins d'enforcement recalculent en
#: exact plutôt que de faire confiance au cache (marge anti-dépassement).
_USAGE_EXACT_ABOVE_PCT = 0.90

# ⚠ Clé = (user_id, racine mesurée) et NON le seul user_id : deux racines
# coexistent pour un même utilisateur — ``P/work`` (ce que voit l'agent, ce sur
# quoi le quota est appliqué) et ``P`` (qui contient EN PLUS skills/ et
# memory/, utilisé par la vue admin). Avec une clé au seul user_id, un appelant
# qui passe ``P`` empoisonnerait silencieusement la valeur lue par tous ceux
# qui passent ``P/work`` — un écart invisible sur la jauge ET sur l'enforcement.
_usage_cache: "dict[tuple, tuple[float, int]]" = {}     # (uid, root) → (monotonic, octets)
_usage_locks: "dict[tuple, _threading_usage.Lock]" = {}
_usage_locks_guard = _threading_usage.Lock()


def _usage_key(user_id: int, root) -> tuple:
    return (int(user_id), str(root))


def _usage_lock_for(key: tuple) -> "_threading_usage.Lock":
    lk = _usage_locks.get(key)
    if lk is None:
        with _usage_locks_guard:                 # création concurrente possible
            lk = _usage_locks.get(key)
            if lk is None:
                lk = _threading_usage.Lock()
                _usage_locks[key] = lk
    return lk


def sandbox_usage_bytes(user_id: int, root: Path, *,
                        max_age_s: float = _USAGE_TTL_S,
                        quota_bytes: int = 0) -> int:
    """Octets occupés par la sandbox de ``user_id``, avec cache et single-flight.

    ``quota_bytes`` > 0 : chemin d'ENFORCEMENT. Si la valeur en cache place déjà
    l'utilisateur au-dessus de :data:`_USAGE_EXACT_ABOVE_PCT` du quota, on
    ignore le cache et on recalcule en exact — près de la limite, la précision
    prime sur le coût. Loin de la limite (le cas courant), le cache sert.
    """
    import time as _t
    key = _usage_key(user_id, root)
    now = _t.monotonic()
    hit = _usage_cache.get(key)
    if hit is not None and (now - hit[0]) <= max_age_s:
        if not (quota_bytes > 0 and hit[1] >= quota_bytes * _USAGE_EXACT_ABOVE_PCT):
            return hit[1]

    # Single-flight : un seul ``du`` par (user, racine), les autres attendent.
    with _usage_lock_for(key):
        hit = _usage_cache.get(key)
        now = _t.monotonic()
        if hit is not None and (now - hit[0]) <= max_age_s:
            if not (quota_bytes > 0 and hit[1] >= quota_bytes * _USAGE_EXACT_ABOVE_PCT):
                return hit[1]
        total = _sandbox_size_bytes(root)
        _usage_cache[key] = (_t.monotonic(), total)
        return total


def bump_sandbox_usage(user_id: int, delta_bytes: int) -> None:
    """Ajuste le compteur d'une écriture dont on connaît le delta, SANS relancer
    de ``du``. Ne rafraîchit pas l'horodatage : le TTL continue de courir, donc
    la dérive accumulée est bornée dans le temps.

    Applique le delta à TOUTES les racines mises en cache pour cet utilisateur :
    une écriture dans ``P/work`` fait aussi grossir ``P`` d'autant."""
    uid = int(user_id)
    for key, hit in list(_usage_cache.items()):
        if key[0] == uid:
            _usage_cache[key] = (hit[0], max(0, hit[1] + int(delta_bytes)))


def invalidate_sandbox_usage(user_id: int) -> None:
    """Force un recalcul au prochain accès (suppression, vidage, restauration —
    opérations dont le delta n'est pas connu à peu de frais). Purge toutes les
    racines de cet utilisateur."""
    uid = int(user_id)
    for key in [k for k in _usage_cache if k[0] == uid]:
        _usage_cache.pop(key, None)


def reset_sandbox_usage_cache() -> None:
    """Vide tout le cache (tests)."""
    _usage_cache.clear()


# Plafond d'entrées remontées par ``_build_file_tree`` (audit perf 2026-08-08).
# L'explorateur sérialise l'arbre ENTIER à chaque ouverture de l'éditeur et
# après chaque opération de fichier. Une sandbox avec ``node_modules``
# (100 k+ entrées) produisait un JSON de plusieurs Mo : coût serveur, transfert,
# puis parse + rendu Vue côté client — l'explorateur devenait inutilisable.
# On borne le nombre total d'entrées et on le SIGNALE (``truncated``) au lieu de
# tronquer en silence.
TREE_MAX_ENTRIES = int(os.environ.get("SANDBOX_TREE_MAX_ENTRIES", "20000"))


def _build_file_tree(path: Path, relative_root: Path, include_hidden: bool = False,
                     _budget: "dict | None" = None) -> list:
    """Arbre des fichiers du sandbox. Par défaut, les entrées cachées (nom
    commençant par ``.`` : ``.git``, ``.venv``, ``.env``…) sont MASQUÉES de
    l'explorateur — elles restent accessibles/éditables via le terminal.
    ``include_hidden=True`` les ré-inclut (toggle « Afficher les fichiers cachés »).

    SECURITY (F6, puis 2026-09-29) : aucun lien suivi. Chaque dossier est
    ouvert RELATIVEMENT au descripteur de son parent, en ``O_NOFOLLOW`` : un
    ``ln -s /srv/elpis/user_sandboxes/<victime>/work /work/x``, posé avant ou
    PENDANT le parcours, n'est jamais listé ; ``ln -s . loop`` ne boucle pas.
    Profondeur bornée. ``path`` et ``relative_root`` désignent la racine.

    ``_budget`` : dict ``{"left": N, "truncated": bool}`` partagé par toute la
    récursion, qui plafonne le NOMBRE TOTAL d'entrées (cf.
    :data:`TREE_MAX_ENTRIES`) ; l'appelant y lit ``truncated``.

    Coût (audit charge 2026-08-14) : route la plus appelée du panneau éditeur,
    et SYNCHRONE. Ni ``resolve()`` ni ``relative_to`` par entrée : le chemin
    relatif s'assemble au fil de la descente, et les descripteurs évitent de
    re-parcourir le chemin à chaque dossier.
    """
    if _budget is None:
        _budget = {"left": TREE_MAX_ENTRIES, "truncated": False}
    try:
        fd = open_dir_beneath(relative_root, rel_under(relative_root, path))
    except (OSError, ValueError):
        return []
    return _tree_level(fd, "", include_hidden, _budget, 0)


def _tree_level(dfd: int, rel_prefix: str, include_hidden: bool,
                budget: dict, depth: int) -> list:
    """Un niveau de :func:`_build_file_tree` ; ferme ``dfd``."""
    items = []
    try:
        if depth > 40:
            return items
        try:
            entries = sorted(os.scandir(dfd),
                             key=lambda e: (not e.is_dir(follow_symlinks=False), e.name.lower()))
        except OSError:
            # PermissionError, conteneur mort…
            return items
        for entry in entries:
            try:
                if budget["left"] <= 0:
                    budget["truncated"] = True
                    break
                if not include_hidden and entry.name.startswith("."):
                    continue
                if entry.is_symlink():                  # liens : ni suivis ni listés
                    continue
                rel_path = f"{rel_prefix}/{entry.name}" if rel_prefix else entry.name
                is_dir = entry.is_dir(follow_symlinks=False)
                budget["left"] -= 1
                item = {"name": entry.name, "path": rel_path, "type": "folder" if is_dir else "file"}
                if is_dir:
                    cfd = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
                                  | os.O_CLOEXEC, dir_fd=dfd)
                    item["children"] = _tree_level(cfd, rel_path, include_hidden, budget, depth + 1)
                else:
                    item["size"] = entry.stat(follow_symlinks=False).st_size
                items.append(item)
            except OSError:
                continue
    finally:
        os.close(dfd)
    return items


# ─────────────────────────────────────────────────────────────────────────────
#  BACKUP ZIP BUILDER
# ─────────────────────────────────────────────────────────────────────────────
_DB_ANNEXES = ("-wal", "-shm", "-journal")
# Fichiers de ``user_db/`` propres à l'hôte : ni sauvegardés ni restaurés
# (restaurer la sauvegarde d'un autre hôte ne doit pas couper l'accès à la base).
_HOST_ONLY = (".db_password", ".db_maintenance", ".db_job.json",
              ".config_boot.json")   # empreinte « lu au démarrage » (ops/restart_pending.py)


def _snapshot_sqlite(src: Path, dst: Path) -> None:
    """Instantané COHÉRENT d'une base vivante, par l'API de sauvegarde SQLite.

    La base est en WAL : sa copie brute perdait les transactions encore dans
    ``-wal``, voire emportait une page à moitié écrite. L'instantané repasse en
    ``journal_mode=DELETE`` : un seul fichier autonome, sans ``-wal`` à
    emporter. ``dst`` existe déjà (créé en 0600 par ``mkstemp``) et SQLite
    garde son mode : la base ne transite jamais lisible par tous dans /tmp."""
    source = sqlite3.connect(str(src), timeout=30)
    try:
        cible = sqlite3.connect(str(dst))
        try:
            source.backup(cible)
            cible.execute("PRAGMA journal_mode=DELETE")
        finally:
            cible.close()
    finally:
        source.close()


def _make_backup_zip(scope: str) -> tuple:
    """Build an admin backup zip on-the-fly.

    ``scope`` is one of "full", "db", "sandboxes", "mcp" — each picks
    a specific subset of disk state to bundle. Returns ``(tmp_path, filename)``;
    callers stream the file then unlink it.
    """
    from shared_infra.config import DB_PATH as _DB_PATH, SANDBOX_DIR as _SANDBOX_DIR, MCP_SERVERS_DIR as _MCP_DIR
    import time as _time
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")
    tmp.close()
    ts = int(_time.time())
    skipped: list = []
    with zipfile.ZipFile(tmp.name, 'w', zipfile.ZIP_DEFLATED) as zf:
        def _safe_write(abs_p: Path, arcname: str):
            # Les sandboxes contiennent des fichiers créés DANS le container
            # (UID 10001, parfois sans o+r — caches, .pickle…), des liens
            # morts, voire des FIFO. Un seul open() raté faisait échouer TOUT
            # le backup en 500 : on ignore le fichier et on le consigne dans
            # un manifest à la racine du zip (backup partiel > pas de backup).
            try:
                if not abs_p.is_file():          # FIFO/socket/lien mort
                    raise OSError("fichier spécial ou lien mort")
                zf.write(abs_p, arcname)
            except (PermissionError, OSError) as e:
                skipped.append(f"{abs_p} — {e.__class__.__name__}: {e}")

        def _add_path(p: Path, arcroot: str, exclus: frozenset = frozenset()):
            if not p.exists():
                return
            if p.is_file():
                _safe_write(p, arcroot + "/" + p.name)
                return
            for root, _, files in os.walk(p):
                for file in files:
                    abs_p = Path(root) / file
                    if exclus and abs_p.resolve() in exclus:
                        continue
                    _safe_write(abs_p, arcroot + "/" + abs_p.relative_to(p).as_posix())

        if scope in ("full", "db"):
            db_file = Path(_DB_PATH)
            from shared_infra.db._connection import DB_BACKEND as _backend
            if _backend != "sqlite":
                # Moteur serveur : la sauvegarde reste un fichier SQLite
                # (restaurable partout), produit par le transfert. L'app.db
                # présent sur le disque n'est plus la base active.
                snapdir = tempfile.mkdtemp()
                snap = os.path.join(snapdir, db_file.name)
                try:
                    from shared_infra.db import transfer as _t
                    rep = _t.transfer(_t.active_target(), {"backend": "sqlite", "path": snap})
                    if not rep.get("ok"):
                        raise RuntimeError("; ".join(rep.get("mismatches") or []) or "vérification")
                    _safe_write(Path(snap), f"db/{db_file.name}")
                except Exception as e:
                    skipped.append(f"base {_backend} — instantané impossible : {e}")
                finally:
                    shutil.rmtree(snapdir, ignore_errors=True)
            elif db_file.exists():
                fd, snap = tempfile.mkstemp(suffix=".db")
                os.close(fd)
                try:
                    _snapshot_sqlite(db_file, Path(snap))
                    _safe_write(Path(snap), f"db/{db_file.name}")
                except sqlite3.Error as e:
                    skipped.append(f"{db_file} — instantané impossible : {e}")
                finally:
                    for suffixe in ("",) + _DB_ANNEXES:
                        Path(snap + suffixe).unlink(missing_ok=True)
            user_db_dir = PROJECT_ROOT / "user_db"
            if user_db_dir.exists():
                # La base est déjà dans ``db/`` : la recopier ici en brut, avec
                # son ``-wal``, doublait le zip d'une version incohérente.
                # Exclus aussi : ce qui est propre à CET hôte (mot de passe du
                # serveur de base, état d'une bascule) et les copies inactives
                # de la base laissées par une bascule (``.bak-*``, ``.new-*``).
                base = db_file.resolve()
                exclus = {base.with_name(base.name + s) for s in ("",) + _DB_ANNEXES}
                exclus |= {user_db_dir.resolve() / n for n in _HOST_ONLY}
                if base.parent.exists():
                    exclus |= {q.resolve() for q in base.parent.glob(base.name + ".bak-*")}
                    exclus |= {q.resolve() for q in base.parent.glob(base.name + ".new-*")}
                _add_path(user_db_dir, "user_db", exclus=frozenset(exclus))

        if scope in ("full", "sandboxes"):
            _add_path(_SANDBOX_DIR, "sandboxes")

        if scope in ("full", "mcp"):
            _add_path(_MCP_DIR, "mcp_custom_servers")

        if scope == "full":
            # Skins importés ou créés depuis la console (hors du code).
            from shared_infra.config import SKINS_DIR as _SKINS_DIR
            _add_path(Path(_SKINS_DIR), "user_skins")

        if skipped:
            zf.writestr(
                "backup-warnings.txt",
                "Fichiers ignorés (illisibles depuis l'hôte) :\n" + "\n".join(skipped) + "\n")

    label = {"full": "complet", "db": "db", "sandboxes": "sandboxes", "mcp": "mcp"}.get(scope, scope)
    # Date de la dernière sauvegarde, lue par la Vue d'ensemble de la console
    # (« aucune sauvegarde depuis N jours »). Couvre le téléchargement ET
    # l'envoi distant, qui passent tous deux par ici.
    try:
        from shared_infra.db import log_metric
        log_metric("backup_created", 1, {"scope": scope, "skipped": len(skipped),
                                         "bytes": os.path.getsize(tmp.name)})
    except Exception:                                        # noqa: BLE001
        logger.warning("[backup] date de sauvegarde non enregistrée", exc_info=True)
    return tmp.name, f"backup_{label}_{ts}.zip"


# ─────────────────────────────────────────────────────────────────────────────
#  GIT WRAPPERS
# ─────────────────────────────────────────────────────────────────────────────
import subprocess as _sp_git


def _git_run(repo_dir: Path, *args, timeout: int = 30,
             env_extra: dict = None) -> _sp_git.CompletedProcess:
    """Execute a git command inside a specific repo directory.

    Environnement : ``host_git_env`` (liste blanche, HOME de l'app, hooks et
    signature coupés — audit 2026-09-22, C1). Dépôt refusé si ``.git`` sort du
    dépôt ou si sa config déclare une commande exécutable (``repo_refusal``).
    """
    env = host_git_env(env_extra, cwd=repo_dir)
    bad = repo_refusal(repo_dir, env)
    if bad:
        kind, detail = bad
        msg = (f"Dépôt refusé : sa configuration déclare « {detail} », une commande que git "
               f"exécuterait sur le serveur. Retirez-la depuis le terminal du bac à sable "
               f"(git config --unset {detail}).") if kind == "config" else (
               f"Dépôt refusé : {detail}. Git lirait des données hors du dépôt.")
        return _sp_git.CompletedProcess(["git"] + list(args), 1, "", msg)
    return run_host_git(["git"] + list(args), cwd=repo_dir, env=env,
                        capture_output=True, text=True, timeout=timeout)


def _git_resolve_repo(sandbox: Path, repo_rel: str) -> Path:
    """Resolve a repo path within the sandbox. Raises HTTPException if invalid."""
    if not repo_rel:
        raise HTTPException(400, "Paramètre 'repo' requis (chemin du dépôt)")
    repo_dir = (sandbox / repo_rel).resolve()
    # SECURITY FIX : ``startswith`` est vulnérable aux préfixes communs
    # (cf. _path_inside docstring). On utilise relative_to via le helper.
    if not _path_inside(repo_dir, sandbox):
        raise HTTPException(403, "Chemin hors sandbox")
    if not repo_dir.is_dir():
        raise HTTPException(404, f"Dossier introuvable : {repo_rel}")
    if not os.path.lexists(repo_dir / ".git"):
        raise HTTPException(400, f"'{repo_rel}' n'est pas un dépôt Git")
    _git_refuse_foreign_dir(repo_dir)
    return repo_dir


def _git_refuse_foreign_dir(repo_dir: Path) -> None:
    """403 si ``.git`` est un lien, un fichier ``gitdir:``, ou pointe hors du
    dépôt (alternates…) — audit 2026-09-22, H5. ``_git_run`` refuse aussi,
    ceci donne un code HTTP propre dès la résolution."""
    why = unsafe_git_dir(repo_dir)
    if why:
        raise HTTPException(403, f"Dépôt refusé : {why}")


def _git_resolve_repo_or_root(sandbox: Path, repo_rel: str) -> Path:
    """Like _git_resolve_repo but allows empty repo_rel if sandbox root IS a repo."""
    if repo_rel:
        return _git_resolve_repo(sandbox, repo_rel)
    # Fallback: check if sandbox root is a repo
    if os.path.lexists(sandbox / ".git"):
        _git_refuse_foreign_dir(sandbox)
        return sandbox
    raise HTTPException(400, "Paramètre 'repo' requis (chemin du dépôt)")


def _git_run_with_creds(repo_dir: Path, *args, username: str = "", token: str = "",
                        timeout: int = 60) -> _sp_git.CompletedProcess:
    """Run a git command with optional HTTPS credentials via GIT_ASKPASS.

    Le token transite UNIQUEMENT par une variable d'environnement lue par un
    script askpass STATIQUE (jamais ``argv`` ni ``.git/config``) — implémentation
    PARTAGÉE avec le chemin MCP via ``shared_infra.git.askpass.git_askpass_env``
    (source unique ; ``subprocess`` sans shell → zéro expansion).
    """
    from shared_infra.git.askpass import git_askpass_env, AskpassError
    try:
        with git_askpass_env(username, token) as env_extra:
            return _git_run(repo_dir, *args, timeout=timeout, env_extra=env_extra)
    except AskpassError as e:
        raise HTTPException(400, f"Caractère de contrôle interdit dans les credentials : {e}")
