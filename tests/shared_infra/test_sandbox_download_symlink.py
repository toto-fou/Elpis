# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_sandbox_download_symlink.py

Le téléchargement d'un DOSSIER zippe son contenu via ``os.walk``. Comme les
traversées sœurs (/search, /grep, taille), il doit SAUTER les symlinks : sans
ça un user peut planter ``ln -s /etc/passwd leak`` (ou pointer vers la base
SQLite / le sandbox d'un autre user) et exfiltrer des fichiers hôte via le zip,
puisque le backend lit en UID hôte. Régression du fix sandbox_files.py:250.
"""
from __future__ import annotations

import io
import os
import zipfile

import pytest


@pytest.fixture()
def box(tmp_path):
    """tmp_path/box = sandbox ; tmp_path/secret.txt = fichier hôte HORS sandbox."""
    (tmp_path / "secret.txt").write_text("TOP-SECRET-HOST-CONTENT")
    root = tmp_path / "box"
    folder = root / "f"
    folder.mkdir(parents=True)
    (folder / "ok.txt").write_text("legit-content")
    # symlink vers l'extérieur du sandbox (le vecteur d'exfiltration)
    os.symlink(tmp_path / "secret.txt", folder / "leak")
    # symlink vers un dossier extérieur (ne doit pas être suivi non plus)
    outside_dir = tmp_path / "outside"
    outside_dir.mkdir()
    (outside_dir / "x.txt").write_text("SECRET-DIR-CONTENT")
    os.symlink(outside_dir, folder / "linkdir")
    return root


def _client(monkeypatch, root):
    import shared_infra.sandbox.routes_files as sf
    monkeypatch.setattr(sf, "require_user_id", lambda r: 1)
    monkeypatch.setattr(sf, "_get_work_path", lambda uid: root)
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    app = FastAPI(); app.include_router(sf.router)
    return TestClient(app)


def test_folder_download_excludes_symlinks(box, monkeypatch):
    c = _client(monkeypatch, box)
    resp = c.get("/api/sandbox/download", params={"path": "f"})
    assert resp.status_code == 200
    zf = zipfile.ZipFile(io.BytesIO(resp.content))
    names = zf.namelist()

    # le fichier régulier est bien présent…
    assert "f/ok.txt" in names
    assert zf.read("f/ok.txt") == b"legit-content"

    # …mais AUCUN symlink (fichier ou dossier) n'est suivi
    assert "f/leak" not in names
    assert not any(n.startswith("f/linkdir") for n in names)

    # défense en profondeur : le contenu des cibles hors-sandbox n'apparaît
    # nulle part dans l'archive
    blob = resp.content
    assert b"TOP-SECRET-HOST-CONTENT" not in blob
    assert b"SECRET-DIR-CONTENT" not in blob


def test_single_file_download_still_works(box, monkeypatch):
    """Non-régression : télécharger un fichier régulier reste OK."""
    c = _client(monkeypatch, box)
    resp = c.get("/api/sandbox/download", params={"path": "f/ok.txt"})
    assert resp.status_code == 200
    assert resp.content == b"legit-content"


def test_single_file_download_rejects_symlink_escape(box, monkeypatch):
    """Le download fichier unique refusait déjà l'échappement (resolve + _path_inside)."""
    c = _client(monkeypatch, box)
    resp = c.get("/api/sandbox/download", params={"path": "f/leak"})
    assert resp.status_code == 403
