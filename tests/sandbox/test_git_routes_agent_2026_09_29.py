# SPDX-License-Identifier: MIT
"""Routes Git de l'éditeur par l'agent de la sandbox (L4.4) : clone dans un
sous-dossier, pull et push par le relais (identifiant de la requête, jamais
écrit dans le dépôt), push limité aux refs de la route, refus du relais
(403/400), agent injoignable (503), délai (504), branche courante des
dépôts, init et abandon de modifications par l'agent."""
from __future__ import annotations

import subprocess

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import shared_infra.sandbox.routes_git as sg
from shared_infra.sandbox import agent_client as AC, git_ops
from shared_infra.sandbox.agent_client import AgentError
from tests._git_amont import BASIC, JETON, _git, demarrer_amont

IDS = {"cred_user": "u", "cred_token": JETON}


@pytest.fixture()
def amont(tmp_path):
    srv = demarrer_amont(tmp_path)
    yield srv
    srv.shutdown()
    srv.server_close()


@pytest.fixture()
def client(tmp_path, monkeypatch):
    from tests.conftest import editeur_sur_agent
    work = tmp_path / "sb" / "u" / "work"
    work.mkdir(parents=True)
    editeur_sur_agent(monkeypatch, work)
    monkeypatch.setattr(sg, "require_user_id", lambda request: 1)
    monkeypatch.setattr(sg, "_get_work_path", lambda uid: work)
    monkeypatch.setattr(sg, "get_username_by_id", lambda uid: "alice")
    import shared_infra.git.resolver as resolver
    monkeypatch.setattr(resolver, "save_git_credential", lambda *a, **k: True)
    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app), work


@pytest.fixture()
def connecteur(amont, monkeypatch):  # noqa: F811
    """L'amont local (127.0.0.1) enregistré comme hôte de connecteur."""
    hote = amont.url.split("/")[2]
    monkeypatch.setattr(git_ops, "connector_hosts", lambda uid: {hote})
    return amont


def _refs(depot) -> list:
    return subprocess.run(["git", "for-each-ref", "--format=%(refname)"], cwd=depot,
                          capture_output=True, text=True, check=True).stdout.split()


def test_clone_pull_push(client, connecteur, monkeypatch):
    c, work = client
    r = c.post("/api/sandbox/git/clone", json={"url": connecteur.url, "dir": "copie", **IDS})
    assert r.status_code == 200, r.text
    config = (work / "copie" / ".git" / "config").read_text()
    assert connecteur.url in config and JETON not in config
    # Identifiants saisis : envoyés après la demande de l'amont (401), comme git.
    assert [a for _m, _p, a in connecteur.vus][:1] == [None]
    assert all(a == BASIC for _m, _p, a in connecteur.vus[1:])

    (connecteur.src / "c.txt").write_text("c\n")
    _git(connecteur.src, "add", "c.txt")
    _git(connecteur.src, "commit", "-q", "-m", "c")
    _git(connecteur.src, "push", "-q", connecteur.racine + "/depot.git", "main")
    r = c.post("/api/sandbox/git/pull", json={"repo": "copie", **IDS})
    assert r.status_code == 200, r.text
    assert (work / "copie" / "c.txt").read_text() == "c\n"

    (work / "copie" / "b.txt").write_text("b\n")
    assert c.post("/api/sandbox/git/stage", json={"repo": "copie"}).status_code == 200
    r = c.post("/api/sandbox/git/commit", json={"repo": "copie", "message": "b"})
    assert r.status_code == 200, r.text
    r = c.post("/api/sandbox/git/push", json={"repo": "copie", **IDS})
    assert r.status_code == 200, r.text
    log = subprocess.run(["git", "log", "-1", "--format=%s|%an", "main"],
                         cwd=connecteur.racine + "/depot.git", capture_output=True, text=True)
    assert log.stdout.strip() == "b|alice"

    # fetch --all : les remotes HTTP(S) par le relais, les autres laissés.
    # Les identifiants saisis n'y servent jamais (plusieurs hôtes possibles) :
    # sans connecteur, l'amont n'en reçoit aucun.
    _git(work / "copie", "remote", "add", "local", str(connecteur.src))
    connecteur.vus.clear()
    r = c.post("/api/sandbox/git/fetch", json={"repo": "copie", **IDS})
    assert r.status_code == 400, r.text
    assert connecteur.vus and all(a is None for _m, _p, a in connecteur.vus)
    # Avec le connecteur de l'hôte : envoyés d'emblée.
    monkeypatch.setattr(git_ops, "_credential", lambda uid, url: ("u", JETON))
    r = c.post("/api/sandbox/git/fetch", json={"repo": "copie"})
    assert r.status_code == 200 and r.json()["skipped"] == ["local"], r.text


def test_push_suit_la_configuration_de_git(client, connecteur):
    """(Relecture L4.4) Le push fait ce que ferait ``git push`` : refspec de
    la config, ``push.followTags`` ; le relais n'accepte que ces refs."""
    c, work = client
    assert c.post("/api/sandbox/git/clone",
                  json={"url": connecteur.url, "dir": "copie", **IDS}).status_code == 200
    _git(work / "copie", "branch", "autre")
    _git(work / "copie", "config", "remote.origin.push", "refs/heads/*:refs/heads/revue/*")
    _git(work / "copie", "tag", "-a", "v1", "-m", "v1")
    _git(work / "copie", "config", "push.followTags", "true")
    r = c.post("/api/sandbox/git/push", json={"repo": "copie", **IDS})
    assert r.status_code == 200, r.text
    assert _refs(connecteur.racine + "/depot.git") == [
        "refs/heads/main", "refs/heads/revue/autre", "refs/heads/revue/main", "refs/tags/v1"]
    # Rien de nouveau : pas de second push.
    r = c.post("/api/sandbox/git/push", json={"repo": "copie", **IDS})
    assert r.status_code == 200 and r.json()["message"] == "Déjà à jour", r.text


def test_push_suppression_refusee_en_409(client, connecteur):
    """Une suppression demandée par la config est refusée en 409 (refus de
    politique) : l'éditeur ne redemande pas d'identifiants."""
    c, work = client
    assert c.post("/api/sandbox/git/clone",
                  json={"url": connecteur.url, "dir": "copie", **IDS}).status_code == 200
    _git(work / "copie", "config", "remote.origin.push", ":refs/heads/main")
    r = c.post("/api/sandbox/git/push", json={"repo": "copie", **IDS})
    assert r.status_code == 409, r.text
    assert "suppression de refs/heads/main refusée" in r.json()["detail"]
    assert "403" not in r.json()["detail"]
    assert _refs(connecteur.racine + "/depot.git") == ["refs/heads/main"]


def test_clone_cible_occupee_ou_echec(client, connecteur):
    c, work = client
    (work / "plein").mkdir()
    (work / "plein" / "x").write_text("x")
    r = c.post("/api/sandbox/git/clone", json={"url": connecteur.url, "dir": "plein", **IDS})
    assert r.status_code == 409
    absent = connecteur.url.replace("depot.git", "absent.git")
    r = c.post("/api/sandbox/git/clone", json={"url": absent, **IDS})
    assert r.status_code == 400
    assert not (work / "absent").exists()                # clone raté : rien laissé
    r = c.post("/api/sandbox/git/clone", json={"url": connecteur.url, "dir": "../x", **IDS})
    assert r.status_code == 400


def test_refus_du_relais_agent_injoignable_et_delai(client, monkeypatch):
    c, work = client
    _git(work, "init", "-q", "-b", "main", "p")
    r = c.post("/api/sandbox/git/push", json={"repo": "p"})
    assert r.status_code == 400 and "introuvable" in r.json()["detail"]   # pas de remote
    _git(work / "p", "remote", "add", "origin", "http://169.254.169.254/x.git")
    r = c.post("/api/sandbox/git/push", json={"repo": "p"})
    assert r.status_code == 403 and "anti-SSRF" in r.json()["detail"], r.text
    r = c.post("/api/sandbox/git/remote", json={"repo": "p", "url": "file:///etc/passwd"})
    assert r.status_code == 403

    async def lent(self, *a, **k):
        return {"returncode": 124, "stdout": "", "stderr": "", "truncated": False,
                "timed_out": True, "duration_ms": 30000}
    monkeypatch.setattr(AC.AgentClient, "git", lent)
    assert c.get("/api/sandbox/git/log", params={"repo": "p"}).status_code == 504

    async def injoignable(self, *a, **k):
        raise AgentError("agent_unavailable", "test")
    monkeypatch.setattr(AC.AgentClient, "stat", injoignable)
    for url in ("/api/sandbox/git/status", "/api/sandbox/git/log", "/api/sandbox/git/repos"):
        assert c.get(url, params={"repo": "p"}).status_code == 503, url


def test_repos_et_branche_courante(client):
    c, work = client
    _git(work, "init", "-q", "-b", "main", "a")
    _git(work / "a", "commit", "-q", "--allow-empty", "-m", "x")
    _git(work / "a", "checkout", "-q", "--detach")
    _git(work, "init", "-q", "-b", "dev", "g/b")
    _git(work / "a", "worktree", "add", "-q", "-b", "arbre", str(work / "w" / "arbre"))
    repos = {r["path"]: r["branch"] for r in c.get("/api/sandbox/git/repos").json()["repos"]}
    assert repos == {"a": "(HEAD)", "g/b": "dev", "w/arbre": "arbre"}


def test_init_et_abandon(client):
    c, work = client
    r = c.post("/api/sandbox/git/init", json={"dir": "neuf/sous", "user_name": "Moi"})
    assert r.status_code == 200, r.text
    assert (work / "neuf" / "sous" / ".git").is_dir()
    assert "/work/" in r.json()["message"] or str(work) in r.json()["message"]
    (work / "neuf" / "sous" / "tmp.txt").write_text("x")
    (work / "garde.txt").write_text("x")
    r = c.post("/api/sandbox/git/discard",
               json={"repo": "neuf/sous", "paths": ["tmp.txt", "../../garde.txt"]})
    assert r.status_code == 200, r.text
    assert not (work / "neuf" / "sous" / "tmp.txt").exists()
    assert (work / "garde.txt").exists()                 # hors du dépôt : ignoré


def test_rafraichissement_passif_ne_reveille_pas_la_sandbox(client, monkeypatch):
    """Statut, dépôts et arbre (rafraîchis au retour sur la fenêtre) :
    conteneur arrêté → 503, ni redémarré ni agent lancé."""
    from shared_infra.sandbox.executors import _user_sandbox as us
    c, work = client
    _git(work, "init", "-q", "-b", "main", "p")
    reveils: list = []

    async def arrete(self):
        return us.SandboxStatus(exists=True, running=False, container_name=self.container_name)

    async def reveiller(self):
        reveils.append(1)
        return us.SandboxStatus(exists=True, running=True, container_name=self.container_name)
    monkeypatch.setattr(us.UserSandbox, "status", arrete)
    monkeypatch.setattr(us.UserSandbox, "ensure_running", reveiller)
    for url in ("/api/sandbox/git/status", "/api/sandbox/git/repos", "/api/sandbox/git/tree"):
        assert c.get(url, params={"repo": "p"}).status_code == 503, url
    assert reveils == []


def test_tilde_est_un_nom_de_depot(client):
    """Chemins de l'éditeur : ``~`` est un dossier, pas la racine."""
    c, work = client
    _git(work, "init", "-q", "-b", "main", "~")
    d = c.get("/api/sandbox/git/status", params={"repo": "~"}).json()
    assert d["is_repo"] is True and d["branch"] == "main"
    assert c.get("/api/sandbox/git/status").json() == {"is_repo": False}


# ── Relecture L4.4 (2026-09-30) ──────────────────────────────────────────────

def _depot_local(work, nom="p"):
    _git(work, "init", "-q", "-b", "main", nom)
    (work / nom / "a.txt").write_text("a\n")
    _git(work / nom, "add", "a.txt")
    _git(work / nom, "commit", "-q", "-m", "a")
    return work / nom


def test_nouvelle_branche(client):
    """« Nouvelle branche » : ``-b --end-of-options x`` créait
    « --end-of-options » (cassé depuis 8218cc0)."""
    c, work = client
    _depot_local(work)
    r = c.post("/api/sandbox/git/checkout", json={"repo": "p", "branch": "feat", "create": True})
    assert r.status_code == 200, r.text
    assert c.get("/api/sandbox/git/branches", params={"repo": "p"}).json()["current"] == "feat"
    r = c.post("/api/sandbox/git/checkout", json={"repo": "p", "branch": "main"})
    assert r.status_code == 200, r.text
    r = c.post("/api/sandbox/git/checkout", json={"repo": "p", "branch": "-x", "create": True})
    assert r.status_code == 400


def test_pull_d_une_branche_qui_suit_une_branche_locale(client):
    """``branch.<b>.remote = .`` : fusion locale, sans réseau ni « origin »."""
    c, work = client
    p = _depot_local(work)
    _git(p, "checkout", "-q", "-b", "feature", "--track", "main")
    _git(p, "checkout", "-q", "main")
    (p / "b.txt").write_text("b\n")
    _git(p, "add", "b.txt")
    _git(p, "commit", "-q", "-m", "b")
    _git(p, "checkout", "-q", "feature")
    r = c.post("/api/sandbox/git/pull", json={"repo": "p"})
    assert r.status_code == 200, r.text
    assert (p / "b.txt").exists()


def test_pull_suit_la_configuration_du_depot(client, monkeypatch):
    """« Pull » suit ``pull.rebase`` / ``pull.ff`` ; « Pull (rebase) » rebase."""
    c, work = client
    p = _depot_local(work)
    vus: list = []

    async def pull(agent, cwd, remote, branch="", mode="--ff-only", **kw):
        vus.append(mode)
        return git_ops.GitResult(0, "", "")
    monkeypatch.setattr(git_ops, "pull", pull)
    for config, attendu in ((None, "--ff-only"), (("pull.rebase", "true"), "--rebase"),
                            (("pull.rebase", "false"), "--no-rebase")):
        if config:
            _git(p, "config", *config)
        assert c.post("/api/sandbox/git/pull", json={"repo": "p", "rebase": False}).status_code == 200
        assert vus[-1] == attendu, config
    _git(p, "config", "--unset", "pull.rebase")
    _git(p, "config", "pull.ff", "only")
    c.post("/api/sandbox/git/pull", json={"repo": "p", "rebase": False})
    assert vus[-1] == "--ff-only"
    c.post("/api/sandbox/git/pull", json={"repo": "p", "rebase": True})
    assert vus[-1] == "--rebase"


def test_fetch_et_pull_sans_sous_modules(client, monkeypatch):
    """Le fetch d'un sous-module viserait un autre dépôt que celui du ticket
    du relais : jamais récursif."""
    c, work = client
    p = _depot_local(work)
    _git(p, "remote", "add", "origin", "http://depot.lan/x.git")
    vus: list = []

    async def reseau(agent, cwd, args, **kw):
        vus.append(list(args))
        return git_ops.GitResult(0, "", "")
    monkeypatch.setattr(git_ops, "run_network", reseau)
    monkeypatch.setattr(git_ops, "remote_block_reason", lambda url, uid: None)
    assert c.post("/api/sandbox/git/fetch", json={"repo": "p"}).status_code == 200
    c.post("/api/sandbox/git/pull", json={"repo": "p"})
    assert vus and all("--no-recurse-submodules" in a for a in vus), vus


def test_abandon_ne_suit_pas_un_lien_de_dossier(client):
    """``lnk -> ../autre`` : abandonner « lnk/precieux.txt » supprimait
    ``/work/autre/precieux.txt``, hors du dépôt."""
    c, work = client
    p = _depot_local(work, "r")
    (work / "autre").mkdir()
    (work / "autre" / "precieux.txt").write_text("x")
    (p / "lnk").symlink_to("../autre")
    (p / "vrai").mkdir()
    (p / "vrai" / "neuf.txt").write_text("x")
    r = c.post("/api/sandbox/git/discard",
               json={"repo": "r", "paths": ["lnk/precieux.txt", "vrai/neuf.txt"]})
    assert r.status_code == 200, r.text
    assert (work / "autre" / "precieux.txt").exists()
    assert not (p / "vrai" / "neuf.txt").exists()


def test_clone_en_echec_ou_hors_delai_ne_laisse_rien(client, monkeypatch):
    """git tué à l'échéance ne nettoie pas : le dossier partiel est retiré,
    sinon le nouvel essai répond 409."""
    c, work = client
    monkeypatch.setattr(git_ops, "remote_block_reason", lambda url, uid: None)

    async def lent(agent, cwd, args, **kw):
        (work / "lent").mkdir()
        (work / "lent" / ".git").mkdir()
        return git_ops.GitResult(124, "", "", timed_out=True)
    monkeypatch.setattr(git_ops, "run_network", lent)
    r = c.post("/api/sandbox/git/clone", json={"url": "http://depot.lan/lent.git"})
    assert r.status_code == 504, r.text
    assert not (work / "lent").exists()

    async def injoignable(agent, cwd, args, **kw):
        (work / "lent").mkdir()
        raise AgentError("agent_unavailable", "test")
    monkeypatch.setattr(git_ops, "run_network", injoignable)
    r = c.post("/api/sandbox/git/clone", json={"url": "http://depot.lan/lent.git"})
    assert r.status_code == 503, r.text
    assert not (work / "lent").exists()


def test_diff_du_premier_commit_et_sorties_tronquees(client, monkeypatch):
    c, work = client
    p = _depot_local(work)
    h = subprocess.run(["git", "rev-parse", "HEAD"], cwd=p, capture_output=True,
                       text=True).stdout.strip()
    d = c.get("/api/sandbox/git/commit-diff", params={"repo": "p", "hash": h}).json()
    assert d["files"] == [{"status": "A", "path": "a.txt"}] and d["truncated"] is False
    (p / "gros.txt").write_text("x" * 5000)
    _git(p, "add", "gros.txt")
    _git(p, "commit", "-q", "-m", "gros")
    monkeypatch.setattr(sg, "_SORTIE", 1000)
    r = c.get("/api/sandbox/git/show-file", params={"repo": "p", "hash": "HEAD",
                                                    "path": "gros.txt"})
    assert r.status_code == 413, r.text
    (p / "gros.txt").write_text("y" * 5000)
    d = c.get("/api/sandbox/git/diff", params={"repo": "p"}).json()
    assert d["truncated"] is True


def test_depots_et_arbre_sont_des_sondages(client, monkeypatch):
    """``/repos`` et ``/tree`` ne comptent pas comme une activité de la
    sandbox (horloge d'arrêt pour inactivité)."""
    c, work = client
    _depot_local(work)
    passifs: list = []
    for nom in ("list", "read_many"):
        vrai = getattr(AC.AgentClient, nom)

        async def espion(self, *a, _vrai=vrai, _nom=nom, **k):
            passifs.append((_nom, k.get("passive", False)))
            return await _vrai(self, *a, **k)
        monkeypatch.setattr(AC.AgentClient, nom, espion)
    assert c.get("/api/sandbox/git/repos").status_code == 200
    assert c.get("/api/sandbox/git/tree", params={"repo": "p"}).status_code == 200
    assert passifs and all(p for _n, p in passifs), passifs
