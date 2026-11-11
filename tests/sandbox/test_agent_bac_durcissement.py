# SPDX-License-Identifier: MIT
"""tests/sandbox/test_agent_bac_durcissement.py — agent du bac : Content-Length invalide refusé (400) et connexions simultanées plafonnées (503)."""
from __future__ import annotations

import json
import os
import socket
import tempfile
import threading
import time
from pathlib import Path

import pytest

from tests.agent_bac import S


@pytest.fixture
def bac(monkeypatch):
    monkeypatch.setattr(S, "_MAX_CONNEXIONS", 3)
    dossier = Path(tempfile.mkdtemp(prefix="bd-"))
    work = dossier / "w"
    work.mkdir()
    chemin = str(dossier / "a.sock")
    srv = S.servir(str(work), chemin)
    threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
    try:
        yield chemin
    finally:
        srv.shutdown()
        srv.server_close()


def _ouvrir(chemin: str) -> socket.socket:
    s = socket.socket(socket.AF_UNIX)
    s.settimeout(10)
    s.connect(chemin)
    return s


def _requete(chemin: str, brut: bytes) -> tuple:
    with _ouvrir(chemin) as s:
        s.sendall(brut)
        rep = b""
        while True:
            bloc = s.recv(65536)
            if not bloc:
                break
            rep += bloc
    tete, _, corps = rep.partition(b"\r\n\r\n")
    return int(tete.split()[1]), json.loads(corps or b"{}")


@pytest.mark.parametrize("longueur", ["-1", "abc", "1e3", "+5", "1 2", "٣"])
def test_content_length_invalide_refuse_en_400(bac, longueur):
    brut = f"POST /v1/stat HTTP/1.1\r\nHost: a\r\nContent-Length: {longueur}\r\nConnection: close\r\n\r\n".encode()
    statut, corps = _requete(bac, brut)
    assert statut == 400 and corps["error"] == "bad_request"


def test_content_length_valide_toujours_accepte(bac):
    json_ = b'{"paths": []}'
    brut = (b"POST /v1/stat HTTP/1.1\r\nHost: a\r\nContent-Type: application/json\r\nContent-Length: %d\r\n"
            b"Connection: close\r\n\r\n%s" % (len(json_), json_))
    assert _requete(bac, brut)[0] == 200


def test_transfer_encoding_refuse_en_411(bac):
    brut = b"POST /v1/stat HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n"
    assert _requete(bac, brut)[0] == 411


def test_connexions_plafonnees_503_puis_service_repris(bac):
    inactives = [_ouvrir(bac) for _ in range(3)]
    try:
        time.sleep(0.3)                                  # les trois fils tiennent leur place, en attente d'une requête
        corps = b'{"paths": []}'
        brut = (b"POST /v1/stat HTTP/1.1\r\nHost: a\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s"
                % (len(corps), corps))
        statut, rep = _requete(bac, brut)
        assert statut == 503 and rep["error"] == "busy"
    finally:
        for s in inactives:
            s.close()
    for _ in range(50):                                  # les places libérées, le service répond de nouveau
        try:
            if _requete(bac, b"GET /v1/hello HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n")[0] == 200:
                return
        except (OSError, ValueError):
            pass
        time.sleep(0.1)
    pytest.fail("l'agent ne répond plus après la libération des connexions")


def test_confinement_liens_inchange(tmp_path):
    work, hors = tmp_path / "w", tmp_path / "hors"
    (work / "d").mkdir(parents=True)
    hors.mkdir()
    (hors / "s").write_text("x")
    os.symlink(hors, work / "l")
    os.symlink(hors / "s", work / "d" / "f")
    a = S.Agent(str(work))
    assert a.reel("") == a.racine and a.entree("") == a.racine
    assert a.entree("l") == os.path.join(a.racine, "l")
    assert a.entree("d/f") == os.path.join(a.racine, "d", "f")
    for rel in ("l", "l/s", "d/f"):
        with pytest.raises(S.Refus) as e:
            a.reel(rel)
        assert e.value.code == "outside_root"
    with pytest.raises(S.Refus) as e:
        a.entree("l/s")
    assert e.value.code == "outside_root"
    with pytest.raises(S.Refus) as e:
        a.entree("..")
    assert e.value.code == "bad_path"
    assert a.fsop({"op": "remove", "path": "d/f"})["removed"] == 1 and (hors / "s").exists()
