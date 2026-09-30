# SPDX-License-Identifier: MIT
"""
Action recording — record_action, record_inspection, region inference.

Auto-extracted from the former monolithic ``backend/ax_memory/_legacy.py``.
Function bodies are byte-for-byte identical to the originals.
"""
from __future__ import annotations

import logging
import sqlite3
import time
from typing import Any, Optional

log = logging.getLogger(__name__)

from shared_infra.db._dialect import insert_id
from shared_infra.memory.ax._connection import _DB_LOCK, _conn
from shared_infra.memory.ax.selectors import extract_selectors_from_kwargs, node_key
from shared_infra.memory.ax.urls import normalize_url

# ── Region detection (heuristic — no DOM scraping) ──────────────────
_KNOWN_REGIONS = {
    "header", "nav", "main", "aside", "footer", "form",
    "dialog", "menu", "toolbar", "banner", "complementary",
    "contentinfo", "search", "navigation",
}


def infer_region(result: Any, fallback_role: str = "") -> str:
    """
    Detecte la region semantique d'un element depuis le result de pw_act.
    Retourne une chaine parmi _KNOWN_REGIONS ou 'body' si rien trouve.
    """
    if not isinstance(result, dict):
        return "body"
    for key in ("region", "region_tag", "ancestor", "closest_landmark"):
        v = result.get(key)
        if isinstance(v, str) and v.lower() in _KNOWN_REGIONS:
            return v.lower()
    if fallback_role and fallback_role.lower() in _KNOWN_REGIONS:
        return fallback_role.lower()
    return "body"


# ---------------------------------------------------------------------------
# Action success detection
# ---------------------------------------------------------------------------
def is_action_success(result: Any) -> bool:
    if not isinstance(result, dict):
        return False
    if "error" in result and result["error"]:
        return False
    if result.get("ok") is True:
        return True
    if result.get("success") is True:
        return True
    if result.get("element_found") is True:
        return True
    return True


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------
def _get_or_create_region(c: sqlite3.Connection, site: str, path: str,
                         region_tag: str) -> int:
    """Retourne l'id du noeud region pour (site, path, region_tag).
    Cree le noeud s'il n'existe pas."""
    row = c.execute("""
        SELECT id FROM ax_nodes
         WHERE site=? AND path=? AND parent_id IS NULL
           AND node_type='region' AND region_tag=?
    """, (site, path, region_tag)).fetchone()
    if row:
        return row["id"]
    return insert_id(c.cursor(), """
        INSERT INTO ax_nodes
            (site, path, parent_id, node_type, region_tag,
             role, name, node_key, verified_count, last_ok, stale)
        VALUES (?, ?, NULL, 'region', ?, 'region', ?, ?, 0, ?, 0)
    """, (site, path, region_tag, region_tag,
          f"region:{region_tag}", time.time()))
def _resolve_ancestor_chain(
    c: sqlite3.Connection,
    site: str,
    path: str,
    ancestors: list[dict],
) -> Optional[int]:
    """
    Construit ou retrouve la chaine d'ancetres DOM capturee par server.js,
    et retourne l'id du plus proche ancetre (qui sera le parent_id de
    l'element). Les ancetres sont tries du plus proche au plus eloigne.

    Chaque ancetre est un noeud ax_nodes avec node_type='region' (pour
    rester compatible avec le reste du code), parent_id pointant vers
    l'ancetre suivant dans la chaine, ou NULL pour la racine.

    Ex : ancestors = [{role:menu, name:Admin}, {role:nav, name:Main}, {role:banner}]
    Resultat :
       node root (banner)  parent_id=NULL
         -> node nav (Main)  parent_id=root
            -> node menu (Admin)  parent_id=nav  <-- retourne cet id
    """
    if not ancestors:
        return None
    # On traite du plus eloigne au plus proche (inverse de l'ordre recu)
    chain = list(reversed(ancestors))
    parent_id: Optional[int] = None
    now = time.time()

    for anc in chain:
        if not isinstance(anc, dict):
            continue
        role = (anc.get("role") or anc.get("tag") or "region").strip().lower()
        name = (anc.get("name") or "").strip()
        if len(name) > 80:
            name = name[:80]
        region_tag = role  # pour le filtrage et le tri des regions
        anc_key = node_key(role, name) if name else f"region:{role}"

        # Recherche existant par (site, path, parent_id, node_key)
        if parent_id is None:
            row = c.execute("""
                SELECT id FROM ax_nodes
                 WHERE site=? AND path=? AND parent_id IS NULL
                   AND node_type='region' AND node_key=?
            """, (site, path, anc_key)).fetchone()
        else:
            row = c.execute("""
                SELECT id FROM ax_nodes
                 WHERE site=? AND path=? AND parent_id=?
                   AND node_type='region' AND node_key=?
            """, (site, path, parent_id, anc_key)).fetchone()

        if row:
            parent_id = row["id"]
            # Bump le compteur de l'ancetre pour tracer sa frequence
            c.execute("""
                UPDATE ax_nodes SET verified_count = verified_count + 1,
                                    last_ok = ?
                 WHERE id = ?
            """, (now, parent_id))
        else:
            parent_id = insert_id(c.cursor(), """
                INSERT INTO ax_nodes
                    (site, path, parent_id, node_type, region_tag,
                     role, name, node_key, verified_count, last_ok, stale)
                VALUES (?, ?, ?, 'region', ?, ?, ?, ?, 1, ?, 0)
            """, (site, path, parent_id, region_tag, role,
                  name, anc_key, now))
    return parent_id
def record_action(
    url: str,
    role: str,
    name: str,
    result: Any,
    locator_kw: Optional[dict] = None,
    url_before: Optional[str] = None,
    ancestors: Optional[list[dict]] = None,
) -> Optional[str]:
    """
    Hook appele depuis tools/firefox_tools.py apres chaque pw_act.

    Fonctionnement
    --------------
    Succes :
      1. Extraction de tous les selecteurs passes en kwargs (role+name, test_id,
         css, xpath, label, placeholder, text).
      2. Detection de la region semantique depuis le result.
      3. Si `ancestors` fourni (depuis server.js): construit la chaine DOM
         reelle (header > nav > menu > element). Les ancetres sont imbriques
         via parent_id. Max 3 niveaux au-dessus de l'element.
      4. Upsert du noeud element (parent_id = plus proche ancetre).
      5. Pour chaque strategie de selecteur utilisee, upsert dans ax_selectors
         avec success_count++.
      6. Si url_before est fournie ET differente de l'url finale : enregistre
         la transition (from_path -> to_path) dans ax_transitions.
    Echec :
      - Si le noeud existe -> mark stale.
      - Pour chaque selecteur utilise -> failure_count++.

    `ancestors` format : [
        {'tag':'menu','role':'menu','name':'Admin','expandable':True},
        {'tag':'nav','role':'navigation','name':'Main','expandable':False},
        {'tag':'header','role':'banner','name':'','expandable':False},
    ]
    Ordre : plus proche ancetre en premier. Si None ou vide, on tombe
    sur l'ancien comportement (region semantique via infer_region).

    Retourne 'saved' / 'stale' / None.
    """
    site, path = normalize_url(
        url or (result.get("url") if isinstance(result, dict) else "")
    )
    if not site or not role or not name:
        return None

    locator_kw = locator_kw or {}
    kw_for_extract = dict(locator_kw)
    kw_for_extract["role"] = role
    kw_for_extract["name"] = name
    selectors = extract_selectors_from_kwargs(kw_for_extract)
    if not selectors:
        return None

    key = node_key(role, name)
    ok = is_action_success(result)
    region = infer_region(result)
    now = time.time()

    # Calcul de la transition potentielle.
    # On considere qu'il y a transition si :
    #   1. l'action a reussi
    #   2. url_before est fournie et non vide
    #   3. la page destination (path) est differente de la page source
    # La page "source" pour l'enregistrement du noeud element est url_before
    # (c'est la page sur laquelle l'element se trouve). La page "dest" est path.
    transition_from = None
    transition_to = None
    # Path sur lequel l'element vit (= page ou il a ete clique)
    element_path = path
    if ok and url_before:
        site_before, path_before = normalize_url(url_before)
        if site_before == site and path_before != path:
            transition_from = path_before
            transition_to = path
            # L'element est sur la page source, pas la destination
            element_path = path_before

    try:
        with _DB_LOCK, _conn() as c:
            if ok:
                # Si les ancetres DOM sont fournis par le serveur Node, on
                # construit la chaine parent_id reelle. Sinon on retombe sur
                # l'ancien comportement (region semantique plate).
                if ancestors and isinstance(ancestors, list):
                    region_id = _resolve_ancestor_chain(
                        c, site, element_path, ancestors,
                    )
                else:
                    region_id = _get_or_create_region(
                        c, site, element_path, region,
                    )
            else:
                region_id = None

            if ok:
                existing = c.execute("""
                    SELECT id FROM ax_nodes
                     WHERE site=? AND path=? AND parent_id=? AND node_key=?
                """, (site, element_path, region_id, key)).fetchone()
            else:
                existing = c.execute("""
                    SELECT id FROM ax_nodes
                     WHERE site=? AND path=? AND node_type='element'
                       AND node_key=?
                """, (site, element_path, key)).fetchone()

            if ok:
                if existing:
                    node_id = existing["id"]
                    c.execute("""
                        UPDATE ax_nodes
                           SET verified_count = verified_count + 1,
                               last_ok = ?,
                               stale = 0,
                               stale_at = NULL,
                               role = ?,
                               name = ?
                         WHERE id = ?
                    """, (now, role, (name or "")[:200], node_id))
                else:
                    node_id = insert_id(c.cursor(), """
                        INSERT INTO ax_nodes
                            (site, path, parent_id, node_type, region_tag,
                             role, name, node_key, verified_count, last_ok, stale)
                        VALUES (?, ?, ?, 'element', ?, ?, ?, ?, 1, ?, 0)
                    """, (site, element_path, region_id, region,
                          role, (name or "")[:200], key, now))

                for strat, val in selectors:
                    val_trunc = (val or "")[:300]
                    c.execute("""
                        INSERT INTO ax_selectors
                            (node_id, strategy, value, success_count,
                             failure_count, last_ok)
                        VALUES (?, ?, ?, 1, 0, ?)
                        ON CONFLICT(node_id, strategy, value) DO UPDATE SET
                            success_count = ax_selectors.success_count + 1,
                            last_ok = excluded.last_ok
                    """, (node_id, strat, val_trunc, now))

                # Enregistrement de la transition si detectee
                if transition_from is not None and transition_to is not None:
                    c.execute("""
                        INSERT INTO ax_transitions
                            (site, from_path, action_node_id, to_path,
                             verified_count, last_ok)
                        VALUES (?, ?, ?, ?, 1, ?)
                        ON CONFLICT(site, from_path, action_node_id, to_path)
                        DO UPDATE SET
                            verified_count = ax_transitions.verified_count + 1,
                            last_ok = excluded.last_ok
                    """, (site, transition_from, node_id, transition_to, now))
                    log.debug(
                        "[ax] TRANSITION site=%s %s --[%s]--> %s",
                        site, transition_from, key, transition_to,
                    )

                log.debug("[ax] SAVE site=%s path=%s region=%s key=%s "
                          "selectors=%d",
                          site, element_path, region, key, len(selectors))
                return "saved"
            else:
                if not existing:
                    return None
                node_id = existing["id"]
                c.execute("""
                    UPDATE ax_nodes
                       SET stale = 1, stale_at = ?
                     WHERE id = ? AND stale = 0
                """, (now, node_id))
                for strat, val in selectors:
                    val_trunc = (val or "")[:300]
                    c.execute("""
                        UPDATE ax_selectors
                           SET failure_count = failure_count + 1,
                               last_fail = ?
                         WHERE node_id=? AND strategy=? AND value=?
                    """, (now, node_id, strat, val_trunc))
                log.debug("[ax] STALE site=%s path=%s key=%s",
                          site, element_path, key)
                return "stale"
    except Exception as e:
        log.warning("[ax] record_action failed: %s", e)
        return None


# ---------------------------------------------------------------------------
# Public API : record_inspection
# ---------------------------------------------------------------------------
def record_inspection(url: str, nodes_present: list[dict]) -> dict:
    """
    Appele apres pw_page(op='inspect'). Pour chaque element stale sur le path
    courant :
      - si present -> reactive
      - sinon -> supprime (et ses selecteurs via FK cascade)
    Les regions vides (plus d'enfants) sont aussi nettoyees.
    """
    site, path = normalize_url(url)
    if not site:
        return {"revived": 0, "deleted": 0}

    present_keys: set[str] = set()
    for n in nodes_present or []:
        if not isinstance(n, dict):
            continue
        r = n.get("role") or ""
        nm = (n.get("name") or n.get("accessible_name")
              or n.get("text") or "")
        if r:
            present_keys.add(node_key(r, nm))

    try:
        with _DB_LOCK, _conn() as c:
            stale_rows = c.execute("""
                SELECT id, node_key FROM ax_nodes
                 WHERE site=? AND path=? AND stale=1 AND node_type='element'
            """, (site, path)).fetchall()
            if not stale_rows:
                return {"revived": 0, "deleted": 0}

            to_revive = [r["id"] for r in stale_rows
                         if r["node_key"] in present_keys]
            to_delete = [r["id"] for r in stale_rows
                         if r["node_key"] not in present_keys]
            now = time.time()

            for nid in to_revive:
                c.execute("""
                    UPDATE ax_nodes
                       SET stale=0, stale_at=NULL, last_ok=?
                     WHERE id=?
                """, (now, nid))
            for nid in to_delete:
                c.execute("DELETE FROM ax_nodes WHERE id=?", (nid,))

            c.execute("""
                DELETE FROM ax_nodes
                 WHERE site=? AND path=? AND node_type='region'
                   AND id NOT IN (
                       SELECT parent_id FROM (
                           SELECT DISTINCT parent_id FROM ax_nodes
                            WHERE parent_id IS NOT NULL
                       ) AS parents
                   )
            """, (site, path))

            result = {"revived": len(to_revive), "deleted": len(to_delete)}
            if to_revive or to_delete:
                log.info("[ax] INSPECT site=%s path=%s revived=%d deleted=%d",
                         site, path, result["revived"], result["deleted"])
            return result
    except Exception as e:
        log.warning("[ax] record_inspection failed: %s", e)
        return {"revived": 0, "deleted": 0}


# ---------------------------------------------------------------------------
# Public API : load_tree
# ---------------------------------------------------------------------------
