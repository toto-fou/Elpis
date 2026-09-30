# SPDX-License-Identifier: MIT
"""Relecture de L4.5 (archives par l'agent, 2026-09-30) : chaque défaut
corrigé a son test — sauvegarde incomplète signalée, réponse mal formée
bornée au compte, fichier coupé en cours de lecture signalé, trame de fin
bornée, en-têtes tar bornés, provisoires orphelins retirés, heure des zip,
dossier remplacé pendant le parcours, téléchargements (course, en-têtes,
sélection illisible), sortie close après la dernière trame."""
from __future__ import annotations

import asyncio
import io
import json
import os
import tarfile
import time
import zipfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from shared_infra.sandbox import agent_client as AC
from shared_infra.sandbox.agent import server as S
from shared_infra.sandbox.agent_client import AgentError
from tests.conftest import editeur_sur_agent, sandboxes_sur_agent
from tests.shared_infra.test_archives_agent_2026_09_29 import _agent, _lire, _tar


@pytest.fixture()
def work(tmp_path):
    """Même /work que ``test_archives_agent_2026_09_29``."""
    w = tmp_path / "u" / "work"
    (w / "d" / "vide").mkdir(parents=True)
    (w / "a.txt").write_text("A")
    (w / "d" / "b.sh").write_text("#!/bin/sh\n")
    os.chmod(w / "d" / "b.sh", 0o755)
    (tmp_path / "dehors.txt").write_text("HORS")
    os.symlink(tmp_path / "dehors.txt", w / "d" / "lien")
    os.mkfifo(w / "d" / "fifo")
    return w


def _client(monkeypatch, work):
    import shared_infra.sandbox.routes_files as sf
    editeur_sur_agent(monkeypatch, work)
    monkeypatch.setattr(sf, "require_user_id", lambda request: 1)
    monkeypatch.setattr(sf, "_get_work_path", lambda uid: work)
    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    return sf, TestClient(app)


# ── Sauvegarde admin ─────────────────────────────────────────────────────────

def _sauvegarde(tmp_path, monkeypatch, noms=("alice", "bob")):
    from shared_infra import config
    from shared_infra.routes import _helpers as H
    sb = tmp_path / "sb"
    for nom in noms:
        (sb / nom / "work").mkdir(parents=True)
        (sb / nom / "work" / f"{nom}.txt").write_text(nom)
    monkeypatch.setattr(config, "SANDBOX_DIR", sb)
    sandboxes_sur_agent(monkeypatch, sb, list(noms))
    metriques: list = []
    import shared_infra.db as dbm
    monkeypatch.setattr(dbm, "log_metric", lambda nom, *a, **k: metriques.append(nom))
    return H, metriques


def test_sauvegarde_sans_agent_est_incomplete(tmp_path, monkeypatch):
    """Agents indisponibles (Docker arrêté…) : le zip n'a pas le /work de ces
    comptes, il est nommé « _incomplet » et ne compte pas comme réussi."""
    H, metriques = _sauvegarde(tmp_path, monkeypatch)
    vrai = AC.AgentClient.archive

    def archive(self, *a, **k):
        if "bob" in str(self.socket_path):
            raise AgentError("container_down", "arrêté")
        return vrai(self, *a, **k)
    monkeypatch.setattr(AC.AgentClient, "archive", archive)
    chemin, nom = H._make_backup_zip("sandboxes")
    try:
        assert H.backup_incomplete(nom), nom
        with zipfile.ZipFile(chemin) as z:
            assert "sandboxes/alice/work/alice.txt" in z.namelist()
            alertes = z.read("backup-warnings.txt").decode()
        assert "bob/work — container_down" in alertes
    finally:
        os.unlink(chemin)
    assert "backup_created" not in metriques and "backup_incomplete" in metriques


def test_reponse_mal_formee_n_arrete_que_son_compte(tmp_path, monkeypatch):
    """Une réponse d'agent mal formée (date non entière…) : le /work de CE
    compte est signalé, les autres sont sauvegardés."""
    import contextlib
    H, _m = _sauvegarde(tmp_path, monkeypatch)
    vrai = AC.AgentClient.archive

    @contextlib.asynccontextmanager
    async def archive(self, *a, **k):
        if "bob" not in str(self.socket_path):
            async with vrai(self, *a, **k) as flux:
                yield flux
            return

        async def trames():
            yield b"J", json.dumps({"entry": "x", "kind": "file", "size": 1,
                                    "mtime_ns": "hier", "mode": 420}).encode()
        yield AC.AgentArchive(trames(), max_files=10)
    monkeypatch.setattr(AC.AgentClient, "archive", archive)
    chemin, nom = H._make_backup_zip("sandboxes")
    try:
        with zipfile.ZipFile(chemin) as z:
            assert "sandboxes/alice/work/alice.txt" in z.namelist()
            alertes = z.read("backup-warnings.txt").decode()
        assert "bob/work — bad_response" in alertes and H.backup_incomplete(nom)
    finally:
        os.unlink(chemin)


def test_sauvegarde_ne_garde_pas_les_sandboxes_levees(tmp_path, monkeypatch):
    """Sandbox arrêtée : démarrée pour la lecture, qui ne compte pas comme une
    activité, puis arrêtée de nouveau (elle restait levée ``idle_kill_hours``)."""
    from shared_infra.sandbox.executors import _user_sandbox as us
    H, _m = _sauvegarde(tmp_path, monkeypatch, noms=("alice",))
    etats: list = []
    activite: list = []

    async def arretee(self):
        en_marche = bool(etats) and etats[-1] == "start"
        return us.SandboxStatus(exists=True, running=en_marche, container_name=self.container_name)

    async def demarrer(self):
        etats.append("start")
        return us.SandboxStatus(exists=True, running=True, container_name=self.container_name)

    async def arreter(self):
        etats.append("stop")
    monkeypatch.setattr(us.UserSandbox, "status", arretee)
    monkeypatch.setattr(us.UserSandbox, "ensure_running", demarrer)
    monkeypatch.setattr(us.UserSandbox, "stop", arreter)
    monkeypatch.setattr(S.Agent, "signaler_activite", lambda self: activite.append(1))
    chemin, nom = H._make_backup_zip("sandboxes")
    try:
        with zipfile.ZipFile(chemin) as z:
            assert "sandboxes/alice/work/alice.txt" in z.namelist()
    finally:
        os.unlink(chemin)
    assert not H.backup_incomplete(nom)
    # ``ensure_running`` est idempotent (le client de l'agent le rappelle) ;
    # un seul arrêt, à la fin.
    assert etats[0] == "start" and etats[-1] == "stop" and etats.count("stop") == 1
    assert activite == []


def test_fichier_coupe_en_cours_de_lecture_signale(work):
    """Erreur de lecture au milieu d'un fichier : l'archive continue, le
    fichier est signalé (trame ``incomplete`` en ``raw``, bilan)."""
    import stat as _stat

    class Sortie:
        def __init__(self):
            self.objets = []

        def json(self, o):
            self.objets.append(o)

        def write(self, b):
            return len(b)
    sortie = Sortie()
    fd = os.open(work / "d", os.O_RDONLY)                 # read() sur un dossier : EISDIR
    try:
        st = os.stat(work / "a.txt")
        n, erreur = S._Brut(sortie).fichier("a.txt", st, fd)
    finally:
        os.close(fd)
    assert n == 0 and erreur
    assert sortie.objets[-1] == {"incomplete": "a.txt", "code": erreur, "bytes": 0}
    assert _stat.S_ISREG(st.st_mode)


def test_zip_d_un_fichier_raccourci_le_signale(work):
    class Tampon(io.BytesIO):
        pass
    fd = os.open(work / "a.txt", os.O_RDONLY)
    try:
        st = os.stat(work / "a.txt")
        faux = os.stat_result((st.st_mode, st.st_ino, st.st_dev, 1, 0, 0, 10,
                               st.st_atime, st.st_mtime, st.st_ctime))
        n, erreur = S._Zip(S._Sortie(Tampon())).fichier("a.txt", faux, fd)
    finally:
        os.close(fd)
    assert (n, erreur) == (1, "changed")


# ── Agent : trame de fin, extraction, heure, parcours ────────────────────────

def test_trame_de_fin_bornee(work):
    """Beaucoup d'entrées omises à noms longs non ASCII : le bilan reste sous
    la limite du client (l'archive entière échouait à la toute fin)."""
    d = work / "liens"
    d.mkdir()
    for i in range(150):
        os.symlink("/nulle/part", d / (f"{i:03d}" + "😀" * 60))
    _debut, _data, fin, _o = asyncio.run(_lire(_agent(work), paths=["liens"], format="raw",
                                              max_bytes=1 << 20, max_files=1000))
    assert fin["omitted"] == 150 and 0 < len(fin["skipped"]) <= S._OMIS_DETAILLES
    assert len(json.dumps(fin["skipped"])) <= S._OMIS_OCTETS + 1024


def test_en_tete_pax_demesure_refuse(work):
    """Un en-tête pax de plusieurs Mio est refusé AVANT d'être lu."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.PAX_FORMAT) as tf:
        ti = tarfile.TarInfo("f")
        ti.pax_headers = {"comment": "x" * (2 << 20)}
        tf.addfile(ti, io.BytesIO(b""))
    with pytest.raises(AgentError) as e:
        asyncio.run(_agent(work).extract("", buf.getvalue(), max_bytes=1 << 30,
                                         max_file=1 << 30, max_members=10))
    assert e.value.code == "bad_archive"
    assert (work / "a.txt").read_text() == "A"            # /work intact


def test_provisoire_orphelin_retire(work):
    vieux = work / ".elpis-tmp-deadbeefdeadbeef"
    vieux.mkdir()
    (vieux / "x").write_text("x")
    os.utime(vieux, (time.time() - 7200, time.time() - 7200))
    recent = work / ".elpis-tmp-0123456789abcdef"
    recent.mkdir()
    asyncio.run(_agent(work).extract("", _tar([("n.txt", b"N", tarfile.REGTYPE, 0o644)]),
                                     max_bytes=1 << 20, max_file=1 << 20, max_members=10,
                                     leave=".elpis-tmp-*"))
    assert not vieux.exists() and recent.exists()


def test_heure_des_zip_celle_de_l_hote():
    t = 1_700_000_000
    assert S._date_zip(t, [[None, 7200]]) == time.gmtime(t + 7200)[:6]
    assert S._date_zip(t, [[t + 1, 3600], [None, 7200]]) == time.gmtime(t + 3600)[:6]
    assert S._date_zip(1e17) == (2107, 12, 31, 23, 59, 58)            # hors de portée
    assert S._decalages_valides([[None, 3600]]) == [[None, 3600]]
    assert S._decalages_valides([[1, 3600]]) is None                  # dernière borne None
    assert S._decalages_valides([[None, True]]) is None


def test_dossier_remplace_pendant_le_parcours(work):
    """Dossier échangé entre le parcours et son ouverture : omis
    (« changed »), jamais suivi."""
    omis: list = []
    faux = os.stat(work / "a.txt")                        # pas l'inode du dossier
    liste = list(S.Agent(str(work))._sous_arbre(str(work / "d"), "d", faux, False,
                                                 lambda n, c: omis.append((n, c))))
    assert liste == [] and omis == [("d", "changed")]


def test_sortie_close_apres_la_derniere_trame():
    buf = io.BytesIO()
    sortie = S._Sortie(buf)
    sortie.json({"done": True})
    sortie.fermer()
    fin = buf.getvalue()
    sortie.write(b"x" * (2 << 20))                        # finaliseur d'un zip abandonné
    sortie.json({"x": 1})
    assert buf.getvalue() == fin


# ── Client : validation des trames ───────────────────────────────────────────

def _flux(objets, max_files=10, max_bytes=100):
    async def trames():
        for genre, corps in objets:
            yield genre, corps
    f = AC.AgentArchive(trames(), max_files=max_files, max_bytes=max_bytes)

    async def tout():
        return [x async for x in f]
    return asyncio.run(tout())


def test_client_refuse_une_archive_mal_formee():
    e = lambda **k: (b"J", json.dumps({"entry": "a", "kind": "file", "size": 1,  # noqa: E731
                                       "mtime_ns": 0, "mode": 420, **k}).encode())
    fin = (b"J", json.dumps({"done": True, "files": 1}).encode())
    assert _flux([e(), (b"D", b"x"), fin])[0]["entry"] == "a"
    for mauvais in ([e(mtime_ns="hier"), fin], [e(size=-1), fin], [e(kind="lien"), fin],
                    [e(), (b"D", b"xx"), fin], [e(entry="../x"), fin],
                    [e(entry="n" * 5000), fin], [e()] * 11 + [fin]):
        with pytest.raises(AgentError) as x:
            _flux(mauvais)
        assert x.value.code == "bad_response", mauvais


# ── Routes : téléchargements ─────────────────────────────────────────────────

def test_telechargement_d_un_fichier_raccourci_relu(work, monkeypatch):
    """Corps incomplet (fichier raccourci pendant la lecture) : relu, et non
    « sandbox arrêtée » (503)."""
    _sf, c = _client(monkeypatch, work)
    vrai = AC.AgentClient.read
    appels = []

    async def coupe(self, *a, **k):
        appels.append(1)
        if len(appels) == 1:
            raise AgentError("transport", "corps incomplet")
        return await vrai(self, *a, **k)
    monkeypatch.setattr(AC.AgentClient, "read", coupe)
    r = c.get("/api/sandbox/download", params={"path": "a.txt"})
    assert r.status_code == 200 and r.content == b"A" and len(appels) == 2


def test_en_tetes_de_la_version_servie(work, monkeypatch):
    """Servi en flux après un changement : ``X-Size`` décrit les octets
    servis, et non l'état lu avant."""
    sf, c = _client(monkeypatch, work)
    monkeypatch.setattr(sf, "_DOWNLOAD_SHA_MAX", 0)       # toujours en flux
    vrai = sf._stat_un

    async def stat_puis_change(*a, **k):
        e = await vrai(*a, **k)
        (work / "a.txt").write_text("AAAA")
        return e
    monkeypatch.setattr(sf, "_stat_un", stat_puis_change)
    r = c.get("/api/sandbox/download", params={"path": "a.txt"})
    assert r.status_code == 200 and r.content == b"AAAA" and r.headers["x-size"] == "4"


def test_selection_toute_illisible_404(work, monkeypatch):
    if os.geteuid() == 0:
        pytest.skip("root lit tout")
    _sf, c = _client(monkeypatch, work)
    os.chmod(work / "a.txt", 0)
    try:
        r = c.post("/api/sandbox/download-multi", json={"paths": ["a.txt"]})
    finally:
        os.chmod(work / "a.txt", 0o644)
    assert r.status_code == 404


# ── Relecture finale (2026-09-30) ────────────────────────────────────────────

def test_fichier_remplace_pendant_l_archive_garde(work, monkeypatch):
    """Un fichier réécrit (écriture puis renommage) après le parcours reste
    dans l'archive : seul un DOSSIER remplacé est écarté."""
    vrai = S.Agent.entrees_archive

    def puis_remplace(self, a, omettre):
        for x in vrai(self, a, omettre):
            if x[0].endswith("a.txt"):
                tmp = work / "a.tmp"
                tmp.write_text("NOUVEAU")
                os.replace(tmp, work / "a.txt")
            yield x
    monkeypatch.setattr(S.Agent, "entrees_archive", puis_remplace)
    _d, data, fin, _o = asyncio.run(_lire(_agent(work), paths=["a.txt"], max_bytes=1 << 20,
                                          max_files=10))
    z = zipfile.ZipFile(io.BytesIO(data))
    assert z.namelist() == ["a.txt"] and z.read("a.txt") == b"NOUVEAU"


def test_nom_tres_long_jamais_perdu(work, monkeypatch):
    nom = "é" * 120                                       # 240 octets
    (work / nom).write_text("A")
    monkeypatch.setattr(S, "_supprimer_obstine",
                        lambda p: (_ for _ in ()).throw(PermissionError(13, "refusé")))
    vrai = os.rename

    def renommer(src, dst):
        if os.path.basename(src) == nom and ".elpis-tmp-" not in src:
            raise PermissionError(13, "refusé")
        vrai(src, dst)
    monkeypatch.setattr(S.os, "rename", renommer)
    res = asyncio.run(_agent(work).extract("", _tar([(nom, b"N", tarfile.REGTYPE, 0o644)]),
                                           max_bytes=1 << 20, max_file=1 << 20, max_members=10))
    monkeypatch.undo()
    places = [p for p in work.iterdir() if ".elpis-restaure-" in p.name]
    assert len(places) == 1 and places[0].read_text() == "N", res
    assert len(places[0].name.encode()) <= 255


def test_tar_sparse_et_en_tetes_empiles_refuses(work):
    import shutil
    import subprocess
    if not shutil.which("tar"):
        pytest.skip("tar absent")
    d = work.parent / "sp"
    d.mkdir()
    with open(d / "creux", "wb") as f:
        f.truncate(8 << 20)
    subprocess.run(["tar", "-czSf", str(d / "x.tgz"), "-C", str(d), "creux"], check=True)
    with pytest.raises(AgentError) as e:
        asyncio.run(_agent(work).extract("", (d / "x.tgz").read_bytes(), max_bytes=1 << 30,
                                         max_file=1 << 30, max_members=10))
    assert e.value.code == "bad_archive"
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.PAX_FORMAT) as tf:
        for i in range(6):
            ti = tarfile.TarInfo(f"f{i}")
            ti.pax_headers = {"comment": "x" * (900 << 10)}
            tf.addfile(ti, io.BytesIO(b""))
    with pytest.raises(AgentError) as e:
        asyncio.run(_agent(work).extract("", buf.getvalue(), max_bytes=1 << 30,
                                         max_file=1 << 30, max_members=10))
    assert e.value.code == "bad_archive"
