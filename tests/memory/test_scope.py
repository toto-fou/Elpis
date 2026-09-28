# SPDX-License-Identifier: MIT
"""Tests de résolution des scopes + provider builtin (snapshot figé)."""
from __future__ import annotations

from pathlib import Path

from llm_core.memory import resolve_paths, store_for, MarkdownMemoryProvider
from llm_core.memory._scope import safe_username, scope_hash


def test_chat_scope_uses_root_files(tmp_path):
    mem, usr = resolve_paths("alice", "user", tmp_path)
    assert mem == tmp_path / "alice" / "memory" / "MEMORY.md"
    assert usr == tmp_path / "alice" / "memory" / "USER.md"


def test_empty_scope_is_root(tmp_path):
    mem, usr = resolve_paths("bob", "", tmp_path)
    assert mem.name == "MEMORY.md"
    assert "scopes" not in str(mem)


def test_agentic_scope_nested_under_hash(tmp_path):
    sk = "pipeline:42:node:7"
    mem, usr = resolve_paths("carol", sk, tmp_path)
    assert mem == tmp_path / "carol" / "memory" / "scopes" / scope_hash(sk) / "MEMORY.md"
    # USER.md reste per-user (racine), partagé entre scopes
    assert usr == tmp_path / "carol" / "memory" / "USER.md"


def test_user_md_shared_across_scopes(tmp_path):
    _, usr_chat = resolve_paths("dan", "user", tmp_path)
    _, usr_agent = resolve_paths("dan", "team:5:role:reviewer", tmp_path)
    assert usr_chat == usr_agent


def test_safe_username():
    assert safe_username("Jean.Dupont") == "JeanDupont"
    assert safe_username("") == "guest"
    assert safe_username(None) == "guest"


def test_store_for_kinds(tmp_path):
    s_mem = store_for("memory", "eve", "user", tmp_path, memory_limit=2200, user_limit=1375)
    s_usr = store_for("user", "eve", "user", tmp_path, memory_limit=2200, user_limit=1375)
    assert s_mem.char_limit == 2200 and s_mem.label == "MEMORY.md"
    assert s_usr.char_limit == 1375 and s_usr.label == "USER.md"


def test_builtin_provider_frozen_snapshot(tmp_path):
    prov = MarkdownMemoryProvider("frank", "user", tmp_path, memory_limit=2200, user_limit=1375)
    store_for("memory", "frank", "user", tmp_path).add("initial fact")
    prov.initialize(session_id="sess1")
    snap1 = prov.system_prompt_block()
    assert "initial fact" in snap1
    # Écriture en cours de session : le snapshot figé NE change PAS
    store_for("memory", "frank", "user", tmp_path).add("added mid-session")
    snap2 = prov.system_prompt_block()
    assert snap2 == snap1
    assert "added mid-session" not in snap2
    # Une nouvelle session (re-init) voit la mise à jour
    prov.initialize(session_id="sess2")
    assert "added mid-session" in prov.system_prompt_block()
