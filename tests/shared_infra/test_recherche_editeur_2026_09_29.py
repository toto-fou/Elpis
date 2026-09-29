# SPDX-License-Identifier: MIT
"""GET /api/sandbox/search par l'agent de la sandbox (L4.3) : noms et
contenu, liens jamais suivis, dossiers cachés et de dépendances non lus en
mode contenu, bornes signalées."""
from __future__ import annotations

import os

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import shared_infra.sandbox.routes_files as sf
from tests.conftest import editeur_sur_agent


@pytest.fixture()
def env(tmp_path, monkeypatch):
    root = tmp_path / "w"
    (root / "src").mkdir(parents=True)
    (root / ".cache").mkdir()
    (root / "node_modules" / "x").mkdir(parents=True)
    (root / "src" / "main.py").write_text("print('Bonjour')\n" + "x = 1\n" * 3 + ("y" * 300) + "bonjour\n")
    (root / ".env").write_text("CLE=bonjour\n")
    (root / ".cache" / "c.txt").write_text("bonjour caché\n")
    (root / "node_modules" / "x" / "i.js").write_text("bonjour\n")
    (root / "image.png").write_bytes(b"bonjour")
    (root / "donnees.dat").write_bytes(b"\x00bonjour")
    dehors = tmp_path / "dehors"
    dehors.mkdir()
    (dehors / "bonjour.txt").write_text("bonjour dehors\n")
    os.symlink(dehors, root / "lien")
    editeur_sur_agent(monkeypatch, root)
    monkeypatch.setattr(sf, "require_user_id", lambda r: 1)
    monkeypatch.setattr(sf, "_get_work_path", lambda uid: root)
    app = FastAPI()
    app.include_router(sf.router)
    return TestClient(app), root


def test_recherche_par_nom(env):
    client, root = env
    (root / "src" / "Bonjour.md").write_text("x")
    r = client.get("/api/sandbox/search", params={"q": "bonjour", "mode": "name"})
    assert r.status_code == 200, r.text
    assert [i["path"] for i in r.json()["items"]] == ["src/Bonjour.md"]   # le lien : ni listé ni suivi


def test_recherche_dans_le_contenu(env):
    client, root = env
    r = client.get("/api/sandbox/search", params={"q": "bonjour"})
    assert r.status_code == 200, r.text
    d = r.json()
    trouves = {(i["path"], i["line"]) for i in d["items"]}
    assert trouves == {("src/main.py", 1), ("src/main.py", 5), (".env", 1)}, d
    long = next(i for i in d["items"] if i["line"] == 5)
    assert long["col"] == 301 and long["preview"].endswith("bonjour…")
    assert d["truncated"] is False


def test_recherche_bornee(env, monkeypatch):
    client, root = env
    for i in range(250):
        (root / "src" / f"f{i:03d}.txt").write_text("bonjour\n")
    d = client.get("/api/sandbox/search", params={"q": "bonjour"}).json()
    assert len(d["items"]) == 200 and d["truncated"] is True
