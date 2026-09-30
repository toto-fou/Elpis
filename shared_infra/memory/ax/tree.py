# SPDX-License-Identifier: MIT
"""
Tree dumps for admin / debug — load_tree, load_dom_tree, get_tree_json.

Auto-extracted from the former monolithic ``backend/ax_memory/_legacy.py``.
Function bodies are byte-for-byte identical to the originals.
"""
from __future__ import annotations

import logging
from typing import Optional

log = logging.getLogger(__name__)

from shared_infra.db._dialect import ci_like, nulls_first
from shared_infra.memory.ax._connection import _conn
from shared_infra.memory.ax.selectors import _top_selectors


def load_tree(site: str, include_stale: bool = False) -> dict:
    """
    Retourne {path: {region_tag: [element_nodes]}} avec selecteurs.
    Version plate (v3 compat) : chaque element est groupe sous sa region
    directe. Utilise quand on n'a pas de hierarchie DOM profonde.
    """
    if not site:
        return {}
    tree: dict[str, dict[str, list[dict]]] = {}
    try:
        with _conn() as c:
            where_stale = "" if include_stale else " AND n.stale = 0"
            rows = c.execute(f"""
                SELECT n.id, n.path, n.role, n.name, n.node_key,
                       n.verified_count, n.last_ok, n.stale,
                       p.region_tag AS parent_region
                  FROM ax_nodes n
                  LEFT JOIN ax_nodes p ON n.parent_id = p.id
                 WHERE n.site = ? AND n.node_type = 'element'{where_stale}
                 ORDER BY n.path, p.region_tag, n.role, n.name
            """, (site,)).fetchall()

            for r in rows:
                path = r["path"]
                region = r["parent_region"] or "body"
                selectors = _top_selectors(c, r["id"], limit=3)
                tree.setdefault(path, {}).setdefault(region, []).append({
                    "role": r["role"],
                    "name": r["name"],
                    "node_key": r["node_key"],
                    "verified_count": r["verified_count"],
                    "last_ok": r["last_ok"],
                    "stale": bool(r["stale"]),
                    "selectors": selectors,
                })
    except Exception as e:
        log.warning("[ax] load_tree failed: %s", e)
    return tree
def load_dom_tree(site: str, path: Optional[str] = None,
                  include_stale: bool = False) -> dict:
    """
    Charge l'arbre DOM profond d'un site, reconstruit recursivement via
    parent_id. Format de retour :

        {path: {
            "roots": [node_dict, ...],  # noeuds sans parent (parent_id IS NULL)
            "by_id": {id: node_dict},   # lookup rapide par id
        }}

    Chaque node_dict contient :
        id, role, name, node_type, region_tag, verified_count, stale,
        selectors, children (liste recursive de node_dict)

    Si `path` est fourni, ne charge QUE cette page (perf).
    """
    if not site:
        return {}
    out: dict[str, dict] = {}
    try:
        with _conn() as c:
            where_stale = "" if include_stale else " AND stale = 0"
            if path is not None:
                rows = c.execute(f"""
                    SELECT id, path, parent_id, node_type, region_tag,
                           role, name, node_key, verified_count, last_ok, stale
                      FROM ax_nodes
                     WHERE site = ? AND path = ?{where_stale}
                     ORDER BY {nulls_first('parent_id')}, role, name
                """, (site, path)).fetchall()
            else:
                rows = c.execute(f"""
                    SELECT id, path, parent_id, node_type, region_tag,
                           role, name, node_key, verified_count, last_ok, stale
                      FROM ax_nodes
                     WHERE site = ?{where_stale}
                     ORDER BY path, {nulls_first('parent_id')}, role, name
                """, (site,)).fetchall()

            # Premiere passe : index par path -> by_id, chaque node avec children=[]
            for r in rows:
                p = r["path"]
                if p not in out:
                    out[p] = {"roots": [], "by_id": {}}
                selectors = (_top_selectors(c, r["id"], limit=3)
                             if r["node_type"] == "element" else [])
                out[p]["by_id"][r["id"]] = {
                    "id":             r["id"],
                    "parent_id":      r["parent_id"],
                    "role":           r["role"],
                    "name":           r["name"],
                    "node_type":      r["node_type"],
                    "region_tag":     r["region_tag"],
                    "node_key":       r["node_key"],
                    "verified_count": r["verified_count"],
                    "last_ok":        r["last_ok"],
                    "stale":          bool(r["stale"]),
                    "selectors":      selectors,
                    "children":       [],
                }
            # Seconde passe : rattacher chaque node a son parent, ou aux roots
            for data in out.values():
                by_id = data["by_id"]
                for node in by_id.values():
                    pid = node["parent_id"]
                    if pid is None or pid not in by_id:
                        data["roots"].append(node)
                    else:
                        by_id[pid]["children"].append(node)
    except Exception as e:
        log.warning("[ax] load_dom_tree failed: %s", e)
    return out
def get_tree_json(site: str) -> dict:
    """
    Retourne l'arbre DOM complet d'un site au format JSON structure
    pour l'UI (accordion). Format :
        {
          site: str,
          paths: [
            {path: str, roots: [node_tree, ...]},
          ]
        }
    Chaque node_tree : {id, role, name, node_type, verified_count, stale,
                        expandable, selectors, children: [...]}
    """
    if not site:
        return {"site": site, "paths": []}
    dom = load_dom_tree(site, include_stale=True)
    if not dom:
        return {"site": site, "paths": []}

    def _serialize(node):
        return {
            "id":             node["id"],
            "role":           node["role"],
            "name":           node["name"],
            "node_type":      node["node_type"],
            "region_tag":     node.get("region_tag"),
            "verified_count": node["verified_count"],
            "stale":          bool(node["stale"]),
            "selectors": [
                {
                    "strategy":      s["strategy"],
                    "value":         s["value"],
                    "success_count": s.get("success_count") or 0,
                    "failure_count": s.get("failure_count") or 0,
                }
                for s in (node.get("selectors") or [])
            ],
            "children": [_serialize(c) for c in (node.get("children") or [])],
        }

    paths_out = []
    for path in sorted(dom.keys(), key=lambda p: (p != "/", p)):
        roots = dom[path]["roots"]
        paths_out.append({
            "path":  path,
            "roots": [_serialize(r) for r in roots],
        })
    return {"site": site, "paths": paths_out}


def search_nodes(site: str, query: str, limit: int = 20) -> list[dict]:
    """Recherche d'éléments par nom ou rôle sur un site (LIKE, insensible
    à la casse).

    Pensé pour que le modèle retrouve "où est le bouton X" sans charger
    tout l'arbre du site dans son contexte. Retour COMPACT — une ligne
    par élément trouvé, plafonné par ``limit`` :

        [{"path", "role", "name", "region_tag", "verified_count",
          "stale", "selector"}, ...]

    ``selector`` = le meilleur sélecteur connu pour ce noeud (1 seul).
    Tri : éléments fiables d'abord (non-stale, puis verified_count
    décroissant).
    """
    if not site or not query:
        return []
    q = f"%{query.strip()}%"
    lim = max(1, min(int(limit), 100))
    out: list[dict] = []
    try:
        with _conn() as c:
            rows = c.execute(f"""
                SELECT n.id, n.path, n.role, n.name, n.region_tag,
                       n.verified_count, n.stale
                  FROM ax_nodes n
                 WHERE n.site = ? AND n.node_type = 'element'
                   AND ( {ci_like("n.name")}
                      OR {ci_like("n.role")} )
                 ORDER BY n.stale ASC, n.verified_count DESC, n.name ASC
                 LIMIT ?
            """, (site, q, q, lim)).fetchall()
            for r in rows:
                sels = _top_selectors(c, r["id"], limit=1)
                out.append({
                    "path":           r["path"],
                    "role":           r["role"],
                    "name":           r["name"],
                    "region_tag":     r["region_tag"],
                    "verified_count": r["verified_count"],
                    "stale":          bool(r["stale"]),
                    "selector":       (sels[0] if sels else None),
                })
    except Exception as e:
        log.warning("[ax] search_nodes failed: %s", e)
    return out


# ---------------------------------------------------------------------------
# Rendering pour le system prompt (arbre ASCII)
# ---------------------------------------------------------------------------

_REGION_ORDER = {
    "header": 0, "banner": 0,
    "nav": 1, "navigation": 1,
    "main": 2,
    "search": 3,
    "form": 4,
    "dialog": 5, "menu": 5, "toolbar": 5,
    "aside": 6, "complementary": 6,
    "footer": 7, "contentinfo": 7,
    "body": 9,
}
