# SPDX-License-Identifier: MIT
"""Matrice adversariale de la frontière hôte ↔ sandbox, en VRAI conteneur.

Même matrice que ``test_adversarial_sandbox_2026_09_29.py`` (FIFO, socket,
lien dur, noms décomposés ou bidirectionnels, dossier remplacé par un lien
pendant un parcours, dépôt Git piégé), mais contre l'image ``elpis/sandbox``
et l'agent qui tourne DANS le conteneur, sous l'UID du conteneur. Les pièges
sont posés depuis le conteneur (``docker exec``), comme le ferait le code
qu'on y exécute : l'hôte n'écrit pas dans ``/work``, qui appartient à l'UID
du conteneur.

Lancement explicite (Docker et l'image requis, un conteneur par test) :
``ELPIS_TEST_CONTENEUR=1 venv/bin/pytest -n 0
tests/shared_infra/test_adversarial_conteneur_2026_10_03.py``.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import threading
import time
import unicodedata

import pytest

import llm_core.tools.fs_tools as fs_tools
from shared_infra.sandbox import agent_client as AC, naming as _naming
from shared_infra.sandbox.executors._user_sandbox import SandboxAdminConfig

pytestmark = pytest.mark.agent_reel

COMPTE = "guest"                       # compte par défaut des outils appelés sans contexte
UID = "10001:10001"


def _docker(*args, timeout=60, check=True):
    return subprocess.run(["docker", *args], capture_output=True, text=True,
                          timeout=timeout, check=check)


def _prerequis():
    if os.environ.get("ELPIS_TEST_CONTENEUR") != "1":
        pytest.skip("ELPIS_TEST_CONTENEUR=1 requis (vrai conteneur)")
    if not shutil.which("docker"):
        pytest.skip("docker absent")
    image = SandboxAdminConfig.from_dict({}).image
    if _docker("image", "inspect", image, check=False).returncode != 0:
        pytest.skip(f"image {image} absente")
    nom = _naming.container_name(COMPTE)
    if _docker("container", "inspect", nom, check=False).returncode == 0:
        pytest.skip(f"un conteneur {nom} existe déjà : on n'y touche pas")
    return nom


class _FakeMCP:
    def __init__(self):
        self.tools = {}

    def tool(self, **kw):
        def deco(fn):
            self.tools[fn.__name__] = fn
            return fn
        return deco


class Conteneur:
    """Les outils fichiers (passés par l'agent du conteneur) et les gestes
    du code de la sandbox (``docker exec`` sous l'UID du conteneur)."""

    def __init__(self, tools, nom, work):
        self.tools, self.nom, self.work = tools, nom, work

    def read(self, path):
        return self.tools["read_file"](None, path=path)

    def listing(self, path="."):
        return self.tools["list_files"](None, path=path, recursive=True, include_hidden=True)

    def grep(self, text):
        return self.tools["list_files"](None, path=".", search_text=text)

    def write(self, path, content):
        return self.tools["write_file"](None, path=path, content=content)

    def sh(self, script, *args, timeout=60):
        """Script lancé dans ``/work`` par le code de la sandbox."""
        r = _docker("exec", "-u", UID, "-w", "/work", self.nom, "sh", "-c", script, "--",
                    *args, timeout=timeout, check=False)
        assert r.returncode == 0, r.stderr
        return r.stdout


@pytest.fixture
def conteneur(tmp_path, monkeypatch):
    from shared_infra import config
    from shared_infra.sandbox.executors import _user_sandbox as us
    nom = _prerequis()
    base = tmp_path / "sandboxes"
    work = base / COMPTE / "work"
    work.mkdir(parents=True)
    # Créés par l'hôte : un montage dont la source manque serait créé par
    # le démon, propriété de root, et le nettoyage échouerait.
    (base / COMPTE / AC.AGENT_RUN_DIR).mkdir()
    (base / AC.RELAY_DIR).mkdir()
    monkeypatch.setenv("APP_SANDBOX_DIR", str(base))
    monkeypatch.setattr(config, "SANDBOX_DIR", base)
    us.reset_user_sandbox_cache()
    mcp = _FakeMCP()
    fs_tools.register(mcp, base)
    c = Conteneur(mcp.tools, nom, work)
    try:
        r = c.listing()                                   # démarre conteneur et agent
        assert r.get("ok") is not False, r
        etat = _docker("container", "inspect", nom, "--format", "{{.State.Running}}").stdout
        assert etat.strip() == "true", "les outils ne sont pas passés par le conteneur"
        yield c
    finally:
        _docker("exec", "-u", "0:0", nom, "sh", "-c",
                "rm -rf /work/* /work/.[!.]* /work/..?*; chown 0:0 /work; chmod 0777 /work",
                check=False)
        _docker("rm", "-fv", nom, check=False)
        us.reset_user_sandbox_cache()


def _borne(fn, timeout=20.0):
    """Exécute ``fn`` dans un thread : une ouverture bloquante (FIFO) ferait
    échouer le test au lieu de le figer."""
    out = {}
    t = threading.Thread(target=lambda: out.setdefault("r", fn()), daemon=True)
    t.start()
    t.join(timeout)
    assert not t.is_alive(), "l'opération a bloqué"
    return out.get("r")


# ── Fichiers spéciaux ───────────────────────────────────────────────────────

def test_fifo_et_socket_ne_bloquent_ni_ne_sont_lus(conteneur):
    conteneur.sh('mkfifo fifo && printf "aiguille\\n" > ok.txt && python3 -c '
                 '"import socket; socket.socket(socket.AF_UNIX).bind(\'sock\')"')
    for name in ("fifo", "sock"):
        r = _borne(lambda n=name: conteneur.read(n))
        assert r.get("ok") is False, r
    assert "ok.txt" in str(_borne(lambda: conteneur.grep("aiguille")))
    _borne(conteneur.listing)


def test_ecrire_un_lien_dur_ne_modifie_pas_son_jumeau(conteneur):
    conteneur.sh('printf "v1\\n" > a.txt && ln a.txt b.txt')
    assert conteneur.write("a.txt", "v2\n").get("ok"), "écriture refusée"
    assert conteneur.sh("cat a.txt") == "v2\n"
    assert conteneur.sh("cat b.txt") == "v1\n"            # nouvel inode, jumeau intact


# ── Liens hors de /work ─────────────────────────────────────────────────────

def test_liens_vers_le_systeme_du_conteneur_jamais_suivis(conteneur):
    conteneur.sh("ln -s /etc sortie && ln -s /etc/passwd mots")
    for chemin in ("sortie/passwd", "mots"):
        r = conteneur.read(chemin)
        assert r.get("ok") is False and "root:" not in str(r), r
    assert conteneur.write("sortie/x", "x\n").get("ok") is False
    assert "passwd" not in str(conteneur.listing())


# ── Noms ────────────────────────────────────────────────────────────────────

def test_noms_decomposes_bidirectionnels_et_trop_longs(conteneur):
    nfd = unicodedata.normalize("NFD", "café.txt")
    nfc = unicodedata.normalize("NFC", "café.txt")
    bidi = "facture‮txt.exe"                     # U+202E : inversion d'affichage
    conteneur.sh('printf "décomposé\\n" > "$1" && printf "bidi\\n" > "$2"', nfd, bidi)
    # Pas de normalisation silencieuse : l'autre forme est un AUTRE fichier.
    assert conteneur.read(nfc).get("ok") is False
    assert "décomposé" in str(conteneur.read(nfd))
    assert "bidi" in str(conteneur.read(bidi))
    assert bidi in conteneur.listing()["items"]
    r = conteneur.write("x" * 300 + ".txt", "trop long\n")    # > NAME_MAX : erreur propre
    assert r.get("ok") is False, r


# ── Courses ─────────────────────────────────────────────────────────────────

def test_dossiers_remplaces_par_des_liens_pendant_les_parcours(conteneur):
    """Le code de la sandbox bascule sans arrêt 200 dossiers entre leur forme
    réelle et un lien vers ``/etc`` pendant que l'hôte liste : aucun parcours
    ne descend dans un lien, et chaque listage aboutit."""
    noms = [f"d{i}" for i in range(200)]
    conteneur.sh('for n in "$@"; do mkdir "$n" && : > "$n/leurre.txt"; done', *noms)
    bascule = (
        "import os, sys, time\n"
        "fin = time.monotonic() + float(sys.argv[1])\n"
        "noms = sys.argv[2:]\n"
        "while time.monotonic() < fin:\n"
        "    for n in noms:\n"
        "        os.rename(n, n + '.x'); os.symlink('/etc', n)\n"
        "    for n in noms:\n"
        "        os.unlink(n); os.rename(n + '.x', n)\n")
    p = subprocess.Popen(["docker", "exec", "-u", UID, "-w", "/work", conteneur.nom,
                          "python3", "-c", bascule, "8", *noms],
                         stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        time.sleep(0.5)
        vus = 0
        fin = time.monotonic() + 6
        while time.monotonic() < fin:
            r = _borne(conteneur.listing)
            assert r.get("ok") is not False, r
            assert "passwd" not in str(r) and "hostname" not in str(r), r
            vus += 1
        assert vus >= 5
    finally:
        _, err = p.communicate(timeout=20)
    assert p.returncode == 0, f"la bascule dossier ↔ lien n'a pas tourné : {err!r}"


# ── Dépôts Git piégés ───────────────────────────────────────────────────────

_GIT_ID = "-c user.name=t -c user.email=t@t"


def test_sous_module_local_jamais_rapatrie(conteneur, monkeypatch):
    """Un sous-module qui pointe hors de ``/work`` par ``file://`` : git,
    lancé dans la sandbox sans l'environnement ``GIT_*`` du service, refuse
    de le rapatrier."""
    from llm_core.tools._espace import Espace
    monkeypatch.setenv("GIT_ALLOW_PROTOCOL", "file")
    conteneur.sh(
        f"set -e; g='git {_GIT_ID}'; "
        "mkdir -p /tmp/dehors && cd /tmp/dehors && git init -q -b main && "
        "echo un > a.txt && $g add a.txt && $g commit -qm init; "
        "mkdir /work/repo && cd /work/repo && git init -q -b main && "
        "echo un > a.txt && $g add a.txt && $g commit -qm init && "
        "$g -c protocol.file.allow=always submodule add -q /tmp/dehors sub && "
        "$g commit -qm sous-module && rm -rf sub .git/modules")
    r = Espace(COMPTE, conteneur.work).git("repo", ["submodule", "update", "--init"],
                                         timeout_s=60)
    assert r.returncode != 0
    assert conteneur.sh("ls -A repo/sub 2>/dev/null || true").strip() == ""


def test_pilote_gitattributes_absent_ne_casse_pas_le_statut(conteneur):
    from llm_core.tools._espace import Espace
    conteneur.sh(
        f"set -e; g='git {_GIT_ID}'; mkdir repo && cd repo && git init -q -b main && "
        "echo un > a.txt && $g add a.txt && $g commit -qm init && "
        "echo '*.txt filter=absent diff=absent' > .gitattributes && echo deux > a.txt")
    statut, err = fs_tools._git_status_map(Espace(COMPTE, conteneur.work), conteneur.work,
                                           conteneur.work / "repo")
    assert err is None and statut.get("a.txt") == " M"
