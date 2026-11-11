# SPDX-License-Identifier: MIT
"""tests/desktop_agent/test_agent_garde.py — garde de l'agent de bureau : jeton Bearer obligatoire, Origin refusé, JSON obligatoire, /health ouvert, démarrage sans jeton."""
from __future__ import annotations

import importlib.util
import os
import sys

import pytest
from fastapi.testclient import TestClient

_AGENT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "desktop-agent"))
JETON = os.environ["DESKTOP_AGENT_TOKEN"]
BON = {"Authorization": f"Bearer {JETON}"}


class _Faux:
    name = "faux"

    def health(self):
        return {"ok": True}

    def cursor_pos(self):
        return [0, 0]


def _charger(nom: str):
    spec = importlib.util.spec_from_file_location(nom, os.path.join(_AGENT, "server.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def srv(monkeypatch):
    sauve_chemin, sauve_mods = list(sys.path), set(sys.modules)
    sys.path.insert(0, _AGENT)
    try:
        mod = _charger("agent_garde_test")
        monkeypatch.setattr(mod, "backend", _Faux())
        yield mod
    finally:
        sys.path[:] = sauve_chemin
        for n in list(sys.modules):
            if n not in sauve_mods and n.split(".")[0] in ("backends", "normalize", "agent_garde_test"):
                sys.modules.pop(n, None)


@pytest.fixture
def client(srv):
    return TestClient(srv.app)


def test_health_reste_ouvert_sans_jeton(client):
    assert client.get("/health").status_code == 200


@pytest.mark.parametrize("entetes", [{}, {"Authorization": "Bearer faux"}, {"Authorization": "Basic " + JETON},
                                     {"Authorization": JETON}])
def test_sans_jeton_valide_refus_401(client, entetes):
    r = client.post("/click", json={"x": 1, "y": 1}, headers=entetes)
    assert r.status_code == 401 and r.headers["www-authenticate"] == "Bearer"
    assert client.get("/list_files", headers=entetes).status_code == 401


def test_jeton_valide_laisse_passer_la_garde(client):
    assert client.get("/list_files", params={"path": ""}, headers=BON).status_code != 401


def test_origin_refuse_meme_avec_le_bon_jeton(client):
    r = client.post("/click", json={}, headers={**BON, "Origin": "http://evil.example"})
    assert r.status_code == 403
    assert client.get("/list_files", headers={**BON, "Origin": "null"}).status_code == 403


def test_corps_non_json_refuse_415(client):
    r = client.post("/click", content=b"x=1", headers={**BON, "Content-Type": "application/x-www-form-urlencoded"})
    assert r.status_code == 415
    assert client.post("/click", content=b"{}", headers=BON).status_code == 415


@pytest.mark.parametrize("corps", [b"{pas du json", b"[1, 2]", b'"texte"'])
def test_json_invalide_ou_non_objet_refuse_400(client, corps):
    r = client.post("/click", content=corps, headers={**BON, "Content-Type": "application/json"})
    assert r.status_code == 400


def test_websocket_refuse(client):
    from starlette.websockets import WebSocketDisconnect
    with pytest.raises(WebSocketDisconnect) as e, client.websocket_connect("/ws", headers=BON):
        pass
    assert e.value.code == 1008


def test_demarrage_sans_jeton_en_generant_un_fichier(tmp_path, monkeypatch):
    monkeypatch.delenv("DESKTOP_AGENT_TOKEN")
    monkeypatch.delenv("DESKTOP_AGENT_INSECURE", raising=False)
    sauve_chemin, sauve_mods = list(sys.path), set(sys.modules)
    sys.path.insert(0, _AGENT)
    try:
        spec = importlib.util.spec_from_file_location("agent_garde_gen", os.path.join(_AGENT, "server.py"))
        mod = importlib.util.module_from_spec(spec)
        import pathlib
        monkeypatch.setattr(pathlib.Path, "read_text", lambda self, *a, **k: (_ for _ in ()).throw(OSError()))
        monkeypatch.setattr(os, "open", lambda *a, **k: (_ for _ in ()).throw(OSError("lecture seule")))
        with pytest.raises(SystemExit, match="aucun jeton configuré"):
            spec.loader.exec_module(mod)
    finally:
        sys.path[:] = sauve_chemin
        for n in list(sys.modules):
            if n not in sauve_mods and n.split(".")[0] in ("backends", "normalize", "agent_garde_gen"):
                sys.modules.pop(n, None)


def test_mode_non_securise_explicite_demarre_sans_jeton(monkeypatch):
    monkeypatch.delenv("DESKTOP_AGENT_TOKEN")
    monkeypatch.setenv("DESKTOP_AGENT_INSECURE", "1")
    sauve_chemin, sauve_mods = list(sys.path), set(sys.modules)
    sys.path.insert(0, _AGENT)
    try:
        mod = _charger("agent_garde_insecure")
        monkeypatch.setattr(mod, "backend", _Faux())
        assert mod._TOKEN == ""
        assert TestClient(mod.app).get("/list_files", params={"path": ""}).status_code != 401
    finally:
        sys.path[:] = sauve_chemin
        for n in list(sys.modules):
            if n not in sauve_mods and n.split(".")[0] in ("backends", "normalize", "agent_garde_insecure"):
                sys.modules.pop(n, None)
