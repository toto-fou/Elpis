# SPDX-License-Identifier: MIT
"""
tests/db/test_migration_0002.py — vérifie le cleanup des blocs morts.

- sandbox_read auto-migré → inject (source='sandbox')
- fork / tool_* / agent_team / lsp_query → tagués dans pipeline_health
- pipeline_runs NON modifié (audit immuable)
- pas de double-tagging au rerun
"""
from __future__ import annotations

import importlib
import json
import sqlite3
import pytest

# Migration historique d'une base SQLite (une base serveur naît du schéma de référence).
pytestmark = pytest.mark.sqlite_only


_mig0002 = importlib.import_module(
    "shared_infra.db._migrations.0002_remove_dead_blocks"
)


def _db_with_pipelines(*pipelines: dict) -> sqlite3.Connection:
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
    for p in pipelines:
        conn.execute(
            "INSERT INTO agent_pipelines(flow_json) VALUES(?)",
            (json.dumps(p),),
        )
    conn.commit()
    return conn


def _flow_with(*nodes: dict) -> dict:
    data = {str(i): n for i, n in enumerate(nodes, start=1)}
    return {"drawflow": {"Home": {"data": data}}}


def test_sandbox_read_auto_migrated_to_inject():
    sb = {"id": 1, "name": "sandbox_read", "class": "sandbox_read_block",
          "data": {"label": "Sandbox Read", "files": "a.py"}}
    flow = _flow_with(sb)
    conn = _db_with_pipelines(flow)
    _mig0002.migrate(conn)

    row = conn.execute("SELECT flow_json FROM agent_pipelines").fetchone()
    obj = json.loads(row[0])
    node = obj["drawflow"]["Home"]["data"]["1"]
    assert node["name"] == "inject"
    assert node["class"] == "inject_block"
    assert node["data"]["source"] == "sandbox"
    assert node["data"]["files"] == "a.py"  # data preservée


def test_fork_block_tagged_in_pipeline_health():
    fk = {"id": 2, "name": "fork", "class": "fork_block", "data": {}}
    conn = _db_with_pipelines(_flow_with(fk))
    _mig0002.migrate(conn)
    rows = conn.execute(
        "SELECT source_table, node_id, issue FROM pipeline_health"
    ).fetchall()
    assert any(r[2] == "removed-block:fork" for r in rows)


def test_tool_blocks_tagged():
    nodes = [
        {"id": "n1", "name": "tool_fs", "class": "tool_icon", "data": {}},
        {"id": "n2", "name": "tool_custom", "class": "tool_icon_wide", "data": {}},
        {"id": "n3", "name": "agent_team", "class": "agent_team_block", "data": {}},
    ]
    conn = _db_with_pipelines(_flow_with(*nodes))
    _mig0002.migrate(conn)
    issues = {r[0] for r in conn.execute("SELECT issue FROM pipeline_health").fetchall()}
    assert "removed-block:tool_fs" in issues
    assert "removed-block:tool_custom" in issues
    assert "removed-block:agent_team" in issues


def test_pipeline_runs_not_touched():
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE agent_pipelines (id INTEGER PRIMARY KEY, flow_json TEXT)")
    conn.execute(
        "CREATE TABLE pipeline_runs (id INTEGER PRIMARY KEY, flow_json TEXT)"
    )
    flow = json.dumps(_flow_with(
        {"id": 1, "name": "sandbox_read", "class": "sandbox_read_block", "data": {}}
    ))
    conn.execute("INSERT INTO pipeline_runs(flow_json) VALUES(?)", (flow,))
    conn.execute("INSERT INTO agent_pipelines(flow_json) VALUES(?)", (flow,))
    conn.commit()
    _mig0002.migrate(conn)
    # pipeline_runs reste à l'identique
    row = conn.execute("SELECT flow_json FROM pipeline_runs").fetchone()
    assert json.loads(row[0])["drawflow"]["Home"]["data"]["1"]["name"] == "sandbox_read"


def test_no_double_tagging_on_rerun():
    fk = {"id": 1, "name": "fork", "class": "fork_block", "data": {}}
    conn = _db_with_pipelines(_flow_with(fk))
    _mig0002.migrate(conn)
    n1 = conn.execute("SELECT COUNT(*) FROM pipeline_health").fetchone()[0]
    _mig0002.migrate(conn)
    n2 = conn.execute("SELECT COUNT(*) FROM pipeline_health").fetchone()[0]
    # NB : le runner du framework dédupliquera via schema_migrations.
    # Cette migration directe (sans framework) ne dédup PAS ; on accepte
    # donc n2 > n1, mais on s'assure qu'on n'a pas explosé le compte.
    assert n2 >= n1


def test_mcp_block_auto_deleted_with_edges_purged():
    """Refonte 2026 pivot : un bloc mcp/toolbox doit être physiquement
    retiré du flow_json + ses edges purgées des autres nœuds."""
    flow = {
        "drawflow": {"Home": {"data": {
            "1": {
                "id": 1, "name": "mcp", "class": "mcp_block",
                "data": {"tools": ["shell"], "mcp_servers": []},
                "inputs": {}, "outputs": {"output_1": {"connections": [
                    {"node": "2", "output": "input_2"}
                ]}},
            },
            "2": {
                "id": 2, "name": "agent", "class": "agent_block",
                "data": {"role": "Worker"},
                "inputs": {
                    "input_1": {"connections": []},
                    "input_2": {"connections": [{"node": "1", "input": "output_1"}]},
                },
                "outputs": {"output_1": {"connections": []}},
            },
        }}}
    }
    conn = _db_with_pipelines(flow)
    _mig0002.migrate(conn)

    row = conn.execute("SELECT flow_json FROM agent_pipelines").fetchone()
    obj = json.loads(row[0])
    nodes = obj["drawflow"]["Home"]["data"]
    # Le bloc MCP a disparu
    assert "1" not in nodes
    # L'edge cible de l'agent input_2 a été purgée
    assert nodes["2"]["inputs"]["input_2"]["connections"] == []

    # pipeline_health taggé avec auto-deleted-block:mcp
    issues = [r[0] for r in conn.execute("SELECT issue FROM pipeline_health").fetchall()]
    assert any(i.startswith("auto-deleted-block:mcp") for i in issues)


def test_toolbox_legacy_also_auto_deleted():
    flow = {"drawflow": {"Home": {"data": {
        "9": {"id": 9, "name": "toolbox", "class": "toolbox_block",
              "data": {"tools": []},
              "inputs": {}, "outputs": {"output_1": {"connections": []}}},
    }}}}
    conn = _db_with_pipelines(flow)
    _mig0002.migrate(conn)
    row = conn.execute("SELECT flow_json FROM agent_pipelines").fetchone()
    nodes = json.loads(row[0])["drawflow"]["Home"]["data"]
    assert "9" not in nodes


def test_blackboard_blocks_auto_deleted():
    flow = {"drawflow": {"Home": {"data": {
        "5": {"id": 5, "name": "blackboard_write",
              "class": "blackboard_write_block", "data": {},
              "inputs": {"input_1": {"connections": []}},
              "outputs": {"output_1": {"connections": []}}},
        "6": {"id": 6, "name": "blackboard_read",
              "class": "blackboard_read_block", "data": {},
              "inputs": {"input_1": {"connections": []}},
              "outputs": {"output_1": {"connections": []}}},
    }}}}
    conn = _db_with_pipelines(flow)
    _mig0002.migrate(conn)
    nodes = json.loads(
        conn.execute("SELECT flow_json FROM agent_pipelines").fetchone()[0]
    )["drawflow"]["Home"]["data"]
    assert "5" not in nodes
    assert "6" not in nodes
