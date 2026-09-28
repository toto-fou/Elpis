# SPDX-License-Identifier: MIT
"""Garde anti-corruption de ``POST /api/sandbox/save`` (2026-09-15).

Avant : un .xlsx/.pdf/.zip ouvert dans l'éditeur tombait dans Monaco via
``res.text()`` et un Ctrl+S (ou l'autosave) réécrivait ce texte par-dessus le
binaire — corruption silencieuse. La route refuse désormais d'écraser un
binaire existant par du TEXTE ; le ``content_b64`` (binaire explicite, vignettes
Studio) reste permis. Cf. ``docs/editor-office-preview-design-2026-09-15.md``.
"""
from __future__ import annotations

import os

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import shared_infra.sandbox.exec_bridge as xb
import shared_infra.sandbox.routes_files as sf
from shared_infra.sandbox.filetypes import existing_file_is_binary, looks_binary


@pytest.fixture()
def env(tmp_path, monkeypatch):
    root = tmp_path / "work"
    root.mkdir()
    writes = []

    async def _write_text(uid, rel, content):
        writes.append(("text", rel, content))
        (root / rel).write_text(content)

    async def _write_bytes(uid, rel, data):
        writes.append(("bytes", rel, data))
        (root / rel).write_bytes(data)

    monkeypatch.setattr(sf, "require_user_id", lambda request: 1)
    monkeypatch.setattr(sf, "_get_work_path", lambda uid: root)
    monkeypatch.setattr(sf, "get_user_settings", lambda uid: {"sandbox_quota_mb": 0})
    monkeypatch.setattr(sf, "get_username_by_id", lambda uid: "alice")
    monkeypatch.setattr(sf, "log_metric", lambda *a, **k: None)
    monkeypatch.setattr(xb, "sandbox_write_text", _write_text)
    monkeypatch.setattr(xb, "sandbox_write_bytes", _write_bytes)

    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app), root, writes


@pytest.mark.parametrize("name,data", [
    ("rapport.pdf", b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj"),
    ("classeur.xlsx", b"PK\x03\x04\x14\x00\x06\x00" + b"\x00" * 40),
    ("donnees.bin", b"abc\x00def"),
    ("vieux.doc", b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 16),
    ("utf16.txt", b"\xff\xfeh\x00i\x00"),
])
def test_texte_sur_binaire_refuse_et_fichier_intact(env, name, data):
    client, root, writes = env
    (root / name).write_bytes(data)
    r = client.post("/api/sandbox/save", json={"path": name, "content": "écrasé"})
    assert r.status_code == 409
    assert r.json()["detail"] == "Fichier binaire : sauvegarde refusée"
    assert (root / name).read_bytes() == data
    assert writes == []


def test_content_b64_sur_binaire_permis(env):
    client, root, writes = env
    (root / "vignette.png").write_bytes(b"\x89PNG\r\n\x1a\nOLD")
    import base64
    new = b"\x89PNG\r\n\x1a\nNEW"
    r = client.post("/api/sandbox/save", json={
        "path": "vignette.png", "content_b64": base64.b64encode(new).decode()})
    assert r.status_code == 200, r.text
    assert (root / "vignette.png").read_bytes() == new


@pytest.mark.parametrize("existing", [None, b"", b"print('ok')\n", "é à ç".encode("latin-1")])
def test_texte_sur_texte_nouveau_ou_vide_permis(env, existing):
    client, root, writes = env
    if existing is not None:
        (root / "script.py").write_bytes(existing)
    r = client.post("/api/sandbox/save", json={"path": "script.py", "content": "x = 1\n"})
    assert r.status_code == 200, r.text
    assert (root / "script.py").read_text() == "x = 1\n"


def test_lien_symbolique_vers_binaire_non_suivi(tmp_path):
    target = tmp_path / "cible.pdf"
    target.write_bytes(b"%PDF-1.4")
    link = tmp_path / "lien.txt"
    os.symlink(target, link)
    assert existing_file_is_binary(target) is True
    assert existing_file_is_binary(link) is False       # O_NOFOLLOW → illisible → False


def test_fifo_ne_bloque_pas(tmp_path):
    fifo = tmp_path / "tube"
    os.mkfifo(fifo)
    assert existing_file_is_binary(fifo) is False


@pytest.mark.parametrize("head,expected", [
    (b"", False),
    (b"hello world\n", False),
    ("données en UTF-8 — ok".encode(), False),
    ("latin-1 é".encode("latin-1"), False),
    (b"\xef\xbb\xbfBOM utf-8", False),
    (b"x" * 9000 + b"\x00", False),   # NUL au-delà de la fenêtre de 8 Ko
    (b"x" * 100 + b"\x00", True),
    (b"%PDF-1.7", True),
    (b"PK\x03\x04", True),
    (b"\x7fELF\x02", True),
    (b"\x1f\x8b\x08", True),
    (b"GIF89a", True),
    (b"\xfe\xff\x00h", True),
])
def test_looks_binary(head, expected):
    assert looks_binary(head) is expected
