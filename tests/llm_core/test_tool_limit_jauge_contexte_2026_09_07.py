# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_tool_limit_jauge_contexte_2026_09_07.py — sortie « limite
d'outils » : jauge de contexte et cause réelle de l'arrêt.

Deux défauts constatés en production (2026-09-07) : au cap d'itérations, l'UI
déverrouillait la bannière « contexte du modèle presque plein (100 %) » alors
que la fenêtre n'était pas pleine, et le bandeau annonçait « 200/200 tours »
même quand la boucle s'était arrêtée pour une AUTRE cause.

  • Le chemin « limite atteinte » n'exposait pas ``last_prompt_tokens`` : la
    route retombait sur ``input_tokens`` — un CUMUL de toutes les itérations
    (des millions de tokens) — et poussait une jauge à 100 %.
  • Les sorties forcées (contexte saturé, mur d'horloge, boucle d'action)
    écrasaient ``effective_iter`` avec le budget pour sortir de la boucle : le
    compteur exposé (« 200/200 tours ») mentait, et la cause était perdue.
  • ``finish=length`` sur un tool call était TOUJOURS lu « fenêtre de
    contexte pleine » : c'est le plus souvent le plafond de GÉNÉRATION
    (max_tokens) qui coupe une écriture trop longue, contexte à 20 %.

Aucun réseau : stream LLM + availability/vision/ctx monkeypatchés.
"""
from __future__ import annotations

import asyncio
import json

import pytest

import llm_core._ctx_window as _cw
import llm_core.engine.run_exit as _run_exit
from llm_core import _chat_with_tools as _cwt, _model_info


async def _anoop(*_a, **_k):
    return None


async def _avision(*_a, **_k):
    return False


N_CTX = 32_000


def _patch_env(monkeypatch, n_ctx: int = N_CTX):
    async def _actx(*_a, **_k):
        return n_ctx

    monkeypatch.setattr(_cwt, "verify_llm_availability", _anoop)
    monkeypatch.setattr(_cwt, "_model_supports_vision", _avision)
    monkeypatch.setattr(_model_info, "get_model_context_size", _actx)
    monkeypatch.setattr(_cw, "resolve_context_window", _actx)


def _tc(cid, name="mytool", args="{}"):
    return {"id": cid, "type": "function",
            "function": {"name": name, "arguments": args}}


def _round(tool_calls=None, content=None, finish=None, *, pt=0, ct=0):
    return {
        "choices": [{
            "finish_reason": finish or ("tool_calls" if tool_calls else "stop"),
            "message": {"role": "assistant", "content": content,
                        "tool_calls": tool_calls},
        }],
        "usage": {"prompt_tokens": pt, "completion_tokens": ct},
        "timings": {},
    }


def _builtin(handler=None):
    return {
        "mytool": {
            "definition": {"type": "function",
                           "function": {"name": "mytool", "parameters": {}}},
            "handler": handler or (lambda _args: json.dumps({"ok": True})),
        },
    }


def _is_wrapup(messages) -> bool:
    """Dernier message = une consigne de SYNTHÈSE (et non un nudge mi-tour)."""
    _last = messages[-1].get("content") if messages else ""
    _consignes = set(_run_exit._WRAPUP_BY_KIND.values()) | {_run_exit._MAX_STEPS_WRAPUP}
    return isinstance(_last, str) and _last in _consignes


class _ScriptedStream:
    """Rejoue ``script`` dans l'ordre ; les appels SANS outils (tour de
    synthèse) rendent ``wrapup``."""

    def __init__(self, script, wrapup=None):
        self.script = list(script)
        self.wrapup = wrapup
        self.payloads = []
        self.wrap_payloads = []

    async def __call__(self, messages, tools_payload, **kw):
        # Synthèse reconnue à sa consigne [SYSTEM] : elle reçoit désormais les
        # MÊMES outils que les itérations (AUDIT 2026-09-25).
        if _is_wrapup(messages) and self.wrapup is not None:
            self.wrap_payloads.append([dict(m) for m in messages])
            return self.wrapup
        self.payloads.append([dict(m) for m in messages])
        return self.script[len(self.payloads) - 1]


async def _run(monkeypatch, stream, **kw):
    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", stream)
    seen = []

    async def _on_event(ev):
        seen.append(ev)

    final, _events, metrics = await _cwt.run_chat_multi_mcp(
        [{"role": "user", "content": "fais"}],
        mcp_configs=[], builtin_tools=_builtin(), username="u",
        on_event=_on_event, **kw,
    )
    return final, seen, metrics


def _limit_event(seen):
    evs = [e for e in seen if isinstance(e, dict) and e.get("type") == "tool_limit"]
    assert len(evs) == 1, evs
    return evs[0]


# ── 1. Cap atteint : la jauge doit voir le DERNIER prompt, pas le cumul ──────
async def test_limite_atteinte_expose_last_prompt_tokens(monkeypatch):
    _patch_env(monkeypatch)
    stream = _ScriptedStream(
        [_round(tool_calls=[_tc("a")], pt=1000, ct=10),
         _round(tool_calls=[_tc("b")], pt=1500, ct=10)],
        wrapup=_round(content="synthèse", pt=1800, ct=30),
    )
    final, seen, metrics = await _run(
        monkeypatch, stream, sampling_override={"max_tool_iterations": 2})
    assert final == "synthèse"
    assert metrics["tool_limit_reached"] is True
    # Cumul des itérations (facturation) — ce N'EST PAS une occupation.
    assert metrics["input_tokens"] == 1000 + 1500 + 1800
    # Occupation réelle = dernier prompt envoyé (ici celui de la synthèse).
    assert metrics["last_prompt_tokens"] == 1800
    assert metrics["tool_limit_stop_reason"] == "steps"
    ev = _limit_event(seen)
    assert ev["iterations"] == 2 and ev["max_iterations"] == 2
    assert ev["stop_reason"] == "steps"


async def test_limite_atteinte_sans_synthese_garde_le_dernier_prompt(monkeypatch):
    _patch_env(monkeypatch)

    class _Boom(_ScriptedStream):
        async def __call__(self, messages, tools_payload, **kw):
            if _is_wrapup(messages):
                raise RuntimeError("synthèse KO")
            return await super().__call__(messages, tools_payload, **kw)

    stream = _Boom([_round(tool_calls=[_tc("a")], pt=900, ct=5),
                    _round(tool_calls=[_tc("b")], pt=1400, ct=5)])
    _final, _seen, metrics = await _run(
        monkeypatch, stream, sampling_override={"max_tool_iterations": 2})
    assert metrics["tool_limit_reached"] is True
    assert metrics["last_prompt_tokens"] == 1400


# ── 2. Route : la jauge ne retombe JAMAIS sur le cumul du chemin outils ──────
def test_jauge_route_ignore_le_cumul_du_chemin_outils():
    from chatbot_app.turn.execution import _kv_gauge_used_tokens
    # Chemin outils, cap atteint SANS last_prompt_tokens (ancien contrat) :
    # le cumul ne doit pas devenir une occupation → jauge masquée.
    assert _kv_gauge_used_tokens({
        "input_tokens": 4_300_000, "submitted_input_tokens": 4_300_000,
        "tool_limit_reached": True}) == 0
    # Chemin outils nominal : le dernier prompt gagne sur le cumul.
    assert _kv_gauge_used_tokens({
        "input_tokens": 4300, "submitted_input_tokens": 4300,
        "last_prompt_tokens": 1800}) == 1800
    # Chat classique (un seul appel) : input_tokens EST l'occupation.
    assert _kv_gauge_used_tokens({"input_tokens": 900}) == 900
    assert _kv_gauge_used_tokens({}) == 0
    assert _kv_gauge_used_tokens(None) == 0


# ── 3. Coupes finish=length : plafond de génération ≠ contexte plein ─────────
async def test_streak_plafond_generation_pas_contexte(monkeypatch):
    _patch_env(monkeypatch)
    # 4 000 + 8 000 tokens sur 32 000 : la fenêtre est à 37 %, c'est le
    # plafond de sortie (max_tokens) qui a coupé l'écriture.
    cut = dict(tool_calls=[_tc("a")], finish="length", pt=4000, ct=8000)
    stream = _ScriptedStream([_round(**cut), _round(**cut), _round(**cut)],
                             wrapup=_round(content="", pt=4100, ct=1))
    final, seen, metrics = await _run(monkeypatch, stream)
    assert len(stream.payloads) == 3
    assert metrics["tool_limit_reached"] is True
    assert metrics.get("context_saturated") is None
    assert metrics.get("gen_cap_stop") is True
    assert metrics["tool_limit_stop_reason"] == "gen_cap"
    # Le compteur exposé est le VRAI (0 tour productif), pas le budget.
    ev = _limit_event(seen)
    assert ev["iterations"] == 0 and ev["stop_reason"] == "gen_cap"
    assert metrics["tool_limit_effective_iters"] == 0
    # Aucun message ne parle de contexte plein/saturé — ni les toasts par
    # coupe (le front y greffe un bouton « Compacter » dès qu'il lit
    # « contexte »), ni l'arrêt, ni la réponse.
    for e in seen:
        if not isinstance(e, dict):
            continue
        if e.get("type") == "info":
            assert "contexte" not in str(e.get("text", "")).lower()
        if e.get("type") == "notice":
            assert "satur" not in str(e.get("message", "")).lower()
    assert "satur" not in final.lower()
    assert "génération" in final.lower()
    # La jauge de contexte reste juste : dernier prompt réellement envoyé
    # (sans outil abouti, le tour de synthèse est sauté → celui de la 3e
    # itération), jamais le cumul (12 000 ici).
    assert metrics["last_prompt_tokens"] == 4000
    assert metrics["input_tokens"] == 12_000


async def test_streak_contexte_reellement_plein(monkeypatch):
    _patch_env(monkeypatch)
    cut = dict(tool_calls=[_tc("a")], finish="length", pt=30_000, ct=1_800)
    stream = _ScriptedStream([_round(**cut), _round(**cut), _round(**cut)],
                             wrapup=_round(content="", pt=30_100, ct=1))
    final, seen, metrics = await _run(monkeypatch, stream)
    assert metrics["tool_limit_reached"] is True
    assert metrics.get("context_saturated") is True
    assert metrics.get("gen_cap_stop") is None
    assert metrics["tool_limit_stop_reason"] == "ctx_saturated"
    ev = _limit_event(seen)
    assert ev["iterations"] == 0 and ev["stop_reason"] == "ctx_saturated"
    assert any(e.get("type") == "info" and "contexte" in str(e.get("text")).lower()
               for e in seen if isinstance(e, dict))
    assert "satur" in final.lower()


async def test_streak_fenetre_inconnue_ne_pretend_pas_contexte_plein(monkeypatch):
    _patch_env(monkeypatch, n_ctx=0)
    cut = dict(tool_calls=[_tc("a")], finish="length", pt=4000, ct=8000)
    stream = _ScriptedStream([_round(**cut), _round(**cut), _round(**cut)],
                             wrapup=_round(content="", pt=4100, ct=1))
    final, _seen, metrics = await _run(monkeypatch, stream)
    assert metrics.get("context_saturated") is None
    assert metrics["tool_limit_stop_reason"] == "gen_cap"


# ── 4. Mur d'horloge : compteur réel, cause conservée ────────────────────────
async def test_wallclock_compteur_reel_et_cause(monkeypatch):
    _patch_env(monkeypatch)
    import shared_infra.config as cfg
    monkeypatch.setattr(cfg, "LLAMA_TOOL_LOOP_MAX_S", 0.01, raising=False)

    async def _slow(_args):
        await asyncio.sleep(0.05)
        return json.dumps({"ok": True})

    stream = _ScriptedStream([_round(tool_calls=[_tc("a")], pt=100, ct=3)],
                             wrapup=_round(content="fin", pt=120, ct=3))
    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", stream)
    seen = []

    async def _on_event(ev):
        seen.append(ev)

    _final, _e, metrics = await _cwt.run_chat_multi_mcp(
        [{"role": "user", "content": "go"}],
        mcp_configs=[], builtin_tools=_builtin(_slow), username="u",
        on_event=_on_event, sampling_override={"max_tool_iterations": 50},
    )
    assert metrics["tool_limit_reached"] is True
    assert metrics["tool_limit_stop_reason"] == "wallclock"
    ev = _limit_event(seen)
    assert ev["iterations"] == 1 and ev["max_iterations"] == 50
    assert ev["stop_reason"] == "wallclock"
    assert metrics["tool_limit_effective_iters"] == 1
