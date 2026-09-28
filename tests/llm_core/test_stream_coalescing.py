# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_stream_coalescing.py — coalescing NDJSON du stream chat
(perf vague 4).

Cible : ``chatbot_app.routes.chats._drain_coalesced`` — agrégation des
content_token / thinking_token consécutifs DÉJÀ en file, sans latence
ajoutée, ordre du flux strictement préservé, sentinelle None respectée
même tirée par get_nowait pendant l'agrégation.
"""
from __future__ import annotations

import asyncio

import pytest

from chatbot_app.routes.chats import _drain_coalesced


async def _collect(events):
    q = asyncio.Queue()
    for ev in events:
        q.put_nowait(ev)
    q.put_nowait(None)
    return [ev async for ev in _drain_coalesced(q)]


@pytest.mark.asyncio
async def test_consecutive_tokens_coalesced_with_count():
    out = await _collect([
        {"type": "content_token", "text": "Bon"},
        {"type": "content_token", "text": "jour"},
        {"type": "content_token", "text": " !"},
    ])
    assert out == [{"type": "content_token", "text": "Bonjour !", "n": 3}]


@pytest.mark.asyncio
async def test_single_token_unchanged_no_n_field():
    out = await _collect([{"type": "content_token", "text": "x"}])
    # Pas de champ ``n`` sur un token isolé : format identique à l'existant.
    assert out == [{"type": "content_token", "text": "x"}]


@pytest.mark.asyncio
async def test_other_event_breaks_aggregate_and_order_preserved():
    out = await _collect([
        {"type": "content_token", "text": "a"},
        {"type": "content_token", "text": "b"},
        {"type": "tool_call", "name": "read_file"},
        {"type": "content_token", "text": "c"},
    ])
    assert out == [
        {"type": "content_token", "text": "ab", "n": 2},
        {"type": "tool_call", "name": "read_file"},
        {"type": "content_token", "text": "c"},
    ]


@pytest.mark.asyncio
async def test_thinking_and_content_not_mixed():
    out = await _collect([
        {"type": "thinking_token", "text": "hm"},
        {"type": "thinking_token", "text": "..."},
        {"type": "content_token", "text": "ok"},
    ])
    assert out == [
        {"type": "thinking_token", "text": "hm...", "n": 2},
        {"type": "content_token", "text": "ok"},
    ]


@pytest.mark.asyncio
async def test_sentinel_pulled_during_aggregation_terminates():
    # La sentinelle None est tirée par get_nowait au milieu d'un agrégat :
    # l'agrégat est émis puis le générateur s'arrête (pas de deadlock).
    out = await _collect([
        {"type": "content_token", "text": "fin"},
        {"type": "content_token", "text": "."},
    ])
    assert out[-1]["text"] == "fin."


@pytest.mark.asyncio
async def test_first_token_not_delayed():
    # Le premier événement est émis dès qu'il est disponible : le drain ne
    # bloque pas en attente d'un éventuel token suivant.
    q = asyncio.Queue()
    q.put_nowait({"type": "content_token", "text": "premier"})
    gen = _drain_coalesced(q)
    ev = await asyncio.wait_for(gen.__anext__(), timeout=0.5)
    assert ev["text"] == "premier"
    q.put_nowait(None)
    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(gen.__anext__(), timeout=0.5)


@pytest.mark.asyncio
async def test_window_aggregates_slowly_arriving_tokens():
    """Perf vague 5 : quand le consommateur suit la cadence (file toujours
    vide), la micro-fenêtre bornée agrège quand même les tokens proches —
    sinon 60 tok/s = 60 lignes NDJSON/s à parser côté client."""
    q = asyncio.Queue()

    async def producer():
        for i in range(10):
            await q.put({"type": "content_token", "text": str(i)})
            await asyncio.sleep(0.003)   # 3 ms < fenêtre 15 ms
        await q.put(None)

    out = []

    async def consumer():
        async for ev in _drain_coalesced(q, window_ms=15.0):
            out.append(ev)

    await asyncio.gather(producer(), consumer())
    toks = [e for e in out if e.get("type") == "content_token"]
    assert sum(e.get("n", 1) for e in toks) == 10        # rien de perdu
    assert "".join(e["text"] for e in toks) == "0123456789"  # ordre strict
    assert len(toks) < 10                                # agrégation effective


@pytest.mark.asyncio
async def test_window_zero_restores_legacy_behavior():
    """window_ms=0 : comportement historique — 1 événement par token quand
    les tokens arrivent espacés (aucune attente ajoutée)."""
    q = asyncio.Queue()

    async def producer():
        for i in range(5):
            await q.put({"type": "content_token", "text": str(i)})
            await asyncio.sleep(0.003)
        await q.put(None)

    out = []

    async def consumer():
        async for ev in _drain_coalesced(q, window_ms=0):
            out.append(ev)

    await asyncio.gather(producer(), consumer())
    toks = [e for e in out if e.get("type") == "content_token"]
    assert len(toks) == 5 and all("n" not in e for e in toks)


@pytest.mark.asyncio
async def test_window_non_token_event_breaks_and_orders():
    """Un événement d'un autre type reçu PENDANT la fenêtre interrompt
    l'agrégat et sort à sa place dans le flux (ordre strict)."""
    q = asyncio.Queue()

    async def producer():
        await q.put({"type": "content_token", "text": "a"})
        await asyncio.sleep(0.002)
        await q.put({"type": "content_token", "text": "b"})
        await asyncio.sleep(0.002)
        await q.put({"type": "tool_call", "name": "read_file"})
        await asyncio.sleep(0.002)
        await q.put({"type": "content_token", "text": "c"})
        await q.put(None)

    out = []

    async def consumer():
        async for ev in _drain_coalesced(q, window_ms=15.0):
            out.append(ev)

    await asyncio.gather(producer(), consumer())
    types = [e.get("type") for e in out]
    itool = types.index("tool_call")
    before = "".join(e["text"] for e in out[:itool])
    after = "".join(e["text"] for e in out[itool + 1:])
    assert before == "ab" and after == "c"
