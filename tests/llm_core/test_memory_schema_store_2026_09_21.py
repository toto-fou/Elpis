# SPDX-License-Identifier: MIT
"""Audit 2026-09-21 (M3) — ``store`` est obligatoire dans le schéma de
``memory`` : facultatif avec défaut, la grammaire llama.cpp le rangeait après
les autres facultatifs et un fait de profil partait dans MEMORY.md."""
from __future__ import annotations

from fastmcp import FastMCP

from llm_core.tools import memory_tools


async def test_store_obligatoire(tmp_path):
    mcp = FastMCP("t")
    memory_tools.register(mcp, tmp_path)
    t = await mcp.list_tools()
    items = list(t.values()) if isinstance(t, dict) else list(t)
    tool = next(i for i in items if getattr(i, "name", "") == "memory")
    schema = tool.parameters
    assert set(schema.get("required") or []) >= {"action", "store"}
    assert schema["properties"]["store"].get("enum") == ["memory", "user"] \
        or "memory" in str(schema["properties"]["store"])
