# SPDX-License-Identifier: MIT
"""
0002_remove_dead_blocks.py — Refonte 2026 : nettoyage des blocs morts.

Deux comportements :

1. **Auto-rewrite ``sandbox_read`` → ``inject``** : même shape de data,
   on ajoute ``source="sandbox"`` pour matcher le discriminator du bloc
   inject. Inversible si jamais on revenait en arrière.

2. **Tag dans ``pipeline_health``** pour tous les autres blocs supprimés
   (``fork``, ``agent_team``, ``tool_*``, ``lsp_query``, etc.). Pas
   d'auto-rewrite — l'utilisateur doit ouvrir l'éditeur et remplacer.
   Le boot **ne fail pas** ; une bannière s'affiche à l'ouverture.

Tables touchées
===============
- ``agent_pipelines.flow_json``    : auto-rewrite + tagging
- ``shared_pipelines.flow_json``   : idem
- ``pipeline_versions.flow_json``  : idem
- ``pipeline_health`` (créée si absente) : tagging

``pipeline_runs`` n'est pas modifié (audit immuable).
"""
from __future__ import annotations

import json
import logging
import sqlite3
import time
from typing import Tuple

logger = logging.getLogger("uvicorn.error")


_TABLES = ("agent_pipelines", "shared_pipelines", "pipeline_versions")

# Types de blocs retirés depuis la v2 du moteur de pipelines (supprimé depuis).
_REMOVED = frozenset({
    "fork",
    "agent_team",
    "tool_fs", "tool_shell", "tool_web", "tool_git",
    "tool_chart", "tool_net", "tool_custom", "tool",
    "lsp_query", "code_diagnostics",
    "team_artifact_write", "team_artifact_read",
})

# Refonte 2026 pivot — blocs retirés DU CANVAS dont les nodes doivent être
# physiquement supprimés du flow_json (avec leurs edges) car ils n'ont plus
# de def côté _nodeTypes et casseraient l'affichage. Pas de report de data
# (les tools du toolbox sont à reconfigurer manuellement par l'utilisateur
# dans le nouveau sous-menu Tools de l'éditeur agent).
_AUTO_DELETE = frozenset({
    "mcp", "toolbox",          # ex-MCP/Sandbox bloc unifié → tools inline agent
    "blackboard_write", "blackboard_read",  # jamais utilisé
})


def _walk_for_actions(node, *, found: list, parent_path: str = "") -> bool:
    """Parcours récursif. Auto-rewrite ``sandbox_read`` → ``inject`` ;
    accumule les autres types retirés trouvés dans ``found``.

    Retourne True si une mutation a eu lieu sur cette racine.
    """
    changed = False
    if isinstance(node, dict):
        name = node.get("name")
        if name == "sandbox_read":
            node["name"] = "inject"
            node["class"] = "inject_block"
            data = node.setdefault("data", {})
            if isinstance(data, dict):
                data.setdefault("source", "sandbox")
            changed = True
        elif name in _REMOVED:
            found.append((node.get("id", "?"), name))
        for v in node.values():
            if _walk_for_actions(v, found=found, parent_path=parent_path):
                changed = True
    elif isinstance(node, list):
        for v in node:
            if _walk_for_actions(v, found=found, parent_path=parent_path):
                changed = True
    return changed


def _delete_orphan_nodes(flow_dict: dict, deleted: list) -> bool:
    """Supprime physiquement les nœuds ``_AUTO_DELETE`` du ``flow_json``
    Drawflow + leurs connexions sortantes/entrantes dans tous les autres
    nœuds. Retourne True si au moins un nœud a été retiré.

    ``deleted`` est accumulé avec (node_id, name) pour le tagging.
    """
    try:
        nodes_map = flow_dict["drawflow"]["Home"]["data"]
    except (KeyError, TypeError):
        return False
    if not isinstance(nodes_map, dict):
        return False

    to_remove: list[str] = []
    for nid, node in list(nodes_map.items()):
        if not isinstance(node, dict):
            continue
        if node.get("name") in _AUTO_DELETE:
            deleted.append((nid, node.get("name", "?")))
            to_remove.append(str(nid))

    if not to_remove:
        return False

    removed_set = set(to_remove)

    # Purge des connexions vers/depuis les nœuds supprimés dans tous les
    # autres nœuds.
    for _other_nid, other in nodes_map.items():
        if not isinstance(other, dict):
            continue
        for port_kind in ("inputs", "outputs"):
            ports = other.get(port_kind) or {}
            if not isinstance(ports, dict):
                continue
            for port in ports.values():
                if not isinstance(port, dict):
                    continue
                conns = port.get("connections")
                if not isinstance(conns, list):
                    continue
                port["connections"] = [
                    c for c in conns
                    if str((c or {}).get("node", "")) not in removed_set
                ]

    for nid in to_remove:
        nodes_map.pop(nid, None)
    return True


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    cur = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (name,),
    )
    return cur.fetchone() is not None


def _ensure_pipeline_health(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS pipeline_health (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            source_table  TEXT NOT NULL,
            pipeline_id   INTEGER NOT NULL,
            node_id       TEXT NOT NULL,
            issue         TEXT NOT NULL,
            detected_at   REAL NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_pipeline_health_pid "
        "ON pipeline_health(source_table, pipeline_id)"
    )


def migrate(conn: sqlite3.Connection) -> None:
    _ensure_pipeline_health(conn)
    now = time.time()
    n_rewrites = 0
    n_tagged = 0
    for table in _TABLES:
        if not _table_exists(conn, table):
            logger.info("[0002] %s does not exist — skipping", table)
            continue
        cur = conn.execute(f"PRAGMA table_info({table})")
        cols = {row[1] for row in cur.fetchall()}
        if "flow_json" not in cols:
            continue

        rows = conn.execute(f"SELECT id, flow_json FROM {table}").fetchall()
        for row_id, raw in rows:
            if not raw:
                continue
            # Short-circuit si rien de pertinent dans la string
            if ("sandbox_read" not in raw
                and not any(t in raw for t in _REMOVED)
                and not any(t in raw for t in _AUTO_DELETE)):
                continue
            try:
                obj = json.loads(raw)
            except Exception as exc:
                logger.warning(
                    "[0002] %s id=%s flow_json not valid JSON: %s — skipping",
                    table, row_id, exc,
                )
                continue

            found: list[Tuple[str, str]] = []
            changed_walk = _walk_for_actions(obj, found=found)

            # Suppression physique des blocs canvas retirés (mcp/toolbox/
            # blackboard) — décision pivot refonte 2026.
            deleted: list[Tuple[str, str]] = []
            changed_del = _delete_orphan_nodes(obj, deleted)

            if changed_walk or changed_del:
                new_raw = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
                conn.execute(
                    f"UPDATE {table} SET flow_json=? WHERE id=?",
                    (new_raw, row_id),
                )
                n_rewrites += 1

            # Tag dans pipeline_health pour les types REMOVED non auto-rewrités
            for node_id, type_name in found:
                conn.execute(
                    "INSERT INTO pipeline_health "
                    "(source_table, pipeline_id, node_id, issue, detected_at) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (table, row_id, str(node_id),
                     f"removed-block:{type_name}", now),
                )
                n_tagged += 1
            # Tag aussi les auto-deleted pour que l'utilisateur soit informé
            # qu'il doit reconfigurer manuellement (cas mcp/toolbox = tools
            # à re-cocher dans le sous-menu Tools de l'éditeur agent).
            for node_id, type_name in deleted:
                conn.execute(
                    "INSERT INTO pipeline_health "
                    "(source_table, pipeline_id, node_id, issue, detected_at) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (table, row_id, str(node_id),
                     f"auto-deleted-block:{type_name}", now),
                )
                n_tagged += 1

    logger.info(
        "[0002] dead-blocks cleanup: %d auto-rewrites (sandbox_read→inject), "
        "%d pipeline_health tags",
        n_rewrites, n_tagged,
    )
