# SPDX-License-Identifier: MIT
"""
Site CRUD — list, stats, delete, mark stale, wipe.

Auto-extracted from the former monolithic ``backend/ax_memory/_legacy.py``.
Function bodies are byte-for-byte identical to the originals.
"""
from __future__ import annotations

import logging
import time
from typing import Optional

log = logging.getLogger(__name__)

from shared_infra.memory.ax._connection import _conn, _DB_LOCK


def list_sites() -> list[str]:
    try:
        with _conn() as c:
            rows = c.execute("""
                SELECT site, COUNT(*) AS n FROM ax_nodes
                 WHERE stale=0 AND node_type='element'
                 GROUP BY site ORDER BY n DESC
            """).fetchall()
        return [r["site"] for r in rows]
    except Exception:
        return []
def list_sites_with_stats(*, owner: str | None = None) -> list[dict]:
    """
    Retourne la liste des sites connus avec leurs statistiques.
    Format : [{'site', 'elements', 'regions', 'paths', 'transitions',
               'has_credentials', 'cred_username', 'last_activity'}, ...]
    Utilise pour l'UI admin/user.
    """
    try:
        with _conn() as c:
            rows = c.execute("""
                SELECT n.site,
                    SUM(CASE WHEN n.node_type='element' AND n.stale=0
                             THEN 1 ELSE 0 END) AS elements,
                    SUM(CASE WHEN n.node_type='region'
                             THEN 1 ELSE 0 END) AS regions,
                    COUNT(DISTINCT n.path) AS paths,
                    MAX(n.last_ok) AS last_activity
                  FROM ax_nodes n
                 GROUP BY n.site
                 ORDER BY last_activity DESC
            """).fetchall()

            out = []
            for r in rows:
                site = r["site"]
                # Count transitions
                trans = c.execute("""
                    SELECT COUNT(*) AS n FROM ax_transitions WHERE site = ?
                """, (site,)).fetchone()
                # Credentials — AUDIT 2026-08-23 : bornes au PROPRIETAIRE.
                # Sans ``owner``, cette vue annoncait « has_credentials » et
                # le ``cred_username`` d'un autre compte a qui la demandait.
                if owner:
                    cred = c.execute("""
                        SELECT username, use_count FROM ax_credentials
                         WHERE site = ? AND owner = ?
                    """, (site, owner)).fetchone()
                else:
                    cred = None
                out.append({
                    "site":            site,
                    "elements":        r["elements"] or 0,
                    "regions":         r["regions"] or 0,
                    "paths":           r["paths"] or 0,
                    "transitions":     trans["n"] if trans else 0,
                    "has_credentials": cred is not None,
                    "cred_username":   cred["username"] if cred else None,
                    "cred_use_count":  cred["use_count"] if cred else 0,
                    "last_activity":   r["last_activity"],
                })
        return out
    except Exception as e:
        log.warning("[ax] list_sites_with_stats failed: %s", e)
        return []
def get_site_stats(site: str, *, owner: str | None = None) -> Optional[dict]:
    """Stats detaillees d'un seul site. Identifiants bornes au PROPRIETAIRE
    ``owner`` (audit 2026-09-22 : la route, ouverte a tout compte, renvoyait
    le ``cred_username`` d'un autre) ; sans ``owner``, aucun."""
    if not site:
        return None
    try:
        with _conn() as c:
            agg = c.execute("""
                SELECT
                    SUM(CASE WHEN node_type='element' AND stale=0
                             THEN 1 ELSE 0 END) AS elements_ok,
                    SUM(CASE WHEN node_type='element' AND stale=1
                             THEN 1 ELSE 0 END) AS elements_stale,
                    SUM(CASE WHEN node_type='region'
                             THEN 1 ELSE 0 END) AS regions,
                    COUNT(DISTINCT path) AS paths,
                    MAX(last_ok) AS last_activity,
                    MIN(last_ok) AS first_activity
                  FROM ax_nodes WHERE site = ?
            """, (site,)).fetchone()
            if not agg or agg["elements_ok"] is None:
                return None
            trans = c.execute("""
                SELECT COUNT(*) AS n, SUM(verified_count) AS total_verifs
                  FROM ax_transitions WHERE site = ?
            """, (site,)).fetchone()
            sel = c.execute("""
                SELECT COUNT(*) AS n FROM ax_selectors s
                  JOIN ax_nodes n ON s.node_id = n.id
                 WHERE n.site = ?
            """, (site,)).fetchone()
            cred = c.execute("""
                SELECT username, use_count, last_ok FROM ax_credentials
                 WHERE site = ? AND owner = ?
            """, (site, owner)).fetchone() if owner else None
        return {
            "site":            site,
            "elements_ok":     agg["elements_ok"] or 0,
            "elements_stale":  agg["elements_stale"] or 0,
            "regions":         agg["regions"] or 0,
            "paths":           agg["paths"] or 0,
            "transitions":     trans["n"] if trans else 0,
            "selectors":       sel["n"] if sel else 0,
            "first_activity":  agg["first_activity"],
            "last_activity":   agg["last_activity"],
            "has_credentials": cred is not None,
            "cred_username":   cred["username"] if cred else None,
            "cred_use_count":  cred["use_count"] if cred else 0,
            "cred_last_ok":    cred["last_ok"] if cred else None,
        }
    except Exception as e:
        log.warning("[ax] get_site_stats failed: %s", e)
        return None
def delete_site(site: str, include_credentials: bool = False) -> dict:
    """
    Supprime toutes les donnees AX d'un site (nodes, selectors, transitions).
    Si include_credentials=True, supprime aussi les credentials.
    Retourne {deleted: {nodes, selectors, transitions, credentials}}.
    """
    if not site:
        return {"deleted": {"nodes": 0, "selectors": 0, "transitions": 0,
                            "credentials": 0}}
    try:
        with _DB_LOCK, _conn() as c:
            # Selectors d'abord (FK)
            sel_count = c.execute("""
                SELECT COUNT(*) AS n FROM ax_selectors s
                  JOIN ax_nodes n ON s.node_id = n.id
                 WHERE n.site = ?
            """, (site,)).fetchone()["n"]
            c.execute("""
                DELETE FROM ax_selectors WHERE node_id IN (
                    SELECT id FROM ax_nodes WHERE site = ?
                )
            """, (site,))
            # Transitions
            tr = c.execute("DELETE FROM ax_transitions WHERE site = ?",
                           (site,)).rowcount
            # Nodes
            nd = c.execute("DELETE FROM ax_nodes WHERE site = ?",
                           (site,)).rowcount
            # Credentials (optionnel)
            cr = 0
            if include_credentials:
                cr = c.execute("DELETE FROM ax_credentials WHERE site = ?",
                               (site,)).rowcount
        log.info("[ax] delete_site %s : nodes=%d selectors=%d trans=%d creds=%d",
                 site, nd, sel_count, tr, cr)
        return {"deleted": {
            "nodes": nd, "selectors": sel_count,
            "transitions": tr, "credentials": cr,
        }}
    except Exception as e:
        log.warning("[ax] delete_site failed: %s", e)
        return {"error": str(e)}
def delete_sites_bulk(sites: list[str], include_credentials: bool = False) -> dict:
    """Supprime plusieurs sites en une seule transaction. Utilise par l'UI
    admin pour les actions multi-selection."""
    summary = {
        "nodes": 0, "selectors": 0, "transitions": 0, "credentials": 0,
        "sites_processed": 0,
    }
    for s in sites or []:
        res = delete_site(s, include_credentials=include_credentials)
        if "deleted" in res:
            for k, v in res["deleted"].items():
                summary[k] += v
            summary["sites_processed"] += 1
    return {"deleted": summary}
def mark_site_stale(site: str) -> dict:
    """
    Marque tous les selecteurs d'un site comme stale (force le refresh
    lors de la prochaine utilisation). Ne supprime rien. Utile quand une
    app a ete redeployee et que le DOM a peut-etre change.

    Impact :
      - Les noeuds element passent stale=1, stale_at=now
      - Au prochain pw_act reussi sur un element, il repassera stale=0
      - Au prochain pw_act echoue, le noeud reste stale
    """
    if not site:
        return {"marked": 0}
    try:
        now = time.time()
        with _DB_LOCK, _conn() as c:
            cur = c.execute("""
                UPDATE ax_nodes SET stale = 1, stale_at = ?
                 WHERE site = ? AND node_type = 'element' AND stale = 0
            """, (now, site))
        log.info("[ax] mark_site_stale %s : %d elements marked", site, cur.rowcount)
        return {"marked": cur.rowcount}
    except Exception as e:
        log.warning("[ax] mark_site_stale failed: %s", e)
        return {"error": str(e)}
def wipe_all() -> dict:
    """Wipe total : vide toutes les tables AX. Action destructrice, admin only."""
    try:
        with _DB_LOCK, _conn() as c:
            n_sel = c.execute("DELETE FROM ax_selectors").rowcount
            n_tr = c.execute("DELETE FROM ax_transitions").rowcount
            n_nd = c.execute("DELETE FROM ax_nodes").rowcount
            n_cr = c.execute("DELETE FROM ax_credentials").rowcount
        log.warning("[ax] WIPE ALL : nodes=%d selectors=%d trans=%d creds=%d",
                    n_nd, n_sel, n_tr, n_cr)
        return {"deleted": {
            "nodes": n_nd, "selectors": n_sel,
            "transitions": n_tr, "credentials": n_cr,
        }}
    except Exception as e:
        log.warning("[ax] wipe_all failed: %s", e)
        return {"error": str(e)}
