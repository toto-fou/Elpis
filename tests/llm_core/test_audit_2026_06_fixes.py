# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_audit_2026_06_fixes.py — verrouillage des correctifs de
l'audit consolidé 2026-06 (Vague 1 backend, items 1-3).

Cible :
- ``chatbot_app.routes.chats._drop_event_after_cancel`` : le 'final' du
  partiel passe la garde post-cancel (les tokens parasites restent droppés).
- ``conversation_compressor.compression_was_attempted`` : le cooldown
  s'applique aussi sur ÉCHEC d'une vraie tentative, pas sur les pré-checks.
- ``_tool_parsing.extract_tool_calls`` : les tool-calls JSON malformés sont
  loggés (bloc <tool_call> invalide, objets non parsables en texte libre)
  sans changer le comportement de parsing.
"""
from __future__ import annotations

import logging

from chatbot_app.routes.chats import _drop_event_after_cancel, _task_runs_for_persist
from llm_core.conversation_compressor import compression_was_attempted
from llm_core import _tool_parsing
from llm_core._tool_parsing import extract_tool_calls


# ──────────────────────────────────────────────────────────────────────────
# _drop_event_after_cancel — whitelist du 'final' partiel
# ──────────────────────────────────────────────────────────────────────────

def test_final_passes_guard_after_cancel():
    # Le 'final' du partiel (cancelled/persisted) DOIT atteindre le front.
    assert _drop_event_after_cancel("final", cancelled=True) is False


def test_parasite_events_dropped_after_cancel():
    for evt in ("content_token", "thinking_token", "mode", "tool_call_delta", None):
        assert _drop_event_after_cancel(evt, cancelled=True) is True


def test_nothing_dropped_without_cancel():
    for evt in ("final", "content_token", None):
        assert _drop_event_after_cancel(evt, cancelled=False) is False


def test_task_step_final_passes_guard_after_cancel():
    """2026-07-18 — le BILAN d'un sous-agent (task_step status=final) est émis
    pendant le unwinding du Stop parent : il DOIT passer (état terminal de la
    ligne agent), sinon spinner à vie côté UI. Les autres task_step restent
    droppés (bruit post-stop)."""
    assert _drop_event_after_cancel("task_step", cancelled=True, status="final") is False
    for st in ("tick", "running", "done", "spawned", None):
        assert _drop_event_after_cancel("task_step", cancelled=True, status=st) is True


def test_task_runs_for_persist_strippe_tools():
    """2026-07-18 — le déroulé ``tools`` n'est plus rendu (refonte carte
    agent) → jamais persisté ni round-trippé (poids mort DB + payload).
    Les autres champs passent tels quels ; entrées non-dict écartées."""
    runs = [
        {"id": "t1", "agent": "explore", "state": "completed",
         "tools": [{"tool": "read_file", "status": "done"}] * 50},
        "junk",
        {"id": "t2", "agent": "web", "state": "cancelled", "tools": []},
    ]
    out = _task_runs_for_persist(runs)
    assert [r["id"] for r in out] == ["t1", "t2"]
    assert all("tools" not in r for r in out)
    assert out[0]["agent"] == "explore"
    assert _task_runs_for_persist(None) == []


# ──────────────────────────────────────────────────────────────────────────
# compression_was_attempted — cooldown sur échec réel
# ──────────────────────────────────────────────────────────────────────────

def test_attempted_on_success():
    assert compression_was_attempted({"compressed": True}) is True


def test_attempted_on_costly_failures():
    # Échecs d'une VRAIE tentative → cooldown (un compresseur down ne doit
    # pas être retenté à chaque itération).
    for reason in (
        "llm_error: ReadTimeout",
        "summary_too_short",
        "exception: boom",
    ):
        assert compression_was_attempted({"compressed": False, "reason": reason}) is True


def test_not_attempted_on_cheap_prechecks():
    for reason in ("threshold_not_reached", "nothing_to_compress", "disabled", "not_run"):
        assert compression_was_attempted({"compressed": False, "reason": reason}) is False


def test_attempted_defensive_on_garbage():
    assert compression_was_attempted({}) is False


# ──────────────────────────────────────────────────────────────────────────
# extract_tool_calls — logging des tool-calls perdus
# ──────────────────────────────────────────────────────────────────────────

def test_malformed_tool_call_block_logged(caplog):
    text = '<tool_call>{"name": "foo", "arguments": {</tool_call>'
    with caplog.at_level(logging.WARNING, logger="uvicorn.error"):
        result = extract_tool_calls(text)
    assert result is None
    assert any("non parsable" in r.message for r in caplog.records)


def test_valid_tool_call_block_not_logged(caplog):
    text = '<tool_call>{"name": "foo", "arguments": {"a": 1}}</tool_call>'
    with caplog.at_level(logging.WARNING, logger="uvicorn.error"):
        result = extract_tool_calls(text)
    assert result == [("foo", {"a": 1})]
    assert not caplog.records


def test_free_text_malformed_json_logged_once(caplog):
    # Un objet ressemblant à un tool-call mais non parsable → UN log récap.
    text = 'voici {"name": "broken", "arguments": { et rien d\'autre'
    with caplog.at_level(logging.WARNING, logger="uvicorn.error"):
        result = extract_tool_calls(text)
    assert result is None
    hits = [r for r in caplog.records if "non parsable" in r.message]
    assert len(hits) == 1


def test_prose_with_braces_not_logged(caplog):
    # Du texte normal avec des accolades (snippet de code) ne doit pas alerter.
    text = "en Python : d = {'a': 1} puis f({'b': 2})"
    with caplog.at_level(logging.WARNING, logger="uvicorn.error"):
        extract_tool_calls(text)
    assert not [r for r in caplog.records if "non parsable" in r.message]


# ──────────────────────────────────────────────────────────────────────────
# A1 — diagnostic renvoyé au modèle quand un tool-call ne parse pas
# ──────────────────────────────────────────────────────────────────────────

def test_diagnostic_set_on_malformed_block():
    # Bloc <tool_call> balisé mais JSON cassé → diagnostic armé pour la boucle.
    assert extract_tool_calls('<tool_call>{"name": "foo", "arguments": {</tool_call>') is None
    assert _tool_parsing.LAST_PARSE_DIAGNOSTIC
    assert "<tool_call>" in _tool_parsing.LAST_PARSE_DIAGNOSTIC


def test_diagnostic_set_on_free_text_malformed():
    assert extract_tool_calls('blabla {"name": "broken", "arguments": { fin') is None
    assert _tool_parsing.LAST_PARSE_DIAGNOSTIC


def test_diagnostic_cleared_on_valid_call():
    # Une parse réussie ne doit JAMAIS laisser un diagnostic actif (reset entrée).
    extract_tool_calls('<tool_call>{"name": "foo", "arguments": {</tool_call>')  # arme
    assert extract_tool_calls('<tool_call>{"name": "foo", "arguments": {"a": 1}}</tool_call>') == [("foo", {"a": 1})]
    assert _tool_parsing.LAST_PARSE_DIAGNOSTIC == ""


def test_diagnostic_empty_on_prose():
    # Prose sans tentative d'appel → pas de diagnostic (sinon faux feedback).
    extract_tool_calls("juste du texte avec d = {'a': 1}")
    assert _tool_parsing.LAST_PARSE_DIAGNOSTIC == ""


def test_diagnostic_empty_on_unknown_tool_that_parsed():
    # Un nom d'outil inconnu mais JSON VALIDE parse correctement → pas de
    # diagnostic « mal formé » (le filtrage du nom est géré ailleurs).
    assert extract_tool_calls('<tool_call>{"name": "nope", "arguments": {}}</tool_call>') == [("nope", {})]
    assert _tool_parsing.LAST_PARSE_DIAGNOSTIC == ""
