# SPDX-License-Identifier: MIT
"""llm_core._tool_traits : une seule source pour « sériel », « rejouable »,
« lecture seule » et « mutant » (2026-09-29)."""
from __future__ import annotations

import pytest

from llm_core._tool_traits import read_only_hint, tool_traits


def test_traits_declares_par_le_service(real_tool_registry):
    lecture = tool_traits("list_files")
    assert lecture.read_only and not lecture.mutates and not lecture.serial and lecture.replay_safe
    ecriture = tool_traits("write_file")
    assert ecriture.mutates and ecriture.serial and not ecriture.replay_safe
    # Un onglet par session (sériel), mais rien d'écrit : pas un artefact de
    # compression, malgré le préfixe pw_ des outils sériels.
    onglet = tool_traits("pw_find")
    assert onglet.serial and onglet.read_only and not onglet.mutates


@pytest.fixture
def registre_vide(tmp_path, monkeypatch):
    from llm_core import _mcp_categories as cats
    monkeypatch.setattr(cats, "_CACHE_PATH", tmp_path / "categories.json")
    monkeypatch.setattr(cats, "_registry", None)
    monkeypatch.setattr(cats, "_sources", {})
    monkeypatch.setattr(cats, "_disk_cache", {"at": 0.0, "reg": None})


def test_replis_prudents_sans_declaration(registre_vide):
    inconnu = tool_traits("zz_outil_externe")
    assert not inconnu.read_only                    # fail-fermé : jamais en /plan
    assert not inconnu.serial and inconnu.replay_safe and not inconnu.mutates
    prefixe = tool_traits("git_quelque_chose")
    assert prefixe.serial and prefixe.mutates and not prefixe.replay_safe
    assert not tool_traits("execute_shell").replay_safe      # rejouer relancerait la commande
    assert not tool_traits("").replay_safe


def test_l_objet_de_list_tools_fait_foi(registre_vide):
    obj = {"name": "zz", "annotations": {"readOnlyHint": True}}
    assert tool_traits("zz", tool=obj).read_only
    assert read_only_hint({"annotations": {"read_only_hint": False}}) is False
    assert read_only_hint(object()) is None
