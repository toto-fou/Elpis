# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_run_kill_containment.py — audit cœur 2026-08-21.

Deux symptômes de prod sur les runs autonomes longs (5-6 h) :

  1. « erreurs pydantic qui tuent le run » — une exception levée pendant
     l'exécution d'un outil (ValidationError pydantic enveloppée dans un
     (Base)ExceptionGroup anyio par les transports MCP, CancelledError fui
     d'un cancel-scope) traversait tous les ``except Exception`` et
     terminait le run entier au lieu de revenir au modèle en tool-error.

  2. « coupures avec bouton Continuer » — un partiel de transport (flux
     coupé mi-génération) n'était JAMAIS retenté ni repris : fin de run
     immédiate. La reprise in-run (think-resume) était explicitement
     bloquée sur ``partial=True``.

Aucun réseau : mêmes stubs que test_harness_timeouts.
"""
from __future__ import annotations

import asyncio
import json

import pytest

from llm_core import _chat_with_tools as _cwt, _model_info
from llm_core._think_resume import should_auto_resume
from llm_core.engine import tool_dispatch as _tool_dispatch
from llm_core.engine.tool_exec import flatten_exception_message


async def _anoop(*_a, **_k):
    return None


async def _avision(*_a, **_k):
    return False


async def _actx(*_a, **_k):
    return 8192


def _patch_env(monkeypatch):
    monkeypatch.setattr(_cwt, "verify_llm_availability", _anoop)
    monkeypatch.setattr(_cwt, "_model_supports_vision", _avision)
    monkeypatch.setattr(_model_info, "get_model_context_size", _actx)


def _final_msg(content):
    return {
        "choices": [{"finish_reason": "stop",
                     "message": {"role": "assistant", "content": content, "tool_calls": None}}],
        "usage": {"prompt_tokens": 4, "completion_tokens": 2}, "timings": {},
    }


def _tool_call_msg(name="boom", content=""):
    return {"choices": [{"finish_reason": "tool_calls", "message": {
        "role": "assistant", "content": content,
        "tool_calls": [{"id": "c1", "type": "function",
                        "function": {"name": name, "arguments": "{}"}}]}}],
        "usage": {"prompt_tokens": 3, "completion_tokens": 1}, "timings": {}}


def _builtin(name, handler):
    return {name: {
        "definition": {"type": "function", "function": {
            "name": name, "description": "test", "parameters": {"type": "object", "properties": {}}}},
        "handler": handler,
    }}


def _capture():
    seen = []
    async def on_event(ev):
        seen.append(ev)
    return seen, on_event


# ── flatten_exception_message ────────────────────────────────────────────────
def test_flatten_unwraps_nested_exception_groups():
    inner = ValueError("1 validation error for write_fileArguments — path: champ requis")
    grp = BaseExceptionGroup("unhandled errors in a TaskGroup",
                             [ExceptionGroup("sub", [inner])])
    msg = flatten_exception_message(grp)
    assert "validation error" in msg
    assert "TaskGroup" not in msg          # le wrapper anyio ne masque plus la cause


def test_flatten_plain_exception_passthrough():
    # Exception simple : message TEL QUEL (même enveloppe qu'avant le fix).
    assert flatten_exception_message(RuntimeError("boom")) == "boom"
    # Exception vide → au moins le type.
    assert "CancelledError" in flatten_exception_message(asyncio.CancelledError())


# ── (1) une exception d'outil ne tue plus le run ─────────────────────────────
async def test_baseexceptiongroup_from_tool_is_contained(monkeypatch):
    """BaseExceptionGroup (groupe anyio portant un CancelledError) : ni
    CancelledError ni Exception — avant, il traversait tout et terminait le
    run comme un Stop. Attendu : tool-error ordinaire, le modèle conclut."""
    _patch_env(monkeypatch)
    seq = {"n": 0}

    async def _fake_stream(messages, tools_payload, **kw):
        seq["n"] += 1
        if seq["n"] == 1:
            return _tool_call_msg("boom")
        return _final_msg("conclu malgré l'outil en panne")

    async def _boom(args):
        raise BaseExceptionGroup("unhandled errors in a TaskGroup",
                                 [asyncio.CancelledError()])

    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", _fake_stream)
    events, on_event = _capture()
    final, _ev, metrics = await _cwt.run_chat_multi_mcp(
        [{"role": "user", "content": "go"}],
        mcp_configs=[], builtin_tools=_builtin("boom", _boom), username="u",
        on_event=on_event,
    )
    assert "conclu" in final
    assert not metrics.get("ended_with_error")
    tr = [e for e in events if e.get("type") == "tool_result"]
    assert any("error" in json.dumps(e, ensure_ascii=False) for e in tr)


async def test_leaked_cancelled_error_is_contained(monkeypatch):
    """CancelledError FUI d'un cancel-scope MCP (aucun Stop utilisateur) :
    converti en tool-error, le run continue — avant, fin silencieuse « comme
    annulé »."""
    _patch_env(monkeypatch)
    seq = {"n": 0}

    async def _fake_stream(messages, tools_payload, **kw):
        seq["n"] += 1
        if seq["n"] == 1:
            return _tool_call_msg("leaky")
        return _final_msg("fini")

    async def _leaky(args):
        raise asyncio.CancelledError()

    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", _fake_stream)
    events, on_event = _capture()
    final, _ev, metrics = await _cwt.run_chat_multi_mcp(
        [{"role": "user", "content": "go"}],
        mcp_configs=[], builtin_tools=_builtin("leaky", _leaky), username="u",
        on_event=on_event, is_cancelled=lambda: False,
    )
    assert "fini" in final


async def test_real_cancellation_still_propagates(monkeypatch):
    """Un VRAI Stop (is_cancelled → True) pendant un outil doit toujours
    propager CancelledError (persistance du partiel côté route)."""
    _patch_env(monkeypatch)

    async def _fake_stream(messages, tools_payload, **kw):
        return _tool_call_msg("leaky")

    async def _leaky(args):
        raise asyncio.CancelledError()

    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", _fake_stream)
    _events, on_event = _capture()
    with pytest.raises(asyncio.CancelledError):
        await _cwt.run_chat_multi_mcp(
            [{"role": "user", "content": "go"}],
            mcp_configs=[], builtin_tools=_builtin("leaky", _leaky), username="u",
            on_event=on_event, is_cancelled=lambda: True,
        )


async def test_pydantic_validation_error_reaches_model_flattened(monkeypatch):
    """ValidationError pydantic (levée dans le corps/transport de l'outil,
    enveloppée par anyio) : le tool-result doit porter le DÉTAIL du champ,
    pas « unhandled errors in a TaskGroup »."""
    _patch_env(monkeypatch)
    pydantic = pytest.importorskip("pydantic")

    class _Args(pydantic.BaseModel):
        path: str

    seq = {"n": 0}

    async def _fake_stream(messages, tools_payload, **kw):
        seq["n"] += 1
        if seq["n"] == 1:
            return _tool_call_msg("validated")
        return _final_msg("ok")

    async def _validated(args):
        try:
            _Args.model_validate({})       # path manquant → ValidationError
        except Exception as e:
            raise ExceptionGroup("unhandled errors in a TaskGroup", [e])

    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", _fake_stream)
    events, on_event = _capture()
    await _cwt.run_chat_multi_mcp(
        [{"role": "user", "content": "go"}],
        mcp_configs=[], builtin_tools=_builtin("validated", _validated), username="u",
        on_event=on_event,
    )
    tr = json.dumps([e for e in events if e.get("type") == "tool_result"],
                    ensure_ascii=False)
    assert "validation error" in tr
    assert "TaskGroup" not in tr


# ── pick_tool_payload : isError du protocole MCP ─────────────────────────────
class _Txt:
    def __init__(self, text):
        self.text = text


class _CallToolResult:
    def __init__(self, text, is_error):
        self.content = [_Txt(text)]
        self.isError = is_error


def test_pick_tool_payload_honors_iserror():
    from llm_core.engine.result_contract import result_is_error
    out = _tool_dispatch.pick_tool_payload(_CallToolResult(
        "1 validation error for write_fileArguments\npath: Field required", True))
    assert isinstance(out, dict) and out.get("ok") is False
    # Sérialisé comme dans la boucle → bien classé ÉCHEC (budget productif).
    assert result_is_error(json.dumps(out, ensure_ascii=False)) is True


def test_pick_tool_payload_iserror_keeps_structured_envelope():
    env = json.dumps({"ok": False, "error": "boom", "hint": "x"})
    out = _tool_dispatch.pick_tool_payload(_CallToolResult(env, True))
    assert out == {"ok": False, "error": "boom", "hint": "x"}


def test_pick_tool_payload_success_unchanged():
    out = _tool_dispatch.pick_tool_payload(_CallToolResult(json.dumps({"data": 1}), False))
    assert out == {"data": 1}


# ── (2) reprise après partiel de transport ───────────────────────────────────
def test_should_auto_resume_accepts_transport_partial():
    ok, why = should_auto_resume(
        finish="length", content="", thinking="raisonnement en cours…",
        had_tool_calls=False, partial=True, resumes_done=0,
        think_tokens_done=100, ctx_size=32768, window_tokens=1000,
    )
    assert ok is True
    assert "coupure transport" in why


async def test_transport_partial_thinking_resumes_in_run(monkeypatch):
    """Flux coupé en plein raisonnement (partiel de transport, zéro prose) :
    la boucle REPREND in-run au lieu de terminer le run en « Continuer »."""
    _patch_env(monkeypatch)
    seq = {"n": 0}

    async def _fake_stream(messages, tools_payload, on_thinking_token=None, **kw):
        seq["n"] += 1
        if seq["n"] == 1:
            if on_thinking_token:
                await on_thinking_token("je réfléchissais quand le flux a coupé ")
            return {"choices": [{"finish_reason": "length", "message": {
                "role": "assistant", "content": None, "tool_calls": None}}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 8},
                "timings": {}, "partial": True,
                "reasoning_channel_native": True}
        assert kw.get("resume_think"), "la reprise doit porter le thinking accumulé"
        return _final_msg("réponse après reprise transport")

    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", _fake_stream)
    events, on_event = _capture()
    final, _ev, metrics = await _cwt.run_chat_multi_mcp(
        [{"role": "user", "content": "go"}],
        mcp_configs=[], builtin_tools={}, username="u",
        on_event=on_event,
    )
    assert seq["n"] == 2
    assert "après reprise transport" in final
    assert not metrics.get("ended_with_error")


# ── erreur LLM définitive : le partiel est désormais REPRENABLE ─────────────
async def test_llm_failure_with_partial_arms_truncated(monkeypatch):
    """Échec LLM après retries avec du texte déjà produit aux tours
    précédents : ``metrics.truncated`` armé → la route pose le flag et le
    front affiche « Continuer » (avant : aucun chemin de reprise)."""
    _patch_env(monkeypatch)
    seq = {"n": 0}

    async def _fake_stream(messages, tools_payload, on_content_token=None, **kw):
        seq["n"] += 1
        if seq["n"] == 1:
            # Tour d'outil AVEC prose : un partiel existera dans l'historique.
            return _tool_call_msg("noop", content="Début de l'analyse.")
        if on_content_token:
            await on_content_token("token ")   # bloque le retry hoquet
        raise RuntimeError("panne moteur définitive")

    async def _noop(args):
        return json.dumps({"ok": True})

    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", _fake_stream)
    _events, on_event = _capture()
    final, _ev, metrics = await _cwt.run_chat_multi_mcp(
        [{"role": "user", "content": "go"}],
        mcp_configs=[], builtin_tools=_builtin("noop", _noop), username="u",
        on_event=on_event,
    )
    assert metrics.get("ended_with_error") is True
    assert metrics.get("truncated") is True
    # (2026-09-21, audit H1) Le partiel est le texte que l'utilisateur voyait
    # au moment de la coupure. La narration du tour précédent (« Début de
    # l'analyse. ») est déjà dans ``tool_history`` — la reprendre comme
    # réponse la doublait au rechargement et perdait le texte interrompu.
    assert final.strip() == "token"
    assert any("analyse" in (m.get("content") or "").lower()
               for m in metrics.get("tool_history") or [])


# ── tool_calls hostiles : ignorés, pas fatals ────────────────────────────────
async def test_malformed_tool_call_entries_are_skipped(monkeypatch):
    """Un tool_call non-dict ou au name null (provider non-llama, réponse
    malformée) ne doit plus tuer le tour : entrée ignorée, le reste du lot
    s'exécute."""
    _patch_env(monkeypatch)
    seq = {"n": 0}

    async def _fake_stream(messages, tools_payload, **kw):
        seq["n"] += 1
        if seq["n"] == 1:
            return {"choices": [{"finish_reason": "tool_calls", "message": {
                "role": "assistant", "content": "",
                "tool_calls": [
                    "pas-un-dict",
                    {"id": "c0", "type": "function", "function": {"name": None}},
                    {"id": "c1", "type": "function",
                     "function": {"name": "noop", "arguments": "{}"}},
                ]}}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 1}, "timings": {}}
        return _final_msg("fini")

    ran = {"noop": 0}

    async def _noop(args):
        ran["noop"] += 1
        return json.dumps({"ok": True})

    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", _fake_stream)
    _events, on_event = _capture()
    final, _ev, _metrics = await _cwt.run_chat_multi_mcp(
        [{"role": "user", "content": "go"}],
        mcp_configs=[], builtin_tools=_builtin("noop", _noop), username="u",
        on_event=on_event,
    )
    assert "fini" in final
    assert ran["noop"] == 1
