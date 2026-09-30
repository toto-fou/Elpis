# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_continue_truncation_and_cancel.py

Couvre les correctifs « reprise / Continue » + tool-calls :

  • BUG 3  — extract_tool_calls : un ``arguments`` string NON-JSON retombe sur
             ``{}`` (aligné sur le chemin natif), sans fuite d'exception.
  • BUG 1a — chemin classique : ``meta`` porte ``finish_reason`` / ``truncated``
             quand le modèle est coupé par le plafond (``finish_reason=="length"``).
  • BUG 1b — chemin outils : la réponse finale coupée (``length``) arme
             ``metrics["truncated"]``.
  • BUG 2a — annulation EN PLEINE boucle d'outils : un event interne
             ``tool_history_partial`` (DELTA du run depuis 2026-07-27) est
             émis avant de propager l'annulation, pour qu'un « Continuer »
             ne reparte pas aveugle.

Aucun réseau : le stream LLM et les helpers d'availability/vision/ctx sont
monkeypatchés.
"""
from __future__ import annotations

import asyncio
import json

import pytest

from llm_core import _chat_classic as _ccl, _chat_with_tools as _cwt, _llm_params, _tool_parsing as _tp
from llm_core.providers import openai_compat as _oai


# ── Fakes HTTP (chemin classique) ────────────────────────────────────────────
class _FakeResp:
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

    def stream(self, _method, _url, json=None, headers=None):  # noqa: A002
        self.captured["payload"] = json
        return _FakeResp(self._lines)


async def _anoop(*_a, **_k):
    return None


async def _avision(*_a, **_k):
    return False


async def _actx(*_a, **_k):
    return 0


# ── BUG 3 — fallback {} sur arguments string non-JSON, sans exception ─────────
def test_extract_tool_calls_nonjson_string_args_yields_empty_dict():
    # ``arguments`` est une string JSON invalide → on retombe sur {} (chemin
    # natif), PAS sur {"value": ...} ni une exception qui remonterait.
    text = '<tool_call>{"name": "search", "arguments": "ceci nest pas du json {"}</tool_call>'
    out = _tp.extract_tool_calls(text)
    assert out == [("search", {})]


def test_extract_tool_calls_valid_string_args_still_parsed():
    # Garde-fou : une string JSON VALIDE reste dé-stringifiée normalement.
    text = '<tool_call>{"name": "search", "arguments": "{\\"q\\": 1}"}</tool_call>'
    out = _tp.extract_tool_calls(text)
    assert out == [("search", {"q": 1})]


# ── BUG 1a — chemin classique : finish_reason/truncated dans meta ────────────
async def test_classic_meta_flags_length_truncation(monkeypatch):
    async def _fake_sampling(*_a, **_k):
        return {}

    monkeypatch.setattr(_llm_params, "resolve_sampling", _fake_sampling)
    lines = [
        'data: {"choices":[{"delta":{"content":"reponse coupee"}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"length"}],'
        '"usage":{"prompt_tokens":5,"completion_tokens":3}}',
        "data: [DONE]",
    ]
    monkeypatch.setattr(_oai, "_get_llm_client", lambda *a, **k: _FakeClient(lines))

    _thinking, content, meta = await _ccl.llama_chat_stream_tokens(
        [{"role": "user", "content": "vas-y"}],
    )
    assert content == "reponse coupee"
    assert meta.get("finish_reason") == "length"
    assert meta.get("truncated") is True


async def test_classic_meta_no_truncation_on_stop(monkeypatch):
    async def _fake_sampling(*_a, **_k):
        return {}

    monkeypatch.setattr(_llm_params, "resolve_sampling", _fake_sampling)
    lines = [
        'data: {"choices":[{"delta":{"content":"fini"}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],'
        '"usage":{"prompt_tokens":5,"completion_tokens":1}}',
        "data: [DONE]",
    ]
    monkeypatch.setattr(_oai, "_get_llm_client", lambda *a, **k: _FakeClient(lines))

    _t, _c, meta = await _ccl.llama_chat_stream_tokens(
        [{"role": "user", "content": "salut"}],
    )
    assert meta.get("truncated") is False


# ── BUG 1b — chemin outils : réponse finale coupée → metrics["truncated"] ─────
def _patch_tools_env(monkeypatch):
    monkeypatch.setattr(_cwt, "verify_llm_availability", _anoop)
    monkeypatch.setattr(_cwt, "_model_supports_vision", _avision)
    monkeypatch.setattr(_cwt, "get_model_context_size", _actx)


async def test_tools_final_length_sets_truncated(monkeypatch):
    _patch_tools_env(monkeypatch)

    async def _fake_stream(messages, tools_payload, **kw):
        return {
            "choices": [{
                "finish_reason": "length",
                "message": {"role": "assistant",
                            "content": "longue reponse coupee net",
                            "tool_calls": None},
            }],
            "usage": {"prompt_tokens": 10, "completion_tokens": 8},
            "timings": {},
        }

    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", _fake_stream)

    final, _events, metrics = await _cwt.run_chat_multi_mcp(
        [{"role": "user", "content": "ecris long"}],
        mcp_configs=[], builtin_tools=None, username="u",
    )
    assert "coupee" in final
    assert metrics.get("truncated") is True
    assert metrics.get("finish_reason") == "length"


async def test_tools_final_stop_not_truncated(monkeypatch):
    _patch_tools_env(monkeypatch)

    async def _fake_stream(messages, tools_payload, **kw):
        return {
            "choices": [{
                "finish_reason": "stop",
                "message": {"role": "assistant", "content": "reponse complete",
                            "tool_calls": None},
            }],
            "usage": {"prompt_tokens": 4, "completion_tokens": 2},
            "timings": {},
        }

    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", _fake_stream)

    _final, _events, metrics = await _cwt.run_chat_multi_mcp(
        [{"role": "user", "content": "salut"}],
        mcp_configs=[], builtin_tools=None, username="u",
    )
    assert metrics.get("truncated") is False


# ── BUG 2a — annulation en boucle d'outils → tool_history_partial émis ────────
async def test_cancel_during_tools_emits_partial_tool_history(monkeypatch):
    _patch_tools_env(monkeypatch)

    state = {"cancel": False}

    def _handler(_args):
        # Une fois l'outil exécuté, on demande l'annulation : la prochaine
        # vérification (haut de boucle, itération suivante) la détectera.
        state["cancel"] = True
        return json.dumps({"ok": True, "data": "resultat outil"})

    builtin = {
        "mytool": {
            "definition": {"type": "function",
                           "function": {"name": "mytool", "parameters": {}}},
            "handler": _handler,
        },
    }

    calls = {"n": 0}

    async def _fake_stream(messages, tools_payload, **kw):
        calls["n"] += 1
        # 1er tour : demande l'appel d'outil. (On ne doit jamais atteindre un
        # 2e tour : l'annulation coupe la boucle avant.)
        return {
            "choices": [{
                "finish_reason": "tool_calls",
                "message": {"role": "assistant", "content": None, "tool_calls": [
                    {"id": "call_x", "type": "function",
                     "function": {"name": "mytool", "arguments": "{}"}},
                ]},
            }],
            "usage": {}, "timings": {},
        }

    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", _fake_stream)

    seen = []

    async def _on_event(ev):
        seen.append(ev)

    with pytest.raises(asyncio.CancelledError):
        await _cwt.run_chat_multi_mcp(
            [{"role": "user", "content": "fais le"}],
            mcp_configs=[], builtin_tools=builtin, username="u",
            on_event=_on_event,
            is_cancelled=lambda: state["cancel"],
        )

    partials = [e for e in seen if isinstance(e, dict)
                and e.get("type") == "tool_history_partial"]
    assert partials, "un event tool_history_partial doit être émis à l'annulation"
    hist = partials[-1].get("tool_history") or []
    # Contrat DELTA (2026-07-27) : le snapshot ne porte QUE le travail de ce
    # run — exactement le round exécuté, sans entrée user de contrôle.
    assert [m.get("role") for m in hist] == ["assistant", "tool"], hist
    assert hist[0].get("tool_calls") and hist[1].get("tool_call_id") == "call_x"
