# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_fs_edit_robustness.py — robustesse d'édition fs
(passe « moins d'outils, plus capables » 2026-07).

Couvre :
- repli WHITESPACE-TOLERANT de str_replace (_flexible_block_matches) :
  espaces traînants, décalage d'indentation UNIFORME (new_str ré-indenté),
  refus des décalages non uniformes, ambiguïté comptée ;
- normalisation CRLF + BOM dans edit_file : un old_str en \\n matche un
  fichier CRLF, et la convention du fichier est RESTAURÉE à l'écriture ;
- write_file : encodage STRICT (fini la corruption silencieuse
  errors='replace') ;
- coercition des params structurés JSON-encodés en string (edits=…).
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

import llm_core.tools.fs_tools as fs_tools
from llm_core.tools.fs_tools import (
    _apply_one_edit,
    _flexible_block_matches,
)


# ──────────────────────────────────────────────────────────────────────────
# _apply_one_edit / str_replace — repli tolérant
# ──────────────────────────────────────────────────────────────────────────

def test_exact_match_stays_primary():
    text = "def f():\n    return 1\n"
    out, info = _apply_one_edit(text, {"action": "str_replace",
                                       "old_str": "return 1", "new_str": "return 2"})
    assert out == "def f():\n    return 2\n"
    assert "matched" not in info          # chemin exact : pas de note


def test_trailing_whitespace_fallback():
    text = "a = 1   \nb = 2\t\nc = 3\n"          # espaces/tabs traînants
    old = "a = 1\nb = 2\nc = 3\n"                 # le modèle les a perdus
    out, info = _apply_one_edit(text, {"action": "str_replace",
                                       "old_str": old, "new_str": "x = 0\n"})
    assert out == "x = 0\n"
    assert info["matched"] == "trailing_ws"
    assert info["replacements"] == 1


def test_uniform_indent_shift_reindents_new_str():
    text = ("class A:\n"
            "    def f(self):\n"
            "        if x:\n"
            "            return 1\n")
    # Le modèle cite le bloc SANS l'indentation de classe (décalage -4 uniforme).
    old = ("def f(self):\n"
           "    if x:\n"
           "        return 1\n")
    new = ("def f(self):\n"
           "    if x:\n"
           "        return 2\n")
    out, info = _apply_one_edit(text, {"action": "str_replace",
                                       "old_str": old, "new_str": new})
    assert info["matched"] == "indent_shift"
    # new_str a été ré-indenté pour suivre le fichier (+4).
    assert "            return 2\n" in out
    assert out.startswith("class A:\n    def f(self):\n")


def test_non_uniform_shift_refused():
    text = "    a\n        b\n"
    old = "a\n    c\n"          # contenu différent → jamais matché
    with pytest.raises(ValueError, match="not found"):
        _apply_one_edit(text, {"action": "str_replace", "old_str": old, "new_str": "x"})
    old2 = "a\nb\n"             # décalages +4 puis +8 → NON uniforme → refus
    with pytest.raises(ValueError, match="not found"):
        _apply_one_edit(text, {"action": "str_replace", "old_str": old2, "new_str": "x"})


def test_flexible_ambiguity_counted():
    text = "    foo()\nsep\n        foo()\n"
    spans = _flexible_block_matches(text, "foo()\n")
    assert len(spans) == 2
    with pytest.raises(ValueError, match="expected 1 occurrences, found 2"):
        _apply_one_edit(text, {"action": "str_replace",
                               "old_str": "foo()\n", "new_str": "bar()\n"})
    # count=-1 : remplace les deux, chacun à SON indentation.
    out, info = _apply_one_edit(text, {"action": "str_replace", "count": -1,
                                       "old_str": "foo()\n", "new_str": "bar()\n"})
    assert out == "    bar()\nsep\n        bar()\n"
    assert info["replacements"] == 2


def test_mid_line_fragment_not_flex_matched():
    """Un fragment en MILIEU de ligne relève du match exact — le repli
    ligne-aligné ne doit pas s'en mêler (risque de faux positifs)."""
    text = "value = compute(a, b)\n"
    with pytest.raises(ValueError, match="not found"):
        _apply_one_edit(text, {"action": "str_replace",
                               "old_str": "compute(a,b)", "new_str": "x"})


# ──────────────────────────────────────────────────────────────────────────
# Outils enregistrés (FakeMCP) — CRLF/BOM, encodage strict, coercition
# ──────────────────────────────────────────────────────────────────────────

class _FakeMCP:
    def __init__(self):
        self.tools = {}

    def tool(self, **kw):
        def deco(fn):
            self.tools[fn.__name__] = fn
            return fn
        return deco


@pytest.fixture()
def fs(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_SANDBOX_DIR", str(tmp_path))
    mcp = _FakeMCP()
    fs_tools.register(mcp, tmp_path)
    work = tmp_path / "guest" / "work"
    work.mkdir(parents=True, exist_ok=True)
    return mcp.tools, work


def test_edit_file_crlf_match_and_restore(fs):
    tools, work = fs
    f = work / "win.txt"
    f.write_bytes(b"line one\r\nline two\r\nline three\r\n")
    out = tools["edit_file"](None, path="win.txt", action="str_replace",
                             old_str="line two\n", new_str="LINE 2\n")
    assert out.get("ok") is True, out
    assert out.get("line_endings") == "crlf"
    data = f.read_bytes()
    assert data == b"line one\r\nLINE 2\r\nline three\r\n"   # CRLF restauré


def test_edit_file_bom_preserved(fs):
    tools, work = fs
    f = work / "bom.txt"
    f.write_bytes(b"\xef\xbb\xbfhello\nworld\n")
    out = tools["edit_file"](None, path="bom.txt", action="str_replace",
                             old_str="hello", new_str="salut")
    assert out.get("ok") is True, out
    data = f.read_bytes()
    assert data.startswith(b"\xef\xbb\xbf")                  # BOM conservé
    assert b"salut" in data


def test_edit_file_edits_as_json_string_coerced(fs):
    tools, work = fs
    f = work / "multi.txt"
    f.write_text("aaa\nbbb\n", encoding="utf-8")
    edits_str = json.dumps([
        {"action": "str_replace", "old_str": "aaa", "new_str": "AAA"},
        {"action": "str_replace", "old_str": "bbb", "new_str": "BBB"},
    ])
    out = tools["edit_file"](None, path="multi.txt", action="multi", edits=edits_str)
    assert out.get("ok") is True, out
    assert f.read_text(encoding="utf-8") == "AAA\nBBB\n"


def test_write_file_strict_encoding_error(fs):
    tools, work = fs
    out = tools["write_file"](None, path="latin.txt", content="héllo €",
                              encoding="ascii")
    assert out.get("ok") is False
    assert out.get("error") == "encoding_mismatch"
    assert not (work / "latin.txt").exists()                 # rien d'écrit
    # utf-8 (défaut) passe.
    out2 = tools["write_file"](None, path="latin.txt", content="héllo €")
    assert out2.get("ok") is True
    assert (work / "latin.txt").read_text(encoding="utf-8") == "héllo €"
