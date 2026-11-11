# SPDX-License-Identifier: MIT
"""tests/sandbox/test_agent_speciaux_releve_2026_10_17.py — genre exact des fichiers spéciaux et relevé des liens et spéciaux (harnais B-10)."""
from __future__ import annotations

import json
import os
import shutil
import socket
import stat
import tempfile
import threading
from pathlib import Path

import httpx
import pytest

from tests.agent_bac import S


@pytest.fixture
def bac():
    dossier = Path(tempfile.mkdtemp(prefix="sp-"))
    work = dossier / "w"
    work.mkdir()
    sock = str(dossier / "a.sock")
    srv = S.servir(str(work), sock)
    threading.Thread(target=srv.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
    c = httpx.Client(transport=httpx.HTTPTransport(uds=sock), base_url="http://agent", timeout=30)
    yield work, c, dossier
    c.close()
    srv.shutdown()
    srv.server_close()
    shutil.rmtree(dossier, ignore_errors=True)


def _fifo_et_socket(dossier: Path) -> None:
    os.mkfifo(dossier / "fifo1")
    with socket.socket(socket.AF_UNIX) as s:
        s.bind(str(dossier / "sock1"))


def _ndjson(r: httpx.Response) -> list:
    assert r.status_code == 200, r.text
    return [json.loads(x) for x in r.text.splitlines() if x]


def _releve(c: httpx.Client, **kw) -> str:
    r = c.post("/v1/changes/begin", json={"skip": [], **kw})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _fin(c: httpx.Client, ident: str, **kw) -> tuple:
    lignes = _ndjson(c.post("/v1/changes/end", json={"id": ident, **kw}))
    return lignes[:-1], lignes[-1]


def test_genre_special_depuis_s_ifmt_sans_ouvrir():
    assert S._special(stat.S_IFIFO | 0o644) == "fifo"
    assert S._special(stat.S_IFSOCK | 0o755) == "socket"
    assert S._special(stat.S_IFCHR | 0o666) == "char_device"
    assert S._special(stat.S_IFBLK | 0o660) == "block_device"
    assert S._special(stat.S_IFREG | 0o644) is None
    assert S._special(stat.S_IFLNK | 0o777) is None


def test_list_et_stat_distinguent_fifo_socket_peripherique(bac, monkeypatch):
    work, c, _ = bac
    (work / "x").mkdir()
    (work / "x" / "f.txt").write_text("a")
    _fifo_et_socket(work / "x")
    os.symlink("fifo1", work / "x" / "lien_fifo")
    ouverts = []
    vrai_open = os.open
    monkeypatch.setattr(os, "open", lambda p, *a, **k: (ouverts.append(str(p)), vrai_open(p, *a, **k))[1])
    lignes = _ndjson(c.post("/v1/list", json={"path": "x"}))
    par = {e["path"]: e for e in lignes if "path" in e}
    assert (par["x/fifo1"]["kind"], par["x/fifo1"]["special"]) == ("other", "fifo")
    assert (par["x/sock1"]["kind"], par["x/sock1"]["special"]) == ("other", "socket")
    assert "special" not in par["x/f.txt"] and "special" not in par["x/lien_fifo"]
    assert par["x/lien_fifo"]["kind"] == "link"
    filtre = _ndjson(c.post("/v1/list", json={"path": "x", "kinds": ["other"]}))
    assert sorted(e["path"] for e in filtre if "path" in e) == ["x/fifo1", "x/sock1"]
    r = c.post("/v1/stat", json={"paths": ["x/fifo1", "x/sock1", "x/f.txt", "x/lien_fifo"]})
    assert r.status_code == 200, r.text
    e = {x["path"]: x for x in r.json()["entries"]}
    assert (e["x/fifo1"]["kind"], e["x/fifo1"]["special"]) == ("other", "fifo")
    assert (e["x/sock1"]["kind"], e["x/sock1"]["special"]) == ("other", "socket")
    assert "special" not in e["x/f.txt"]
    assert e["x/lien_fifo"]["link"] and e["x/lien_fifo"]["special"] == "fifo"
    assert not [p for p in ouverts if "fifo1" in p or "sock1" in p]       # jamais ouverts
    if os.path.exists("/dev/null"):
        assert S._special(os.lstat("/dev/null").st_mode) == "char_device"


def test_releve_liens_et_speciaux_crees_modifies_supprimes(bac):
    work, c, dossier = bac
    (work / "y").mkdir()
    (work / "y" / "vieux").symlink_to("a")
    (work / "y" / "parti").symlink_to("b")
    os.mkfifo(work / "y" / "f_partie")
    (work / "y" / "devient_lien").write_text("x")
    ident = _releve(c, all_kinds=True)
    (work / "y" / "r.txt").write_text("r\n")
    (work / "y" / "l1").symlink_to("r.txt")
    (dossier / "dehors_dir").mkdir()
    (dossier / "dehors_dir" / "secret.txt").write_text("s")
    (work / "y" / "dehors").symlink_to(str(dossier / "dehors_dir"))
    (work / "y" / "vieux").unlink()
    (work / "y" / "vieux").symlink_to("c")
    (work / "y" / "parti").unlink()
    (work / "y" / "f_partie").unlink()
    (work / "y" / "devient_lien").unlink()
    (work / "y" / "devient_lien").symlink_to("r.txt")
    os.mkfifo(work / "y" / "f1")
    _fifo_et_socket(work / "y" / "..")
    vus, bilan = _fin(c, ident)
    par = {(v["path"], v.get("kind", "file")): v for v in vus}
    assert par[("y/r.txt", "file")]["change"] == "created"
    assert par[("y/l1", "link")] == {"path": "y/l1", "change": "created", "kind": "link",
                                     "before": {"state": "absent"},
                                     "after": {"kind": "link", "target": "r.txt"}}
    assert par[("y/dehors", "link")]["after"] == {"kind": "link", "target": str(dossier / "dehors_dir")}
    assert par[("y/vieux", "link")]["change"] == "modified"
    assert par[("y/vieux", "link")]["before"] == {"kind": "link", "target": "a"}
    assert par[("y/vieux", "link")]["after"] == {"kind": "link", "target": "c"}
    assert par[("y/parti", "link")]["change"] == "deleted"
    assert par[("y/parti", "link")]["before"] == {"kind": "link", "target": "b"}
    assert par[("y/parti", "link")]["after"] == {"state": "absent"}
    assert par[("y/f_partie", "fifo")]["change"] == "deleted"
    assert par[("y/devient_lien", "file")]["change"] == "deleted"
    assert par[("y/devient_lien", "link")]["change"] == "created"
    assert par[("y/f1", "fifo")]["after"] == {"kind": "fifo"}
    assert par[("fifo1", "fifo")]["change"] == "created"
    assert par[("sock1", "socket")]["change"] == "created"
    assert bilan["total"] == len(vus) == 11 and bilan["complete"]
    assert not [v for v in vus if "secret" in v["path"]]                # lien sortant : son texte seul
    ident = _releve(c, all_kinds=True)
    (work / "y" / "l1").unlink()
    (work / "y" / "l1").symlink_to("r.txt")                             # recréé, même cible
    os.unlink(work / "y" / "f1")
    os.mkfifo(work / "y" / "f1")                                        # recréée, même genre
    assert _fin(c, ident) == ([], {"done": True, "total": 0, "complete": True})


def test_releve_sans_all_kinds_inchange_pour_un_ancien_hote(bac):
    work, c, _ = bac
    ident = _releve(c)
    (work / "l1").symlink_to("nulle_part")
    os.mkfifo(work / "f1")
    (work / "r.txt").write_text("r")
    vus, bilan = _fin(c, ident)
    assert [(v["path"], v["change"]) for v in vus] == [("r.txt", "created")]
    assert "kind" not in vus[0] and bilan["total"] == 1


def test_releve_liens_bornes_entrees_fichiers_et_texte_de_cible(bac):
    work, c, _ = bac
    for i in range(6):
        (work / f"l{i}").symlink_to(f"c{i}")
    ident = _releve(c, all_kinds=True, max_entries=3)
    (work / "neuf").symlink_to("x")
    for i in range(6):
        (work / f"l{i}").unlink()
    vus, bilan = _fin(c, ident)
    assert vus == [] and not bilan["complete"]                          # parcours incomplet : rien déduit
    ident = _releve(c, all_kinds=True)
    for i in range(4):
        (work / f"m{i}").symlink_to("z")
    longue = "d/" * 2000
    (work / "long").symlink_to(longue)
    vus, bilan = _fin(c, ident, max_files=2)
    assert len(vus) == 2 and bilan["total"] == 5                        # max_files compte aussi les liens
    ident = _releve(c, all_kinds=True)
    (work / "long").unlink()
    (work / "long").symlink_to(longue + "e")
    (vu,) = _fin(c, ident)[0]
    assert vu["change"] == "modified" and len(vu["after"]["target"]) <= S._CIBLE_RELEVEE + 32
    assert vu["before"]["target"] != vu["after"]["target"]
