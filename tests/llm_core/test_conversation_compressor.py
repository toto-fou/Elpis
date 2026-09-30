# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_conversation_compressor.py — couverture des primitives
PURES du compresseur conversationnel (aucun LLM / réseau requis).

Cible :
- ``_count_turns``                  : comptage tours classic / agentic / mixte.
- ``_split_by_turn_index``          : zones system / to_compress / bridge / recent.
- ``_serialize_for_compression``    : sérialisation dense + résolution du NOM
                                      d'outil via ``tool_call_id`` (bug fix).
- ``_extract_previous_summary`` /
  ``_format_summary_as_system_message`` : round-trip des marqueurs.
- ``ConversationCompressor.min_matter_turns`` : matière minimale (M3 — le
  déclenchement est la règle unique d'overflow, côté caller).
"""
from __future__ import annotations

from llm_core.conversation_compressor import (
    ConversationCompressor,
    _count_turns,
    _extract_previous_summary,
    _format_summary_as_system_message,
    _serialize_for_compression,
    _split_by_turn_index,
)

# ──────────────────────────────────────────────────────────────────────────
# _count_turns
# ──────────────────────────────────────────────────────────────────────────

def test_count_turns_classic_exchange():
    msgs = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "q1"},
        {"role": "assistant", "content": "a1"},
        {"role": "user", "content": "q2"},
        {"role": "assistant", "content": "a2"},
    ]
    # 2 user + 2 assistant-pur = 4 tours (system ignoré)
    assert _count_turns(msgs) == 4


def test_count_turns_agentic_tool_calls():
    msgs = [
        {"role": "user", "content": "do it"},
        {"role": "assistant", "tool_calls": [{"id": "c1", "function": {"name": "read_file"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "data"},
        {"role": "assistant", "content": "final answer"},
    ]
    # user(1) + assistant-tool(1) + tool(0) + assistant-final-après-tool(0) = 2
    assert _count_turns(msgs) == 2


def test_count_turns_final_assistant_after_tool_not_double_counted():
    # Réponse finale (assistant pur) juste après un tool result ne compte pas.
    msgs = [
        {"role": "user", "content": "q"},
        {"role": "assistant", "tool_calls": [{"id": "c1", "function": {"name": "t"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "r"},
        {"role": "assistant", "content": "done"},
    ]
    assert _count_turns(msgs) == 2


# ──────────────────────────────────────────────────────────────────────────
# _serialize_for_compression — résolution du nom d'outil (bug fix)
# ──────────────────────────────────────────────────────────────────────────

def test_serialize_resolves_tool_name_from_tool_call_id():
    """Un message role=tool n'a que ``tool_call_id`` (pas ``name``). Le nom
    DOIT être résolu depuis le tool_calls de l'assistant qui l'a appelé."""
    msgs = [
        {"role": "user", "content": "lis le fichier"},
        {"role": "assistant", "tool_calls": [
            {"id": "call_42", "function": {"name": "read_file", "arguments": '{"path":"a.py"}'}},
        ]},
        {"role": "tool", "tool_call_id": "call_42", "content": "contenu du fichier"},
    ]
    out = _serialize_for_compression(msgs)
    assert "[TOOL:read_file]" in out, out
    # Le bug d'origine produisait "[TOOL:tool]" — il ne doit plus apparaître.
    assert "[TOOL:tool]" not in out
    # Le tool_call assistant est aussi sérialisé compactement.
    assert "[ASSISTANT→TOOL] read_file(" in out


def test_serialize_tool_name_falls_back_when_unresolvable():
    """Pas de tool_call_id appariable → fallback générique 'tool'."""
    msgs = [
        {"role": "tool", "tool_call_id": "orphan", "content": "r"},
    ]
    out = _serialize_for_compression(msgs)
    assert "[TOOL:tool]" in out


def test_serialize_explicit_name_takes_priority():
    msgs = [
        {"role": "tool", "name": "explicit_name", "tool_call_id": "x", "content": "r"},
    ]
    out = _serialize_for_compression(msgs)
    assert "[TOOL:explicit_name]" in out


def test_serialize_truncates_huge_content():
    big = "x" * 5000
    out = _serialize_for_compression([{"role": "user", "content": big}], max_chars_per_msg=2000)
    assert "[tronqué" in out
    assert len(out) < 2600


def test_serialize_multiple_tools_keep_distinct_names():
    msgs = [
        {"role": "assistant", "tool_calls": [
            {"id": "a", "function": {"name": "grep", "arguments": "{}"}},
            {"id": "b", "function": {"name": "list_files", "arguments": "{}"}},
        ]},
        {"role": "tool", "tool_call_id": "b", "content": "files"},
        {"role": "tool", "tool_call_id": "a", "content": "matches"},
    ]
    out = _serialize_for_compression(msgs)
    assert "[TOOL:list_files] files" in out
    assert "[TOOL:grep] matches" in out


# ──────────────────────────────────────────────────────────────────────────
# _split_by_turn_index
# ──────────────────────────────────────────────────────────────────────────

def test_split_too_few_turns_compresses_nothing():
    msgs = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "q"},
        {"role": "assistant", "content": "a"},
    ]
    system, to_compress, bridge, recent = _split_by_turn_index(
        msgs, keep_recent_turns=6, keep_bridge_turns=3,
    )
    assert system == [{"role": "system", "content": "sys"}]
    assert to_compress == []
    assert bridge == []
    # Tout le non-system reste en "recent"
    assert len(recent) == 2


def test_split_zones_partition_all_non_system_messages():
    # 12 tours user/assistant alternés
    msgs = [{"role": "system", "content": "s"}]
    for i in range(12):
        msgs.append({"role": "user", "content": f"q{i}"})
        msgs.append({"role": "assistant", "content": f"a{i}"})
    system, to_compress, bridge, recent = _split_by_turn_index(
        msgs, keep_recent_turns=4, keep_bridge_turns=2,
    )
    non_system = [m for m in msgs if m["role"] != "system"]
    # Les 4 zones doivent partitionner exactement les messages non-system.
    assert to_compress + bridge + recent == non_system
    assert len(system) == 1
    assert recent, "recent ne doit pas être vide"
    assert to_compress, "il doit rester des tours à compresser"


# ──────────────────────────────────────────────────────────────────────────
# Round-trip marqueurs de résumé
# ──────────────────────────────────────────────────────────────────────────

def test_summary_marker_round_trip():
    summary = "<context>tâche X</context>\n<state>en cours</state>"
    msg = _format_summary_as_system_message(summary, turns_compressed=7)
    assert msg["role"] == "system"
    extracted = _extract_previous_summary([msg])
    assert extracted == summary


def test_extract_previous_summary_none_when_absent():
    msgs = [{"role": "system", "content": "plain prompt"}, {"role": "user", "content": "hi"}]
    assert _extract_previous_summary(msgs) is None


# ──────────────────────────────────────────────────────────────────────────
# Matière minimale (harnais v4, M3 — les règles en tours sont supprimées :
# le déclenchement appartient à la règle unique d'overflow du caller)
# ──────────────────────────────────────────────────────────────────────────

def _compressor():
    async def _noop(*a, **k):  # pragma: no cover - jamais appelé en sync
        return "", {}
    return ConversationCompressor(
        _noop, keep_recent_turns=6, keep_bridge_turns=3,
    )


def test_min_matter_turns_geometrie_des_zones():
    c = _compressor()
    assert c.min_matter_turns() == 6 + 3 + 2, \
        "matière minimale = zones conservées + 2 tours à résumer"
    c2 = ConversationCompressor(c.llama_chat, keep_recent_turns=2,
                                keep_bridge_turns=1)
    assert c2.min_matter_turns() == 5
