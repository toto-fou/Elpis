# SPDX-License-Identifier: MIT
"""
tests/shared_infra/test_last_user_text.py — couverture de
``last_user_text`` (extraction du dernier message user, multimodal-safe).

Le fix garantit qu'un message user au content MULTIMODAL (liste de blocs
texte+image) rend son texte — avant, la route ne lisait que les ``str`` et
laissait le texte vide (skills non matchés, mémoire indexant un tour vide).
"""
from __future__ import annotations

from shared_infra.routes._helpers import last_user_text


def test_plain_string_user():
    msgs = [
        {"role": "user", "content": "première question"},
        {"role": "assistant", "content": "réponse"},
        {"role": "user", "content": "dernière question"},
    ]
    assert last_user_text(msgs) == "dernière question"


def test_multimodal_user_content():
    """Cas régressif : content liste texte+image."""
    msgs = [{
        "role": "user",
        "content": [
            {"type": "text", "text": "décris cette image"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,xxx"}},
        ],
    }]
    assert last_user_text(msgs) == "décris cette image"


def test_returns_last_not_first():
    msgs = [
        {"role": "user", "content": "vieux"},
        {"role": "assistant", "content": "a"},
        {"role": "user", "content": [{"type": "text", "text": "récent"}]},
    ]
    assert last_user_text(msgs) == "récent"


def test_no_user_returns_empty():
    msgs = [{"role": "system", "content": "s"}, {"role": "assistant", "content": "a"}]
    assert last_user_text(msgs) == ""


def test_empty_and_non_list():
    assert last_user_text([]) == ""
    assert last_user_text(None) == ""  # type: ignore[arg-type]


def test_strips_whitespace():
    assert last_user_text([{"role": "user", "content": "  spaced  "}]) == "spaced"


def test_skips_trailing_assistant():
    msgs = [
        {"role": "user", "content": "la vraie question"},
        {"role": "assistant", "content": "réponse en cours"},
    ]
    assert last_user_text(msgs) == "la vraie question"
