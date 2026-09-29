# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_mcp_compliance_middleware.py

Conformité MCP — points #2 (rate-limit des invocations) et #3 (title d'affichage).
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fastmcp import Client, FastMCP  # noqa: E402

from llm_core.tools._mcp_compliance_middleware import (  # noqa: E402
    TitleFiller,
    ToolRateLimit,
    _titleize,
)


# ── #3 title ─────────────────────────────────────────────────────────
def test_titleize():
    assert _titleize("write_file") == "Write File"
    assert _titleize("todo_add_many") == "Todo Add Many"
    assert _titleize("git_commit") == "Git Commit"


async def test_titles_filled_for_all_tools():
    mcp = FastMCP("t")
    mcp.add_middleware(TitleFiller())

    @mcp.tool
    def write_file(path: str) -> dict:
        return {"ok": True}

    @mcp.tool(annotations={"title": "Déjà nommé"})
    def fancy() -> dict:
        return {"ok": True}

    async with Client(mcp) as c:
        tools = {t.name: t.title for t in await c.list_tools()}
    assert tools["write_file"] == "Write File"        # rempli
    assert tools["fancy"] == "Déjà nommé"             # title existant NON écrasé


# ── #2 rate limit ────────────────────────────────────────────────────
def _server(rps, burst):
    mcp = FastMCP("t")
    mcp.add_middleware(ToolRateLimit(rps=rps, burst=burst))

    @mcp.tool
    def ping() -> dict:
        return {"ok": True}

    return mcp


async def test_rate_limit_blocks_when_exceeded():
    # burst=1 + refill quasi nul → 1er appel OK, 2e bloqué.
    async with Client(_server(rps=0.0001, burst=1)) as c:
        r1 = await c.call_tool("ping", {}, raise_on_error=False)
        assert r1.is_error is False
        blocked = False
        try:
            r2 = await c.call_tool("ping", {}, raise_on_error=False)
            blocked = bool(getattr(r2, "is_error", False))
        except Exception:
            blocked = True  # erreur protocole MCP (RateLimitError) remontée
        assert blocked is True


async def test_rate_limit_disabled_when_rps_zero():
    async with Client(_server(rps=0, burst=1)) as c:
        for _ in range(5):
            r = await c.call_tool("ping", {}, raise_on_error=False)
            assert r.is_error is False
