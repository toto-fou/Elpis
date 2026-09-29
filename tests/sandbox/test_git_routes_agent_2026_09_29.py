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


def test_clone_pull_push(client, connecteur):
    c, work = client
    r = c.post("/api/sandbox/git/clone", json={"url": connecteur.url, "dir": "copie", **IDS})
    assert r.status_code == 200, r.text
    config = (work / "copie" / ".git" / "config").read_text()
    assert connecteur.url in config and JETON not in config
    assert connecteur.vus and all(a == BASIC for _m, _p, a in connecteur.vus)

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
    _git(work / "copie", "remote", "add", "local", str(connecteur.src))
    r = c.post("/api/sandbox/git/fetch", json={"repo": "copie", **IDS})
    assert r.status_code == 200 and r.json()["skipped"] == ["local"], r.text


def test_push_limite_aux_refs_de_la_route(client, connecteur):
    c, work = client
    assert c.post("/api/sandbox/git/clone",
                  json={"url": connecteur.url, "dir": "copie", **IDS}).status_code == 200
    _git(work / "copie", "branch", "autre")
    # Refspec de la config : ``git push origin`` pousserait toutes les branches.
    _git(work / "copie", "config", "remote.origin.push", "refs/heads/*:refs/heads/*")
    r = c.post("/api/sandbox/git/push", json={"repo": "copie", **IDS})
    assert r.status_code == 400, r.text
    assert "refs/heads/autre hors de l'opération autorisée" in r.json()["detail"]
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
