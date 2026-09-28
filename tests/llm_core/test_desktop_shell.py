# SPDX-License-Identifier: MIT
"""tests/llm_core/test_desktop_shell.py — ``run_command_core`` + outil desktop_shell.

Le control-agent (``_agent_req``) et la cible (``_resolve_target``) sont
monkeypatchés → aucun réseau, aucune VM. On vérifie que la commande/timeout sont
transmis, que le résultat suit le CONTRAT execute_shell (ok = returncode==0,
executor, stdout/stderr en dernier), et le gating de registration par
``DESKTOP_DISABLE_SHELL``.
"""
from __future__ import annotations

import pytest

from llm_core.tools import desktop_tools as dt

FAKE_TGT = {"name": "t1", "agent_url": "http://agent", "os": "windows"}


class _FakeMCP:
    def __init__(self):
        self.tools = {}

    def tool(self, *dargs, **dkw):
        name = dkw.get("name")

        def deco(fn):
            self.tools[name or fn.__name__] = fn
            return fn
        return deco


@pytest.fixture
def agent(monkeypatch):
    """Capture l'appel agent ; renvoie une réponse /run_command déterministe."""
    seen = []

    def fake_agent_req(tgt, endpoint, payload=None, method="POST", timeout=None):
        seen.append({"endpoint": endpoint, "payload": payload, "timeout": timeout})
        return {"ok": True, "cursor": None, "returncode": 0,
                "stdout": "hello", "stderr": "", "truncated": False,
                "duration_ms": 7, "shell": (payload or {}).get("shell") or "powershell"}

    monkeypatch.setattr(dt, "_resolve_target",
                        lambda target, username="": (FAKE_TGT if target in ("", "t1") else None))
    monkeypatch.setattr(dt, "_agent_req", fake_agent_req)
    return seen


def test_run_command_core_maps_result(agent):
    r = dt.run_command_core("u", "t1", command="Get-Date", shell="powershell")
    assert r["ok"] is True
    assert r["returncode"] == 0
    assert r["cmd"] == "Get-Date"
    assert r["stdout"] == "hello"
    assert r["executor"] == "desktop.t1.powershell"
    # métadonnées AVANT stdout/stderr (survivent au cap d'émission)
    keys = list(r.keys())
    assert keys.index("returncode") < keys.index("stdout")


def test_run_command_core_forwards_command_and_timeout(agent):
    dt.run_command_core("u", "t1", command="ls", shell="bash", cwd="/tmp",
                        timeout_sec=120, max_output=5000)
    call = agent[0]
    assert call["endpoint"] == "/run_command"
    assert call["payload"]["command"] == "ls"
    assert call["payload"]["shell"] == "bash"
    assert call["payload"]["cwd"] == "/tmp"
    assert call["payload"]["timeout_ms"] == 120000
    assert call["payload"]["max_output"] == 5000
    # timeout client = durée + marge (30s)
    assert call["timeout"] == 150


def test_run_command_core_clamps_timeout(agent):
    dt.run_command_core("u", "t1", command="x", timeout_sec=99999)
    assert agent[0]["payload"]["timeout_ms"] == 600000       # clampé à 600s
    assert agent[0]["timeout"] == 630


def test_run_command_core_nonzero_is_not_error(monkeypatch):
    monkeypatch.setattr(dt, "_resolve_target", lambda target, username="": FAKE_TGT)
    monkeypatch.setattr(dt, "_agent_req",
                        lambda *a, **k: {"returncode": 2, "stdout": "", "stderr": "boom",
                                         "truncated": False, "duration_ms": 3, "shell": "cmd"})
    r = dt.run_command_core("u", "t1", command="exit 2", shell="cmd")
    assert r["ok"] is False           # ok = (returncode == 0)
    assert r["returncode"] == 2
    assert r.get("error") is None     # PAS une enveloppe d'erreur
    assert r["stderr"] == "boom"


def test_run_command_core_timeout_result(monkeypatch):
    monkeypatch.setattr(dt, "_resolve_target", lambda target, username="": FAKE_TGT)
    monkeypatch.setattr(dt, "_agent_req",
                        lambda *a, **k: {"returncode": 124, "timed_out": True,
                                         "stdout": "", "stderr": "", "truncated": False,
                                         "duration_ms": 1000, "shell": "powershell"})
    r = dt.run_command_core("u", "t1", command="Start-Sleep 999", timeout_sec=1)
    assert r["ok"] is False
    assert r["error"] == "timeout"
    assert r["returncode"] == 124
    assert "timeout_sec" in r["hint"]


def test_run_command_core_empty_command(agent):
    r = dt.run_command_core("u", "t1", command="   ")
    assert r.get("error") == "need_command"
    assert not agent   # aucun appel agent


def test_run_command_core_no_target(monkeypatch):
    monkeypatch.setattr(dt, "_resolve_target", lambda target, username="": None)
    r = dt.run_command_core("u", "t1", command="x")
    assert r.get("error") == "no_target"


# ── gating de registration ───────────────────────────────────────────────────
def test_tool_registered_by_default(monkeypatch):
    monkeypatch.setattr(dt._cfg, "DESKTOP_DISABLE_SHELL", False, raising=False)
    mcp = _FakeMCP()
    dt.register(mcp)
    assert "desktop_shell" in mcp.tools


def test_tool_hidden_when_disabled(monkeypatch):
    monkeypatch.setattr(dt._cfg, "DESKTOP_DISABLE_SHELL", True, raising=False)
    mcp = _FakeMCP()
    dt.register(mcp)
    assert "desktop_shell" not in mcp.tools
