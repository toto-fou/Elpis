# SPDX-License-Identifier: MIT
"""tests/llm_core/test_glm_tool_calls.py — tool-calls des modèles « thinking »
GLM-4.5/4.6 (format XML <arg_key>/<arg_value>) + Qwen3, et récupération d'un
appel piégé dans le canal *reasoning*.

Contexte : GLM-4.x émet ``<tool_call>name <arg_key>k</arg_key>
<arg_value>v</arg_value></tool_call>`` (PAS du JSON). Avant, ce bloc échouait au
``json.loads`` et l'appel était PERDU. De plus, les modèles thinking émettent
parfois l'appel DANS le reasoning → ni exécuté ni affiché (juste vu brut).
"""
from __future__ import annotations

from llm_core._chat_with_tools import (
    _recover_tool_calls_from_reasoning,
    _strip_tool_call_markup,
)
from llm_core._tool_parsing import _parse_glm_tool_block, extract_tool_calls


# ── format GLM-4.5/4.6 (XML arg_key/arg_value) ───────────────────────────────
def test_glm_single_string_arg():
    text = ("<tool_call>get_weather\n"
            "<arg_key>location</arg_key>\n"
            "<arg_value>Paris</arg_value>\n"
            "</tool_call>")
    assert extract_tool_calls(text) == [("get_weather", {"location": "Paris"})]


def test_glm_typed_arg_values():
    text = ("<tool_call>set_opts\n"
            "<arg_key>count</arg_key><arg_value>3</arg_value>\n"
            "<arg_key>enabled</arg_key><arg_value>true</arg_value>\n"
            "<arg_key>ratio</arg_key><arg_value>0.5</arg_value>\n"
            "</tool_call>")
    out = extract_tool_calls(text)
    assert out == [("set_opts", {"count": 3, "enabled": True, "ratio": 0.5})]
    # types réellement dé-JSON-ifiés (pas des strings)
    assert out[0][1]["count"] == 3 and out[0][1]["enabled"] is True


def test_glm_json_object_arg_value():
    text = ("<tool_call>desktop_act\n"
            "<arg_key>op</arg_key><arg_value>click</arg_value>\n"
            "<arg_key>point</arg_key><arg_value>{\"x\": 10, \"y\": 20}</arg_value>\n"
            "</tool_call>")
    assert extract_tool_calls(text) == [
        ("desktop_act", {"op": "click", "point": {"x": 10, "y": 20}})]


def test_glm_no_arg_call():
    assert extract_tool_calls("<tool_call>refresh</tool_call>") == [("refresh", {})]


def test_glm_multiple_blocks():
    text = ("<tool_call>a\n<arg_key>k</arg_key><arg_value>1</arg_value></tool_call>"
            " du texte au milieu "
            "<tool_call>b\n<arg_key>m</arg_key><arg_value>x</arg_value></tool_call>")
    assert extract_tool_calls(text) == [("a", {"k": 1}), ("b", {"m": "x"})]


def test_parse_glm_block_helper_rejects_json_garbage():
    # un corps JSON tronqué ne doit PAS être pris pour du GLM (nom = '{...' invalide)
    assert _parse_glm_tool_block('{"name": "foo", "arguments": {') is None


def test_qwen_json_still_parses():
    # régression : le format Qwen (JSON dans <tool_call>) reste intact
    text = '<tool_call>{"name": "foo", "arguments": {"a": 1}}</tool_call>'
    assert extract_tool_calls(text) == [("foo", {"a": 1})]


def test_glm_truncated_block_no_crash():
    # bloc GLM jamais fermé → pas de match <tool_call>...</tool_call>, pas de crash
    assert extract_tool_calls("<tool_call>get_weather\n<arg_key>loc") is None


# ── strip markup GLM (panneau visible/thinking) ──────────────────────────────
def test_strip_removes_glm_block():
    text = ("Je vais chercher la météo. "
            "<tool_call>get_weather\n<arg_key>loc</arg_key><arg_value>Paris</arg_value></tool_call>")
    assert _strip_tool_call_markup(text) == "Je vais chercher la météo."


def test_strip_removes_orphan_arg_tags():
    # balises d'args isolées (bloc déjà partiellement retiré) → nettoyées
    out = _strip_tool_call_markup("texte <arg_key>k</arg_key><arg_value>v</arg_value> fin")
    assert "arg_key" not in out and "arg_value" not in out
    assert out.startswith("texte") and out.endswith("fin")


# ── récupération depuis le reasoning ─────────────────────────────────────────
def test_recover_glm_call_from_reasoning():
    reasoning = ("L'utilisateur veut la météo. Je dois appeler l'outil.\n"
                 "<tool_call>get_weather\n<arg_key>location</arg_key>"
                 "<arg_value>Paris</arg_value></tool_call>")
    rec = _recover_tool_calls_from_reasoning(reasoning)
    assert len(rec) == 1
    assert rec[0]["function"]["name"] == "get_weather"
    assert rec[0]["type"] == "function" and rec[0]["id"]
    import json
    assert json.loads(rec[0]["function"]["arguments"]) == {"location": "Paris"}


def test_recover_qwen_call_from_reasoning():
    reasoning = 'réflexion… <tool_call>{"name": "foo", "arguments": {"a": 1}}</tool_call>'
    rec = _recover_tool_calls_from_reasoning(reasoning)
    assert rec[0]["function"]["name"] == "foo"


def test_no_recovery_without_markup():
    # le modèle PARLE d'appeler un outil sans émettre de markup → aucun appel
    reasoning = "Je pourrais appeler get_weather mais je vais répondre directement."
    assert _recover_tool_calls_from_reasoning(reasoning) == []


def test_no_recovery_on_empty():
    assert _recover_tool_calls_from_reasoning("") == []
    assert _recover_tool_calls_from_reasoning(None) == []


def test_recovery_filters_unknown_tool_names():
    reasoning = ("<tool_call>get_weather\n<arg_key>location</arg_key>"
                 "<arg_value>Paris</arg_value></tool_call>")
    # nom inconnu du registre → pas promu
    assert _recover_tool_calls_from_reasoning(reasoning, known_names={"other_tool"}) == []
    # nom connu → promu
    rec = _recover_tool_calls_from_reasoning(reasoning, known_names={"get_weather"})
    assert len(rec) == 1 and rec[0]["function"]["name"] == "get_weather"
