# SPDX-License-Identifier: MIT
"""Le bloc mémoire (snapshot) est injecté à sa place dans le system prompt
unifié.

Depuis le refactor prefix-cache-friendly, ``assemble_system_messages`` retourne
**un seul** message ``{"role": "system"}`` qui concatène les blocs (custom →
protocols → memory → skills) avec ``\\n\\n---\\n\\n`` comme séparateur. La
position relative reste : custom au début, memory après protocols, skills à
la fin (cf. _system_prompts.assemble_system_messages docstring).
"""
from __future__ import annotations

from llm_core._system_prompts import assemble_system_messages


def test_memory_block_appended_after_custom():
    msgs = assemble_system_messages(
        custom_sys="you are helpful",
        active_mcp_servers=None,
        last_user_text=None,        # opt-out skills → isolation
        memory_block="# Memory (snapshot)\n\n## USER.md\nalice likes rust",
    )
    # Un seul system message désormais (prefix-cache friendly).
    assert len(msgs) == 1
    content = msgs[0]["content"]
    # Custom prompt en tête, memory plus loin dans le même bloc.
    assert content.startswith("you are helpful")
    assert "# Memory (snapshot)" in content
    assert "alice likes rust" in content
    # Memory vient bien APRÈS le custom prompt, séparé par ``---``.
    assert content.index("you are helpful") < content.index("# Memory (snapshot)")


def test_no_memory_block_no_extra_content():
    base = assemble_system_messages("sys", None, last_user_text=None)
    with_empty = assemble_system_messages("sys", None, last_user_text=None, memory_block="")
    assert base == with_empty
    assert all("snapshot" not in m["content"].lower() for m in with_empty)


def test_memory_block_whitespace_only_skipped():
    msgs = assemble_system_messages("sys", None, last_user_text=None, memory_block="   \n  ")
    assert len(msgs) == 1 and msgs[0]["content"] == "sys"
