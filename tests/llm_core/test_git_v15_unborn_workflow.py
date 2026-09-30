# SPDX-License-Identifier: MIT
"""Régressions audit 2026-07-26 — workflow git v15 sur repo vierge.

Trois bugs rendaient les outils git inutilisables en pratique :

1. ``git_inspect`` échouait à 100 % avec ``shell_chars_forbidden_in_git_args`` :
   le ``--pretty=format:%H|%s|…`` interne contenait un ``|`` littéral, rejeté
   par la validation BAD_CHARS de ``_reject`` (→ ``%x7c`` désormais).
2. ``git_commit`` lisait ``branch: ""`` sur un repo sans commit :
   ``rev-parse --abbrev-ref HEAD`` échoue sur une branche unborn
   (→ ``branch --show-current`` en premier). Combiné à ``git_start_work``
   qui exigeait un switch vers une base unborn (impossible), le workflow
   complet était deadlocké : aucun chemin pour committer.
3. Commit initial : un repo fraîchement créé par l'agent n'a AUCUNE histoire
   à protéger → le premier commit est autorisé même sur main (les gardes
   protected/agent-branch s'appliquent à partir du 2e commit).
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

import llm_core.tools.git_tools as git_tools


class _FakeMCP:
    def __init__(self):
        self.tools = {}

    def tool(self, **kw):
        def deco(fn):
            self.tools[fn.__name__] = fn
            return fn
        return deco


@pytest.fixture()
def git(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_SANDBOX_DIR", str(tmp_path))
    mcp = _FakeMCP()
    git_tools.register(mcp, tmp_path)
    work = tmp_path / "guest" / "work"
    work.mkdir(parents=True, exist_ok=True)
    return mcp.tools, work


def _init_repo(tools, name="proj"):
    r = tools["git_action"](None, repo=name, action="init")
    assert r.get("ok"), r
    return r


# ── helpers module-level ─────────────────────────────────────────────────

def test_current_branch_on_unborn_head(tmp_path):
    rp = tmp_path / "r"
    subprocess.run(["git", "init", "-q", "-b", "main", str(rp)], check=True)
    git_tools._remember_work_root(tmp_path, "guest")   # git par l'agent de cette racine
    assert git_tools._head_is_unborn(rp) is True
    assert git_tools._current_branch(rp) == "main"
    subprocess.run(["git", "switch", "-q", "-c", "agent/probe"], cwd=rp, check=True)
    assert git_tools._current_branch(rp) == "agent/probe"


def test_inspect_log_format_passes_reject():
    # Le format interne de git_inspect ne doit contenir AUCUN BAD_CHARS.
    git_tools._reject(["git", "log", "-n", "5",
                       "--pretty=format:%H%x7c%s%x7c%an%x7c%ar"])


# ── git_inspect : plus de shell_chars_forbidden_in_git_args ──────────────

def test_git_inspect_works_on_fresh_and_committed_repo(git):
    tools, work = git
    _init_repo(tools)
    r = tools["git_inspect"](None, repo="proj")
    assert r.get("ok"), r                      # échouait à 100 % avant le fix
    assert r["branch"] == "main"

    (work / "proj" / "a.txt").write_text("hello\n")
    c = tools["git_commit"](None, repo="proj", message="Initial import")
    assert c.get("ok"), c
    r2 = tools["git_inspect"](None, repo="proj")
    assert r2.get("ok"), r2
    assert r2["recent_commits"] and r2["recent_commits"][0]["subject"] == "Initial import"


# ── git_commit : commit initial autorisé, gardes ensuite ─────────────────

def test_initial_commit_allowed_on_main_then_protected(git):
    tools, work = git
    _init_repo(tools)
    (work / "proj" / "f.py").write_text("x = 1\n")

    c1 = tools["git_commit"](None, repo="proj", message="Bootstrap project")
    assert c1.get("ok"), c1
    assert c1.get("initial_commit") is True
    assert c1["branch"] == "main"              # était "" (not_agent_branch) avant

    # Dès le 2e commit, main redevient protégée.
    (work / "proj" / "f.py").write_text("x = 2\n")
    c2 = tools["git_commit"](None, repo="proj", message="Should be denied")
    assert not c2.get("ok")
    assert c2["error"] == "protected_branch"


def test_commit_on_unborn_agent_branch(git):
    tools, work = git
    _init_repo(tools)
    sw = tools["git_action"](None, repo="proj", action="switch",
                             branch="agent/probe", create=True)
    assert sw.get("ok"), sw
    (work / "proj" / "f.py").write_text("x = 1\n")
    c = tools["git_commit"](None, repo="proj", message="First on agent branch")
    assert c.get("ok"), c                      # branch:"" → not_agent_branch avant
    assert c["branch"] == "agent/probe"


# ── git_start_work : repo fraîchement créé ───────────────────────────────

def test_start_work_on_virgin_repo(git):
    tools, work = git
    _init_repo(tools)
    # Depuis le scaffold d'init, main EXISTE → chemin normal (switch + pull
    # best-effort), plus de deadlock switch_base_failed.
    r = tools["git_start_work"](None, repo="proj", branch_intent="add-readme")
    assert r.get("ok"), r
    assert r["branch"].startswith("agent/add-readme-")
    assert r["base"] == "main" and r["base_sha"]

    (work / "proj" / "README.md").write_text("# proj\n")
    c = tools["git_commit"](None, repo="proj", message="Add readme")
    assert c.get("ok"), c
    assert c["branch"] == r["branch"]


def test_start_work_full_cycle_after_first_commit(git):
    tools, work = git
    _init_repo(tools)
    (work / "proj" / "a.txt").write_text("v1\n")
    assert tools["git_commit"](None, repo="proj", message="Init")["ok"]

    r = tools["git_start_work"](None, repo="proj", branch_intent="fix-typo")
    assert r.get("ok"), r
    assert r["base"] == "main" and r["base_sha"]
    (work / "proj" / "a.txt").write_text("v2\n")
    c = tools["git_commit"](None, repo="proj", message="Fix typo")
    assert c.get("ok"), c
    assert not c.get("initial_commit")


# ── init : branche initiale MATÉRIALISÉE (plus de « main fantôme ») ──────

def test_init_materializes_main(git):
    """`git init -b main` seul laisse main UNBORN : `git switch main` échouait
    (« invalid reference ») et main n'existait jamais. init pose désormais un
    commit scaffold immédiat."""
    tools, work = git
    r = _init_repo(tools)
    assert r["branch_materialized"] is True
    rp = work / "proj"
    ref = subprocess.run(["git", "rev-parse", "--verify", "refs/heads/main"],
                         cwd=rp, capture_output=True, text=True)
    assert ref.returncode == 0, "refs/heads/main doit exister après init"
    sw = tools["git_action"](None, repo="proj", action="switch", branch="main")
    assert sw.get("ok") and sw.get("returncode") == 0, sw


def test_pristine_rule_scaffold_only(git):
    tools, work = git
    _init_repo(tools)
    rp = work / "proj"
    assert git_tools._head_is_pristine(rp) is True       # scaffold seul
    (rp / "a.txt").write_text("v1\n")
    assert tools["git_commit"](None, repo="proj", message="Real")["ok"]
    assert git_tools._head_is_pristine(rp) is False      # contenu réel → protégé


def test_rev_list_allowed_readonly(git):
    # rev-list absent de READONLY_SUBS rendait _head_is_pristine ET le calcul
    # ahead/behind de git_inspect silencieusement inopérants.
    tools, work = git
    _init_repo(tools)
    r = git_tools._run_git_ro(work / "proj", ["rev-list", "--count", "HEAD"])
    assert r.get("ok") and r.get("returncode") == 0
    assert (r.get("stdout") or "").strip() == "1"


# ── un seul UID écrit dans /work (L4.6) ─────────────────────────────────

def test_git_writes_are_owner_only_writable(git):
    """git tourne dans la sandbox sous son UID (L4.4) : ce qu'écrivent les
    outils git sort en 0644/0755 (umask 022 de l'agent), quel que soit
    l'umask du processus de l'app — plus d'élargissement 0666/0777."""
    import os as _os
    import stat as _stat
    old_umask = _os.umask(0)
    try:
        tools, work = git
        _init_repo(tools)
        rp = work / "proj"
        assert tools["git_write"](None, repo="proj", action="write",
                                  path="src/app.py", content="x=1\n")["ok"]
        assert tools["git_commit"](None, repo="proj", message="Bootstrap")["ok"]
    finally:
        _os.umask(old_umask)

    def m(p):
        return _stat.S_IMODE(_os.stat(p).st_mode) & 0o777

    assert m(rp / ".git") == 0o755
    assert m(rp / ".git" / "index") == 0o644
    assert m(rp / "src") == 0o755
    assert m(rp / "src" / "app.py") == 0o644
    ouverts = [str(p) for p in (rp / ".git").rglob("*") if m(p) & 0o022]
    assert not ouverts, ouverts[:5]


# ── doc/runtime : plus de mention du layout legacy git_repos/ ────────────

def test_init_error_hints_no_longer_mention_git_repos(git):
    tools, _ = git
    r = tools["git_action"](None, repo="", action="init")
    assert not r.get("ok")
    assert "git_repos" not in (r.get("fix") or "")
    _init_repo(tools)
    dup = tools["git_action"](None, repo="proj", action="init")
    assert not dup.get("ok")
    assert "git_repos" not in (dup.get("fix") or "")


# ── doublon unicode signalé à l'init ─────────────────────────────────────

def test_init_warns_on_unicode_twin(git):
    # Les noms de repo git_action(init) sont ASCII-only → le jumeau par
    # ACCENT ne peut pas naître ici (il vient du shell/fs, couvert par
    # write_file/mkdir), mais le jumeau par CASSE reste possible.
    tools, work = git
    _init_repo(tools, "projet-devinette")
    r = tools["git_action"](None, repo="Projet-Devinette", action="init")
    assert r.get("ok"), r
    assert "projet-devinette" in (r.get("warning") or "")


# ── AUDIT 2026-08-02 — anti-SSRF non-bloquant pour git_start_work ─────────────

def test_start_work_local_succeeds_despite_ssrf_blocked_remote(git):
    """Un remote refusé par l'anti-SSRF (IP interne) ne doit PLUS avorter
    git_start_work : le pull (simple commodité, déjà non-fatal) est sauté, mais
    la création de branche — 100 % locale — réussit. Avant, un
    ``blocked_remote`` bloquait tout démarrage de travail sur un repo à remote
    interne/HTTP."""
    tools, work = git
    _init_repo(tools)
    (work / "proj" / "a.txt").write_text("v1\n")
    assert tools["git_commit"](None, repo="proj", message="Init")["ok"]

    # Remote pointant vers une IP link-local → refusé par block_remote_url_reason.
    subprocess.run(["git", "remote", "add", "origin", "http://169.254.169.254/x.git"],
                   cwd=(work / "proj"), check=True)

    r = tools["git_start_work"](None, repo="proj", branch_intent="offline-branch")
    assert r.get("ok"), r
    assert r["branch"].startswith("agent/offline-branch-")
    # Le pull a été sauté pour cause d'anti-SSRF, sans faire échouer l'outil.
    assert "anti-SSRF" in (r.get("pull") or ""), r
    # La branche existe bien localement.
    br = subprocess.run(["git", "branch", "--show-current"], cwd=(work / "proj"),
                        capture_output=True, text=True).stdout.strip()
    assert br == r["branch"]


# ── AUDIT 2026-08-02 — git_submit : erreur de push EXPLICITE (jamais vide) ────

def _branche(work):
    return subprocess.run(["git", "branch", "--show-current"], cwd=(work / "proj"),
                          capture_output=True, text=True).stdout.strip()


def _prep_agent_branch_with_remote(tools, work, remote="http://10.0.0.9/r.git"):
    _init_repo(tools)
    (work / "proj" / "a.txt").write_text("v1\n")
    assert tools["git_commit"](None, repo="proj", message="Init")["ok"]
    sw = tools["git_start_work"](None, repo="proj", branch_intent="ship-it")
    assert sw.get("ok"), sw
    subprocess.run(["git", "remote", "add", "origin", remote],
                   cwd=(work / "proj"), check=True)
    (work / "proj" / "a.txt").write_text("v2\n")
    assert tools["git_commit"](None, repo="proj", message="Change")["ok"]


def test_submit_push_timeout_is_explicit(git, monkeypatch):
    """Le vrai bug : un push qui TIMEOUT (remote injoignable) renvoyait
    ``push_failed`` avec un message VIDE (``pu.get('stderr')`` inexistant sur
    l'enveloppe de timeout), rejoué en boucle. On doit désormais renvoyer un
    ``push_timeout`` explicite."""
    tools, work = git
    _prep_agent_branch_with_remote(tools, work)

    def fake_net(cwd, args, username, **kw):
        assert args[0] == "push" and kw["push_refs"] == {"refs/heads/" + _branche(work)}
        return git_tools._err("timeout", hint="Exceeded 30s.", cmd=["git", *args], returncode=124)
    monkeypatch.setattr(git_tools, "_run_network", fake_net)

    r = tools["git_submit"](None, repo="proj", title="Ship it")
    assert not r.get("ok"), r
    assert r.get("error") == "push_timeout", r
    assert r.get("timed_out") is True, r
    # Message NON vide et exploitable (nomme le remote + le délai).
    fix = (r.get("fix") or "")
    assert fix.strip() and "10.0.0.9" in fix and "30s" in fix, r


def test_submit_push_failure_never_empty(git, monkeypatch):
    """Un échec de push SANS sortie (stderr/stdout vides) ne doit plus produire
    un message vide : on tombe sur un repli explicite."""
    tools, work = git
    _prep_agent_branch_with_remote(tools, work)

    def fake_net(cwd, args, username, **kw):
        return git_tools._ok(cmd=["git", *args], returncode=1, stdout="", stderr="", duration_ms=1)
    monkeypatch.setattr(git_tools, "_run_network", fake_net)

    r = tools["git_submit"](None, repo="proj", title="Ship it")
    assert not r.get("ok"), r
    assert r.get("error") == "push_failed", r
    fix = (r.get("fix") or "")
    assert fix.strip(), r
    assert ("aucune sortie" in fix) or ("silencieux" in fix), r


# ── AUDIT 2026-08-02 (Part B) — git_clone : credentials via connecteur
# Le modèle ne saisit JAMAIS de token : il est résolu depuis les Connecteurs Git
# et ajouté par le relais de l'hôte (L4.4), jamais dans l'URL, l'argv ni la
# sandbox.

def _mock_net_capture(monkeypatch, returncode=0, stdout="", stderr=""):
    cap = {}
    def fake_net(cwd, args, username, *, url, push_refs=None, auth=None, timeout=120):
        cap.update(args=list(args), auth=auth, url=url)
        return git_tools._ok(returncode=returncode, stdout=stdout, stderr=stderr)
    monkeypatch.setattr(git_tools, "_run_network", fake_net)
    return cap


def test_clone_uses_connector_credentials_through_the_relay(git, monkeypatch):
    tools, work = git
    import shared_infra.db as _db
    import shared_infra.git.resolver as _resolver
    monkeypatch.setattr("shared_infra.accounts.users.get_user", lambda u: {"id": 7})
    monkeypatch.setattr(_resolver, "import_legacy_git_credentials", lambda *a, **k: 0)
    monkeypatch.setattr(_resolver, "resolve_git_credential",
                        lambda uid, url: {"username": "bob", "token": "SEKRIT-TOKEN",
                                          "provider_type": "gitea",
                                          "host": "10.0.0.42:3000",
                                          "api_base": "http://10.0.0.42:3000/api/v1"})
    cap = _mock_net_capture(monkeypatch)

    r = tools["git_clone"](None, url="http://10.0.0.42:3000/bob/repo.git",
                           into_path="clone_a")
    assert r.get("ok"), r
    # Token remis au relais de l'hôte, présent NI dans l'URL NI dans l'argv.
    assert cap["auth"] == ("bob", "SEKRIT-TOKEN")
    assert "SEKRIT-TOKEN" not in " ".join(cap["args"])


def test_clone_without_connector_has_no_credentials(git, monkeypatch):
    tools, work = git
    import shared_infra.db as _db
    monkeypatch.setattr("shared_infra.accounts.users.get_user", lambda u: None)   # pas d'user → pas de cred
    cap = _mock_net_capture(monkeypatch)

    r = tools["git_clone"](None, url="http://10.0.0.42:3000/bob/pub.git",
                           into_path="clone_b")
    assert r.get("ok"), r
    assert cap["auth"] is None


def test_clone_private_repo_error_points_to_connector(git, monkeypatch):
    tools, work = git
    import shared_infra.db as _db
    monkeypatch.setattr("shared_infra.accounts.users.get_user", lambda u: None)
    _mock_net_capture(monkeypatch, returncode=128, stderr="fatal: Authentication failed")

    r = tools["git_clone"](None, url="http://10.0.0.42:3000/bob/priv.git",
                           into_path="clone_c")
    assert not r.get("ok"), r
    assert r.get("error") == "clone_failed"
    assert "Connecteur Git" in (r.get("fix") or "")
    assert r.get("credentialed") is False


# ── AUDIT 2026-08-02 — creds donnés au modèle (chat) : utilisés ET enregistrés ─

def test_clone_with_explicit_token_uses_and_saves(git, monkeypatch):
    tools, work = git
    import shared_infra.db as _db
    import shared_infra.git.resolver as _resolver
    monkeypatch.setattr("shared_infra.accounts.users.get_user", lambda u: {"id": 5})
    saved = {}
    monkeypatch.setattr(_resolver, "save_git_credential",
                        lambda uid, url, user, tok, *a, **k:
                        (saved.update(uid=uid, url=url, user=user, tok=tok) or 42))
    cap = _mock_net_capture(monkeypatch)

    r = tools["git_clone"](None, url="http://10.0.0.42:3000/alice/repo.git",
                           into_path="clone_tok", username="alice", token="TOK-XYZ")
    assert r.get("ok"), r
    assert r.get("credentials_saved") is True
    # token remis au relais, ABSENT de l'URL/argv
    assert cap["auth"] == ("alice", "TOK-XYZ")
    assert "TOK-XYZ" not in " ".join(cap["args"])
    # persisté keyé sur l'URL, pour ce user
    assert saved.get("tok") == "TOK-XYZ" and saved.get("uid") == 5
    assert "10.0.0.42:3000" in saved.get("url", "")


def test_git_set_credential_tool_saves(git, monkeypatch):
    tools, work = git
    import shared_infra.db as _db
    import shared_infra.git.resolver as _resolver
    monkeypatch.setattr("shared_infra.accounts.users.get_user", lambda u: {"id": 9})
    calls = {}
    monkeypatch.setattr(_resolver, "save_git_credential",
                        lambda uid, target, user, tok, ptype="":
                        (calls.update(uid=uid, target=target, user=user, tok=tok, ptype=ptype) or 7))

    r = tools["git_set_credential"](None, target="10.0.0.42:3000",
                                    token="MYTOK", username="alice",
                                    provider_type="gitea")
    assert r.get("ok"), r
    assert r.get("connector_id") == 7
    assert r.get("host") == "10.0.0.42:3000"
    assert calls.get("tok") == "MYTOK" and calls.get("ptype") == "gitea"


def test_git_set_credential_tool_requires_token(git):
    tools, work = git
    r = tools["git_set_credential"](None, target="10.0.0.42:3000", token="")
    assert not r.get("ok")
    assert r.get("error") == "token_required"
