# SPDX-License-Identifier: MIT
"""Step 4 gate: the cross-UID chmod widening is active in host-write mode
and skipped when fs writes are agent-backed (single UID owns /work)."""
import os

from llm_core.tools import fs_tools


def test_chmod_widens_in_host_mode(monkeypatch, tmp_path):
    monkeypatch.setattr(fs_tools, "use_agent", lambda op: False)
    f = tmp_path / "a.txt"
    f.write_text("x")
    os.chmod(f, 0o600)
    fs_tools._chmod_cross_writable(tmp_path, f)
    assert (f.stat().st_mode & 0o777) == 0o666


def test_chmod_skipped_in_agent_mode(monkeypatch, tmp_path):
    monkeypatch.setattr(fs_tools, "use_agent", lambda op: True)
    f = tmp_path / "a.txt"
    f.write_text("x")
    os.chmod(f, 0o600)
    fs_tools._chmod_cross_writable(tmp_path, f)
    assert (f.stat().st_mode & 0o777) == 0o600  # untouched


def test_parents_created_widened_in_host_mode(monkeypatch, tmp_path):
    monkeypatch.setattr(fs_tools, "use_agent", lambda op: False)
    target = tmp_path / "sub" / "x.txt"
    fs_tools._atomic_write_bytes(target, b"x", tmp_path)
    assert (target.parent.stat().st_mode & 0o777) == 0o777
    assert (target.stat().st_mode & 0o777) == 0o666


def test_parents_not_widened_in_agent_mode(monkeypatch, tmp_path):
    monkeypatch.setattr(fs_tools, "use_agent", lambda op: True)
    target = tmp_path / "sub2" / "x.txt"
    fs_tools._atomic_write_bytes(target, b"x", tmp_path)
    assert target.read_bytes() == b"x"
    assert (target.parent.stat().st_mode & 0o777) != 0o777  # not force-widened


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
