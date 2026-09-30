# SPDX-License-Identifier: MIT
"""tests/llm_core/test_llamacpp_provider.py — étages partagés des 2 moteurs.

``build_llama_payload`` + ``consume_llama_sse`` (providers.llamacpp) sont
extraits des blocs byte-identiques des deux fonctions de streaming. Couvre :
- payload : skeleton, extensions llama.cpp gated sur llama_native, clamp +
  slot pinning gated sur local_llamacpp ;
- consume : accumulation tool_calls (canal natif), routage thinking/content
  via ThinkTagSplitter, capture usage/timings (l'usage du chunk final est la
  source RÉELLE de la jauge de contexte), cancel mid-stream, flush de fin.
"""
from __future__ import annotations

import pytest

from llm_core._stream_tag_parser import ThinkTagSplitter
from llm_core.providers.llamacpp import (
    SseStreamResult,
    build_llama_payload,
    consume_llama_sse,
)

# ── build_llama_payload ─────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_payload_skeleton_et_sampling():
    p = await build_llama_payload(
        [{"role": "user", "content": "hi"}], target_model="m", user_id="u",
        sampling_params={"temperature": 0.5}, llama_native=False,
        local_llamacpp=False, thinking_mode=False, chat_id=None,
    )
    assert p["model"] == "m" and p["stream"] is True
    assert p["stream_options"] == {"include_usage": True}
    assert p["temperature"] == 0.5
    # cible non-llama.cpp : aucune extension llama.cpp.
    assert "chat_template_kwargs" not in p and "timings_per_token" not in p
    assert "id_slot" not in p


@pytest.mark.asyncio
async def test_payload_extensions_llama_native(monkeypatch):
    p = await build_llama_payload(
        [{"role": "user", "content": "hi"}], target_model="m", user_id="u",
        sampling_params={}, llama_native=True, local_llamacpp=False,
        thinking_mode=True, chat_id=None,
    )
    assert p["timings_per_token"] is True
    assert p["chat_template_kwargs"] == {"enable_thinking": True}
    # llama_native mais PAS local → pas de slot pinning ni de clamp local.
    assert "id_slot" not in p


@pytest.mark.asyncio
async def test_payload_slot_et_clamp_local(monkeypatch):
    import llm_core._constants as const
    import llm_core._model_info as mi
    import llm_core.providers.llamacpp as prov

    async def _ctx(_m):
        return 8192

    async def _slot(_cid):
        return 3

    monkeypatch.setattr(mi, "get_model_context_size", _ctx)
    monkeypatch.setattr(const, "resolve_slot_id_async", _slot)
    p = await build_llama_payload(
        [{"role": "user", "content": "hi"}], target_model="m", user_id="u",
        sampling_params={}, llama_native=True, local_llamacpp=True,
        thinking_mode=False, chat_id="c1",
    )
    assert p["id_slot"] == 3
    assert isinstance(p.get("max_tokens"), int) and p["max_tokens"] > 0


# ── consume_llama_sse ───────────────────────────────────────────────────────

class _FakeResp:
    def __init__(self, lines):
        self._lines = lines

    async def aiter_lines(self):
        for x in self._lines:
            yield x

    async def aclose(self):
        pass


async def _consume(lines, **kw):
    return await consume_llama_sse(
        _FakeResp(lines), tag_splitter=ThinkTagSplitter(),
        req_id="r", user_id="u", **kw)


@pytest.mark.asyncio
async def test_consume_accumule_tool_calls():
    import json
    delta = {"choices": [{"delta": {"tool_calls": [{
        "index": 0, "id": "t1", "type": "function",
        "function": {"name": "read_file", "arguments": '{"path":"a"}'}}]}}]}
    fin = {"choices": [{"delta": {}, "finish_reason": "tool_calls"}],
           "usage": {"prompt_tokens": 5}}
    r = await _consume([f"data: {json.dumps(delta)}", f"data: {json.dumps(fin)}",
                        "data: [DONE]"])
    tcs = r.built_tool_calls()
    assert len(tcs) == 1 and tcs[0]["function"]["name"] == "read_file"
    assert r.finish_reason == "tool_calls"


@pytest.mark.asyncio
async def test_consume_route_thinking_et_content():
    import json
    toks = []
    c1 = {"choices": [{"delta": {"content": "<think>raison</think>visible"}}]}
    fin = {"choices": [{"delta": {}, "finish_reason": "stop"}]}

    async def _c(t):
        toks.append(("c", t))

    async def _k(t):
        toks.append(("k", t))

    r = await _consume(
        [f"data: {json.dumps(c1)}", f"data: {json.dumps(fin)}", "data: [DONE]"],
        on_content_token=_c, on_thinking_token=_k,
    )
    assert "raison" in r.thinking() and "visible" in r.content()
    # chat classique : aucun tool_call accumulé.
    assert r.built_tool_calls() == []


@pytest.mark.asyncio
async def test_consume_capture_usage_reel():
    # La jauge de contexte lit l'usage RÉEL du chunk final (fin de requête) :
    # le consumer doit le capturer tel quel, timings compris (métriques).
    lines = [
        'data: {"choices":[{"delta":{"content":"a"}}],"timings":{"prompt_n":42}}',
        'data: {"choices":[{"delta":{"content":"b"}}],"timings":{"prompt_n":42}}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],'
        '"usage":{"prompt_tokens":4242,"completion_tokens":2},'
        '"timings":{"prompt_n":42,"predicted_n":2}}',
        "data: [DONE]",
    ]
    r = await _consume(lines)
    assert r.usage == {"prompt_tokens": 4242, "completion_tokens": 2}
    assert r.timings.get("prompt_n") == 42


@pytest.mark.asyncio
async def test_consume_cancel_mid_stream():
    import asyncio
    lines = ['data: {"choices":[{"delta":{"content":"x"}}]}'] * 5
    with pytest.raises(asyncio.CancelledError):
        await _consume(lines, is_cancelled=lambda: True)


@pytest.mark.asyncio
async def test_consume_sink_voit_le_partiel_sur_raise_mid_stream():
    """Régression anti-duplication (Phase 5) : sur une erreur transport EN
    PLEIN flux, le ``sink`` fourni par l'appelant contient déjà les tokens
    émis via on_content_token → le garde anti-retry du caller les voit et ne
    ré-émet pas. Sans sink, un objet frais ne remonterait jamais (raise avant
    return) et le retry dupliquerait la sortie côté client."""
    import json

    class _RaisingResp:
        async def aclose(self): pass
        async def aiter_lines(self):
            yield 'data: ' + json.dumps({"choices": [{"delta": {"content": "Bonjour "}}]})
            yield 'data: ' + json.dumps({"choices": [{"delta": {"content": "le monde"}}]})
            raise RuntimeError("RemoteProtocolError: peer closed mid-stream")

    emitted = []
    async def _on_content(t): emitted.append(t)

    sink = SseStreamResult()
    with pytest.raises(RuntimeError):
        await consume_llama_sse(
            _RaisingResp(), tag_splitter=ThinkTagSplitter(), req_id="r",
            user_id="u", on_content_token=_on_content, sink=sink)
    # Le partiel EST visible dans le sink de l'appelant malgré le raise.
    assert sink.content_parts == ["Bonjour ", "le monde"]
    assert emitted == ["Bonjour ", "le monde"]

    # Sans sink : l'objet créé en interne ne peut PAS remonter sur un raise
    # (le garde du caller verrait des buffers vides → retry → duplication).
    with pytest.raises(RuntimeError):
        await consume_llama_sse(
            _RaisingResp(), tag_splitter=ThinkTagSplitter(), req_id="r2",
            user_id="u", on_content_token=_on_content)
