# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_harness_timeouts.py — durcissement boucle outillée (R10).

  • (a) un builtin awaitable suspendu est BORNÉ (asyncio.wait_for) → JSON timeout,
        la boucle continue au lieu de geler ; le builtin ``task`` reçoit une borne
        ≥ TASK_CHILD_TIMEOUT_S (on ne tue pas un sous-agent légitime).
  • (b) un hoquet du moteur à iter>0 SANS token émis → 1 nouvelle tentative
        (event ``info``) ; avec des tokens déjà streamés → PAS de retry (partiel).
  • (c) budget mur d'horloge OPT-IN dépassé → event ``notice`` + tour de synthèse.

Aucun réseau : le stream LLM et les helpers d'availability/vision/ctx sont
monkeypatchés (mêmes stubs que test_continue_truncation_and_cancel).
"""
from __future__ import annotations

import asyncio
import json

import pytest

from llm_core import _chat_with_tools as _cwt


async def _anoop(*_a, **_k):
    return None


async def _avision(*_a, **_k):
    return False


async def _actx(*_a, **_k):
    return 8192


def _patch_env(monkeypatch):
    monkeypatch.setattr(_cwt, "verify_llm_availability", _anoop)
    monkeypatch.setattr(_cwt, "_model_supports_vision", _avision)
    monkeypatch.setattr(_cwt, "get_model_context_size", _actx)


def _final_msg(content):
    return {
        "choices": [{"finish_reason": "stop",
                     "message": {"role": "assistant", "content": content, "tool_calls": None}}],
        "usage": {"prompt_tokens": 4, "completion_tokens": 2}, "timings": {},
    }


def _builtin(name, handler):
    """Un builtin au format attendu : {name: {definition, handler}}."""
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


# ── (a) timeout des builtins ──────────────────────────────────────────────────
async def test_builtin_timeout_returns_json_and_loop_continues(monkeypatch):
    _patch_env(monkeypatch)
    monkeypatch.setattr(_cwt, "_tool_timeout_s", lambda name: 0.05)

    async def _slow_builtin(args):
        await asyncio.sleep(5)          # dépasse la borne (0.05 s)
        return json.dumps({"ok": True})

    calls = {"n": 0}

    async def _fake_stream(messages, tools_payload, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            # 1er tour : demande l'outil lent (builtin).
            return {"choices": [{"finish_reason": "tool_calls", "message": {
                "role": "assistant", "content": "",
                "tool_calls": [{"id": "c1", "type": "function",
                                "function": {"name": "slowtool", "arguments": "{}"}}]}}],
                "usage": {"prompt_tokens": 5, "completion_tokens": 1}, "timings": {}}
        # tour suivant : le modèle voit le JSON timeout et conclut.
        return _final_msg("fini malgré le timeout")

    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", _fake_stream)

    events, on_event = _capture()
    final, _ev, metrics = await _cwt.run_chat_multi_mcp(
        [{"role": "user", "content": "go"}],
        mcp_configs=[], builtin_tools=_builtin("slowtool", _slow_builtin), username="u",
        on_event=on_event,
    )
    # La boucle n'a pas gelé : elle a repris et conclu.
    assert "malgré le timeout" in final
    # Le tool_result vu par le modèle porte l'erreur timeout.
    tr = [e for e in events if e.get("type") == "tool_result"]
    assert any("timeout" in json.dumps(e, ensure_ascii=False) for e in tr)


def test_task_builtin_gets_generous_timeout(monkeypatch):
    # Le builtin ``task`` doit recevoir une borne ≥ TASK_CHILD_TIMEOUT_S (+marge),
    # sinon on couperait un sous-agent encore dans son budget.
    import shared_infra.config as cfg
    monkeypatch.setattr(cfg, "TASK_CHILD_TIMEOUT_S", 1800, raising=False)
    assert _cwt._tool_timeout_s("task") >= 1800 + 60
    # Un outil quelconque garde le défaut global (bien plus court).
    assert _cwt._tool_timeout_s("un_outil_x") < 1800


# ── (b) retry sur hoquet moteur à iter>0 ──────────────────────────────────────
async def test_llm_hiccup_retry_when_no_tokens(monkeypatch):
    _patch_env(monkeypatch)
    seq = {"n": 0}

    async def _fake_stream(messages, tools_payload, **kw):
        seq["n"] += 1
        if seq["n"] == 1:
            # iter 0 : un tour d'outil « vide » pour passer à iter>0 sans texte.
            return {"choices": [{"finish_reason": "tool_calls", "message": {
                "role": "assistant", "content": "",
                "tool_calls": [{"id": "c1", "type": "function",
                                "function": {"name": "noop", "arguments": "{}"}}]}}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 1}, "timings": {}}
        if seq["n"] == 2:
            raise RuntimeError("hoquet moteur transitoire")   # iter>0, aucun token émis
        return _final_msg("ok après reprise")

    async def _noop_builtin(args):
        return json.dumps({"ok": True})

    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", _fake_stream)
    events, on_event = _capture()
    final, _ev, metrics = await _cwt.run_chat_multi_mcp(
        [{"role": "user", "content": "go"}],
        mcp_configs=[], builtin_tools=_builtin("noop", _noop_builtin), username="u",
        on_event=on_event,
    )
    assert "après reprise" in final
    assert seq["n"] == 3                       # échec puis reprise réussie
    assert any(e.get("type") == "info" and "Hoquet" in (e.get("text") or "")
               for e in events)


async def test_llm_hiccup_no_retry_after_tokens(monkeypatch):
    # Si des tokens ont DÉJÀ été streamés au tour qui échoue, PAS de retry (on ne
    # duplique pas le texte) → le partiel est conservé et le tour se termine.
    _patch_env(monkeypatch)
    seq = {"n": 0}

    async def _fake_stream(messages, tools_payload, on_content_token=None, **kw):
        seq["n"] += 1
        if seq["n"] == 1:
            return {"choices": [{"finish_reason": "tool_calls", "message": {
                "role": "assistant", "content": "",
                "tool_calls": [{"id": "c1", "type": "function",
                                "function": {"name": "noop", "arguments": "{}"}}]}}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 1}, "timings": {}}
        # iter>0 : émet un token AVANT d'échouer → pas de retry autorisé.
        if on_content_token:
            await on_content_token("Voici le début ")
        raise RuntimeError("échec après un token")

    async def _noop_builtin(args):
        return json.dumps({"ok": True})

    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", _fake_stream)
    events, on_event = _capture()
    final, _ev, metrics = await _cwt.run_chat_multi_mcp(
        [{"role": "user", "content": "go"}],
        mcp_configs=[], builtin_tools=_builtin("noop", _noop_builtin), username="u",
        on_event=on_event,
    )
    assert seq["n"] == 2                        # échec, PAS de 3e appel (pas de retry)
    assert metrics.get("ended_with_error") is True
    assert not any(e.get("type") == "info" and "Hoquet" in (e.get("text") or "")
                   for e in events)


# ── (c) budget mur d'horloge opt-in ───────────────────────────────────────────
async def test_wall_clock_budget_triggers_wrapup(monkeypatch):
    _patch_env(monkeypatch)
    import shared_infra.config as cfg
    monkeypatch.setattr(cfg, "LLAMA_TOOL_LOOP_MAX_S", 0.01, raising=False)   # dépassé d'emblée

    async def _noop_builtin(args):
        await asyncio.sleep(0.05)               # pousse le temps au-delà du budget
        return json.dumps({"ok": True})

    seq = {"n": 0}

    async def _fake_stream(messages, tools_payload, **kw):
        seq["n"] += 1
        if seq["n"] == 1:
            return {"choices": [{"finish_reason": "tool_calls", "message": {
                "role": "assistant", "content": "",
                "tool_calls": [{"id": "c1", "type": "function",
                                "function": {"name": "noop", "arguments": "{}"}}]}}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 1}, "timings": {}}
        # tour de synthèse (chemin « limite atteinte »).
        return _final_msg("synthèse finale")

    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", _fake_stream)
    events, on_event = _capture()
    final, _ev, metrics = await _cwt.run_chat_multi_mcp(
        [{"role": "user", "content": "go"}],
        mcp_configs=[], builtin_tools=_builtin("noop", _noop_builtin), username="u",
        on_event=on_event,
    )
    assert any(e.get("type") == "notice" and "budget de temps" in (e.get("message") or "")
               for e in events)


# ── (2026-09-21) partiel d'erreur : jamais la réponse d'un tour précédent ────
async def test_partiel_d_erreur_ne_reprend_pas_l_ancienne_reponse(monkeypatch):
    """Le partiel était le dernier ``assistant`` non vide de TOUT l'historique :
    un run n'ayant produit que des tool_calls renvoyait la réponse du tour
    précédent, persistée comme nouvelle réponse avec « Continuer »."""
    _patch_env(monkeypatch)
    _vrai_sleep = asyncio.sleep

    async def _sleep_rapide(_d, *a, **k):
        await _vrai_sleep(0)
    monkeypatch.setattr(_cwt.asyncio, "sleep", _sleep_rapide)
    seq = {"n": 0}

    async def _fake_stream(messages, tools_payload, **kw):
        seq["n"] += 1
        if seq["n"] == 1:
            return {"choices": [{"finish_reason": "tool_calls", "message": {
                "role": "assistant", "content": "",
                "tool_calls": [{"id": "c1", "type": "function",
                                "function": {"name": "noop", "arguments": "{}"}}]}}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 1}, "timings": {}}
        raise RuntimeError("moteur tombé")

    async def _noop_builtin(args):
        return json.dumps({"ok": True})

    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", _fake_stream)
    events, on_event = _capture()
    final, _ev, metrics = await _cwt.run_chat_multi_mcp(
        [{"role": "user", "content": "q1"},
         {"role": "assistant", "content": "ANCIENNE RÉPONSE"},
         {"role": "user", "content": "go"}],
        mcp_configs=[], builtin_tools=_builtin("noop", _noop_builtin), username="u",
        on_event=on_event,
    )
    assert metrics.get("ended_with_error") is True
    assert "ANCIENNE" not in (final or "")
    assert metrics.get("truncated") is False
    assert "thinking" in metrics


async def test_partiel_d_erreur_garde_le_texte_streame(monkeypatch):
    _patch_env(monkeypatch)
    seq = {"n": 0}

    async def _fake_stream(messages, tools_payload, on_content_token=None, **kw):
        seq["n"] += 1
        if seq["n"] == 1:
            return {"choices": [{"finish_reason": "tool_calls", "message": {
                "role": "assistant", "content": "",
                "tool_calls": [{"id": "c1", "type": "function",
                                "function": {"name": "noop", "arguments": "{}"}}]}}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 1}, "timings": {}}
        if on_content_token:
            await on_content_token("Voici le début ")
        raise RuntimeError("échec après un token")

    async def _noop_builtin(args):
        return json.dumps({"ok": True})

    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", _fake_stream)
    events, on_event = _capture()
    final, _ev, metrics = await _cwt.run_chat_multi_mcp(
        [{"role": "user", "content": "q1"},
         {"role": "assistant", "content": "ANCIENNE RÉPONSE"},
         {"role": "user", "content": "go"}],
        mcp_configs=[], builtin_tools=_builtin("noop", _noop_builtin), username="u",
        on_event=on_event,
    )
    assert final.strip() == "Voici le début"
    assert metrics.get("truncated") is True
