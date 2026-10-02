# SPDX-License-Identifier: MIT
"""tests/llm_core/test_lost_tool_call_nudge.py — appel d'outil perdu hors canal.

Incident prod 2026-07-12 : le modèle émet son appel en dialecte XML
(<tool_call><function=…><parameter=…>) ; le parseur natif du serveur consomme
les balises ouvrantes, échoue, et seules les FERMANTES atteignent le client —
dans le canal reasoning. Résultat avant fix : tour mort après la phrase
d'annonce, markup brut promu dans la bulle
(« Je vais créer… </parameter></function></tool_call> »).

Contrat :
- A1-bis : aucun tool call + aucune prose + traces de markup dans le reasoning
  → relance bornée (_LOST_TOOL_CALL_NUDGE, budget partagé avec A1) ;
- à l'épuisement du budget, la promotion thinking→réponse passe par
  _strip_tool_call_markup (jamais de markup dans la bulle) ;
- promotion vidée par le strip (markup pur) → non promu, truncated_in_think.
"""
from __future__ import annotations

import pytest

import llm_core._chat_with_tools as _cwt
import llm_core._target as _tgt
from llm_core import _model_info

INTRO = "Je vais créer un projet Python avec des tests unitaires."
LEAKED = INTRO + "\n</parameter>\n</function>\n</tool_call>"
ANSWER = "Projet créé : calculate/operations.py + tests. Tout est vert."


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


def _lost_call_response():
    return {
        "choices": [{"finish_reason": "stop", "message": {
            "role": "assistant", "content": "", "tool_calls": None}}],
        "usage": {"prompt_tokens": 100, "completion_tokens": 35},
        "timings": {},
    }


async def _run(monkeypatch, *, replies, leaked=LEAKED):
    """``replies`` : liste de 'lost' (reasoning + markup, rien d'exécutable)
    ou de textes = vraie réponse finale renvoyée par le fake."""
    _patch_env(monkeypatch)
    seen_msgs: list = []
    calls = {"n": 0}

    async def _fake_stream(messages, tools_payload, **kw):
        calls["n"] += 1
        seen_msgs.append([dict(m) for m in messages])
        kind = replies[min(calls["n"], len(replies)) - 1]
        if kind == "lost":
            on_think = kw.get("on_thinking_token")
            if on_think:
                await on_think(leaked)
            return _lost_call_response()
        return {
            "choices": [{"finish_reason": "stop", "message": {
                "role": "assistant", "content": kind, "tool_calls": None}}],
            "usage": {"prompt_tokens": 120, "completion_tokens": 40},
            "timings": {},
        }

    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", _fake_stream)

    async def _bloc(fargs):
        return {"ok": True}

    events = []

    async def _on_event(ev):
        events.append(ev)

    final, _evs, metrics = await _cwt.run_chat_multi_mcp(
        [{"role": "user", "content": "Crée le projet calculate avec des tests."}],
        [], on_event=_on_event, username="u",
        builtin_tools={"write_file": {
            "definition": {"type": "function", "function": {
                "name": "write_file", "parameters": {"type": "object"}}},
            "handler": _bloc}},
        chat_id="c-lost",
    )
    return final, events, metrics, calls, seen_msgs


async def test_relance_apres_appel_perdu(monkeypatch):
    final, _events, metrics, calls, seen = await _run(
        monkeypatch, replies=["lost", ANSWER])
    assert calls["n"] == 2                       # 1 tour perdu + 1 relance
    assert final == ANSWER
    # La relance a injecté la consigne de ré-émission NATIVE.
    nudges = [m for m in seen[1]
              if m.get("role") == "user"
              and "NO tool call" in str(m.get("content", ""))]
    assert len(nudges) == 1
    assert "</tool_call>" not in final


async def test_promotion_strippee_apres_cap_de_relances(monkeypatch):
    # Toutes les tentatives sont perdues : 1 tour + 2 relances (cap A1), puis
    # le tour final promeut le reasoning en réponse — SANS le markup.
    final, _events, metrics, calls, _seen = await _run(
        monkeypatch, replies=["lost", "lost", "lost"])
    assert calls["n"] == 3                       # cap _MALFORMED_RETRY_MAX = 2
    assert final == INTRO                        # prose promue, markup strippé
    assert "</tool_call>" not in final and "</parameter>" not in final


async def test_markup_pur_non_promu(monkeypatch):
    # Reasoning = markup PUR (pas de prose) : après le cap, le strip vide la
    # promotion → rien dans la bulle, thinking gardé + Continuer armé.
    final, _events, metrics, _calls, _seen = await _run(
        monkeypatch, replies=["lost", "lost", "lost"],
        leaked="</parameter>\n</function>\n</tool_call>")
    assert final == ""
    assert metrics["truncated_in_think"] is True
