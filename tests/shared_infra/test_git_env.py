# SPDX-License-Identifier: MIT
"""Tests for the shared git-hardening environment builder."""
from shared_infra.sandbox.git_env import hardened_git_env


def _config_map(env):
    n = int(env["GIT_CONFIG_COUNT"])
    return {env[f"GIT_CONFIG_KEY_{i}"]: env[f"GIT_CONFIG_VALUE_{i}"] for i in range(n)}


def test_disables_repo_hooks():
    cfg = _config_map(hardened_git_env())
    assert cfg.get("core.hooksPath") == "/dev/null"


def test_sets_terminal_prompt_default():
    assert hardened_git_env()["GIT_TERMINAL_PROMPT"] == "0"


def test_caller_terminal_prompt_preserved():
    # we only setdefault — an explicit caller value wins
    assert hardened_git_env({"GIT_TERMINAL_PROMPT": "1"})["GIT_TERMINAL_PROMPT"] == "1"


def test_pure_does_not_mutate_base():
    base = {"PATH": "/usr/bin"}
    out = hardened_git_env(base)
    assert "GIT_CONFIG_COUNT" not in base  # base untouched
    assert out["PATH"] == "/usr/bin"       # base values carried through


def test_appends_to_existing_config_count():
    base = {
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "user.name",
        "GIT_CONFIG_VALUE_0": "x",
    }
    cfg = _config_map(hardened_git_env(base))
    assert cfg["user.name"] == "x"             # pre-existing key preserved
    assert cfg["core.hooksPath"] == "/dev/null"  # hardening appended


def test_preserves_askpass_credentials():
    env = hardened_git_env({"GIT_ASKPASS": "/tmp/x.sh", "GIT_ASKPASS_USER": "u"})
    assert env["GIT_ASKPASS"] == "/tmp/x.sh"
    assert env["GIT_ASKPASS_USER"] == "u"


# ── AUDIT 2026-06 — clés .git/config à nom fixe neutralisées ─────────────

def test_neutralizes_fixed_name_rce_keys():
    cfg = _config_map(hardened_git_env())
    assert cfg.get("core.fsmonitor") == "false"
    assert cfg.get("protocol.file.allow") == "never"
    assert cfg.get("credential.helper") == ""   # reset de la liste des helpers
    assert cfg.get("core.pager") == "cat"


def test_bounds_child_git_protocols():
    env = hardened_git_env()
    assert env["GIT_ALLOW_PROTOCOL"] == "http:https:git"
    from shared_infra.git.ssrf import GIT_REMOTE_SCHEMES
    assert set(env["GIT_ALLOW_PROTOCOL"].split(":")) == GIT_REMOTE_SCHEMES
    # ext:: (RCE) et file:// implicite exclus
    assert "ext" not in env["GIT_ALLOW_PROTOCOL"].split(":")


def test_caller_allow_protocol_preserved():
    env = hardened_git_env({"GIT_ALLOW_PROTOCOL": "https"})
    assert env["GIT_ALLOW_PROTOCOL"] == "https"


# ── Audit 2026-09-21 (S4) : clés à nom libre refusées avant toute commande ──

import subprocess as _sp

import pytest


def _git_hote(repo, *args):
    """L'ancien chemin des routes (``_git_run``, retiré en L4.4 : git tourne
    dans la sandbox) : contrôle du dépôt, puis git hôte en prison."""
    from shared_infra.sandbox.git_env import host_git_env, repo_refusal, run_host_git
    env = host_git_env(cwd=repo)
    bad = repo_refusal(repo, env)
    if bad:
        return _sp.CompletedProcess(["git", *args], 1, "", f"Dépôt refusé : {bad[1]}")
    return run_host_git(["git", *args], cwd=repo, env=env, capture_output=True, text=True,
                        timeout=30)


def _repo(tmp_path, *cfg):
    r = tmp_path / "r"
    _sp.run(["git", "init", "-q", str(r)], check=True)
    for k, v in cfg:
        _sp.run(["git", "-C", str(r), "config", k, v], check=True)
    return r


def test_filter_clean_refuse_et_non_execute(tmp_path):
    from shared_infra.sandbox.git_env import unsafe_repo_config
    marque = tmp_path / "PWNED"
    r = _repo(tmp_path, ("filter.x.clean", f"touch {marque}"))
    (r / ".gitattributes").write_text("* filter=x\n")
    (r / "a.txt").write_text("a")
    assert unsafe_repo_config(r) == "filter.x.clean"
    out = _git_hote(r, "add", "-A")
    assert out.returncode == 1 and "filter.x.clean" in out.stderr
    assert not marque.exists(), "la commande du filtre a tourné sur l'hôte"


def test_cle_dangereuse_via_inclusion(tmp_path):
    from shared_infra.sandbox.git_env import unsafe_repo_config
    r = _repo(tmp_path)
    (r / ".git" / "extra.cfg").write_text('[diff "y"]\n\ttextconv = cat\n')
    _sp.run(["git", "-C", str(r), "config", "include.path", "extra.cfg"], check=True)
    assert unsafe_repo_config(r) == "diff.y.textconv"


@pytest.mark.parametrize("cle,val", [
    ("core.worktree", "/etc"), ("core.sshCommand", "sh"),
    ("url.http://169.254.169.254/.insteadOf", "https://github.com/"),
    ("gpg.program", "sh"), ("merge.m.driver", "sh %O"),
])
def test_autres_cles_refusees(tmp_path, cle, val):
    from shared_infra.sandbox.git_env import unsafe_repo_config
    assert unsafe_repo_config(_repo(tmp_path, (cle, val))) == cle.lower()


def test_depot_ordinaire_accepte(tmp_path):
    from shared_infra.sandbox.git_env import unsafe_repo_config
    r = _repo(tmp_path, ("user.name", "x"), ("remote.origin.url", "https://example.org/r.git"))
    assert unsafe_repo_config(r) is None
    assert unsafe_repo_config(tmp_path) is None            # hors dépôt


# ── Audit 2026-09-22 (C1, C2, H5) ─────────────────────────────────────────

def test_gitconfig_du_depot_pas_lu_comme_global(tmp_path):
    """C1 : ``HOME=<dépôt>`` faisait lire ``<dépôt>/.gitconfig`` en portée
    globale, hors du contrôle ; le filtre s'exécutait sur l'hôte."""
    marque = tmp_path / "PWNED"
    r = _repo(tmp_path)
    (r / ".gitconfig").write_text(f'[filter "x"]\n\tclean = touch {marque}\n')
    (r / ".gitattributes").write_text("* filter=x\n")
    (r / "a.txt").write_text("a")
    _git_hote(r, "add", "-A")
    assert not marque.exists(), "le .gitconfig du dépôt a été lu comme config globale"


def test_env_hote_en_liste_blanche(monkeypatch, tmp_path):
    from shared_infra.sandbox.git_env import host_git_env
    monkeypatch.setenv("ELPIS_SECRET_TEST", "fuite")
    monkeypatch.setenv("GIT_DIR", "/etc")
    env = host_git_env({"GIT_ASKPASS": "/x", "HOME": str(tmp_path)}, cwd=tmp_path / "r")
    assert "ELPIS_SECRET_TEST" not in env and "GIT_DIR" not in env
    assert env["GIT_ASKPASS"] == "/x"
    assert env["HOME"] != str(tmp_path)                    # jamais re-pointé
    assert env["GIT_CONFIG_GLOBAL"].startswith(env["HOME"])
    assert env["GIT_CEILING_DIRECTORIES"] == str(tmp_path)


def test_signature_coupee():
    cfg = _config_map(hardened_git_env())
    assert cfg["commit.gpgsign"] == "false" and cfg["gpg.format"] == "openpgp"


@pytest.mark.parametrize("cle,val", [
    ("gpg.ssh.defaultKeyCommand", "sh -c id"), ("http.proxy", "http://127.0.0.1:1"),
    ("http.https://x.org/.proxy", "http://127.0.0.1:1"), ("remote.origin.proxy", "http://a"),
    ("http.extraHeader", "X: y"), ("core.fsmonitor", "sh"), ("core.hooksPath", "h"),
    ("submodule.s.update", "!sh"), ("core.editor", "sh"),
])
def test_cles_2026_09_22_refusees(tmp_path, cle, val):
    from shared_infra.sandbox.git_env import unsafe_repo_config
    assert unsafe_repo_config(_repo(tmp_path, (cle, val))) == cle.lower()


def test_git_lien_symbolique_refuse(tmp_path):
    from shared_infra.sandbox.git_env import unsafe_git_dir
    autre = _repo(tmp_path)
    d = tmp_path / "d"
    d.mkdir()
    (d / ".git").symlink_to(autre / ".git")
    assert "lien" in unsafe_git_dir(d)
    assert _git_hote(d, "status").returncode == 1


@pytest.mark.parametrize("prep", ["gitdir", "alternates", "objets"])
def test_git_hors_depot_refuse(tmp_path, prep):
    from shared_infra.sandbox.git_env import unsafe_git_dir
    r = _repo(tmp_path)
    if prep == "gitdir":
        d = tmp_path / "d"
        d.mkdir()
        (d / ".git").write_text(f"gitdir: {r / '.git'}\n")
        r = d
    elif prep == "alternates":
        (r / ".git/objects/info/alternates").write_text("/home/x/.git/objects\n")
    else:
        (r / ".git/objects/ab").symlink_to(tmp_path)
    assert unsafe_git_dir(r)
    assert unsafe_git_dir(_repo(tmp_path / "ok")) is None


def test_proxy_et_askpass_du_depot_neutralises():
    """``core.gitProxy`` / ``core.askPass`` d'un dépôt ne lancent rien, même
    posés après le contrôle : variable vide prioritaire, clé forcée à vide."""
    env = hardened_git_env({})
    assert env["GIT_PROXY_COMMAND"] == ""
    n = int(env["GIT_CONFIG_COUNT"])
    pairs = {env[f"GIT_CONFIG_KEY_{i}"]: env[f"GIT_CONFIG_VALUE_{i}"] for i in range(n)}
    assert pairs["core.askPass"] == ""
