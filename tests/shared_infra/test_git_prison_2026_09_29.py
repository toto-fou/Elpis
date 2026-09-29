# SPDX-License-Identifier: MIT
"""Git hôte enfermé dans bwrap (2026-09-29) : la configuration d'un dépôt de
sandbox peut changer entre le contrôle (``repo_refusal``) et l'exécution ; ce
qu'elle fait exécuter doit rester confiné à la zone de travail de
l'utilisateur, et un ``cwd`` remplacé par un lien ne doit mener nulle part."""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from shared_infra.sandbox import bwrap, git_env
from shared_infra.sandbox.git_env import host_git_env, run_host_git

_HAS_BWRAP = bwrap.probe()


@pytest.fixture
def sandboxes(tmp_path, monkeypatch):
    """``<tmp>/sb/<user>/work``, comme ``SANDBOX_DIR``."""
    from shared_infra import config
    sb = tmp_path / "sb"
    for user in ("alice", "bob"):
        (sb / user / "work").mkdir(parents=True)
    monkeypatch.setattr(config, "SANDBOX_DIR", sb)
    return sb


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True,
                   env={"PATH": "/usr/bin:/bin", "HOME": str(cwd),
                        "GIT_CONFIG_NOSYSTEM": "1"})


def _repo(path: Path) -> Path:
    path.mkdir(parents=True)
    _git(path, "init", "-q", "-b", "main")
    _git(path, "config", "user.email", "t@t")
    _git(path, "config", "user.name", "t")
    (path / "a.txt").write_text("un\n")
    _git(path, "add", "a.txt")
    _git(path, "commit", "-q", "-m", "init")
    return path


def test_sous_commande():
    sub = git_env._subcommand
    assert sub(["git", "-c", "a.b=c", "fetch", "origin"]) == "fetch"
    assert sub(["git", "-C", "x", "status"]) == "status"
    assert sub(["git", "--no-pager", "log"]) == "log"
    assert sub(["git"]) == ""


def test_racine_de_la_prison(sandboxes, tmp_path):
    work = sandboxes / "alice" / "work"
    assert git_env._jail_root(work / "src" / "repo") == work
    assert git_env._jail_root(work) == work
    for hors_zone in (sandboxes, sandboxes / "alice", sandboxes / "alice" / "snapshots"):
        assert git_env._jail_root(hors_zone) is None
    ailleurs = tmp_path / "ailleurs"
    assert git_env._jail_root(ailleurs) == ailleurs


def test_argv_de_la_prison(sandboxes, monkeypatch):
    monkeypatch.setattr(bwrap, "binary", lambda: "/usr/bin/bwrap")
    work = sandboxes / "alice" / "work"
    repo = work / "repo"
    env = {"HOME": "/srv/app/user_db/.git-home", "GIT_ASKPASS": "/tmp/git_askpass_x.sh"}

    argv = git_env._jail_argv(repo, work, env, network=False)
    assert argv[0] == "/usr/bin/bwrap" and "--unshare-all" in argv
    assert "--share-net" not in argv
    i = argv.index("--bind")
    assert argv[i + 1:i + 3] == [str(work), str(work)]       # la zone de travail, rien d'autre
    assert argv[-2:] == ["--chdir", str(repo)]
    assert "/etc" not in argv and "/etc/passwd" in argv      # /etc réduit
    assert "/etc/resolv.conf" not in argv
    for v in env.values():
        assert v in argv                                     # HOME et askpass, en lecture

    net = git_env._jail_argv(repo, work, env, network=True)
    assert "--share-net" in net and "/etc/resolv.conf" in net


def test_hors_zone_de_travail_rien_n_est_lance(sandboxes, monkeypatch):
    monkeypatch.setattr(git_env, "git_isolation", lambda: "bwrap")
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: pytest.fail("lancé"))
    r = run_host_git(["git", "status"], cwd=sandboxes / "alice", env={},
                     capture_output=True, text=True)
    assert r.returncode == 1 and "zone de travail" in r.stderr


def _fake_jail(monkeypatch, rc=lambda argv: 0):
    """``subprocess.run`` factice : note (cwd, réseau, commande, env, timeout)."""
    monkeypatch.setattr(git_env, "git_isolation", lambda: "bwrap")
    calls = []

    def fake_run(argv, **kw):
        i = argv.index("--chdir")
        cmd = argv[i + 2:]
        calls.append({"cwd": argv[i + 1], "net": "--share-net" in argv, "cmd": cmd,
                      "argv": argv, "env": kw.get("env"), "timeout": kw.get("timeout")})
        return subprocess.CompletedProcess(argv, rc(cmd), "", "")
    monkeypatch.setattr(subprocess, "run", fake_run)
    return calls


def test_le_reseau_ne_sert_qu_au_transfert(sandboxes, monkeypatch):
    work = sandboxes / "alice" / "work"
    calls = _fake_jail(monkeypatch)

    def phases():
        out = [(c["cwd"], c["net"], c["cmd"]) for c in calls]
        calls.clear()
        return out

    run_host_git(["git", "clone", "--depth", "50", "--", "https://h/r.git", str(work / "r")],
                 cwd=work, env={})
    assert phases() == [
        (str(work), True, ["git", "clone", "--no-checkout", "--depth", "50", "--",
                           "https://h/r.git", str(work / "r")]),
        (str(work / "r"), False, ["git", "reset", "--hard", "-q"])]

    r = str(work / "r")
    for opt, suite in (("--ff-only", ["merge", "--ff-only"]), ("--rebase", ["merge", "--ff-only"]),
                       ("--no-rebase", ["merge", "--no-edit"])):
        run_host_git(["git", "pull", opt, "origin", "main"], cwd=work / "r", env={})
        assert phases() == [(r, True, ["git", "fetch", "origin", "main"]),
                            (r, False, ["git", *suite, "FETCH_HEAD"])]
    # Sans branche : l'amont de la branche courante, comme ``pull``.
    for args in (["pull"], ["pull", "--rebase"], ["pull", "--ff-only", "origin"]):
        run_host_git(["git", *args], cwd=work / "r", env={})
        assert phases()[1][2][-1] == "@{upstream}"

    run_host_git(["git", "status"], cwd=work / "r", env={})
    run_host_git(["git", "push", "origin", "agent/x"], cwd=work / "r", env={})
    assert [net for _cwd, net, _cmd in phases()] == [False, True]
    with pytest.raises(ValueError):
        run_host_git(["git", "pull", "--squash"], cwd=work / "r", env={})


def test_rebase_seulement_si_pas_d_avance_rapide(sandboxes, monkeypatch):
    work = sandboxes / "alice" / "work"
    calls = _fake_jail(monkeypatch, rc=lambda cmd: 1 if "--ff-only" in cmd else 0)
    r = run_host_git(["git", "pull", "--rebase", "origin", "main"], cwd=work, env={},
                     capture_output=True, text=True)
    assert [c["cmd"][1:] for c in calls] == [["fetch", "origin", "main"],
                                           ["merge", "--ff-only", "FETCH_HEAD"],
                                           ["rebase", "FETCH_HEAD"]]
    assert r.returncode == 0


def test_la_suite_locale_ne_voit_ni_jeton_ni_askpass(sandboxes, monkeypatch):
    work = sandboxes / "alice" / "work"
    calls = _fake_jail(monkeypatch)
    env = {"HOME": "/srv/home", "GIT_ASKPASS": "/tmp/askpass.sh",
           "GIT_ASKPASS_USER": "u", "GIT_ASKPASS_PASS": "jeton"}
    run_host_git(["git", "pull", "--ff-only", "origin", "main"], cwd=work, env=env)
    transfert, suite = calls
    assert transfert["env"]["GIT_ASKPASS_PASS"] == "jeton" and "/tmp/askpass.sh" in transfert["argv"]
    assert not any(k.startswith("GIT_ASKPASS") for k in suite["env"])
    assert "/tmp/askpass.sh" not in suite["argv"]


def test_une_echeance_pour_les_deux_temps(sandboxes, monkeypatch):
    work = sandboxes / "alice" / "work"
    calls = _fake_jail(monkeypatch)
    horloge = iter([100.0, 100.0, 130.0])        # 30 s passées pendant le transfert
    monkeypatch.setattr(git_env.time, "monotonic", lambda: next(horloge))
    run_host_git(["git", "pull", "--ff-only", "origin", "main"], cwd=work, env={}, timeout=120)
    assert [c["timeout"] for c in calls] == [120.0, 90.0]


def test_certificats_montes_meme_sous_etc(sandboxes, monkeypatch):
    monkeypatch.setattr(bwrap, "binary", lambda: "/usr/bin/bwrap")
    work = sandboxes / "alice" / "work"
    argv = git_env._jail_argv(work, work, {"SSL_CERT_FILE": "/etc/corp/ca.pem",
                                           "GIT_SSL_CAPATH": "/usr/share/ca"}, network=True)
    assert "/etc/corp/ca.pem" in argv and "/usr/share/ca" not in argv


@pytest.mark.skipif(not _HAS_BWRAP, reason="bwrap indisponible sur ce poste")
def test_un_pilote_ajoute_apres_le_controle_reste_en_prison(sandboxes, tmp_path):
    repo = _repo(sandboxes / "alice" / "work" / "repo")
    dehors = tmp_path / "dehors"
    dehors.mkdir()
    # Ce que le conteneur écrirait APRÈS repo_refusal : un pilote textconv.
    (repo / ".gitattributes").write_text("*.txt diff=pwn\n")
    _git(repo, "config", "diff.pwn.textconv",
         f"touch {dehors}/pwned {repo}/dedans; cat")
    (repo / "a.txt").write_text("deux\n")

    r = run_host_git(["git", "diff", "HEAD"], cwd=repo, env=host_git_env(cwd=repo),
                     capture_output=True, text=True, timeout=30)
    assert r.returncode == 0, r.stderr
    assert (repo / "dedans").exists()            # le pilote a bien tourné…
    assert not (dehors / "pwned").exists()       # …sans rien voir hors de la zone


@pytest.mark.skipif(not _HAS_BWRAP, reason="bwrap indisponible sur ce poste")
def test_un_cwd_remplace_par_un_lien_ne_mene_nulle_part(sandboxes):
    bob = _repo(sandboxes / "bob" / "work" / "repo")
    lien = sandboxes / "alice" / "work" / "repo"
    lien.symlink_to("../../bob/work/repo")       # posé après la résolution par l'appelant

    r = run_host_git(["git", "log", "--oneline"], cwd=lien, env=host_git_env(cwd=lien),
                     capture_output=True, text=True, timeout=30)
    assert r.returncode != 0
    assert "init" not in r.stdout                # l'historique de bob reste invisible
    assert (bob / "a.txt").read_text() == "un\n"


@pytest.mark.skipif(not _HAS_BWRAP, reason="bwrap indisponible sur ce poste")
def test_clone_puis_pull_en_deux_temps(sandboxes):
    work = sandboxes / "alice" / "work"
    src = _repo(work / "src")
    # Dépôt local visible dans la prison ; environnement minimal (le durci
    # refuse le protocole ``file``, sans objet ici).
    env = {"PATH": "/usr/bin:/bin", "HOME": str(work), "GIT_CONFIG_NOSYSTEM": "1",
           **{f"GIT_{r}_{k}": v for r in ("AUTHOR", "COMMITTER")
              for k, v in (("NAME", "t"), ("EMAIL", "t@t"))}}

    def git(cwd, *args):
        r = run_host_git(["git", *args], cwd=cwd, env=env, capture_output=True, text=True,
                         timeout=30)
        assert r.returncode == 0, r.stderr
        return r

    git(work, "clone", "-q", str(src), str(work / "copie"))
    assert (work / "copie" / "a.txt").read_text() == "un\n"
    assert git(work / "copie", "status", "--porcelain").stdout == ""

    (src / "a.txt").write_text("deux\n")
    _git(src, "commit", "-qam", "deux")
    git(work / "copie", "pull", "--ff-only", "origin", "main")
    assert (work / "copie" / "a.txt").read_text() == "deux\n"

    vide = work / "vide.git"
    _git(work, "init", "-q", "--bare", "-b", "main", str(vide))
    git(work, "clone", "-q", str(vide), str(work / "copie-vide"))   # dépôt vide : toléré
    # Branche non née : ``--rebase`` avance en rapide, comme ``pull``.
    _git(src, "push", "-q", str(vide), "main")
    git(work / "copie-vide", "pull", "--rebase", "origin", "main")
    assert (work / "copie-vide" / "a.txt").read_text() == "deux\n"

    # Divergence : rebase de la branche locale sur l'amont.
    copie = work / "copie"
    (copie / "b.txt").write_text("local\n")
    _git(copie, "add", "b.txt")
    _git(copie, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "local")
    (src / "a.txt").write_text("trois\n")
    _git(src, "commit", "-qam", "trois")
    git(copie, "pull", "--rebase")
    log = git(copie, "log", "--format=%s").stdout.split()
    assert log[:3] == ["local", "trois", "deux"]


@pytest.mark.skipif(not _HAS_BWRAP, reason="bwrap indisponible sur ce poste")
def test_pull_sans_amont_echoue_comme_git(sandboxes):
    work = sandboxes / "alice" / "work"
    src = _repo(work / "src")
    _git(src, "branch", "aaa")                    # 1re ligne possible de FETCH_HEAD
    env = {"PATH": "/usr/bin:/bin", "HOME": str(work), "GIT_CONFIG_NOSYSTEM": "1"}
    subprocess.run(["git", "clone", "-q", str(src), str(work / "copie")], check=True,
                   capture_output=True, env=env)
    copie = work / "copie"
    _git(copie, "switch", "-q", "-c", "agent/x")
    (copie / "c.txt").write_text("x\n")
    _git(copie, "add", "c.txt")
    _git(copie, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "agent")
    avant = subprocess.run(["git", "rev-parse", "HEAD"], cwd=copie, capture_output=True,
                           text=True, env=env).stdout
    for args in (["pull"], ["pull", "--rebase"], ["pull", "--ff-only", "origin"]):
        r = run_host_git(["git", *args], cwd=copie, env=env, capture_output=True, text=True,
                         timeout=30)
        assert r.returncode != 0, args
    assert subprocess.run(["git", "rev-parse", "HEAD"], cwd=copie, capture_output=True,
                          text=True, env=env).stdout == avant


@pytest.mark.skipif(not _HAS_BWRAP, reason="bwrap indisponible sur ce poste")
def test_git_fonctionne_normalement_en_prison(sandboxes):
    repo = _repo(sandboxes / "alice" / "work" / "repo")
    (repo / "b.txt").write_text("x\n")
    env = host_git_env(cwd=repo)
    for args in (["add", "b.txt"], ["commit", "-q", "-m", "b"]):
        r = run_host_git(["git", *args], cwd=repo, env=env, capture_output=True, text=True,
                         timeout=30)
        assert r.returncode == 0, r.stderr
    log = run_host_git(["git", "log", "--oneline"], cwd=repo, env=env,
                       capture_output=True, text=True, timeout=30)
    assert log.stdout.count("\n") == 2


# ── Outils Git de l'agent ───────────────────────────────────────────────────

def test_branche_par_defaut_malgre_une_branche_locale_origin_main(tmp_path):
    from llm_core.tools import git_tools
    rp = _repo(tmp_path / "r")
    _git(rp, "update-ref", "refs/remotes/origin/main", "HEAD")
    _git(rp, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
    _git(rp, "branch", "origin/main")           # rend « --short » ambigu
    assert git_tools._default_base_branch(rp) == "main"


def test_files_liste_aussi_la_racine_du_depot(tmp_path, monkeypatch):
    from llm_core.tools import git_tools

    class _FakeMCP:
        def __init__(self):
            self.tools = {}

        def tool(self, **kw):
            def deco(fn):
                self.tools[fn.__name__] = fn
                return fn
            return deco
    monkeypatch.setenv("APP_SANDBOX_DIR", str(tmp_path))
    monkeypatch.setattr(git_tools, "_grant_sandbox_access", lambda *a, **k: None)
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
