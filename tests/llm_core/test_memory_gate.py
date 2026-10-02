# SPDX-License-Identifier: MIT
"""Toggle mémoire (per-user, défaut OFF) : gating des tools memory/session_search.

La mémoire n'est PAS une catégorie du panneau d'outils (CATEGORY hidden=True) :
elle est gouvernée par un réglage ``memory_enabled``. ``_apply_memory_gate``
retire les tools ``memory`` / ``session_search`` quand le toggle est OFF, de
façon robuste (par nom ET par catégorie, donc même si le manifeste est
indisponible ou si ``filter_categories`` est None).
"""
from __future__ import annotations

from llm_core.engine.tool_catalog import _MEMORY_TOOL_NAMES, _apply_memory_gate


class _Tool:
    def __init__(self, name):
        self.name = name


def _cat(name):
    # Manifeste simulé : memory/session_search → 'memory', le reste → 'fs'.
    return "memory" if name in ("memory", "session_search") else "fs"


def test_memory_tools_known_names():
    assert _MEMORY_TOOL_NAMES == frozenset({"memory", "session_search"})


def test_gate_off_drops_memory_tools_by_object():
    tools = [_Tool("memory"), _Tool("session_search"), _Tool("write_file")]
    kept = _apply_memory_gate(tools, memory_enabled=False, categorize=_cat)
    assert [t.name for t in kept] == ["write_file"]


def test_gate_on_keeps_everything():
    tools = [_Tool("memory"), _Tool("session_search"), _Tool("write_file")]
    kept = _apply_memory_gate(tools, memory_enabled=True, categorize=_cat)
    assert [t.name for t in kept] == ["memory", "session_search", "write_file"]


def test_gate_off_works_on_dict_tools():
    tools = [{"name": "memory"}, {"name": "grep"}]
    kept = _apply_memory_gate(tools, memory_enabled=False, categorize=_cat)
    assert kept == [{"name": "grep"}]


def test_gate_off_robust_when_manifest_down():
    # Manifeste indisponible → categorize renvoie "" pour tout : le drop par NOM
    # doit quand même retirer les tools mémoire.
    tools = [_Tool("memory"), _Tool("session_search"), _Tool("read_file")]
    kept = _apply_memory_gate(tools, memory_enabled=False, categorize=lambda n: "")
    assert [t.name for t in kept] == ["read_file"]


def test_gate_off_drops_by_category_even_if_name_unknown():
    # Un éventuel futur tool mémoire (nom inconnu) mais catégorisé 'memory'
    # doit aussi tomber.
    tools = [_Tool("memory_snapshot"), _Tool("ls")]
    cat = lambda n: "memory" if n == "memory_snapshot" else "fs"
    kept = _apply_memory_gate(tools, memory_enabled=False, categorize=cat)
    assert [t.name for t in kept] == ["ls"]
