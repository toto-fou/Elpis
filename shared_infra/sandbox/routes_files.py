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
import stat as _stat
import subprocess as _sp
import time
import zipfile
from pathlib import Path, PurePosixPath
from typing import List, Optional

from fastapi import File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from shared_infra.accounts.users import (
    get_user_settings,
    get_username_by_id,
)
from shared_infra.config import config_view
from shared_infra.db import (
    log_metric,
)
from shared_infra.routes._state import router
from shared_infra.sandbox import file_history as _fh
from shared_infra.sandbox.agent_client import AgentError
from shared_infra.sandbox.exec_bridge import agent_for, agent_http
from shared_infra.sandbox.file_lock import file_write_lock, sha256_bytes
from shared_infra.sandbox.paths import (
    SandboxPathError,
    lexical_rel,
    open_beneath,
    open_leaf,
    open_path_beneath,
    rel_under,
    reopen,
    walk_beneath,
)
from shared_infra.security.deps import require_user_id

logger = logging.getLogger("uvicorn.error")

# Helpers shared with ``_legacy``. Importing through the module reference
# means we always observe the live values.
# Compteur d'usage disque mis en cache + single-flight (audit perf 2026-08-08).
# ``_sandbox_size_bytes`` reste importé pour les rares chemins qui veulent la
# valeur EXACTE sans passer par le cache.
from shared_infra.routes._helpers import (  # noqa: E402 — import tardif voulu (dépendance circulaire ou coût)  # noqa: E402 — import tardif voulu (dépendance circulaire ou coût)
    TREE_MAX_ENTRIES,
    _get_work_path,
    _no_cache,
    _path_inside,
    _quota_lock_for,
    _strip_work_prefix,
    _zip_copy,
    bump_sandbox_usage,
    invalidate_sandbox_usage,
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


async def _hist_before(root: Path, path: Path):
    """Contenu AVANT écriture, pour l'historique de session (jamais bloquant)."""
    try:
        return await asyncio.to_thread(_fh.read_before, root, path)
    except Exception:                                           # noqa: BLE001
        return None


async def _hist_write(user_id: int, rel: str, before, after, source: str) -> None:
    """``file_history.record_write`` hors boucle ; n'échoue jamais."""
    try:
        await asyncio.to_thread(_fh.record_write, user_id, rel, before, after, source)
    except Exception:                                           # noqa: BLE001
        logger.exception("[sandbox] historique : écriture non notée (%s)", rel)


def _sha_fd(pfd: int, limit: int) -> Optional[str]:
    """sha256 du fichier régulier désigné par le descripteur ``O_PATH``
    ``pfd`` ; ``None`` s'il est illisible ou dépasse ``limit``."""
    try:
        with os.fdopen(reopen(pfd), "rb") as f:
            if os.fstat(f.fileno()).st_size > limit:
                return None
            h = hashlib.sha256()
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
            return h.hexdigest()
    except OSError:
        return None


def _file_state(root: Path, p: Path, *, sha_max: int) -> dict:
    """État disque de ``p`` (sous ``root``), sans jamais lever : ``kind`` ∈
    ``missing``, ``dir``, ``file``, ``other`` (lien, fichier spécial),
    ``unreadable``, ``not_dir``. Pour un fichier : ``mtime``, ``size`` et
    ``sha256`` (``None`` au-delà de ``sha_max`` ou si le contenu est
    illisible, ``readable`` à faux). Une seule ouverture ``O_PATH``, sans
    suivre de lien : mtime, taille et empreinte décrivent le même inode
    (2026-09-29)."""
    try:
        pfd = open_path_beneath(root, rel_under(root, p))
    except FileNotFoundError:
        return {"kind": "missing"}
    except SandboxPathError:
        return {"kind": "not_dir"}     # un composant du chemin n'est pas un dossier
    except OSError:
        return {"kind": "unreadable"}
    try:
        st = os.fstat(pfd)
        if _stat.S_ISDIR(st.st_mode):
            return {"kind": "dir", "mtime": st.st_mtime}
        if not _stat.S_ISREG(st.st_mode):
            return {"kind": "other", "mtime": st.st_mtime, "size": st.st_size}
        out = {"kind": "file", "mtime": st.st_mtime, "size": st.st_size, "sha256": None,
               "readable": True}
        if st.st_size <= sha_max:
            out["sha256"] = _sha_fd(pfd, sha_max)
            out["readable"] = out["sha256"] is not None
        return out
    finally:
        os.close(pfd)


# ─────────────────────────────────────────────────────────────────────────────
#  Accès par l'agent de la sandbox (L4.3)
# ─────────────────────────────────────────────────────────────────────────────
# Les routes ne lisent plus le dossier de la sandbox : l'agent du conteneur
# le fait. ``root`` (chemin hôte) ne sert plus qu'aux noms, aux verrous et au
# quota ; les liens sont résolus par l'agent, sous /work.

def _mtime_s(ns: int) -> float:
    """mtime en secondes, calculé comme ``os.stat().st_mtime`` (au bit près :
    le front compare les valeurs rendues)."""
    return float(ns // 1_000_000_000) + (ns % 1_000_000_000) * 1e-9


def _rel_editeur(root: Path, rel_path: str) -> str:
    """Chemin relatif à la sandbox d'un chemin reçu par une route, sans lire
    le disque ; hors de la sandbox : 403."""
    try:
        return lexical_rel(root, rel_path)
    except SandboxPathError:
        raise HTTPException(403, "Access denied") from None


async def _etat_agent(agent, rel: str, *, sha_max: int) -> dict:
    """État de ``rel`` par l'agent, même forme que :func:`_file_state` :
    ``kind`` ∈ missing, dir, file, other, unreadable, not_dir ; pour un
    fichier ``mtime`` (s), ``mtime_ns``, ``size``, ``sha256`` (``None`` au-delà
    de ``sha_max``). Un lien sous /work est suivi (l'écriture écrit sa cible)."""
    try:
        (e,) = await agent.stat([rel], hash=sha_max > 0, hash_max=max(sha_max, 1))
    except AgentError as ex:
        raise agent_http(ex, "Lecture") from None
    kind = e.get("kind")
    if kind == "missing":
        return {"kind": "missing"}
    if kind == "error":
        return {"kind": "not_dir" if e.get("error") == "not_dir" else "unreadable"}
    ns = int(e.get("mtime_ns") or 0)
    if kind == "dir":
        return {"kind": "dir", "mtime": _mtime_s(ns)}
    if kind != "file":
        return {"kind": "other", "mtime": _mtime_s(ns), "size": int(e.get("size") or 0)}
    taille = int(e.get("size") or 0)
    sha = e.get("sha256") if isinstance(e.get("sha256"), str) else None
    return {"kind": "file", "mtime": _mtime_s(ns), "mtime_ns": ns, "size": taille, "sha256": sha,
            "readable": sha is not None or taille > sha_max}


async def _stat_un(agent, rel: str, libelle: str) -> dict:
    """Entrée ``stat`` de ``rel`` par l'agent (un lien sous /work suivi) ;
    un refus (lien qui sort de /work, droits…) en ``HTTPException``."""
    try:
        (e,) = await agent.stat([rel])
    except AgentError as ex:
        raise agent_http(ex, libelle) from None
    if e.get("kind") == "error":
        raise agent_http(AgentError(str(e.get("error") or "io_error"), ""), libelle)
    return e


async def _binaire_existant(agent, rel: str) -> bool:
    """Vrai si ``rel`` est un fichier existant qui ne s'édite pas comme texte
    (en-tête lu par l'agent) ; absent, spécial ou illisible : faux."""
    from shared_infra.sandbox.filetypes import SNIFF_BYTES, looks_binary
    try:
        r = await agent.read(rel, length=SNIFF_BYTES, max_bytes=SNIFF_BYTES)
    except AgentError as ex:
        if ex.code in ("agent_unavailable", "container_down", "transport", "bad_response",
                       "timeout"):
            raise agent_http(ex, "Lecture") from None
        return False
    return looks_binary(r.data)


async def _hist_avant(agent, rel: str, st: dict):
    """Contenu AVANT écriture pour l'historique (jamais bloquant) : octets,
    ``None`` (absent, pas un fichier), ``TOO_BIG`` au-delà de ``MAX_FILE``."""
    if st.get("kind") != "file":
        return None
    if int(st.get("size") or 0) > _fh.MAX_FILE:
        return _fh.TOO_BIG
    try:
        return (await agent.read(rel, max_bytes=_fh.MAX_FILE)).data
    except AgentError:
        return None


# ─────────────────────────────────────────────────────────────────────────────
#  DISCOVERY
# ─────────────────────────────────────────────────────────────────────────────
def _arbre(entrees: list) -> list:
    """Arbre de l'explorateur depuis la liste de l'agent (chemins relatifs à
    la racine) : liens ni listés ni suivis, à chaque niveau les dossiers puis
    les noms sans casse. Items ``{name, path, type, children | size}``."""
    noeuds: dict = {}
    for e in entrees:
        kind = e.get("kind")
        if kind == "link":
            continue
        chemin = e["path"]
        item: dict = {"name": chemin.rsplit("/", 1)[-1], "path": chemin,
                      "type": "folder" if kind == "dir" else "file"}
        if kind == "dir":
            item["children"] = []
        else:
            item["size"] = int(e.get("size") or 0)
        noeuds[chemin] = item
    racine: list = []
    for chemin, item in noeuds.items():
        parent = chemin.rsplit("/", 1)[0] if "/" in chemin else ""
        if not parent:
            racine.append(item)
        elif parent in noeuds:
            noeuds[parent]["children"].append(item)

    def trier(items: list) -> None:
        items.sort(key=lambda i: (i["type"] != "folder", i["name"].lower(), i["name"]))
        for i in items:
            if "children" in i:
                trier(i["children"])
    trier(racine)
    return racine


@router.get("/api/sandbox/tree")
async def api_get_sandbox_tree(request: Request, include_hidden: bool = False):
    user_id = require_user_id(request)
    root = _get_work_path(user_id)
    # Dotfiles masqués par défaut (explorateur propre) ; ré-inclus via le
    # toggle « Afficher les fichiers cachés ». Le terminal n'est pas concerné.
    #
    # ``TREE_MAX_ENTRIES`` plafonne le nombre TOTAL d'entrées : une sandbox
    # avec un ``node_modules`` produisait sinon un JSON de plusieurs Mo à
    # chaque ouverture de l'éditeur. La troncature est SIGNALÉE. Une seule
    # requête à l'agent, qui parcourt sans suivre de lien.
    try:
        liste = await agent_for(user_id).list("", depth=41, max_entries=TREE_MAX_ENTRIES,
                                              hidden=include_hidden, deadline_s=10)
    except AgentError as ex:
        raise agent_http(ex, "Arborescence") from None
    return JSONResponse(
        {"root": str(root.name), "items": _arbre(liste.entries),
         "truncated": liste.truncated, "max_entries": TREE_MAX_ENTRIES},
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


class _PinnedFileResponse(FileResponse):
    """``FileResponse`` d'un inode déjà ouvert (``/proc/self/fd/<n>``) : ni
    relecture du chemin d'origine, ni lien suivi ; en-têtes, ETag et requêtes
    ``Range`` de ``FileResponse`` conservés. Le descripteur est fermé une fois
    la réponse envoyée ou abandonnée."""

    def __init__(self, fd: int, **kwargs):
        super().__init__(f"/proc/self/fd/{fd}", stat_result=os.fstat(fd), **kwargs)
        self._fd = fd

    async def __call__(self, scope, receive, send):
        # Sans ``pathsend`` : le serveur rouvrirait ``/proc/self/fd/<n>``
        # après coup, descripteur fermé ou réattribué.
        ext = scope.get("extensions") or {}
        if "http.response.pathsend" in ext:
            scope = {**scope, "extensions": {k: v for k, v in ext.items()
                                             if k != "http.response.pathsend"}}
        try:
            await super().__call__(scope, receive, send)
        finally:
            os.close(self._fd)


def _pinned_file_response(root: Path, target: Path, **kwargs) -> "_PinnedFileResponse":
    """Réponse fichier de ``target`` (sous ``root``), ouvert sans suivre de lien."""
    return _PinnedFileResponse(open_beneath(root, rel_under(root, target)), **kwargs)


def _preview_file_response(root: Path, target: Path) -> FileResponse:
    """``FileResponse`` d'un fichier de sandbox.

    ``Cache-Control`` : sans en-tête explicite, l'``ETag`` seul ne force PAS
    la revalidation — le navigateur peut resservir l'ancien ``.css``/``.js``
    après une modification. On force la revalidation (304 à 0 octet tant que
    rien ne change).
    """
    mt, _ = mimetypes.guess_type(target.name)
    resp = _pinned_file_response(root, target, media_type=mt or "text/plain")
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
    uid = require_user_id(request)
    target = _sandbox_file(uid, path)
    if target is None:
        raise HTTPException(404, "Not found")
    try:
        return _preview_file_response(_get_work_path(uid), target)
    except (OSError, SandboxPathError):
        raise HTTPException(404, "Not found")


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
    root = _get_work_path(uid).resolve()
    text = None
    if kind in ("text/html", "text/css"):
        data = None
        try:
            with os.fdopen(open_beneath(root, rel_under(root, target)), "rb") as f:
                data = f.read(rw.MAX_REWRITE_BYTES + 1)
        except (OSError, SandboxPathError):
            raise HTTPException(404, "Not found")
        if len(data) <= rw.MAX_REWRITE_BYTES:
            text = data.decode("utf-8", errors="replace")
    if text is None:
        try:
            return _preview_cors(_preview_file_response(root, target))
        except (OSError, SandboxPathError):
            raise HTTPException(404, "Not found")
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


_UNREADABLE_ROOT = "Sandbox illisible (droits ou conteneur arrêté) — recherche impossible."


@router.get("/api/sandbox/search")
async def api_search_sandbox(request: Request, q: str, mode: str = "content"):
    """Search inside the user sandbox, by the sandbox agent (links never
    followed).

    mode=name    → filename filter
    mode=content → full-text search with line numbers and preview
    """
    user_id = require_user_id(request)
    if not q:
        return {"items": []}
    agent = agent_for(user_id)
    # Passe sandbox 2026-09-26 — bornes : arrêt à MAX_HITS résultats, plafond
    # de fichiers lus, échéance de 3 s (liste et recherche comprises) ;
    # ``truncated`` le signale au client. Un agent injoignable : 503 (E7 :
    # jamais un résultat vide « propre » quand rien n'a pu être lu).
    echeance = time.monotonic() + 3.0
    MAX_HITS = 200

    if mode == "name":
        try:
            liste = await agent.list("", depth=4096, max_entries=MAX_HITS, hidden=True,
                                     deadline_s=3.0, name_contains=q)
        except AgentError as ex:
            raise agent_http(ex, "Recherche") from None
        items = [{"path": e["path"], "name": e["path"].rsplit("/", 1)[-1], "type": "file"}
                 for e in liste.entries if e.get("kind") in ("file", "other")]
        return {"items": items, "errors": liste.errors, "truncated": liste.truncated}

    # mode=content — dossiers cachés, node_modules et __pycache__ non
    # parcourus ; fichiers cachés, eux, lus.
    SKIP_EXTS = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg',
                 '.woff', '.woff2', '.ttf', '.eot', '.pdf', '.zip', '.tar',
                 '.gz', '.bin', '.exe', '.so', '.pyc', '.db', '.sqlite'}
    MAX_FILE = 512 * 1024   # 512 KB
    MAX_FILES_SCANNED = 5000  # même ordre que /grep
    try:
        liste = await agent.list("", depth=4096, max_entries=50_000, hidden=True,
                                 prune=[".*", "node_modules", "__pycache__"], deadline_s=3.0)
        fichiers = [e["path"] for e in liste.entries
                    if e.get("kind") == "file" and int(e.get("size") or 0) <= MAX_FILE
                    and PurePosixPath(e["path"]).suffix.lower() not in SKIP_EXTS]
        truncated = liste.truncated or len(fichiers) > MAX_FILES_SCANNED
        fichiers = fichiers[:MAX_FILES_SCANNED]
        trouves, bilan = (await agent.grep(
            fichiers, q, ignore_case=True, max_file_bytes=MAX_FILE, max_hits=MAX_HITS,
            width=2000, deadline_s=max(0.5, echeance - time.monotonic()))
            if fichiers else ([], {}))
    except AgentError as ex:
        raise agent_http(ex, "Recherche") from None
    truncated = truncated or bool(bilan.get("hits_truncated") or bilan.get("timed_out"))
    q_lower = q.lower()
    results = []
    for h in trouves:
        line = h["text"]
        col = line.lower().find(q_lower) + 1 or 1
        # Aperçu court centré sur la première occurrence.
        preview = line.strip()
        if len(preview) > 120:
            start = max(0, col - 40)
            preview = ('…' if start > 0 else '') + line[start:start + 120].strip() + '…'
        results.append({"path": h["file"], "name": h["file"].rsplit("/", 1)[-1],
                        "line": h["line"], "col": col, "preview": preview})
    return {"items": results, "errors": liste.errors, "truncated": truncated}


# ─────────────────────────────────────────────────────────────────────────────
#  READ / WRITE
# ─────────────────────────────────────────────────────────────────────────────
def _read_consistent(root: Path, p: Path, attempts: int = 3):
    """``(octets, stat)`` d'un fichier ≤ ``_DOWNLOAD_SHA_MAX`` lus d'un seul
    tenant (stat identique avant et après la lecture), ou ``None`` (trop gros,
    illisible, ou réécrit en place à chaque tentative → repli en flux)."""
    for _ in range(attempts):
        try:
            with os.fdopen(open_beneath(root, rel_under(root, p)), "rb") as f:
                st1 = os.fstat(f.fileno())
                if st1.st_size > _DOWNLOAD_SHA_MAX:
                    return None
                data = f.read(_DOWNLOAD_SHA_MAX + 1)
                st2 = os.fstat(f.fileno())
        except (OSError, SandboxPathError):
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


def _spool_zip(root: Path, entries, *, max_bytes: int, max_files: int, strict: bool):
    """Écrit ``entries`` (itérable de ``(chemin relatif à root, nom dans
    l'archive)``) dans un zip temporaire sur disque ; seuls les fichiers
    réguliers sont lus, sans suivre de lien. Retourne ``(chemin_zip,
    nb_fichiers)``.

    ``strict`` : au-delà des plafonds, lève ``_ZipTooBig`` (dossier : une
    archive tronquée en silence tromperait l'utilisateur) ; sinon s'arrête et
    rend ce qui est déjà écrit (multi-fichiers : comportement historique)."""
    import tempfile
    fd, tmp = tempfile.mkstemp(prefix="dl-", suffix=".zip", dir=str(_zip_spool_dir()))
    os.close(fd)
    total = written = 0
    try:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            for rel, arc in entries:
                try:
                    src = os.fdopen(open_beneath(root, rel), "rb")
                except (OSError, SandboxPathError):
                    continue                          # lien, fichier spécial, disparu
                with src:
                    st = os.fstat(src.fileno())
                    if total + st.st_size > max_bytes or written + 1 > max_files:
                        if strict:
                            raise _ZipTooBig()
                        break
                    try:
                        _zip_copy(zf, arc, src, st)
                    except OSError:
                        continue
                total += st.st_size
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
            served = _read_consistent(root, target_path)
            if served is not None:
                data, st = served
                from urllib.parse import quote as _q

                from fastapi.responses import Response
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
            resp = _pinned_file_response(root, target_path, filename=target_path.name)
        except (OSError, SandboxPathError):
            raise HTTPException(404, "Not found")
        _no_cache(resp)
        resp.headers["X-Mtime"] = str(resp.stat_result.st_mtime)
        resp.headers["X-Size"] = str(resp.stat_result.st_size)
        resp.headers["Access-Control-Expose-Headers"] = "X-Mtime, X-Size"
        return resp

    # If it's a folder, zip it (on disk) and serve
    folder_name = target_path.name or "folder"
    folder_rel = rel_under(root, target_path)

    def _entries():
        # Parcours par descripteurs : ni lien suivi, ni dossier remplacé par
        # un lien pendant le parcours ; ``_spool_zip`` ne lit que des fichiers
        # réguliers, ouverts sans suivre de lien.
        for rel_dir, _dirs, names, _dfd in walk_beneath(root, folder_rel):
            for fn in names:
                rel = f"{rel_dir}/{fn}" if rel_dir else fn
                yield rel, f"{folder_name}/{PurePosixPath(rel).relative_to(folder_rel)}"

    try:
        tmp, _n = _spool_zip(root, _entries(), max_bytes=_ZIP_DIR_MAX_BYTES,
                             max_files=_ZIP_DIR_MAX_FILES, strict=True)
    except (OSError, SandboxPathError):
        raise HTTPException(404, "Not found")
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
            try:
                rel = rel_under(root, target_path)
            except ValueError:
                continue
            yield rel, rel

    # Au-delà de la limite : on renvoie ce qui est déjà écrit (succès partiel,
    # comportement historique) ; un fichier illisible est sauté.
    tmp, written = await asyncio.to_thread(
        _spool_zip, root, _entries(), max_bytes=MAX_TOTAL_BYTES, max_files=500, strict=False)

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
    from shared_infra.config import MAX_UPLOAD_BYTES
    from shared_infra.files.uploads import read_upload_bounded
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
                    _before = await _hist_before(root, safe)
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

    from shared_infra.sandbox.exec_bridge import sandbox_append_chunk, sandbox_delete, sandbox_rename

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
            _before = await _hist_before(root, safe)
            try:
                await sandbox_rename(user_id, tmp_rel, rel_path, overwrite=True)
            except HTTPException:
                try:
                    await sandbox_delete(user_id, tmp_rel)
                except HTTPException:
                    pass
                invalidate_sandbox_usage(user_id)
                raise
            _st = await asyncio.to_thread(_file_state, root, safe, sha_max=_DOWNLOAD_SHA_MAX)
        new_mtime = _st.get("mtime")
        # Historique (source « upload ») : contenu relu (fichier ≤ 5 Mo gardé).
        await _hist_write(user_id, _strip_work_prefix(rel_path), _before,
                          await _hist_before(root, safe), "upload")
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


def _save_conflict(st: dict, expected_mtime=None, expected_sha256=None):
    """Détail du 412 si le fichier (état ``st``, cf. :func:`_etat_agent`) a
    changé ou disparu depuis la version de référence de l'onglet, sinon None.

    Audit éditeur 2026-09-23 :
    * E6 — ``expected_sha256`` (hash du CONTENU) fait autorité quand il est
      fourni : un changement qui conserve le mtime (``cp -p``, ``touch -r``,
      deux écritures dans le même tick) ne passe plus. ``expected_mtime``
      reste accepté seul (clients plus anciens).
    * E26 — un ``stat`` qui lève ``PermissionError``/``NotADirectoryError``
      ne vaut plus « pas de précondition » : refus explicite.
    """
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
    if kind == "other":
        return 409, {"code": "not_file",
                     "message": "Ce chemin n'est pas un fichier ordinaire (lien ou fichier spécial)"}
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
    rel = _rel_editeur(root, rel_path)
    agent = agent_for(user_id)
    # Garde anti-corruption : du TEXTE ne remplace jamais un binaire existant
    # (xlsx/pdf/zip ouverts par erreur dans Monaco puis sauvegardés). Le
    # ``content_b64`` (binaire explicite) n'est pas concerné.
    if raw_bytes is None and await _binaire_existant(agent, rel):
        raise HTTPException(409, "Fichier binaire : sauvegarde refusée")
    # Création seule (« Nouveau fichier ») : un nom déjà pris n'est JAMAIS
    # vidé en silence. Détail structuré : le front propose d'ouvrir l'existant.
    _if_absent = bool(data.get("if_absent"))
    _existe = {"code": "exists", "message": "Un fichier porte déjà ce nom"}
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
    try:
        # Quota + écriture sous le verrou du compte (anti-TOCTOU du quota) et
        # sous celui du FICHIER, commun avec les outils de l'assistant (E7).
        # L'état vérifié ici l'est de nouveau par l'agent au remplacement
        # (``if_sha256`` / ``if_mtime_ns`` / ``if_absent``) : une écriture du
        # terminal entre les deux est refusée, pas écrasée.
        async with _quota_lock_for(user_id), _file_lock(root / rel):
            st = await _etat_agent(agent, rel, sha_max=_DOWNLOAD_SHA_MAX)
            condition: dict = {}
            if expected_sha is not None or expected_mtime is not None:
                _conflict = _save_conflict(st, expected_mtime, expected_sha)
                if _conflict is not None:
                    raise HTTPException(*_conflict)
                condition = ({"if_sha256": st["sha256"]} if st.get("sha256")
                             else {"if_mtime_ns": st["mtime_ns"]})
            elif st["kind"] == "dir":
                # E25 — un DOSSIER porte ce nom : refus, même sans précondition.
                raise HTTPException(409, {"code": "is_dir", "message": "Un dossier porte ce nom"})
            if _if_absent:
                if st["kind"] != "missing":
                    raise HTTPException(409, _existe)
                condition = {"if_absent": True}
            # ── Quota check (per-user override wins) ─────────────────
            _user_settings = get_user_settings(user_id)
            if "sandbox_quota_mb" in _user_settings:
                _quota_mb = int(_user_settings["sandbox_quota_mb"])
            else:
                _cfg = config_view() or {}
                _quota_mb = int(_cfg.get("app", {}).get("sandbox_quota_mb", 5120))
            _existing = int(st.get("size") or 0) if st["kind"] == "file" else 0
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
            # Historique de session : contenu AVANT l'écriture.
            _before = await _hist_avant(agent, rel, st)
            _t = time.time()
            try:
                r = await agent.write(rel, _payload, parents=True, **condition)
            except AgentError as ex:
                if ex.code == "changed":
                    st2 = await _etat_agent(agent, rel, sha_max=_DOWNLOAD_SHA_MAX)
                    raise HTTPException(412, _conflict_detail(
                        st2["kind"] == "missing", st2, "Le fichier a changé sur le disque")) from None
                if ex.code == "exists":
                    raise HTTPException(409, _existe) from None
                raise agent_http(ex, "Sauvegarde") from None
            bump_sandbox_usage(user_id, _net_new)   # delta connu → pas de ``du``
            write_dur = round(time.time() - _t, 4)
            # mtime serveur de NOTRE écriture (PASSE 14 : pas de Date.now()
            # côté navigateur) ; ``sha256`` des octets envoyés.
            new_mtime = _mtime_s(int(r["mtime_ns"])) if r.get("mtime_ns") else None
        await _hist_write(user_id, rel, _before, _payload, _source)
        ext = PurePosixPath(rel).suffix.lstrip(".")
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
    rel = _rel_editeur(root, path)
    agent = agent_for(user_id)
    e = await _stat_un(agent, rel, "Suppression")
    if e["kind"] == "missing":
        raise HTTPException(404, "Not found")
    from shared_infra.sandbox.exec_bridge import sandbox_delete
    # Historique de session (audit éditeur 2026-09-23) : la suppression d'un
    # FICHIER est notée (contenu d'avant gardé) ; un dossier ou un lien, non.
    _is_file = e["kind"] == "file" and not e.get("link")
    _before = await _hist_avant(agent, rel, e) if _is_file else None
    try:
        await sandbox_delete(user_id, path)
        invalidate_sandbox_usage(user_id)   # taille supprimée inconnue
        if _is_file:
            await _hist_write(user_id, rel, _before, None, "editor")
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
    _rel_editeur(_get_work_path(user_id), rel_path)     # 403 hors de la sandbox
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
    old, new = _rel_editeur(root, old_rel), _rel_editeur(root, new_rel)
    agent = agent_for(user_id)
    if (await _stat_un(agent, old, "Renommage"))["kind"] == "missing":
        raise HTTPException(404, "Source not found")
    # Une cible existante n'est jamais écrasée (renommer a.py en b.py
    # détruisait b.py) ; l'agent le vérifie de nouveau au renommage.
    if new != old and (await _stat_un(agent, new, "Renommage"))["kind"] != "missing":
        raise HTTPException(409, "Un élément porte déjà ce nom à cet endroit")
    from shared_infra.sandbox.exec_bridge import sandbox_rename
    try:
        await sandbox_rename(user_id, old_rel, new_rel)
        # L'historique de session suit le fichier (ou le dossier) renommé.
        try:
            await asyncio.to_thread(_fh.record_move, user_id, old, new)
        except Exception:                                       # noqa: BLE001
            logger.exception("[sandbox] historique : renommage non noté")
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Rename error: {str(e)}")


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
    src, dst = _rel_editeur(root, src_rel), _rel_editeur(root, dst_rel)
    agent = agent_for(user_id)
    e = await _stat_un(agent, src, "Copie")
    if e["kind"] == "missing":
        raise HTTPException(404, "Source introuvable")
    if (await _stat_un(agent, dst, "Copie"))["kind"] != "missing":
        raise HTTPException(409, "Un élément porte déjà ce nom à cet endroit")
    if not src or dst == src or dst.startswith(src + "/"):
        raise HTTPException(400, "Impossible de copier un dossier dans lui-même")
    from shared_infra.sandbox.exec_bridge import sandbox_copy
    async with _quota_lock_for(user_id):
        _user_settings = get_user_settings(user_id)
        if "sandbox_quota_mb" in _user_settings:
            _quota_mb = int(_user_settings["sandbox_quota_mb"])
        else:
            _quota_mb = int((config_view() or {}).get("app", {}).get("sandbox_quota_mb", 5120))
        try:
            du = await agent.fsop("du", path=src, deadline_s=30)
        except AgentError as ex:
            raise agent_http(ex, "Copie") from None
        size = int(du.get("bytes") or 0)
        if _quota_mb > 0:
            if not du.get("complete"):
                raise HTTPException(413, "Arborescence trop grande pour vérifier le quota")
            used = await asyncio.to_thread(
                sandbox_usage_bytes, user_id, root,
                quota_bytes=_quota_mb * 1024 * 1024)
            if used + size > _quota_mb * 1024 * 1024:
                raise HTTPException(413, f"Quota sandbox dépassé ({_quota_mb} Mo)")
        await sandbox_copy(user_id, src_rel, dst_rel)
        bump_sandbox_usage(user_id, size)
    # Historique de session : une copie de FICHIER est une création.
    if e["kind"] == "file" and not e.get("link"):
        _after = await _hist_avant(agent, dst, e)
        if _after is not None:
            await _hist_write(user_id, dst, None, _after, "editor")
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

    # Expression validée ici (400 lisible) ; la recherche elle-même tourne
    # dans l'agent de la sandbox — une expression coûteuse n'occupe que le
    # conteneur de l'utilisateur, plus un thread partagé de l'hôte.
    if use_regex:
        try:
            _re.compile(query, 0 if case_sensitive else _re.IGNORECASE)
        except _re.error as e:
            raise HTTPException(400, f"Regex invalide : {e}")

    agent = agent_for(user_id)
    started = _t.monotonic()
    try:
        # Dossiers ignorés (et cachés, sauf demande) non parcourus.
        liste = await agent.list(
            "", depth=4096, max_entries=_GREP_MAX_FILES_SCANNED * 4, hidden=include_hidden,
            prune=sorted(_GREP_IGNORED_DIRS), deadline_s=_GREP_TIMEOUT_SEC)
        fichiers = [e["path"] for e in liste.entries if e.get("kind") == "file"
                    and (not glob_pattern
                         or fnmatch.fnmatch(e["path"].rsplit("/", 1)[-1], glob_pattern))]
        truncated = liste.truncated or len(fichiers) > _GREP_MAX_FILES_SCANNED
        fichiers = fichiers[:_GREP_MAX_FILES_SCANNED]
        reste = _GREP_TIMEOUT_SEC - (_t.monotonic() - started)
        trouves, bilan = (await agent.grep(
            fichiers, query, ignore_case=not case_sensitive, regex=use_regex,
            max_file_bytes=_GREP_MAX_FILE_BYTES, max_hits=_GREP_MAX_RESULTS,
            context=_GREP_SNIPPET_RADIUS, max_line=_GREP_MAX_LINE_CHARS,
            deadline_s=max(0.5, reste)) if fichiers else ([], {}))
    except AgentError as ex:
        raise agent_http(ex, "Recherche") from None
    matches = [{"path": h["file"], "line": h["line"], "col": h["col"], "snippet": h["text"],
                "match_start": h["match_start"], "match_end": h["match_end"]} for h in trouves]
    return {
        "matches":             matches,
        "total_files_scanned": len(fichiers),
        "truncated":           truncated or bool(bilan.get("hits_truncated")
                                                 or bilan.get("timed_out")),
        "elapsed_ms":          int((_t.monotonic() - started) * 1000),
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


def _remplacement(e: dict, raw: Optional[bytes], pat, repl):
    """Remplacement dans UN fichier lu par l'agent (``e`` : son entrée de
    liste ou de ``stat``, ``raw`` : son contenu).

    Rend ``(texte, nouveau_texte, n, échantillons)``, ou une chaîne = raison
    d'ignorer, ou None (rien à remplacer / fichier hors champ : binaire, pas
    de l'UTF-8 strict, trop gros). Un lien symbolique est ignoré, comme avant
    l'agent."""
    if e.get("kind") == "link" or e.get("link"):
        return "lien symbolique"
    if e.get("kind") != "file":
        return "fichier spécial"
    if raw is None or len(raw) > _GREP_MAX_FILE_BYTES or _is_likely_binary(raw[:512]):
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
    return text, new_text, n, samples


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
    agent = agent_for(user_id)

    # ── Aperçu : liste et présélection par l'agent (une recherche groupée),
    #    puis les seuls candidats lus par lots ; bornes de fichiers et de temps.
    if dry_run:
        files, skipped = [], []
        started = _t.monotonic()
        try:
            liste = await agent.list(
                "", depth=4096, max_entries=_GREP_MAX_FILES_SCANNED * 4, hidden=include_hidden,
                prune=sorted(_GREP_IGNORED_DIRS), deadline_s=_REPLACE_SCAN_TIMEOUT_SEC)
            entrees = [e for e in liste.entries if e.get("kind") != "dir"
                       and (not glob_pattern
                            or fnmatch.fnmatch(e["path"].rsplit("/", 1)[-1], glob_pattern))]
            truncated = liste.truncated or len(entrees) > _GREP_MAX_FILES_SCANNED
            entrees = entrees[:_GREP_MAX_FILES_SCANNED]
            for e in entrees:
                if e["kind"] != "file":
                    skipped.append({"path": e["path"], "reason": _remplacement(e, None, pat, repl)})
            fichiers = [e["path"] for e in entrees if e["kind"] == "file"
                        and int(e.get("size") or 0) <= _GREP_MAX_FILE_BYTES]
            trouves, bilan = (await agent.grep(
                fichiers, query, ignore_case=not case_sensitive, regex=use_regex,
                files_only=True, max_hits=len(fichiers), max_file_bytes=_GREP_MAX_FILE_BYTES,
                max_line=_GREP_MAX_FILE_BYTES,
                deadline_s=max(0.5, _REPLACE_SCAN_TIMEOUT_SEC - (_t.monotonic() - started)))
                if fichiers else ([], {}))
            truncated = truncated or bool(bilan.get("timed_out"))
            candidats = [h["file"] for h in trouves]
            n_lus = 0
            while n_lus < len(candidats):
                if (len(files) >= _REPLACE_MAX_FILES
                        or (_t.monotonic() - started) > _REPLACE_SCAN_TIMEOUT_SEC):
                    truncated = True
                    break
                lot = candidats[n_lus:n_lus + 200]
                lus = await agent.read_many(lot, max_file=_GREP_MAX_FILE_BYTES,
                                            max_total=32 * 1024 * 1024)
                for rel in lot:
                    if rel not in lus:
                        break                           # hors budget : lot suivant
                    n_lus += 1
                    res = _remplacement({"kind": "file"}, lus[rel], pat, repl)
                    if res is None:
                        continue
                    # Le pont d'écriture normalise ``work/…`` (et les blancs de
                    # bord) : un tel chemin serait LU ici mais ÉCRIT ailleurs.
                    if _strip_work_prefix(rel) != rel:
                        res = "chemin ambigu (work/)"
                    if isinstance(res, str):
                        skipped.append({"path": rel, "reason": res})
                        continue
                    _text, _new, n, samples = res
                    files.append({
                        "path": rel, "count": n,
                        "samples": [{"line": ln, "before": b[:300], "after": a[:300]}
                                    for ln, b, a in samples],
                    })
                    if len(files) >= _REPLACE_MAX_FILES:
                        break
        except AgentError as ex:
            raise agent_http(ex, "Remplacement") from None
        return {"files": files, "total": sum(f["count"] for f in files),
                "truncated": truncated, "skipped": skipped}

    # ── Application : fichier par fichier, SOUS le verrou du compte. Chaque
    #    fichier est relu juste avant d'être écrit (jamais un texte lu pendant
    #    l'aperçu) ; l'agent n'écrit que si le contenu est encore celui relu
    #    (sinon ignoré : modifié entre sa lecture et son écriture).
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
            # E7 — relecture, contrôle et écriture sous le verrou du fichier,
            # commun avec les outils de l'assistant.
            async with _file_lock(root / rel):
                try:
                    (e,) = await agent.stat([rel])
                    raw = None
                    if (e.get("kind") == "file" and not e.get("link")
                            and int(e.get("size") or 0) <= _GREP_MAX_FILE_BYTES):
                        raw = (await agent.read(rel, max_bytes=_GREP_MAX_FILE_BYTES + 1)).data
                except AgentError:
                    continue                            # disparu ou illisible
                if e.get("kind") in ("missing", "error"):
                    continue
                res = _remplacement(e, raw, pat, repl)
                if res is None:
                    continue
                if isinstance(res, str):
                    skipped.append({"path": rel, "reason": res})
                    continue
                text, new_text, n, _samples = res
                old_bytes = text.encode("utf-8")
                new_bytes = new_text.encode("utf-8")
                delta = len(new_bytes) - len(old_bytes)
                if _quota_mb > 0 and delta > 0 and _used + delta > _quota_bytes:
                    failed = {"path": rel, "error": f"Quota sandbox dépassé ({_quota_mb} Mo)"}
                    break
                try:
                    r = await agent.write(rel, new_bytes, if_sha256=sha256_bytes(old_bytes))
                except AgentError as ex:
                    if ex.code == "changed":
                        skipped.append({"path": rel, "reason": "modifié pendant l'opération"})
                        continue
                    failed = {"path": rel, "error": str(agent_http(ex, "Remplacement").detail)}
                    break
                mtime = _mtime_s(int(r["mtime_ns"])) if r.get("mtime_ns") else None
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
    if not full.name.lower().endswith(".docx"):
        raise HTTPException(400, "Pas un fichier .docx")
    # Octets lus sur l'inode, sans suivre de lien (2026-09-29).
    try:
        with os.fdopen(open_beneath(root, rel_under(root, full)), "rb") as f:
            size = os.fstat(f.fileno()).st_size
            if size > _DOCX_MAX_BYTES:
                raise HTTPException(413, f"Fichier trop gros (max {_DOCX_MAX_BYTES // (1024*1024)} MB)")
            data = f.read(_DOCX_MAX_BYTES + 1)
    except (OSError, SandboxPathError):
        raise HTTPException(404, "Fichier introuvable")

    try:
        from docx import Document  # python-docx
    except ImportError:
        raise HTTPException(
            501,
            "Support .docx non installé côté serveur (pip install python-docx)",
        )

    try:
        doc = Document(io.BytesIO(data))
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
    """Compare l'état connu du frontend (mtime, taille, hash) avec le disque,
    en deux requêtes groupées à l'agent : les états, puis les empreintes
    utiles seulement (fichiers ≤ ``_CHECK_SHA_MAX``)."""
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

    root = _get_work_path(user_id)
    demandes = []                  # (chemin du client, rel, mtime, taille, sha)
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
            rel = _rel_editeur(root, path)
        except HTTPException:
            continue                                # hors de la sandbox : ignoré
        demandes.append((path, rel, client_mtime, client_size, client_sha))
    if not demandes:
        return {"stale": [], "truncated": truncated}

    agent = agent_for(user_id)
    try:
        etats = await agent.stat([d[1] for d in demandes])
    except AgentError as ex:
        raise agent_http(ex, "Vérification") from None
    stale: List[dict] = []
    a_hacher = []                                   # (indice, rel)
    for n, ((path, rel, client_mtime, client_size, client_sha), e) in enumerate(zip(demandes, etats)):
        kind = e.get("kind")
        if kind == "missing" or (kind == "error" and e.get("error") == "not_dir"):
            stale.append({"path": path, "missing": True})
            continue
        if kind == "error":
            stale.append({"path": path, "unreadable": True})
            continue
        if kind != "file":
            stale.append({"path": path, "not_file": True})
            continue
        taille, mtime = int(e.get("size") or 0), _mtime_s(int(e.get("mtime_ns") or 0))
        changed = (abs(mtime - client_mtime) > _SAVE_MTIME_EPS
                   or (client_size is not None and client_size != taille))
        if taille <= _CHECK_SHA_MAX and (changed or client_sha is not None):
            a_hacher.append((n, rel))
        stale.append({"path": path, "new_mtime": mtime, "size": taille, "sha256": None,
                      "_changed": changed, "_sha": client_sha})
    if a_hacher:
        try:
            empreintes = await agent.stat([r for _n, r in a_hacher], hash=True,
                                          hash_max=_CHECK_SHA_MAX)
        except AgentError as ex:
            raise agent_http(ex, "Vérification") from None
        for (n, _r), e in zip(a_hacher, empreintes):
            d = stale[n]
            sha = e.get("sha256") if e.get("kind") == "file" else None
            if sha is None:
                if not d["_changed"]:               # empreinte nécessaire pour trancher
                    stale[n] = {"path": d["path"], "unreadable": True}
                continue
            d["sha256"] = sha
            if not d["_changed"] and d["_sha"] is not None:
                d["_changed"] = sha != d["_sha"]
    rendu = []
    for d in stale:
        if "_changed" in d:
            if not d.pop("_changed"):
                continue
            d.pop("_sha")
        rendu.append(d)
    return {"stale": rendu, "truncated": truncated}


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
        st = await asyncio.to_thread(_file_state, root, full, sha_max=_DOWNLOAD_SHA_MAX)
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


def export_work_archive(root: Path, fileobj) -> None:
    """Écrit dans ``fileobj`` une archive tar.gz des fichiers RÉGULIERS de
    ``root`` (``/work``), chacun lu sur son inode ouvert sans suivre de lien
    (2026-09-29) ; liens et fichiers spéciaux sont omis."""
    import tarfile as _tarfile
    with _tarfile.open(fileobj=fileobj, mode="w:gz") as tf:
        for rel_dir, dirnames, names, dfd in walk_beneath(root):
            dirnames.sort()
            for name in sorted(names):
                try:
                    src = os.fdopen(open_leaf(dfd, name), "rb")
                except (OSError, SandboxPathError):
                    continue
                with src:
                    tf.addfile(tf.gettarinfo(arcname=f"{rel_dir}/{name}" if rel_dir else name,
                                             fileobj=src), src)


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
            with os.fdopen(fd, "wb") as fh:
                export_work_archive(root, fh)
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

