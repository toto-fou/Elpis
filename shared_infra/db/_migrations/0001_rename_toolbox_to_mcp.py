# SPDX-License-Identifier: MIT
"""
0001_rename_toolbox_to_mcp.py — Refonte 2026 : rename ``toolbox`` → ``mcp``.

Tables touchées : ``agent_pipelines``, ``shared_pipelines``,
``pipeline_versions`` (colonne ``flow_json``).

NB : ``pipeline_runs`` n'est **pas** migré (audit immuable). Le viewer
accepte les anciennes valeurs via l'alias dans ``NodeType.normalize``.

Stratégie
=========
JSON-walk (PAS str.replace) : on parse le ``flow_json``, on muter les 3
champs (``node.name``, ``node.class``, ``node.data.label``) uniquement
là où ils valent exactement les valeurs legacy. Évite la corruption
d'un prompt utilisateur contenant le mot "Sandbox".
"""
from __future__ import annotations

import json
import logging
import sqlite3

logger = logging.getLogger("uvicorn.error")


_TABLES = ("agent_pipelines", "shared_pipelines", "pipeline_versions")


def _walk(node) -> bool:
    """Mutation en place ; retourne True si au moins un champ a changé."""
    changed = False
    if isinstance(node, dict):
        if node.get("name") == "toolbox":
            node["name"] = "mcp"
            changed = True
        if node.get("class") == "toolbox_block":
            node["class"] = "mcp_block"
            changed = True
        data = node.get("data")
        if isinstance(data, dict) and data.get("label") == "Sandbox":
            data["label"] = "MCP"
            changed = True
        for v in node.values():
            if _walk(v):
                changed = True
    elif isinstance(node, list):
        for v in node:
            if _walk(v):
                changed = True
    return changed


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    cur = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (name,),
    )
    return cur.fetchone() is not None


def migrate(conn: sqlite3.Connection) -> None:
    total_rows = 0
    total_changed = 0
    for table in _TABLES:
        if not _table_exists(conn, table):
            logger.info("[0001] %s does not exist — skipping", table)
            continue
        # Détection robuste de la colonne flow_json (certains schémas legacy
        # utilisent un nom différent — on log et skip si absent).
        cur = conn.execute(f"PRAGMA table_info({table})")
        cols = {row[1] for row in cur.fetchall()}
        if "flow_json" not in cols:
            logger.info("[0001] %s has no flow_json column — skipping", table)
            continue

        cur = conn.execute(f"SELECT id, flow_json FROM {table}")
        rows = cur.fetchall()
        for row_id, raw in rows:
            total_rows += 1
            if not raw or "toolbox" not in raw:
                continue  # short-circuit : rien à rewrite ici
            try:
                obj = json.loads(raw)
            except Exception as exc:
                logger.warning(
                    "[0001] %s id=%s flow_json not valid JSON: %s — skipping",
                    table, row_id, exc,
                )
                continue
            if _walk(obj):
                new_raw = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
                conn.execute(
                    f"UPDATE {table} SET flow_json=? WHERE id=?",
                    (new_raw, row_id),
                )
                total_changed += 1
    logger.info(
        "[0001] rename toolbox→mcp: scanned %d rows, mutated %d",
        total_rows, total_changed,
    )
