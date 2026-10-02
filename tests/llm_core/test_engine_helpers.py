# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_engine_helpers.py — couverture des helpers PURS du
moteur tool-calling ``run_chat_multi_mcp`` :

- ``_result_is_error``        : détection d'échec d'un résultat d'outil,
                                partagée par le chemin natif ET legacy.
- ``_strip_tool_call_markup`` : nettoyage du contenu visible sur le chemin
                                de secours « texte libre » (deux dialectes).

Aucun LLM / réseau requis : ce sont des fonctions pures.
"""
from __future__ import annotations

import json

from llm_core._tool_parsing import _strip_tool_call_markup
from llm_core.engine.result_contract import result_is_error as _result_is_error

# ──────────────────────────────────────────────────────────────────────────
# _result_is_error — l'incohérence natif/legacy corrigée
# ──────────────────────────────────────────────────────────────────────────

def test_ok_false_envelope_is_error():
    """Cas régressif : envelope _err() multi-clés avec ok=false. Le chemin
    legacy le ratait avant le fix (comptait l'itération comme productive)."""
    res = json.dumps({"ok": False, "error": "boom", "message": "m", "fix": "f"})
    assert _result_is_error(res) is True


def test_ok_false_alone_is_error():
    assert _result_is_error('{"ok": false}') is True


def test_single_key_error_is_error():
    assert _result_is_error('{"error": "not found"}') is True


def test_multikey_error_without_ok_false_is_success():
    # ``error`` présent mais len != 1 et pas de ok:false → succès (cohérent
    # avec l'heuristique native historique, inchangée).
    assert _result_is_error('{"error": "x", "detail": "y"}') is False


def test_ok_true_is_success():
    assert _result_is_error(json.dumps({"ok": True, "data": [1, 2, 3]})) is False


def test_free_dict_is_success():
    assert _result_is_error('{"result": "value", "rows": 4}') is False


def test_non_json_string_is_success():
    assert _result_is_error("plain text output from a tool") is False


def test_json_list_is_success():
    assert _result_is_error('["a", "b"]') is False


def test_malformed_json_is_success():
    assert _result_is_error('{not valid json') is False


def test_non_str_inputs_are_success():
    assert _result_is_error(None) is False
    assert _result_is_error(123) is False  # type: ignore[arg-type]
    assert _result_is_error({"ok": False}) is False  # dict, not str


# ──────────────────────────────────────────────────────────────────────────
# _strip_tool_call_markup — les deux dialectes nettoyés
# ──────────────────────────────────────────────────────────────────────────

def test_strips_qwen_tool_call_block():
    out = _strip_tool_call_markup('avant <tool_call>{"name":"x"}</tool_call> après')
    assert "tool_call" not in out
    assert "avant" in out and "après" in out


def test_strips_llama_function_block():
    """Cas régressif : la syntaxe <function=> n'était PAS retirée avant."""
    out = _strip_tool_call_markup(
        '<function=read_file><parameter=path>a.py</parameter></function>'
    )
    assert out == ""
    assert "function=" not in out


def test_strips_function_block_keeping_prose():
    out = _strip_tool_call_markup(
        'Je vais lire le fichier. <function=read_file>x</function> Voilà.'
    )
    assert "function=" not in out
    assert "Je vais lire le fichier." in out
    assert "Voilà." in out


def test_strips_unclosed_function_at_eof():
    out = _strip_tool_call_markup('texte <function=foo>incomplet jamais fermé')
    assert "function=" not in out
    assert out.startswith("texte")


def test_mixed_dialects_both_removed():
    out = _strip_tool_call_markup(
        '<tool_call>{"name":"a"}</tool_call> milieu <function=b>y</function>'
    )
    assert "tool_call" not in out
    assert "function=" not in out
    assert "milieu" in out


def test_plain_prose_unchanged():
    assert _strip_tool_call_markup("Bonjour, voici la réponse.") == "Bonjour, voici la réponse."


def test_empty_and_none():
    assert _strip_tool_call_markup("") == ""
    assert _strip_tool_call_markup(None) is None  # type: ignore[arg-type]


# ──────────────────────────────────────────────────────────────────────────
# Régression : le LEAK exact du screenshot (2026-05-30) — markup hybride
# Qwen <tool_call> + Llama <function=> + <parameter=>, NON FERMÉ, mêlé à de
# la prose. Doit ressortir SANS aucune balise de markup visible.
# ──────────────────────────────────────────────────────────────────────────

def test_screenshot_unclosed_hybrid_tool_call_no_leak():
    leaked = (
        "## Phase 2: Create more fixtures for comprehensive testing\n\n"
        "<tool_call>\n"
        "<function=write_file>\n"
        "<parameter=content>\n"
        "#!/bin/bash\n"
        '# Test script for shell operations\n'
        'echo "Hello from test script"\n\n'
        "calculate() {\n"
        "  local a=$1\n"
        "  local b=$2"
    )
    out = _strip_tool_call_markup(leaked)
    # Aucune balise de markup ne doit subsister.
    assert "<tool_call>" not in out
    assert "<function" not in out
    assert "<parameter" not in out
    # La prose légitime d'avant le markup est conservée.
    assert "## Phase 2: Create more fixtures for comprehensive testing" in out
    # Le corps du script (qui était DANS le markup) ne fuit pas.
    assert "#!/bin/bash" not in out


def test_unclosed_function_without_wrapper_no_leak():
    out = _strip_tool_call_markup(
        "Voici le fichier :\n<function=write_file>\n<parameter=path>x.py</parameter>\n"
    )
    assert "<function" not in out
    assert "<parameter" not in out
    assert "Voici le fichier :" in out


def test_orphan_closing_and_param_tags_removed():
    out = _strip_tool_call_markup(
        "texte </parameter></function></tool_call> fin"
    )
    assert "parameter" not in out
    assert "function" not in out
    assert "tool_call" not in out
    assert "texte" in out and "fin" in out


def test_prose_after_closed_block_survives():
    out = _strip_tool_call_markup(
        "<tool_call>{\"name\":\"x\"}</tool_call>\n\nVoici le fichier modifié :"
    )
    assert "tool_call" not in out
    assert "Voici le fichier modifié :" in out
