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
    repo = sandboxes / "alice" / "work" / "src" / "repo"
    assert git_env._jail_root(repo) == sandboxes / "alice" / "work"
    assert git_env._jail_root(sandboxes / "alice" / "work") == sandboxes / "alice" / "work"
    ailleurs = tmp_path / "ailleurs"
    assert git_env._jail_root(ailleurs) == ailleurs


def test_argv_de_la_prison(sandboxes, monkeypatch):
    monkeypatch.setattr(bwrap, "binary", lambda: "/usr/bin/bwrap")
    repo = sandboxes / "alice" / "work" / "repo"
    root = str(sandboxes / "alice" / "work")
    env = {"HOME": "/srv/app/user_db/.git-home", "GIT_ASKPASS": "/tmp/git_askpass_x.sh"}

    argv = git_env._jail_argv(repo, env, network=False)
    assert argv[0] == "/usr/bin/bwrap" and "--unshare-all" in argv
    assert "--share-net" not in argv
    i = argv.index("--bind")
    assert argv[i + 1:i + 3] == [root, root]                 # la zone de travail, rien d'autre
    assert argv[-2:] == ["--chdir", str(repo)]
    assert ["--ro-bind", "/etc", "/etc"] == argv[argv.index("/etc") - 1:argv.index("/etc") + 2]
    for v in env.values():
        assert v in argv                                     # HOME et askpass, en lecture

    net = git_env._jail_argv(repo, env, network=True)
    assert "--share-net" in net and "/run/systemd/resolve" in net


def test_isolation_indisponible_ne_lance_rien(monkeypatch, tmp_path):
    monkeypatch.setattr(git_env, "git_isolation", lambda: "unavailable")
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: pytest.fail("lancé"))
    r = run_host_git(["git", "status"], cwd=tmp_path, env={}, capture_output=True, text=True)
    assert r.returncode == 1 and "bubblewrap" in r.stderr
    rb = run_host_git(["git", "status"], cwd=tmp_path, env={}, capture_output=True)
    assert isinstance(rb.stderr, bytes)


def test_sans_isolation_seulement_si_demande(monkeypatch, tmp_path):
    from shared_infra import config
    monkeypatch.setattr(config, "live_config_value",
                        lambda path, default=None: "none" if path == "executors.git_isolation" else default)
    assert git_env.git_isolation() == "none"
    seen = {}
    monkeypatch.setattr(subprocess, "run", lambda argv, **k: seen.setdefault("argv", argv))
    run_host_git(["git", "status"], cwd=tmp_path, env={})
    assert seen["argv"] == ["git", "status"]


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
