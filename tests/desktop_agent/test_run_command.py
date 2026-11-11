# SPDX-License-Identifier: MIT
"""tests/desktop_agent/test_run_command.py — exécution de commande de l'agent.

Teste ``run_command`` de bout en bout sur le backend LINUX (le poste de dev en
a un, contrairement à Windows/UIA). Couvre : contrat de base (NotSupported par
défaut), stdout/exit-code, troncature tail-keep, timeout→124, décodage UTF-8, et
le kill-switch ``DESKTOP_DISABLE_SHELL``. Le chemin PowerShell/-EncodedCommand du
backend Windows se valide sur la VM.

L'agent vit dans ``desktop-agent/`` (hors package repo) : ajouté au sys.path le
temps des imports puis retiré (sinon son ``server.py`` masque le package repo).
"""
from __future__ import annotations

import os
import sys

import pytest

_AGENT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "desktop-agent"))


def _load():
    saved = list(sys.path)
    sys.path.insert(0, _AGENT)
    try:
        from backends.base import DesktopBackend, NotSupported, tail_truncate
        from backends.linux import LinuxBackend
        return DesktopBackend, NotSupported, LinuxBackend, tail_truncate
    finally:
        sys.path[:] = saved


DesktopBackend, NotSupported, LinuxBackend, tail_truncate = _load()


# ── contrat de base ──────────────────────────────────────────────────────────
def test_base_run_command_not_supported():
    with pytest.raises(NotSupported):
        DesktopBackend().run_command(command="echo hi")


def test_tail_truncate_keeps_end():
    txt = "".join(str(i % 10) for i in range(100))
    out, tr = tail_truncate(txt, 10)
    assert tr is True
    assert out.endswith(txt[-10:])
    assert "TRUNCATED" in out and "showing the tail" in out
    # sous le seuil → intact
    assert tail_truncate("short", 100) == ("short", False)


# ── backend Linux (dev host) ─────────────────────────────────────────────────
def test_linux_run_command_stdout_and_rc():
    b = LinuxBackend()
    r = b.run_command(command="printf hello", shell="bash")
    assert r["returncode"] == 0
    assert r["stdout"] == "hello"
    assert r["truncated"] is False
    assert r["shell"] == "bash"
    assert r["duration_ms"] >= 0


def test_linux_run_command_nonzero_exit():
    b = LinuxBackend()
    r = b.run_command(command="echo oops >&2; exit 7", shell="bash")
    assert r["returncode"] == 7
    assert "oops" in r["stderr"]


def test_linux_run_command_truncates_tail():
    b = LinuxBackend()
    # 5000 'x' mais max_output=100 → tronqué en gardant la queue.
    r = b.run_command(command="printf 'x%.0s' $(seq 1 5000)", shell="bash",
                      max_output=100)
    assert r["truncated"] is True
    assert "TRUNCATED" in r["stdout"]
    assert r["stdout"].endswith("x" * 100)


def test_linux_run_command_timeout_returns_124():
    b = LinuxBackend()
    r = b.run_command(command="sleep 5", shell="bash", timeout_ms=300)
    assert r["returncode"] == 124
    assert r["timed_out"] is True


def test_linux_run_command_utf8_decode():
    b = LinuxBackend()
    r = b.run_command(command="printf 'café ☕'", shell="bash")
    assert r["stdout"] == "café ☕"


def test_linux_run_command_empty_rejected():
    b = LinuxBackend()
    with pytest.raises(NotSupported):
        b.run_command(command="   ", shell="bash")


def test_linux_run_command_unknown_shell():
    b = LinuxBackend()
    with pytest.raises(NotSupported):
        b.run_command(command="echo hi", shell="fish")


def test_kill_switch_blocks_execution(monkeypatch):
    monkeypatch.setenv("DESKTOP_DISABLE_SHELL", "1")
    b = LinuxBackend()
    with pytest.raises(NotSupported):
        b.run_command(command="echo hi", shell="bash")
