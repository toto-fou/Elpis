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
from pathlib import Path, PurePosixPath
from typing import Any, Dict, List, Optional

from fastapi import File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse

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
from shared_infra.sandbox.exec_bridge import PANNES_AGENT, agent_for, agent_http
from shared_infra.sandbox.file_lock import file_write_lock, sha256_bytes
from shared_infra.sandbox.paths import (
    SandboxPathError,
    lexical_rel,
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
    _quota_lock_for,
    _strip_work_prefix,
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


async def _hist_write(user_id: int, rel: str, before, after, source: str) -> None:
    """``file_history.record_write`` hors boucle ; n'échoue jamais."""
    try:
        await asyncio.to_thread(_fh.record_write, user_id, rel, before, after, source)
    except Exception:                                           # noqa: BLE001
        logger.exception("[sandbox] historique : écriture non notée (%s)", rel)


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
    le disque (``~`` est un nom : les chemins viennent de l'arbre) ; hors de
    la sandbox : 403."""
    try:
        return lexical_rel(root, rel_path, tilde=False)
    except SandboxPathError:
        raise HTTPException(403, "Access denied") from None


async def _etat_agent(agent, rel: str, *, sha_max: int) -> dict:
    """État de ``rel`` par l'agent (un refus sur le fichier n'est pas levé) :
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
        code = str(e.get("error") or "")
        if code == "not_dir":
            return {"kind": "not_dir"}
        if code in ("denied", "io_error"):
            return {"kind": "unreadable"}
        # Chemin lui-même refusé (nom trop long, lien hors de /work…).
        raise agent_http(AgentError(code, str(e.get("message") or "")), "Lecture")
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


async def _stats_lots(agent, rels: list) -> list:
    """``stat`` de l'agent par lots (10 000 chemins au plus par requête)."""
    out: list = []
    for i in range(0, len(rels), 10_000):
        out += await agent.stat(rels[i:i + 10_000])
    return out


async def _binaire_existant(agent, rel: str) -> bool:
    """Vrai si ``rel`` est un fichier existant qui ne s'édite pas comme texte
    (en-tête lu par l'agent) ; absent, spécial ou illisible : faux."""
    from shared_infra.sandbox.filetypes import SNIFF_BYTES, looks_binary
    try:
        r = await agent.read(rel, length=SNIFF_BYTES, max_bytes=SNIFF_BYTES)
    except AgentError as ex:
        if ex.code in PANNES_AGENT:
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
                                              hidden=include_hidden, deadline_s=10,
                                              kinds=("dir", "file", "other"))
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


_BLOC_REPONSE = 1 << 20


def _plage(entete: Optional[str], taille: int):
    """``(début, fin)`` (fin exclue) d'un en-tête ``Range`` à UNE plage, None
    sans plage utilisable (plusieurs plages : contenu entier, permis par la
    norme), ``"invalide"`` hors du fichier (416)."""
    m = re.fullmatch(r"\s*bytes=(\d*)-(\d*)\s*", entete or "")
    if not m or (not m.group(1) and not m.group(2)):
        return None
    if not m.group(1):                                  # suffixe : les N derniers octets
        n = int(m.group(2))
        return (max(0, taille - n), taille) if n else "invalide"
    debut = int(m.group(1))
    fin = min(int(m.group(2)) + 1, taille) if m.group(2) else taille
    return (debut, fin) if debut < taille and debut < fin else "invalide"


async def _reponse_agent(request: Request, agent, rel: str, e: dict, media_type: str):
    """Réponse d'un fichier lu par l'agent par blocs (jamais chargé en
    entier), toutes les plages lues sur la MÊME version (taille, mtime et
    inode vérifiés par l'agent) : ETag / Last-Modified comme ``FileResponse``,
    304 sur ``If-None-Match``, une plage ``Range`` (206, ``If-Range``
    respecté). Le premier bloc est lu AVANT l'envoi du statut : un fichier
    changé depuis ``e`` est repris une fois sur son nouvel état (encore
    changé : 503) ; changé pendant le transfert, celui-ci s'interrompt.

    ``Cache-Control`` : sans en-tête explicite, l'``ETag`` seul ne force PAS
    la revalidation — le navigateur pouvait resservir l'ancien ``.css``/
    ``.js`` après une modification (304 à 0 octet tant que rien ne change)."""
    from email.utils import formatdate

    from fastapi.responses import Response, StreamingResponse
    for essai in (1, 2):
        taille, ns = int(e.get("size") or 0), int(e.get("mtime_ns") or 0)
        ino = e.get("ino") if isinstance(e.get("ino"), int) else None
        version = {"expect_size": taille, "expect_mtime_ns": ns, "expect_ino": ino}
        mtime = _mtime_s(ns)
        # L'inode en plus : un remplacement de même taille et même mtime
        # change l'ETag (304 et ``If-Range`` ne mêlent pas deux versions).
        etag = '"' + hashlib.md5(f"{mtime}-{taille}-{ino}".encode(),
                                 usedforsecurity=False).hexdigest() + '"'
        entetes = {"etag": etag, "last-modified": formatdate(mtime, usegmt=True),
                   "accept-ranges": "bytes", "cache-control": "no-cache, must-revalidate"}
        _security_headers(entetes, media_type)
        if etag in [x.strip() for x in (request.headers.get("if-none-match") or "").split(",")]:
            return Response(status_code=304, headers=entetes)
        debut, fin, statut = 0, taille, 200
        if request.headers.get("if-range") in (None, etag):
            plage = _plage(request.headers.get("range"), taille)
            if plage == "invalide":
                return Response(status_code=416, headers={**entetes, "content-range": f"bytes */{taille}"})
            if plage:
                (debut, fin), statut = plage, 206
                entetes["content-range"] = f"bytes {debut}-{fin - 1}/{taille}"
        entetes["content-length"] = str(fin - debut)
        try:
            n = min(_BLOC_REPONSE, fin - debut)
            premier = (await agent.read(rel, offset=debut, length=n, max_bytes=n, **version)).data \
                if n > 0 else b""
        except AgentError as ex:
            if ex.code != "changed":
                raise agent_http(ex, "Lecture") from None
            if essai == 2:
                break
            try:
                (e,) = await agent.stat([rel])
            except AgentError as ex2:
                raise agent_http(ex2, "Lecture") from None
            if e.get("kind") != "file":
                raise HTTPException(404, "Not found") from None
            continue

        async def corps(premier=premier, pos=debut + len(premier), fin=fin, version=version):
            yield premier
            while pos < fin:
                n = min(_BLOC_REPONSE, fin - pos)
                r = await agent.read(rel, offset=pos, length=n, max_bytes=n, **version)
                if not r.data:
                    return
                yield r.data
                pos += len(r.data)
        resp = StreamingResponse(corps(), status_code=statut, media_type=media_type,
                                 headers=entetes)
        # État de la version SERVIE (reprise après un changement comprise) :
        # ``X-Size`` / ``X-Mtime`` du téléchargement en décrivent les octets.
        resp.elpis_stat = e                              # type: ignore[attr-defined]
        return resp
    raise HTTPException(503, "Fichier en cours de modification — réessayez.",
                        headers={"Retry-After": "1"})


async def _fichier_agent(user_id: int, path: str):
    """``(agent, rel, entrée)`` du fichier ``path`` de la sandbox de
    ``user_id`` (un lien suivi sous /work seulement), ou None : absent, hors
    sandbox, pas un fichier — même « introuvable » partout, sans oracle."""
    try:
        rel = _rel_editeur(_get_work_path(user_id), path)
    except HTTPException:
        return None
    agent = agent_for(user_id)
    try:
        (e,) = await agent.stat([rel])
    except AgentError as ex:
        raise agent_http(ex, "Lecture") from None
    return (agent, rel, e) if e.get("kind") == "file" else None


@router.get("/api/sandbox/serve/{path:path}")
async def api_serve_sandbox(request: Request, path: str):
    """Lecture d'un fichier (session). Pour l'AFFICHAGE d'une page, voir
    ``/api/sandbox/pv/`` : ici un document actif reçoit une origine opaque,
    ses sous-ressources n'auraient donc pas la session."""
    trouve = await _fichier_agent(require_user_id(request), path)
    if trouve is None:
        raise HTTPException(404, "Not found")
    agent, rel, e = trouve
    mt = mimetypes.guess_type(PurePosixPath(rel).name)[0] or "text/plain"
    return await _reponse_agent(request, agent, rel, e, mt)


@router.get("/api/sandbox/preview-token")
def api_preview_token(request: Request):
    """Jeton d'URL de l'aperçu (cf. ``preview_token``), lié à la session."""
    from shared_infra.sandbox.preview_token import make_preview_token
    token, exp = make_preview_token(require_user_id(request))
    return _no_cache(JSONResponse({"token": token, "expires": exp}))


async def _resolve_from(user_id: int, doc_dir: str, wanted: str):
    """``wanted`` cherché dans ``doc_dir`` puis en remontant (borné) vers la
    racine sandbox — règle de l'ancien repli 404, sans le ``Referer`` ; les
    candidats sont vérifiés en une requête à l'agent. ``(agent, rel,
    entrée)`` ou None."""
    root = _get_work_path(user_id)
    parts = [p for p in PurePosixPath(_strip_work_prefix(doc_dir)).parts
             if p not in ("", ".", "/")]
    lowest = max(0, len(parts) - _PREVIEW_ROOT_WALK_MAX)
    candidats = []
    for depth in range(len(parts), lowest - 1, -1):
        try:
            candidats.append(_rel_editeur(root, "/".join([*parts[:depth], wanted])))
        except HTTPException:
            continue
    if not candidats:
        return None
    agent = agent_for(user_id)
    try:
        entrees = await agent.stat(candidats)
    except AgentError as ex:
        raise agent_http(ex, "Lecture") from None
    for rel, e in zip(candidats, entrees):
        if e.get("kind") == "file":
            return agent, rel, e
    return None


@router.get("/api/sandbox/pv/{token}/{path:path}")
async def api_preview_sandbox(request: Request, token: str, path: str):
    """Aperçu « Web » : identité portée par le jeton du chemin, pas par le
    cookie (qu'un document à origine opaque n'envoie pas).

    ``~r/d<dossier>/<chemin>`` : résolveur des refs absolues-racine,
    réécrites dans le HTML et le CSS servis (cf. ``preview_rewrite``)."""
    from shared_infra.sandbox import preview_rewrite as rw
    from shared_infra.sandbox.preview_token import check_preview_token
    uid = check_preview_token(token)
    if uid is None:
        raise HTTPException(403, "Aperçu expiré : rechargez-le")
    trouve = None
    if path.startswith(rw.RESOLVER + "/"):
        split = rw.split_resolver(path[len(rw.RESOLVER) + 1:])
        if split:
            trouve = await _resolve_from(uid, *split)
    else:
        trouve = await _fichier_agent(uid, path)
    if trouve is None:
        raise HTTPException(404, "Not found")
    agent, rel, e = trouve
    mt = mimetypes.guess_type(PurePosixPath(rel).name)[0] or "text/plain"
    kind = mt.split(";")[0].strip().lower()
    if kind not in ("text/html", "text/css") or int(e.get("size") or 0) > rw.MAX_REWRITE_BYTES:
        return _preview_cors(await _reponse_agent(request, agent, rel, e, mt))
    try:
        data = (await agent.read(rel, max_bytes=rw.MAX_REWRITE_BYTES)).data
    except AgentError as ex:
        if ex.code in ("not_found", "is_dir", "not_file", "too_large", "outside_root"):
            raise HTTPException(404, "Not found") from None
        raise agent_http(ex, "Lecture") from None
    doc_dir = PurePosixPath(rel).parent.as_posix()
    base = rw.resolver_base(f"{PREVIEW_URL_PREFIX}{token}/", "" if doc_dir == "." else doc_dir)
    reecrire = rw.rewrite_html if kind == "text/html" else rw.rewrite_css
    # Jusqu'à MAX_REWRITE_BYTES de texte réécrit : hors de la boucle d'événements.
    body = await asyncio.to_thread(lambda: reecrire(data.decode("utf-8", errors="replace"), base))
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
                                     deadline_s=3.0, name_contains=q, kinds=("file", "other"))
        except AgentError as ex:
            raise agent_http(ex, "Recherche") from None
        items = [{"path": e["path"], "name": e["path"].rsplit("/", 1)[-1], "type": "file"}
                 for e in liste.entries]
        return {"items": items, "errors": liste.errors, "truncated": liste.truncated}

    # mode=content — dossiers cachés, node_modules et __pycache__ non
    # parcourus ; fichiers cachés, eux, lus.
    SKIP_EXTS = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg',
                 '.woff', '.woff2', '.ttf', '.eot', '.pdf', '.zip', '.tar',
                 '.gz', '.bin', '.exe', '.so', '.pyc', '.db', '.sqlite'}
    MAX_FILE = 512 * 1024   # 512 KB
    MAX_FILES_SCANNED = 5000  # même ordre que /grep
    APERCU = 120            # caractères de l'aperçu
    try:
        liste = await agent.list("", depth=4096, max_entries=50_000, hidden=True,
                                 prune=[".*", "node_modules", "__pycache__"], deadline_s=3.0,
                                 kinds=("file",))
        fichiers = [e["path"] for e in liste.entries
                    if int(e.get("size") or 0) <= MAX_FILE
                    and PurePosixPath(e["path"]).suffix.lower() not in SKIP_EXTS]
        truncated = liste.truncated or len(fichiers) > MAX_FILES_SCANNED
        fichiers = fichiers[:MAX_FILES_SCANNED]
        # Fenêtre de la ligne autour de la première occurrence (``col`` : sa
        # colonne dans la ligne entière, même très longue).
        trouves, bilan = (await agent.grep(
            fichiers, q, ignore_case=True, max_file_bytes=MAX_FILE, max_hits=MAX_HITS,
            context=APERCU, deadline_s=max(0.5, echeance - time.monotonic()))
            if fichiers else ([], {}))
    except AgentError as ex:
        raise agent_http(ex, "Recherche") from None
    truncated = truncated or bool(bilan.get("hits_truncated") or bilan.get("timed_out"))
    results = []
    for h in trouves:
        fenetre, col = h["text"], int(h.get("col") or 1)
        decalage = col - 1 - int(h.get("match_start") or 0)   # début de la fenêtre dans la ligne
        entiere = decalage == 0 and len(fenetre) - int(h.get("match_end") or 0) < APERCU
        # Aperçu court centré sur la première occurrence.
        preview = fenetre.strip()
        if not entiere or len(preview) > APERCU:
            start = max(0, col - 40)
            preview = (('…' if start > 0 else '')
                       + fenetre[start - decalage:start - decalage + APERCU].strip() + '…')
        results.append({"path": h["file"], "name": h["file"].rsplit("/", 1)[-1],
                        "line": h["line"], "col": col, "preview": preview})
    return {"items": results, "errors": liste.errors, "truncated": truncated}


# ─────────────────────────────────────────────────────────────────────────────
#  READ / WRITE
# ─────────────────────────────────────────────────────────────────────────────
async def _lecture_stable(agent, rel: str, essais: int = 3):
    """``(octets, stat)`` d'un fichier ≤ ``_DOWNLOAD_SHA_MAX`` lus d'un seul
    tenant (même inode, taille et mtime avant et après la lecture), ou
    ``None`` : trop gros, illisible, ou réécrit en place à chaque essai
    (servi alors en flux)."""
    for _ in range(essais):
        try:
            r = await agent.read(rel, max_bytes=_DOWNLOAD_SHA_MAX)
            (apres,) = await agent.stat([rel])
        except AgentError as ex:
            # Corps incomplet : fichier raccourci pendant la lecture (l'agent
            # coupe la réponse) — relu, comme avant L4.5, et non « sandbox
            # arrêtée » (relecture L4.5).
            if ex.code in ("transport", "changed"):
                continue
            if ex.code in PANNES_AGENT:
                raise agent_http(ex, "Téléchargement") from None
            return None
        if (apres.get("kind") == "file" and len(r.data) == r.stat.get("size")
                and all(apres.get(k) == r.stat.get(k) for k in ("ino", "size", "mtime_ns"))):
            return r.data, r.stat
    return None


def _en_piece_jointe(resp, nom: str) -> None:
    from urllib.parse import quote as _q
    qn = _q(nom)
    resp.headers["Content-Disposition"] = (
        f"attachment; filename*=utf-8''{qn}" if qn != nom else f'attachment; filename="{nom}"')


def _entetes_telechargement(resp, nom: str, st: dict, exposes: str):
    """PASSE 11 — ``X-Mtime`` / ``X-Size`` : le front détecte ensuite les
    modifications externes (cf. ``/api/sandbox/check-mtimes``)."""
    _en_piece_jointe(resp, nom)
    _no_cache(resp)
    resp.headers["X-Mtime"] = str(_mtime_s(int(st.get("mtime_ns") or 0)))
    resp.headers["X-Size"] = str(int(st.get("size") or 0))
    resp.headers["Access-Control-Expose-Headers"] = exposes
    return resp


# ── Archives : produites par l'agent, relayées en flux ──────────────────────
# Passe sandbox 2026-09-26 : jamais en mémoire (un dossier de 3 Go téléchargé
# « en un clic ») ; L4.5 : ni sur le disque de l'hôte — l'agent parcourt et
# compresse dans le conteneur, la route relaie.
_ZIP_DIR_MAX_BYTES = 1024 * 1024 * 1024        # 1 Gio de fichiers source
_ZIP_DIR_MAX_FILES = 20_000                     # aligné sur le plafond de /tree


async def _ouvrir_archive(agent, chemins: list, *, libelle: str, trop: str, **archive):
    """``(pile, flux)`` d'une archive de l'agent ; ses refus arrivent ici,
    avant toute réponse (bornes dépassées en ``strict`` : 413 ``trop``)."""
    pile = contextlib.AsyncExitStack()
    try:
        flux = await pile.enter_async_context(agent.archive(chemins, **archive))
    except AgentError as ex:
        if ex.code == "too_large":
            raise HTTPException(413, trop) from None
        raise agent_http(ex, libelle) from None
    return pile, flux


def _relayer(pile, flux, nom: str, media_type: str, entetes: Optional[dict] = None):
    """Réponse en flux de l'archive ouverte par :func:`_ouvrir_archive` ;
    le flux de l'agent est fermé à la fin de la réponse ou à l'abandon du
    client. Interrompue en route, la réponse est coupée (le navigateur voit
    un téléchargement en échec, pas une archive tronquée)."""
    from starlette.background import BackgroundTask

    async def corps():
        try:
            async for x in flux:
                if isinstance(x, bytes):
                    yield x
        except AgentError as ex:
            logger.warning("[sandbox] archive %s interrompue : %s", nom, ex)
            raise
        finally:
            await pile.aclose()
    resp = StreamingResponse(corps(), media_type=media_type, headers=entetes,
                             background=BackgroundTask(pile.aclose))
    _en_piece_jointe(resp, nom)
    return resp


@router.get("/api/sandbox/download")
async def api_download_sandbox_file(request: Request, path: str):
    """Fichier servi tel quel ; dossier : archive zip. Lus par l'agent de la
    sandbox (un lien n'est suivi que sous /work)."""
    user_id = require_user_id(request)
    root = _get_work_path(user_id)
    rel = _rel_editeur(root, path)
    agent = agent_for(user_id)
    e = await _stat_un(agent, rel, "Téléchargement")
    if e.get("kind") == "dir":
        nom = PurePosixPath(rel).name or root.name
        pile, flux = await _ouvrir_archive(
            agent, [rel], libelle="Archive", base=rel, prefix=nom, format="zip",
            max_bytes=_ZIP_DIR_MAX_BYTES, max_files=_ZIP_DIR_MAX_FILES,
            trop="Dossier trop volumineux pour une archive "
                 f"(> {_ZIP_DIR_MAX_BYTES // (1024 * 1024)} Mo ou "
                 f"{_ZIP_DIR_MAX_FILES} fichiers) — téléchargez-le par parties.")
        return _relayer(pile, flux, f"{nom}.zip", "application/zip")
    if e.get("kind") != "file":
        if e.get("outside"):
            raise HTTPException(403, "Access denied")
        raise HTTPException(404, "Not found")
    nom = PurePosixPath(rel).name
    mt = mimetypes.guess_type(nom)[0] or "text/plain"
    # Audit éditeur 2026-09-23 (E6) — ``X-Sha256`` et ``X-Size`` décrivent
    # les MÊMES octets que ceux servis (lecture d'un seul tenant). Requête
    # ``Range`` (visionneuse hex) ou fichier > 64 Mio : servi en flux, sans
    # ``X-Sha256``.
    if "range" not in request.headers and int(e.get("size") or 0) <= _DOWNLOAD_SHA_MAX:
        lu = await _lecture_stable(agent, rel)
        if lu is not None:
            from fastapi.responses import Response
            data, st = lu
            resp = Response(data, media_type=mt)
            resp.headers["X-Sha256"] = sha256_bytes(data)
            return _entetes_telechargement(resp, nom, st, "X-Mtime, X-Sha256, X-Size")
        e = await _stat_un(agent, rel, "Téléchargement")    # réécrit entre-temps : l'état du moment
        if e.get("kind") != "file":
            raise HTTPException(404, "Not found")
    resp = await _reponse_agent(request, agent, rel, e, mt)
    return _entetes_telechargement(resp, nom, getattr(resp, "elpis_stat", e), "X-Mtime, X-Size")


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
      * silently skip les paths qui sortent de la sandbox ou qui n'existent
        plus -- on ne casse pas tout le téléchargement parce qu'un fichier
        a été supprimé entre-temps.
      * dossiers ignorés (le endpoint single ``download`` les zippe
        déjà ; ici on est strictement multi-FILE).
      * noms dans l'archive : chemins relatifs à la sandbox (préserve la
        structure d'arborescence).
      * au plus 500 fichiers / 200 Mo : au-delà, l'archive s'arrête là
        (``X-Files-Zipped`` : nombre de fichiers retenus).
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

    rels = []
    for raw in paths:
        if isinstance(raw, str) and raw:
            with contextlib.suppress(HTTPException):         # hors sandbox : sauté
                rels.append(_rel_editeur(root, raw))
    if rels:
        pile, flux = await _ouvrir_archive(
            agent_for(user_id), rels, libelle="Archive", trop="", format="zip", walk=False,
            strict=False, max_bytes=200 * 1024 * 1024, max_files=500)
        # ``X-Files-Zipped`` : fichiers PRÉVUS par le parcours (l'en-tête part
        # avant les octets) ; un fichier devenu illisible entre-temps est
        # omis de l'archive, le zip reste valide.
        if flux.debut.get("files"):
            return _relayer(pile, flux, "files.zip", "application/zip",
                            {"X-Files-Zipped": str(flux.debut["files"])})
        await pile.aclose()
    raise HTTPException(404, "No file could be added to the archive")


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
    agent = agent_for(user_id)
    # Chemins résolus sans lire le disque, états pris en une requête.
    rels: dict = {}
    for rel_path in paths:
        try:
            rels[rel_path] = _rel_editeur(root, rel_path)
        except HTTPException:
            rels[rel_path] = None
    valides = sorted({r for r in rels.values() if r})
    try:
        etats = dict(zip(valides, await _stats_lots(agent, valides)))
    except AgentError as ex:
        raise agent_http(ex, "Upload") from None
    for file, rel_path in zip(files, paths):
        rel = rels.get(rel_path)
        if not rel:
            skipped.append({"path": rel_path, "reason": "path_escape"})
            continue
        e = etats.get(rel) or {"kind": "missing"}
        # Un DOSSIER porte déjà ce nom : jamais remplacé.
        if e.get("kind") == "dir":
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
            # Un DOSSIER du même nom n'est pas un écrasement.
            _existing_up = int(e.get("size") or 0) if e.get("kind") == "file" else 0
            if _quota_mb_up > 0 and \
                    _running_used + len(file_bytes) - _existing_up > _quota_mb_up * 1024 * 1024:
                skipped.append({"path": rel_path, "reason": "quota_exceeded"})
                continue
            try:
                # Audit éditeur 2026-09-23 : verrou du fichier (partagé avec
                # l'assistant) + historique de session (source « upload »).
                async with _file_lock(root / rel):
                    _before = await _hist_avant(agent, rel, e)
                    r = await agent.write(rel, file_bytes, parents=True)
            except (AgentError, HTTPException) as ex:
                # Conteneur arrêté, fichier en cours d'écriture par
                # l'assistant (409 du verrou)… : ce fichier est ignoré, les
                # suivants réessaient (l'agent redémarre au besoin).
                refus = agent_http(ex, "Upload") if isinstance(ex, AgentError) else ex
                detail = refus.detail
                if isinstance(detail, dict):
                    detail = detail.get("message") or detail.get("code")
                skipped.append({"path": rel_path, "reason": f"exec_failed: {detail}"})
                continue
            if r.get("mtime_ns"):
                mtimes[rel_path] = _mtime_s(int(r["mtime_ns"]))
            hashes[rel_path] = sha256_bytes(file_bytes)
            saved += 1
            _usage_delta += len(file_bytes) - _existing_up
            if _quota_mb_up > 0:
                _running_used += len(file_bytes) - _existing_up
            await _hist_write(user_id, rel, _before, file_bytes, "upload")
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


async def _ajouter_morceau(user_id: int, tmp_rel: str, data: bytes, *, truncate: bool) -> int:
    """Un morceau d'import ajouté au fichier provisoire. Disque plein (507) :
    le provisoire est supprimé — l'import ne peut plus aboutir, et il
    occuperait l'espace qui manque."""
    from shared_infra.sandbox.exec_bridge import sandbox_append_chunk, sandbox_delete
    try:
        return await sandbox_append_chunk(user_id, tmp_rel, data, truncate=truncate)
    except HTTPException as he:
        if he.status_code == 507:
            with contextlib.suppress(HTTPException):
                await sandbox_delete(user_id, tmp_rel)
            invalidate_sandbox_usage(user_id)
        raise

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

    rel = _rel_editeur(root, rel_path)
    # Le fichier provisoire est désigné par le chemin du client + suffixe :
    # exec_bridge retire le préfixe /work UNE fois, comme pour le fichier final.
    tmp_rel = _upload_tmp_rel(rel_path, qp.get("upload_id") or "")
    tmp = _rel_editeur(root, tmp_rel)

    data = await request.body()
    if len(data) > _UPLOAD_CHUNK_HARD_CAP:
        raise HTTPException(413, "Chunk trop volumineux")

    from shared_infra.sandbox.exec_bridge import sandbox_delete, sandbox_rename
    agent = agent_for(user_id)

    if index == 0:
        try:
            e, e_tmp = await _stats_lots(agent, [rel, tmp])
        except AgentError as ex:
            raise agent_http(ex, "Upload (chunk)") from None
        # Un DOSSIER porte ce nom : jamais remplacé (et le ``.part`` ne
        # serait jamais promu).
        if e.get("kind") == "dir":
            raise HTTPException(409, "Un dossier porte déjà ce nom")
        # Quota vérifié UNE fois (au 1er chunk), SOUS LE VERROU de quota comme
        # ``/upload`` et ``/save`` : sans lui, deux onglets passaient le
        # contrôle ensemble puis écrivaient tous les deux.
        async with _quota_lock_for(user_id):
            cap = await asyncio.to_thread(_import_capacity, user_id, root, fresh=False)
            # Octets que ce fichier AJOUTE : l'écrasé et un ``.part`` laissé par
            # une tentative précédente (tronqué ci-dessous) sont déjà comptés
            # dans l'usage.
            _net = total_size - (int(e.get("size") or 0) if e.get("kind") == "file" else 0)
            _stale_part = int(e_tmp.get("size") or 0) if e_tmp.get("kind") == "file" else 0
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
            _received = await _ajouter_morceau(user_id, tmp_rel, data, truncate=True)
    else:
        # Import ANNULÉ entre deux chunks (``DELETE`` ci-dessous) : l'agent
        # n'ajoute qu'à un fichier provisoire existant.
        try:
            _received = await _ajouter_morceau(user_id, tmp_rel, data, truncate=False)
        except HTTPException as he:
            if he.status_code == 404:
                raise HTTPException(409, "Import interrompu") from None
            raise

    # Le cumul reçu ne dépasse JAMAIS la taille déclarée : sinon un client
    # annonçait 1 octet au contrôle de quota puis en envoyait 1 Go.
    _last = index >= total - 1
    if _received > total_size or (_last and _received != total_size):
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
        async with _file_lock(root / rel):
            _before = await _hist_avant(agent, rel, await _etat_agent(agent, rel, sha_max=0))
            try:
                await sandbox_rename(user_id, tmp_rel, rel_path, overwrite=True)
            except HTTPException:
                try:
                    await sandbox_delete(user_id, tmp_rel)
                except HTTPException:
                    pass
                invalidate_sandbox_usage(user_id)
                raise
            _st = await _etat_agent(agent, rel, sha_max=_DOWNLOAD_SHA_MAX)
        # Historique (source « upload ») : contenu relu (fichier ≤ 5 Mo gardé).
        await _hist_write(user_id, rel, _before, await _hist_avant(agent, rel, _st), "upload")
        # Taille finale réelle (on ne connaît pas l'ancienne : le fichier a été
        # écrasé) → invalidation plutôt que bump.
        invalidate_sandbox_usage(user_id)
        return {"ok": True, "done": True, "path": rel_path, "mtime": _st.get("mtime"),
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
    tmp = _rel_editeur(root, tmp_rel)
    if (await _stat_un(agent_for(user_id), tmp, "Annulation"))["kind"] == "missing":
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

    detailed = 0 < len(files) <= _PRECHECK_MAX_ENTRIES
    demandes = []                                   # (taille annoncée, rel)
    escaped = 0
    if detailed:
        for f in files:
            if not isinstance(f, dict) or not isinstance(f.get("path"), str):
                continue
            try:
                size = max(0, int(f.get("size") or 0))
            except (TypeError, ValueError):
                size = 0
            try:
                demandes.append((size, _rel_editeur(root, f["path"])))
            except HTTPException:
                escaped += 1                        # ``/upload`` les ignorera aussi
    try:
        etats = await _stats_lots(agent_for(user_id), [r for _s, r in demandes])
    except AgentError as ex:
        raise agent_http(ex, "Pré-contrôle") from None

    def _mesure() -> dict:
        total = needed = overwrite = 0
        if detailed:
            for (size, _rel), e in zip(demandes, etats):
                existing = int(e.get("size") or 0) if e.get("kind") == "file" else 0
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
        # Dossiers ignorés (et cachés, sauf demande) non parcourus ; seuls
        # les fichiers au nom voulu sont rendus (et comptés).
        liste = await agent.list(
            "", depth=4096, max_entries=_GREP_MAX_FILES_SCANNED + 1, hidden=include_hidden,
            prune=sorted(_GREP_IGNORED_DIRS), deadline_s=_GREP_TIMEOUT_SEC,
            kinds=("file",), name_glob=glob_pattern)
        fichiers = [e["path"] for e in liste.entries]
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


def _remplacements_lot(lot: list, lus: dict, pat, repl, place: int, echeance: float) -> list:
    """``[(chemin, _remplacement(…))]`` des fichiers lus de ``lot``, dans
    l'ordre ; arrêt à ``place`` fichiers modifiables ou à ``echeance``
    (``time.monotonic``). Tourne dans un fil : une expression coûteuse
    n'occupe pas la boucle d'événements."""
    out: list = []
    for rel in lot:
        if place <= 0 or time.monotonic() > echeance:
            break
        res = _remplacement({"kind": "file"}, lus[rel], pat, repl)
        out.append((rel, res))
        if isinstance(res, tuple):
            place -= 1
    return out


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
                "", depth=4096, max_entries=_GREP_MAX_FILES_SCANNED + 1, hidden=include_hidden,
                prune=sorted(_GREP_IGNORED_DIRS), deadline_s=_REPLACE_SCAN_TIMEOUT_SEC,
                kinds=("file", "link", "other"), name_glob=glob_pattern)
            entrees = liste.entries
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
                lot = lot[:next((i for i, rel in enumerate(lot) if rel not in lus), len(lot))]
                if not lot:
                    truncated = True
                    break
                n_lus += len(lot)                       # le reste : au lot suivant
                # Expressions et remplacements hors de la boucle d'événements.
                resultats = await asyncio.to_thread(
                    _remplacements_lot, lot, lus, pat, repl, _REPLACE_MAX_FILES - len(files),
                    started + _REPLACE_SCAN_TIMEOUT_SEC)
                if len(resultats) < len(lot):
                    truncated = True
                for rel, res in resultats:
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
                except AgentError as ex:
                    if ex.code not in PANNES_AGENT:
                        continue                        # disparu, illisible, modifié…
                    failed = {"path": rel, "error": str(agent_http(ex, "Remplacement").detail)}
                    break
                if e.get("kind") in ("missing", "error"):
                    continue
                res = await asyncio.to_thread(_remplacement, e, raw, pat, repl)
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


def _texte_docx(data: bytes) -> str:
    """Texte brut d'un .docx (paragraphes, puis tables) ; 501 sans
    python-docx, 422 pour un fichier illisible."""
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
        # Préserve les paragraphes vides (entre sections) pour la lisibilité
        lines.append((para.text or "").rstrip())
    # Tables : ajoute après les paragraphes, séparées par une ligne vide
    for tbl in doc.tables:
        lines.append("")  # séparateur
        for row in tbl.rows:
            cells = [c.text.replace("\n", " ").strip() for c in row.cells]
            lines.append(" | ".join(cells))
    return "\n".join(lines).strip() + "\n"


@router.get("/api/sandbox/read-docx")
async def api_sandbox_read_docx(request: Request, path: str):
    """Extrait le texte brut d'un fichier .docx du sandbox utilisateur (lu par
    l'agent, un lien suivi sous /work seulement)."""
    user_id = require_user_id(request)
    if not path or len(path) > 1024:
        raise HTTPException(400, "Path invalide")
    rel = _rel_editeur(_get_work_path(user_id), path)
    if not rel.lower().endswith(".docx"):
        raise HTTPException(400, "Pas un fichier .docx")
    agent = agent_for(user_id)
    e = await _stat_un(agent, rel, "Lecture")
    if e["kind"] != "file":
        raise HTTPException(404, "Fichier introuvable")
    size = int(e.get("size") or 0)
    trop = HTTPException(413, f"Fichier trop gros (max {_DOCX_MAX_BYTES // (1024*1024)} MB)")
    if size > _DOCX_MAX_BYTES:
        raise trop
    try:
        data = (await agent.read(rel, max_bytes=_DOCX_MAX_BYTES)).data
    except AgentError as ex:
        if ex.code == "too_large":
            raise trop from None
        if ex.code in ("not_found", "is_dir", "not_file"):
            raise HTTPException(404, "Fichier introuvable") from None
        raise agent_http(ex, "Lecture") from None
    return {
        "path":      path,
        "text":      await asyncio.to_thread(_texte_docx, data),
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
    utiles seulement (fichiers ≤ ``_CHECK_SHA_MAX``).

    Sondage périodique de l'éditeur : appels passifs — un conteneur arrêté
    n'est pas redémarré (503, que le front ignore : aucun onglet fermé) et
    le sondage ne retient pas la sandbox contre l'arrêt pour inactivité."""
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
        etats = await agent.stat([d[1] for d in demandes], passive=True)
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
                                          hash_max=_CHECK_SHA_MAX, passive=True)
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
    current = {"exists": False, "sha256": None, "size": None, "mtime": None}
    try:
        rel: Optional[str] = _rel_editeur(_get_work_path(user_id), path)
    except HTTPException:
        rel = None                                   # hors sandbox : pas d'état courant
    if rel is not None:
        st = await _etat_agent(agent_for(user_id), rel, sha_max=_DOWNLOAD_SHA_MAX)
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
# Par l'agent de la sandbox (L4.5) : l'archive est produite ou extraite dans le
# conteneur, jamais lue ni écrite par l'hôte ; le conteneur d'un compte arrêté
# est démarré pour l'occasion. (``_extract_tar_bounded`` ne sert plus qu'au
# miroir des skills, dossier de l'hôte hors du conteneur.)
_IMPORT_MAX_BYTES = 2 * 1024 * 1024 * 1024
_WORK_MAX_BYTES = 8 * 1024 * 1024 * 1024        # /work exporté : fichiers source
_WORK_MAX_ENTREES = 500_000
_WORK_PARCOURS_S = 240.0                        # parcours de /work avant le premier octet


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


_TROP_WORK = ("/work trop volumineux pour une archive "
              f"(> {_WORK_MAX_BYTES >> 30} Gio ou {_WORK_MAX_ENTREES} fichiers)")


async def exporter_work(user_id: int) -> bytes:
    """Archive tar.gz des fichiers ordinaires de ``/work`` du compte (sans
    liens ni fichiers spéciaux), produite par l'agent."""
    data = bytearray()
    async with agent_for(user_id).archive([""], format="tgz", max_bytes=_WORK_MAX_BYTES,
                                          max_files=_WORK_MAX_ENTREES,
                                          deadline_s=_WORK_PARCOURS_S) as flux:
        async for x in flux:
            if isinstance(x, bytes):
                data += x
    return bytes(data)


class ImportRefuse(Exception):
    """Import annulé avant de toucher à /work (instantané préalable impossible)."""


async def importer_work_bilan(user_id: int, data, *,
                              max_total: Optional[int] = None) -> Dict[str, Any]:
    """Remplace le contenu de ``/work`` du compte par une archive tar(.gz),
    extraite par l'agent : membres contenus (ni ``..``, ni absolu, ni lien),
    bornes vérifiées avant de toucher à ``/work``. ``data`` : octets ou
    fichier binaire (envoyé par blocs). ``max_total`` : plafond de la taille
    DÉCOMPRESSÉE (défaut : quota du compte).

    (Décision du 2026-09-30) L'ancien contenu n'est plus gardé dans /work
    (``.work-before-import-*`` comptait dans le quota et partait dans les
    sauvegardes) : un INSTANTANÉ est pris d'abord, hors de /work, et l'import
    est annulé (``ImportRefuse``) s'il ne peut l'être. Rend le bilan de
    l'agent (``files``, ``conflicts``, ``conflict_paths``) et ``snapshot``
    (identifiant et nom de l'instantané)."""
    if max_total is None:
        max_total = _user_quota_bytes(user_id)
    from shared_infra.sandbox.routes_snapshots import creer_snapshot
    try:
        meta = await creer_snapshot(
            user_id, time.strftime("Avant import du %d/%m/%Y %H:%M"))
    except RuntimeError as e:
        raise ImportRefuse(f"instantané préalable impossible : {e}") from None
    res = await agent_for(user_id).extract(
        "", data, max_bytes=max_total, max_file=max_total, max_members=_WORK_MAX_ENTREES)
    invalidate_sandbox_usage(user_id)
    return {**res, "snapshot": {"id": meta.get("id"), "name": meta.get("name")}}


async def importer_work(user_id: int, data, *, max_total: Optional[int] = None) -> int:
    """``importer_work_bilan`` réduit au nombre de fichiers extraits."""
    res = await importer_work_bilan(user_id, data, max_total=max_total)
    return int(res.get("files") or 0)


@router.get("/api/sandbox/export")
async def api_sandbox_export(request: Request):
    """Archive tar.gz de ``/work`` du compte (fichiers ordinaires, sans
    liens), produite par l'agent et relayée en flux."""
    user_id = require_user_id(request)
    pile, flux = await _ouvrir_archive(
        agent_for(user_id), [""], libelle="Export", trop=_TROP_WORK, format="tgz",
        max_bytes=_WORK_MAX_BYTES, max_files=_WORK_MAX_ENTREES, deadline_s=_WORK_PARCOURS_S)
    return _relayer(pile, flux, "work.tar.gz", "application/gzip", {"Cache-Control": "no-store"})


@router.post("/api/sandbox/import")
async def api_sandbox_import(request: Request, archive: UploadFile = File(...)):
    """Remplace ``/work`` du compte par une archive tar.gz (migration entre
    hôtes). Un instantané de l'ancien contenu est pris d'abord (import annulé
    s'il ne peut l'être)."""
    user_id = require_user_id(request)
    # Passe sandbox 2026-09-26 — plus de ``archive.read()`` : jusqu'à 2 Go
    # recopiés en RAM avant même le contrôle de taille. Starlette a déjà
    # spoolé l'upload ; on en mesure la taille puis on l'envoie EN FLUX.
    try:
        archive.file.seek(0, os.SEEK_END)
        size = archive.file.tell()
        archive.file.seek(0)
    except (OSError, ValueError):
        size = 0
    if size > _IMPORT_MAX_BYTES:
        raise HTTPException(413, "archive trop volumineuse")
    try:
        res = await importer_work_bilan(user_id, archive.file)
    except ImportRefuse as e:
        raise HTTPException(409, f"Import annulé, /work inchangé : {e}") from None
    except AgentError as e:
        if e.code == "too_large":
            raise HTTPException(413, "archive trop volumineuse une fois décompressée "
                                     "(quota du compte ou nombre de fichiers dépassé)") from None
        if e.code == "bad_archive":
            raise HTTPException(400, "archive invalide") from None
        raise agent_http(e, "Import") from None
    return {"ok": True, "files": int(res.get("files") or 0),
            "conflicts": int(res.get("conflicts") or 0),
            "conflict_paths": [str(x)[:512] for x in (res.get("conflict_paths") or [])[:50]],
            "snapshot": res.get("snapshot")}
