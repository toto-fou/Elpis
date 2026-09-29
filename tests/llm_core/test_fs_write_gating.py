# SPDX-License-Identifier: MIT
"""Step 4 gate: the cross-UID widening is active in host-write mode and
skipped when fs writes are agent-backed (single UID owns /work)."""

from llm_core.tools import fs_tools


def test_mode_ecrit_widens_in_host_mode(monkeypatch):
    # The host still reaches /work: what the agent writes stays writable by
    # the other UID (x bits of the replaced file kept).
    monkeypatch.setattr(fs_tools, "use_agent", lambda op: False)
    assert fs_tools._mode_ecrit({"kind": "missing"}) == "666"
    assert fs_tools._mode_ecrit({"kind": "file", "mode": 0o600}) == "666"
    assert fs_tools._mode_ecrit({"kind": "file", "mode": 0o755}) == "777"


def test_mode_ecrit_keeps_mode_in_agent_mode(monkeypatch):
    monkeypatch.setattr(fs_tools, "use_agent", lambda op: True)
    assert fs_tools._mode_ecrit({"kind": "missing"}) is None      # agent default
    assert fs_tools._mode_ecrit({"kind": "file", "mode": 0o600}) == "600"


def test_write_file_widened_in_host_mode(tmp_path, monkeypatch):
    """What write_file creates stays writable by the other UID while the host
    still reaches /work (explicit mode: independent of the agent's umask)."""
    base = tmp_path / "sandboxes"
    work = base / "guest" / "work"
    work.mkdir(parents=True)
    monkeypatch.setenv("APP_SANDBOX_DIR", str(base))
    monkeypatch.setattr(fs_tools, "use_agent", lambda op: False)

    class _MCP:
        tools: dict = {}

        def tool(self, **kw):
            def deco(fn):
                self.tools[fn.__name__] = fn
                return fn
            return deco
    mcp = _MCP()
    fs_tools.register(mcp, base)
    assert mcp.tools["write_file"](None, path="sub/x.txt", content="x")["ok"]
    assert (work / "sub" / "x.txt").stat().st_mode & 0o777 == 0o666


def test_executable_mode_cross_uid_in_host_mode(monkeypatch):
    # chmod action: a script the model makes executable must be runnable AND
    # editable by the OTHER UID (host/container share no group) → +x + o+rw.
    monkeypatch.setattr(fs_tools, "use_agent", lambda op: False)
    # +x for all + o+rw → fully cross-UID (rwxrwxrwx) regardless of prior mode.
    assert (fs_tools._executable_mode(0o644) & 0o777) == 0o777
    assert (fs_tools._executable_mode(0o600) & 0o777) == 0o777


def test_executable_mode_owner_only_in_agent_mode(monkeypatch):
    # Single-UID backend: owner +x is enough, no cross-UID widening.
    monkeypatch.setattr(fs_tools, "use_agent", lambda op: True)
    assert (fs_tools._executable_mode(0o644) & 0o777) == 0o744
    assert (fs_tools._executable_mode(0o600) & 0o777) == 0o700
