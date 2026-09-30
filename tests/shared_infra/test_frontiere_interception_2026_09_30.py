# SPDX-License-Identifier: MIT
"""Aucun accès de l'hôte au contenu de /work hors de l'agent de la sandbox
(L4.6). Pendant chaque parcours — outils fichiers et Git, routes de
l'éditeur et du panneau Git, téléchargements, export et import, instantanés,
sauvegarde et restauration des sandboxes — ``open``, ``os.open``,
``os.scandir``, ``os.listdir``, ``os.walk``, ``os.fwalk``, ``shutil.rmtree``,
``shutil.copytree``, ``shutil.copy*`` et les écritures de métadonnées
(``os.unlink``, ``os.rename``, ``os.replace``, ``os.chmod``, ``os.mkdir``)
sur un chemin sous /work échouent le test, sauf depuis un fil de l'agent en
thread (qui tient la place du conteneur).

Exceptions de l'hôte, hors de ces parcours : ``du`` (quota, métadonnées
seules, liens non suivis), la suppression d'un compte (``rmtree`` par
descripteurs, puis le root du conteneur si le contenu appartient à son
UID), la création de ``P/work`` et la migration d'une ancienne arborescence
(``ensure_work_subdir``, avant tout usage du conteneur)."""
from __future__ import annotations

import asyncio
import builtins
import contextlib
import io
import json
import os
import shutil
import tarfile
import threading
import zipfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from shared_infra.sandbox.agent import server as S
from tests.conftest import editeur_sur_agent, sandboxes_sur_agent

_agent = threading.local()


def _absolu(chemin, dir_fd=None):
    if isinstance(chemin, int):                          # descripteur
        return os.readlink(f"/proc/self/fd/{chemin}")
    chemin = os.fsdecode(chemin)
    if not os.path.isabs(chemin):
        base = os.readlink(f"/proc/self/fd/{dir_fd}") if dir_fd is not None else os.getcwd()
        chemin = os.path.join(base, chemin)
    return os.path.normpath(chemin)


class _Garde:
    def __init__(self, racines):
        self.racines = {os.path.normpath(str(r)) for r in racines} | \
            {os.path.realpath(str(r)) for r in racines}
        self.vus: list = []

    def noter(self, op, chemin, dir_fd=None, racine_permise=False):
        if getattr(_agent, "actif", False):
            return
        try:
            p = _absolu(chemin, dir_fd)
        except (OSError, TypeError, ValueError):
            return
        for r in self.racines:
            if p.startswith(r + os.sep) or (p == r and not racine_permise):
                self.vus.append((op, p))
                return


@contextlib.contextmanager
def interdit(*racines):
    """Accès de l'hôte sous ``racines`` notés pendant le bloc (rendus par le
    gestionnaire) ; ceux des fils de l'agent en thread sont permis."""
    garde = _Garde(racines)
    mp = pytest.MonkeyPatch()
    vrai_handle = S._Gestionnaire.handle

    def handle(self):
        _agent.actif = True
        try:
            return vrai_handle(self)
        finally:
            _agent.actif = False
    mp.setattr(S._Gestionnaire, "handle", handle)

    def envelopper(module, nom, extraire, racine_permise=False):
        vrai = getattr(module, nom)

        def f(*a, **k):
            try:
                for chemin, dir_fd in extraire(*a, **k):
                    garde.noter(nom, chemin, dir_fd, racine_permise)
            except (TypeError, IndexError):
                pass
            return vrai(*a, **k)
        mp.setattr(module, nom, f)

    def un(i=0, cle=None):
        return lambda *a, **k: [(a[i] if len(a) > i else k.get(cle, "."), k.get("dir_fd"))]

    envelopper(builtins, "open", un(0, "file"))
    envelopper(io, "open", un(0, "file"))
    envelopper(os, "open", un(0, "path"))
    envelopper(os, "scandir", un(0, "path"))
    envelopper(os, "listdir", un(0, "path"))
    envelopper(os, "walk", un(0, "top"))
    envelopper(os, "fwalk", un(0, "top"))
    envelopper(shutil, "rmtree", un(0, "path"))
    for nom in ("copytree", "copyfile", "copy", "copy2"):
        envelopper(shutil, nom, lambda s, d, *a, **k: [(s, None), (d, None)])
    for nom in ("unlink", "remove", "rmdir", "chmod"):
        envelopper(os, nom, un(0, "path"))
    for nom in ("rename", "replace"):
        envelopper(os, nom, lambda s, d, *a, **k: [(s, k.get("src_dir_fd")), (d, k.get("dst_dir_fd"))])
    envelopper(os, "mkdir", un(0, "path"), racine_permise=True)
    try:
        yield garde
    finally:
        mp.undo()


@pytest.fixture()
def sandbox(tmp_path, monkeypatch):
    base = tmp_path / "sb"
    work = base / "alice" / "work"
    (work / "src").mkdir(parents=True)
    (work / "src" / "a.py").write_text("def f():\n    return 1\n")
    (work / "notes.txt").write_text("bonjour\n")
    monkeypatch.setenv("APP_SANDBOX_DIR", str(base))
    monkeypatch.setenv("APP_FILE_HISTORY_DIR", str(tmp_path / "historique"))
    from shared_infra import config
    monkeypatch.setattr(config, "SANDBOX_DIR", base)
    return base, work


class _FakeMCP:
    def __init__(self):
        self.tools = {}

    def tool(self, **kw):
        def deco(fn):
            self.tools[fn.__name__] = fn
            return fn
        return deco


def _outils(module, base):
    mcp = _FakeMCP()
    module.register(mcp, base)
    return mcp.tools


def test_outils_fichiers_et_git(sandbox, monkeypatch):
    import llm_core.tools.fs_tools as fs_tools
    import llm_core.tools.git_tools as git_tools
    base, work = sandbox
    monkeypatch.setattr(fs_tools, "get_username", lambda ctx: "alice")
    monkeypatch.setattr(git_tools, "get_username", lambda ctx: "alice")
    fs, git = _outils(fs_tools, base), _outils(git_tools, base)
    with interdit(work) as garde:
        assert fs["write_file"](None, path="d/n.txt", content="x\n")["ok"]
        assert fs["read_file"](None, path="notes.txt")["ok"]
        assert fs["edit_file"](None, path="notes.txt", action="str_replace",
                               old_str="bonjour", new_str="salut")["ok"]
        assert fs["list_files"](None, path=".", recursive=True)["ok"]
        assert fs["list_files"](None, path=".", search_text="salut")["ok"]
        for args in ({"action": "copy", "path": "d", "dest": "e"},
                     {"action": "move", "path": "e/n.txt", "dest": "m.txt"},
                     {"action": "chmod", "path": "m.txt"},
                     {"action": "delete", "path": "e", "recursive": True}):
            assert fs["manage_files"](None, **args)["ok"], args
        assert fs["code"](None, action="definition", symbol="f")["ok"]
        assert git["git_action"](None, repo="proj", action="init").get("ok")
        assert git["git_write"](None, repo="proj", action="write", path="a.txt",
                                content="a\n").get("ok")
        assert git["git_commit"](None, repo="proj", message="Premier").get("ok")
        for action in ("status", "log", "files", "repos"):
            assert git["git_query"](None, repo="proj", action=action).get("ok"), action
        assert git["git_inspect"](None, repo="proj").get("ok")
    assert garde.vus == []


def _client_editeur(monkeypatch, work):
    import shared_infra.sandbox.routes_files as sf
    import shared_infra.sandbox.routes_git as sg
    editeur_sur_agent(monkeypatch, work)
    for m in (sf, sg):
        monkeypatch.setattr(m, "require_user_id", lambda request: 1)
        monkeypatch.setattr(m, "_get_work_path", lambda uid: work)
    monkeypatch.setattr(sg, "get_username_by_id", lambda uid: "alice")
    app = FastAPI()
    app.include_router(sf.router)
    app.include_router(sg.router)
    return sf, TestClient(app)


def test_routes_de_l_editeur_et_archives(sandbox, monkeypatch):
    _base, work = sandbox
    sf, c = _client_editeur(monkeypatch, work)
    with interdit(work) as garde:
        assert c.get("/api/sandbox/tree").status_code == 200
        r = c.post("/api/sandbox/save", json={"path": "notes.txt", "content": "v2\n"})
        assert r.status_code == 200, r.text
        assert c.post("/api/sandbox/mkdir", json={"path": "nouveau"}).status_code == 200
        assert c.post("/api/sandbox/rename", json={"old_path": "nouveau",
                                                   "new_path": "renomme"}).status_code == 200
        assert c.post("/api/sandbox/copy", json={"src": "src", "dst": "src2"}).status_code == 200
        assert c.delete("/api/sandbox/delete", params={"path": "src2"}).status_code == 200
        assert c.get("/api/sandbox/search", params={"q": "a.py"}).status_code == 200
        assert c.post("/api/sandbox/grep", json={"query": "return"}).status_code == 200
        assert c.get("/api/sandbox/download", params={"path": "notes.txt"}).status_code == 200
        r = c.get("/api/sandbox/download", params={"path": "src"})
        assert r.status_code == 200 and zipfile.ZipFile(io.BytesIO(r.content)).namelist()
        r = c.get("/api/sandbox/export")
        assert r.status_code == 200
        r2 = c.post("/api/sandbox/import", files={"archive": ("w.tgz", r.content,
                                                              "application/gzip")})
        assert r2.status_code == 200, r2.text
        assert c.post("/api/sandbox/git/init", json={"repo": "depot"}).status_code == 200
        assert c.get("/api/sandbox/git/status", params={"repo": "depot"}).status_code == 200
        assert c.get("/api/sandbox/git/repos").status_code == 200
    assert garde.vus == []
    with tarfile.open(fileobj=io.BytesIO(r.content), mode="r:gz") as tf:
        assert "notes.txt" in tf.getnames()


async def test_instantane_aller_retour(sandbox, monkeypatch, tmp_path):
    import shared_infra.sandbox.routes_snapshots as snap
    _base, work = sandbox
    editeur_sur_agent(monkeypatch, work)
    depot = tmp_path / "instantanes"
    depot.mkdir()
    monkeypatch.setattr(snap, "_user_snap_dir", lambda uid: depot)
    with interdit(work) as garde:
        evts = [json.loads(x) async for x in snap._create_snapshot_stream(1, "avant")]
        assert evts[-1]["event"] == "done", evts
        ident = evts[-1]["snapshot"]["id"]
        evts = [json.loads(x) async for x in snap._restore_snapshot_stream(1, ident)]
        assert evts[-1]["event"] == "done", evts
    assert garde.vus == []


def test_sauvegarde_et_restauration_des_sandboxes(sandbox, monkeypatch, tmp_path):
    from shared_infra.routes import _helpers as H
    from shared_infra.routes.admin.lifecycle import _restore_from_zip
    base, work = sandbox
    (base / "alice" / "skills").mkdir()
    (base / "alice" / "skills" / "s.md").write_text("skill")
    sandboxes_sur_agent(monkeypatch, base, ["alice"])
    with interdit(work) as garde:
        archive, _nom = H._make_backup_zip("sandboxes")
        try:
            restaures, erreurs, _b = _restore_from_zip(
                archive, "sandboxes", db_path=tmp_path / "absente.db",
                user_db_dir=tmp_path / "udb", sandbox_dir=base, mcp_dir=tmp_path / "mcp")
        finally:
            os.unlink(archive)
    assert garde.vus == [] and not erreurs, (garde.vus, erreurs)
    assert "sandboxes/alice/work/notes.txt" in restaures


def test_la_garde_voit_un_acces_de_l_hote(sandbox):
    """Témoin : un accès direct de l'hôte est bien relevé."""
    _base, work = sandbox
    with interdit(work) as garde:
        with open(work / "notes.txt") as f:
            f.read()
        os.listdir(work)
        asyncio.run(asyncio.sleep(0))
    assert [op for op, _p in garde.vus] == ["open", "listdir"]
