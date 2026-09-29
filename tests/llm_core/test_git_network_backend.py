# SPDX-License-Identifier: MIT
"""Outils git réseau par le relais authentifiant (L4.4) : clone, fetch, pull
et push des outils de l'assistant, de bout en bout — agent en thread, relais
de l'hôte, ``git http-backend`` en amont. L'identifiant du connecteur est
ajouté par l'hôte : il n'apparaît ni dans la sandbox ni dans le dépôt."""
from __future__ import annotations

import subprocess

import pytest

from llm_core.tools import git_tools
from shared_infra.sandbox import git_ops
from tests._git_amont import BASIC, JETON, _git, demarrer_amont


class _FakeMCP:
    def __init__(self):
        self.tools = {}

    def tool(self, **kw):
        def deco(fn):
            self.tools[fn.__name__] = fn
            return fn
        return deco


@pytest.fixture()
def outils(tmp_path, monkeypatch):
    base = tmp_path / "sb"
    monkeypatch.setenv("APP_SANDBOX_DIR", str(base))
    mcp = _FakeMCP()
    git_tools.register(mcp, base)
    work = base / "guest" / "work"
    work.mkdir(parents=True)
    amont = demarrer_amont(tmp_path)
    hote = amont.url.split("/")[2]                       # 127.0.0.1:<port>
    # Connecteur enregistré pour cet hôte : adresse locale permise, identifiant
    # fourni par l'hôte.
    monkeypatch.setattr(git_ops, "connector_hosts", lambda uid: {hote})
    monkeypatch.setattr(git_ops, "_credential", lambda uid, url: ("u", JETON))
    yield mcp.tools, work, amont
    amont.shutdown()
    amont.server_close()


def _nouveau_commit(amont, nom):
    (amont.src / nom).write_text(nom + "\n")
    _git(amont.src, "add", nom)
    _git(amont.src, "commit", "-q", "-m", nom)
    _git(amont.src, "push", "-q", amont.racine + "/depot.git", "main")


def test_clone_fetch_pull(outils):
    tools, work, amont = outils
    r = tools["git_action"](None, repo="copie", action="clone", target=amont.url)
    assert r.get("ok") and r.get("returncode") == 0, r
    assert r["repo_path"] == "/work/copie"
    assert (work / "copie" / "a.txt").read_text() == "a\n"
    assert JETON not in (work / "copie" / ".git" / "config").read_text()
    assert amont.vus and all(a == BASIC for _m, _p, a in amont.vus)

    _nouveau_commit(amont, "b.txt")
    r = tools["git_action"](None, repo="copie", action="fetch")
    assert r.get("ok") and r.get("returncode") == 0, r
    r = tools["git_action"](None, repo="copie", action="pull", branch="main")
    assert r.get("ok") and r.get("returncode") == 0, r
    assert (work / "copie" / "b.txt").read_text() == "b.txt\n"


def test_git_clone_puis_submit_pousse_la_branche_de_l_agent(outils):
    tools, work, amont = outils
    r = tools["git_clone"](None, url=amont.url, into_path="proj")
    assert r.get("ok"), r
    sw = tools["git_start_work"](None, repo="proj", branch_intent="ship-it")
    assert sw.get("ok") and sw.get("pull") == "ok", sw
    (work / "proj" / "c.txt").write_text("c\n")
    assert tools["git_commit"](None, repo="proj", message="Ajoute c")["ok"]
    r = tools["git_submit"](None, repo="proj", title="Ship it")
    refs = subprocess.run(["git", "for-each-ref", "--format=%(refname)"],
                          cwd=amont.racine + "/depot.git", capture_output=True,
                          text=True).stdout.split()
    assert f"refs/heads/{sw['branch']}" in refs, (r, refs)
    assert refs.count("refs/heads/main") == 1


def test_remote_interne_refuse_sans_connecteur(outils, monkeypatch):
    tools, work, amont = outils
    monkeypatch.setattr(git_ops, "connector_hosts", lambda uid: set())
    r = tools["git_action"](None, repo="copie", action="clone", target=amont.url)
    assert not r.get("ok") and r["error"].startswith("clone_url_blocked"), r
    assert not (work / "copie").exists() and not amont.vus
