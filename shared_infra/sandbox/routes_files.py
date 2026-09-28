# SPDX-License-Identifier: MIT
"""
backend.routes.sandbox_files — Per-user sandbox filesystem operations.

This module exposes the *file* surface of the sandbox: tree view, quota,
upload/download, save/delete, mkdir/rename, lint, serve a static file
back, and full-text search. Git operations live in
``backend.routes.sandbox_git`` and snapshots live in
``backend.routes.sandbox_snapshots``.

Endpoints
---------
Discovery
- GET /api/sandbox/tree           — recursive folder/file listing (root only)
- GET /api/sandbox/quota          — used_mb / quota_mb / pct
- GET /api/sandbox/serve/{path}   — serve a sandbox file back to the browser
                                     (used by the iframe preview)
- GET /api/sandbox/search         — name- or content-grep with previews

Read / write
- GET    /api/sandbox/download    — file → direct, folder → on-the-fly zip
- POST   /api/sandbox/upload      — multi-file upload with per-file size cap
                                     and quota enforcement (skips offending
                                     files, never aborts the whole batch)
- POST   /api/sandbox/save        — write text content, async-safe, quota-checked

Structure
- DELETE /api/sandbox/delete      — delete file or folder
- POST   /api/sandbox/clear       — wipe the whole sandbox
- POST   /api/sandbox/mkdir       — create a folder (parents=True)
- POST   /api/sandbox/rename      — move/rename an item

Tooling
- POST /api/sandbox/lint          — run ruff on Python content (stdin); returns
                                     a list of Monaco-shaped diagnostics

All endpoints share two helpers from ``_legacy``:
  - ``_get_work_path(user_id)`` resolves the per-user WORK root (``P/work``,
    the dir bind-mounted as ``/work``; ``skills``/``.memory`` live at ``P``,
    outside it)
  - ``_sandbox_size_bytes(root)`` walks the tree to compute current usage
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import io
import logging
import mimetypes
import os
import re
import shutil
import subprocess as _sp
import time
import zipfile
from pathlib import Path, PurePosixPath
from typing import List, Optional

from fastapi import File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from shared_infra.config import config_view
from shared_infra.security.deps import require_user_id
from shared_infra.db import (
    log_metric,
)
from shared_infra.accounts.users import (
    get_user_settings,
    get_username_by_id,
)
from shared_infra.routes._state import router
from shared_infra.sandbox import file_history as _fh
from shared_infra.sandbox.file_lock import file_write_lock, sha256_bytes, sha256_file

logger = logging.getLogger("uvicorn.error")

# Helpers shared with ``_legacy``. Importing through the module reference
# means we always observe the live values.
from shared_infra.routes._helpers import _build_file_tree, _get_work_path, _no_cache, _path_inside, _quota_lock_for, _strip_work_prefix  # noqa: E402 — import tardif voulu (dépendance circulaire ou coût)
# Compteur d'usage disque mis en cache + single-flight (audit perf 2026-08-08).
# ``_sandbox_size_bytes`` reste importé pour les rares chemins qui veulent la
# valeur EXACTE sans passer par le cache.
from shared_infra.routes._helpers import (  # noqa: E402 — import tardif voulu (dépendance circulaire ou coût)
    TREE_MAX_ENTRIES, bump_sandbox_usage, invalidate_sandbox_usage,
    sandbox_usage_bytes,
)


# ─────────────────────────────────────────────────────────────────────────────
#  Verrou par fichier + historique de session (audit éditeur 2026-09-23)
# ─────────────────────────────────────────────────────────────────────────────
#: Au-delà, ``/download`` ne hache pas (en-tête ``X-Sha256`` absent) : le
#: fichier est servi en flux, sans être chargé en mémoire.
_DOWNLOAD_SHA_MAX = 64 * 1024 * 1024
#: ``/check-mtimes`` ne hache que les fichiers jusqu'à cette taille.
_CHECK_SHA_MAX = 2 * 1024 * 1024
_CHECK_MAX_FILES = 500
_SHA_RE = re.compile(r"^[0-9a-f]{64}$")


@contextlib.asynccontextmanager
async def _file_lock(path: Path):
    """``file_write_lock`` (flock bloquant, partagé avec les outils fs de
    l'assistant) pris depuis une route async — audit éditeur 2026-09-23, E7.

    Acquisition dans un thread ; si la requête est annulée pendant l'attente,
    le verrou obtenu malgré tout est relâché dès que le thread rend la main
    (sinon le descripteur, donc le verrou, restait ouvert indéfiniment)."""
    cm = file_write_lock(path)
    task = asyncio.ensure_future(asyncio.to_thread(cm.__enter__))
    try:
        got = await asyncio.shield(task)
    except asyncio.CancelledError:
        def _release(t):
            if not t.cancelled() and t.exception() is None:
                cm.__exit__(None, None, None)
        task.add_done_callback(_release)
        raise
    if not got:
        # Passe sandbox 2026-09-26 — ``got=False`` après 3 s veut dire que le
        # verrou est TENU (l'assistant écrit ce fichier) : écrire quand même
        # annulait en silence la garantie « précondition puis mv sous verrou ».
        # Seul le verrouillage DÉSACTIVÉ (FSTOOLS_FLOCK=0, dossier des verrous
        # indisponible) reste en fail-open, comme dans file_write_lock.
        cm.__exit__(None, None, None)
        from shared_infra.sandbox import file_lock as _fl
        if _fl._ENABLED and _fl._locks_base() is not None:
            raise HTTPException(409, "Fichier en cours d'écriture par l'assistant "
                                     "— réessayez dans un instant.")
        yield False                                  # fail-open documenté
        return
    try:
        yield got
    finally:
        cm.__exit__(None, None, None)


async def _hist_before(path: Path):
    """Contenu AVANT écriture, pour l'historique de session (jamais bloquant)."""
    try:
        return await asyncio.to_thread(_fh.read_before, path)
    except Exception:                                           # noqa: BLE001
        return None


async def _hist_write(user_id: int, rel: str, before, after, source: str) -> None:
    """``file_history.record_write`` hors boucle ; n'échoue jamais."""
    try:
        await asyncio.to_thread(_fh.record_write, user_id, rel, before, after, source)
    except Exception:                                           # noqa: BLE001
        logger.exception("[sandbox] historique : écriture non notée (%s)", rel)


def _file_state(p: Path, *, sha_max: int) -> dict:
    """État disque d'un chemin, sans jamais lever : ``kind`` ∈ ``missing``,
    ``dir``, ``file``, ``other``, ``unreadable``, ``not_dir``. Pour un fichier :
    ``mtime``, ``size`` et ``sha256`` (``None`` au-delà de ``sha_max`` ou si
    le contenu est illisible)."""
    try:
        st = p.stat()
    except FileNotFoundError:
        return {"kind": "missing"}
    except NotADirectoryError:
        return {"kind": "not_dir"}
    except PermissionError:
        return {"kind": "unreadable"}
    except OSError:
        return {"kind": "unreadable"}
    import stat as _stat
    if _stat.S_ISDIR(st.st_mode):
        return {"kind": "dir", "mtime": st.st_mtime}
    if not _stat.S_ISREG(st.st_mode):
        return {"kind": "other", "mtime": st.st_mtime, "size": st.st_size}
    out = {"kind": "file", "mtime": st.st_mtime, "size": st.st_size, "sha256": None,
           "readable": True}
    if st.st_size <= sha_max:
        try:
            h = hashlib.sha256()
            with open(p, "rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    h.update(chunk)
            out["sha256"] = h.hexdigest()
        except OSError:
            out["readable"] = False
    return out


# ─────────────────────────────────────────────────────────────────────────────
#  DISCOVERY
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/api/sandbox/tree")
def api_get_sandbox_tree(request: Request, include_hidden: bool = False):
    user_id = require_user_id(request)
    root = _get_work_path(user_id)
    # Dotfiles masqués par défaut (explorateur propre) ; ré-inclus via le
    # toggle « Afficher les fichiers cachés ». Le terminal n'est pas concerné.
    #
    # ``budget`` plafonne le nombre TOTAL d'entrées : une sandbox avec un
    # ``node_modules`` produisait sinon un JSON de plusieurs Mo à chaque
    # ouverture de l'éditeur et après chaque opération de fichier, ce qui
    # figeait l'explorateur côté navigateur. La troncature est SIGNALÉE.
    budget = {"left": TREE_MAX_ENTRIES, "truncated": False}
    tree = _build_file_tree(root, root, include_hidden=include_hidden, _budget=budget)
    return JSONResponse(
        {"root": str(root.name), "items": tree,
         "truncated": budget["truncated"], "max_entries": TREE_MAX_ENTRIES},
        headers={"Cache-Control": "no-cache"},
    )


def _user_quota_mb(user_id: int) -> int:
    """Quota EFFECTIF de la sandbox en Mo (surcharge admin par utilisateur >
    ``app.sandbox_quota_mb``). ``0`` = illimité.

    Source unique des routes de ce module (jauge, uploads, pré-contrôle) : la
    règle était recopiée à trois endroits."""
    user_settings = get_user_settings(user_id)
    if "sandbox_quota_mb" in user_settings:
        return int(user_settings["sandbox_quota_mb"])
    # ``config_view`` et non ``read_config_json`` : on ne fait que LIRE une
    # valeur. La seconde rend une copie profonde du fichier (~119 µs, et il
    # pèse 400 Ko) alors que celle-ci partage une vue en lecture seule
    # (3 µs). Sur la route la plus sondée du panneau éditeur, la copie était
    # payée à chaque appel pour être aussitôt jetée.
    cfg = config_view() or {}
    return int(cfg.get("app", {}).get("sandbox_quota_mb", 5120))


def _disk_free_bytes(root: Path) -> int:
    """Espace libre (octets, non-root) du volume qui porte ``root``.

    Mesuré LÀ où vit la sandbox : sur un hôte d'outils distant, cette route
    s'exécute sur l'hôte (relais ``/api/sandbox/*``), donc le ``statvfs`` voit
    le bon disque. ``0`` si la mesure échoue (appelant : pas de plafond)."""
    try:
        st = os.statvfs(str(root))
        return int(st.f_bavail) * int(st.f_frsize)
    except (OSError, AttributeError):
        return 0


def _import_capacity(user_id: int, root: Path, *, fresh: bool) -> dict:
    """Capacité offerte à UN import (cf. ``config.sandbox_import_max_pct``).

    * quota > 0 : capacité = quota ; restant = quota − usage ;
    * quota illimité : capacité = restant = espace disque libre du volume.
    ``limit_bytes`` = capacité × pourcentage. ``fresh`` force un calcul exact
    de l'usage (``du``) : le pré-contrôle ne doit pas décider sur un cache de
    30 s, la jauge peut. ``limit_bytes`` vaut ``None`` quand rien n'est
    mesurable (disque illisible, quota illimité) : pas de plafond alors."""
    from shared_infra.config import sandbox_import_max_pct
    quota_mb = _user_quota_mb(user_id)
    max_pct = sandbox_import_max_pct()
    if quota_mb > 0:
        quota_bytes = quota_mb * 1024 * 1024
        used = (sandbox_usage_bytes(user_id, root, max_age_s=0.0) if fresh
                else sandbox_usage_bytes(user_id, root, quota_bytes=quota_bytes))
        remaining = max(0, quota_bytes - used)
        capacity = quota_bytes
    else:
        # Illimité : l'usage n'entre dans aucun calcul (seul le disque compte),
        # le cache suffit — pas de ``du`` pour une valeur informative.
        quota_bytes = 0
        used = sandbox_usage_bytes(user_id, root)
        free = _disk_free_bytes(root)
        remaining = free if free > 0 else None
        capacity = free if free > 0 else None
    return {
        "unlimited": quota_mb <= 0,
        "quota_bytes": quota_bytes,
        "used_bytes": used,
        "remaining_bytes": remaining,
        "limit_bytes": (capacity * max_pct // 100) if capacity is not None else None,
        "max_pct": max_pct,
    }


@router.get("/api/sandbox/quota")
def api_sandbox_quota(request: Request):
    """Return current sandbox usage and quota for the calling user.

    Lecture SEULE → passe par le cache (``sandbox_usage_bytes``). C'est la
    route la plus appelée de tout le panneau éditeur (polling + rafraîchis
    après écriture) et chaque calcul exact est un ``du -sb`` sur tout l'arbre :
    sans cache, N utilisateurs = N ``du`` concurrents en permanence.

    Champs en octets (2026-09-16) à côté des Mo arrondis : ``remaining_bytes``
    vaut ``None`` quand le quota est illimité.
    """
    user_id = require_user_id(request)
    root = _get_work_path(user_id)
    quota_mb = _user_quota_mb(user_id)
    used_bytes = sandbox_usage_bytes(user_id, root)
    used_mb = round(used_bytes / (1024 * 1024), 2)
    pct = round(min(used_mb / quota_mb * 100, 100), 1) if quota_mb > 0 else 0
    quota_bytes = quota_mb * 1024 * 1024 if quota_mb > 0 else 0
    return {"used_mb": used_mb, "quota_mb": quota_mb, "pct": pct,
            "used_bytes": used_bytes, "quota_bytes": quota_bytes,
            "remaining_bytes": max(0, quota_bytes - used_bytes) if quota_mb > 0 else None}


#: Préfixe d'URL de l'aperçu « Web » de l'éditeur : ``<préfixe><jeton>/<chemin>``
#: (cf. ``preview_token``).
PREVIEW_URL_PREFIX = "/api/sandbox/pv/"

#: Nombre maximal de dossiers remontés en cherchant la « racine du site »
#: d'une référence absolue-racine (cf. ``preview_rewrite``).
_PREVIEW_ROOT_WALK_MAX = 8

#: Types qu'un navigateur EXÉCUTE (script, gestionnaires) : servis avec une
#: origine opaque (``CSP: sandbox``). Les autres (images, PDF, texte) n'en ont
#: pas besoin, et la visionneuse PDF refuse de s'ouvrir sous ``sandbox``.
_ACTIVE_TYPES = frozenset({
    "text/html", "application/xhtml+xml", "image/svg+xml",
    "text/xml", "application/xml", "text/xsl",
})
PREVIEW_CSP = "sandbox allow-scripts allow-forms allow-popups allow-modals"


def _security_headers(headers, media_type: str) -> None:
    """``nosniff`` partout ; origine OPAQUE pour tout type actif (audit
    2026-09-22, H1) — un ``.html``/``.svg`` écrit par l'agent ou cloné ne
    s'exécute plus avec la session de l'utilisateur."""
    headers["X-Content-Type-Options"] = "nosniff"
    if media_type.split(";")[0].strip().lower() in _ACTIVE_TYPES:
        headers["Content-Security-Policy"] = PREVIEW_CSP


def _preview_file_response(target: Path) -> FileResponse:
    """``FileResponse`` d'un fichier de sandbox.

    ``Cache-Control`` : sans en-tête explicite, l'``ETag`` seul ne force PAS
    la revalidation — le navigateur peut resservir l'ancien ``.css``/``.js``
    après une modification. On force la revalidation (304 à 0 octet tant que
    rien ne change).
    """
    mt, _ = mimetypes.guess_type(target.name)
    resp = FileResponse(target, media_type=mt or "text/plain")
    resp.headers["Cache-Control"] = "no-cache, must-revalidate"
    # ``MutableHeaders`` n'a pas de ``.pop()`` — il faut passer par ``del``.
    if "expires" in resp.headers:
        del resp.headers["expires"]
    _security_headers(resp.headers, mt or "text/plain")
    return resp


def _sandbox_file(user_id: int, path: str) -> Optional[Path]:
    """Fichier ``path`` sous la racine de travail de ``user_id``, ou ``None``.

    AUDIT 2026-08-30 (S3a) — ``resolve()``/``is_file()`` peuvent lever
    ``OSError`` (ENAMETOOLONG, ELOOP) : même « introuvable » que le reste,
    sans oracle qui distinguerait les deux."""
    root = _get_work_path(user_id)
    try:
        target = (root / _strip_work_prefix(path)).resolve()
        return target if _path_inside(target, root) and target.is_file() else None
    except OSError:
        return None


@router.get("/api/sandbox/serve/{path:path}")
def api_serve_sandbox(request: Request, path: str):
    """Lecture d'un fichier (session). Pour l'AFFICHAGE d'une page, voir
    ``/api/sandbox/pv/`` : ici un document actif reçoit une origine opaque,
    ses sous-ressources n'auraient donc pas la session."""
    target = _sandbox_file(require_user_id(request), path)
    if target is None:
        raise HTTPException(404, "Not found")
    return _preview_file_response(target)


@router.get("/api/sandbox/preview-token")
def api_preview_token(request: Request):
    """Jeton d'URL de l'aperçu (cf. ``preview_token``), lié à la session."""
    from shared_infra.sandbox.preview_token import make_preview_token
    token, exp = make_preview_token(require_user_id(request))
    return _no_cache(JSONResponse({"token": token, "expires": exp}))


def _resolve_from(user_id: int, doc_dir: str, wanted: str) -> Optional[Path]:
    """``wanted`` cherché dans ``doc_dir`` puis en remontant (borné) vers la
    racine sandbox — règle de l'ancien repli 404, sans le ``Referer``."""
    root = _get_work_path(user_id).resolve()
    parts = [p for p in PurePosixPath(_strip_work_prefix(doc_dir)).parts
             if p not in ("", ".", "/")]
    lowest = max(0, len(parts) - _PREVIEW_ROOT_WALK_MAX)
    for depth in range(len(parts), lowest - 1, -1):
        try:
            cand = (root.joinpath(*parts[:depth]) / wanted).resolve()
            if _path_inside(cand, root) and cand.is_file():
                return cand
        except OSError:
            continue
    return None


@router.get("/api/sandbox/pv/{token}/{path:path}")
def api_preview_sandbox(token: str, path: str):
    """Aperçu « Web » : identité portée par le jeton du chemin, pas par le
    cookie (qu'un document à origine opaque n'envoie pas).

    ``~r/d<dossier>/<chemin>`` : résolveur des refs absolues-racine,
    réécrites dans le HTML et le CSS servis (cf. ``preview_rewrite``)."""
    from shared_infra.sandbox import preview_rewrite as rw
    from shared_infra.sandbox.preview_token import check_preview_token
    uid = check_preview_token(token)
    if uid is None:
        raise HTTPException(403, "Aperçu expiré : rechargez-le")
    target = None
    if path.startswith(rw.RESOLVER + "/"):
        split = rw.split_resolver(path[len(rw.RESOLVER) + 1:])
        if split:
            target = _resolve_from(uid, *split)
    else:
        target = _sandbox_file(uid, path)
    if target is None:
        raise HTTPException(404, "Not found")

    mt = mimetypes.guess_type(target.name)[0] or "text/plain"
    kind = mt.split(";")[0].strip().lower()
    try:
        big = target.stat().st_size > rw.MAX_REWRITE_BYTES
    except OSError:
        raise HTTPException(404, "Not found")
    if kind not in ("text/html", "text/css") or big:
        return _preview_cors(_preview_file_response(target))
    try:
        text = target.read_text(encoding="utf-8", errors="replace")
    except OSError:
        raise HTTPException(404, "Not found")
    root = _get_work_path(uid).resolve()
    doc_dir = target.parent.relative_to(root).as_posix() if target.parent != root else ""
    base = rw.resolver_base(f"{PREVIEW_URL_PREFIX}{token}/", doc_dir)
    body = rw.rewrite_html(text, base) if kind == "text/html" else rw.rewrite_css(text, base)
    from fastapi.responses import Response
    resp = Response(body, media_type=mt)
    resp.headers["Cache-Control"] = "no-cache, must-revalidate"
    _security_headers(resp.headers, mt)
    return _preview_cors(resp)


def _preview_cors(resp):
    """Un document à origine opaque lit ses données (``fetch('data.json')``)
    en CROSS-ORIGIN : sans ce CORS, tout ``fetch`` de la page échouait. Le
    jeton du chemin est la seule capacité (pas de cookie, pas de
    ``credentials``) : ``*`` n'ouvre rien à qui ne le détient pas."""
    resp.headers["Access-Control-Allow-Origin"] = "*"
    return resp


@router.get("/api/sandbox/search")
def api_search_sandbox(request: Request, q: str, mode: str = "content"):
    """Search inside the user sandbox.

    mode=name    → filename filter (fast, existing behaviour)
    mode=content → full-text grep with line numbers and preview (new)
    """
    user_id = require_user_id(request)
    root = _get_work_path(user_id)
    if not q:
        return {"items": []}

    # AUDIT 2026-08-02 (E7) — une racine illisible (conteneur arrêté, /work
    # démonté, ACL manquante) retournait ``{"items": []}`` en HTTP 200 :
    # l'utilisateur concluait que son fichier n'existe pas alors que la
    # recherche n'a RIEN pu lire. Racine en échec → 503 explicite ; les
    # erreurs par-fichier restent tolérées mais sont comptées dans la
    # réponse (``errors``) au lieu d'être avalées.
    if not root.is_dir():
        raise HTTPException(503, "Sandbox inaccessible (conteneur arrêté ?) — "
                                 "réessayez après l'avoir démarrée.")

    # Passe sandbox 2026-09-26 — bornes de parcours. Le ``break`` à 200
    # résultats ne sortait que de la boucle des fichiers d'UN dossier : le
    # parcours continuait sur tout l'arbre, et une recherche sans résultat
    # lisait chaque fichier ≤ 512 Ko du dépôt. Chaque frappe (après debounce)
    # occupait ainsi un thread du pool partagé (/tree, /download…) plusieurs
    # secondes. Arrêt dès MAX_HITS, plafond de fichiers lus, échéance de 3 s ;
    # ``truncated`` le signale au client.
    _deadline = time.monotonic() + 3.0
    MAX_HITS = 200

    if mode == "name":
        q_lower = q.lower()
        results = []
        _errs = {"n": 0, "root_failed": False, "truncated": False}

        def walk(path, _is_root=False):
            if len(results) >= MAX_HITS or time.monotonic() > _deadline:
                _errs["truncated"] = True
                return
            try:
                for entry in os.scandir(path):
                    if len(results) >= MAX_HITS:
                        _errs["truncated"] = True
                        return
                    # SECURITY FIX : ne pas suivre les symlinks (ni dossiers ni
                    # fichiers). Un fichier symlinké pointant vers l'hôte ou la
                    # sandbox d'un autre user ne doit pas apparaître dans les
                    # résultats (le path retourné deviendrait cliquable côté UI).
                    if entry.is_symlink():
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        walk(entry.path)
                    elif q_lower in entry.name.lower():
                        rel = Path(entry.path).relative_to(root).as_posix()
                        results.append({"path": rel, "name": entry.name, "type": "file"})
            except Exception:
                _errs["n"] += 1                    # E7 : compté, plus avalé
                if _is_root:
                    _errs["root_failed"] = True

        walk(root, _is_root=True)
        if _errs["root_failed"]:
            raise HTTPException(503, "Sandbox illisible (droits ou conteneur "
                                     "arrêté) — recherche impossible.")
        return {"items": results[:MAX_HITS], "errors": _errs["n"],
                "truncated": _errs["truncated"]}

    # mode=content — grep-like full-text search
    results = []
    q_lower = q.lower()
    SKIP_EXTS = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg',
                 '.woff', '.woff2', '.ttf', '.eot', '.pdf', '.zip', '.tar',
                 '.gz', '.bin', '.exe', '.so', '.pyc', '.db', '.sqlite'}
    MAX_FILE = 512 * 1024   # 512 KB
    MAX_FILES_SCANNED = 5000  # même ordre que /grep
    _scanned = 0
    truncated = False

    root_resolved = root.resolve()
    _file_errs = 0
    _walk_errs = {"root_failed": False}

    def _on_walk_error(err):
        # E7 — os.walk avale les erreurs par défaut (onerror=None) : une
        # racine illisible produisait un résultat vide « propre ».
        if getattr(err, "filename", None) == str(root):
            _walk_errs["root_failed"] = True

    for dirpath, dirnames, filenames in os.walk(root, followlinks=False,
                                                onerror=_on_walk_error):
        if (len(results) >= MAX_HITS or _scanned >= MAX_FILES_SCANNED
                or time.monotonic() > _deadline):
            truncated = True
            break
        # Skip hidden / node_modules / __pycache__
        dirnames[:] = [d for d in dirnames
                       if not d.startswith('.') and d not in ('node_modules', '__pycache__', '.git')]
        for fname in filenames:
            if len(results) >= MAX_HITS or _scanned >= MAX_FILES_SCANNED:
                truncated = True
                break
            fpath = Path(dirpath) / fname
            if fpath.suffix.lower() in SKIP_EXTS:
                continue
            # SECURITY FIX : os.walk(followlinks=False) bloque les RÉPERTOIRES
            # symlinkés mais pas les FICHIERS symlinkés, que read_text() suit.
            # Un user peut faire `ln -s /etc/passwd leak.txt` (ou pointer vers
            # la sandbox d'un autre user) et lire des fichiers hôte/cross-tenant.
            # On skippe les symlinks et on confirme via _path_inside que le
            # fichier résolu reste sous la racine — comme le fait /grep.
            try:
                if fpath.is_symlink():
                    continue
                if not _path_inside(fpath.resolve(), root_resolved):
                    continue
            except (OSError, RuntimeError):
                continue
            try:
                if fpath.stat().st_size > MAX_FILE:
                    continue
                text = fpath.read_text(encoding="utf-8", errors="replace")
                _scanned += 1
                # Filtre rapide : la très grande majorité des fichiers ne
                # contient pas la chaîne — un seul ``in`` sur le texte entier
                # évite de découper et de minusculiser chaque ligne.
                if q_lower not in text.lower():
                    continue
                rel = fpath.relative_to(root).as_posix()
                for lineno, line in enumerate(text.splitlines(), 1):
                    if q_lower in line.lower():
                        # Find column of first match
                        col = line.lower().index(q_lower) + 1
                        # Short preview centred on the match
                        preview = line.strip()
                        if len(preview) > 120:
                            start = max(0, col - 40)
                            preview = ('…' if start > 0 else '') + line[start:start + 120].strip() + '…'
                        results.append({
                            "path":    rel,
                            "name":    fname,
                            "line":    lineno,
                            "col":     col,
                            "preview": preview,
                        })
                        if len(results) >= MAX_HITS:
                            break
            except Exception:
                _file_errs += 1                    # E7 : compté, plus avalé

    if _walk_errs["root_failed"]:
        raise HTTPException(503, "Sandbox illisible (droits ou conteneur "
                                 "arrêté) — recherche impossible.")
    return {"items": results, "errors": _file_errs, "truncated": truncated}


# ─────────────────────────────────────────────────────────────────────────────
#  READ / WRITE
# ─────────────────────────────────────────────────────────────────────────────
def _read_consistent(p: Path, attempts: int = 3):
    """``(octets, stat)`` d'un fichier ≤ ``_DOWNLOAD_SHA_MAX`` lus d'un seul
    tenant (stat identique avant et après la lecture), ou ``None`` (trop gros,
    illisible, ou réécrit en place à chaque tentative → repli en flux)."""
    for _ in range(attempts):
        try:
            with open(p, "rb") as f:
                st1 = os.fstat(f.fileno())
                if st1.st_size > _DOWNLOAD_SHA_MAX:
                    return None
                data = f.read(_DOWNLOAD_SHA_MAX + 1)
                st2 = os.fstat(f.fileno())
        except OSError:
            return None
        if len(data) > _DOWNLOAD_SHA_MAX:
            return None
        if (st1.st_mtime_ns == st2.st_mtime_ns and st1.st_size == st2.st_size
                and len(data) == st2.st_size):
            return data, st2
    return None


# ── Archives de téléchargement : sur DISQUE, jamais en mémoire ──────────────
# Passe sandbox 2026-09-26 — les deux routes de zip construisaient l'archive
# dans un ``io.BytesIO`` : un dossier de 3 Go (dataset, node_modules)
# télécharge « en un clic » = 3 Go de RAM du worker (OOM possible ; quelques
# clics en parallèle suffisaient), sans aucun plafond côté dossier. L'archive
# est désormais écrite dans un fichier temporaire sous SANDBOX_DIR (disque ; le
# /tmp de la machine est un tmpfs, donc de la RAM), servi puis supprimé.
_ZIP_DIR_MAX_BYTES = 1024 * 1024 * 1024        # 1 Gio de fichiers source
_ZIP_DIR_MAX_FILES = 20_000                     # aligné sur le plafond de /tree


class _ZipTooBig(Exception):
    pass


def _zip_spool_dir() -> Path:
    from shared_infra.config import SANDBOX_DIR
    d = Path(SANDBOX_DIR) / ".dl_spool"
    d.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Restes d'un worker tué en plein envoi : purgés au passage (> 1 h).
    try:
        cutoff = time.time() - 3600
        for f in d.iterdir():
            try:
                if f.is_file() and f.stat().st_mtime < cutoff:
                    f.unlink()
            except OSError:
                pass
    except OSError:
        pass
    return d


def _spool_zip(entries, *, max_bytes: int, max_files: int, strict: bool):
    """Écrit ``entries`` (itérable de ``(chemin, nom_dans_l_archive)``) dans un
    zip temporaire sur disque. Retourne ``(chemin_zip, nb_fichiers)``.

    ``strict`` : au-delà des plafonds, lève ``_ZipTooBig`` (dossier : une
    archive tronquée en silence tromperait l'utilisateur) ; sinon s'arrête et
    rend ce qui est déjà écrit (multi-fichiers : comportement historique)."""
    import tempfile
    fd, tmp = tempfile.mkstemp(prefix="dl-", suffix=".zip", dir=str(_zip_spool_dir()))
    os.close(fd)
    total = written = 0
    try:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            for abs_file, arc in entries:
                try:
                    size = abs_file.stat().st_size
                except OSError:
                    continue
                if total + size > max_bytes or written + 1 > max_files:
                    if strict:
                        raise _ZipTooBig()
                    break
                try:
                    zf.write(abs_file, arcname=arc)
                except OSError:
                    continue
                total += size
                written += 1
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return tmp, written


def _zip_response(tmp: str, filename: str, extra_headers=None) -> FileResponse:
    from starlette.background import BackgroundTask
    headers = dict(extra_headers or {})
    return FileResponse(tmp, media_type="application/zip", filename=filename,
                        headers=headers, background=BackgroundTask(_unlink_quiet, tmp))


def _unlink_quiet(p: str) -> None:
    try:
        os.unlink(p)
    except OSError:
        pass


@router.get("/api/sandbox/download")
def api_download_sandbox_file(request: Request, path: str):
    user_id = require_user_id(request)
    root = _get_work_path(user_id)
    target_path = (root / _strip_work_prefix(path)).resolve()
    # SECURITY FIX : cf. _path_inside (anti path-traversal cross-users).
    if not _path_inside(target_path, root):
        raise HTTPException(403, "Access denied")
    if not target_path.exists():
        raise HTTPException(404, "Not found")

    # If it's a file, serve directly
    if target_path.is_file():
        # PASSE 11 — expose le mtime du fichier via header custom pour
        # que le frontend puisse détecter les modifications externes
        # ultérieures (cf. /api/sandbox/check-mtimes).
        #
        # Audit éditeur 2026-09-23 (E6) — ``X-Sha256`` et ``X-Size`` décrivent
        # les MÊMES octets que ceux servis : lecture unique par un descripteur
        # (un ``mv`` concurrent remplace l'inode, pas notre lecture) et
        # ``fstat`` avant/après ; une écriture EN PLACE pendant la lecture
        # relance la lecture. Requête ``Range`` (visionneuse hex) ou fichier
        # > 64 Mio : servi en flux comme avant, sans ``X-Sha256``.
        if "range" not in request.headers:
            served = _read_consistent(target_path)
            if served is not None:
                data, st = served
                from fastapi.responses import Response
                from urllib.parse import quote as _q
                mt = mimetypes.guess_type(target_path.name)[0] or "text/plain"
                resp = Response(data, media_type=mt)
                fname = target_path.name
                qn = _q(fname)
                resp.headers["Content-Disposition"] = (
                    f"attachment; filename*=utf-8''{qn}" if qn != fname
                    else f'attachment; filename="{fname}"')
                _no_cache(resp)
                resp.headers["X-Mtime"] = str(st.st_mtime)
                resp.headers["X-Size"] = str(len(data))
                resp.headers["X-Sha256"] = sha256_bytes(data)
                resp.headers["Access-Control-Expose-Headers"] = "X-Mtime, X-Sha256, X-Size"
                return resp
        try:
            _st = target_path.stat()
            mtime_header, size_header = str(_st.st_mtime), str(_st.st_size)
        except OSError:
            mtime_header = size_header = ""
        resp = _no_cache(FileResponse(target_path, filename=target_path.name))
        if mtime_header:
            resp.headers["X-Mtime"] = mtime_header
            resp.headers["X-Size"] = size_header
            resp.headers["Access-Control-Expose-Headers"] = "X-Mtime, X-Size"
        return resp

    # If it's a folder, zip it (on disk) and serve
    folder_name = target_path.name or "folder"
    target_resolved = target_path.resolve()

    def _entries():
        for dirpath, dirnames, filenames in os.walk(target_path, followlinks=False):
            for fn in filenames:
                abs_file = Path(dirpath) / fn
                # SECURITY FIX : os.walk(followlinks=False) bloque les RÉPERTOIRES
                # symlinkés mais pas les FICHIERS symlinkés, que zf.write() suit.
                # Un user peut faire `ln -s /etc/passwd leak` (ou pointer vers la
                # base SQLite / le sandbox d'un autre user) et exfiltrer des
                # fichiers hôte/cross-tenant via le zip. On skippe les symlinks et
                # on confirme via _path_inside que le fichier résolu reste sous la
                # racine — comme le font /search et /grep.
                try:
                    if abs_file.is_symlink():
                        continue
                    if not _path_inside(abs_file.resolve(), target_resolved):
                        continue
                except (OSError, RuntimeError):
                    continue
                arc_name = str(abs_file.relative_to(target_path))
                yield abs_file, f"{folder_name}/{arc_name}"

    try:
        tmp, _n = _spool_zip(_entries(), max_bytes=_ZIP_DIR_MAX_BYTES,
                             max_files=_ZIP_DIR_MAX_FILES, strict=True)
    except _ZipTooBig:
        raise HTTPException(
            413, "Dossier trop volumineux pour une archive "
                 f"(> {_ZIP_DIR_MAX_BYTES // (1024 * 1024)} Mo ou "
                 f"{_ZIP_DIR_MAX_FILES} fichiers) — téléchargez-le par parties.")
    return _zip_response(tmp, f"{folder_name}.zip")


@router.post("/api/sandbox/download-multi")
async def api_download_multi_sandbox_files(request: Request):
    """Zip-stream plusieurs fichiers identifiés par leurs chemins.

    Utilisé par le diff card côté chat (mode editor disabled) pour
    permettre à l'utilisateur de récupérer en un clic tous les
    fichiers modifiés par l'agent dans un même message assistant.

    Body JSON
    ---------
        { "paths": ["src/a.py", "static/b.css", ...] }

    Comportement
    ------------
      * silently skip les paths qui sortent de la sandbox (anti
        path-traversal cross-users) ou qui n'existent plus -- on
        ne casse pas tout le téléchargement parce qu'un fichier
        a été supprimé entre-temps.
      * dossiers ignorés (le endpoint single ``download`` les zippe
        déjà ; ici on est strictement multi-FILE).
      * collisions de basename résolues côté zip via le path relatif
        à la sandbox (preserve la structure d'arborescence).
      * limite raisonnable de 500 fichiers/200 MB pour éviter qu'un
        client malicieux n'explose la mémoire serveur.
    """
    user_id = require_user_id(request)
    root = _get_work_path(user_id)

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON body")

    paths = body.get("paths") if isinstance(body, dict) else None
    if not isinstance(paths, list) or not paths:
        raise HTTPException(400, "Missing 'paths' (non-empty list expected)")

    # Garde-fou anti-DoS : si quelqu'un poste 100k paths, on coupe.
    if len(paths) > 500:
        raise HTTPException(413, "Too many paths (max 500)")

    MAX_TOTAL_BYTES = 200 * 1024 * 1024     # 200 MB cumulés

    # AUDIT 2026-09-01 (passe 5, B3) — jusqu'à 500 fichiers / 200 Mo lus +
    # compressés (DEFLATE) : construction en thread. Passe sandbox 2026-09-26 :
    # l'archive est écrite sur DISQUE (``_spool_zip``) au lieu d'un BytesIO de
    # 200 Mo par requête.
    def _entries():
        for raw in paths:
            if not isinstance(raw, str) or not raw:
                continue
            try:
                target_path = (root / _strip_work_prefix(raw)).resolve()
            except Exception:
                continue
            # SECURITY : pas de path-traversal cross-users.
            if not _path_inside(target_path, root):
                continue
            if not target_path.is_file():
                continue
            try:
                yield target_path, str(target_path.relative_to(root))
            except ValueError:
                continue

    # Au-delà de la limite : on renvoie ce qui est déjà écrit (succès partiel,
    # comportement historique) ; un fichier illisible est sauté.
    tmp, written = await asyncio.to_thread(
        _spool_zip, _entries(), max_bytes=MAX_TOTAL_BYTES, max_files=500, strict=False)

    if written == 0:
        _unlink_quiet(tmp)
        raise HTTPException(404, "No file could be added to the archive")

    # Indication informative : nb fichiers réellement zippés
    # (parfois < len(paths) si des fichiers ont disparu).
    return _zip_response(tmp, "files.zip", {"X-Files-Zipped": str(written)})


@router.post("/api/sandbox/upload")
async def api_upload_sandbox_files(
    request: Request,
    files: List[UploadFile] = File(...),
    paths: List[str] = Form(...),
):
    """Upload one or more files into the user's sandbox.

    PASSE 15 — Chaque fichier est écrit via ``docker exec`` (UID 10001),
    pas par ``Path.write_bytes`` direct sur l'host. Cela paie une demi-
    douzaine de ms par fichier en overhead docker exec, mais garantit
    l'uniformité d'ownership avec les fichiers créés par le terminal
    et le LLM. Sans ce changement, un upload depuis l'éditeur produisait
    un fichier inéditable depuis le terminal sandbox.
    """
    user_id = require_user_id(request)
    root = _get_work_path(user_id)
    # Per-user quota override
    _quota_mb_up = _user_quota_mb(user_id)
    # Plafond PAR FICHIER (MAX_UPLOAD_BYTES par défaut 50 Mo).
    # Garde-fou contre un user qui upload un fichier de 5 Go par erreur :
    # sans limite on faisait ``await file.read()`` qui charge TOUT en RAM
    # → OOM du worker + freeze event loop.
    from shared_infra.files.uploads import read_upload_bounded
    from shared_infra.config import MAX_UPLOAD_BYTES
    from shared_infra.sandbox.exec_bridge import sandbox_write_bytes
    saved = 0
    skipped = []
    mtimes = {}   # PASSE 14 — mtime par fichier sauvé, idem que /save
    hashes = {}   # 2026-09-23 — sha256 des octets écrits, par fichier
    # PERF (gros dossiers) — avant, on recalculait la taille TOTALE de la
    # sandbox (``_sandbox_size_bytes`` = os.walk complet) POUR CHAQUE fichier
    # → O(fichiers × arbre). Un import de plusieurs milliers de fichiers
    # rampait (et grossissait à mesure que l'arbo gonflait). On lit la taille
    # de base UNE fois, puis on suit un compteur incrémental ``_running_used``.
    # Le lock par-uid sérialise toujours l'écriture ; une légère dérive sous
    # écritures concurrentes (autre /save en parallèle) est tolérable pour un
    # quota « soft » et s'auto-corrige à la requête suivante.
    _running_used = (await asyncio.to_thread(
        sandbox_usage_bytes, user_id, root,
        quota_bytes=_quota_mb_up * 1024 * 1024)) if _quota_mb_up > 0 else 0
    _usage_delta = 0        # cumul écrit, reporté au cache en fin de batch
    for file, rel_path in zip(files, paths):
        # rel_path comes from webkitRelativePath or just filename
        safe = (root / _strip_work_prefix(rel_path)).resolve()
        # SECURITY FIX : cf. _path_inside (anti path-traversal cross-users).
        if not _path_inside(safe, root):
            skipped.append({"path": rel_path, "reason": "path_escape"})
            continue
        # Un DOSSIER porte déjà ce nom : ``mv tmp "$1"`` (exec_bridge) rangerait
        # le fichier À L'INTÉRIEUR sous un nom temporaire au lieu de le poser.
        if safe.is_dir():
            skipped.append({"path": rel_path, "reason": "is_directory"})
            continue
        try:
            file_bytes = await read_upload_bounded(file, MAX_UPLOAD_BYTES)
        except HTTPException:
            # Plafond dépassé : on skip ce fichier, pas tout le batch.
            skipped.append({"path": rel_path, "reason": "too_large"})
            continue
        # ── Quota check + écriture sous lock asyncio (anti-TOCTOU) ──
        # Sérialise par-uid avec api_save_sandbox_file pour empêcher
        # qu'un upload+save concurrent dépasse silencieusement le quota.
        async with _quota_lock_for(user_id):
            _existing_up = 0
            if _quota_mb_up > 0:
                # ``is_file`` et non ``exists`` : un DOSSIER du même nom a un
                # ``st_size`` de bloc (4096) qui n'est pas un écrasement.
                _existing_up = safe.stat().st_size if safe.is_file() else 0
                if _running_used + len(file_bytes) - _existing_up > _quota_mb_up * 1024 * 1024:
                    skipped.append({"path": rel_path, "reason": "quota_exceeded"})
                    continue
            # PASSE 15 — écriture via docker exec (UID 10001). Le helper
            # gère mkdir -p du parent, l'atomicité (write tmp + mv), et
            # l'umask 0002 pour donner mode 0664 (cross-readable).
            try:
                # Audit éditeur 2026-09-23 : verrou du fichier (partagé avec
                # l'assistant) + historique de session (source « upload »).
                async with _file_lock(safe):
                    _before = await _hist_before(safe)
                    await sandbox_write_bytes(user_id, rel_path, file_bytes)
                    try:
                        mtimes[rel_path] = safe.stat().st_mtime
                    except OSError:
                        pass
                hashes[rel_path] = sha256_bytes(file_bytes)
                saved += 1
                _usage_delta += len(file_bytes) - _existing_up
                if _quota_mb_up > 0:
                    _running_used += len(file_bytes) - _existing_up
                await _hist_write(user_id, _strip_work_prefix(rel_path), _before,
                                  file_bytes, "upload")
            except HTTPException as he:
                # Container down ou autre erreur exec — on ne casse pas
                # tout le batch ; ce fichier est skipped, les suivants
                # ré-essaient (la 1re tentative aura déclenché ensure_running
                # si possible, donc les suivantes voient un container up).
                skipped.append({"path": rel_path, "reason": f"exec_failed: {he.detail}"})
    # Delta connu → on ajuste le compteur au lieu de l'invalider : la jauge
    # est juste immédiatement, sans relancer de ``du`` sur tout l'arbre.
    if _usage_delta:
        bump_sandbox_usage(user_id, _usage_delta)
    return {"ok": True, "saved": saved, "skipped": skipped, "mtimes": mtimes,
            "sha256s": hashes}


# Marge au-dessus du chunk client (8 Mo) : tolère un chunk un peu plus gros
# sans pour autant accepter qu'un client envoie un « chunk » de 1 Go en RAM.
_UPLOAD_CHUNK_HARD_CAP = 32 * 1024 * 1024

# AUDIT 2026-08-02 (E4) — suffixe DÉDIÉ pour les tmp d'upload chunké. L'ancien
# ``.part`` était ambigu : le balayage de maintenance supprimait alors tout
# fichier utilisateur ``*.part``. Ce suffixe n'est porté par aucun fichier
# utilisateur → le sweep (``maintenance._sweep_orphan_part_files``) ne cible
# QUE les vrais tmp abandonnés. Déterministe (stable entre chunks du même
# upload, qui partagent ``rel_path``).
UPLOAD_TMP_SUFFIX = ".elpis-upload.part"

# 2026-09-16 — identifiant d'IMPORT fourni par le client (``upload_id``) : deux
# onglets qui importaient le même gros fichier écrivaient le MÊME ``.part`` et
# entrelaçaient leurs morceaux (fichier corrompu). Il s'insère AVANT le suffixe
# dédié, que le balayage de maintenance continue donc de reconnaître.
_UPLOAD_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")


def _upload_tmp_rel(rel_path: str, upload_id: str) -> str:
    """Chemin relatif du tmp d'un upload chunké (sans ``upload_id`` : nom
    historique, pour un client plus ancien)."""
    if upload_id:
        if not _UPLOAD_ID_RE.match(upload_id):
            raise HTTPException(400, "upload_id invalide")
        return f"{rel_path}.{upload_id}{UPLOAD_TMP_SUFFIX}"
    return rel_path + UPLOAD_TMP_SUFFIX


def _host_file_size(p: Path):
    """Taille vue de l'HÔTE, ou ``None`` si le fichier n'y est pas visible
    (absent, dossier, droits). ``None`` ≠ 0 : les gardes de taille ne tranchent
    que sur ce qu'elles voient vraiment — jamais sur un stat raté."""
    try:
        return p.stat().st_size if p.is_file() else None
    except OSError:
        return None


def _fmt_octets(n: int) -> str:
    """« 12,4 Go » / « 850 Mo » / « 42 Ko » — messages de refus."""
    n = max(0, int(n))
    for seuil, unite in ((1024 ** 3, "Go"), (1024 ** 2, "Mo"), (1024, "Ko")):
        if n >= seuil:
            return f"{n / seuil:.1f}".replace(".", ",").replace(",0", "") + " " + unite
    return f"{n} o"


@router.post("/api/sandbox/upload-chunk")
async def api_upload_sandbox_chunk(request: Request):
    """Upload chunké/streamé d'UN gros fichier — mémoire bornée.

    L'upload multipart classique (``/api/sandbox/upload``) charge chaque
    fichier ENTIER en RAM (plafonné à ``MAX_UPLOAD_BYTES`` = 50 Mo) puis le
    repasse via stdin de ``docker exec`` : impossible pour un fichier de 1 Go
    (rejeté « too_large », ou OOM si on levait le plafond).

    Ici le client découpe le fichier en chunks séquentiels et POST chacun
    avec le corps = octets bruts du chunk et les métadonnées en query :
        ?path=<rel>&index=<i>&total=<n>&size=<octets_totaux>[&upload_id=<id>]
    - 1er chunk (index 0) : crée le ``.part`` (truncate) + check quota ;
    - chunks suivants : append ;
    - dernier chunk : ``mv .part → fichier final``.
    Aucun côté ne bufferise le fichier entier.

    2026-09-16 — la taille DÉCLARÉE n'est plus crue sur parole : le contrôle
    du 1er chunk se fait sous le verrou de quota (en déduisant le fichier
    écrasé et un ``.part`` précédent), un fichier seul ne peut pas dépasser le
    plafond d'un import (``app.sandbox_import_max_pct``), le cumul reçu ne peut
    pas dépasser la taille déclarée, et le fichier n'est promu que si sa
    taille finale est exactement celle annoncée.
    """
    user_id = require_user_id(request)
    root = _get_work_path(user_id)
    qp = request.query_params
    rel_path = qp.get("path") or ""
    try:
        index = int(qp.get("index", "0"))
        total = int(qp.get("total", "1"))
        total_size = int(qp.get("size", "0"))
    except ValueError:
        raise HTTPException(400, "Paramètres chunk invalides")
    if not rel_path or total < 1 or index < 0 or index >= total or total_size < 0:
        raise HTTPException(400, "Paramètres chunk invalides")

    rel_norm = _strip_work_prefix(rel_path)
    safe = (root / rel_norm).resolve()
    # SECURITY : anti path-traversal cross-users (cf. _path_inside).
    if not _path_inside(safe, root):
        raise HTTPException(403, "Hors sandbox")
    # IMPORTANT — pass the ORIGINAL rel_path (not the pre-stripped rel_norm)
    # to the _sandbox_exec helpers: they strip the /work prefix exactly once
    # internally (like every other editor route). Passing rel_norm caused a
    # SECOND strip, so for a user with a real top-level folder named 'work'
    # the chunk landed at the sandbox root while the host check used
    # rel_norm — host and container diverged. tmp = "<rel>"+SUFFIX so the
    # single strip yields "<rel_norm>"+SUFFIX at the same dir as the final.
    tmp_rel = _upload_tmp_rel(rel_path, qp.get("upload_id") or "")
    tmp_host = (root / _strip_work_prefix(tmp_rel)).resolve()
    if not _path_inside(tmp_host, root):
        raise HTTPException(403, "Hors sandbox")

    data = await request.body()
    if len(data) > _UPLOAD_CHUNK_HARD_CAP:
        raise HTTPException(413, "Chunk trop volumineux")

    from shared_infra.sandbox.exec_bridge import (
        sandbox_append_chunk, sandbox_delete, sandbox_rename)

    if index == 0:
        # Un DOSSIER porte ce nom : ``mv`` rangerait le fichier dedans au lieu
        # de le poser (et le ``.part`` ne serait jamais promu).
        if safe.is_dir():
            raise HTTPException(409, "Un dossier porte déjà ce nom")
        # Quota vérifié UNE fois (au 1er chunk), SOUS LE VERROU de quota comme
        # ``/upload`` et ``/save`` : sans lui, deux onglets passaient le
        # contrôle ensemble puis écrivaient tous les deux.
        async with _quota_lock_for(user_id):
            cap = await asyncio.to_thread(_import_capacity, user_id, root, fresh=False)
            # Octets que ce fichier AJOUTE : l'écrasé et un ``.part`` laissé par
            # une tentative précédente (tronqué ci-dessous) sont déjà comptés
            # dans l'usage.
            _net = total_size - (_host_file_size(safe) or 0)
            _stale_part = _host_file_size(tmp_host) or 0
            if cap["limit_bytes"] is not None and _net > cap["limit_bytes"]:
                raise HTTPException(
                    413, f"Import trop volumineux (limite {_fmt_octets(cap['limit_bytes'])}, "
                         f"{cap['max_pct']} % de la sandbox)")
            if not cap["unlimited"]:
                if cap["used_bytes"] - _stale_part + _net > cap["quota_bytes"]:
                    raise HTTPException(
                        413, f"Quota sandbox dépassé ({cap['quota_bytes'] // (1024 * 1024)} Mo)")
            elif cap["remaining_bytes"] is not None and _net > cap["remaining_bytes"]:
                raise HTTPException(413, "Espace disque insuffisant")
            await sandbox_append_chunk(user_id, tmp_rel, data, truncate=True)
    else:
        # Import ANNULÉ entre deux chunks (``DELETE`` ci-dessous) : un append
        # recréerait un ``.part`` orphelin avec ce seul morceau. On ne tranche
        # que si le dossier parent est visible de l'hôte (sinon : pas de garde).
        if tmp_host.parent.is_dir() and not tmp_host.exists():
            raise HTTPException(409, "Import interrompu")
        await sandbox_append_chunk(user_id, tmp_rel, data, truncate=False)

    # Le cumul reçu ne dépasse JAMAIS la taille déclarée : sinon un client
    # annonçait 1 octet au contrôle de quota puis en envoyait 1 Go.
    _received = await asyncio.to_thread(_host_file_size, tmp_host)
    _last = index >= total - 1
    if _received is not None and (_received > total_size or (_last and _received != total_size)):
        try:
            await sandbox_delete(user_id, tmp_rel)
        except HTTPException:
            pass
        invalidate_sandbox_usage(user_id)
        raise HTTPException(400, "Taille reçue incohérente — import du fichier annulé")

    if _last:
        # Dernier chunk : promotion atomique du .part en fichier final.
        # Audit éditeur 2026-09-23 (E4) — ÉCRASE un fichier existant (le
        # quota et ``/upload-precheck`` comptent déjà l'écrasement ; seul un
        # dossier homonyme reste refusé). En cas d'échec, le ``.part`` est
        # retiré au lieu de rester sur disque (arbre, quota).
        async with _file_lock(safe):
            _before = await _hist_before(safe)
            try:
                await sandbox_rename(user_id, tmp_rel, rel_path, overwrite=True)
            except HTTPException:
                try:
                    await sandbox_delete(user_id, tmp_rel)
                except HTTPException:
                    pass
                invalidate_sandbox_usage(user_id)
                raise
            _st = await asyncio.to_thread(_file_state, safe, sha_max=_DOWNLOAD_SHA_MAX)
        new_mtime = _st.get("mtime")
        # Historique (source « upload ») : contenu relu (fichier ≤ 5 Mo gardé).
        try:
            await asyncio.to_thread(_fh.record_file_write, user_id,
                                    _strip_work_prefix(rel_path), _before, safe, "upload")
        except Exception:                                       # noqa: BLE001
            logger.exception("[sandbox] historique upload-chunk")
        # Taille finale réelle (on ne connaît pas l'ancienne : le fichier a été
        # écrasé) → invalidation plutôt que bump.
        invalidate_sandbox_usage(user_id)
        return {"ok": True, "done": True, "path": rel_path, "mtime": new_mtime,
                "sha256": _st.get("sha256")}
    return {"ok": True, "done": False}


@router.delete("/api/sandbox/upload-chunk")
async def api_abort_sandbox_chunk(request: Request, path: str = "", upload_id: str = ""):
    """Annulation d'un upload chunké : supprime SON ``.part`` (2026-09-16).

    Idempotent (``removed: false`` si rien à supprimer). Ne peut viser qu'un
    tmp d'upload : le chemin est TOUJOURS reconstruit avec le suffixe dédié,
    jamais pris tel quel — impossible d'effacer un fichier utilisateur par
    cette route."""
    user_id = require_user_id(request)
    if not path:
        raise HTTPException(400, "Chemin requis")
    root = _get_work_path(user_id)
    tmp_rel = _upload_tmp_rel(path, upload_id)
    tmp_host = (root / _strip_work_prefix(tmp_rel)).resolve()
    if not _path_inside(tmp_host, root):
        raise HTTPException(403, "Hors sandbox")
    if not tmp_host.exists():
        return {"ok": True, "removed": False}
    from shared_infra.sandbox.exec_bridge import sandbox_delete
    await sandbox_delete(user_id, tmp_rel)
    invalidate_sandbox_usage(user_id)
    return {"ok": True, "removed": True}


#: Au-delà, le pré-contrôle ne regarde plus fichier par fichier (écrasements
#: non déduits) : il juge sur la taille totale annoncée. Même ordre de grandeur
#: que le plafond de l'arbre (``TREE_MAX_ENTRIES``).
_PRECHECK_MAX_ENTRIES = 20000


@router.post("/api/sandbox/upload-precheck")
async def api_upload_precheck(request: Request):
    """Un import tiendra-t-il ? Répond AVANT le moindre envoi (2026-09-16).

    Corps : ``{"files": [{"path", "size"}, …], "total_bytes": n}``. Sans ce
    contrôle, un dossier trop gros s'importait à moitié puis butait sur le
    quota : le pré-contrôle refuse l'import entier s'il dépasse le plafond
    d'un import (``app.sandbox_import_max_pct`` de la capacité) ou l'espace
    restant.

    * Usage EXACT (``du`` frais), pas le cache 30 s de la jauge.
    * ``needed_bytes`` = ce que l'import AJOUTE : un fichier qui en écrase un
      autre ne compte que sa croissance (même règle que ``/upload``).
    * Au-delà de ``_PRECHECK_MAX_ENTRIES`` fichiers : taille totale seule.
    * Le serveur reste l'autorité pendant l'import (quota par fichier).
    """
    user_id = require_user_id(request)
    root = _get_work_path(user_id)
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(400, "JSON invalide")
    if not isinstance(data, dict) or not isinstance(data.get("files", []), list):
        raise HTTPException(400, "Corps invalide")
    files = data.get("files") or []
    try:
        declared_total = max(0, int(data.get("total_bytes") or 0))
    except (TypeError, ValueError):
        raise HTTPException(400, "total_bytes invalide")

    def _mesure() -> dict:
        detailed = 0 < len(files) <= _PRECHECK_MAX_ENTRIES
        total = needed = overwrite = escaped = 0
        if detailed:
            for f in files:
                if not isinstance(f, dict) or not isinstance(f.get("path"), str):
                    continue
                try:
                    size = max(0, int(f.get("size") or 0))
                except (TypeError, ValueError):
                    size = 0
                safe = (root / _strip_work_prefix(f["path"])).resolve()
                if not _path_inside(safe, root):
                    escaped += 1          # ``/upload`` les ignorera aussi
                    continue
                existing = _host_file_size(safe) or 0
                total += size
                overwrite += min(existing, size)
                needed += max(0, size - existing)
        else:
            total = needed = declared_total
        cap = _import_capacity(user_id, root, fresh=True)
        limit, remaining = cap["limit_bytes"], cap["remaining_bytes"]
        # Borne la plus STRICTE des deux : c'est elle que le message nomme.
        bornes = [(b, why) for b, why in ((limit, "import_limit"), (remaining, "remaining"))
                  if b is not None]
        allowed, reason = (min(bornes, key=lambda x: x[0]) if bornes else (None, ""))
        fits = allowed is None or needed <= allowed
        return {
            "fits": fits,
            "reason": "" if fits else reason,
            "allowed_bytes": allowed,
            "needed_bytes": needed,
            "total_bytes": total,
            "overwrite_bytes": overwrite,
            "escaped": escaped,
            "detailed": detailed,
            **cap,
        }

    return await asyncio.to_thread(_mesure)


# Écart toléré entre le mtime connu du client et celui du disque. Les deux
# viennent du même ``stat`` (en-tête X-Mtime, réponse de /save) et font l'aller-
# retour JSON sans perte : une vraie modification les sépare bien davantage.
_SAVE_MTIME_EPS = 0.0005


def _conflict_detail(missing: bool, state: Optional[dict], message: str, **extra) -> dict:
    """Corps du 412 (contrat front, audit éditeur 2026-09-23)."""
    state = state or {}
    d = {"code": "conflict", "missing": missing,
         "mtime": state.get("mtime") if not missing else None,
         "sha256": state.get("sha256") if not missing else None,
         "message": message}
    d.update(extra)
    return d


def _save_conflict(safe_path: Path, expected_mtime=None, expected_sha256=None):
    """Détail du 412 si le fichier a changé (ou disparu) depuis la version de
    référence de l'onglet, sinon None.

    Audit éditeur 2026-09-23 :
    * E6 — ``expected_sha256`` (hash du CONTENU) fait autorité quand il est
      fourni : un changement qui conserve le mtime (``cp -p``, ``touch -r``,
      deux écritures dans le même tick) ne passe plus. ``expected_mtime``
      reste accepté seul (clients plus anciens).
    * E26 — un ``stat`` qui lève ``PermissionError``/``NotADirectoryError``
      ne vaut plus « pas de précondition » : refus explicite.
    """
    st = _file_state(safe_path, sha_max=_DOWNLOAD_SHA_MAX)
    kind = st["kind"]
    if kind == "missing":
        return 412, _conflict_detail(True, None, "Le fichier a été supprimé du disque")
    if kind == "not_dir":
        return 409, {"code": "not_dir",
                     "message": "Un élément du chemin est un fichier, pas un dossier"}
    if kind == "unreadable":
        return 412, _conflict_detail(
            False, None, "Fichier illisible : impossible de vérifier qu'il n'a pas changé",
            unreadable=True)
    if kind == "dir":
        return 409, {"code": "is_dir", "message": "Un dossier porte ce nom"}
    if expected_sha256 is not None:
        if st.get("sha256") is None and not st.get("readable", True):
            return 412, _conflict_detail(
                False, st, "Fichier illisible : impossible de vérifier qu'il n'a pas changé",
                unreadable=True)
        if st.get("sha256") == expected_sha256:
            return None
        if st.get("sha256") is None and expected_mtime is not None:
            # Trop gros pour être haché : repli sur le mtime.
            if abs(st["mtime"] - float(expected_mtime)) <= _SAVE_MTIME_EPS:
                return None
        return 412, _conflict_detail(False, st, "Le fichier a changé sur le disque")
    if abs(st["mtime"] - float(expected_mtime)) <= _SAVE_MTIME_EPS:
        return None
    return 412, _conflict_detail(False, st, "Le fichier a changé sur le disque")


# Passe sandbox 2026-09-26 — plafond du contenu TEXTE de /save : seul le
# binaire (content_b64) était borné. Un ``content`` de 500 Mo était parsé par
# ``request.json()`` sur la boucle d'événements (gel de tout le worker), puis
# encodé et envoyé tel quel (≈ 3× la taille en RAM).
_SAVE_MAX_BYTES = 50 * 1024 * 1024


@router.post("/api/sandbox/save")
async def api_save_sandbox_file(request: Request):
    user_id = require_user_id(request)
    try:
        _cl = int(request.headers.get("content-length") or 0)
    except ValueError:
        _cl = 0
    if _cl > _SAVE_MAX_BYTES * 2:          # JSON échappé : marge ×2
        raise HTTPException(413, "Contenu trop volumineux pour l'éditeur "
                                 f"({_SAVE_MAX_BYTES // (1024 * 1024)} Mo max)")
    data = await request.json()
    if not isinstance(data, dict):
        raise HTTPException(400, "Corps JSON (objet) requis")
    rel_path = data.get("path")
    content = data.get("content")
    # ``content_b64`` : contenu BINAIRE (vignettes PNG des scripts d'automatisation,
    # ``automations/assets/*.png``) — décodé ici, écrit tel quel.
    raw_bytes = None
    if content is None and isinstance(data.get("content_b64"), str):
        import base64 as _b64
        try:
            raw_bytes = _b64.b64decode(data["content_b64"], validate=True)
        except Exception:
            raise HTTPException(400, "content_b64 invalide")
        if len(raw_bytes) > 8 * 1024 * 1024:
            raise HTTPException(413, "contenu binaire trop volumineux (8 Mo max)")
    if not rel_path or not isinstance(rel_path, str):
        raise HTTPException(400, "Path required")
    # BUG FIX : avant, ``content=None`` produisait un AttributeError sur
    # ``content.encode("utf-8")`` plus bas, attrapé par le ``except Exception``
    # générique → 500 confus pour le client. On valide explicitement.
    if raw_bytes is None and not isinstance(content, str):
        raise HTTPException(400, "Content (string) required")
    # Audit éditeur 2026-09-23 (E27) — un surrogate isolé (``"\ud800"`` en
    # JSON) n'est pas encodable en UTF-8 : 400 lisible, plus une 500.
    if raw_bytes is None:
        try:
            _payload = content.encode("utf-8")
        except UnicodeEncodeError:
            raise HTTPException(400, "Contenu invalide (caractère non encodable)")
    else:
        _payload = raw_bytes
    if len(_payload) > _SAVE_MAX_BYTES:
        raise HTTPException(413, "Contenu trop volumineux pour l'éditeur "
                                 f"({_SAVE_MAX_BYTES // (1024 * 1024)} Mo max)")
    root = _get_work_path(user_id)
    safe_path = (root / _strip_work_prefix(rel_path)).resolve()
    # SECURITY FIX : cf. _path_inside (anti path-traversal cross-users).
    if not _path_inside(safe_path, root):
        raise HTTPException(403, "Access denied")
    # Garde anti-corruption : du TEXTE ne remplace jamais un binaire existant
    # (xlsx/pdf/zip ouverts par erreur dans Monaco puis sauvegardés). Le
    # ``content_b64`` (binaire explicite) n'est pas concerné.
    if raw_bytes is None:
        from shared_infra.sandbox.filetypes import existing_file_is_binary
        if await asyncio.to_thread(existing_file_is_binary, safe_path):
            raise HTTPException(409, "Fichier binaire : sauvegarde refusée")
    # Création seule (« Nouveau fichier ») : un nom déjà pris n'est JAMAIS
    # vidé en silence. Détail structuré : le front propose d'ouvrir l'existant.
    _if_absent = bool(data.get("if_absent"))
    if _if_absent and safe_path.exists():
        raise HTTPException(409, {"code": "exists",
                                  "message": "Un fichier porte déjà ce nom"})
    # Précondition (2026-09-19) : ``expected_mtime`` = mtime de la version sur
    # laquelle l'onglet est fondé. Si le disque a bougé depuis (terminal,
    # outil de l'assistant, git), on refuse au lieu d'écraser en silence ;
    # l'éditeur propose Écraser / Comparer / Recharger.
    expected_mtime = data.get("expected_mtime")
    if expected_mtime is not None and (
            not isinstance(expected_mtime, (int, float)) or isinstance(expected_mtime, bool)):
        # Une précondition illisible ne doit JAMAIS valoir « pas de
        # précondition » : le client croirait son écriture protégée alors
        # qu'elle écrase sans contrôle.
        raise HTTPException(400, "expected_mtime invalide (nombre attendu)")
    # Audit éditeur 2026-09-23 (E6) — ``expected_sha256`` : hash du contenu de
    # référence (en-tête ``X-Sha256`` de /download, ``sha256`` de /save).
    expected_sha = data.get("expected_sha256")
    if expected_sha is not None:
        if not isinstance(expected_sha, str) or not _SHA_RE.match(expected_sha.lower()):
            raise HTTPException(400, "expected_sha256 invalide (64 caractères hexadécimaux)")
        expected_sha = expected_sha.lower()
    _source = "restore" if data.get("source") == "restore" else "editor"
    # PASSE 15 — Tous les writes passent désormais par ``docker exec
    # --user 10001:10001`` (cf. _sandbox_exec.sandbox_write_text). Cela
    # garantit l'uniformité de l'ownership UID=10001 sur TOUT le contenu
    # de la sandbox : files créés par le terminal, par le LLM (via les
    # MCPs), et par l'éditeur ont désormais le même propriétaire.
    # Conséquence : "rm" depuis le terminal fonctionne sur les fichiers
    # créés depuis l'éditeur, et la suppression depuis l'éditeur
    # fonctionne sur les dossiers créés depuis le terminal — la classe
    # de bugs "Permission denied parfois" disparaît à la racine.
    from shared_infra.sandbox.exec_bridge import sandbox_write_text, sandbox_write_bytes
    try:
        # ── Quota check + écriture sous lock asyncio (anti-TOCTOU) ────
        # Avant ce fix, deux saves concurrentes du même user pouvaient
        # toutes deux passer le check puis toutes deux écrire → quota
        # dépassé en silence. Le lock sérialise quota+écriture par-uid.
        #
        # Audit éditeur 2026-09-23 (E7) — EN PLUS, verrou du FICHIER, commun
        # avec les outils fs de l'assistant : une écriture de l'agent ne peut
        # plus tomber entre la précondition et le ``mv`` (ni le mtime rendu
        # être celui d'une écriture concurrente).
        async with _quota_lock_for(user_id), _file_lock(safe_path):
            # Précondition vérifiée SOUS les verrous.
            if expected_sha is not None or expected_mtime is not None:
                _conflict = await asyncio.to_thread(
                    _save_conflict, safe_path, expected_mtime, expected_sha)
                if _conflict is not None:
                    raise HTTPException(*_conflict)
            else:
                # E25 — sans précondition aussi : un DOSSIER porte ce nom →
                # refus (``mv`` y rangeait le fichier, réponse 200).
                if safe_path.is_dir():
                    raise HTTPException(409, {"code": "is_dir",
                                              "message": "Un dossier porte ce nom"})
            # ``if_absent`` RE-vérifié sous le verrou : deux créations
            # simultanées du même nom passaient toutes deux le contrôle
            # d'entrée, la seconde vidait le fichier de la première.
            if _if_absent and safe_path.exists():
                raise HTTPException(409, {"code": "exists",
                                          "message": "Un fichier porte déjà ce nom"})
            # ── Quota check (per-user override wins) ─────────────────
            _user_settings = get_user_settings(user_id)
            if "sandbox_quota_mb" in _user_settings:
                _quota_mb = int(_user_settings["sandbox_quota_mb"])
            else:
                _cfg = config_view() or {}
                _quota_mb = int(_cfg.get("app", {}).get("sandbox_quota_mb", 5120))
            _existing = safe_path.stat().st_size if safe_path.is_file() else 0
            _net_new = len(_payload) - _existing
            if _quota_mb > 0:
                # Cache + single-flight : sans ça, CHAQUE autosave relançait un
                # ``du -sb`` sur tout l'arbre. Près de la limite (≥ 90 %) le
                # helper recalcule en exact, donc l'enforcement reste fiable.
                _used_bytes = await asyncio.to_thread(
                    sandbox_usage_bytes, user_id, root,
                    quota_bytes=_quota_mb * 1024 * 1024)
                if _used_bytes + _net_new > _quota_mb * 1024 * 1024:
                    raise HTTPException(413, f"Quota sandbox dépassé ({_quota_mb} Mo)")
            # ─────────────────────────────────────────────────────────
            # Historique de session : contenu AVANT l'écriture.
            _before = await _hist_before(safe_path)
            _t = time.time()
            # Écriture via docker exec — pas de mkdir explicite, le helper
            # le fait dans le même shell-script (atomique côté FS via
            # write-tmp + mv).
            if raw_bytes is not None:
                await sandbox_write_bytes(user_id, rel_path, raw_bytes)
            else:
                await sandbox_write_text(user_id, rel_path, content)
            bump_sandbox_usage(user_id, _net_new)   # delta connu → pas de ``du``
            write_dur = round(time.time() - _t, 4)
            # PASSE 14 — Retourne le mtime serveur pour que le frontend
            # puisse mettre à jour fileMtimes sans avoir à deviner avec
            # Date.now() (qui causait des faux positifs "modifié sur
            # disque" en cas de dérive d'horloge navigateur/serveur).
            # Stat SOUS le verrou du fichier (E7) : c'est le mtime de NOTRE
            # écriture. Le ``sha256`` vient des octets envoyés, pas d'une
            # relecture.
            try:
                new_mtime = safe_path.stat().st_mtime
            except OSError:
                new_mtime = None
        await _hist_write(user_id, _strip_work_prefix(rel_path), _before, _payload, _source)
        ext = safe_path.suffix.lstrip(".")
        username = get_username_by_id(user_id) or f"user_{user_id}"
        log_metric("code_write_time", write_dur, {"ext": ext, "size": len(_payload), "user": username})
        log_metric("sandbox_write", 1, {"ext": ext, "size": len(_payload), "user": username})
        return {"ok": True, "size": len(_payload), "mtime": new_mtime,
                "sha256": sha256_bytes(_payload)}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Write error: {str(e)}")


# ─────────────────────────────────────────────────────────────────────────────
#  STRUCTURE
# ─────────────────────────────────────────────────────────────────────────────
@router.delete("/api/sandbox/delete")
async def api_delete_sandbox_item(request: Request, path: str):
    """Supprime un fichier ou un dossier de la sandbox.

    PASSE 15 — Délégué à ``docker exec rm -rf`` (UID 10001). Cela résout
    le cas où l'host (UID host) ne pouvait pas supprimer un dossier
    créé par le terminal (UID 10001) à cause de la mismatch d'ownership.
    """
    user_id = require_user_id(request)
    root = _get_work_path(user_id)
    target_path = (root / _strip_work_prefix(path)).resolve()
    # SECURITY FIX : cf. _path_inside (anti path-traversal cross-users).
    if not _path_inside(target_path, root):
        raise HTTPException(403, "Access denied")
    # Le exists() vit côté host — fonctionne pour tout fichier au moins
    # 0644 (le défaut via umask 0000 du container donne 0666 → OK). Si
    # l'host n'a pas le droit de stat (très rare — dossier 0700), on
    # laisse passer au docker exec qui répondra "No such file" et on
    # mappe en 404 ci-dessous.
    if not target_path.exists():
        raise HTTPException(404, "Not found")
    from shared_infra.sandbox.exec_bridge import sandbox_delete
    # Historique de session (audit éditeur 2026-09-23) : la suppression d'un
    # FICHIER est notée (contenu d'avant gardé) ; un dossier, non.
    _is_file = target_path.is_file() and not (root / _strip_work_prefix(path)).is_symlink()
    _before = await _hist_before(target_path) if _is_file else None
    try:
        await sandbox_delete(user_id, path)
        invalidate_sandbox_usage(user_id)   # taille supprimée inconnue
        if _is_file:
            await _hist_write(user_id, _strip_work_prefix(path), _before, None, "editor")
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Delete error: {str(e)}")


@router.post("/api/sandbox/clear")
async def api_clear_sandbox(request: Request):
    """Clear all files in the user's sandbox.

    PASSE 15 — Délégué à ``docker exec rm -rf /work/*`` au lieu d'un
    walk Python sur l'host (qui pouvait laisser des fichiers stuck
    par ownership UID 10001).
    """
    user_id = require_user_id(request)
    root = _get_work_path(user_id)
    if not root.exists():
        return {"ok": True, "deleted": 0}
    from shared_infra.sandbox.exec_bridge import sandbox_clear
    try:
        count = await sandbox_clear(user_id)
        invalidate_sandbox_usage(user_id)
        return {"ok": True, "deleted": count}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Clear error: {str(e)}")


@router.post("/api/sandbox/mkdir")
async def api_create_folder(request: Request):
    user_id = require_user_id(request)
    data = await request.json()
    rel_path = data.get("path")
    if not rel_path:
        raise HTTPException(400, "Path required")
    root = _get_work_path(user_id)
    target_path = (root / _strip_work_prefix(rel_path)).resolve()
    # SECURITY FIX : cf. _path_inside (anti path-traversal cross-users).
    if not _path_inside(target_path, root):
        raise HTTPException(403, "Access denied")
    # PASSE 15 — docker exec mkdir -p, owned UID 10001.
    from shared_infra.sandbox.exec_bridge import sandbox_mkdir
    try:
        await sandbox_mkdir(user_id, rel_path)
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Mkdir error: {str(e)}")


@router.post("/api/sandbox/rename")
async def api_rename_item(request: Request):
    user_id = require_user_id(request)
    data = await request.json()
    old_rel = data.get("old_path")
    new_rel = data.get("new_path")
    if not old_rel or not new_rel:
        raise HTTPException(400, "Old and new paths required")
    root = _get_work_path(user_id)
    old_path = (root / _strip_work_prefix(old_rel)).resolve()
    new_path = (root / _strip_work_prefix(new_rel)).resolve()
    # SECURITY FIX : cf. _path_inside (anti path-traversal cross-users).
    if not _path_inside(old_path, root) or not _path_inside(new_path, root):
        raise HTTPException(403, "Access denied")
    if not old_path.exists():
        raise HTTPException(404, "Source not found")
    # ``mv`` écrase une cible existante sans rien dire : renommer a.py en b.py
    # (ou déposer un fichier dans un dossier qui a déjà le même nom) détruisait
    # b.py. On refuse, le front affiche le message.
    if new_path != old_path and (new_path.exists() or new_path.is_symlink()):
        raise HTTPException(409, "Un élément porte déjà ce nom à cet endroit")
    # PASSE 15 — docker exec mv. mkdir -p du parent inclus dans le shell
    # script du helper. Même UID que le créateur d'origine si déjà 10001,
    # sinon mv préserve l'ownership existant (rename atomique sans copie
    # tant qu'on reste sur le même FS — le bind-mount /work est sur un
    # seul FS).
    from shared_infra.sandbox.exec_bridge import sandbox_rename
    try:
        await sandbox_rename(user_id, old_rel, new_rel)
        # L'historique de session suit le fichier (ou le dossier) renommé.
        try:
            await asyncio.to_thread(_fh.record_move, user_id,
                                    _strip_work_prefix(old_rel), _strip_work_prefix(new_rel))
        except Exception:                                       # noqa: BLE001
            logger.exception("[sandbox] historique : renommage non noté")
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Rename error: {str(e)}")


def _tree_size_bytes(p: Path) -> int:
    """Taille cumulée d'un fichier ou d'un dossier (liens non suivis)."""
    if p.is_symlink() or p.is_file():
        try:
            return p.lstat().st_size
        except OSError:
            return 0
    total = 0
    for dirpath, _dirs, files in os.walk(p, followlinks=False):
        for f in files:
            try:
                total += os.lstat(os.path.join(dirpath, f)).st_size
            except OSError:
                pass
    return total


@router.post("/api/sandbox/copy")
async def api_copy_item(request: Request):
    """Duplique un fichier ou un dossier (« Dupliquer » de l'explorateur).

    Cible existante → 409 (jamais d'écrasement) ; quota vérifié AVANT la
    copie avec la taille réelle de la source."""
    user_id = require_user_id(request)
    data = await request.json()
    src_rel = data.get("src")
    dst_rel = data.get("dst")
    if not src_rel or not dst_rel:
        raise HTTPException(400, "Source et destination requises")
    root = _get_work_path(user_id)
    src_path = (root / _strip_work_prefix(src_rel)).resolve()
    dst_path = (root / _strip_work_prefix(dst_rel)).resolve()
    if not _path_inside(src_path, root) or not _path_inside(dst_path, root):
        raise HTTPException(403, "Access denied")
    if not src_path.exists():
        raise HTTPException(404, "Source introuvable")
    if dst_path.exists() or dst_path.is_symlink():
        raise HTTPException(409, "Un élément porte déjà ce nom à cet endroit")
    if dst_path == src_path or _path_inside(dst_path, src_path):
        raise HTTPException(400, "Impossible de copier un dossier dans lui-même")
    from shared_infra.sandbox.exec_bridge import sandbox_copy
    async with _quota_lock_for(user_id):
        size = await asyncio.to_thread(_tree_size_bytes, src_path)
        _user_settings = get_user_settings(user_id)
        if "sandbox_quota_mb" in _user_settings:
            _quota_mb = int(_user_settings["sandbox_quota_mb"])
        else:
            _quota_mb = int((config_view() or {}).get("app", {}).get("sandbox_quota_mb", 5120))
        if _quota_mb > 0:
            used = await asyncio.to_thread(
                sandbox_usage_bytes, user_id, root,
                quota_bytes=_quota_mb * 1024 * 1024)
            if used + size > _quota_mb * 1024 * 1024:
                raise HTTPException(413, f"Quota sandbox dépassé ({_quota_mb} Mo)")
        await sandbox_copy(user_id, src_rel, dst_rel)
        bump_sandbox_usage(user_id, size)
    # Historique de session : une copie de FICHIER est une création.
    if src_path.is_file():
        _after = await _hist_before(dst_path)
        if _after is not None:
            await _hist_write(user_id, _strip_work_prefix(dst_rel), None, _after, "editor")
    return {"ok": True, "path": dst_rel}


# ─────────────────────────────────────────────────────────────────────────────
#  TOOLING
# ─────────────────────────────────────────────────────────────────────────────
@router.post("/api/sandbox/lint")
async def api_sandbox_lint(request: Request):
    """Lint Python code with ruff. Returns a list of diagnostics."""
    require_user_id(request)
    data = await request.json()
    code = data.get("content", "")
    fname = data.get("filename", "file.py")

    if not fname.endswith(".py"):
        return {"diagnostics": []}

    # AUDIT 2026-08-31 (passe 4, B5) — which + fork/exec ruff SYNC sur la
    # boucle, avec un debounce front de 800 ms → ~1 gel/s pendant la frappe
    # d'un .py dans l'éditeur. Tout le sous-processus part en thread.
    ruff_bin = await asyncio.to_thread(_find_ruff)
    if not ruff_bin:
        return {"diagnostics": [], "error": "ruff not found on server"}

    try:
        proc = await asyncio.to_thread(
            _sp.run,
            [ruff_bin, "check", "--stdin-filename", fname,
             "--output-format", "json", "--select", "E,F,W,I", "-"],
            input=code.encode("utf-8"),
            capture_output=True,
            timeout=10,
        )
        import json as _json
        raw = _json.loads(proc.stdout or "[]")
        diagnostics = [
            {
                "row":      d["location"]["row"],
                "col":      d["location"]["column"],
                "end_row":  d.get("end_location", {}).get("row", d["location"]["row"]),
                "end_col":  d.get("end_location", {}).get("column", d["location"]["column"] + 1),
                "code":     d["code"],
                "message":  d["message"],
                "severity": 8 if d["code"].startswith(("E", "F")) else 4,  # 8=error 4=warning
            }
            for d in raw
        ]
        return {"diagnostics": diagnostics}
    except Exception as e:
        return {"diagnostics": [], "error": str(e)}


_FORMAT_MAX_BYTES = 2 * 1024 * 1024


def _find_ruff() -> Optional[str]:
    """Chemin de ``ruff`` : le PATH, sinon le dossier de l'interpréteur.

    Un serveur lancé par ``venv/bin/gunicorn`` SANS venv activé (unité
    systemd, lancement direct) n'a pas ``venv/bin`` dans son PATH : ``which``
    ne voyait pas le ruff pourtant installé à côté de lui — lint muet et
    « Formater » en 501."""
    found = shutil.which("ruff")
    if found:
        return found
    import sys as _sys
    cand = Path(_sys.executable).parent / "ruff"
    return str(cand) if cand.is_file() and os.access(cand, os.X_OK) else None


@router.post("/api/sandbox/format")
async def api_sandbox_format(request: Request):
    """Formate du Python avec ``ruff format`` (« Formater le document »).

    Rend ``{"content": ...}`` ; une erreur de syntaxe revient en 422 avec le
    message de ruff (le document n'est pas modifié)."""
    require_user_id(request)
    data = await request.json()
    code = data.get("content")
    fname = str(data.get("filename") or "file.py")
    if not isinstance(code, str):
        raise HTTPException(400, "content (texte) requis")
    if not fname.endswith((".py", ".pyi")):
        raise HTTPException(400, "Formatage disponible pour Python seulement")
    if len(code.encode("utf-8")) > _FORMAT_MAX_BYTES:
        raise HTTPException(413, "Fichier trop gros pour le formatage (2 Mo max)")
    ruff_bin = await asyncio.to_thread(_find_ruff)
    if not ruff_bin:
        raise HTTPException(501, "ruff absent du serveur")
    try:
        proc = await asyncio.to_thread(
            _sp.run,
            [ruff_bin, "format", "--stdin-filename", PurePosixPath(fname).name, "-"],
            input=code.encode("utf-8"),
            capture_output=True,
            timeout=15,
        )
    except _sp.TimeoutExpired:
        raise HTTPException(504, "Formatage trop long")
    if proc.returncode != 0:
        msg = (proc.stderr or b"").decode("utf-8", errors="replace").strip()
        raise HTTPException(422, (msg.splitlines() or ["Formatage impossible"])[0][:300])
    return {"content": proc.stdout.decode("utf-8")}


# ─────────────────────────────────────────────────────────────────────────────
#  GREP — Multi-file search across the user's sandbox
# ─────────────────────────────────────────────────────────────────────────────
#
#  Powers the editor's "Search across sandbox" (Ctrl+Shift+F) panel.
#
#  Scope & limits :
#    - Strictly contained in ``_get_work_path(user_id)`` (resolved with
#      ``_path_inside`` per matched file). No cross-user reads possible.
#    - Hard cap on files scanned, matches returned, file size, and wall
#      clock time. Hitting any limit returns ``truncated=true`` so the UI
#      can flag "résultats partiels".
#    - Binary files detected by first-512-bytes NULL scan → skipped.
#    - Hidden dirs (.git, .charts, .memory, __pycache__, node_modules,
#      .venv) ignored by default. Override via the ``include_hidden``
#      flag.
#    - Plain-text substring search by default. ``regex=true`` enables
#      Python regex (validated, ``re.IGNORECASE`` when case-insensitive).
#      Invalid regex → 400.
#    - ``glob`` (fnmatch pattern) filters by filename (basename match,
#      not full path) — e.g. ``*.py`` to grep Python only.
#
#  Response shape :
#    { matches: [ { path, line, col, snippet, match_start, match_end } ],
#      total_files_scanned: int,
#      truncated: bool,
#      elapsed_ms: int }
#
#  Performance : pure Python iteration on stdlib only. For sandboxes
#  bigger than a few thousand files / hundreds of MB, the time cap will
#  fire before exhausting the corpus — that's intentional, the UI flags
#  the truncation and users can narrow with ``glob``.
_GREP_MAX_RESULTS       = 500
_GREP_MAX_FILES_SCANNED = 5_000
_GREP_MAX_FILE_BYTES    = 5 * 1024 * 1024     # 5 MB per file
_GREP_TIMEOUT_SEC       = 5.0
_GREP_SNIPPET_RADIUS    = 80                  # chars before/after match
# (2026-09-20) Une regex pathologique peut occuper le thread très longtemps
# sur UNE ligne (backtracking) ; le budget de temps n'est vérifié qu'entre
# les lignes. Au-delà de cette longueur, une ligne n'est fouillée qu'en texte.
_GREP_MAX_LINE_CHARS    = 20_000
_GREP_IGNORED_DIRS = frozenset({
    ".git", ".charts", ".memory", "__pycache__", "node_modules",
    ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache",
    ".ruff_cache", ".cache", "dist", "build",
})


def _is_likely_binary(head: bytes) -> bool:
    """Cheap binary sniffer : NULL byte in the first 512 bytes."""
    return b"\x00" in head


@router.post("/api/sandbox/grep")
async def api_sandbox_grep(request: Request):
    """Multi-file substring/regex search restricted to the user's sandbox.

    Request body (all optional except ``query``) ::

        {
          "query":          "...",      # text or regex pattern
          "regex":          false,
          "case_sensitive": false,
          "glob":           "*.py",     # filename filter
          "include_hidden": false
        }

    Returns the structured response described in the module-level docstring.
    """
    import fnmatch
    import re as _re
    import time as _t

    user_id = require_user_id(request)
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Body JSON requis")

    query = (body.get("query") or "")
    if not isinstance(query, str) or not query.strip():
        raise HTTPException(400, "Query vide")
    if len(query) > 1000:
        raise HTTPException(400, "Query trop longue (max 1000 caractères)")

    use_regex      = bool(body.get("regex", False))
    case_sensitive = bool(body.get("case_sensitive", False))
    glob_pattern   = body.get("glob") or ""
    include_hidden = bool(body.get("include_hidden", False))

    if glob_pattern and (not isinstance(glob_pattern, str) or len(glob_pattern) > 200):
        raise HTTPException(400, "glob invalide")

    # Build the matcher closure.
    if use_regex:
        try:
            flags = 0 if case_sensitive else _re.IGNORECASE
            pat = _re.compile(query, flags)
        except _re.error as e:
            raise HTTPException(400, f"Regex invalide : {e}")
        def _scan_line(line: str):
            if len(line) > _GREP_MAX_LINE_CHARS:
                return None
            return pat.search(line)
    else:
        needle = query if case_sensitive else query.lower()
        def _scan_line(line: str):
            hay = line if case_sensitive else line.lower()
            i = hay.find(needle)
            if i < 0:
                return None
            # Synthetise a re.Match-like duck object via a simple class
            class _M:
                def __init__(self, s, e): self._s, self._e = s, e
                def start(self): return self._s
                def end(self):   return self._e
            return _M(i, i + len(needle))

    root = _get_work_path(user_id)
    if not root.exists():
        return {"matches": [], "total_files_scanned": 0, "truncated": False, "elapsed_ms": 0}

    matches    = []
    files_seen = 0
    truncated  = False
    started    = _t.monotonic()

    def _too_late() -> bool:
        return (_t.monotonic() - started) > _GREP_TIMEOUT_SEC

    # We iterate via os.walk + per-file open, blocking. For the size we
    # cap (5k files × 5 MB), this stays under the 5s wall clock on
    # commodity hardware. Pushing to a thread isn't necessary at these
    # bounds and would only add overhead.
    def _grep_blocking():
        nonlocal files_seen, truncated
        for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
            if _too_late():
                truncated = True
                return
            # Prune hidden dirs in-place (os.walk respects modifications).
            if not include_hidden:
                dirnames[:] = [
                    d for d in dirnames
                    if d not in _GREP_IGNORED_DIRS and not d.startswith(".")
                ]
            else:
                dirnames[:] = [d for d in dirnames if d not in _GREP_IGNORED_DIRS]

            for fname in filenames:
                if not include_hidden and fname.startswith("."):
                    continue
                if glob_pattern and not fnmatch.fnmatch(fname, glob_pattern):
                    continue
                files_seen += 1
                if files_seen > _GREP_MAX_FILES_SCANNED:
                    truncated = True
                    return
                if len(matches) >= _GREP_MAX_RESULTS:
                    truncated = True
                    return
                if _too_late():
                    truncated = True
                    return

                fpath = Path(dirpath) / fname
                # Defensive : confirm the file is actually under root
                # (os.walk(followlinks=False) should prevent symlink escapes
                # but a belt-and-suspenders check costs nothing).
                try:
                    if not _path_inside(fpath.resolve(), root.resolve()):
                        continue
                except (OSError, RuntimeError):
                    continue

                try:
                    st = fpath.stat()
                except OSError:
                    continue
                if st.st_size > _GREP_MAX_FILE_BYTES:
                    continue

                try:
                    with open(fpath, "rb") as f:
                        head = f.read(512)
                        if _is_likely_binary(head):
                            continue
                        rest = f.read()
                except OSError:
                    continue

                try:
                    text = (head + rest).decode("utf-8", errors="replace")
                except Exception:
                    continue

                rel = str(fpath.relative_to(root))
                for lineno, line in enumerate(text.splitlines(), start=1):
                    m = _scan_line(line)
                    if not m:
                        continue
                    s, e = m.start(), m.end()
                    snip_start = max(0, s - _GREP_SNIPPET_RADIUS)
                    snip_end   = min(len(line), e + _GREP_SNIPPET_RADIUS)
                    snippet = line[snip_start:snip_end]
                    matches.append({
                        "path":        rel,
                        "line":        lineno,
                        "col":         s + 1,
                        "snippet":     snippet,
                        "match_start": s - snip_start,
                        "match_end":   e - snip_start,
                    })
                    if len(matches) >= _GREP_MAX_RESULTS:
                        truncated = True
                        return
                    if _too_late():
                        truncated = True
                        return

    await asyncio.to_thread(_grep_blocking)
    elapsed_ms = int((_t.monotonic() - started) * 1000)
    return {
        "matches":             matches,
        "total_files_scanned": files_seen,
        "truncated":           truncated,
        "elapsed_ms":          elapsed_ms,
    }


# ─────────────────────────────────────────────────────────────────────────────
#  REPLACE — Remplacement multi-fichiers (2026-09-19)
# ─────────────────────────────────────────────────────────────────────────────
#
#  Même correspondance que ``/grep`` (ligne par ligne, texte ou regex, casse,
#  filtre de nom, dossiers ignorés) pour que l'aperçu et l'application
#  touchent exactement ce que la recherche a montré.
#
#    dry_run=true  → { files: [{path, count, samples:[{line, before, after}]}],
#                      total, truncated }
#    dry_run=false → applique aux seuls ``paths`` fournis (la liste validée
#                    dans l'aperçu) ; { files: [{path, count, mtime}], total }
#
#  En regex, ``$1`` / ``$&`` (habitude JS) sont acceptés en plus de ``\1``.
#  Un fichier qui n'est pas de l'UTF-8 strict est ignoré : le réécrire après
#  un décodage tolérant le corromprait.
_REPLACE_MAX_FILES   = 500
_REPLACE_MAX_SAMPLES = 5
_REPLACE_MAX_REPLACEMENT = 10_000      # caractères du texte de remplacement
_REPLACE_SCAN_TIMEOUT_SEC = 10.0       # budget de l'aperçu (comme /grep)
_LINE_END_RE = re.compile(r"(\r\n|\n|\r)$")
_JS_REF_RE = re.compile(r"\$(\$|&|\d+)")


def _replace_template(replacement: str, use_regex: bool):
    """Texte → littéral strict. Regex → gabarit ``re`` ; les habitudes JS
    ``$1`` / ``$&`` / ``$$`` sont traduites (``\\1`` reste accepté)."""
    if not use_regex:
        return lambda _m: replacement

    def _js(m):
        g = m.group(1)
        if g == "$":
            return "$"
        return r"\g<0>" if g == "&" else r"\g<%s>" % g
    return _JS_REF_RE.sub(_js, replacement)


def _replace_in_text(text: str, pat, repl, max_samples: int = _REPLACE_MAX_SAMPLES):
    """(nouveau_texte, nb_remplacements, [(ligne, avant, après)] — échantillon)."""
    out, count, samples = [], 0, []
    for lineno, raw in enumerate(text.splitlines(keepends=True), start=1):
        m_end = _LINE_END_RE.search(raw)
        ending = m_end.group(1) if m_end else ""
        body = raw[: len(raw) - len(ending)]
        new_body, n = pat.subn(repl, body)
        if n:
            count += n
            if len(samples) < max_samples:
                samples.append((lineno, body, new_body))
        out.append(new_body + ending)
    return "".join(out), count, samples


def _replace_scan_file(fpath: Path, root_res: Path, pat, repl):
    """Lit UN fichier et calcule son remplacement.

    Rend ``(texte, nouveau_texte, n, échantillons, mtime_ns)``, ou une chaîne
    = raison d'ignorer, ou None (rien à remplacer / fichier hors champ).
    Un lien symbolique est ignoré : l'écriture (``mv tmp cible``) le
    remplacerait par une copie ordinaire."""
    try:
        if fpath.is_symlink():
            return "lien symbolique"
        if not fpath.is_file() or not _path_inside(fpath.resolve(), root_res):
            return None
        st = fpath.stat()
        if st.st_size > _GREP_MAX_FILE_BYTES:
            return None
        raw = fpath.read_bytes()
    except OSError:
        return None
    if _is_likely_binary(raw[:512]):
        return None
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return None
    new_text, n, samples = _replace_in_text(text, pat, repl)
    if not n:
        return None
    if len(new_text) > _GREP_MAX_FILE_BYTES:
        return "résultat trop gros"
    return text, new_text, n, samples, st.st_mtime_ns


def _replace_path_in_scope(rel: str, include_hidden: bool, glob_pattern: str) -> bool:
    """Mêmes règles d'exclusion que le parcours de l'aperçu, pour un chemin
    fourni par le client à l'application."""
    import fnmatch
    parts = PurePosixPath(rel).parts
    if not parts or any(p in ("", ".", "..") for p in parts):
        return False
    if any(d in _GREP_IGNORED_DIRS for d in parts[:-1]):
        return False
    if not include_hidden and any(p.startswith(".") for p in parts):
        return False
    return not glob_pattern or fnmatch.fnmatch(parts[-1], glob_pattern)


@router.post("/api/sandbox/replace")
async def api_sandbox_replace(request: Request):
    import fnmatch
    import re as _re
    import time as _t

    user_id = require_user_id(request)
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Body JSON requis")
    query = body.get("query") or ""
    if not isinstance(query, str) or not query:
        raise HTTPException(400, "Query vide")
    if len(query) > 1000:
        raise HTTPException(400, "Query trop longue (max 1000 caractères)")
    replacement = body.get("replacement")
    if not isinstance(replacement, str):
        raise HTTPException(400, "replacement (texte) requis")
    if len(replacement) > _REPLACE_MAX_REPLACEMENT:
        raise HTTPException(400, "Texte de remplacement trop long (10 000 caractères max)")
    use_regex      = bool(body.get("regex", False))
    case_sensitive = bool(body.get("case_sensitive", False))
    include_hidden = bool(body.get("include_hidden", False))
    glob_pattern   = body.get("glob") or ""
    dry_run        = bool(body.get("dry_run", False))
    only = body.get("paths")
    if glob_pattern and (not isinstance(glob_pattern, str) or len(glob_pattern) > 200):
        raise HTTPException(400, "glob invalide")
    if not dry_run:
        if not (isinstance(only, list) and only and all(isinstance(p, str) for p in only)):
            raise HTTPException(400, "paths requis pour appliquer")
        if len(only) > _REPLACE_MAX_FILES:
            raise HTTPException(400, f"Trop de fichiers ({_REPLACE_MAX_FILES} max par application)")

    flags = 0 if case_sensitive else _re.IGNORECASE
    try:
        pat = _re.compile(query if use_regex else _re.escape(query), flags)
    except _re.error as e:
        raise HTTPException(400, f"Regex invalide : {e}")
    repl = _replace_template(replacement, use_regex)
    try:
        # Le gabarit est analysé même sans correspondance : ``C:\dir``, un
        # ``\`` final ou ``$2`` sans 2e groupe sortaient en 500 opaque.
        pat.subn(repl, "")
    except (_re.error, IndexError) as e:
        raise HTTPException(400, f"Remplacement invalide : {e}")

    root = _get_work_path(user_id)
    if not root.exists():
        return {"files": [], "total": 0, "truncated": False}
    root_res = root.resolve()

    # ── Aperçu : parcours borné (fichiers, temps), rien n'est gardé en mémoire
    #    au-delà du compte et de quelques lignes d'exemple par fichier.
    if dry_run:
        def _preview():
            files, skipped, seen = [], [], 0
            started = _t.monotonic()
            for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
                dirnames[:] = [d for d in dirnames if d not in _GREP_IGNORED_DIRS
                               and (include_hidden or not d.startswith("."))]
                for fname in filenames:
                    if not include_hidden and fname.startswith("."):
                        continue
                    if glob_pattern and not fnmatch.fnmatch(fname, glob_pattern):
                        continue
                    fpath = Path(dirpath) / fname
                    rel = str(fpath.relative_to(root))
                    seen += 1
                    if (seen > _GREP_MAX_FILES_SCANNED or len(files) >= _REPLACE_MAX_FILES
                            or (_t.monotonic() - started) > _REPLACE_SCAN_TIMEOUT_SEC):
                        return files, skipped, True
                    res = _replace_scan_file(fpath, root_res, pat, repl)
                    if res is None:
                        continue
                    # Le pont d'écriture normalise ``work/…`` (et les blancs de
                    # bord) : un tel chemin serait LU ici mais ÉCRIT ailleurs.
                    if _strip_work_prefix(rel) != rel:
                        res = "chemin ambigu (work/)"
                    if isinstance(res, str):
                        skipped.append({"path": rel, "reason": res})
                        continue
                    _text, _new, n, samples, _m = res
                    files.append({
                        "path": rel, "count": n,
                        "samples": [{"line": ln, "before": b[:300], "after": a[:300]}
                                    for ln, b, a in samples],
                    })
            return files, skipped, False

        files, skipped, truncated = await asyncio.to_thread(_preview)
        return {"files": files, "total": sum(f["count"] for f in files),
                "truncated": truncated, "skipped": skipped}

    # ── Application : fichier par fichier, SOUS le verrou du compte. Chaque
    #    fichier est relu juste avant d'être écrit (jamais un texte lu pendant
    #    l'aperçu), et ignoré s'il a bougé entre sa lecture et son écriture.
    from shared_infra.sandbox.exec_bridge import sandbox_write_text
    done, skipped, failed = [], [], None
    seen_paths = set()
    async with _quota_lock_for(user_id):
        _user_settings = get_user_settings(user_id)
        if "sandbox_quota_mb" in _user_settings:
            _quota_mb = int(_user_settings["sandbox_quota_mb"])
        else:
            _cfg = config_view() or {}
            _quota_mb = int(_cfg.get("app", {}).get("sandbox_quota_mb", 5120))
        _quota_bytes = _quota_mb * 1024 * 1024
        _used = (await asyncio.to_thread(sandbox_usage_bytes, user_id, root,
                                         quota_bytes=_quota_bytes)) if _quota_mb > 0 else 0
        for raw_rel in only:
            if _strip_work_prefix(raw_rel) != raw_rel:
                skipped.append({"path": raw_rel, "reason": "hors champ"})
                continue
            # Audit éditeur 2026-09-23 (E28) — dédoublonnage sur le chemin
            # CANONIQUE : ``a.py`` et ``./a.py`` (ou ``a//b``) désignent le
            # même fichier, le remplacement était appliqué deux fois.
            rel = PurePosixPath(raw_rel).as_posix()
            if rel in seen_paths:
                continue
            seen_paths.add(rel)
            if not _replace_path_in_scope(rel, include_hidden, glob_pattern):
                skipped.append({"path": raw_rel, "reason": "hors champ"})
                continue
            fpath = root / rel
            # E7 — relecture, contrôle et écriture sous le verrou du fichier,
            # commun avec les outils de l'assistant.
            async with _file_lock(fpath.resolve()):
                res = await asyncio.to_thread(_replace_scan_file, fpath, root_res, pat, repl)
                if res is None:
                    continue
                if isinstance(res, str):
                    skipped.append({"path": rel, "reason": res})
                    continue
                text, new_text, n, _samples, mtime_ns = res
                old_bytes = text.encode("utf-8")
                new_bytes = new_text.encode("utf-8")
                delta = len(new_bytes) - len(old_bytes)
                if _quota_mb > 0 and delta > 0 and _used + delta > _quota_bytes:
                    failed = {"path": rel, "error": f"Quota sandbox dépassé ({_quota_mb} Mo)"}
                    break
                try:
                    if fpath.stat().st_mtime_ns != mtime_ns:
                        skipped.append({"path": rel, "reason": "modifié pendant l'opération"})
                        continue
                    await sandbox_write_text(user_id, rel, new_text)
                except HTTPException as e:
                    failed = {"path": rel, "error": str(e.detail)}
                    break
                except OSError as e:
                    failed = {"path": rel, "error": str(e)}
                    break
                try:
                    mtime = fpath.stat().st_mtime
                except OSError:
                    mtime = None
            bump_sandbox_usage(user_id, delta)
            _used += delta
            # Historique de session (source « replace ») : le texte relu sous
            # le verrou est exactement le contenu remplacé.
            await _hist_write(user_id, rel, old_bytes, new_bytes, "replace")
            done.append({"path": rel, "count": n, "mtime": mtime,
                         "sha256": sha256_bytes(new_bytes)})
    out = {"files": done, "total": sum(f["count"] for f in done),
           "truncated": False, "skipped": skipped}
    if failed:
        # 200 + ``failed`` : les fichiers DÉJÀ réécrits doivent revenir au
        # client (recalage de leurs onglets), ce qu'un 5xx ne permettrait pas.
        out["failed"] = failed
    return out


# ─────────────────────────────────────────────────────────────────────────────
#  DOCX / OFFICE — Lecture de fichiers Word en plaintext
# ─────────────────────────────────────────────────────────────────────────────
#
#  Quand l'utilisateur clique sur un fichier .docx dans le file tree,
#  ``download?path=X`` retournerait le binaire ZIP (illisible en texte
#  brut dans Monaco). Ce endpoint extrait le contenu textuel via
#  ``python-docx`` et le retourne en plain text, pour qu'il soit lisible
#  dans l'éditeur (en read-only logique côté UI — pas de sauvegarde
#  arrière).
#
#  Sécurité :
#    - ``require_user_id`` + ``_path_inside`` strict sur la sandbox utilisateur
#    - Taille max 10 MB (un docx normal fait <2 MB, on est large)
#    - Erreur silencieuse si ``python-docx`` absent → 501 explicite
#
#  Note : on retourne aussi un flag ``read_only=true`` pour que le
#  frontend rende le buffer non-éditable / non-sauvegardable (un save
#  écraserait le binaire avec du texte, perte irrémédiable des styles).
# ─────────────────────────────────────────────────────────────────────────────
_DOCX_MAX_BYTES = 10 * 1024 * 1024     # 10 MB — plus que largement suffisant


@router.get("/api/sandbox/read-docx")
def api_sandbox_read_docx(request: Request, path: str):
    """Extrait le texte brut d'un fichier .docx du sandbox utilisateur."""
    user_id = require_user_id(request)
    if not path or len(path) > 1024:
        raise HTTPException(400, "Path invalide")

    root = _get_work_path(user_id)
    full = (root / _strip_work_prefix(path)).resolve()
    if not _path_inside(full, root.resolve()):
        raise HTTPException(403, "Hors sandbox")
    if not full.exists() or not full.is_file():
        raise HTTPException(404, "Fichier introuvable")
    if not full.name.lower().endswith(".docx"):
        raise HTTPException(400, "Pas un fichier .docx")
    try:
        size = full.stat().st_size
    except OSError:
        raise HTTPException(500, "Lecture stat impossible")
    if size > _DOCX_MAX_BYTES:
        raise HTTPException(413, f"Fichier trop gros (max {_DOCX_MAX_BYTES // (1024*1024)} MB)")

    try:
        from docx import Document  # python-docx
    except ImportError:
        raise HTTPException(
            501,
            "Support .docx non installé côté serveur (pip install python-docx)",
        )

    try:
        doc = Document(str(full))
    except Exception as e:
        # docx corrompu ou format inconnu (vieux .doc binaire ≠ .docx OOXML)
        raise HTTPException(422, f"Lecture .docx impossible : {e}")

    # Extraction simple : paragraphes + tables, séparés par des newlines.
    # On ne préserve PAS le formatting (gras, listes, headings) — c'est
    # le compromis "plaintext lisible". Pour un rendu fidèle, il faudrait
    # passer par pandoc ou mammoth.js — overkill pour cette feature.
    lines: list[str] = []
    for para in doc.paragraphs:
        text = (para.text or "").rstrip()
        # Préserve les paragraphes vides (entre sections) pour la lisibilité
        lines.append(text)
    # Tables : ajoute après les paragraphes, séparées par une ligne vide
    for tbl in doc.tables:
        lines.append("")  # séparateur
        for row in tbl.rows:
            cells = [c.text.replace("\n", " ").strip() for c in row.cells]
            lines.append(" | ".join(cells))
    text_out = "\n".join(lines).strip() + "\n"

    return {
        "path":      path,
        "text":      text_out,
        "size":      size,
        "read_only": True,    # signal frontend : ne pas autoriser save
        "format":    "docx",
    }


# ─────────────────────────────────────────────────────────────────────────────
#  MTIME CHECK — Détection des modifications externes
# ─────────────────────────────────────────────────────────────────────────────
#
#  Endpoint utilisé par le frontend pour détecter quand un fichier est
#  modifié en dehors de l'éditeur (terminal, git pull, autre user collab,
#  etc.). Appelé périodiquement et au focus de la fenêtre.
#
#  Input  : { files: [{ path, mtime, size?, sha256? }, ...] }
#  Output : { stale: [...], truncated: bool }
#    stale : { path, new_mtime, size, sha256 }  (sha256 ≤ 2 Mio, sinon null)
#            { path, missing: true }             fichier supprimé
#            { path, not_file: true }            devenu dossier (ou non régulier)
#            { path, unreadable: true }          droits refusés
#
#  Audit éditeur 2026-09-23 :
#  - E5 : même tolérance que /save (``_SAVE_MTIME_EPS``), plus 1 s ;
#  - E6 : la TAILLE (si fournie) et le HASH (si fourni, fichier ≤ 2 Mio, mtime
#    identique) rattrapent les écritures du même tick et les copies qui
#    conservent le mtime (``cp -p``) ;
#  - E30 : dossier / illisible signalés au lieu d'être tus ; au-delà de 500
#    entrées, les 500 premières sont traitées et ``truncated`` vaut true
#    (l'ancien 413 faisait abandonner le sondage en silence).
#
#  Sécurité : ``_path_inside`` sur chaque path.
# ─────────────────────────────────────────────────────────────────────────────
@router.post("/api/sandbox/check-mtimes")
async def api_sandbox_check_mtimes(request: Request):
    """Compare l'état connu du frontend (mtime, taille, hash) avec le disque."""
    user_id = require_user_id(request)
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "JSON requis")

    files = body.get("files") if isinstance(body, dict) else None
    if not isinstance(files, list):
        raise HTTPException(400, "files doit être une liste")
    truncated = len(files) > _CHECK_MAX_FILES
    files = files[:_CHECK_MAX_FILES]

    # AUDIT 2026-08-31 (passe 2) — ``resolve()`` + ``stat()`` (+ hash) hors
    # de la boucle d'événements : threadpool.
    def _scan():
        root = _get_work_path(user_id)
        if not root.exists():
            return []
        root_resolved = root.resolve()
        stale = []
        for item in files:
            if not isinstance(item, dict):
                continue
            path = item.get("path")
            client_mtime = item.get("mtime")
            if not isinstance(path, str) or len(path) > 1024:
                continue
            if not isinstance(client_mtime, (int, float)) or isinstance(client_mtime, bool):
                continue
            client_size = item.get("size")
            if not isinstance(client_size, int) or isinstance(client_size, bool):
                client_size = None
            client_sha = item.get("sha256")
            client_sha = (client_sha.lower() if isinstance(client_sha, str)
                          and _SHA_RE.match(client_sha.lower()) else None)
            try:
                full = (root / _strip_work_prefix(path)).resolve()
            except (OSError, RuntimeError):
                stale.append({"path": path, "unreadable": True})
                continue
            if not _path_inside(full, root_resolved):
                continue
            try:
                st = full.stat()
            except (FileNotFoundError, NotADirectoryError):
                stale.append({"path": path, "missing": True})
                continue
            except OSError:
                stale.append({"path": path, "unreadable": True})
                continue
            import stat as _stat
            if not _stat.S_ISREG(st.st_mode):
                stale.append({"path": path, "not_file": True})
                continue
            small = st.st_size <= _CHECK_SHA_MAX
            same_mtime = abs(st.st_mtime - client_mtime) <= _SAVE_MTIME_EPS
            changed = (not same_mtime
                       or (client_size is not None and client_size != st.st_size))
            disk_sha = None
            if not changed and client_sha is not None and small:
                disk_sha = sha256_file(full, limit=_CHECK_SHA_MAX)
                if disk_sha is None:
                    stale.append({"path": path, "unreadable": True})
                    continue
                changed = disk_sha != client_sha
            if changed:
                if disk_sha is None and small:
                    disk_sha = sha256_file(full, limit=_CHECK_SHA_MAX)
                stale.append({
                    "path":      path,
                    "new_mtime": st.st_mtime,
                    "size":      st.st_size,
                    "sha256":    disk_sha,
                })
        return stale

    return {"stale": await asyncio.to_thread(_scan), "truncated": truncated}


# ─────────────────────────────────────────────────────────────────────────────
#  HISTORIQUE DE SESSION — lecture seule (2026-09-23)
# ─────────────────────────────────────────────────────────────────────────────
#  Chaque compte ne voit que SON historique (``require_user_id``). La
#  restauration passe par ``/save`` (``source: "restore"`` + précondition),
#  pas par une route dédiée.
@router.get("/api/sandbox/history")
async def api_sandbox_history(request: Request):
    user_id = require_user_id(request)
    info = await asyncio.to_thread(_fh.session_info, user_id)
    return _no_cache(JSONResponse(info))


@router.get("/api/sandbox/history/file")
async def api_sandbox_history_file(request: Request, path: str = ""):
    user_id = require_user_id(request)
    if not path or len(path) > 1024:
        raise HTTPException(400, "Chemin requis")
    ent = await asyncio.to_thread(_fh.file_entry, user_id, path)
    if not ent:
        raise HTTPException(404, "Aucun historique pour ce fichier")
    root = _get_work_path(user_id)
    current = {"exists": False, "sha256": None, "size": None, "mtime": None}
    try:
        full = (root / _strip_work_prefix(path)).resolve()
        inside = _path_inside(full, root)
    except (OSError, RuntimeError):
        inside = False
    if inside:
        st = await asyncio.to_thread(_file_state, full, sha_max=_DOWNLOAD_SHA_MAX)
        if st["kind"] == "file":
            current = {"exists": True, "sha256": st.get("sha256"),
                       "size": st.get("size"), "mtime": st.get("mtime")}
    ent["current"] = current
    return _no_cache(JSONResponse(ent))


@router.get("/api/sandbox/history/blob")
async def api_sandbox_history_blob(request: Request, sha: str = ""):
    from fastapi.responses import Response
    user_id = require_user_id(request)
    data = await asyncio.to_thread(_fh.get_blob, user_id, (sha or "").lower())
    if data is None:
        raise HTTPException(404, "Version introuvable")
    try:
        data.decode("utf-8")
        mt = "text/plain; charset=utf-8"
    except UnicodeDecodeError:
        mt = "application/octet-stream"
    resp = Response(data, media_type=mt)
    # Adressé par contenu : immuable.
    resp.headers["Cache-Control"] = "private, max-age=86400"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    return resp


# ─────────────────────────────────────────────────────────────────────────────
#  Miroir des skills poussé par l'APP (hôte d'outils distant, 2026-09-12, P4)
# ─────────────────────────────────────────────────────────────────────────────
@router.post("/api/sandbox/skills-mirror")
async def api_sandbox_skills_mirror(request: Request, archive: UploadFile = File(...)):
    """Remplace ``<sandbox>/<compte>/skills`` (hors du mont ``/work``) par le
    contenu d'une archive tar.gz du store de skills de l'app. Sur un hôte
    d'outils distant, c'est ainsi que ``skill_run_script`` trouve les scripts ;
    en local la route existe mais l'app synchronise le miroir directement.
    Archive bornée (32 Mo), chemins contenus (aucun ``..``, aucun lien)."""
    import io as _io
    import tarfile as _tarfile
    user_id = require_user_id(request)
    from shared_infra.routes._helpers import _get_sandbox_path as _sbp
    root = Path(_sbp(user_id))
    from shared_infra.files.uploads import read_upload_bounded
    # Passe sandbox 2026-09-26 — lecture BORNÉE (avant : tout lu, puis testé).
    data = await read_upload_bounded(archive, 32 * 1024 * 1024)
    target = root / "skills"
    tmp = root / ".skills-mirror.tmp"

    def _extract() -> int:
        if tmp.exists():
            shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir(parents=True, exist_ok=True)
        try:
            n = _extract_tar_bounded(_io.BytesIO(data), tmp,
                                     max_total=256 * 1024 * 1024, max_members=20_000)
        except BaseException:
            shutil.rmtree(tmp, ignore_errors=True)
            raise
        if target.exists():
            shutil.rmtree(target, ignore_errors=True)
        tmp.rename(target)
        return n
    try:
        n = await asyncio.to_thread(_extract)
    except _ArchiveTooBig:
        raise HTTPException(413, "archive trop volumineuse une fois décompressée")
    return {"ok": True, "files": n}


# ─────────────────────────────────────────────────────────────────────────────
#  Export / import de ``/work`` (migration entre hôtes d'outils, 2026-09-12, P5)
# ─────────────────────────────────────────────────────────────────────────────
_IMPORT_MAX_BYTES = 2 * 1024 * 1024 * 1024


class _ArchiveTooBig(Exception):
    pass


def _user_quota_bytes(user_id: int) -> int:
    """Quota disque du compte (Mo → octets), comme le terminal et /save."""
    try:
        qs = get_user_settings(user_id) or {}
        qc = config_view().app
        return int(qs.get("sandbox_quota_mb", getattr(qc, "sandbox_quota_mb", 5120) or 5120)) * 1024 * 1024
    except Exception:                                            # noqa: BLE001
        return 5120 * 1024 * 1024


def _extract_tar_bounded(fileobj, tmp: Path, *, max_total: int, max_members: int) -> int:
    """Extrait une archive tar (compressée ou non) dans ``tmp`` : membres
    CONTENUS (ni ``..``, ni absolu, ni lien, ni device), copiés EN FLUX.

    Passe sandbox 2026-09-26 — une archive de 32 Mo peut se décompresser en
    dizaines de Go (bombe) : ni la taille décompressée ni le nombre de membres
    n'étaient bornés, et chaque membre était lu ENTIER en mémoire
    (``write_bytes(f.read())``). Lève ``_ArchiveTooBig`` au-delà des plafonds
    (l'appelant jette ``tmp``). Retourne le nombre de fichiers écrits."""
    import tarfile as _tarfile
    n = total = members = 0
    tmp_root = tmp.resolve()
    with _tarfile.open(fileobj=fileobj, mode="r:*") as tf:
        for m in tf:                                   # itération en flux
            members += 1
            if members > max_members:
                raise _ArchiveTooBig()
            parts = [x for x in PurePosixPath(m.name).parts if x not in ("", ".", "/")]
            if not parts or ".." in parts or m.name.startswith("/"):
                continue
            if not (m.isfile() or m.isdir()):
                continue                                  # ni lien, ni device
            dest = (tmp / "/".join(parts)).resolve()
            if tmp_root not in dest.parents and dest != tmp_root:
                continue
            if m.isdir():
                dest.mkdir(parents=True, exist_ok=True)
                continue
            total += max(0, int(m.size or 0))
            if total > max_total:
                raise _ArchiveTooBig()
            dest.parent.mkdir(parents=True, exist_ok=True)
            f = tf.extractfile(m)
            if f is None:
                continue
            with open(dest, "wb") as out:
                shutil.copyfileobj(f, out, 1 << 20)
            n += 1
    return n


def import_work_archive(user_id: int, data, *, max_total: Optional[int] = None) -> int:
    """Remplace le contenu de ``/work`` du compte par celui d'une archive
    tar.gz (membres contenus : ni ``..``, ni absolu, ni lien). Retourne le
    nombre de fichiers écrits. Utilisé par la route ``/api/sandbox/import`` et
    par une migration locale. ``data`` : octets ou fichier binaire (la route
    passe le fichier d'upload tel quel, sans le recopier en mémoire).
    ``max_total`` : plafond de la taille DÉCOMPRESSÉE (défaut : quota du compte)."""
    import io as _io
    root = Path(_get_work_path(user_id))
    tmp = root.parent / ".work-import.tmp"
    if tmp.exists():
        shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True, exist_ok=True)
    if max_total is None:
        max_total = _user_quota_bytes(user_id)
    fileobj = _io.BytesIO(data) if isinstance(data, (bytes, bytearray)) else data
    try:
        n = _extract_tar_bounded(fileobj, tmp, max_total=max_total, max_members=500_000)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    # bascule : l'ancien /work est renommé, jamais supprimé ici
    old = root.parent / f".work-before-import-{int(time.time())}"
    if root.exists():
        root.rename(old)
    tmp.rename(root)
    return n


async def grant_work_access(user_id: int) -> None:
    """Remet ``/work`` au modèle d'ownership du sandbox après une écriture
    host-side (import d'archive).

    AUDIT 2026-09-16 (A1) — ``sandbox_grant_access`` est une coroutine, et elle
    était appelée SANS ``await`` depuis ``import_work_archive`` (fonction
    synchrone lancée en thread) : la coroutine n'était jamais exécutée
    (« coroutine was never awaited »), donc ni ACL ni chown — un /work importé
    restait la propriété de l'UID de l'app et le container ne pouvait plus
    l'éditer. L'appel vit désormais dans la route, qui est asynchrone."""
    try:
        from shared_infra.sandbox.exec_bridge import sandbox_grant_access
        await sandbox_grant_access(user_id, "")
    except Exception:                                            # noqa: BLE001
        logger.warning("[sandbox] remise des droits de /work échouée user=%s",
                       user_id, exc_info=True)


@router.get("/api/sandbox/export")
async def api_sandbox_export(request: Request):
    """Archive tar.gz de ``/work`` du compte (fichiers réguliers, sans liens)."""
    import tarfile as _tarfile
    user_id = require_user_id(request)
    root = Path(_get_work_path(user_id))

    # Passe sandbox 2026-09-26 — l'archive de TOUT /work était construite dans
    # un BytesIO puis servie d'un bloc : un /work de quelques Go = autant de
    # RAM du worker. Elle est écrite sur disque (même dépôt que les zips) et
    # supprimée une fois servie.
    def _build() -> str:
        import tempfile
        fd, tmp = tempfile.mkstemp(prefix="export-", suffix=".tar.gz",
                                   dir=str(_zip_spool_dir()))
        try:
            with os.fdopen(fd, "wb") as fh, _tarfile.open(fileobj=fh, mode="w:gz") as tf:
                for p in sorted(root.rglob("*")):
                    if p.is_file() and not p.is_symlink():
                        tf.add(p, arcname=str(p.relative_to(root)))
        except BaseException:
            _unlink_quiet(tmp)
            raise
        return tmp
    tmp = await asyncio.to_thread(_build)
    from starlette.background import BackgroundTask
    return FileResponse(tmp, media_type="application/gzip", filename="work.tar.gz",
                        headers={"Cache-Control": "no-store"},
                        background=BackgroundTask(_unlink_quiet, tmp))


@router.post("/api/sandbox/import")
async def api_sandbox_import(request: Request, archive: UploadFile = File(...)):
    """Remplace ``/work`` du compte par une archive tar.gz (migration entre
    hôtes). L'ancien ``/work`` est conservé à côté (``.work-before-import-<ts>``)."""
    user_id = require_user_id(request)
    # Passe sandbox 2026-09-26 — plus de ``archive.read()`` : jusqu'à 2 Go
    # recopiés en RAM avant même le contrôle de taille. Starlette a déjà
    # spoolé l'upload ; on en mesure la taille puis on l'extrait EN FLUX.
    try:
        archive.file.seek(0, os.SEEK_END)
        size = archive.file.tell()
        archive.file.seek(0)
    except (OSError, ValueError):
        size = 0
    if size > _IMPORT_MAX_BYTES:
        raise HTTPException(413, "archive trop volumineuse")
    try:
        n = await asyncio.to_thread(import_work_archive, user_id, archive.file)
    except _ArchiveTooBig:
        raise HTTPException(413, "archive trop volumineuse une fois décompressée "
                                 "(quota du compte ou nombre de fichiers dépassé)")
    await grant_work_access(user_id)
    return {"ok": True, "files": n}

