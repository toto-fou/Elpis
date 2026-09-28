# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_llama_http_tokens.py — couverture de
``count_tokens_for_messages`` (comptage tokens par message).

Vérifie le contrat (somme + overhead, None-propagation, skip non-dict,
multimodal) ET que la tokenisation des messages tourne CONCURREMMENT
(le test de concurrence échouerait/bloquerait avec l'ancienne version
série).

``count_tokens_exact`` (qui fait le vrai POST /tokenize) est monkeypatché
→ aucun réseau requis.
"""
from __future__ import annotations

import asyncio

import pytest

from llm_core import _llama_http


@pytest.fixture(autouse=True)
def _force_per_message_fallback(monkeypatch):
    """Ces tests valident le comptage PAR MESSAGE (= le fallback). On neutralise
    donc le chemin exact ``/apply-template`` (``count_rendered_prompt_tokens_exact``
    → None) pour l'exercer de façon déterministe et SANS réseau. Le chemin exact
    a sa propre couverture (``test_prompt_tokens_exact.py``)."""
    async def _none(*a, **k):
        return None
    monkeypatch.setattr(_llama_http, "count_rendered_prompt_tokens_exact", _none)


@pytest.fixture
def stub_tokenizer(monkeypatch):
    """Remplace count_tokens_exact par un stub déterministe (len(text))."""
    calls = []

    async def _fake(text, model_id=None, *, timeout=5.0, use_cache=True):
        calls.append(text)
        return len(text)

    monkeypatch.setattr(_llama_http, "count_tokens_exact", _fake)
    return calls


async def test_sums_per_message_plus_overhead(stub_tokenizer):
    msgs = [
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "hi"},
    ]
    total = await _llama_http.count_tokens_for_messages(msgs)
    assert total == (len("user\nhello") + 4) + (len("assistant\nhi") + 4)
    assert len(stub_tokenizer) == 2  # un appel par message


async def test_empty_messages_returns_zero():
    assert await _llama_http.count_tokens_for_messages([]) == 0


async def test_all_non_dict_returns_zero(stub_tokenizer):
    total = await _llama_http.count_tokens_for_messages(["nope", 42, None])
    assert total == 0
    assert len(stub_tokenizer) == 0


async def test_skips_non_dict_entries(stub_tokenizer):
    msgs = ["not a dict", {"role": "user", "content": "x"}]
    total = await _llama_http.count_tokens_for_messages(msgs)
    assert total == len("user\nx") + 4
    assert len(stub_tokenizer) == 1


async def test_none_propagation(monkeypatch):
    async def _fake(text, model_id=None, *, timeout=5.0, use_cache=True):
        return None if "boom" in text else len(text)

    monkeypatch.setattr(_llama_http, "count_tokens_exact", _fake)
    msgs = [{"role": "user", "content": "ok"}, {"role": "user", "content": "boom"}]
    assert await _llama_http.count_tokens_for_messages(msgs) is None


async def test_multimodal_concats_only_text_parts(stub_tokenizer):
    msgs = [{
        "role": "user",
        "content": [
            {"type": "text", "text": "abc"},
            {"type": "image_url", "image_url": {"url": "data:..."}},
            {"type": "text", "text": "de"},
        ],
    }]
    total = await _llama_http.count_tokens_for_messages(msgs)
    # Seuls les blocs texte sont sérialisés (l'image est exclue et son coût ajouté
    # à part). Le sérialiseur partagé context.tokens.message_text_for_tokenize place chaque part
    # sur sa propre ligne : parts = ["user", "abc", "de"] → "user\nabc\nde".
    assert total == len("user\nabc\nde") + 4


async def test_messages_are_tokenized_concurrently(monkeypatch):
    """Preuve de la concurrence : chaque stub bloque jusqu'à ce que les 3
    appels aient démarré. En série, le 1er resterait bloqué (les autres ne
    démarrant jamais) et la requête échouerait/timeout — donc ce test ne
    passe QUE si les appels sont lancés en parallèle (asyncio.gather)."""
    started = 0
    release = asyncio.Event()

    async def _fake(text, model_id=None, *, timeout=5.0, use_cache=True):
        nonlocal started
        started += 1
        if started >= 3:
            release.set()
        await asyncio.wait_for(release.wait(), timeout=2.0)
        return len(text)

    monkeypatch.setattr(_llama_http, "count_tokens_exact", _fake)
    msgs = [{"role": "user", "content": str(i)} for i in range(3)]
    total = await asyncio.wait_for(
        _llama_http.count_tokens_for_messages(msgs), timeout=3.0,
    )
    assert started == 3
    assert total == sum(len(f"user\n{i}") + 4 for i in range(3))


async def test_tool_calls_arguments_counted(stub_tokenizer):
    """NON-RÉGRESSION (porte de compression agentic) : un assistant qui
    n'émet QUE des tool_calls (content=None) doit peser le poids de ses
    arguments — pas ~0. Si cette garantie casse, le seuil tokens de la
    compression redevient aveugle sur les conversations agentic."""
    args = '{"path": "' + "x" * 200 + '"}'
    msgs = [{
        "role": "assistant", "content": None,
        "tool_calls": [{"id": "c1", "function": {"name": "write_file", "arguments": args}}],
    }]
    total = await _llama_http.count_tokens_for_messages(msgs)
    # stub = len(text) : role + nom d'outil + arguments concaténés.
    assert total >= len(args)
    assert any(args in t for t in stub_tokenizer)
