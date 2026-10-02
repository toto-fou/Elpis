# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_stream_usage_and_tools_order.py

Contrat de ``_llama_chat_with_tools_stream`` / ``llama_chat_stream_tokens``
depuis la bascule « réel seul » (2026-07-12) :

  1. AUCUN hook de pré-vol : la jauge de contexte ne s'appuie que sur
     ``usage`` du chunk SSE final (réel serveur), remonté tel quel dans le
     retour (dict outils / meta classic). ``timings_per_token`` reste demandé
     (timings → métriques de débit).

  2. Efficience du prefix-cache — le payload ``tools[]`` est trié de façon
     déterministe (par nom) → sérialisation byte-identique d'un tour à l'autre,
     quel que soit l'ordre rendu par le pool MCP.

Aucun réseau : le client HTTP et ``resolve_sampling`` sont monkeypatchés. Le
faux client capture le payload envoyé et rejoue un flux SSE crafté.
"""
from __future__ import annotations

import pytest

from llm_core import _chat_classic as _ccl, _llm_params
from llm_core.engine import llm_stream as _llm_stream
from llm_core.providers import openai_compat as _oai


class _FakeResp:
    """Réponse de stream factice : async context manager + aiter_lines."""

    status_code = 200

    def __init__(self, lines):
        self._lines = lines

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_a):
        return False

    async def aiter_lines(self):
        for line in self._lines:
            yield line

    async def aclose(self):
        pass


class _FakeClient:
    def __init__(self, lines):
        self._lines = lines
        self.captured = {}

    def stream(self, _method, _url, json=None, headers=None):  # noqa: A002 (signature httpx)
        self.captured["payload"] = json
        self.captured["url"] = _url
        self.captured["headers"] = headers
        return _FakeResp(self._lines)


def _tool(name: str):
    return {"type": "function", "function": {"name": name, "parameters": {}}}


@pytest.fixture
def patched(monkeypatch):
    async def _fake_sampling(*_a, **_k):
        return {}

    monkeypatch.setattr(_llm_params, "resolve_sampling", _fake_sampling)

    def _install(lines):
        fake = _FakeClient(lines)
        # Le transport résout le client via providers.openai_compat.endpoint()
        # (cible par défaut = llama.cpp intégré → client partagé). On patche
        # donc le factory à CE niveau (la cible par défaut n'envoie pas d'auth
        # et garde le payload llama-only intact).
        monkeypatch.setattr(_oai, "_get_llm_client", lambda *a, **k: fake)
        return fake

    return _install


async def test_usage_reel_capture_et_timings_demandes(patched):
    # L'usage du chunk final (réel serveur) doit remonter tel quel dans le
    # retour — c'est LA source de la jauge de contexte et de la porte de
    # compression. timings_per_token reste demandé (métriques).
    lines = [
        'data: {"choices":[{"delta":{"content":"Hi"}}],"timings":{"prompt_n":4242}}',
        'data: {"choices":[{"delta":{"content":" there"}}],"timings":{"prompt_n":4242}}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],'
        '"usage":{"prompt_tokens":4242,"completion_tokens":2},'
        '"timings":{"prompt_n":4242}}',
        "data: [DONE]",
    ]
    fake = patched(lines)

    out = await _llm_stream._llama_chat_with_tools_stream(
        [{"role": "user", "content": "hi"}],
        [_tool("alpha")],
    )

    assert out.get("usage") == {"prompt_tokens": 4242, "completion_tokens": 2}
    assert fake.captured["payload"].get("timings_per_token") is True


async def test_tools_payload_sorted_deterministically(patched):
    lines = [
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],'
        '"usage":{"prompt_tokens":10,"completion_tokens":1}}',
        "data: [DONE]",
    ]
    fake = patched(lines)

    # Ordre d'entrée volontairement non trié.
    await _llm_stream._llama_chat_with_tools_stream(
        [{"role": "user", "content": "hi"}],
        [_tool("zebra"), _tool("alpha"), _tool("mike")],
    )

    sent_names = [
        (t.get("function") or {}).get("name")
        for t in fake.captured["payload"]["tools"]
    ]
    assert sent_names == ["alpha", "mike", "zebra"]


async def test_classic_path_usage_et_timings(monkeypatch):
    # Chemin classique (chat SANS outils) : l'usage réel du chunk final arrive
    # dans meta (metrics → event kv_cache de fin de tour côté route) et le
    # payload demande timings_per_token.
    async def _fake_sampling(*_a, **_k):
        return {}

    monkeypatch.setattr(_llm_params, "resolve_sampling", _fake_sampling)

    lines = [
        'data: {"choices":[{"delta":{"content":"Salut"}}],"timings":{"prompt_n":999}}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],'
        '"usage":{"prompt_tokens":999,"completion_tokens":1},'
        '"timings":{"prompt_n":999}}',
        "data: [DONE]",
    ]
    fake = _FakeClient(lines)
    monkeypatch.setattr(_oai, "_get_llm_client", lambda *a, **k: fake)

    _thinking, content, meta = await _ccl.llama_chat_stream_tokens(
        [{"role": "user", "content": "salut"}],
    )

    assert content == "Salut"
    assert meta["usage"] == {"prompt_tokens": 999, "completion_tokens": 1}
    assert fake.captured["payload"].get("timings_per_token") is True
