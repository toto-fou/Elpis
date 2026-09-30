# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_mcp_iserror_middleware.py

Conformité MCP (compliance #1) : le middleware OkFalseAsIsError arme
``isError: true`` sur les erreurs métier ``{ok:false}`` produites par
``_toolkit.err()`` — TOUT en conservant l'enveloppe comme payload texte
(ce que lit pick_tool_payload côté app). Le chemin succès reste intact.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fastmcp import Client, FastMCP  # noqa: E402

from llm_core.tools._mcp_error_middleware import OkFalseAsIsError  # noqa: E402
from llm_core.tools._toolkit import err, ok  # noqa: E402


def _server() -> FastMCP:
    mcp = FastMCP("test-iserror")
    mcp.add_middleware(OkFalseAsIsError())

    @mcp.tool
    def succeed() -> dict:
        return ok(value=42)

    @mcp.tool
    def fail() -> dict:
        return err("bad_path", "path is outside the sandbox",
                   fix="pass a relative path", next_action="call list_files")

    @mcp.tool
    def fail_text() -> str:
        # Enveloppe renvoyée en TEXTE JSON (pas de structured_content) →
        # exerce le fallback de _error_envelope.
        return json.dumps(err("io_error", "disk full"))

    return mcp


async def test_business_error_sets_iserror_and_keeps_envelope():
    async with Client(_server()) as c:
        r = await c.call_tool("fail", {}, raise_on_error=False)
        assert r.is_error is True
        env = json.loads(r.content[0].text)
        assert env["ok"] is False
        assert env["error"] == "bad_path"
        assert env["message"] == "path is outside the sandbox"
        assert env["fix"] == "pass a relative path"        # enveloppe COMPLÈTE préservée
        assert env["next_action"] == "call list_files"


async def test_success_is_not_flagged():
    async with Client(_server()) as c:
        r = await c.call_tool("succeed", {}, raise_on_error=False)
        assert r.is_error is False
        assert (r.structured_content or {}).get("ok") is True
        assert (r.structured_content or {}).get("value") == 42


async def test_text_envelope_fallback_sets_iserror():
    async with Client(_server()) as c:
        r = await c.call_tool("fail_text", {}, raise_on_error=False)
        assert r.is_error is True
        env = json.loads(r.content[0].text)
        assert env["ok"] is False and env["error"] == "io_error"
