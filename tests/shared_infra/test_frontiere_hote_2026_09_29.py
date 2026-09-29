# SPDX-License-Identifier: MIT
"""Frontière hôte ↔ sandbox (2026-09-29) : ce que l'hôte fait dans /work
(lire, parcourir, supprimer, historiser) ne suit jamais un lien, même posé
ENTRE le contrôle du chemin et son usage — course rejouée ici de façon
déterministe en remplaçant un dossier par un lien juste après le contrôle."""
from __future__ import annotations

import os
import socket

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import llm_core.tools.fs_tools as fs_tools
from shared_infra.sandbox import paths
from shared_infra.sandbox.paths import SandboxPathError, open_beneath, pinned_beneath

SECRET = "SECRET-DE-L-HOTE"


class _FakeMCP:
    def __init__(self):
        self.tools = {}

    def tool(self, **kw):
        def deco(fn):
            self.tools[fn.__name__] = fn
            return fn
        return deco


@pytest.fixture()
def fs(tmp_path, monkeypatch):
    base = tmp_path / "sandboxes"
    work = base / "guest" / "work"
    (work / "d").mkdir(parents=True)
    (work / "d" / "secret.txt").write_text("leurre\n")
    monkeypatch.setenv("APP_SANDBOX_DIR", str(base))
    mcp = _FakeMCP()
    fs_tools.register(mcp, base)
    hote = tmp_path / "hote"
    hote.mkdir()
    (hote / "secret.txt").write_text(SECRET + "\n")
    return mcp.tools, work, hote


def _basculer(work, hote):
    """``work/d`` (vrai dossier au contrôle) devient un lien vers l'hôte."""
    for f in (work / "d").iterdir():
        f.unlink()
    (work / "d").rmdir()
    os.symlink(hote, work / "d")


def _course_apres(monkeypatch, module, name, work, hote, *, appel=1):
    """Le contrôle ``module.name`` passe (``appel``-ième appel), puis le
    dossier bascule."""
    vrai = getattr(module, name)
    n = {"appels": 0}

    def controle_puis_bascule(*a, **k):
        r = vrai(*a, **k)
        n["appels"] += 1
        if n["appels"] == appel:
            _basculer(work, hote)
        return r
    monkeypatch.setattr(module, name, controle_puis_bascule)


# ── Primitives ──────────────────────────────────────────────────────────────

def test_primitives_refusent_lien_fifo_socket(tmp_path):
    (tmp_path / "f.txt").write_text("ok")
    os.symlink("/etc", tmp_path / "lien")
    os.mkfifo(tmp_path / "fifo")
    s = socket.socket(socket.AF_UNIX)
    s.bind(str(tmp_path / "sock"))
    try:
        with pinned_beneath(tmp_path, "f.txt") as fp:
            assert fp.read_text() == "ok"
        for bad in ("lien", "lien/hostname", "fifo", "sock"):
            with pytest.raises((SandboxPathError, OSError)):
                os.close(open_beneath(tmp_path, bad))
    finally:
        s.close()


def test_antislash_est_un_caractere_de_nom(tmp_path):
    (tmp_path / "d").mkdir()
    (tmp_path / "d" / "f").write_text("autre")
    (tmp_path / "d\\f").write_text("bon")
    with os.fdopen(open_beneath(tmp_path, "d\\f"), "rb") as f:
        assert f.read() == b"bon"
    paths.remove_beneath(tmp_path, "d\\f")
    assert (tmp_path / "d" / "f").read_text() == "autre"


def test_traverse_sans_droit_de_lecture_et_chmod_sans_ouvrir(tmp_path):
    priv = tmp_path / "priv"
    (priv / "pub").mkdir(parents=True)
    (priv / "pub" / "f").write_text("x")
    (tmp_path / "w").write_text("x")
    os.chmod(tmp_path / "w", 0o200)                 # ni lisible ni exécutable
    os.chmod(priv, 0o311)                           # traversable, pas listable
    try:
        with os.fdopen(open_beneath(tmp_path, "priv/pub/f"), "rb") as f:
            assert f.read() == b"x"
        avant, apres = paths.chmod_beneath(tmp_path, "w", lambda m: m | 0o100)
        assert (avant & 0o777, apres & 0o777) == (0o200, 0o300)
    finally:
        os.chmod(priv, 0o755)
    os.symlink(tmp_path / "w", tmp_path / "lien")
    with pytest.raises(SandboxPathError):
        paths.chmod_beneath(tmp_path, "lien", lambda m: 0o777)
    assert paths.stat_beneath(tmp_path, "lien").st_mode & 0o170000 == 0o120000
    assert os.stat(tmp_path / "w").st_mode & 0o777 == 0o300


def test_elargissement_continue_si_la_racine_est_refusee(tmp_path, monkeypatch):
    (tmp_path / "d").mkdir()
    (tmp_path / "d" / "f").write_text("x")
    os.chmod(tmp_path / "d" / "f", 0o600)
    vrai = paths.os.chmod
    racine = os.stat(tmp_path).st_ino

    def chmod_refuse_la_racine(path, mode, *a, **k):
        if os.stat(path).st_ino == racine:
            raise PermissionError("racine étrangère")
        return vrai(path, mode, *a, **k)
    monkeypatch.setattr(paths.os, "chmod", chmod_refuse_la_racine)
    paths.widen_beneath(tmp_path, "", recursive=True)
    assert os.stat(tmp_path / "d" / "f").st_mode & 0o777 == 0o666


def test_chmod_de_la_racine_et_mode_d_une_entree_disparue(tmp_path):
    os.chmod(tmp_path, 0o755)
    avant, apres = paths.chmod_beneath(tmp_path, "", lambda m: m | 0o002)
    assert (avant & 0o777, apres & 0o777) == (0o755, 0o757)
    dfd = paths.open_dir_beneath(tmp_path)
    try:
        assert paths.leaf_mode(dfd, "absent") == 0
    finally:
        os.close(dfd)


def test_historique_garde_l_antislash(tmp_path):
    from shared_infra.sandbox.file_history import norm_rel
    assert norm_rel("a\\b") == "a\\b" and norm_rel("work/a/b") == "a/b"


def test_releve_des_commandes_ne_bloque_pas_sur_une_fifo(tmp_path):
    import threading
    from llm_core.tools import _work_changes as wc
    os.mkfifo(tmp_path / "fifo")
    (tmp_path / "ok.txt").write_text("ok")
    out = {}
    t = threading.Thread(target=lambda: out.update(fifo=wc._read(tmp_path, "fifo", 100),
                                                   ok=wc._read(tmp_path, "ok.txt", 100)))
    t.start()
    t.join(5)
    assert not t.is_alive() and out == {"fifo": None, "ok": b"ok"}
    scan, complet = wc._scan(tmp_path)
    assert complet and set(scan) == {"ok.txt"}


# ── Outils fichiers ─────────────────────────────────────────────────────────

def test_read_file_ne_suit_pas_un_dossier_remplace(fs, monkeypatch):
    tools, work, hote = fs
    _course_apres(monkeypatch, fs_tools, "_safe_path", work, hote)
    r = tools["read_file"](None, path="d/secret.txt")
    assert SECRET not in str(r)
    assert r.get("ok") is False


def test_grep_ne_suit_pas_un_dossier_remplace_pendant_le_parcours(fs, monkeypatch):
    tools, work, hote = fs
    vrai_fwalk = os.fwalk

    def fwalk_bascule(*a, **k):
        for i, item in enumerate(vrai_fwalk(*a, **k)):
            if i == 0:
                _basculer(work, hote)
            yield item
    monkeypatch.setattr(paths.os, "fwalk", fwalk_bascule)
    r = tools["list_files"](None, path=".", search_text="SECRET")
    assert SECRET not in str(r)


def test_suppression_ne_traverse_pas_un_dossier_remplace(fs, monkeypatch):
    tools, work, hote = fs
    # ``delete`` valide deux fois (chemin, puis refus de la racine) : la
    # bascule suit le DERNIER contrôle.
    _course_apres(monkeypatch, fs_tools, "_safe_path", work, hote, appel=2)
    tools["manage_files"](None, action="delete", path="d/secret.txt")
    assert (hote / "secret.txt").read_text() == SECRET + "\n"


def test_mkdir_sous_un_dossier_non_listable(fs):
    tools, work, _hote = fs
    (work / "priv" / "pub").mkdir(parents=True)
    os.chmod(work / "priv", 0o311)
    try:
        r = tools["manage_files"](None, action="mkdir", path="priv/pub/neuf")
        assert r.get("ok"), r
        assert (work / "priv" / "pub" / "neuf").is_dir()
    finally:
        os.chmod(work / "priv", 0o755)


def test_historique_ne_lit_pas_a_travers_un_lien(tmp_path):
    from shared_infra.sandbox.file_history import read_before
    hote = tmp_path / "hote"
    hote.mkdir()
    (hote / "s.txt").write_text(SECRET)
    work = tmp_path / "work"
    work.mkdir()
    os.symlink(hote, work / "d")
    os.symlink(hote / "s.txt", work / "f.txt")
    assert read_before(work, "d/s.txt") is None
    assert read_before(work, "f.txt") is None


# ── Routes de l'éditeur ─────────────────────────────────────────────────────

def test_telechargement_ne_suit_pas_un_dossier_remplace(fs, monkeypatch):
    import shared_infra.sandbox.routes_files as sf
    _tools, work, hote = fs
    monkeypatch.setattr(sf, "require_user_id", lambda request: 1)
    monkeypatch.setattr(sf, "_get_work_path", lambda uid: work)
    _course_apres(monkeypatch, sf, "_path_inside", work, hote)
    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    r = TestClient(app).get("/api/sandbox/download", params={"path": "d/secret.txt"})
    assert SECRET not in r.text
    assert r.status_code == 404


def test_etat_d_un_fichier_illisible_et_d_un_lien(tmp_path):
    import shared_infra.sandbox.routes_files as sf
    (tmp_path / "f").write_text("x")
    os.chmod(tmp_path / "f", 0o000)
    os.symlink("f", tmp_path / "lien")
    try:
        st = sf._file_state(tmp_path, tmp_path / "f", sha_max=1 << 20)
        assert st["kind"] == "file" and st["readable"] is False and st["size"] == 1
    finally:
        os.chmod(tmp_path / "f", 0o644)
    assert sf._file_state(tmp_path, tmp_path / "lien", sha_max=1 << 20)["kind"] == "other"
    assert sf._file_state(tmp_path, tmp_path / "f" / "x", sha_max=1)["kind"] == "not_dir"
    dfd = paths.open_dir_beneath(tmp_path)
    try:
        assert sf._replace_scan_file(tmp_path, "lien", None, "", dir_fd=dfd) == "lien symbolique"
    finally:
        os.close(dfd)


def _client(monkeypatch, work):
    import shared_infra.sandbox.routes_files as sf
    monkeypatch.setattr(sf, "require_user_id", lambda request: 1)
    monkeypatch.setattr(sf, "_get_work_path", lambda uid: work)
    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    return sf, TestClient(app)


def test_zip_d_un_fichier_date_au_dela_de_2107(fs, monkeypatch):
    _tools, work, _hote = fs
    os.utime(work / "d" / "secret.txt", (7258118400, 7258118400))     # 2200-01-01
    _sf, client = _client(monkeypatch, work)
    r = client.get("/api/sandbox/download", params={"path": "d"})
    assert r.status_code == 200 and r.content[:2] == b"PK"


def test_grep_sur_une_racine_illisible(fs, monkeypatch):
    _tools, work, _hote = fs
    sf, client = _client(monkeypatch, work)

    def illisible(*a, **k):
        raise PermissionError("racine")
        yield                                                   # pragma: no cover
    monkeypatch.setattr(sf, "walk_beneath", illisible)
    assert client.post("/api/sandbox/grep", json={"query": "x"}).status_code == 503


async def test_restauration_interrompue_garde_l_arbre_modifiable(tmp_path, monkeypatch):
    """Client parti pendant l'extraction : l'annulation revient à chaque
    ``await`` du ``finally`` ; l'élargissement doit tourner quand même."""
    import io
    import tarfile

    import anyio

    import shared_infra.sandbox.routes_snapshots as snap
    sandbox = tmp_path / "sandbox"
    sandbox.mkdir()
    archive = tmp_path / "snap.tar.gz"
    with tarfile.open(str(archive), "w:gz") as tf:
        for name in ("a.txt", "b.txt"):
            info = tarfile.TarInfo(name)
            info.size, info.mode = 1, 0o600
            tf.addfile(info, io.BytesIO(b"x"))
    monkeypatch.setattr(snap, "_archive_path", lambda uid, sid: archive)
    monkeypatch.setattr(snap, "_sandbox_root_for", lambda uid: sandbox)

    gen = snap._restore_snapshot_stream(1, "a" * 32)
    with anyio.CancelScope() as scope:
        async for line in gen:
            if '"progress"' in line:
                scope.cancel()                   # comme Starlette à la déconnexion
    for _ in range(100):
        if os.stat(sandbox / "a.txt").st_mode & 0o777 == 0o666:
            break
        await anyio.sleep(0.05)
    assert os.stat(sandbox / "a.txt").st_mode & 0o777 == 0o666
