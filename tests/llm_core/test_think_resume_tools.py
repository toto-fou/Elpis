# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_think_resume_tools.py

Auto-reprise d'un raisonnement coupé — chemin OUTILS :

  Boucle ``run_chat_multi_mcp`` (stream mocké, recette de
  test_continue_truncation_and_cancel) :
  • [length think-only] → reprise (resume_think transmis au prochain appel,
    canal natif propagé) → [tool_call] exécuté normalement → [stop] : aucune
    troncature, tool_history du run SANS trace de la reprise, thinking fusionné
    sans « \\n\\n » factice ;
  • plafond de reprises → sortie ``truncated_in_think`` (bannière) ;
  • partiels de transport (``partial:True``) en série → reprises jusqu au
    plafond, puis sortie ``truncated_in_think`` (audit cœur 2026-08-21).

  Fonction de stream ``_llama_chat_with_tools_stream`` (client HTTP mocké) :
  • ``resume_think`` natif → queue native + flags + tools[] conservés ;
  • ``resume_native_ok=False`` → repli think fermé + consigne, thinking coupé.
"""
from __future__ import annotations

import json

import pytest

from llm_core import _chat_with_tools as _cwt, _llm_params, _model_info, _think_resume as tr
from llm_core.engine import llm_stream as _llm_stream
from llm_core.providers import openai_compat as _oai
from tests.llm_core.test_think_resume_classic import _SeqClient


async def _anoop(*_a, **_k):
    return None


async def _avision(*_a, **_k):
    return False


async def _actx(*_a, **_k):
    return 0


def _patch_tools_env(monkeypatch):
    monkeypatch.setattr(_cwt, "verify_llm_availability", _anoop)
    monkeypatch.setattr(_cwt, "_model_supports_vision", _avision)
    monkeypatch.setattr(_model_info, "get_model_context_size", _actx)
    _llm_params._continue_final_cache.clear()


# ── Boucle : reprise puis tool_call puis réponse ─────────────────────────────
async def test_loop_resume_then_tool_then_answer(monkeypatch):
    _patch_tools_env(monkeypatch)

    builtin = {
        "mytool": {
            "definition": {"type": "function",
                           "function": {"name": "mytool", "parameters": {}}},
            "handler": lambda _args: json.dumps({"ok": True}),
        },
    }

    calls = []

    async def _fake_stream(messages, tools_payload, **kw):
        calls.append({"resume_think": kw.get("resume_think"),
                      "resume_native_ok": kw.get("resume_native_ok")})
        n = len(calls)
        if n == 1:
            # Coupé par le plafond en plein raisonnement (canal natif).
            await kw["on_thinking_token"]("pensée A ")
            return {
                "choices": [{"finish_reason": "length",
                             "message": {"role": "assistant", "content": None,
                                         "tool_calls": None}}],
                "usage": {"prompt_tokens": 50, "completion_tokens": 40},
                "timings": {},
                "reasoning_channel_native": True,
            }
        if n == 2:
            # Reprise : le modèle conclut sa réflexion PUIS appelle un outil.
            await kw["on_thinking_token"]("pensée B")
            return {
                "choices": [{"finish_reason": "tool_calls",
                             "message": {"role": "assistant", "content": None,
                                         "tool_calls": [
                                             {"id": "call_1", "type": "function",
                                              "function": {"name": "mytool",
                                                           "arguments": "{}"}}]}}],
                "usage": {"prompt_tokens": 90, "completion_tokens": 30},
                "timings": {},
                "reasoning_channel_native": True,
            }
        return {
            "choices": [{"finish_reason": "stop",
                         "message": {"role": "assistant",
                                     "content": "Terminé.", "tool_calls": None}}],
            "usage": {"prompt_tokens": 120, "completion_tokens": 5},
            "timings": {},
            "reasoning_channel_native": True,
        }

    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", _fake_stream)

    final, _events, metrics = await _cwt.run_chat_multi_mcp(
        [{"role": "user", "content": "tâche longue"}],
        mcp_configs=[], builtin_tools=builtin, username="u",
    )

    assert final == "Terminé."
    # Le 2e appel EST la reprise : raisonnement accumulé + canal natif propagé.
    assert calls[1]["resume_think"] == "pensée A "
    assert calls[1]["resume_native_ok"] is True
    # Les appels normaux ne portent pas de reprise.
    assert calls[0]["resume_think"] is None
    assert calls[2]["resume_think"] is None
    assert metrics["truncated"] is False
    assert metrics["truncated_in_think"] is False
    # tool_history du run : AUCUNE trace de la reprise (prefill transient).
    hist = metrics.get("tool_history") or []
    assert [m.get("role") for m in hist] == ["assistant", "tool"]
    # Thinking fusionné token-exact (pas d'entrée « \n\n » entre segments).
    assert metrics.get("thinking") == "pensée A pensée B"


async def test_loop_resume_cap_exits_truncated_in_think(monkeypatch):
    _patch_tools_env(monkeypatch)
    monkeypatch.setattr(tr, "LLAMA_THINK_RESUME_MAX", 1)

    calls = {"n": 0}

    async def _fake_stream(messages, tools_payload, **kw):
        calls["n"] += 1
        await kw["on_thinking_token"]("pensée %d " % calls["n"])
        return {
            "choices": [{"finish_reason": "length",
                         "message": {"role": "assistant", "content": None,
                                     "tool_calls": None}}],
            "usage": {"prompt_tokens": 50, "completion_tokens": 40},
            "timings": {},
            "reasoning_channel_native": True,
        }

    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", _fake_stream)

    final, _events, metrics = await _cwt.run_chat_multi_mcp(
        [{"role": "user", "content": "réfléchis"}],
        mcp_configs=[], builtin_tools=None, username="u",
    )
    # 1 reprise (plafond=1) puis bannière : PAS de boucle infinie.
    assert calls["n"] == 2
    assert not (final or "").strip()
    assert metrics["truncated"] is True
    assert metrics["truncated_in_think"] is True
    assert metrics["think_resumes"] == 1


async def test_loop_partial_resumes_then_caps(monkeypatch):
    # Audit cœur 2026-08-21 : un partiel de transport en plein raisonnement
    # est désormais REPRIS in-run (au lieu de terminer le run au premier
    # ReadTimeout). Les plafonds restent la borne : des partiels en série
    # consomment les reprises puis la sortie reste ``truncated_in_think``.
    _patch_tools_env(monkeypatch)
    monkeypatch.setattr(tr, "LLAMA_THINK_RESUME_MAX", 2)

    calls = {"n": 0}

    async def _fake_stream(messages, tools_payload, **kw):
        calls["n"] += 1
        await kw["on_thinking_token"]("pensée avant timeout")
        # Partiel de transport (ReadTimeout après émission) : finish=length +
        # marqueur racine ``partial`` (cf. _llama_chat_with_tools_stream).
        return {
            "choices": [{"finish_reason": "length",
                         "message": {"role": "assistant", "content": None,
                                     "tool_calls": None}}],
            "usage": {}, "timings": {},
            "partial": True,
            "reasoning_channel_native": True,
        }

    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", _fake_stream)

    _final, _events, metrics = await _cwt.run_chat_multi_mcp(
        [{"role": "user", "content": "réfléchis"}],
        mcp_configs=[], builtin_tools=None, username="u",
    )
    # 1 appel initial + LLAMA_THINK_RESUME_MAX reprises, puis stop borné.
    assert calls["n"] == 3
    assert metrics["truncated_in_think"] is True


# ── Fonction de stream : construction du payload de reprise ──────────────────
@pytest.fixture()
def _stream_env(monkeypatch):
    async def _fake_sampling(*_a, **_k):
        return {}
    monkeypatch.setattr(_llm_params, "resolve_sampling", _fake_sampling)
    monkeypatch.setattr(_model_info, "get_model_context_size", _actx)
    _llm_params._continue_final_cache.clear()
    yield
    _llm_params._continue_final_cache.clear()


_TOOLS = [{"type": "function",
           "function": {"name": "mytool", "parameters": {"type": "object"}}}]

_STOP_LINES = [
    'data: {"choices":[{"delta":{"content":"ok"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],'
    '"usage":{"prompt_tokens":10,"completion_tokens":2}}',
    "data: [DONE]",
]


async def test_stream_fn_native_resume_payload(_stream_env, monkeypatch):
    client = _SeqClient([_STOP_LINES])
    monkeypatch.setattr(_oai, "_get_llm_client", lambda *a, **k: client)

    out = await _llm_stream._llama_chat_with_tools_stream(
        [{"role": "user", "content": "continue"}], _TOOLS,
        thinking_mode=True, resume_think="raisonnement acquis",
        resume_native_ok=True,
    )
    p = client.captured[0]
    last = p["messages"][-1]
    assert last == {"role": "assistant", "content": "",
                    "reasoning_content": "raisonnement acquis"}
    assert p.get("continue_final_message") is True
    assert p.get("add_generation_prompt") is False
    # tools[] CONSERVÉ : le modèle peut conclure puis appeler un outil.
    assert p.get("tools") and p["tools"][0]["function"]["name"] == "mytool"
    # Le flag de canal est propagé pour le tour SUIVANT.
    assert out.get("reasoning_channel_native") is False


async def test_stream_fn_fallback_resume_payload(_stream_env, monkeypatch):
    client = _SeqClient([_STOP_LINES])
    monkeypatch.setattr(_oai, "_get_llm_client", lambda *a, **k: client)

    await _llm_stream._llama_chat_with_tools_stream(
        [{"role": "user", "content": "continue"}], _TOOLS,
        thinking_mode=True, resume_think="raisonnement acquis",
        resume_native_ok=False,
    )
    p = client.captured[0]
    a, u = p["messages"][-2], p["messages"][-1]
    assert a["role"] == "assistant"
    assert a["content"].startswith("<think>\n")
    assert a["content"].endswith("</think>")
    assert u == {"role": "user", "content": tr.RESUME_AFTER_THINK_INSTRUCTION}
    assert "continue_final_message" not in p
    # Prefill assistant ⟂ enable_thinking : coupé au template sur le repli.
    assert p["chat_template_kwargs"]["enable_thinking"] is False
    assert p.get("tools")
