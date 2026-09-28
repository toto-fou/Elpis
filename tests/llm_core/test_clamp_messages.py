# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_clamp_messages.py — couverture de ``_clamp_messages``.

Le fix garantit que TOUS les messages ``system`` survivent à la troncature,
y compris un system inséré EN MILIEU de conversation (résumé de compression,
AX memory) — qui était supprimé par l'ancienne implémentation.
"""
from __future__ import annotations

from llm_core._chat_classic import _clamp_messages


def test_under_limit_returned_unchanged():
    msgs = [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"}]
    assert _clamp_messages(msgs, 100) == msgs


def test_empty():
    assert _clamp_messages([], 10) == []


def test_leading_system_preserved_and_recent_kept():
    msgs = [{"role": "system", "content": "sys"}]
    for i in range(20):
        msgs.append({"role": "user", "content": f"u{i}"})
    out = _clamp_messages(msgs, 5)
    assert len(out) == 5
    assert out[0] == {"role": "system", "content": "sys"}
    # Les 4 derniers user doivent être conservés (les plus récents).
    assert out[-1] == {"role": "user", "content": "u19"}
    assert out[1] == {"role": "user", "content": "u16"}


def test_midlist_system_summary_is_preserved():
    """Cas régressif : un system (résumé de compression) au MILIEU ne doit
    PAS être supprimé par la troncature."""
    msgs = [{"role": "system", "content": "base prompt"}]
    for i in range(10):
        msgs.append({"role": "user", "content": f"old{i}"})
    # Résumé de compression inséré en milieu de liste.
    summary = {"role": "system", "content": "[COMPRESSED_SUMMARY_V1] faits clés"}
    msgs.append(summary)
    for i in range(10):
        msgs.append({"role": "user", "content": f"new{i}"})

    out = _clamp_messages(msgs, 6)
    assert len(out) == 6
    # Les DEUX system doivent être présents.
    assert {"role": "system", "content": "base prompt"} in out
    assert summary in out
    # Et le tour le plus récent aussi.
    assert {"role": "user", "content": "new9"} in out


def test_chronological_order_preserved():
    msgs = [
        {"role": "system", "content": "s0"},
        {"role": "user", "content": "u0"},
        {"role": "system", "content": "s1"},
        {"role": "user", "content": "u1"},
        {"role": "user", "content": "u2"},
    ]
    out = _clamp_messages(msgs, 4)
    # s0, s1 gardés + 2 derniers user (u1,u2) ; ordre d'origine respecté.
    assert out == [
        {"role": "system", "content": "s0"},
        {"role": "system", "content": "s1"},
        {"role": "user", "content": "u1"},
        {"role": "user", "content": "u2"},
    ]


def test_all_system_exceeding_budget_keeps_recent_system():
    msgs = [{"role": "system", "content": f"s{i}"} for i in range(8)]
    out = _clamp_messages(msgs, 3)
    assert len(out) == 3
    # Les 3 plus récents system.
    assert out == [
        {"role": "system", "content": "s5"},
        {"role": "system", "content": "s6"},
        {"role": "system", "content": "s7"},
    ]


def test_no_system_keeps_recent_tail():
    msgs = [{"role": "user", "content": f"u{i}"} for i in range(10)]
    out = _clamp_messages(msgs, 3)
    assert out == [
        {"role": "user", "content": "u7"},
        {"role": "user", "content": "u8"},
        {"role": "user", "content": "u9"},
    ]
