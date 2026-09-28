# SPDX-License-Identifier: MIT
"""Tests for the network-git backend decision + isolated-egress guard."""
from llm_core.tools import git_tools


def test_host_backend_is_default(monkeypatch, tmp_path):
    monkeypatch.setattr(git_tools, "use_agent", lambda op: False)
    seen = {}
    monkeypatch.setattr(git_tools, "_run_cmd",
                        lambda sb, cmd, **kw: (seen.update(cmd=cmd), {"ok": True})[1])
    r = git_tools._run_git_network(tmp_path, ["git", "fetch", "origin"], "alice")
    assert r["ok"] and seen["cmd"] == ["git", "fetch", "origin"]


def test_agent_isolated_profile_blocked(monkeypatch, tmp_path):
    monkeypatch.setattr(git_tools, "use_agent", lambda op: True)
    monkeypatch.setattr(git_tools, "_profile_has_no_egress", lambda pid: True)
    r = git_tools._run_git_network(tmp_path, ["git", "fetch", "origin"], "alice")
    assert r["ok"] is False and r["error"] == "network_isolated"


def test_agent_egress_routes_into_container(monkeypatch, tmp_path):
    import shared_infra.db as db
    monkeypatch.setattr(git_tools, "use_agent", lambda op: True)
    monkeypatch.setattr(git_tools, "_profile_has_no_egress", lambda pid: False)
    monkeypatch.setattr(git_tools, "_network_profile_id_for", lambda u: "web")
    monkeypatch.setattr("shared_infra.accounts.users.get_user", lambda u: {"id": 7}, raising=False)
    seen = {}
    monkeypatch.setattr(git_tools, "run_shell_via_executor",
                        lambda **kw: (seen.update(kw), {"ok": True, "returncode": 0})[1])
    r = git_tools._run_git_network(tmp_path, ["git", "clone", "https://x", "repo"], "alice")
    assert r["ok"]
    assert seen["tokens"] == ["git", "clone", "https://x", "repo"]
    assert seen["username"] == "alice" and seen["user_id"] == 7
