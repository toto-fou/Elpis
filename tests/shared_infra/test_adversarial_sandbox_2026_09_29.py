# SPDX-License-Identifier: MIT
"""Tests adversariaux de la frontière hôte ↔ sandbox (2026-09-29).

Ce que le conteneur peut poser dans ``/work`` — FIFO, socket, lien dur, noms
décomposés ou bidirectionnels, dossier remplacé par un lien pendant un
parcours, dépôt Git piégé — ne doit ni bloquer l'hôte, ni lui faire lire ou
modifier autre chose que ce qui est demandé.

Les opérations passent par un adaptateur paramétré par CHEMIN D'EXÉCUTION.
Depuis L4.2 il n'y en a plus qu'un : « agent », les outils fichiers passent
par l'agent de la sandbox — ici en processus, sur le disque de l'hôte (la
suite n'exige pas Docker). La même matrice, contre l'image et l'agent du
conteneur : ``test_adversarial_conteneur_2026_10_03.py`` (lancement explicite).
"""
from __future__ import annotations

import os
import shutil
import socket
import subprocess
import threading
import unicodedata

import pytest

import llm_core.tools.fs_tools as fs_tools
from shared_infra.sandbox import paths

SECRET = "SECRET-DE-L-HOTE"


class _FakeMCP:
    def __init__(self):
        self.tools = {}

    def tool(self, **kw):
        def deco(fn):
            self.tools[fn.__name__] = fn
            return fn
        return deco


class AgentOps:
    """Chemin « agent » : les outils fichiers, qui passent par l'agent de la
    sandbox (L4.2)."""

    def __init__(self, tools, work):
        self.tools, self.work = tools, work

    def read(self, path):
        return self.tools["read_file"](None, path=path)

    def listing(self, path="."):
        return self.tools["list_files"](None, path=path, recursive=True, include_hidden=True)

    def grep(self, text):
        return self.tools["list_files"](None, path=".", search_text=text)

    def write(self, path, content):
        return self.tools["write_file"](None, path=path, content=content)


@pytest.fixture(params=["agent"])
def ops(request, tmp_path, monkeypatch):
    base = tmp_path / "sandboxes"
    work = base / "guest" / "work"
    work.mkdir(parents=True)
    monkeypatch.setenv("APP_SANDBOX_DIR", str(base))
    mcp = _FakeMCP()
    fs_tools.register(mcp, base)
    hote = tmp_path / "hote"
    hote.mkdir()
    (hote / "secret.txt").write_text(SECRET + "\n")
    o = AgentOps(mcp.tools, work)
    o.hote = hote
    return o


def _borne(fn, timeout=10.0):
    """Exécute ``fn`` dans un thread : une ouverture bloquante (FIFO) ferait
    échouer le test au lieu de le figer."""
    out = {}
    t = threading.Thread(target=lambda: out.setdefault("r", fn()), daemon=True)
    t.start()
    t.join(timeout)
    assert not t.is_alive(), "l'opération a bloqué"
    return out.get("r")


# ── Fichiers spéciaux ───────────────────────────────────────────────────────

def test_fifo_et_socket_ne_bloquent_ni_ne_sont_lus(ops):
    os.mkfifo(ops.work / "fifo")
    s = socket.socket(socket.AF_UNIX)
    s.bind(str(ops.work / "sock"))
    (ops.work / "ok.txt").write_text("aiguille\n")
    try:
        for name in ("fifo", "sock"):
            r = _borne(lambda n=name: ops.read(n))
            assert r.get("ok") is False, r
        g = _borne(lambda: ops.grep("aiguille"))
        assert "ok.txt" in str(g)
        _borne(ops.listing)
    finally:
        s.close()


def test_ecrire_un_lien_dur_ne_modifie_pas_son_jumeau(ops):
    (ops.work / "a.txt").write_text("v1\n")
    os.link(ops.work / "a.txt", ops.work / "b.txt")
    assert ops.write("a.txt", "v2\n").get("ok"), "écriture refusée"
    assert (ops.work / "a.txt").read_text() == "v2\n"
    assert (ops.work / "b.txt").read_text() == "v1\n"      # nouvel inode, jumeau intact


# ── Noms ────────────────────────────────────────────────────────────────────

def test_noms_decomposes_bidirectionnels_et_trop_longs(ops):
    nfd = unicodedata.normalize("NFD", "café.txt")
    nfc = unicodedata.normalize("NFC", "café.txt")
    (ops.work / nfd).write_text("décomposé\n")
    # Pas de normalisation silencieuse : l'autre forme est un AUTRE fichier.
    assert ops.read(nfc).get("ok") is False
    assert "décomposé" in str(ops.read(nfd))

    bidi = "facture‮txt.exe"                       # U+202E : inversion d'affichage
    (ops.work / bidi).write_text("bidi\n")
    assert "bidi" in str(ops.read(bidi))
    assert bidi in ops.listing()["items"]

    r = ops.write("x" * 300 + ".txt", "trop long\n")     # > NAME_MAX : erreur propre
    assert r.get("ok") is False, r


# ── Courses ─────────────────────────────────────────────────────────────────

def test_listage_d_un_dossier_remplace_par_un_lien_pendant_le_parcours(ops, monkeypatch):
    """Le parcours se fait dans l'agent (L4.2) : ``d``, relevé comme dossier
    puis remplacé par un lien au moment où le parcours l'ouvre, n'est pas
    descendu."""
    from shared_infra.sandbox.agent import server as agent_server
    (ops.work / "d").mkdir()
    (ops.work / "d" / "leurre.txt").write_text("x\n")
    cible = str(ops.work / "d")
    vrai_open, vrai_scandir = agent_server.os.open, agent_server.os.scandir
    bascule = []

    def basculer(chemin):
        if chemin == cible and not bascule:
            bascule.append(True)
            (ops.work / "d" / "leurre.txt").unlink()
            (ops.work / "d").rmdir()
            os.symlink(ops.hote, ops.work / "d")

    def ouvrir(chemin, *a, **k):
        basculer(chemin)
        return vrai_open(chemin, *a, **k)

    def scandir(chemin="."):
        basculer(chemin)
        return vrai_scandir(chemin)
    monkeypatch.setattr(agent_server.os, "open", ouvrir)
    monkeypatch.setattr(agent_server.os, "scandir", scandir)
    r = ops.listing()
    assert bascule, "le listage n'a pas ouvert le dossier"
    assert "secret.txt" not in str(r)


# ── Dépôts Git piégés ───────────────────────────────────────────────────────

def _git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True,
                   env={"PATH": "/usr/bin:/bin", "HOME": str(cwd), "GIT_CONFIG_NOSYSTEM": "1",
                        "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
                        "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t",
                        "GIT_ALLOW_PROTOCOL": "file"})


@pytest.fixture
def depots(tmp_path, monkeypatch):
    from shared_infra import config
    sb = tmp_path / "sb"
    work = sb / "alice" / "work"
    work.mkdir(parents=True)
    monkeypatch.setattr(config, "SANDBOX_DIR", sb)
    return work


def _repo(path):
    path.mkdir(parents=True)
    _git(path, "init", "-q", "-b", "main")
    (path / "a.txt").write_text("un\n")
    _git(path, "add", "a.txt")
    _git(path, "commit", "-q", "-m", "init")
    return path


def test_sous_module_local_jamais_rapatrie(depots, tmp_path, monkeypatch):
    """git tourne dans la sandbox (L4.4) sans l'environnement ``GIT_*`` du
    service : avec ``GIT_ALLOW_PROTOCOL=file`` hérité, il rapatrierait un
    sous-module local ; git refuse alors de lui-même ``file://`` pour un
    sous-module."""
    from llm_core.tools._espace import Espace
    monkeypatch.setenv("GIT_ALLOW_PROTOCOL", "file")
    dehors = _repo(tmp_path / "dehors")                  # hors de la zone de travail
    repo = _repo(depots / "repo")
    _git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", str(dehors), "sub")
    _git(repo, "commit", "-qm", "sous-module")
    shutil.rmtree(repo / "sub")
    shutil.rmtree(repo / ".git" / "modules")
    r = Espace("alice", depots).git("repo", ["submodule", "update", "--init"], timeout_s=30)
    assert r.returncode != 0
    assert not (repo / "sub" / "a.txt").exists()


def test_pilote_gitattributes_absent_ne_casse_pas_le_statut(depots):
    repo = _repo(depots / "repo")
    (repo / ".gitattributes").write_text("*.txt filter=absent diff=absent\n")
    (repo / "a.txt").write_text("deux\n")
    from llm_core.tools._espace import Espace
    statut, err = fs_tools._git_status_map(Espace("alice", depots), depots, repo)
    assert err is None and statut.get("a.txt") == " M"
