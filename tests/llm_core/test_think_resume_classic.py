# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_think_resume_classic.py

Auto-reprise d'un raisonnement coupé (chemin CLASSIQUE, boucle de segments de
``llama_chat_stream_tokens``) — recette ``_FakeClient`` de
``test_continue_truncation_and_cancel``, étendue en séquence multi-requêtes :

  • reprise NATIVE (``continue_final_message``) : 2e POST = mêmes messages +
    assistant ``{content:"", reasoning_content}`` terminal, flags armés,
    thinking accumulé, usage fusionné, ``truncated=False`` ;
  • 4xx sur le natif → REPLI prefill ``<think>…</think>`` + consigne, et
    non-support MÉMORISÉ (``continue_final_support``) ;
  • raisonnement arrivé par BALISES (pas de ``reasoning_content``) → repli
    directement (une continuation native arriverait sans balise ouvrante) ;
  • plafond de reprises atteint → ``truncated_in_think`` (bannière) ;
  • échec dur EN reprise → retour de l'état ACCUMULÉ continuable (pas une
    erreur sèche).

Aucun réseau : client HTTP, sampling et n_ctx monkeypatchés.
"""
from __future__ import annotations

import httpx
import pytest

from llm_core import _chat_classic as _ccl
from llm_core import _llm_params
from llm_core import _model_info
from llm_core import _think_resume as tr
from llm_core.providers import openai_compat as _oai


class _FakeResp:
    def __init__(self, lines, status_code=200):
        self.status_code = status_code
        self._lines = lines

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_a):
        return False

    async def aiter_lines(self):
        for line in self._lines:
            yield line

    async def aread(self):
        return b""

    async def aclose(self):
        pass

    def raise_for_status(self):
        if self.status_code >= 400:
            req = httpx.Request("POST", "http://llm.test/v1/chat/completions")
            raise httpx.HTTPStatusError(
                f"{self.status_code}", request=req,
                response=httpx.Response(self.status_code, request=req))


class _SeqClient:
    """Un jeu de lignes (ou un code 4xx) PAR requête, payloads capturés."""

    def __init__(self, responses):
        self._responses = list(responses)
        self.captured = []

    def stream(self, _method, _url, json=None, headers=None, **_kw):  # noqa: A002 — **_kw : le vrai httpx accepte timeout= par requête
        self.captured.append(json)
        spec = self._responses.pop(0)
        if isinstance(spec, int):
            return _FakeResp([], status_code=spec)
        return _FakeResp(spec)


async def _actx0(*_a, **_k):
    return 0


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    async def _fake_sampling(*_a, **_k):
        return {}
    monkeypatch.setattr(_llm_params, "resolve_sampling", _fake_sampling)
    monkeypatch.setattr(_model_info, "get_model_context_size", _actx0)
    # Cache de capacité : repart inconnu à chaque test (tentative optimiste).
    _llm_params._continue_final_cache.clear()
    yield
    _llm_params._continue_final_cache.clear()


def _seg_len_reasoning(text="pensée segment 1 ", p=100, c=50):
    """Segment coupé par le plafond, raisonnement sur le canal NATIF."""
    return [
        'data: {"choices":[{"delta":{"reasoning_content":"%s"}}]}' % text,
        'data: {"choices":[{"delta":{},"finish_reason":"length"}],'
        '"usage":{"prompt_tokens":%d,"completion_tokens":%d}}' % (p, c),
        "data: [DONE]",
    ]


def _seg_final(answer="La réponse.", think="suite ", p=160, c=20):
    return [
        'data: {"choices":[{"delta":{"reasoning_content":"%s"}}]}' % think,
        'data: {"choices":[{"delta":{"content":"%s"}}]}' % answer,
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],'
        '"usage":{"prompt_tokens":%d,"completion_tokens":%d}}' % (p, c),
        "data: [DONE]",
    ]


async def test_native_resume_success(monkeypatch):
    client = _SeqClient([_seg_len_reasoning(), _seg_final()])
    monkeypatch.setattr(_oai, "_get_llm_client", lambda *a, **k: client)

    thinking, content, meta = await _ccl.llama_chat_stream_tokens(
        [{"role": "user", "content": "réfléchis longuement"}],
        thinking_mode=True,
    )

    assert len(client.captured) == 2
    p2 = client.captured[1]
    # 2e POST : mêmes messages + assistant « en cours » TERMINAL, flags natifs
    # (armés par build_llama_payload sur cette forme).
    last = p2["messages"][-1]
    assert last["role"] == "assistant" and last["content"] == ""
    assert last["reasoning_content"] == "pensée segment 1 "
    assert p2.get("continue_final_message") is True
    assert p2.get("add_generation_prompt") is False
    # Résultat : thinking ACCUMULÉ (concat token-exacte), réponse propre,
    # AUCUNE troncature résiduelle, usage fusionné (completion sommés,
    # prompt = dernier segment).
    assert thinking == "pensée segment 1 suite"
    assert content == "La réponse."
    assert meta["truncated"] is False
    assert meta["truncated_in_think"] is False
    assert meta["think_resumes"] == 1
    assert meta["usage"]["completion_tokens"] == 70
    assert meta["usage"]["prompt_tokens"] == 160
    # Reprise native aboutie → support mémorisé.
    assert _llm_params.continue_final_support(None) is True or \
        True in _llm_params._continue_final_cache.values()


async def test_native_400_falls_back_to_prefill_and_remembers(monkeypatch):
    client = _SeqClient([_seg_len_reasoning(), 400, _seg_final(think="")])
    monkeypatch.setattr(_oai, "_get_llm_client", lambda *a, **k: client)

    thinking, content, meta = await _ccl.llama_chat_stream_tokens(
        [{"role": "user", "content": "vas-y"}],
        thinking_mode=True,
    )

    assert len(client.captured) == 3
    p3 = client.captured[2]
    # Repli : think FERMÉ + consigne de conclusion, thinking coupé au template,
    # pas de flags natifs.
    a, u = p3["messages"][-2], p3["messages"][-1]
    assert a["role"] == "assistant"
    assert a["content"].startswith("<think>\n")
    assert a["content"].endswith("</think>")
    assert u == {"role": "user", "content": tr.RESUME_AFTER_THINK_INSTRUCTION}
    assert "continue_final_message" not in p3
    assert p3["chat_template_kwargs"]["enable_thinking"] is False
    # thinking_mode=False sur le segment de repli → pas de budget envoyé.
    assert "thinking_budget_tokens" not in p3
    # Non-support MÉMORISÉ pour les prochains tours.
    assert False in _llm_params._continue_final_cache.values()
    assert content == "La réponse."
    assert meta["truncated"] is False and meta["think_resumes"] == 1


async def test_tag_channel_reasoning_goes_fallback_directly(monkeypatch):
    # Raisonnement par BALISES <think> (canal content, --reasoning-format
    # none) : jamais de tentative native — la continuation arriverait sans
    # balise ouvrante et serait classée content.
    seg1 = [
        'data: {"choices":[{"delta":{"content":"<think>pensée par balises"}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"length"}],'
        '"usage":{"prompt_tokens":10,"completion_tokens":5}}',
        "data: [DONE]",
    ]
    client = _SeqClient([seg1, _seg_final(think="")])
    monkeypatch.setattr(_oai, "_get_llm_client", lambda *a, **k: client)

    _t, content, meta = await _ccl.llama_chat_stream_tokens(
        [{"role": "user", "content": "vas-y"}],
        thinking_mode=True,
    )
    assert len(client.captured) == 2
    p2 = client.captured[1]
    assert "continue_final_message" not in p2
    assert p2["messages"][-2]["content"].endswith("</think>")
    assert p2["messages"][-1]["content"] == tr.RESUME_AFTER_THINK_INSTRUCTION
    assert content == "La réponse."
    assert meta["think_resumes"] == 1


async def test_resume_cap_reached_arms_truncated_in_think(monkeypatch):
    monkeypatch.setattr(tr, "LLAMA_THINK_RESUME_MAX", 1)
    client = _SeqClient([
        _seg_len_reasoning("pensée A "),
        _seg_len_reasoning("pensée B"),
    ])
    monkeypatch.setattr(_oai, "_get_llm_client", lambda *a, **k: client)

    thinking, content, meta = await _ccl.llama_chat_stream_tokens(
        [{"role": "user", "content": "vas-y"}],
        thinking_mode=True,
    )
    assert len(client.captured) == 2
    assert content == ""
    # Thinking ACCUMULÉ conservé, bannière armée (dernier recours).
    assert thinking == "pensée A pensée B"
    assert meta["truncated"] is True
    assert meta["truncated_in_think"] is True
    assert meta["think_resumes"] == 1


async def test_hard_failure_during_resume_returns_accumulated(monkeypatch):
    # Natif 400 → repli 400 aussi (erreur fatale) : l'état ACCUMULÉ revient
    # (continuable), pas une erreur sèche — le raisonnement déjà streamé au
    # client a de la valeur.
    client = _SeqClient([_seg_len_reasoning("pensée acquise"), 400, 400])
    monkeypatch.setattr(_oai, "_get_llm_client", lambda *a, **k: client)

    thinking, content, meta = await _ccl.llama_chat_stream_tokens(
        [{"role": "user", "content": "vas-y"}],
        thinking_mode=True,
    )
    assert len(client.captured) == 3
    assert content == ""
    assert thinking == "pensée acquise"
    assert meta.get("error") is not True
    assert meta["truncated"] is True and meta["truncated_in_think"] is True
