# SPDX-License-Identifier: MIT
"""Routes serveur de la passe UX de l'éditeur (2026-09-19).

* ``POST /api/sandbox/save`` : précondition ``expected_mtime`` (412 si le
  disque a bougé) et création seule ``if_absent`` (409 si le nom est pris) ;
* ``POST /api/sandbox/rename`` : jamais d'écrasement d'une cible existante ;
* ``POST /api/sandbox/copy`` : « Dupliquer » (cible existante refusée, quota) ;
* ``POST /api/sandbox/replace`` : aperçu puis application, mêmes règles que
  le grep, fichiers non UTF-8 laissés intacts ;
* ``POST /api/sandbox/format`` : ``ruff format`` ;
* ``GET /api/sandbox/git/status`` : liste ``conflicted`` ;
* ``POST /api/sandbox/git/merge-resolve`` : stratégie validée.

Cf. docs/editeur-ux-design-2026-09-19.md.
"""
from __future__ import annotations

import os
import shutil
import subprocess

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import shared_infra.sandbox.exec_bridge as xb
import shared_infra.sandbox.routes_files as sf


@pytest.fixture()
def env(tmp_path, monkeypatch):
    root = tmp_path / "work"
    root.mkdir()
    from tests.conftest import editeur_sur_agent
    ops = editeur_sur_agent(monkeypatch, root)

    monkeypatch.setattr(sf, "require_user_id", lambda request: 1)
    monkeypatch.setattr(sf, "_get_work_path", lambda uid: root)
    monkeypatch.setattr(sf, "get_user_settings", lambda uid: {"sandbox_quota_mb": 0})
    monkeypatch.setattr(sf, "get_username_by_id", lambda uid: "alice")
    monkeypatch.setattr(sf, "log_metric", lambda *a, **k: None)

    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app), root, ops


# ── save : précondition ────────────────────────────────────────────────────

def test_save_sans_precondition_inchange(env):
    client, root, ops = env
    (root / "a.py").write_text("v1")
    r = client.post("/api/sandbox/save", json={"path": "a.py", "content": "v2"})
    assert r.status_code == 200, r.text
    assert (root / "a.py").read_text() == "v2"


def test_save_mtime_a_jour_passe_et_rend_le_nouveau_mtime(env):
    client, root, ops = env
    f = root / "a.py"
    f.write_text("v1")
    base = f.stat().st_mtime
    r = client.post("/api/sandbox/save",
                    json={"path": "a.py", "content": "v2", "expected_mtime": base})
    assert r.status_code == 200, r.text
    new = r.json()["mtime"]
    # Deuxième enregistrement fondé sur le mtime RENDU : doit passer aussi.
    r2 = client.post("/api/sandbox/save",
                     json={"path": "a.py", "content": "v3", "expected_mtime": new})
    assert r2.status_code == 200, r2.text
    assert f.read_text() == "v3"


def test_save_disque_modifie_depuis_refuse_412_fichier_intact(env):
    client, root, ops = env
    f = root / "a.py"
    f.write_text("v1")
    base = f.stat().st_mtime
    os.utime(f, (base + 5, base + 5))
    f.write_text("modifié par le terminal")
    os.utime(f, (base + 5, base + 5))
    r = client.post("/api/sandbox/save",
                    json={"path": "a.py", "content": "mon buffer", "expected_mtime": base})
    assert r.status_code == 412
    d = r.json()["detail"]
    assert d["code"] == "conflict" and d["missing"] is False
    assert abs(d["mtime"] - (base + 5)) < 1e-6
    assert f.read_text() == "modifié par le terminal"
    assert ops == []


def test_save_fichier_supprime_depuis_refuse_412_missing(env):
    client, root, ops = env
    r = client.post("/api/sandbox/save",
                    json={"path": "parti.py", "content": "x", "expected_mtime": 123.0})
    assert r.status_code == 412
    assert r.json()["detail"]["missing"] is True
    assert not (root / "parti.py").exists()


def test_save_expected_mtime_null_vaut_absent(env):
    client, root, ops = env
    (root / "a.py").write_text("v1")
    r = client.post("/api/sandbox/save",
                    json={"path": "a.py", "content": "v2", "expected_mtime": None})
    assert r.status_code == 200, r.text


@pytest.mark.parametrize("bad", ["123", True, [1], {"m": 1}])
def test_save_expected_mtime_invalide_refuse_sans_ecrire(env, bad):
    # Relecture 2026-09-19 : une précondition illisible était IGNORÉE — le
    # client croyait son écriture protégée, le fichier était écrasé sans
    # contrôle. Elle est refusée, et rien n'est écrit.
    client, root, ops = env
    (root / "a.py").write_text("v1")
    r = client.post("/api/sandbox/save",
                    json={"path": "a.py", "content": "v2", "expected_mtime": bad})
    assert r.status_code == 400, r.text
    assert (root / "a.py").read_text() == "v1"


def test_save_if_absent_refuse_un_nom_pris(env):
    client, root, ops = env
    (root / "main.py").write_text("précieux")
    r = client.post("/api/sandbox/save",
                    json={"path": "main.py", "content": "", "if_absent": True})
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "exists"
    assert (root / "main.py").read_text() == "précieux"


def test_save_if_absent_cree_un_fichier_neuf(env):
    client, root, ops = env
    r = client.post("/api/sandbox/save",
                    json={"path": "neuf.py", "content": "", "if_absent": True})
    assert r.status_code == 200, r.text
    assert (root / "neuf.py").exists()


# ── rename : pas d'écrasement ──────────────────────────────────────────────

def test_rename_vers_un_nom_existant_refuse(env):
    client, root, ops = env
    (root / "a.py").write_text("A")
    (root / "b.py").write_text("B")
    r = client.post("/api/sandbox/rename", json={"old_path": "a.py", "new_path": "b.py"})
    assert r.status_code == 409
    assert (root / "b.py").read_text() == "B"
    assert (root / "a.py").read_text() == "A"
    assert ops == []


def test_deplacer_dans_un_dossier_qui_a_deja_ce_nom_refuse(env):
    client, root, ops = env
    (root / "src").mkdir()
    (root / "src" / "a.py").write_text("ancien")
    (root / "a.py").write_text("nouveau")
    r = client.post("/api/sandbox/rename", json={"old_path": "a.py", "new_path": "src/a.py"})
    assert r.status_code == 409
    assert (root / "src" / "a.py").read_text() == "ancien"


def test_rename_libre_passe(env):
    client, root, ops = env
    (root / "a.py").write_text("A")
    r = client.post("/api/sandbox/rename", json={"old_path": "a.py", "new_path": "c.py"})
    assert r.status_code == 200, r.text
    assert (root / "c.py").read_text() == "A"


# ── copy ───────────────────────────────────────────────────────────────────

def test_copy_fichier(env):
    client, root, ops = env
    (root / "a.py").write_text("A")
    r = client.post("/api/sandbox/copy", json={"src": "a.py", "dst": "a copie.py"})
    assert r.status_code == 200, r.text
    assert (root / "a copie.py").read_text() == "A"
    assert (root / "a.py").read_text() == "A"


def test_copy_dossier(env):
    client, root, ops = env
    (root / "pkg" / "sub").mkdir(parents=True)
    (root / "pkg" / "sub" / "m.py").write_text("M")
    r = client.post("/api/sandbox/copy", json={"src": "pkg", "dst": "pkg copie"})
    assert r.status_code == 200, r.text
    assert (root / "pkg copie" / "sub" / "m.py").read_text() == "M"


def test_copy_cible_existante_refusee(env):
    client, root, ops = env
    (root / "a.py").write_text("A")
    (root / "b.py").write_text("B")
    r = client.post("/api/sandbox/copy", json={"src": "a.py", "dst": "b.py"})
    assert r.status_code == 409
    assert (root / "b.py").read_text() == "B"
    assert ops == []


def test_copy_dossier_dans_lui_meme_refuse(env):
    client, root, ops = env
    (root / "pkg").mkdir()
    r = client.post("/api/sandbox/copy", json={"src": "pkg", "dst": "pkg/pkg"})
    assert r.status_code == 400
    assert ops == []


def test_copy_hors_sandbox_refuse(env):
    client, root, ops = env
    (root / "a.py").write_text("A")
    r = client.post("/api/sandbox/copy", json={"src": "a.py", "dst": "../evade.py"})
    assert r.status_code == 403


def test_copy_quota_depasse_refuse(env, monkeypatch):
    client, root, ops = env
    (root / "gros.bin").write_bytes(b"x" * (600 * 1024))
    monkeypatch.setattr(sf, "get_user_settings", lambda uid: {"sandbox_quota_mb": 1})
    monkeypatch.setattr(sf, "sandbox_usage_bytes", lambda *a, **k: 600 * 1024)
    r = client.post("/api/sandbox/copy", json={"src": "gros.bin", "dst": "gros2.bin"})
    assert r.status_code == 413
    assert ops == []


def test_delete_d_un_lien_sortant_retire_le_lien(env, tmp_path):
    client, root, ops = env
    dehors = tmp_path / "dehors"
    dehors.mkdir()
    (dehors / "garde.txt").write_text("intact")
    os.symlink(dehors, root / "lien")
    r = client.delete("/api/sandbox/delete", params={"path": "lien"})
    assert r.status_code == 200, r.text
    assert not os.path.lexists(root / "lien")
    assert (dehors / "garde.txt").read_text() == "intact"
    r = client.delete("/api/sandbox/delete", params={"path": "../dehors"})
    assert r.status_code == 403


def test_copy_source_absente_404(env):
    client, root, ops = env
    r = client.post("/api/sandbox/copy", json={"src": "rien.py", "dst": "x.py"})
    assert r.status_code == 404


# ── replace ────────────────────────────────────────────────────────────────

def _seed_replace(root):
    (root / "src").mkdir()
    (root / "src" / "a.py").write_text("foo = 1\nprint(foo)\n")
    (root / "src" / "b.js").write_text("const Foo = 2;\r\nfoo();\r\n")
    (root / "node_modules").mkdir()
    (root / "node_modules" / "x.js").write_text("foo")
    (root / ".cache.txt").write_text("foo")
    (root / "latin.txt").write_bytes("foo é".encode("latin-1"))
    (root / "bin.dat").write_bytes(b"foo\x00foo")


def test_replace_apercu_ne_touche_a_rien(env):
    client, root, ops = env
    _seed_replace(root)
    r = client.post("/api/sandbox/replace",
                    json={"query": "foo", "replacement": "bar", "dry_run": True})
    assert r.status_code == 200, r.text
    d = r.json()
    paths = {f["path"]: f for f in d["files"]}
    # insensible à la casse par défaut, comme le grep ; node_modules, cachés,
    # binaire et non-UTF-8 exclus
    assert set(paths) == {"src/a.py", "src/b.js"}
    assert paths["src/a.py"]["count"] == 2
    assert paths["src/b.js"]["count"] == 2
    s = paths["src/a.py"]["samples"][0]
    assert s == {"line": 1, "before": "foo = 1", "after": "bar = 1"}
    assert d["total"] == 4
    assert ops == []
    assert (root / "src" / "a.py").read_text() == "foo = 1\nprint(foo)\n"


def test_replace_applique_aux_seuls_fichiers_valides(env):
    client, root, ops = env
    _seed_replace(root)
    r = client.post("/api/sandbox/replace", json={
        "query": "foo", "replacement": "bar", "case_sensitive": True,
        "paths": ["src/b.js"]})
    assert r.status_code == 200, r.text
    d = r.json()
    assert [f["path"] for f in d["files"]] == ["src/b.js"]
    assert d["files"][0]["count"] == 1              # « Foo » épargné (casse)
    assert d["files"][0]["mtime"] is not None
    # fins de ligne CRLF préservées
    assert (root / "src" / "b.js").read_bytes() == b"const Foo = 2;\r\nbar();\r\n"
    assert (root / "src" / "a.py").read_text() == "foo = 1\nprint(foo)\n"
    assert (root / "latin.txt").read_bytes() == "foo é".encode("latin-1")


def test_replace_regex_avec_groupes_style_js(env):
    client, root, ops = env
    (root / "c.py").write_text("def f(a, b):\n    return a + b\n")
    r = client.post("/api/sandbox/replace", json={
        "query": r"def (\w+)\((\w+), (\w+)\)", "replacement": "def $1($3, $2)",
        "regex": True, "paths": ["c.py"]})
    assert r.status_code == 200, r.text
    assert (root / "c.py").read_text().startswith("def f(b, a):")


def test_replace_texte_litteral_ne_interprete_rien(env):
    client, root, ops = env
    (root / "d.txt").write_text("a.b a+b\n")
    r = client.post("/api/sandbox/replace", json={
        "query": "a.b", "replacement": r"\1$1", "paths": ["d.txt"]})
    assert r.status_code == 200, r.text
    assert (root / "d.txt").read_text() == "\\1$1 a+b\n"


def test_replace_ne_traverse_pas_les_lignes(env):
    client, root, ops = env
    (root / "e.txt").write_text("fin\ndebut\n")
    r = client.post("/api/sandbox/replace", json={
        "query": r"fin\s+debut", "replacement": "X", "regex": True, "dry_run": True})
    assert r.json()["files"] == []


def test_replace_filtre_glob(env):
    client, root, ops = env
    _seed_replace(root)
    r = client.post("/api/sandbox/replace", json={
        "query": "foo", "replacement": "bar", "glob": "*.py", "dry_run": True})
    assert [f["path"] for f in r.json()["files"]] == ["src/a.py"]


# ── replace : constats de la relecture du 2026-09-19 ────────────────────────

def test_replace_dossier_work_a_la_racine_jamais_ecrit_ailleurs(env):
    # Le pont d'écriture normalise ``work/x`` en ``x`` : le fichier LU était
    # work/a.py, le fichier ÉCRIT a.py (sans rapport, détruit).
    client, root, ops = env
    (root / "work").mkdir()
    (root / "work" / "a.py").write_text("foo\n")
    (root / "a.py").write_text("INTACT foo\n")
    d = client.post("/api/sandbox/replace",
                    json={"query": "foo", "replacement": "bar", "dry_run": True}).json()
    assert [f["path"] for f in d["files"]] == ["a.py"]
    assert {"path": "work/a.py", "reason": "chemin ambigu (work/)"} in d["skipped"]
    r = client.post("/api/sandbox/replace",
                    json={"query": "foo", "replacement": "bar", "paths": ["work/a.py"]}).json()
    assert r["files"] == [] and r["skipped"][0]["path"] == "work/a.py"
    assert (root / "a.py").read_text() == "INTACT foo\n"
    assert (root / "work" / "a.py").read_text() == "foo\n"
    assert ops == []


@pytest.mark.parametrize("repl", ["C:\\dir", "fin\\", "$2"])
def test_replace_gabarit_regex_invalide_400(env, repl):
    client, root, ops = env
    (root / "f.txt").write_text("abc\n")
    r = client.post("/api/sandbox/replace", json={
        "query": "(b)", "replacement": repl, "regex": True, "dry_run": True})
    assert r.status_code == 400, r.text
    assert "Remplacement invalide" in r.json()["detail"]


def test_replace_dollar_dollar_et_esperluette(env):
    client, root, ops = env
    (root / "g.txt").write_text("prix 10\n")
    r = client.post("/api/sandbox/replace", json={
        "query": r"\d+", "replacement": "$$$&", "regex": True, "paths": ["g.txt"]})
    assert r.status_code == 200, r.text
    assert (root / "g.txt").read_text() == "prix $10\n"


def test_replace_lien_symbolique_ignore(env):
    client, root, ops = env
    (root / "vrai.py").write_text("foo\n")
    os.symlink(root / "vrai.py", root / "lien.py")
    d = client.post("/api/sandbox/replace",
                    json={"query": "foo", "replacement": "bar", "dry_run": True}).json()
    assert [f["path"] for f in d["files"]] == ["vrai.py"]
    assert {"path": "lien.py", "reason": "lien symbolique"} in d["skipped"]
    client.post("/api/sandbox/replace",
                json={"query": "foo", "replacement": "bar", "paths": ["lien.py"]})
    assert (root / "lien.py").is_symlink() and (root / "vrai.py").read_text() == "foo\n"


def test_replace_relit_le_fichier_a_l_application(env):
    # Le texte écrit vient d'une lecture FAITE À L'APPLICATION, jamais de
    # l'aperçu : un enregistrement arrivé entre-temps n'est pas perdu.
    client, root, ops = env
    (root / "h.py").write_text("foo = 1\n")
    client.post("/api/sandbox/replace",
                json={"query": "foo", "replacement": "bar", "dry_run": True})
    (root / "h.py").write_text("foo = 1\nplus = foo\n")          # écrit entre-temps
    r = client.post("/api/sandbox/replace",
                    json={"query": "foo", "replacement": "bar", "paths": ["h.py"]}).json()
    assert r["files"][0]["count"] == 2
    assert (root / "h.py").read_text() == "bar = 1\nplus = bar\n"


def test_replace_echec_en_cours_de_route_rend_les_fichiers_deja_ecrits(env, monkeypatch):
    client, root, ops = env
    for n in ("a.txt", "b.txt", "c.txt"):
        (root / n).write_text("foo\n")
    from shared_infra.sandbox import agent_client as AC
    real = AC.AgentClient.write

    async def _flaky(self, path, data, **kw):
        if path == "b.txt":
            raise AC.AgentError("agent_unavailable", "conteneur arrêté")
        return await real(self, path, data, **kw)
    monkeypatch.setattr(AC.AgentClient, "write", _flaky)
    r = client.post("/api/sandbox/replace", json={
        "query": "foo", "replacement": "bar", "paths": ["a.txt", "b.txt", "c.txt"]})
    assert r.status_code == 200, r.text
    d = r.json()
    assert [f["path"] for f in d["files"]] == ["a.txt"]
    assert d["failed"]["path"] == "b.txt" and "sandbox" in d["failed"]["error"]
    assert (root / "c.txt").read_text() == "foo\n"                # arrêt net


def test_replace_fichier_modifie_entre_relecture_et_ecriture(env, monkeypatch):
    """L'agent n'écrit que si le contenu est encore celui relu."""
    client, root, ops = env
    (root / "a.txt").write_text("foo\n")
    from shared_infra.sandbox import agent_client as AC
    real = AC.AgentClient.read

    async def _lu_puis_modifie(self, path, **kw):
        r = await real(self, path, **kw)
        if path == "a.txt":
            (root / "a.txt").write_text("foo modifié ailleurs\n")
        return r
    monkeypatch.setattr(AC.AgentClient, "read", _lu_puis_modifie)
    r = client.post("/api/sandbox/replace", json={
        "query": "foo", "replacement": "bar", "paths": ["a.txt"]})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["files"] == [] and d["skipped"] == [{"path": "a.txt",
                                                  "reason": "modifié pendant l'opération"}]
    assert (root / "a.txt").read_text() == "foo modifié ailleurs\n"


def test_replace_quota_verifie(env, monkeypatch):
    client, root, ops = env
    (root / "q.txt").write_text("x\n")
    monkeypatch.setattr(sf, "get_user_settings", lambda uid: {"sandbox_quota_mb": 1})
    monkeypatch.setattr(sf, "sandbox_usage_bytes", lambda *a, **k: 1024 * 1024 - 10)
    r = client.post("/api/sandbox/replace", json={
        "query": "x", "replacement": "y" * 5000, "paths": ["q.txt"]}).json()
    assert r["files"] == [] and "Quota" in r["failed"]["error"]
    assert (root / "q.txt").read_text() == "x\n"


def test_replace_bornes_d_entree(env):
    client, root, ops = env
    big = client.post("/api/sandbox/replace", json={
        "query": "a", "replacement": "b" * 10_001, "dry_run": True})
    assert big.status_code == 400
    many = client.post("/api/sandbox/replace", json={
        "query": "a", "replacement": "b", "paths": [f"f{i}.txt" for i in range(501)]})
    assert many.status_code == 400
    hors = client.post("/api/sandbox/replace", json={
        "query": "a", "replacement": "b", "paths": ["../x.txt", "node_modules/y.js", ".secret"]}).json()
    assert hors["files"] == [] and len(hors["skipped"]) == 3


def test_save_if_absent_reverifie_sous_verrou(env, monkeypatch):
    # Deux « Nouveau fichier » simultanés : le second ne vide pas le premier,
    # même créé après le contrôle (l'agent vérifie « absent » au remplacement).
    client, root, ops = env
    vrai = sf._etat_agent

    async def _etat(agent, rel, **kw):
        st = await vrai(agent, rel, **kw)
        if rel == "neuf.py" and st["kind"] == "missing":
            (root / "neuf.py").write_text("déjà là")   # créé entre-temps
        return st
    monkeypatch.setattr(sf, "_etat_agent", _etat)
    r = client.post("/api/sandbox/save",
                    json={"path": "neuf.py", "content": "", "if_absent": True})
    assert r.status_code == 409, r.text
    assert (root / "neuf.py").read_text() == "déjà là"


def test_replace_sans_paths_refuse_l_application(env):
    client, root, ops = env
    r = client.post("/api/sandbox/replace", json={"query": "foo", "replacement": "bar"})
    assert r.status_code == 400


def test_replace_regex_invalide_400(env):
    client, root, ops = env
    r = client.post("/api/sandbox/replace", json={
        "query": "(", "replacement": "x", "regex": True, "dry_run": True})
    assert r.status_code == 400


# ── format ─────────────────────────────────────────────────────────────────

@pytest.mark.skipif(not shutil.which("ruff"), reason="ruff absent")
def test_format_python(env):
    client, root, ops = env
    r = client.post("/api/sandbox/format",
                    json={"content": "x=1\ndef f( a ):\n  return a\n", "filename": "m.py"})
    assert r.status_code == 200, r.text
    assert r.json()["content"] == "x = 1\n\n\ndef f(a):\n    return a\n"


@pytest.mark.skipif(not shutil.which("ruff"), reason="ruff absent")
def test_format_syntaxe_invalide_422(env):
    client, root, ops = env
    r = client.post("/api/sandbox/format", json={"content": "def (:\n", "filename": "m.py"})
    assert r.status_code == 422


def test_ruff_trouve_a_cote_de_l_interpreteur_sans_path(monkeypatch, tmp_path):
    # Relecture 2026-09-19 (serveur réel lancé sans venv activé) : ``which``
    # ne voyait pas le ruff du venv → « Formater » en 501, lint muet.
    import sys

    import shared_infra.sandbox.routes_files as rf
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    (fake_bin / "python").write_text("")
    ruff = fake_bin / "ruff"
    ruff.write_text("#!/bin/sh\n")
    ruff.chmod(0o755)
    monkeypatch.setattr(rf.shutil, "which", lambda name: None)
    monkeypatch.setattr(sys, "executable", str(fake_bin / "python"))
    assert rf._find_ruff() == str(ruff)
    ruff.unlink()
    assert rf._find_ruff() is None


def test_format_non_python_refuse(env):
    client, root, ops = env
    r = client.post("/api/sandbox/format", json={"content": "x", "filename": "m.js"})
    assert r.status_code == 400


# ── git : conflits ─────────────────────────────────────────────────────────

@pytest.fixture()
def git_env(tmp_path, monkeypatch):
    if not shutil.which("git"):
        pytest.skip("git absent")
    import shared_infra.sandbox.routes_git as sg
    from tests.conftest import editeur_sur_agent
    root = tmp_path / "work"
    root.mkdir()
    editeur_sur_agent(monkeypatch, root)                 # git par l'agent (L4.4)
    monkeypatch.setattr(sg, "require_user_id", lambda request: 1)
    monkeypatch.setattr(sg, "_get_work_path", lambda uid: root)
    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app), root


def _git(cwd, *args, check=True):
    subprocess.run(["git", *args], cwd=cwd, check=check, capture_output=True,
                   env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
                        "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"})


def _conflit(root):
    _git(root, "init", "-q", "-b", "main")
    (root / "f.txt").write_text("base\n")
    (root / "g.txt").write_text("base\n")
    _git(root, "add", ".")
    _git(root, "commit", "-qm", "base")
    _git(root, "checkout", "-qb", "autre")
    (root / "f.txt").write_text("autre\n")
    (root / "g.txt").write_text("autre\n")
    _git(root, "commit", "-qam", "autre")
    _git(root, "checkout", "-q", "main")
    (root / "f.txt").write_text("main\n")
    (root / "g.txt").write_text("main\n")
    _git(root, "commit", "-qam", "main")
    _git(root, "merge", "autre", check=False)          # conflit : code retour 1


def test_status_liste_les_conflits_a_part(git_env):
    client, root = git_env
    _conflit(root)
    d = client.get("/api/sandbox/git/status").json()
    assert sorted(c["path"] for c in d["conflicted"]) == ["f.txt", "g.txt"]
    assert all(c["status"] == "UU" for c in d["conflicted"])
    assert d["staged"] == [] and d["modified"] == []


def test_resolution_fichier_par_fichier(git_env):
    client, root = git_env
    _conflit(root)
    r = client.post("/api/sandbox/git/merge-resolve",
                    json={"strategy": "theirs", "files": ["f.txt"]})
    assert r.status_code == 200, r.text
    assert r.json()["all_resolved"] is False
    assert (root / "f.txt").read_text() == "autre\n"
    d = client.get("/api/sandbox/git/status").json()
    assert [c["path"] for c in d["conflicted"]] == ["g.txt"]
    r = client.post("/api/sandbox/git/merge-resolve",
                    json={"strategy": "ours", "files": ["g.txt"]})
    assert r.json()["all_resolved"] is True
    assert (root / "g.txt").read_text() == "main\n"


@pytest.mark.parametrize("bad", ["force", "orphan=x", "", None])
def test_resolution_strategie_invalide_refusee(git_env, bad):
    client, root = git_env
    r = client.post("/api/sandbox/git/merge-resolve", json={"strategy": bad})
    assert r.status_code == 400


# ── grep : borne par ligne pour une regex (2026-09-20) ──────────────────────

def test_grep_regex_ignore_une_ligne_demesuree_mais_pas_le_texte(env):
    import time
    client, root, _ = env
    longue = "a" * 30_000
    (root / "gros.txt").write_text(longue + "\n" + "aaab ici\n", encoding="utf-8")
    t0 = time.monotonic()
    # ``(a+)+c`` sur 30 000 « a » sans « c » : backtracking exponentiel si on la laissait chercher.
    r = client.post("/api/sandbox/grep", json={"query": "(a+)+c", "regex": True})
    assert r.status_code == 200 and time.monotonic() - t0 < 5.0
    assert r.json()["matches"] == []
    r = client.post("/api/sandbox/grep", json={"query": "a+b", "regex": True})
    assert [m["line"] for m in r.json()["matches"]] == [2], "la ligne normale est fouillée"
    r = client.post("/api/sandbox/grep", json={"query": "aaaa", "regex": False})
    assert sorted(m["line"] for m in r.json()["matches"]) == [1], "en texte, la longue ligne est fouillée"
