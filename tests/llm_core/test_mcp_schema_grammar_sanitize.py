# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_mcp_schema_grammar_sanitize.py

Régression — appels MCP en HTTP 400 sur llama.cpp récent (≈ b9xxx+, --jinja).

Le convertisseur GRAMMAIRE (GBNF) de llama.cpp dérive une grammaire du
``parameters`` de chaque outil et REJETTE (« Unrecognized schema: true/false »)
tout *schéma booléen* posé là où un sous-schéma est attendu. pydantic/FastMCP en
émet pour les champs ``Any``/``list`` nus et les ``tuple`` (``items: false``). UN
seul outil concerné faisait 400 toute la requête → plus aucun appel MCP.

``_sanitize_schema_for_grammar`` remplace ces booléens par ``{}`` PARTOUT sauf
``additionalProperties`` (que le convertisseur supporte). Vérifié EN LIVE contre
un serveur b9592 (400→200) ; ce test verrouille la logique sans réseau.
"""
from __future__ import annotations

from llm_core._mcp_wrappers import _sanitize_schema_for_grammar, mcp_tool_to_openai


def test_bool_subschemas_replaced_everywhere_but_additionalproperties():
    raw = {
        "type": "object",
        "properties": {
            "any_field": True,                                                   # Any
            "tup": {"type": "array", "prefixItems": [{"type": "integer"}], "items": False},  # tuple
            "lst": {"type": "array", "items": True},                             # list[Any]
            "uni": {"anyOf": [{"type": "string"}, False]},
            "nested": {"type": "object", "properties": {"x": True}},
            "forbidden": False,
        },
        "additionalProperties": False,
        "required": ["any_field"],
    }
    out = _sanitize_schema_for_grammar(raw)
    assert out["properties"]["any_field"] == {}
    assert out["properties"]["tup"]["items"] == {}
    assert out["properties"]["lst"]["items"] == {}
    assert out["properties"]["uni"]["anyOf"][1] == {}
    assert out["properties"]["nested"]["properties"]["x"] == {}
    assert out["properties"]["forbidden"] == {}
    # additionalProperties bool : SUPPORTÉ par le convertisseur → conservé.
    assert out["additionalProperties"] is False
    # tout le reste inchangé.
    assert out["required"] == ["any_field"]
    assert out["properties"]["tup"]["prefixItems"] == [{"type": "integer"}]


def test_additionalproperties_dict_is_recursed():
    raw = {"type": "object", "additionalProperties": {"type": "array", "items": True}}
    out = _sanitize_schema_for_grammar(raw)
    assert out["additionalProperties"]["items"] == {}


def test_clean_schema_is_noop():
    raw = {"type": "object",
           "properties": {"city": {"type": "string"}, "n": {"type": "integer", "enum": [1, 2]}},
           "required": ["city"]}
    assert _sanitize_schema_for_grammar(raw) == raw


def test_bare_bool_and_non_dict_inputs():
    assert _sanitize_schema_for_grammar(True) == {}
    assert _sanitize_schema_for_grammar(False) == {}
    assert _sanitize_schema_for_grammar("x") == "x"      # non-schéma → inchangé


def test_mcp_tool_to_openai_sanitizes_and_defaults():
    # _dump(dict) renvoie le dict → branche isinstance(d, dict).
    tool = {"name": "weird", "description": "d",
            "inputSchema": {"type": "object", "properties": {"x": True},
                            "additionalProperties": True}}
    oa = mcp_tool_to_openai(tool)
    params = oa["function"]["parameters"]
    assert oa["function"]["name"] == "weird"
    assert params["properties"]["x"] == {}                # bool retiré
    assert params["additionalProperties"] is True         # conservé
    assert params["type"] == "object"


def test_mcp_tool_to_openai_empty_schema_gets_object_defaults():
    oa = mcp_tool_to_openai({"name": "t", "description": "", "inputSchema": {}})
    params = oa["function"]["parameters"]
    assert params == {"type": "object", "properties": {}}


def test_memory_tool_schema_shape_survives_sanitize():
    """Le schéma de l'outil ``memory`` v2 (enum d'actions à 4 valeurs + params
    nullables anyOf[string,null]) traverse la sanitisation sans altération ni
    schéma booléen résiduel — aucune 400 GBNF attendue sur llama.cpp."""
    raw = {
        "type": "object",
        "properties": {
            "action": {"type": "string",
                       "enum": ["add", "replace", "remove", "rewrite"]},
            "store": {"type": "string", "enum": ["memory", "user"],
                      "default": "memory"},
            "content": {"anyOf": [{"type": "string"}, {"type": "null"}],
                        "default": None},
            "target": {"anyOf": [{"type": "string"}, {"type": "null"}],
                       "default": None},
            "old_text": {"anyOf": [{"type": "string"}, {"type": "null"}],
                         "default": None},
            "title": {"anyOf": [{"type": "string"}, {"type": "null"}],
                      "default": None},
        },
        "required": ["action"],
    }
    out = _sanitize_schema_for_grammar(raw)
    assert out == raw  # no-op : rien d'exotique dans ce schéma

    def _no_bool_schema(node):
        # aucun sous-schéma booléen nulle part (source des 400 GBNF)
        assert not isinstance(node, bool)
        if isinstance(node, dict):
            for v in node.values():
                _no_bool_schema(v)
        elif isinstance(node, list):
            for v in node:
                _no_bool_schema(v)

    _no_bool_schema(out)
