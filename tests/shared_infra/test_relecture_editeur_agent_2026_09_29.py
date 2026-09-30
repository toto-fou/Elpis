# SPDX-License-Identifier: MIT
"""Relecture de L4.3 (éditeur par l'agent de la sandbox) : tests de
non-régression des points relevés."""
from __future__ import annotations

import asyncio
import contextlib
import os
import socket
import stat
import threading
import time

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import shared_infra.sandbox.routes_files as sf
from shared_infra.sandbox import agent_client as AC, office_preview as op
from shared_infra.sandbox.agent import server as S
from shared_infra.sandbox.executors import _user_sandbox as us
from shared_infra.sandbox.office_convert import OfficeError
from shared_infra.sandbox.paths import lexical_rel
from shared_infra.sandbox.preview_token import make_preview_token
from tests.conftest import editeur_sur_agent


@pytest.fixture()
def env(tmp_path, monkeypatch):
    root = tmp_path / "w"
    root.mkdir()
    editeur_sur_agent(monkeypatch, root)
    monkeypatch.setattr(sf, "require_user_id", lambda r: 1)
    monkeypatch.setattr(sf, "_get_work_path", lambda uid: root)
    monkeypatch.setattr(sf, "sandbox_usage_bytes", lambda *a, **k: 0)
    app = FastAPI()
    app.include_router(sf.router)
    return TestClient(app, raise_server_exceptions=False), root


def _fil_ou_boucle(appels, fn):
    def espion(*a, **k):
        try:
            asyncio.get_running_loop()
            appels.append("boucle")
        except RuntimeError:
            appels.append("fil")
        return fn(*a, **k)
    return espion


def _panne(code):
    async def panne(self, *a, **k):
        raise AC.AgentError(code, "test")
    return panne


# ── 1. expressions et réécriture hors de la boucle d'événements ────────────
def test_remplacement_et_reecriture_hors_de_la_boucle(env, monkeypatch):
    client, root = env
    (root / "a.txt").write_text("foo bar\n")
    appels: list = []
    monkeypatch.setattr(sf, "_replace_in_text", _fil_ou_boucle(appels, sf._replace_in_text))
    for corps in ({"query": "foo", "replacement": "baz", "dry_run": True},
                  {"query": "foo", "replacement": "baz", "paths": ["a.txt"]}):
        r = client.post("/api/sandbox/replace", json=corps)
        assert r.status_code == 200 and r.json()["total"] == 1, r.text
    assert appels == ["fil", "fil"]
    from shared_infra.sandbox import preview_rewrite as rw
    appels.clear()
    monkeypatch.setattr(rw, "rewrite_html", _fil_ou_boucle(appels, rw.rewrite_html))
    (root / "index.html").write_text('<html><img src="/x.png"></html>')
    r = client.get(f"/api/sandbox/pv/{make_preview_token(1)[0]}/index.html")
    assert r.status_code == 200 and appels == ["fil"], r.text


# ── 2. « ~ » est un nom pour l'éditeur ─────────────────────────────────────
def test_tilde_nom_litteral_pour_l_editeur(env):
    client, root = env
    (root / "~").mkdir()
    (root / "~" / "notes.txt").write_text("dans ~\n")
    (root / "notes.txt").write_text("racine\n")
    (root / "~" / "seul.txt").write_text("x")
    r = client.post("/api/sandbox/save", json={"path": "~/notes.txt", "content": "modifié\n"})
    assert r.status_code == 200, r.text
    assert (root / "~" / "notes.txt").read_text() == "modifié\n"
    assert (root / "notes.txt").read_text() == "racine\n"
    assert client.delete("/api/sandbox/delete", params={"path": "~/seul.txt"}).status_code == 200
    assert not (root / "~" / "seul.txt").exists()
    # Pour le modèle, « ~ » reste la racine.
    assert lexical_rel(root, "~/a") == "a" and lexical_rel(root, "~/a", tilde=False) == "~/a"


def test_tilde_nom_litteral_pour_l_apercu_office(env):
    _client, root = env
    (root / "~").mkdir()
    (root / "~" / "doc.docx").write_bytes(b"PK")
    src = asyncio.run(op.open_source(sf.agent_for(1), root, "~/doc.docx"))
    assert src.rel == "~/doc.docx"


# ── 3. un fichier verrouillé n'arrête pas un import groupé ─────────────────
def test_import_groupe_continue_apres_un_verrou(env, monkeypatch):
    client, root = env
    vrai = sf._file_lock

    @contextlib.asynccontextmanager
    async def verrou(path):
        if path.name == "b.txt":
            raise HTTPException(409, "Fichier en cours d'écriture par l'assistant")
        async with vrai(path) as g:
            yield g
    monkeypatch.setattr(sf, "_file_lock", verrou)
    bumps: list = []
    monkeypatch.setattr(sf, "bump_sandbox_usage", lambda uid, d: bumps.append(d))
    fichiers = [("files", (n, n.encode())) for n in ("a.txt", "b.txt", "c.txt")]
    r = client.post("/api/sandbox/upload", files=fichiers,
                    data={"paths": ["a.txt", "b.txt", "c.txt"]})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["saved"] == 2 and [s["path"] for s in d["skipped"]] == ["b.txt"]
    assert "assistant" in d["skipped"][0]["reason"]
    assert sorted(p.name for p in root.iterdir()) == ["a.txt", "c.txt"] and bumps == [10]


# ── 4. remplacement : une panne de l'agent n'est pas « 0 remplacement » ─────
def test_remplacement_agent_en_panne_signale(env, monkeypatch):
    client, root = env
    (root / "a.txt").write_text("foo\n")
    monkeypatch.setattr(AC.AgentClient, "stat", _panne("agent_unavailable"))
    r = client.post("/api/sandbox/replace", json={"query": "foo", "replacement": "bar",
                                                  "paths": ["a.txt"]})
    assert r.status_code == 200, r.text
    assert r.json()["failed"]["path"] == "a.txt" and (root / "a.txt").read_text() == "foo\n"


# ── 5. import par morceaux : agent en panne au premier morceau → 503 ────────
def test_premier_morceau_agent_en_panne_503(env, monkeypatch):
    client, _root = env
    monkeypatch.setattr(AC.AgentClient, "stat", _panne("agent_unavailable"))
    r = client.post("/api/sandbox/upload-chunk?path=gros.bin&index=0&total=2&size=10",
                    content=b"12345")
    assert r.status_code == 503, r.text


# ── 6. budgets : seules les entrées retenues comptent ──────────────────────
def test_recherche_par_nom_pas_affamee_par_les_dossiers(env):
    client, root = env
    for i in range(300):
        (root / f"test_dir_{i:03d}").mkdir()
    for i in range(50):
        (root / f"test_dir_{i:03d}" / f"test_file_{i}.py").write_text("x")
    d = client.get("/api/sandbox/search", params={"q": "test", "mode": "name"}).json()
    assert len(d["items"]) == 50 and not d["truncated"], d


def test_grep_et_remplacement_filtrent_avant_le_budget(env, monkeypatch):
    client, root = env
    monkeypatch.setattr(sf, "_GREP_MAX_FILES_SCANNED", 10)
    (root / "big" / "sub").mkdir(parents=True)
    for i in range(60):
        (root / "big" / f"f{i}.txt").write_text("")
    (root / "big" / "sub" / "x.py").write_text("needle\n")
    d = client.post("/api/sandbox/grep", json={"query": "needle", "glob": "*.py"}).json()
    assert [m["path"] for m in d["matches"]] == ["big/sub/x.py"] and not d["truncated"], d
    d = client.post("/api/sandbox/replace", json={"query": "needle", "replacement": "x",
                                                  "glob": "*.py", "dry_run": True}).json()
    assert [f["path"] for f in d["files"]] == ["big/sub/x.py"] and not d["truncated"], d


def test_arbre_ne_compte_pas_les_liens(env, monkeypatch):
    client, root = env
    monkeypatch.setattr(sf, "TREE_MAX_ENTRIES", 5)
    for i in range(3):
        (root / f"f{i}").write_text("x")
    for i in range(10):
        os.symlink(f"f{i % 3}", root / f"lien{i}")
    d = client.get("/api/sandbox/tree").json()
    assert sorted(i["name"] for i in d["items"]) == ["f0", "f1", "f2"] and not d["truncated"]


# ── 7. recherche : colonne et aperçu sur une ligne très longue ─────────────
def test_recherche_ligne_longue_colonne_et_apercu(env):
    client, root = env
    (root / "min.js").write_text("a" * 5000 + "needle" + "b" * 50 + "\n")
    (i,) = client.get("/api/sandbox/search", params={"q": "needle"}).json()["items"]
    assert i["col"] == 5001 and "needle" in i["preview"] and i["preview"].startswith("…")


# ── 8. opérations longues : pas de 504 à la minute ; vidage au mieux ───────
def test_suppression_longue_attendue(env, monkeypatch):
    client, root = env
    (root / "d").mkdir()
    (root / "d" / "f").write_text("x")
    monkeypatch.setattr(AC, "_ATTENTE_S", 0.5)
    vrai = S.Agent.fsop

    def lent(self, d):
        if d.get("op") == "remove":
            time.sleep(1.5)
        return vrai(self, d)
    monkeypatch.setattr(S.Agent, "fsop", lent)
    r = client.delete("/api/sandbox/delete", params={"path": "d"})
    assert r.status_code == 200, r.text
    assert not (root / "d").exists()


@pytest.mark.skipif(os.geteuid() == 0, reason="root ignore les droits")
def test_vidage_au_mieux(tmp_path):
    w = tmp_path / "w"
    (w / "bloque").mkdir(parents=True)
    (w / "bloque" / "f").write_text("x")
    (w / "a.txt").write_text("x")
    (w / "z").mkdir()
    os.chmod(w / "bloque", 0o500)                       # son contenu ne se supprime pas
    try:
        r = S.Agent(str(w)).fsop({"op": "clear"})
    finally:
        os.chmod(w / "bloque", 0o700)
    assert (r["removed"], r["failed"]) == (2, 1)
    assert os.listdir(w) == ["bloque"]


# ── 9. aperçu en flux : version fixée avant le statut, inode compris ───────
def test_fichier_change_apres_le_stat_repris(env, monkeypatch):
    client, root = env
    p = root / "app.log"
    p.write_bytes(b"ligne\n" * 1000)
    vrai = AC.AgentClient.stat
    fait = []

    async def stat_puis_ajout(self, *a, **k):
        r = await vrai(self, *a, **k)
        if not fait:
            fait.append(1)
            with open(p, "ab") as f:
                f.write(b"encore\n")
        return r
    monkeypatch.setattr(AC.AgentClient, "stat", stat_puis_ajout)
    r = client.get("/api/sandbox/serve/app.log")
    assert r.status_code == 200 and r.content == p.read_bytes()
    assert r.headers["content-length"] == str(len(r.content))


def test_jamais_deux_versions_dans_une_reponse(env, monkeypatch):
    """Remplacé pendant le transfert par un fichier de même taille et même
    mtime (``cp -p``, ``rsync -t``) : l'inode le trahit, le transfert
    s'interrompt au lieu de mêler les deux versions."""
    client, root = env
    p = root / "video.bin"
    taille = sf._BLOC_REPONSE + 100
    p.write_bytes(b"a" * taille)
    st = p.stat()
    vrai = AC.AgentClient.read

    async def lire_puis_remplacer(self, *a, **k):
        r = await vrai(self, *a, **k)
        if not (root / "fait").exists():
            (root / "fait").write_text("")
            (root / "neuf").write_bytes(b"b" * taille)
            os.utime(root / "neuf", ns=(st.st_atime_ns, st.st_mtime_ns))
            os.replace(root / "neuf", p)
        return r
    monkeypatch.setattr(AC.AgentClient, "read", lire_puis_remplacer)
    try:
        r = client.get("/api/sandbox/serve/video.bin")
        corps = r.content
    except Exception:                                   # noqa: BLE001 — transfert interrompu
        corps = b""
    assert b"b" not in corps or b"a" not in corps


def test_copie_office_refusee_si_l_inode_change(env, tmp_path):
    _client, root = env
    p = root / "doc.docx"
    p.write_bytes(b"PK" + b"a" * 98)
    st = p.stat()
    src = asyncio.run(op.open_source(sf.agent_for(1), root, "doc.docx"))
    (root / "neuf").write_bytes(b"PK" + b"b" * 98)
    os.utime(root / "neuf", ns=(st.st_atime_ns, st.st_mtime_ns))
    os.replace(root / "neuf", p)
    with pytest.raises(OfficeError) as e:
        asyncio.run(op.snapshot_to(src, tmp_path / "copie"))
    assert e.value.code == "changed"


# ── 10. le sondage de l'éditeur ne réveille ni ne retient la sandbox ───────
def test_verification_passive(env, monkeypatch):
    client, root = env
    (root / "a.txt").write_text("x")
    demarrages: list = []
    vrai_demarrer = us.UserSandbox.start_agent

    async def compter(self, replace=False):
        demarrages.append(1)
        await vrai_demarrer(self, replace=replace)
    monkeypatch.setattr(us.UserSandbox, "start_agent", compter)

    async def arrete(self):
        return us.SandboxStatus(exists=True, running=False, container_name=self.container_name)
    reveils: list = []

    async def reveiller(self):
        reveils.append(1)
        return us.SandboxStatus(exists=True, running=True, container_name=self.container_name)
    monkeypatch.setattr(us.UserSandbox, "status", arrete)
    monkeypatch.setattr(us.UserSandbox, "ensure_running", reveiller)
    corps = {"files": [{"path": "a.txt", "mtime": 1.0}]}
    r = client.post("/api/sandbox/check-mtimes", json=corps)
    assert r.status_code == 503 and reveils == [] and demarrages == []   # rien de démarré
    activite: list = []
    vraie_activite = S.Agent.signaler_activite
    monkeypatch.setattr(S.Agent, "signaler_activite",
                        lambda self: activite.append(1) or vraie_activite(self))

    async def en_marche(self):
        return us.SandboxStatus(exists=True, running=True, container_name=self.container_name)
    monkeypatch.setattr(us.UserSandbox, "status", en_marche)
    r = client.post("/api/sandbox/check-mtimes", json=corps)
    assert r.status_code == 200 and r.json()["stale"][0]["path"] == "a.txt", r.text
    assert demarrages == [1] and activite == [] and reveils == []   # agent lancé, sans activité


# ── 11. correspondance des erreurs ─────────────────────────────────────────
def test_nom_trop_long_400(env):
    client, root = env
    (root / "a.txt").write_text("x")
    long = "n" * 300 + ".txt"
    r = client.post("/api/sandbox/rename", json={"old_path": "a.txt", "new_path": long})
    assert r.status_code == 400, r.text
    r = client.post("/api/sandbox/save", json={"path": long, "content": "x", "if_absent": True})
    assert r.status_code == 400, r.text


# ── 12. fichiers spéciaux dans l'agent ─────────────────────────────────────
def test_ajout_sur_une_fifo_ne_bloque_pas(tmp_path):
    w = tmp_path / "w"
    w.mkdir()
    os.mkfifo(w / "x.part")
    rendu: dict = {}

    def ajouter():
        try:
            S.Agent(str(w)).ajouter("x.part", [b"abc"])
        except S.Refus as r:
            rendu["code"] = r.code
    fil = threading.Thread(target=ajouter, daemon=True)
    fil.start()
    fil.join(3)
    assert not fil.is_alive() and rendu == {"code": "not_file"}


def test_copie_d_un_arbre_avec_fifo_et_socket(tmp_path):
    w = tmp_path / "w"
    (w / "d").mkdir(parents=True)
    (w / "d" / "f.txt").write_text("x")
    os.mkfifo(w / "d" / "tube")
    with socket.socket(socket.AF_UNIX) as s:
        s.bind(str(w / "d" / "sock"))
    assert S.Agent(str(w)).fsop({"op": "copy", "src": "d", "dst": "d2"}) == {"ok": True}
    assert (w / "d2" / "f.txt").read_text() == "x"
    assert stat.S_ISFIFO(os.lstat(w / "d2" / "tube").st_mode)
    assert stat.S_ISSOCK(os.lstat(w / "d2" / "sock").st_mode)
