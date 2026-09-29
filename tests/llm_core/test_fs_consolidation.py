# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_fs_consolidation.py — jeu d'outils fs RÉDUIT
(8 → 6, passe « moins d'outils, plus capables » 2026-07).

- registre : exactement {read_file, write_file, edit_file, list_files,
  manage_files, code} — stat_path / code_outline / code_navigate retirés ;
- list_files absorbe stat_path : path=<fichier> → métadonnées (sha via
  details=True) ; search_text sur un fichier → grep mono-fichier ;
- code() fusionne outline / symbols / definition / references ;
- write_file : mode='mkdir' retiré du schéma (erreur guidée en compat) ;
- read_file : include_outline / summary retirés du schéma.
"""
from __future__ import annotations

import inspect
from pathlib import Path

import pytest

import llm_core.tools.fs_tools as fs_tools


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


def test_registry_is_exactly_six_tools(fs):
    tools, _ = fs
    assert sorted(tools) == ["code", "edit_file", "list_files",
                             "manage_files", "read_file", "write_file"]


def test_read_file_slimmed_schema(fs):
    tools, _ = fs
    params = set(inspect.signature(tools["read_file"]).parameters)
    assert "include_outline" not in params
    assert "summary" not in params
    assert "grep" in params            # le grep in-file reste (capacité)


# ── list_files : absorption de stat_path ─────────────────────────────────

def test_list_files_walk_borne_les_gros_arbres(fs, monkeypatch):
    """Régression 2026-07-18 : un rglob récursif matérialisait TOUT l'arbre
    (RAM/CPU non bornés) avant de capper la page. Le walk s'arrête désormais
    au-delà de MAX_WALK entrées visitées et signale ``walk_truncated``."""
    tools, work = fs
    monkeypatch.setattr(fs_tools, "MAX_WALK", 5)   # plafond bas pour le test
    d = work / "big"
    d.mkdir()
    for i in range(20):
        (d / f"f{i:02d}.txt").write_text("x", encoding="utf-8")
    out = tools["list_files"](None, path="big", recursive=True, max_results=100)
    assert out.get("ok") is True and out["action"] == "list"
    assert out.get("walk_truncated") is True
    assert out.get("truncated") is True
    # La sortie est bornée par le walk cap (jamais les 20 entrées).
    assert len(out["items"]) <= 5
    assert "too large" in out.get("hint", "").lower()


def test_list_files_stats_a_file(fs):
    tools, work = fs
    (work / "doc.txt").write_text("bonjour\nmonde\n", encoding="utf-8")
    out = tools["list_files"](None, path="doc.txt")
    assert out.get("ok") is True and out["action"] == "stat"
    assert out["content_type"] == "text"
    assert out.get("mime")
    assert "sha256" not in out
    out2 = tools["list_files"](None, path="doc.txt", details=True)
    assert len(out2.get("sha256", "")) == 64


def test_list_files_greps_single_file(fs):
    tools, work = fs
    (work / "app.log").write_text("info: ok\nerror: boom\ninfo: done\n",
                                  encoding="utf-8")
    out = tools["list_files"](None, path="app.log", search_text="error")
    assert out.get("ok") is True and out["action"] == "grep"
    assert out["count"] == 1
    assert out["hits"][0]["line"] == 2


def test_list_files_dir_mode_unchanged(fs):
    tools, work = fs
    (work / "a.py").write_text("x=1\n")
    (work / "b.txt").write_text("y\n")
    out = tools["list_files"](None, path=".", pattern="*.py")
    assert out.get("ok") is True and out["action"] == "list"
    assert out["items"] == ["a.py"]


# ── code : outil fusionné ────────────────────────────────────────────────

pytestmark_ci = pytest.mark.skipif(not fs_tools._HAS_CI,
                                   reason="code_intel indisponible")


@pytestmark_ci
def test_code_outline_and_symbols(fs):
    tools, work = fs
    (work / "m.py").write_text(
        "class A:\n    def f(self):\n        return 1\n\ndef g():\n    pass\n",
        encoding="utf-8")
    out = tools["code"](None, action="outline", path="m.py")
    assert out.get("ok") is True and out["language"] == "python"
    assert out["outline"]

    out2 = tools["code"](None, action="symbols", path="m.py")
    assert out2.get("ok") is True
    names = {s.get("name") for s in out2["matches"]}
    assert {"A", "g"} <= names


@pytestmark_ci
def test_code_definition_and_references(fs):
    tools, work = fs
    (work / "lib.py").write_text("def target():\n    return 1\n", encoding="utf-8")
    (work / "use.py").write_text("from lib import target\nprint(target())\n",
                                 encoding="utf-8")
    d = tools["code"](None, action="definition", symbol="target",
                      include_glob="*.py")
    assert d.get("ok") is True and d["count"] >= 1
    assert any(h["file"] == "lib.py" for h in d["matches"])

    r = tools["code"](None, action="references", symbol="target",
                      include_glob="*.py")
    assert r.get("ok") is True and r["count"] >= 2



def test_code_prefiltre_sans_perte(fs):
    """Le préfiltre de l'agent garde tout fichier qui peut répondre : mot-clé
    Robot écrit autrement, casse différente ; l'ordre reste celui du parcours."""
    tools, work = fs
    (work / "b").mkdir()
    (work / "b" / "suite.robot").write_text(
        "*** Test Cases ***\nCas\n    open_browser    x\n", encoding="utf-8")
    (work / "a.robot").write_text(
        "*** Keywords ***\nOpen Browser\n    Log    ok\n", encoding="utf-8")
    (work / "node_modules").mkdir()
    (work / "node_modules" / "dep.robot").write_text(
        "*** Keywords ***\nOpen Browser\n    Log    dep\n", encoding="utf-8")
    r = tools["code"](None, action="references", symbol="Open Browser")
    assert r["ok"] and [h["file"] for h in r["matches"]] == ["a.robot", "b/suite.robot"], r
    d = tools["code"](None, action="definition", symbol="Open Browser")
    assert [h["file"] for h in d["matches"]] == ["a.robot"], d
    assert d["files_scanned"] == 2

def test_code_invalid_action_guided(fs):
    tools, _ = fs
    out = tools["code"](None, action="find_definition", symbol="x")
    assert out.get("ok") is False
    assert "outline | symbols | definition | references" in (out.get("fix") or "")


# ── write_file : mkdir dédoublonné ───────────────────────────────────────

def test_write_file_mkdir_moved(fs):
    tools, work = fs
    out = tools["write_file"](None, path="newdir", mode="mkdir")
    assert out.get("ok") is False and out.get("error") == "mkdir_moved"
    assert "manage_files" in (out.get("fix") or "")
    ok = tools["manage_files"](None, action="mkdir", path="newdir")
    assert ok.get("ok") is True and (work / "newdir").is_dir()
