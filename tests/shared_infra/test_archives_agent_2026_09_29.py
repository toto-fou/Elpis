# SPDX-License-Identifier: MIT
"""Archives par l'agent de la sandbox (L4.5) : téléchargements, export et
import, snapshots, sauvegardes. L'hôte ne lit ni n'écrit /work : l'agent
produit l'archive (zip, tar.gz ou brute) ou l'extrait, dans le conteneur."""
from __future__ import annotations

import asyncio
import io
import json
import os
import socket
import tarfile
import zipfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from shared_infra.sandbox import agent_client as AC
from shared_infra.sandbox.agent import server as S
from shared_infra.sandbox.agent_client import AgentError
from tests.conftest import editeur_sur_agent, sandboxes_sur_agent


@pytest.fixture()
def work(tmp_path):
    w = tmp_path / "u" / "work"
    (w / "d" / "vide").mkdir(parents=True)
    (w / "a.txt").write_text("A")
    (w / "d" / "b.sh").write_text("#!/bin/sh\n")
    os.chmod(w / "d" / "b.sh", 0o755)
    (tmp_path / "dehors.txt").write_text("HORS")
    os.symlink(tmp_path / "dehors.txt", w / "d" / "lien")
    os.mkfifo(w / "d" / "fifo")
    return w


def _agent(work):
    from shared_infra.sandbox.executors import get_user_sandbox
    return get_user_sandbox(1, "u", work).agent


async def _lire(agent, **kw):
    """(début, octets, fin, objets) d'une archive de l'agent."""
    data, objets = bytearray(), []
    async with agent.archive(**kw) as flux:
        async for x in flux:
            if isinstance(x, bytes):
                data += x
            else:
                objets.append(x)
        return flux.debut, bytes(data), flux.fin, objets


def _tar(membres, gz=True):
    """Archive de ``(nom, contenu | None, type, mode)`` ; ``None`` : sans données."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz" if gz else "w") as tf:
        for nom, data, genre, mode in membres:
            ti = tarfile.TarInfo(nom)
            ti.type, ti.mode, ti.mtime = genre, mode, 1_000_000_000
            if genre == tarfile.SYMTYPE:
                ti.linkname = "/etc"
            ti.size = len(data or b"")
            tf.addfile(ti, io.BytesIO(data) if data else None)
    return buf.getvalue()


def _noms(work):
    return sorted(str(p.relative_to(work)) for p in work.rglob("*"))


# ── Agent : archives ────────────────────────────────────────────────────────

def test_zip_omet_liens_et_fichiers_speciaux(work):
    debut, data, fin, _ = asyncio.run(_lire(_agent(work), paths=["d"], base="d", prefix="d",
                                            max_bytes=1 << 20, max_files=100))
    assert zipfile.ZipFile(io.BytesIO(data)).namelist() == ["d/b.sh"]
    assert sorted((s["path"], s["error"]) for s in fin["skipped"]) == [("fifo", "special"),
                                                                         ("lien", "link")]
    assert debut["files"] == fin["files"] == 1 and b"HORS" not in data


def test_archive_stricte_refusee_avant_tout_octet(work):
    with pytest.raises(AgentError) as e:
        asyncio.run(_lire(_agent(work), max_bytes=1, max_files=100))
    assert e.value.code == "too_large" and e.value.status == 413
    with pytest.raises(AgentError) as e:
        asyncio.run(_lire(_agent(work), max_bytes=1 << 20, max_files=1, dirs=True))
    assert e.value.code == "too_large"


def test_archive_non_stricte_s_arrete_aux_bornes(work):
    debut, data, fin, _ = asyncio.run(_lire(
        _agent(work), paths=["a.txt", "d/b.sh", "d"], walk=False, strict=False,
        max_bytes=5, max_files=10))
    assert zipfile.ZipFile(io.BytesIO(data)).namelist() == ["a.txt"]
    assert debut["truncated"] and fin["truncated"] and debut["files"] == 1


def test_tgz_garde_dossiers_vides_et_bits_d_execution(work):
    _d, data, fin, _ = asyncio.run(_lire(_agent(work), format="tgz", dirs=True,
                                         max_bytes=1 << 20, max_files=100))
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tf:
        membres = {m.name: m for m in tf.getmembers()}
    assert sorted(membres) == ["a.txt", "d", "d/b.sh", "d/vide"]
    assert membres["d/vide"].isdir() and membres["d/b.sh"].mode & 0o111
    assert (fin["files"], fin["dirs"]) == (2, 2)


def test_archive_brute_entree_puis_octets(work):
    _d, data, _fin, objets = asyncio.run(_lire(_agent(work), format="raw",
                                               max_bytes=1 << 20, max_files=100))
    entrees = [o for o in objets if "entry" in o]
    assert [(e["entry"], e["kind"], e["size"]) for e in entrees] == [("a.txt", "file", 1),
                                                                      ("d/b.sh", "file", 10)]
    assert data == b"A#!/bin/sh\n"


def test_fichier_raccourci_pendant_l_archive(tmp_path):
    """L'en-tête tar annonce la taille lue à l'ouverture : un fichier raccourci
    ensuite est complété par des octets nuls, et signalé."""
    (tmp_path / "f").write_bytes(b"abc")
    fd = os.open(tmp_path / "f", os.O_RDONLY)
    try:
        src = S._Exact(fd, 10)
        assert src.read(10) == b"abc" + bytes(7) and src.complete is False
    finally:
        os.close(fd)


# ── Agent : extraction ──────────────────────────────────────────────────────

def test_extraction_remplace_et_garde_l_ancien_contenu(work):
    (work / ".work-before-import-1").mkdir()
    archive = _tar([("x/y.txt", b"Y", tarfile.REGTYPE, 0o600),
                    ("x/run", b"#!", tarfile.REGTYPE, 0o700),
                    ("../evil", b"E", tarfile.REGTYPE, 0o644),
                    ("/abs", b"B", tarfile.REGTYPE, 0o644),
                    ("lk", None, tarfile.SYMTYPE, 0o777),
                    ("dev", None, tarfile.CHRTYPE, 0o644)])
    res = asyncio.run(_agent(work).extract(
        "", archive, keep=".work-before-import-2", leave=".work-before-import-*",
        max_bytes=1 << 20, max_file=1 << 20, max_members=100))
    assert (res["files"], res["omitted"], res["conflicts"]) == (2, 4, 0)
    assert sorted(p.name for p in work.iterdir()) == [".work-before-import-1",
                                                      ".work-before-import-2", "x"]
    assert (work / ".work-before-import-2" / "a.txt").read_text() == "A"
    assert os.stat(work / "x" / "y.txt").st_mode & 0o777 == 0o666     # jusqu'à L4.6
    assert os.stat(work / "x" / "run").st_mode & 0o777 == 0o777
    assert os.stat(work / "x" / "y.txt").st_mtime == 1_000_000_000
    assert not (work.parent / "evil").exists()


@pytest.mark.parametrize("corps,bornes,code", [
    (b"pas une archive", {}, "bad_archive"),
    (_tar([("f", b"x" * 100, tarfile.REGTYPE, 0o644)]), {"max_file": 10}, "too_large"),
    (_tar([("f", b"x" * 60, tarfile.REGTYPE, 0o644), ("g", b"y" * 60, tarfile.REGTYPE, 0o644)]),
     {"max_bytes": 100}, "too_large"),
    (_tar([(f"f{i}", b"x", tarfile.REGTYPE, 0o644) for i in range(5)]), {"max_members": 3},
     "too_large"),
])
def test_extraction_refusee_sans_toucher_au_contenu(work, corps, bornes, code):
    avant = _noms(work)
    a = {"max_bytes": 1 << 20, "max_file": 1 << 20, "max_members": 100, **bornes}
    with pytest.raises(AgentError) as e:
        asyncio.run(_agent(work).extract("", corps, **a))
    assert e.value.code == code and e.value.status in (400, 413)
    assert _noms(work) == avant                          # ni vidé, ni provisoire laissé


def test_extraction_refusee_repond_apres_un_gros_corps(work):
    """Refus en cours de route : l'agent lit le corps jusqu'au bout, l'hôte
    reçoit le refus et non une connexion coupée."""
    corps = b"\x1f\x8b" + os.urandom(6 << 20)            # gzip illisible, 6 Mio
    with pytest.raises(AgentError) as e:
        asyncio.run(_agent(work).extract("", corps, max_bytes=1 << 30, max_file=1 << 30,
                                         max_members=100))
    assert e.value.code == "bad_archive"


def test_remplacement_retablit_les_droits_d_une_entree_verrouillee(work):
    """(Relecture L4.5) Dossier en lecture seule (cache Go en 0555) : ses
    droits sont rétablis puis il est supprimé, sans conflit."""
    if os.geteuid() == 0:
        pytest.skip("root supprime tout")
    (work / "ro").mkdir()
    (work / "ro" / "f").write_text("x")
    os.chmod(work / "ro", 0o555)
    try:
        res = asyncio.run(_agent(work).extract(
            "", _tar([("n.txt", b"N", tarfile.REGTYPE, 0o644)]), max_bytes=1 << 20,
            max_file=1 << 20, max_members=100))
    finally:
        if (work / "ro").exists():
            os.chmod(work / "ro", 0o755)
    assert res["conflicts"] == 0 and (work / "n.txt").read_text() == "N"
    assert not (work / "ro").exists() and not (work / "a.txt").exists()


def test_remplacement_ne_perd_jamais_la_nouvelle_entree(work, monkeypatch):
    """(Relecture L4.5) Une ancienne entrée impossible à effacer gardait son
    nom : la nouvelle entrée du même nom repartait avec le provisoire,
    perdue, et la restauration se disait réussie. L'ancienne est mise de
    côté ; si elle ne peut même pas être déplacée, la nouvelle est placée
    sous un autre nom. Les deux cas sont remontés."""
    (work / "ro").mkdir()
    (work / "ro" / "ancien").write_text("A")
    (work / "fixe").write_text("F")
    vrai_supprimer, vrai_renommer = S._supprimer_obstine, os.rename

    def supprimer(p):
        if os.path.basename(p) in ("ro", "fixe"):
            raise PermissionError(13, "refusé")
        vrai_supprimer(p)

    def renommer(src, dst):
        if os.path.basename(src) == "fixe" and ".elpis-tmp-" not in src:
            raise PermissionError(13, "refusé")
        vrai_renommer(src, dst)
    monkeypatch.setattr(S, "_supprimer_obstine", supprimer)
    monkeypatch.setattr(S.os, "rename", renommer)
    res = asyncio.run(_agent(work).extract(
        "", _tar([("ro/neuf", b"N", tarfile.REGTYPE, 0o644), ("fixe", b"G", tarfile.REGTYPE, 0o644)]),
        max_bytes=1 << 20, max_file=1 << 20, max_members=100))
    monkeypatch.undo()
    # « ro » mis de côté ; « fixe » ni effacé ni déplacé, et son remplaçant
    # placé sous un autre nom : trois écarts.
    assert res["conflicts"] == 3, res
    assert (work / "ro" / "neuf").read_text() == "N"               # placé
    (ancien,) = [p for p in work.iterdir() if p.name.startswith("ro.elpis-ancien-")]
    assert (ancien / "ancien").read_text() == "A"                  # mis de côté
    assert (work / "fixe").read_text() == "F"                      # indéplaçable
    (neuf,) = [p for p in work.iterdir() if p.name.startswith("fixe.elpis-restaure-")]
    assert neuf.read_text() == "G"                                  # jamais perdu
    assert sorted(x.split(" → ")[0] for x in res["conflict_paths"]) == ["fixe", "fixe", "ro"]
    assert not [p for p in work.iterdir() if p.name.startswith(".elpis-tmp-")]


# ── Client : trames ─────────────────────────────────────────────────────────

class _Rep:
    def __init__(self, *morceaux):
        self._m = morceaux

    async def aiter_raw(self):
        for m in self._m:
            yield m


def _trame(genre, corps):
    return genre + len(corps).to_bytes(4, "big") + corps


async def _trames(r, maxi=1 << 20):
    return [t async for t in AC._trames(r, maxi)]


@pytest.mark.parametrize("flux,code", [
    ([b"X\x00\x00\x00\x01a"], "bad_response"),                          # genre inconnu
    ([b"J" + (AC._TRAME_J + 1).to_bytes(4, "big")], "bad_response"),     # objet trop long
    ([_trame(b"D", b"x" * 10)] * 3, "too_large"),                        # au-delà de maxi
    ([_trame(b"D", b"abc")[:5]], "bad_response"),                        # tronquée
])
def test_trames_bornees(flux, code):
    with pytest.raises(AgentError) as e:
        asyncio.run(_trames(_Rep(*flux), maxi=25))
    assert e.value.code == code


def test_trames_decoupees_n_importe_ou():
    brut = _trame(b"J", b'{"start":true}') + _trame(b"D", b"abc") + _trame(b"J", b'{"done":true}')
    morceaux = [brut[i:i + 3] for i in range(0, len(brut), 3)]
    assert asyncio.run(_trames(_Rep(*morceaux))) == [
        (b"J", b'{"start":true}'), (b"D", b"abc"), (b"J", b'{"done":true}')]


@pytest.mark.parametrize("trames,code", [
    ([_trame(b"D", b"x")], "bad_response"),                                        # sans début
    ([_trame(b"J", b'{"start":true}'), _trame(b"J", b'{"error":"io_error"}')], "io_error"),
    ([_trame(b"J", b'{"start":true}'), _trame(b"D", b"x")], "bad_response"),       # sans fin
    ([_trame(b"J", b'{"start":true}'), _trame(b"J", b'{"entry":"../x"}')], "bad_response"),
])
def test_archive_mal_formee(trames, code):
    async def lire():
        flux = AC.AgentArchive(AC._trames(_Rep(*trames), 1 << 20))
        await flux._ouvrir()
        return [x async for x in flux]
    with pytest.raises(AgentError) as e:
        asyncio.run(lire())
    assert e.value.code == code


# ── Routes ──────────────────────────────────────────────────────────────────

def _client(monkeypatch, work):
    import shared_infra.sandbox.routes_files as sf
    editeur_sur_agent(monkeypatch, work)
    monkeypatch.setattr(sf, "require_user_id", lambda request: 1)
    monkeypatch.setattr(sf, "_get_work_path", lambda uid: work)
    app = FastAPI()
    app.include_router(sf.router)
    return sf, TestClient(app)


def test_telechargement_d_un_dossier_et_de_la_racine(work, monkeypatch):
    _sf, c = _client(monkeypatch, work)
    r = c.get("/api/sandbox/download", params={"path": "d"})
    assert r.status_code == 200 and 'filename="d.zip"' in r.headers["content-disposition"]
    assert zipfile.ZipFile(io.BytesIO(r.content)).namelist() == ["d/b.sh"]
    r = c.get("/api/sandbox/download", params={"path": "/work"})
    assert zipfile.ZipFile(io.BytesIO(r.content)).namelist() == ["work/a.txt", "work/d/b.sh"]


def test_dossier_trop_volumineux_413(work, monkeypatch):
    sf, c = _client(monkeypatch, work)
    monkeypatch.setattr(sf, "_ZIP_DIR_MAX_BYTES", 1)
    r = c.get("/api/sandbox/download", params={"path": "d"})
    assert r.status_code == 413 and "trop volumineux" in r.json()["detail"]


def test_telechargement_de_plusieurs_fichiers(work, monkeypatch):
    _sf, c = _client(monkeypatch, work)
    r = c.post("/api/sandbox/download-multi",
               json={"paths": ["a.txt", "d", "../x", "d/b.sh", "absent", "d/lien"]})
    assert r.status_code == 200 and r.headers["x-files-zipped"] == "2"
    assert zipfile.ZipFile(io.BytesIO(r.content)).namelist() == ["a.txt", "d/b.sh"]
    assert c.post("/api/sandbox/download-multi", json={"paths": ["d"]}).status_code == 404


def test_fichier_reecrit_a_chaque_lecture_servi_en_flux(work, monkeypatch):
    """Réécrit en place entre la lecture et le contrôle, à chaque essai : pas
    d'empreinte annoncée pour des octets qui ne sont plus ceux du disque ; le
    fichier est servi en flux, dans son état du moment."""
    _sf, c = _client(monkeypatch, work)
    vrai = S.Agent.stat_lot
    appels = []

    def reecrit_puis_stat(self, chemins, *a):
        appels.append(1)
        if 2 <= len(appels) <= 4:                    # les trois contrôles après lecture
            with open(work / "a.txt", "a") as f:
                f.write("+")
        return vrai(self, chemins, *a)
    monkeypatch.setattr(S.Agent, "stat_lot", reecrit_puis_stat)
    r = c.get("/api/sandbox/download", params={"path": "a.txt"})
    assert r.status_code == 200 and "x-sha256" not in r.headers
    assert r.content == b"A+++" and r.headers["x-size"] == "4"


def test_export_puis_import_avec_instantane_prealable(work, monkeypatch, tmp_path):
    """(Décision du 2026-09-30) L'import prend un instantané de /work, hors de
    /work, puis le remplace sans y garder de copie ; instantané impossible :
    import refusé, /work intact."""
    import shared_infra.sandbox.routes_snapshots as snap
    depot = tmp_path / "snaps"
    depot.mkdir()
    monkeypatch.setattr(snap, "_user_snap_dir", lambda uid: depot)
    sf, c = _client(monkeypatch, work)
    r = c.get("/api/sandbox/export")
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/gzip")
    with tarfile.open(fileobj=io.BytesIO(r.content), mode="r:gz") as tf:
        assert sorted(tf.getnames()) == ["a.txt", "d/b.sh"]
    (work / "local.txt").write_text("L")
    r2 = c.post("/api/sandbox/import", files={"archive": ("w.tgz", r.content, "application/gzip")})
    assert r2.status_code == 200 and r2.json()["files"] == 2, r2.text
    assert r2.json()["snapshot"]["name"].startswith("Avant import du ")
    assert not (work / "local.txt").exists()                        # remplacé, sans copie
    assert not [p for p in work.iterdir() if p.name.startswith(".work-before-import-")]
    assert (work / "d" / "b.sh").read_text() == "#!/bin/sh\n"
    (meta,) = [json.loads(p.read_text()) for p in depot.glob("*.json")]
    with tarfile.open(depot / f"{meta['id']}.tar.gz") as tf:
        assert "local.txt" in tf.getnames()                         # l'ancien contenu
    monkeypatch.setattr(snap, "_MAX_TOTAL_BYTES", 1)                 # instantané impossible
    (work / "local.txt").write_text("L")
    r3 = c.post("/api/sandbox/import", files={"archive": ("w.tgz", r.content, "application/gzip")})
    assert r3.status_code == 409 and "/work inchangé" in r3.json()["detail"], r3.text
    assert (work / "local.txt").read_text() == "L"


def test_import_borne_ou_invalide_laisse_work_intact(work, monkeypatch):
    sf, c = _client(monkeypatch, work)
    avant = _noms(work)
    monkeypatch.setattr(sf, "_user_quota_bytes", lambda uid: 10)
    bombe = _tar([("f", b"0" * 1000, tarfile.REGTYPE, 0o644)])
    assert c.post("/api/sandbox/import", files={"archive": ("b.tgz", bombe)}).status_code == 413
    assert c.post("/api/sandbox/import", files={"archive": ("b.tgz", b"rien")}).status_code == 400
    assert _noms(work) == avant


def test_compte_arrete_demarre_pour_l_export(work, monkeypatch):
    """Conteneur arrêté : l'opération le démarre, par le chemin habituel."""
    import shared_infra.sandbox.routes_files as sf
    from shared_infra.sandbox.executors import _user_sandbox as us
    editeur_sur_agent(monkeypatch, work)
    appels = []
    vrai = us.UserSandbox.ensure_running

    async def compte(self):
        appels.append(self.container_name)
        return await vrai(self)
    monkeypatch.setattr(us.UserSandbox, "ensure_running", compte)
    data = asyncio.run(sf.exporter_work(1))
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tf:
        assert sorted(tf.getnames()) == ["a.txt", "d/b.sh"]
    assert len(appels) == 1


# ── Snapshots ───────────────────────────────────────────────────────────────

async def _evenements(gen):
    return [json.loads(ligne) async for ligne in gen]


async def test_snapshot_aller_retour(work, monkeypatch, tmp_path):
    import shared_infra.sandbox.routes_snapshots as snap
    editeur_sur_agent(monkeypatch, work)
    depot = tmp_path / "snaps"
    depot.mkdir()
    monkeypatch.setattr(snap, "_user_snap_dir", lambda uid: depot)
    evts = await _evenements(snap._create_snapshot_stream(1, "avant"))
    fin = evts[-1]
    assert fin["event"] == "done", evts
    assert evts[1]["event"] == "start" and evts[1]["total_files"] == 2
    meta = fin["snapshot"]
    assert (meta["file_count"], meta["src_bytes"]) == (2, 11)
    (work / "a.txt").write_text("modifié")
    (work / "nouveau.txt").write_text("n")
    evts = await _evenements(snap._restore_snapshot_stream(1, meta["id"]))
    assert evts[-1]["event"] == "done" and evts[-1]["files_restored"] == 2, evts
    assert (work / "a.txt").read_text() == "A" and not (work / "nouveau.txt").exists()
    assert (work / "d" / "vide").is_dir() and os.stat(work / "d" / "b.sh").st_mode & 0o111
    assert not (depot / snap._RESTORE_MARKER_NAME).exists()


async def test_snapshot_trop_volumineuse_refusee(work, monkeypatch, tmp_path):
    import shared_infra.sandbox.routes_snapshots as snap
    editeur_sur_agent(monkeypatch, work)
    monkeypatch.setattr(snap, "_user_snap_dir", lambda uid: tmp_path)
    monkeypatch.setattr(snap, "_MAX_TOTAL_BYTES", 5)
    evts = await _evenements(snap._create_snapshot_stream(1, ""))
    assert evts[-1]["event"] == "error" and "trop volumineuse" in evts[-1]["message"]
    assert not list(tmp_path.glob("*.tar.gz*"))                      # rien laissé


# ── Sauvegarde admin ────────────────────────────────────────────────────────

def test_sauvegarde_puis_restauration_des_sandboxes(tmp_path, monkeypatch):
    from shared_infra import config
    from shared_infra.routes import _helpers as H
    from shared_infra.routes.admin.lifecycle import _restore_from_zip
    sb = tmp_path / "sb"
    for nom in ("alice", "bob"):
        (sb / nom / "work" / "src").mkdir(parents=True)
        (sb / nom / "work" / "src" / f"{nom}.py").write_text(nom)
    (sb / "alice" / "skills").mkdir()
    (sb / "alice" / "skills" / "s.md").write_text("skill")
    (sb / ".elpis-relay").mkdir()                        # sockets du relais Git (L4.4)
    relais = socket.socket(socket.AF_UNIX)
    relais.bind(str(sb / ".elpis-relay" / "1.sock"))
    monkeypatch.setattr(config, "SANDBOX_DIR", sb)
    sandboxes_sur_agent(monkeypatch, sb, ["alice", "bob"])
    archive, _nom = H._make_backup_zip("sandboxes")
    try:
        with zipfile.ZipFile(archive) as z:
            # Ni socket de l'agent, ni relais : ni sauvegardés, ni signalés.
            assert sorted(z.namelist()) == ["sandboxes/alice/skills/s.md",
                                            "sandboxes/alice/work/src/alice.py",
                                            "sandboxes/bob/work/src/bob.py"]
        for nom in ("alice", "bob"):
            (sb / nom / "work" / "src" / f"{nom}.py").unlink()
        restaures, erreurs, _base = _restore_from_zip(
            archive, "sandboxes", db_path=tmp_path / "absente.db", user_db_dir=tmp_path / "udb",
            sandbox_dir=sb, mcp_dir=tmp_path / "mcp")
    finally:
        os.unlink(archive)
        relais.close()
    assert erreurs == [] and len(restaures) == 3
    assert (sb / "bob" / "work" / "src" / "bob.py").read_text() == "bob"
    assert (sb / "alice" / "work" / "src" / "alice.py").read_text() == "alice"
