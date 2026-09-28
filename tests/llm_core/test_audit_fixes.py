# SPDX-License-Identifier: MIT
"""Regression tests for the harness-audit fixes (2026-06).

Unit-level, fixture-free coverage of:
  #3  skills block gated on skills_enabled (assemble_system_messages)
  #6  git_action SSRF re-validation helper (_block_remote_ssrf)
  #8  edit_file emits the STABLE documented error codes
"""
from __future__ import annotations

import subprocess

import pytest


# ── #8 — edit_file stable error codes ──────────────────────────────────────
def test_edit_err_maps_stable_codes():
    from llm_core.tools import fs_tools as ft
    not_found = ft._edit_err(ValueError(
        "str_replace: old_str not found — check whitespace, indentation, line endings"))
    assert not_found["ok"] is False
    assert not_found["error"] == "old_str_not_found"

    ambiguous = ft._edit_err(ValueError(
        "str_replace: expected 1 occurrences, found 3 — expand old_str for uniqueness"))
    assert ambiguous["error"] == "old_str_ambiguous"

    regex0 = ft._edit_err(ValueError("regex: pattern matched 0 times — check pattern"))
    assert regex0["error"] == "old_str_not_found"

    # Unknown message → falls back to the slugified code (legacy behaviour).
    other = ft._edit_err(ValueError("some other failure"))
    assert other["error"] == "some_other_failure"

    # The multi-edit prefix is preserved in the message but doesn't change the code.
    pref = ft._edit_err(ValueError("str_replace: old_str not found"), prefix="edit 2 failed: ")
    assert pref["error"] == "old_str_not_found"
    assert "edit 2 failed:" in pref["message"]


# ── #3 — skills block gated on skills_enabled ──────────────────────────────
def test_assemble_gates_skills_block(monkeypatch):
    import llm_core._system_prompts as sp
    monkeypatch.setattr(sp, "_build_skills_block", lambda *a, **k: "## SKILLS_SENTINEL")

    on = sp.assemble_system_messages(custom_sys="base", last_user_text="x", skills_enabled=True)
    assert any("SKILLS_SENTINEL" in m["content"] for m in on)

    off = sp.assemble_system_messages(custom_sys="base", last_user_text="x", skills_enabled=False)
    assert all("SKILLS_SENTINEL" not in m["content"] for m in off)
    # custom_sys still emitted when skills are gated off (block != whole prompt).
    assert any("base" in m["content"] for m in off)

    # Default True preserves the pre-fix behaviour for every existing caller.
    dflt = sp.assemble_system_messages(custom_sys="base", last_user_text="x")
    assert any("SKILLS_SENTINEL" in m["content"] for m in dflt)


# ── #6 — git remote SSRF re-validation ─────────────────────────────────────
def _git_available() -> bool:
    try:
        subprocess.run(["git", "--version"], capture_output=True, check=True)
        return True
    except Exception:
        return False


@pytest.mark.skipif(not _git_available(), reason="git not installed")
def test_block_remote_ssrf_flags_internal(tmp_path):
    from llm_core.tools import git_tools as gt
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    # 169.254.x.x is link-local → blocked by _clone_url_block_reason WITHOUT DNS.
    subprocess.run(["git", "remote", "add", "origin",
                    "https://169.254.169.254/meta.git"], cwd=repo, check=True)
    reason = gt._block_remote_ssrf(repo)
    assert reason and "origin" in reason


@pytest.mark.skipif(not _git_available(), reason="git not installed")
def test_block_remote_ssrf_none_without_remote(tmp_path):
    from llm_core.tools import git_tools as gt
    repo = tmp_path / "repo2"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    assert gt._block_remote_ssrf(repo) is None
