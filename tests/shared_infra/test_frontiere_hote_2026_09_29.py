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
