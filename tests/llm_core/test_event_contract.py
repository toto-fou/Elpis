# SPDX-License-Identifier: MIT
"""tests/llm_core/test_event_contract.py — contrat d'events NDJSON (Phase 0).

Le frontend consomme les events émis par la boucle via ``on_event`` : tout
renommage/disparition silencieux le casse. Ces tests figent :

1. l'ENSEMBLE des types autorisés (``EVENT_TYPES`` — un type inconnu émis =
   échec → l'ajout d'un type est un choix explicite, additif) ;
2. la SÉQUENCE des types pour des scénarios canoniques (goldens) —
   l'ordre relatif tool_call → tool_result → itération suivante est un
   invariant du frontend (panneau d'activité outils).

La Phase 4 (TurnEngine/EventSink) doit laisser ces séquences identiques.
"""
from __future__ import annotations

import asyncio
import json

import pytest

import llm_core._chat_with_tools as _cwt

from tests.llm_core.goldens_harness import (
    assert_matches_golden,
    builtin_tools,
    patch_hermetic,
    sse_final,
    sse_text,
    sse_tool_call,
)

# Types d'events du contrat loop-side (le routeur en ajoute d'autres :
# queue_status, thinking, truncated… hors périmètre de la boucle).
EVENT_TYPES = frozenset({
    "mode", "iteration",
    "thinking", "thinking_token", "thinking_content",
    "content_token",
    "tool_thinking", "tool_call", "tool_call_delta", "tool_result",
    "tool_progress", "tool_log", "tool_limit", "tool_history_partial",
    "kv_cache",
    "compression_start", "compression_done", "compression_state",
    "compression_capped",
    "info", "notice", "error",
    "annotation_frame",
})


async def _collect(monkeypatch, scripts, *, messages=None, builtin=None,
                   is_cancelled=None):
    patch_hermetic(monkeypatch, scripts)
    seen: list = []

    async def _on_event(ev):
        seen.append(ev)

    final, _events, metrics = await _cwt.run_chat_multi_mcp(
        messages or [
            {"role": "system", "content": "SOCLE GOLDEN"},
            {"role": "user", "content": "Utilise zeta_echo puis conclus."},
        ],
        mcp_configs=[],
        builtin_tools=builtin if builtin is not None else builtin_tools(),
        username="golden", chat_id="golden-chat", model="golden-model",
        memory_enabled=False, on_event=_on_event,
        is_cancelled=is_cancelled,
    )
    return seen, final, metrics


def _types(seen: list) -> list:
    return [e.get("type") for e in seen if isinstance(e, dict)]


# ── E1 : tour natif complet (tool_call → tool_result → réponse) ─────────────

async def test_sequence_native_tool_roundtrip(monkeypatch):
    seen, final, _m = await _collect(monkeypatch, [
        sse_tool_call("zeta_echo", '{"msg": "ping"}'),
        sse_final("Terminé."),
    ])
    types = _types(seen)
    assert set(types) <= EVENT_TYPES, f"types hors contrat : {set(types) - EVENT_TYPES}"
    # Invariant frontend : l'appel précède TOUJOURS son résultat.
    assert types.index("tool_call") < types.index("tool_result")
    assert final == "Terminé."
    assert_matches_golden("events_native_roundtrip", types)


# ── E2 : chemin legacy (tool call en TEXTE tag-parsé) ───────────────────────

async def test_sequence_legacy_tag_parse(monkeypatch):
    tool_txt = '<tool_call>\n{"name": "zeta_echo", "arguments": {"msg": "x"}}\n</tool_call>'
    seen, final, _m = await _collect(monkeypatch, [
        sse_text(tool_txt),
        sse_final("Fini via legacy."),
    ])
    types = _types(seen)
    assert set(types) <= EVENT_TYPES, f"types hors contrat : {set(types) - EVENT_TYPES}"
    assert "tool_call" in types and "tool_result" in types
    assert types.index("tool_call") < types.index("tool_result")
    assert final == "Fini via legacy."
    assert_matches_golden("events_legacy_roundtrip", types)


# ── E3 : tool call TEXTE malformé → diagnostic au modèle, puis réponse ──────

async def test_sequence_legacy_malformed_puis_reprise(monkeypatch):
    broken = '<tool_call>{"name": "zeta_echo", "arguments": {broken}</tool_call>'
    seen, final, _m = await _collect(monkeypatch, [
        sse_text(broken),
        sse_final("Réparé."),
    ])
    types = _types(seen)
    assert set(types) <= EVENT_TYPES, f"types hors contrat : {set(types) - EVENT_TYPES}"
    # Pas d'exécution d'outil sur un appel non parsable.
    assert "tool_result" not in types
    assert final == "Réparé."
    assert_matches_golden("events_legacy_malformed", types)


# ── E4 : annulation pendant les outils → tool_history_partial puis raise ────

async def test_cancel_emet_partial_puis_raise(monkeypatch):
    state = {"cancel": False}

    def _handler(_args):
        state["cancel"] = True
        return json.dumps({"ok": True})

    builtin = {
        "mytool": {
            "definition": {"type": "function", "function": {
                "name": "mytool", "parameters": {}}},
            "handler": _handler,
        },
    }
    with pytest.raises(asyncio.CancelledError):
        await _collect(
            monkeypatch,
            [sse_tool_call("mytool", "{}"), sse_final("jamais atteint")],
            builtin=builtin,
            is_cancelled=lambda: state["cancel"],
        )
