# SPDX-License-Identifier: MIT
"""
Routes FastAPI pour l'UI AX Memory :
  - Lecture (ouvert a tous les users authentifies) : liste sites, arbre, stats
  - Ecriture (admin ou moderator only) : delete site, mark stale, wipe

A inclure dans app.py via : app.include_router(ax.router)
"""
import logging
from typing import List

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from shared_infra.security.deps import require_user_id
from shared_infra.accounts.users import get_user_by_id
from shared_infra.memory import ax

logger = logging.getLogger("uvicorn.error")
router = APIRouter(tags=["ax_memory"])


# ── Helpers d'autorisation (mirror de routes.py) ──────────────────────
def _require_admin_or_mod(request: Request) -> int:
    """Require admin (is_admin=1) ou moderator (is_admin=2).
    Raise 403 sinon. Retourne user_id.

    Note : ``get_user_by_id`` retourne un ``sqlite3.Row`` (pas un dict), qui
    supporte l'accès par index/clé mais pas la méthode ``.get()``. On utilise
    donc l'indexation avec fallback.
    """
    user_id = require_user_id(request)
    me = get_user_by_id(user_id)
    if not me:
        raise HTTPException(403, "Admin or moderator required")
    try:
        admin_level = me["is_admin"]
    except (KeyError, IndexError):
        admin_level = 0
    if admin_level not in (1, 2):
        raise HTTPException(403, "Admin or moderator required")
    return user_id


def _require_any_user(request: Request) -> int:
    """Require any authenticated user. Returns user_id."""
    return require_user_id(request)


# ── LECTURE (tout user authentifie) ───────────────────────────────────

@router.get("/api/ax/sites")
def list_sites_api(request: Request):
    """Liste des sites connus avec stats. Accessible a tous les users."""
    _require_any_user(request)
    # AUDIT 2026-08-23 — route ouverte à tout compte authentifié : la vue est
    # bornée au propriétaire, sinon elle divulgue le ``cred_username`` d'un
    # autre. Identité inconnue ⇒ aucun bloc d'identifiants (fail-closed).
    sites = ax.list_sites_with_stats(
        owner=getattr(request.state, "username", None) or "")
    return {"sites": sites, "count": len(sites)}


@router.get("/api/ax/sites/{site}/stats")
def site_stats_api(site: str, request: Request):
    """Stats detaillees d'un site. Accessible a tous les users."""
    _require_any_user(request)
    stats = ax.get_site_stats(site, owner=getattr(request.state, "username", None) or "")
    if stats is None:
        raise HTTPException(404, f"Site '{site}' not found")
    return stats


@router.get("/api/ax/sites/{site}/tree")
def site_tree_api(site: str, request: Request):
    """
    Arbre DOM profond d'un site au format JSON (pour accordion).
    Accessible a tous les users.
    """
    _require_any_user(request)
    tree = ax.get_tree_json(site)
    if not tree.get("paths"):
        # Site existe ? Si oui on renvoie un arbre vide, sinon 404
        stats = ax.get_site_stats(site)
        if not stats:
            raise HTTPException(404, f"Site '{site}' not found")
    return tree


@router.get("/api/ax/sites/{site}/tree-ascii")
def site_tree_ascii_api(site: str, request: Request):
    """
    Rendu ASCII de l'arbre DOM (meme format qu'injecte au LLM).
    Utile pour debug / verification de ce que le LLM voit.
    """
    _require_any_user(request)
    ascii_tree = ax.render_full_dom_for_prompt(site, max_chars=50000)
    if not ascii_tree:
        stats = ax.get_site_stats(site)
        if not stats:
            raise HTTPException(404, f"Site '{site}' not found")
        return {"site": site, "ascii": "(no DOM recorded yet)"}
    return {"site": site, "ascii": ascii_tree}


# ── ECRITURE (admin/moderator only) ────────────────────────────────────

class BulkSitesPayload(BaseModel):
    sites: List[str]
    include_credentials: bool = False


@router.delete("/api/ax/sites/{site}")
def delete_site_api(site: str, request: Request,
                    include_credentials: bool = False):
    """Supprime un site (ses nodes, selectors, transitions).
    include_credentials=true pour aussi purger les creds.
    Admin/moderator only."""
    _require_admin_or_mod(request)
    res = ax.delete_site(site, include_credentials=include_credentials)
    if "error" in res:
        raise HTTPException(500, res["error"])
    return res


@router.delete("/api/ax/sites/{site}/credentials")
def delete_site_creds_api(site: str, request: Request):
    """Supprime UNIQUEMENT les credentials d'un site.
    Admin/moderator only."""
    _require_admin_or_mod(request)
    ok = ax.delete_credentials(site)
    return {"deleted": 1 if ok else 0}


@router.post("/api/ax/sites/{site}/mark-stale")
def mark_site_stale_api(site: str, request: Request):
    """Marque tous les elements d'un site comme stale.
    Force le refresh a la prochaine utilisation. Admin/moderator only."""
    _require_admin_or_mod(request)
    res = ax.mark_site_stale(site)
    if "error" in res:
        raise HTTPException(500, res["error"])
    return res


@router.post("/api/ax/bulk-delete")
def bulk_delete_api(request: Request, payload: BulkSitesPayload):
    """Supprime plusieurs sites en une fois. Admin/moderator only."""
    _require_admin_or_mod(request)
    if not payload.sites:
        raise HTTPException(400, "No sites provided")
    res = ax.delete_sites_bulk(payload.sites,
                               include_credentials=payload.include_credentials)
    return res


@router.post("/api/ax/bulk-mark-stale")
def bulk_mark_stale_api(request: Request, payload: BulkSitesPayload):
    """Mark stale pour plusieurs sites. Admin/moderator only."""
    _require_admin_or_mod(request)
    if not payload.sites:
        raise HTTPException(400, "No sites provided")
    total = 0
    for s in payload.sites:
        r = ax.mark_site_stale(s)
        total += r.get("marked", 0)
    return {"marked": total, "sites_processed": len(payload.sites)}


@router.delete("/api/ax/all")
def wipe_all_api(request: Request, confirm: str = ""):
    """Wipe total de toute la memoire AX. Admin only (pas moderator).
    Requiert confirm='WIPE' pour eviter les accidents."""
    user_id = require_user_id(request)
    me = get_user_by_id(user_id)
    if not me:
        raise HTTPException(403, "Full admin required for wipe")
    try:
        admin_level = me["is_admin"]
    except (KeyError, IndexError):
        admin_level = 0
    if admin_level != 1:
        raise HTTPException(403, "Full admin required for wipe")
    if confirm != "WIPE":
        raise HTTPException(400, "confirmation required : pass confirm=WIPE")
    res = ax.wipe_all()
    if "error" in res:
        raise HTTPException(500, res["error"])
    logger.warning("[ax] WIPE ALL requested by user_id=%s", user_id)
    return res
