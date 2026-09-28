# SPDX-License-Identifier: MIT
"""
Page-transition graph — load + adjacency + BFS paths.

Auto-extracted from the former monolithic ``backend/ax_memory/_legacy.py``.
Function bodies are byte-for-byte identical to the originals.
"""
from __future__ import annotations

import logging
from collections import deque
from typing import Optional

log = logging.getLogger(__name__)

from shared_infra.memory.ax._connection import _conn
from shared_infra.memory.ax.selectors import _top_selectors


def load_transitions(site: str) -> list[dict]:
    """
    Retourne toutes les transitions connues pour un site :
    [{from_path, to_path, action_role, action_name, verified_count}, ...]
    Exclut les noeuds d'action stale.
    """
    if not site:
        return []
    out = []
    try:
        with _conn() as c:
            rows = c.execute("""
                SELECT t.from_path, t.to_path, t.verified_count,
                       n.role AS action_role, n.name AS action_name,
                       n.stale AS action_stale
                  FROM ax_transitions t
                  JOIN ax_nodes n ON t.action_node_id = n.id
                 WHERE t.site = ?
                 ORDER BY t.verified_count DESC, t.last_ok DESC
            """, (site,)).fetchall()
        for r in rows:
            if r["action_stale"]:
                continue
            out.append({
                "from_path":      r["from_path"],
                "to_path":        r["to_path"],
                "action_role":    r["action_role"],
                "action_name":    r["action_name"],
                "verified_count": r["verified_count"],
            })
    except Exception as e:
        log.warning("[ax] load_transitions failed: %s", e)
    return out
def _build_adjacency(transitions: list[dict]) -> tuple[dict, dict]:
    """
    Construit 2 maps d'adjacence pour BFS :
      - forward:  {from_path: [(to_path, action_role, action_name, vc), ...]}
      - backward: {to_path:   [(from_path, action_role, action_name, vc), ...]}
    """
    fwd: dict[str, list[tuple]] = {}
    bwd: dict[str, list[tuple]] = {}
    for t in transitions:
        edge = (t["to_path"], t["action_role"], t["action_name"],
                t["verified_count"])
        fwd.setdefault(t["from_path"], []).append(edge)
        redge = (t["from_path"], t["action_role"], t["action_name"],
                 t["verified_count"])
        bwd.setdefault(t["to_path"], []).append(redge)
    return fwd, bwd
def _bfs_paths(start: str, adjacency: dict, max_depth: int) -> dict:
    """
    BFS depuis start, renvoie {path: depth} pour les paths atteints.
    Depth 0 = start lui-meme.
    """
    visited: dict[str, int] = {start: 0}
    queue: list[tuple[str, int]] = [(start, 0)]
    while queue:
        node, depth = queue.pop(0)
        if depth >= max_depth:
            continue
        for edge in adjacency.get(node, []):
            neighbor = edge[0]
            if neighbor not in visited:
                visited[neighbor] = depth + 1
                queue.append((neighbor, depth + 1))
    return visited


def find_path(site: str, to_path: str, from_path: Optional[str] = None,
              max_depth: int = 6) -> dict:
    """Reconstruit le plus court chemin de clics CONNU pour atteindre une page.

    S'appuie sur le graphe ``ax_transitions`` accumulé par ``record_action``
    (chaque transition = "sur from_path, l'action X mène à to_path"). C'est
    le coeur du "ne pas refaire le travail" : le modèle demande un chemin
    plutôt que de re-naviguer l'IHM à l'aveugle.

    Paramètres
    ----------
    site       : identifiant de site normalisé (host[:port]).
    to_path    : page de destination ("/admin/users", "/", ...).
    from_path  : page de départ. Si ``None`` → BFS multi-source : on
                 cherche le chemin connu le plus court depuis N'IMPORTE
                 quelle page connue (utile quand le modèle ne sait pas
                 encore où il se trouve).
    max_depth  : profondeur BFS maximale (défaut 6).

    Retour — COMPACT, jamais l'arbre entier :
        {
          "found": bool,
          "site": str,
          "from_path": str | None,   # départ RÉEL du chemin trouvé
          "to_path": str,
          "depth": int,              # nombre d'étapes (0 = déjà sur place)
          "steps": [
            {"from", "to", "action_role", "action_name",
             "action_selector", "verified_count"},
            ...
          ],
        }

    ``action_selector`` (le meilleur sélecteur connu du noeud d'action)
    n'est résolu QUE pour les étapes du chemin gagnant — pas pour tout
    le graphe.
    """
    empty = {"found": False, "site": site, "from_path": from_path,
             "to_path": to_path, "depth": 0, "steps": []}
    if not site or not to_path:
        return empty

    # Déjà arrivé : départ explicite == destination.
    if from_path is not None and from_path == to_path:
        return {"found": True, "site": site, "from_path": from_path,
                "to_path": to_path, "depth": 0, "steps": []}

    try:
        with _conn() as c:
            rows = c.execute("""
                SELECT t.from_path, t.to_path, t.action_node_id,
                       t.verified_count,
                       n.role  AS action_role,
                       n.name  AS action_name,
                       n.stale AS action_stale
                  FROM ax_transitions t
                  JOIN ax_nodes n ON t.action_node_id = n.id
                 WHERE t.site = ?
            """, (site,)).fetchall()

            # Adjacence forward : from_path -> [edge, ...]. On ignore les
            # transitions dont le noeud d'action est stale.
            fwd: dict[str, list[dict]] = {}
            all_from: set[str] = set()
            for r in rows:
                if r["action_stale"]:
                    continue
                edge = {
                    "from":            r["from_path"],
                    "to":              r["to_path"],
                    "action_node_id":  r["action_node_id"],
                    "action_role":     r["action_role"],
                    "action_name":     r["action_name"],
                    "verified_count":  r["verified_count"],
                }
                fwd.setdefault(r["from_path"], []).append(edge)
                all_from.add(r["from_path"])

            if not fwd:
                return empty

            # Sources de la BFS.
            if from_path is not None:
                sources = [from_path]
            else:
                sources = list(all_from)

            # BFS avec parent-tracking : node -> (parent_node, edge_utilisee).
            # Les sources pointent sur None.
            parent: dict[str, Optional[tuple]] = {s: None for s in sources}
            queue: deque = deque((s, 0) for s in sources)
            reached: Optional[str] = None
            while queue:
                node, depth = queue.popleft()
                if node == to_path:
                    reached = node
                    break
                if depth >= max_depth:
                    continue
                # À profondeur égale, on préfère les transitions les plus
                # vérifiées (les plus fiables).
                for edge in sorted(fwd.get(node, []),
                                   key=lambda e: -e["verified_count"]):
                    nxt = edge["to"]
                    if nxt not in parent:
                        parent[nxt] = (node, edge)
                        queue.append((nxt, depth + 1))

            if reached is None:
                return empty

            # Reconstruction du chemin source -> cible.
            chain: list[dict] = []
            cur = reached
            while parent.get(cur) is not None:
                prev, edge = parent[cur]
                chain.append(edge)
                cur = prev
            chain.reverse()

            # Résolution des sélecteurs UNIQUEMENT pour les étapes retenues.
            steps = []
            for edge in chain:
                sels = _top_selectors(c, edge["action_node_id"], limit=1)
                steps.append({
                    "from":            edge["from"],
                    "to":              edge["to"],
                    "action_role":     edge["action_role"],
                    "action_name":     edge["action_name"],
                    "action_selector": (sels[0] if sels else None),
                    "verified_count":  edge["verified_count"],
                })

            actual_from = chain[0]["from"] if chain else (from_path or to_path)
            return {
                "found":     True,
                "site":      site,
                "from_path": actual_from,
                "to_path":   to_path,
                "depth":     len(steps),
                "steps":     steps,
            }
    except Exception as e:
        log.warning("[ax] find_path failed: %s", e)
        return {**empty, "error": str(e)}
