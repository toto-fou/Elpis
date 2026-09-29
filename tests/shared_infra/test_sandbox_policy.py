# SPDX-License-Identifier: MIT
"""Tests for the OP_BACKEND policy table (the migration lever)."""
import pytest

from shared_infra.sandbox.policy import Backend, all_ops, backend_for, use_agent


def test_defaults_are_status_quo_host():
    # Shipping default: every known op is HOST (provable no-op when wired).
    for op, backend in all_ops().items():
        assert backend is Backend.HOST, op


def test_unknown_op_fails_safe_to_host():
    assert backend_for("does.not.exist") is Backend.HOST
    assert use_agent("does.not.exist") is False


def test_env_override_to_agent(monkeypatch):
    monkeypatch.setenv("SANDBOX_GATEWAY_FS_WRITE", "agent")
    assert backend_for("fs.write") is Backend.AGENT
    assert use_agent("fs.write") is True
    # other ops untouched
    assert backend_for("fs.read") is Backend.HOST


def test_env_override_back_to_host(monkeypatch):
    monkeypatch.setenv("SANDBOX_GATEWAY_EXEC_SHELL", "host")
    assert backend_for("exec.shell") is Backend.HOST


def test_invalid_env_value_ignored(monkeypatch):
    monkeypatch.setenv("SANDBOX_GATEWAY_FS_READ", "banana")
    assert backend_for("fs.read") is Backend.HOST


def test_all_ops_reflects_override(monkeypatch):
    monkeypatch.setenv("SANDBOX_GATEWAY_GIT_NETWORK", "agent")
    table = all_ops()
    assert table["git.network"] is Backend.AGENT
