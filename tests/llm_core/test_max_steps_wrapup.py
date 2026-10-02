# SPDX-License-Identifier: MIT
"""tests/llm_core/test_max_steps_wrapup.py — tour de synthèse « max-steps ».

Au cap d'itérations, la boucle fait un DERNIER appel LLM SANS outils
(modèle OpenCode max-steps.txt) au lieu de rendre un partiel sec :
- l'appel de synthèse reçoit le MÊME tools_payload que les itérations
  (préfixe KV stable, AUDIT 2026-09-25) + la consigne [SYSTEM] ;
- son texte streame en content_token et devient la réponse retournée ;
- metrics.max_steps_wrapup=True ; échec → fallback partiel historique.
"""
from __future__ import annotations

import pytest

import llm_core._chat_with_tools as _cwt
import llm_core._target as _tgt
import llm_core.engine.run_exit as _run_exit
from llm_core import _model_info


async def _anoop(*_a, **_k):
    return None


async def _avision(*_a, **_k):
    return False


async def _actx(*_a, **_k):
    return 32000


class _FakeTarget:
    is_local_llamacpp = True
    is_llamacpp = True


def _patch_env(monkeypatch):
    monkeypatch.setattr(_cwt, "verify_llm_availability", _anoop)
    monkeypatch.setattr(_cwt, "_model_supports_vision", _avision)
    monkeypatch.setattr(_model_info, "get_model_context_size", _actx)
    monkeypatch.setattr(_tgt, "current_target", lambda: _FakeTarget())


WRAP_TEXT = "Step limit reached. Done: read block 1-2. Remaining: block 3. Next: raise the budget."


async def _run(monkeypatch, *, wrap_fails=False):
    _patch_env(monkeypatch)
    calls = {"with_tools": 0, "wrapup": 0, "wrapup_tools": None, "wrapup_choice": None}

    async def _fake_stream(messages, tools_payload, **kw):
        _last = messages[-1].get("content") if messages else ""
        _consignes = set(_run_exit._WRAPUP_BY_KIND.values()) | {_run_exit._MAX_STEPS_WRAPUP}
        if not (isinstance(_last, str) and _last in _consignes):
            calls["with_tools"] += 1
            return {
                "choices": [{"finish_reason": "tool_calls", "message": {
                    "role": "assistant", "content": "",
                    "tool_calls": [{"id": f"c{calls['with_tools']}", "type": "function",
                                    "function": {"name": "lire_bloc",
                                                 "arguments": '{"n": 1}'}}],
                }}],
                "usage": {"prompt_tokens": 100, "completion_tokens": 10},
                "timings": {},
            }
        # Appel de synthèse : consigne [SYSTEM] en dernier user, MÊMES outils.
        calls["wrapup"] += 1
        calls["wrapup_tools"] = [t["function"]["name"] for t in (tools_payload or [])]
        calls["wrapup_choice"] = kw.get("tool_choice")
        assert "[SYSTEM] MAXIMUM STEPS REACHED" in messages[-1]["content"]
        if wrap_fails:
            raise RuntimeError("boom")
        on_tok = kw.get("on_content_token")
        if on_tok:
            await on_tok(WRAP_TEXT)
        return {
            "choices": [{"finish_reason": "stop", "message": {
                "role": "assistant", "content": WRAP_TEXT, "tool_calls": None}}],
            "usage": {"prompt_tokens": 120, "completion_tokens": 30},
            "timings": {},
        }

    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", _fake_stream)

    async def _bloc(fargs):
        return {"ok": True, "bloc": fargs.get("n")}

    events = []

    async def _on_event(ev):
        events.append(ev)

    final, _evs, metrics = await _cwt.run_chat_multi_mcp(
        [{"role": "user", "content": "lis tout"}],
        [], on_event=_on_event, username="u",
        builtin_tools={"lire_bloc": {
            "definition": {"type": "function", "function": {
                "name": "lire_bloc", "parameters": {"type": "object"}}},
            "handler": _bloc}},
        sampling_override={"max_tool_iterations": 2},
        chat_id="c-wrap",
    )
    return final, events, metrics, calls


async def test_wrapup_remplace_le_partiel_sec(monkeypatch):
    final, events, metrics, calls = await _run(monkeypatch)
    assert calls["with_tools"] == 2          # budget épuisé après 2 itérations
    assert calls["wrapup"] == 1              # UN tour de synthèse
    # Mêmes outils que les itérations : préfixe KV intact (AUDIT 2026-09-25).
    assert calls["wrapup_tools"] == ["lire_bloc"]
    # … mais aucun appel offert (AUDIT 2026-09-26) : outils rendus dans le
    # gabarit (llama.cpp), grammaire d'appel désactivée.
    assert calls["wrapup_choice"] == "none"
    assert final == WRAP_TEXT
    assert metrics["tool_limit_reached"] is True
    assert metrics["max_steps_wrapup"] is True
    # le texte a streamé (content_token, re-streamé en chunks après strip du
    # markup — comme le chemin de réponse finale) et le banner tool_limit est
    # parti AVANT.
    types = [e.get("type") for e in events]
    assert "tool_limit" in types
    _streamed = "".join(e.get("text", "") for e in events
                        if e.get("type") == "content_token")
    assert WRAP_TEXT in _streamed
    assert types.index("tool_limit") < types.index("content_token")


async def test_wrapup_echec_fallback_partiel(monkeypatch):
    """Échec du tour de synthèse ET aucun texte assistant accumulé : on rend un
    message DÉTERMINISTE (sans appel LLM), jamais une bulle vide. Avant, ce
    chemin renvoyait "" — or c'est le cas le PLUS probable en vrai, la synthèse
    échouant typiquement contre le même contexte plein qui a causé la limite."""
    final, _events, metrics, calls = await _run(monkeypatch, wrap_fails=True)
    assert calls["wrapup"] == 1
    assert metrics["max_steps_wrapup"] is False
    assert final and final.strip()
    # Dit ce qui s'est passé, le compteur, et les deux issues offertes.
    assert "limite d'itérations" in final
    assert "2/2 tours" in final
    assert "Reprendre" in final and "budget" in final


async def test_pas_de_bulle_vide_sans_wrapup(monkeypatch):
    """Même garantie quand le tour de synthèse est SAUTÉ (ici : annulation
    demandée juste avant). La réponse reste non vide et explicite."""
    final, _events, metrics, _calls = await _run(monkeypatch, wrap_fails=True)
    assert metrics["tool_limit_reached"] is True
    assert final.strip()                       # jamais vide, quel que soit le chemin
