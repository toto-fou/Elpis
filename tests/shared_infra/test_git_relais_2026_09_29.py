# SPDX-License-Identifier: MIT
"""Git par l'agent de la sandbox et relais authentifiant (L4.4) : git local
durci, puis réseau de bout en bout — agent en thread, relais de l'hôte, et un
vrai serveur Git HTTP (``git http-backend``) en amont."""
from __future__ import annotations

import socket
import subprocess
from pathlib import Path

import pytest

from shared_infra.sandbox import git_ops, git_relay
from shared_infra.sandbox.agent_client import AgentError
from tests._git_amont import BASIC, JETON, _git, demarrer_amont


def _libre(url, uid):
    return None                                          # amont local (127.0.0.1)


@pytest.fixture()
def sandbox(tmp_path):
    from shared_infra.sandbox.executors import get_user_sandbox
    work = tmp_path / "sb" / "u" / "work"
    work.mkdir(parents=True)
    return get_user_sandbox(1, "u", work).agent, work


@pytest.fixture()
def amont(tmp_path):
    srv = demarrer_amont(tmp_path)
    yield srv
    srv.shutdown()
    srv.server_close()


def _reseau(**kw):
    return dict(uid=1, auth=("u", JETON), block_reason=_libre, **kw)


# ── git local ────────────────────────────────────────────────────────────────

async def test_git_local_durci(sandbox):
    agent, work = sandbox
    (work / "p").mkdir()
    assert (await git_ops.run(agent, "p", ["init", "-q", "-b", "main"])).ok
    (work / "p" / "f.txt").write_text("x\n")
    hook = work / "p" / ".git" / "hooks" / "pre-commit"
    hook.write_text("#!/bin/sh\nexit 1\n")
    hook.chmod(0o755)
    assert (await git_ops.run(agent, "p", ["add", "f.txt"])).ok
    r = await git_ops.run(agent, "p", ["commit", "-q", "-m", "premier"])
    assert r.ok, r.stderr                                # hook jamais lancé
    r = await git_ops.run(agent, "p", ["log", "-1", "--format=%cn <%ce>"])
    assert r.stdout.strip() == "Elpis <elpis@localhost>"  # identité par défaut
    # La config de l'utilisateur (/work/.gitconfig) prime sur ce défaut.
    (work / ".gitconfig").write_text("[user]\n\tname = Moi\n\temail = moi@x\n")
    assert (await git_ops.run(agent, "p", ["commit", "-q", "--allow-empty", "-m", "2"])).ok
    r = await git_ops.run(agent, "p", ["log", "-1", "--format=%cn"])
    assert r.stdout.strip() == "Moi"


async def test_git_local_bornes(sandbox):
    agent, work = sandbox
    r = await git_ops.run(agent, "", ["-c", "alias.dort=!sleep 5", "dort"], timeout_s=0.5)
    assert r.returncode == 124 and r.timed_out and r.duration_ms < 4000
    r = await git_ops.run(agent, "", ["-c", "alias.bavard=!head -c 300000 /dev/zero | tr '\\0' x",
                                      "bavard"], max_out=1000)
    assert r.ok and r.truncated and r.stdout == "x" * 1000
    with pytest.raises(AgentError) as e:
        await git_ops.run(agent, "", ["status"], env={"GIT_DIR": "/"})
    assert e.value.code == "bad_request"
    (work / "dehors").symlink_to("/tmp")
    with pytest.raises(AgentError) as e:
        await git_ops.run(agent, "dehors", ["status"])
    assert e.value.code == "outside_root"


# ── réseau par le relais ─────────────────────────────────────────────────────

async def test_clone_fetch_pull_push(sandbox, amont):
    agent, work = sandbox
    url = amont.url
    r = await git_ops.run_network(agent, "", ["clone", "-q", "--", url, "copie"],
                                  url=url, **_reseau())
    assert r.ok, r.stderr
    assert (work / "copie" / "a.txt").read_text() == "a\n"
    config = (work / "copie" / ".git" / "config").read_text()
    assert url in config and JETON not in config        # URL d'origine, jamais l'identifiant
    # Identifiants saisis : envoyés seulement après la demande de l'amont (401).
    assert [(m, p) for m, p, a in amont.vus if a is None] == [
        ("GET", "/depot.git/info/refs?service=git-upload-pack")]
    assert all(a == BASIC for _m, _p, a in amont.vus if a is not None)

    # Fetch : FETCH_HEAD et la sortie parlent de l'URL d'origine.
    (amont.src / "b.txt").write_text("b\n")
    _git(amont.src, "add", "b.txt")
    _git(amont.src, "commit", "-q", "-m", "b")
    _git(amont.src, "push", "-q", amont.racine + "/depot.git", "main")
    r = await git_ops.pull(agent, "copie", "origin", "main", "--no-rebase", uid=1,
                           auth=("u", JETON), block_reason=_libre)
    assert r.ok, r.stderr
    fetch_head = (work / "copie" / ".git" / "FETCH_HEAD").read_text()
    assert f"branch 'main' of {url[:-len('.git')]}\n" in fetch_head, fetch_head
    assert (work / "copie" / "b.txt").read_text() == "b\n"

    # Push : seulement les refs du ticket, jamais de suppression.
    (work / "copie" / "c.txt").write_text("c\n")
    assert (await git_ops.run(agent, "copie", ["add", "c.txt"])).ok
    assert (await git_ops.run(agent, "copie", ["commit", "-q", "-m", "c"])).ok
    ok = await git_ops.run_network(agent, "copie", ["push", "origin", "HEAD:refs/heads/agent/x"],
                                   url=url, push_refs={"refs/heads/agent/x"}, **_reseau())
    assert ok.ok, ok.stderr
    for args, motif in ((["push", "origin", "HEAD:refs/heads/main"], "hors de l'opération"),
                        (["push", "origin", ":refs/heads/agent/x"], "suppression")):
        r = await git_ops.run_network(agent, "copie", args, url=url,
                                      push_refs={"refs/heads/agent/x"}, **_reseau())
        assert not r.ok and motif in r.stderr, r.stderr
    refs = subprocess.run(["git", "for-each-ref", "--format=%(refname)"],
                          cwd=amont.racine + "/depot.git", capture_output=True, text=True).stdout
    assert refs.split() == ["refs/heads/agent/x", "refs/heads/main"]
    assert "127.0.0.1" not in ok.stderr.replace(url, "")  # sortie réécrite vers l'origine


async def test_sans_identifiant_l_amont_refuse(sandbox, amont):
    agent, _work = sandbox
    r = await git_ops.run_network(agent, "", ["clone", "-q", "--", amont.url, "copie"],
                                  url=amont.url, uid=1, block_reason=_libre)
    assert not r.ok
    assert all(a is None for _m, _p, a in amont.vus)


async def test_garde_et_schemas(sandbox):
    agent, _work = sandbox
    for url, code in (("git://h/x.git", "scheme_not_relayed"),
                      ("https://u:p@h/x.git", "blocked_remote"),
                      ("https://h/a/../b.git", "malformed_url"),
                      ("http://127.0.0.1:1/x.git", "blocked_remote")):
        with pytest.raises(git_relay.RelayRefused) as e:
            await git_ops.run_network(agent, "", ["ls-remote", url], uid=1, url=url,
                                      block_reason=None if "127" in url or "@" in url else _libre)
        assert e.value.code == code, (url, e.value.code)


def _requete(dossier: Path, nom: str, jeton: str, ligne: str) -> bytes:
    s = socket.socket(socket.AF_UNIX)
    s.settimeout(10)
    s.connect(str(dossier / nom))
    s.sendall(f"ELPIS-RELAY/1 {jeton}\r\n{ligne}\r\nHost: x\r\n\r\n".encode())
    rendu = b""
    while (b := s.recv(65536)):
        rendu += b
    s.close()
    return rendu


def test_relais_tient_au_ticket(tmp_path, amont):
    dossier = tmp_path / "relais"
    with git_relay.ticket(dossier, uid=1, url=amont.url, service=git_relay.UPLOAD,
                          auth=BASIC) as (relay, _refus):
        nom, jeton = relay["socket"], relay["ticket"]
        assert JETON not in repr(relay)                 # rien de secret pour le conteneur
        ok = _requete(dossier, nom, jeton, "GET /depot.git/info/refs?service=git-upload-pack HTTP/1.1")
        assert ok.startswith(b"HTTP/1.1 200")
        for ligne in ("GET /autre.git/info/refs?service=git-upload-pack HTTP/1.1",
                      "GET /depot.git/info/refs?service=git-receive-pack HTTP/1.1",
                      "GET /depot.git/HEAD HTTP/1.1"):
            assert _requete(dossier, nom, jeton, ligne).startswith(b"HTTP/1.1 403"), ligne
        assert _requete(dossier, nom, "x" * 43, "GET /depot.git/info/refs HTTP/1.1") == b""
    # Révoqué en fin d'opération : connexion fermée sans réponse.
    assert _requete(dossier, nom, jeton,
                    "GET /depot.git/info/refs?service=git-upload-pack HTTP/1.1") == b""
    assert oct((dossier / nom).stat().st_mode & 0o777) == "0o666"


async def test_git_passif_ne_redemarre_pas_le_conteneur(sandbox, monkeypatch):
    """Sondage du panneau Git : conteneur arrêté → ``container_down``, sans le
    redémarrer ni y lancer l'agent."""
    from shared_infra.sandbox.executors import _user_sandbox as us
    agent, _work = sandbox
    appels: list = []

    async def arrete(self):
        return us.SandboxStatus(exists=True, running=False, container_name=self.container_name)

    async def reveiller(self):
        appels.append("ensure_running")
        return us.SandboxStatus(exists=True, running=True, container_name=self.container_name)
    monkeypatch.setattr(us.UserSandbox, "status", arrete)
    monkeypatch.setattr(us.UserSandbox, "ensure_running", reveiller)
    with pytest.raises(AgentError) as e:
        await git_ops.run(agent, "", ["status"], passive=True)
    assert e.value.code == "container_down" and appels == []
    assert (await git_ops.run(agent, "", ["--version"])).ok     # actif : démarré au besoin
    assert appels == ["ensure_running"]


def test_origine_telle_qu_ecrite():
    """``insteadOf`` compare des préfixes, casse comprise : l'origine réécrite
    reprend l'URL telle qu'écrite ; l'amont, lui, est normalisé."""
    from shared_infra.sandbox.agent import server as S
    for url, amont, depot, origine in (
            ("https://GitHub.com/Org/Depot.git", "https://github.com", "/Org/Depot",
             "https://GitHub.com/"),
            ("http://[FD00::1]:3000/r.git/", "http://[fd00::1]:3000", "/r", "http://[FD00::1]:3000/")):
        assert git_relay.amont(url) == (amont, depot, origine)
        assert S._ORIGINE.fullmatch(origine)


def _attendre(cond, delai=5.0):
    import time
    fin = time.monotonic() + delai
    while not cond():
        assert time.monotonic() < fin
        time.sleep(0.01)


def test_connexions_simultanees_bornees(tmp_path, amont):
    """Relais : au plus ``_CONNEXIONS_MAX`` requêtes à la fois par ticket ;
    agent : au plus ``_RELAIS_CONNEXIONS`` connexions relayées par commande."""
    from shared_infra.sandbox.agent import server as S
    dossier = tmp_path / "relais"
    ligne = "GET /depot.git/info/refs?service=git-upload-pack HTTP/1.1"
    with git_relay.ticket(dossier, uid=1, url=amont.url, service=git_relay.UPLOAD,
                          auth=BASIC) as (relay, _refus):
        t = git_relay._registre._tickets[relay["ticket"]]
        muettes = []
        for _ in range(git_relay._CONNEXIONS_MAX):
            s = socket.socket(socket.AF_UNIX)
            s.connect(str(dossier / relay["socket"]))
            s.sendall(f"ELPIS-RELAY/1 {relay['ticket']}\r\n".encode())
            muettes.append(s)
        _attendre(lambda: t.actives == git_relay._CONNEXIONS_MAX)
        assert _requete(dossier, relay["socket"], relay["ticket"], ligne) == b""
        for s in muettes:
            s.close()
        _attendre(lambda: t.actives == 0)
        assert _requete(dossier, relay["socket"], relay["ticket"], ligne).startswith(b"HTTP/1.1 200")

        with S._Relais(str(dossier), relay) as r:
            port = int(r.prefixe.rsplit(":", 1)[1].rstrip("/"))
            ouvertes = [socket.create_connection(("127.0.0.1", port)) for _ in range(S._RELAIS_CONNEXIONS)]
            _attendre(lambda: r._actives == S._RELAIS_CONNEXIONS)
            de_trop = socket.create_connection(("127.0.0.1", port))
            de_trop.settimeout(5)
            assert de_trop.recv(1) == b""                # fermée d'emblée
            de_trop.close()
            for s in ouvertes:
                s.close()


def test_connexions_sans_ticket_bornees(tmp_path, amont, monkeypatch):
    """Relais : une connexion qui ne présente pas de ticket est fermée après
    ``_PREAMBULE_S`` ; au-delà de ``_CONNEXIONS_SERVEUR`` connexions en cours,
    la suivante est fermée d'emblée."""
    import time
    dossier = tmp_path / "relais"
    monkeypatch.setattr(git_relay, "_PREAMBULE_S", 0.3)
    monkeypatch.setattr(git_relay, "_CONNEXIONS_SERVEUR", 3)
    with git_relay.ticket(dossier, uid=1, url=amont.url, service=git_relay.UPLOAD,
                          auth=BASIC) as (relay, _refus):
        srv = git_relay._serveurs[str(dossier)]
        muette = socket.socket(socket.AF_UNIX)
        muette.settimeout(5)
        muette.connect(str(dossier / relay["socket"]))
        debut = time.monotonic()
        assert muette.recv(1) == b"" and time.monotonic() - debut < 3
        muette.close()
        _attendre(lambda: srv._actives == 0)
        monkeypatch.setattr(git_relay, "_PREAMBULE_S", 5.0)
        ouvertes = []
        for _ in range(3):
            s = socket.socket(socket.AF_UNIX)
            s.connect(str(dossier / relay["socket"]))
            ouvertes.append(s)
        _attendre(lambda: srv._actives == 3)
        de_trop = socket.socket(socket.AF_UNIX)
        de_trop.settimeout(5)
        de_trop.connect(str(dossier / relay["socket"]))
        assert de_trop.recv(1) == b""
        de_trop.close()
        for s in ouvertes:
            s.close()
        _attendre(lambda: srv._actives == 0)
        ligne = "GET /depot.git/info/refs?service=git-upload-pack HTTP/1.1"
        assert _requete(dossier, relay["socket"], relay["ticket"], ligne).startswith(b"HTTP/1.1 200")


# ── Relecture L4.4 (2026-09-30) ──────────────────────────────────────────────

async def test_connecteur_envoye_d_emblee(sandbox, amont, monkeypatch):
    """Identifiant d'un CONNECTEUR (lié à cet hôte) : envoyé dès la première
    requête ; les identifiants saisis, eux, attendent le 401 (cf. plus haut)."""
    agent, _work = sandbox
    monkeypatch.setattr(git_ops, "_credential", lambda uid, url: ("u", JETON))
    r = await git_ops.run_network(agent, "", ["clone", "-q", "--", amont.url, "c2"],
                                  url=amont.url, uid=1, block_reason=_libre)
    assert r.ok, r.stderr
    assert amont.vus and all(a == BASIC for _m, _p, a in amont.vus)


async def test_proxy_d_environnement_ignore(sandbox, amont, monkeypatch):
    """Ni l'hôte (relais → amont) ni git dans la sandbox (→ écoute locale de
    l'agent) ne passent par un proxy : celui de l'environnement ou de
    ``/work/.gitconfig`` ne voit ni ne casse le trafic Git authentifié."""
    agent, work = sandbox
    for var in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "all_proxy"):
        monkeypatch.setenv(var, "http://127.0.0.1:9")
    monkeypatch.delenv("NO_PROXY", raising=False)
    monkeypatch.delenv("no_proxy", raising=False)
    r = await git_ops.run_network(agent, "", ["clone", "-q", "--", amont.url, "c3"],
                                  url=amont.url, **_reseau())
    assert r.ok, r.stderr
    (work / ".gitconfig").write_text("[http]\n\tproxy = http://127.0.0.1:9\n")
    r = await git_ops.run_network(agent, "c3", ["fetch", "-q", "origin"],
                                  url=amont.url, **_reseau())
    assert r.ok, r.stderr


async def test_redirection_de_l_amont_refusee(sandbox, tmp_path):
    """Une redirection n'est ni suivie ni rendue à git (qui la suivrait hors
    du relais, sans ticket ni garde) : refus explicite, l'URL à corriger."""
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class Redirige(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            self.send_response(301)
            self.send_header("Location", "https://ailleurs.lan/depot.git/info/refs?x=1")
            self.send_header("Content-Length", "0")
            self.end_headers()

    srv = ThreadingHTTPServer(("127.0.0.1", 0), Redirige)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        agent, _work = sandbox
        url = f"http://127.0.0.1:{srv.server_address[1]}/depot.git"
        r = await git_ops.run_network(agent, "", ["clone", "-q", "--", url, "c4"],
                                      url=url, **_reseau())
    finally:
        srv.shutdown()
        srv.server_close()
    assert not r.ok
    assert any("redirige (301 vers https://ailleurs.lan/depot.git/info/refs)" in m
               for m in r.refus), r.refus


async def test_ca_illisible_explique(sandbox, amont, monkeypatch):
    """``GIT_SSL_CAINFO`` absent : message du relais, et non une réponse vide."""
    agent, _work = sandbox
    monkeypatch.setenv("GIT_SSL_CAINFO", "/nulle/part/ca.pem")
    git_relay._tls.cache_clear()
    try:
        r = await git_ops.run_network(agent, "", ["clone", "-q", "--", amont.url, "c5"],
                                      url=amont.url, **_reseau())
    finally:
        monkeypatch.delenv("GIT_SSL_CAINFO")
        git_relay._tls.cache_clear()
    assert not r.ok and any("autorité de certification illisible" in m for m in r.refus)
    assert amont.vus == []


async def test_lfs_jamais_telecharge(sandbox):
    """Checkout d'un dépôt LFS : pointeurs gardés, même hors du relais (le
    filtre de l'image joindrait l'amont LFS directement)."""
    agent, _work = sandbox
    r = await git_ops.run(agent, "", ["-c", "alias.env=!env", "env"])
    assert r.ok and "GIT_LFS_SKIP_SMUDGE=1" in r.stdout.splitlines()


def test_agent_rend_la_place_sans_descripteur(tmp_path, monkeypatch):
    """Agent : un échec de création du socket (plus de descripteur) rend la
    place de la connexion au lieu de la perdre."""
    from shared_infra.sandbox.agent import server as S
    spec = {"socket": "1.sock", "ticket": "t" * 43, "origin": "http://h/"}
    with S._Relais(str(tmp_path), spec) as r:
        r._actives = 1

        class Client:
            fermee = False

            def close(self):
                Client.fermee = True

        def plus_de_fd(*a, **k):
            raise OSError(24, "Too many open files")
        monkeypatch.setattr(S.socket, "socket", plus_de_fd)
        r._relayer(Client())
        assert r._actives == 0 and Client.fermee
