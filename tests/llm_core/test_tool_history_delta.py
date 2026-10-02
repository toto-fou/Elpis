# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_tool_history_delta.py — capture DELTA de la tool_history.

Correctif « génération interrompue » 2026-07-27 : la boucle persiste désormais
UNIQUEMENT le travail de CE run (``_run_tool_history``), marqué
``tool_history_delta`` — plus de capture cumulative depuis le 1er message
agentique (qui, ré-expandée à chaque bulle par la route, doublait le contexte
à chaque tour jusqu'à saturer n_ctx).

Couvre :
  • delta exact sur le chemin natif (2 rounds) — marqueur posé, AUCUNE entrée
    ``user`` même quand des messages de contrôle mi-tour ont été injectés
    (harness_status éphémère) ;
  • delta sur le chemin legacy (ids synthétiques legacy_{iter}_{idx}) ;
  • snapshot d'annulation = delta, assistant.tool_calls orphelin final retiré ;
  • tool call TRONQUÉ (finish=length) : texte assistant conservé dans le
    delta, nudge compact [SYSTEM] éphémère (présent au payload suivant,
    absent du delta) ;
  • streak « contexte saturé » : 3 coupes d'affilée → sortie propre par le
    chemin tool-limit (metrics ``context_saturated``), un round réussi
    réarme le compteur.

Aucun réseau : stream LLM + availability/vision/ctx monkeypatchés.
"""
from __future__ import annotations

import asyncio
import json

import pytest

from llm_core import _chat_with_tools as _cwt, _model_info


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


def _tc(cid, name="mytool", args="{}"):
    return {"id": cid, "type": "function",
            "function": {"name": name, "arguments": args}}


def _round(tool_calls=None, content=None, finish=None, usage=None):
    return {
        "choices": [{
            "finish_reason": finish or ("tool_calls" if tool_calls else "stop"),
            "message": {"role": "assistant", "content": content,
                        "tool_calls": tool_calls},
        }],
        "usage": dict(usage or {}), "timings": {},
    }


def _builtin(handler=None):
    return {
        "mytool": {
            "definition": {"type": "function",
                           "function": {"name": "mytool", "parameters": {}}},
            "handler": handler or (lambda _args: json.dumps({"ok": True})),
        },
    }


class _ScriptedStream:
    """Fake _llama_chat_with_tools_stream : rejoue ``script`` dans l'ordre et
    snapshotte les payloads reçus (assertions sur les messages envoyés)."""

    def __init__(self, script, on_call=None):
        self.script = list(script)
        self.payloads = []
        self.on_call = on_call

    async def __call__(self, messages, tools_payload, **kw):
        self.payloads.append([dict(m) for m in messages])
        if self.on_call:
            self.on_call(len(self.payloads))
        return self.script[len(self.payloads) - 1]


# ── Chemin natif : delta exact + marqueur + éphémères exclus ─────────────────
async def test_delta_natif_deux_rounds_sans_ephemeres(monkeypatch):
    _patch_tools_env(monkeypatch)
    # harness_status forcé à CHAQUE round productif → un message user de
    # contrôle est injecté mi-tour ; il doit rester hors du delta persisté.
    monkeypatch.setattr(_cwt, "_harness_status_line",
                        lambda *_a, **_k: "<harness_status>50%</harness_status>")

    stream = _ScriptedStream([
        _round(tool_calls=[_tc("call_a")]),
        _round(tool_calls=[_tc("call_b")]),
        _round(content="réponse finale"),
    ])
    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", stream)

    final, _events, metrics = await _cwt.run_chat_multi_mcp(
        [{"role": "user", "content": "fais"}],
        mcp_configs=[], builtin_tools=_builtin(), username="u",
    )
    assert final == "réponse finale"
    assert metrics.get("tool_history_delta") is True
    hist = metrics["tool_history"]
    assert [m["role"] for m in hist] == ["assistant", "tool", "assistant", "tool"]
    assert hist[0]["tool_calls"][0]["id"] == "call_a"
    assert hist[1]["tool_call_id"] == "call_a"
    assert hist[2]["tool_calls"][0]["id"] == "call_b"
    # Éphémères exclus : aucune entrée user (harness_status pourtant injecté).
    assert all(m["role"] != "user" for m in hist)
    # …mais bien PRÉSENT dans le payload LLM du tour suivant (working only).
    assert any(m.get("role") == "user"
               and "<harness_status>" in str(m.get("content"))
               for m in stream.payloads[-1])


# ── Chemin legacy (texte) : ids synthétiques dans le delta ───────────────────
async def test_delta_legacy_ids_synthetiques(monkeypatch):
    _patch_tools_env(monkeypatch)
    stream = _ScriptedStream([
        _round(content='je lis <tool_call>{"name": "mytool", "arguments": {}}</tool_call>',
               finish="stop"),
        _round(content="fini"),
    ])
    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", stream)

    final, _events, metrics = await _cwt.run_chat_multi_mcp(
        [{"role": "user", "content": "fais"}],
        mcp_configs=[], builtin_tools=_builtin(), username="u",
    )
    assert final == "fini"
    assert metrics.get("tool_history_delta") is True
    hist = metrics["tool_history"]
    assert [m["role"] for m in hist] == ["assistant", "tool"]
    assert hist[0]["tool_calls"][0]["id"].startswith("legacy_")
    assert hist[0]["content"] == "je lis"          # markup strippé, texte gardé
    assert hist[1]["tool_call_id"] == hist[0]["tool_calls"][0]["id"]


# ── Annulation : snapshot = delta, orphelin terminal retiré ──────────────────
async def test_cancel_snapshot_delta_sans_orphelin(monkeypatch):
    _patch_tools_env(monkeypatch)
    state = {"cancel": False}

    stream = _ScriptedStream(
        [
            _round(tool_calls=[_tc("call_a")]),
            _round(tool_calls=[_tc("call_b")]),
        ],
        # L'annulation arrive PENDANT le 2e appel LLM : le round call_b est
        # appendé puis le check pré-exécution la détecte → l'orphelin doit
        # être strippé du snapshot.
        on_call=lambda n: state.update(cancel=(n >= 2)),
    )
    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", stream)

    seen = []

    async def _on_event(ev):
        seen.append(ev)

    with pytest.raises(asyncio.CancelledError):
        await _cwt.run_chat_multi_mcp(
            [{"role": "user", "content": "fais"}],
            mcp_configs=[], builtin_tools=_builtin(), username="u",
            on_event=_on_event, is_cancelled=lambda: state["cancel"],
        )

    partials = [e for e in seen if isinstance(e, dict)
                and e.get("type") == "tool_history_partial"]
    assert partials, "tool_history_partial attendu à l'annulation"
    hist = partials[-1]["tool_history"]
    # Delta du run : round 1 COMPLET seulement — l'assistant call_b (sans
    # résultat apparié) est retiré.
    assert [m["role"] for m in hist] == ["assistant", "tool"]
    assert hist[0]["tool_calls"][0]["id"] == "call_a"
    assert all("call_b" != (m.get("tool_calls") or [{}])[0].get("id")
               for m in hist if m["role"] == "assistant")


# ── Tool call tronqué : texte gardé dans le delta, nudge éphémère ────────────
async def test_truncated_call_texte_garde_nudge_ephemere(monkeypatch):
    _patch_tools_env(monkeypatch)
    stream = _ScriptedStream([
        _round(tool_calls=[_tc("call_x")], content="je vais lire",
               finish="length"),
        _round(content="fini"),
    ])
    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", stream)

    final, _events, metrics = await _cwt.run_chat_multi_mcp(
        [{"role": "user", "content": "fais"}],
        mcp_configs=[], builtin_tools=_builtin(), username="u",
    )
    assert final == "fini"
    hist = metrics.get("tool_history") or []
    # Le texte assistant du round coupé est persisté…
    assert any(m["role"] == "assistant" and m.get("content") == "je vais lire"
               for m in hist)
    # …le nudge compact-retry [SYSTEM] n'y est PAS…
    assert all("cut off" not in str(m.get("content")) for m in hist)
    assert all(m["role"] != "user" for m in hist)
    # …mais il a bien été envoyé au modèle pour la relance.
    assert any(m.get("role") == "user" and "cut off" in str(m.get("content"))
               for m in stream.payloads[-1])


# ── Streak contexte saturé : 3 coupes d'affilée → sortie tool-limit ──────────
async def test_streak_trois_coupes_sortie_saturation(monkeypatch):
    _patch_tools_env(monkeypatch)
    # Fenêtre RÉELLEMENT pleine : prompt + sortie ≈ n_ctx. Une coupe
    # ``finish=length`` loin de n_ctx est le plafond de génération, pas une
    # saturation (cf. test_tool_limit_jauge_contexte_2026_09_07).
    import llm_core._ctx_window as _cw

    async def _ctx32k(*_a, **_k):
        return 32_000

    monkeypatch.setattr(_cw, "resolve_context_window", _ctx32k)
    _full = {"prompt_tokens": 30_500, "completion_tokens": 1_400}
    stream = _ScriptedStream([
        _round(tool_calls=[_tc("call_a")], finish="length", usage=_full),
        _round(tool_calls=[_tc("call_b")], finish="length", usage=_full),
        _round(tool_calls=[_tc("call_c")], finish="length", usage=_full),
    ])
    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", stream)

    seen = []

    async def _on_event(ev):
        seen.append(ev)

    final, _events, metrics = await _cwt.run_chat_multi_mcp(
        [{"role": "user", "content": "fais"}],
        mcp_configs=[], builtin_tools=_builtin(), username="u",
        on_event=_on_event,
    )
    # Sortie par le chemin tool-limit, PAS un spin jusqu'au hard cap (100).
    assert len(stream.payloads) == 3
    assert metrics.get("tool_limit_reached") is True
    assert metrics.get("context_saturated") is True
    # Message utilisateur garanti et actionnable.
    assert "satur" in final.lower()
    assert any(e.get("type") == "notice" and "saturé" in str(e.get("message"))
               for e in seen if isinstance(e, dict))


async def test_streak_reset_sur_round_reussi(monkeypatch):
    _patch_tools_env(monkeypatch)
    stream = _ScriptedStream([
        _round(tool_calls=[_tc("c1")], finish="length"),
        _round(tool_calls=[_tc("c2")], finish="length"),
        _round(tool_calls=[_tc("c3")]),                     # round OK → reset
        _round(tool_calls=[_tc("c4")], finish="length"),
        _round(tool_calls=[_tc("c5")], finish="length"),
        _round(content="fini"),
    ])
    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", stream)

    final, _events, metrics = await _cwt.run_chat_multi_mcp(
        [{"role": "user", "content": "fais"}],
        mcp_configs=[], builtin_tools=_builtin(), username="u",
    )
    # Jamais 3 coupes CONSÉCUTIVES → pas d'arrêt saturation, réponse normale.
    assert final == "fini"
    assert len(stream.payloads) == 6
    assert metrics.get("context_saturated") is None
    assert metrics.get("tool_limit_reached") is None
    # Le delta persiste le round réussi (c3) et les textes conservés éventuels.
    hist = metrics.get("tool_history") or []
    assert any(m["role"] == "assistant" and m.get("tool_calls")
               and m["tool_calls"][0]["id"] == "c3" for m in hist)
