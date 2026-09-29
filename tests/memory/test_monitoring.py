# SPDX-License-Identifier: MIT
"""Audit log écrit par l'outil memory + structure des stats."""
from __future__ import annotations

import json
from pathlib import Path

import pytest


class FakeMCP:
    def __init__(self): self.tools = {}
    def tool(self, **kw):
        def deco(fn): self.tools[fn.__name__] = fn; return fn
        return deco
    def resource(self, *a, **kw): return lambda fn: fn
    def prompt(self, *a, **kw): return lambda fn: fn


class FakeCtx:
    def __init__(self, **meta):
        class _RC: pass
        rc = _RC(); rc.meta = meta
        self.request_context = rc
    async def info(self, *a, **k): pass
    async def debug(self, *a, **k): pass


@pytest.fixture
def memory_tool(tmp_path):
    from llm_core.tools import memory_tools
    m = FakeMCP()
    memory_tools.register(m, tmp_path)
    return m.tools["memory"], tmp_path


async def test_audit_log_appended_on_each_call(memory_tool):
    memory, root = memory_tool
    ctx = FakeCtx(username="alice", chat_id="c1")
    await memory(ctx, action="add", store="memory", content="fact one")
    await memory(ctx, action="add", store="memory", content="fact two")
    await memory(ctx, action="remove", store="memory", old_text="one")
    audit = root / "alice" / "memory" / ".audit.jsonl"
    assert audit.exists()
    lines = [json.loads(l) for l in audit.read_text().strip().splitlines()]
    assert len(lines) == 3
    assert [l["action"] for l in lines] == ["add", "add", "remove"]
    assert all(l["ok"] for l in lines)
    assert lines[-1]["n_entries"] == 1


async def test_audit_log_records_failure(memory_tool, monkeypatch):
    memory, root = memory_tool
    from llm_core.tools import memory_tools
    monkeypatch.setattr(memory_tools, "_memory_limits", lambda: (20, 20))
    ctx = FakeCtx(username="bob", chat_id="c1")
    await memory(ctx, action="add", store="memory", content="x" * 50)  # over limit
    audit = (root / "bob" / "memory" / ".audit.jsonl")
    line = json.loads(audit.read_text().strip().splitlines()[-1])
    assert line["ok"] is False
    assert line["error_code"] == "over_limit"
    assert "limit" in (line["error"] or "")


async def test_audit_log_records_rewrite(memory_tool):
    memory, root = memory_tool
    ctx = FakeCtx(username="rene", chat_id="c1")
    await memory(ctx, action="add", store="memory", content="ancien")
    await memory(ctx, action="rewrite", store="memory", content="nouveau\n---\nsecond")
    audit = root / "rene" / "memory" / ".audit.jsonl"
    lines = [json.loads(l) for l in audit.read_text().strip().splitlines()]
    assert lines[-1]["action"] == "rewrite" and lines[-1]["ok"]
    assert lines[-1]["error_code"] is None


async def test_audit_log_records_no_match_code(memory_tool):
    memory, root = memory_tool
    ctx = FakeCtx(username="nara", chat_id="c1")
    await memory(ctx, action="add", store="memory", content="fait present")
    await memory(ctx, action="remove", store="memory", target="totalement absent xyz")
    audit = root / "nara" / "memory" / ".audit.jsonl"
    line = json.loads(audit.read_text().strip().splitlines()[-1])
    assert line["ok"] is False and line["error_code"] == "no_match"
