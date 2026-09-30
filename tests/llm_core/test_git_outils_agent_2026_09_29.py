# SPDX-License-Identifier: MIT
"""Outils Git de l'assistant, exécutés par l'agent de la sandbox (L4.4) :
comportements repris des tests de l'ancienne prison Git de l'hôte."""
from __future__ import annotations

from llm_core.tools import git_tools
from tests._git_amont import _git


class _FakeMCP:
    def __init__(self):
        self.tools = {}

    def tool(self, **kw):
        def deco(fn):
            self.tools[fn.__name__] = fn
            return fn
        return deco


def _repo(path):
    path.mkdir(parents=True)
    _git(path, "init", "-q", "-b", "main")
    (path / "a.txt").write_text("un\n")
    _git(path, "add", "a.txt")
    _git(path, "commit", "-q", "-m", "init")
    return path


def test_branche_par_defaut_malgre_une_branche_locale_origin_main(tmp_path):
    rp = _repo(tmp_path / "r")
    git_tools._remember_work_root(tmp_path, "guest")
    _git(rp, "update-ref", "refs/remotes/origin/main", "HEAD")
    _git(rp, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
    _git(rp, "branch", "origin/main")           # rend « --short » ambigu
    assert git_tools._default_base_branch(rp) == "main"


def test_files_liste_aussi_la_racine_du_depot(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_SANDBOX_DIR", str(tmp_path))
    mcp = _FakeMCP()
    git_tools.register(mcp, tmp_path)
    work = tmp_path / "guest" / "work"
    rp = _repo(work / "proj")
    (rp / "src").mkdir()
    (rp / "src" / "b.py").write_text("x\n")
    items = mcp.tools["git_query"](None, repo="proj", action="files")["items"]
    assert {"a.txt", "src/b.py"} <= set(items)
    py = mcp.tools["git_query"](None, repo="proj", action="files", pattern="**/*.py")["items"]
    assert py == ["src/b.py"]
