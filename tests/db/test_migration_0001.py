# SPDX-License-Identifier: MIT
"""
tests/db/test_migration_0001.py — Vérifie la migration toolbox → mcp.

Couvre :
- rewrite de ``node.name``, ``node.class``, ``data.label`` dans flow_json
- préservation des autres données (prompts qui contiennent "Sandbox" en texte)
- idempotence (rerun ne change rien)
- short-circuit si "toolbox" n'apparaît pas dans la string
- tables manquantes ignorées sans erreur
"""
from __future__ import annotations

import importlib
import json
import sqlite3
import pytest

# Migration historique d'une base SQLite (une base serveur naît du schéma de référence).
pytestmark = pytest.mark.sqlite_only


# Le nom de module commence par un chiffre, donc on utilise importlib
# (l'import notation pointée échouerait : ``from shared_infra.db._migrations.0001_…``
# n'est pas une syntaxe Python valide).
_mig0001 = importlib.import_module(
    "shared_infra.db._migrations.0001_rename_toolbox_to_mcp"
)


def _make_db():
    conn = sqlite3.connect(":memory:")
    conn.execute(
        "CREATE TABLE agent_pipelines (id INTEGER PRIMARY KEY, flow_json TEXT)"
    )
    conn.execute(
        "CREATE TABLE shared_pipelines (id INTEGER PRIMARY KEY, flow_json TEXT)"
    )
    conn.execute(
        "CREATE TABLE pipeline_versions (id INTEGER PRIMARY KEY, flow_json TEXT)"
    )
    return conn


_FLOW_WITH_TOOLBOX = {
    "drawflow": {
        "Home": {
            "data": {
                "1": {
                    "id": 1,
                    "name": "toolbox",
                    "class": "toolbox_block",
                    "data": {"label": "Sandbox", "tools": ["fs", "shell"]},
                    "inputs": {},
                    "outputs": {"output_1": {"connections": []}},
                },
                "2": {
                    "id": 2,
                    "name": "agent",
                    "class": "agent_block",
                    "data": {
                        "instructions": "Use the Sandbox to run shell commands.",
                        "role": "Worker",
                    },
                },
            }
        }
    }
}


def test_walk_rewrites_only_target_fields():
    obj = json.loads(json.dumps(_FLOW_WITH_TOOLBOX))  # deep copy
    changed = _mig0001._walk(obj)
    assert changed is True
    node1 = obj["drawflow"]["Home"]["data"]["1"]
    assert node1["name"] == "mcp"
    assert node1["class"] == "mcp_block"
    assert node1["data"]["label"] == "MCP"
    # Agent instructions referencing "Sandbox" should NOT be touched
    node2 = obj["drawflow"]["Home"]["data"]["2"]
    assert "Sandbox" in node2["data"]["instructions"]


def test_walk_idempotent_on_already_migrated():
    obj = json.loads(json.dumps(_FLOW_WITH_TOOLBOX))
    _mig0001._walk(obj)
    changed_2 = _mig0001._walk(obj)
    assert changed_2 is False


def test_migrate_rewrites_all_3_tables():
    conn = _make_db()
    for table in ("agent_pipelines", "shared_pipelines", "pipeline_versions"):
        conn.execute(
            f"INSERT INTO {table}(flow_json) VALUES(?)",
            (json.dumps(_FLOW_WITH_TOOLBOX),),
        )
    conn.commit()

    _mig0001.migrate(conn)

    for table in ("agent_pipelines", "shared_pipelines", "pipeline_versions"):
        row = conn.execute(f"SELECT flow_json FROM {table}").fetchone()
        obj = json.loads(row[0])
        node = obj["drawflow"]["Home"]["data"]["1"]
        assert node["name"] == "mcp"
        assert node["class"] == "mcp_block"
        assert node["data"]["label"] == "MCP"


def test_migrate_short_circuits_when_no_toolbox():
    conn = _make_db()
    benign = json.dumps({"drawflow": {"Home": {"data": {}}}})
    conn.execute("INSERT INTO agent_pipelines(flow_json) VALUES(?)", (benign,))
    conn.commit()
    _mig0001.migrate(conn)  # no crash
    row = conn.execute("SELECT flow_json FROM agent_pipelines").fetchone()
    assert row[0] == benign


def test_migrate_handles_missing_tables_gracefully():
    conn = sqlite3.connect(":memory:")
    # Aucune table créée → la migration doit passer sans erreur
    _mig0001.migrate(conn)


def test_migrate_handles_invalid_json_silently():
    conn = _make_db()
    conn.execute(
        "INSERT INTO agent_pipelines(flow_json) VALUES(?)",
        ("not-json-but-contains-toolbox",),
    )
    conn.commit()
    _mig0001.migrate(conn)  # no crash, just a warning
    row = conn.execute("SELECT flow_json FROM agent_pipelines").fetchone()
    assert row[0] == "not-json-but-contains-toolbox"
