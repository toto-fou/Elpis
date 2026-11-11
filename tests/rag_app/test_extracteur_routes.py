# SPDX-License-Identifier: MIT
# tests/rag_app/test_extracteur_routes.py — routes /api/extract : jeton, refus de chemins, NDJSON, délai, annulation.
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys

import pytest
from fastapi.testclient import TestClient

from rag_app import app as A
from rag_app.extracteur import chemins, isolation, prison, service

from . import _extracteur_docs as docs

ENTETE = {"Authorization": "Bearer jeton-test"}


@pytest.fixture
def client():
    return TestClient(A.app, client=("127.0.0.1", 50000))


def _post(client, source, ext, **corps):
    return client.post("/api/extract", json={"source": source, "ext": ext, **corps}, headers=ENTETE)


# ─── jeton de service ───────────────────────────────────────────────────────
@pytest.mark.parametrize("route,corps", [
    ("/api/extract", {"source": "sources/a.txt", "ext": ".txt"}),
    ("/api/render", {"source": "sources/a.pdf", "ext": ".pdf", "page": 1}),
    ("/api/locate", {"source": "sources/a.pdf", "ext": ".pdf", "text": "bonjour"}),
])
def test_sans_jeton_ou_jeton_faux_refuse(client, magasin_rag, route, corps):
    (magasin_rag / "sources" / "a.txt").write_text("bonjour")
    assert client.post(route, json=corps).status_code == 401
    assert client.post(route, json=corps, headers={"Authorization": "Bearer faux"}).status_code in (401, 403)
    assert client.post(route, json=corps, headers={"Authorization": "Bearer"}).status_code in (401, 403)


def test_sans_jeton_configure_seul_l_appel_local_direct_passe(magasin_rag, monkeypatch):
    monkeypatch.delenv("RAG_SERVICE_TOKEN")
    monkeypatch.setattr(A, "_expected_token", lambda: "")
    (magasin_rag / "sources" / "a.txt").write_text("bonjour")
    corps = {"source": "sources/a.txt", "ext": ".txt"}
    distant = TestClient(A.app, client=("10.1.2.3", 50000))
    assert distant.post("/api/extract", json=corps).status_code == 401
    local = TestClient(A.app, client=("127.0.0.1", 50000))
    assert local.post("/api/extract", json=corps).status_code == 200


# ─── résolution des chemins ─────────────────────────────────────────────────
@pytest.mark.parametrize("source", [
    "../a.txt", "sources/../../a.txt", "sources/../a.txt", "/etc/passwd", "/etc/../etc/passwd", "sources//a.txt",
    "sources/./a.txt", "sources\\a.txt", "", "a\u0000.txt", "sources/" + "x" * 300 + ".txt",
])
def test_chemins_hors_du_magasin_refuses(client, magasin_rag, source):
    (magasin_rag.parent / "a.txt").write_text("secret hors du magasin")
    (magasin_rag / "a.txt").write_text("dans le magasin")
    rep = _post(client, source, ".txt")
    assert rep.status_code in (400, 422), (source, rep.text)
    assert "secret" not in rep.text


def test_chemin_avec_substitut_unicode_isole_refuse_sans_erreur_500(client, magasin_rag):
    rep = client.post("/api/extract", content=b'{"source": "sources/\\ud800.txt", "ext": ".txt"}',
                      headers={**ENTETE, "Content-Type": "application/json"})
    assert rep.status_code == 422 and rep.json()["detail"][0]["loc"] == ["body", "source"]


def test_lien_symbolique_refuse_fichier_et_dossier(client, magasin_rag):
    dehors = magasin_rag.parent / "dehors"
    dehors.mkdir()
    (dehors / "secret.txt").write_text("secret")
    (magasin_rag / "sources" / "lien.txt").symlink_to(dehors / "secret.txt")
    (magasin_rag / "sources" / "dossier").symlink_to(dehors)
    (magasin_rag / "sources" / "ok.txt").write_text("legitime")
    (magasin_rag / "sources" / "interne.txt").symlink_to(magasin_rag / "sources" / "ok.txt")
    for source in ("sources/lien.txt", "sources/dossier/secret.txt", "sources/interne.txt"):
        rep = _post(client, source, ".txt")
        assert rep.status_code == 400 and rep.json()["detail"]["code"] == "bad_path", source
    assert _post(client, "sources/ok.txt", ".txt").status_code == 200


def test_racine_elle_meme_derriere_un_lien_reste_acceptee(client, magasin_rag, monkeypatch, tmp_path):
    lien = tmp_path / "racine-lien"
    lien.symlink_to(magasin_rag)
    monkeypatch.setenv("RAG_STORE_DIR", str(lien))
    (magasin_rag / "sources" / "a.txt").write_text("bonjour")
    assert _post(client, "sources/a.txt", ".txt").status_code == 200


def test_fichier_absent_dossier_et_configuration_manquante(client, magasin_rag, monkeypatch):
    assert _post(client, "sources/absent.txt", ".txt").status_code == 404
    (magasin_rag / "sources" / "dossier.txt").mkdir()
    assert _post(client, "sources/dossier.txt", ".txt").status_code == 400
    monkeypatch.delenv("RAG_STORE_DIR")
    monkeypatch.setattr(chemins, "DEFAUT_MAGASIN", magasin_rag.parent / "absent")
    rep = _post(client, "sources/a.txt", ".txt")
    assert rep.status_code == 503 and rep.json()["detail"]["code"] == "not_configured"


def test_sans_variables_les_dossiers_par_defaut_du_core(client, magasin_rag, monkeypatch, tmp_path):
    monkeypatch.delenv("RAG_STORE_DIR")
    monkeypatch.delenv("RAG_CACHE_DIR")
    monkeypatch.setattr(chemins, "DEFAUT_MAGASIN", magasin_rag)
    monkeypatch.setattr(chemins, "DEFAUT_CACHE", tmp_path / "rag-cache")
    (magasin_rag / "sources" / "a.txt").write_text("bonjour")
    assert json.loads(_post(client, "sources/a.txt", ".txt").text.splitlines()[-1])["type"] == "result"
    assert chemins.racine_cache() == (tmp_path / "rag-cache").resolve()
    assert oct((tmp_path / "rag-cache").stat().st_mode & 0o777) == "0o700"


def test_jeton_lu_dans_le_fichier_de_jeton(magasin_rag, monkeypatch, tmp_path):
    monkeypatch.delenv("RAG_SERVICE_TOKEN")
    fichier = tmp_path / "jeton"
    fichier.write_text("jeton-fichier\n")
    monkeypatch.setenv("RAG_SERVICE_TOKEN_FILE", str(fichier))
    (magasin_rag / "sources" / "a.txt").write_text("bonjour")
    local = TestClient(A.app, client=("127.0.0.1", 50000))
    corps = {"source": "sources/a.txt", "ext": ".txt"}
    assert local.post("/api/extract", json=corps).status_code == 401
    assert local.post("/api/extract", json=corps, headers={"Authorization": "Bearer jeton-test"}).status_code == 403
    assert local.post("/api/extract", json=corps, headers={"Authorization": "Bearer jeton-fichier"}).status_code == 200


def test_anciennes_routes_et_console_retirees(client, magasin_rag):
    for methode, route in (("get", "/"), ("get", "/api/config"), ("post", "/api/search"), ("get", "/api/collections"),
                           ("post", "/api/tools/rag_search"), ("post", "/api/upload"), ("get", "/api/ocr/queue"),
                           ("post", "/api/restart"), ("post", "/api/reset"), ("get", "/static/app.js"),
                           ("get", "/docs"), ("get", "/openapi.json")):
        assert getattr(client, methode)(route, headers=ENTETE).status_code in (404, 405), route


def test_cache_dans_le_magasin_refuse(client, magasin_rag, monkeypatch):
    monkeypatch.setenv("RAG_CACHE_DIR", str(magasin_rag / "cache"))
    docs.docx_temoin(magasin_rag / "sources" / "g.docx")
    rep = client.post("/api/render", json={"source": "sources/g.docx", "ext": ".docx", "page": 1}, headers=ENTETE)
    assert rep.status_code == 503


def test_extension_hors_liste_ou_incoherente_est_unsupported(client, magasin_rag):
    (magasin_rag / "sources" / "x.exe").write_bytes(b"MZ")
    (magasin_rag / "sources" / "y.txt").write_text("texte")
    for source, ext in (("sources/x.exe", ".exe"), ("sources/y.txt", ".pdf"), ("sources/y.txt", ""), ("sources/y.txt", ".sh.exe")):
        rep = _post(client, source, ext)
        assert rep.status_code == 200, (source, ext)
        assert json.loads(rep.text) == {"type": "error", "code": "unsupported", "message": json.loads(rep.text)["message"]}
    # L'extension sans point et la casse sont tolérées.
    assert json.loads(_post(client, "sources/y.txt", "TXT").text.splitlines()[-1])["type"] == "result"


def test_corps_invalide(client, magasin_rag):
    assert client.post("/api/extract", json={"source": "a.txt"}, headers=ENTETE).status_code == 422
    assert client.post("/api/render", json={"source": "a.pdf", "ext": ".pdf", "page": 0}, headers=ENTETE).status_code == 422
    assert client.post("/api/render", json={"source": "a.pdf", "ext": ".pdf", "page": 1, "dpi": 9999},
                       headers=ENTETE).status_code == 422
    assert client.post("/api/locate", json={"source": "a.pdf", "ext": ".pdf", "text": ""}, headers=ENTETE).status_code == 422


# ─── format NDJSON ──────────────────────────────────────────────────────────
def test_flux_ndjson_progress_puis_result(client, magasin_rag):
    docs.pdf_structure(magasin_rag / "sources" / "s.pdf")
    rep = _post(client, "sources/s.pdf", ".pdf")
    assert rep.headers["content-type"].startswith("application/x-ndjson")
    assert rep.text.endswith("\n") and "\n\n" not in rep.text
    lignes = [json.loads(ligne) for ligne in rep.text.splitlines()]
    assert [x["type"] for x in lignes[:-1]] == ["progress"] * (len(lignes) - 1) and len(lignes) >= 2
    assert all(set(x) == {"type", "done", "total"} and isinstance(x["done"], int) for x in lignes[:-1])
    final = lignes[-1]
    assert set(final) == {"type", "meta", "blocks", "warnings"}
    assert set(final["meta"]) == {"pages", "title", "text_layer", "mime"}
    assert {b["kind"] for b in final["blocks"]} <= {"heading", "paragraph", "list", "table", "code"}
    assert all(set(b) <= {"kind", "text", "level", "page", "boxes", "sheet", "slide"} for b in final["blocks"])


def test_erreur_ndjson_ligne_unique_apres_progress(client, magasin_rag):
    (magasin_rag / "sources" / "faux.pdf").write_bytes(b"%PDF-1.4 abime")
    lignes = [json.loads(ligne) for ligne in _post(client, "sources/faux.pdf", ".pdf").text.splitlines()]
    assert lignes[-1] == {"type": "error", "code": "corrupt", "message": lignes[-1]["message"]}
    assert all(x["type"] == "progress" for x in lignes[:-1])


# ─── délai et annulation ────────────────────────────────────────────────────
def test_delai_depasse_tue_l_enfant(client, magasin_rag, monkeypatch):
    docs.pdf_structure(magasin_rag / "sources" / "s.pdf")
    monkeypatch.setenv("RAG_EXTRACT_TIMEOUT_S", "0.05")
    lignes = [json.loads(ligne) for ligne in _post(client, "sources/s.pdf", ".pdf").text.splitlines()]
    assert lignes[-1]["type"] == "error" and lignes[-1]["code"] == "timeout"
    assert not isolation.ACTIFS


def test_fermer_le_flux_tue_l_enfant(magasin_rag):
    from fpdf import FPDF
    pdf = FPDF(unit="pt", format="A4")
    for n in range(300):
        pdf.add_page()
        pdf.set_font("Helvetica", "", 11)
        pdf.set_xy(72, 100)
        pdf.multi_cell(450, 14, f"Page {n}. " + "Du texte pour occuper la page. " * 60)
    pdf.output(str(magasin_rag / "sources" / "long.pdf"))

    async def scenario():
        chemin, ext = service.resoudre_source("sources/long.pdf", ".pdf")
        flux = service.flux_extraction(str(chemin), ext, False, None)
        premiere = json.loads(await flux.__anext__())
        assert premiere["type"] == "progress" and isolation.ACTIFS
        enfants = list(isolation.ACTIFS)
        await flux.aclose()
        assert not isolation.ACTIFS
        assert all(p.returncode is not None for p in enfants)

    asyncio.run(scenario())


def test_executer_renvoie_le_resultat_de_l_enfant(magasin_rag):
    async def scenario():
        job = {"type": "extract", "path": str(magasin_rag / "sources" / "t.txt"), "ext": ".txt", "max_chars": 100,
               "zip_max_mo": 10, "tolerer_vide": False}
        (magasin_rag / "sources" / "t.txt").write_text("bonjour")
        resultat = await isolation.executer(job, 30)
        assert resultat["blocks"][0]["text"] == "bonjour"

    asyncio.run(scenario())


# ─── prison des analyses ────────────────────────────────────────────────────
@pytest.mark.skipif(not prison.bwrap_utilisable(), reason="bubblewrap inutilisable ici")
def test_analyse_dans_la_prison_ne_voit_que_sa_source(client, magasin_rag, monkeypatch, tmp_path):
    (magasin_rag / "sources" / "t.txt").write_text("bonjour")
    (magasin_rag / "sources" / "voisin.txt").write_text("secret d'un autre")
    sonde = ("import os, socket, sys\n"
             "print(open('/doc/source.txt').read(), os.path.exists(sys.argv[1]), os.path.exists(sys.argv[2]))\n"
             "try:\n socket.create_connection(('127.0.0.1', 22), 1); print('reseau')\n"
             "except OSError:\n print('sans-reseau')")
    argv = prison.argv_analyse(prison.bwrap_utilisable(), [sys.executable, "-I", "-c", sonde,
                               str(magasin_rag / "sources" / "voisin.txt"), str(tmp_path)],
                               str(magasin_rag / "sources" / "t.txt"), "/doc/source.txt")
    sortie = subprocess.run(argv, capture_output=True, text=True, timeout=30, env={"PATH": "/usr/bin:/bin"})
    assert sortie.stdout.split() == ["bonjour", "False", "False", "sans-reseau"], sortie.stderr
    vus = []
    vrai = isolation.asyncio.create_subprocess_exec

    async def espion(*argv, **kw):
        vus.append(argv)
        return await vrai(*argv, **kw)

    monkeypatch.setattr(isolation.asyncio, "create_subprocess_exec", espion)
    lignes = [json.loads(ligne) for ligne in _post(client, "sources/t.txt", ".txt").text.splitlines()]
    assert lignes[-1]["type"] == "result" and lignes[-1]["blocks"][0]["text"] == "bonjour"
    assert vus[0][0].endswith("bwrap") and "--unshare-all" in vus[0]
    du_magasin = [a for a in vus[0] if a.startswith(str(magasin_rag.resolve()))]
    assert du_magasin == [str((magasin_rag / "sources" / "t.txt").resolve())] and "/doc/source.txt" in vus[0]


def test_isolation_exigee_sans_bubblewrap_503_avant_toute_analyse(client, magasin_rag, monkeypatch):
    docs.pdf_structure(magasin_rag / "sources" / "s.pdf")
    monkeypatch.setenv("RAG_ISOLATION", "bwrap")
    monkeypatch.setattr(prison, "bwrap_utilisable", lambda: "")
    for rep in (_post(client, "sources/s.pdf", ".pdf"),
                client.post("/api/render", json={"source": "sources/s.pdf", "ext": ".pdf", "page": 1}, headers=ENTETE)):
        assert rep.status_code == 503 and rep.json()["detail"]["code"] == "isolation_unavailable"
    assert client.get("/api/health").json()["isolated"] is False
    monkeypatch.setenv("RAG_ISOLATION", "none")
    assert _post(client, "sources/s.pdf", ".pdf").text.splitlines()[-1].startswith('{"type":"result"')


def test_fin_relayee_par_bwrap_garde_son_sens():
    assert isolation._erreur_sortie(128 + 9, "").code == "too_large"
    assert isolation._erreur_sortie(128 + 24, "").code == "timeout"
    assert isolation._erreur_sortie(1, "").code == "corrupt"


# ─── santé ──────────────────────────────────────────────────────────────────
def test_sante_publique_sans_detail_sensible(client, magasin_rag, monkeypatch):
    h = client.get("/api/health").json()
    assert set(h) == {"ok", "service", "version", "soffice", "isolated", "ocr"}
    assert h["ok"] is True and h["service"] == "rag_app" and isinstance(h["version"], str)
    assert isinstance(h["soffice"], bool) and isinstance(h["ocr"], bool)
    faux = magasin_rag.parent / "faux-soffice"
    faux.write_text("#!/bin/sh\n")
    faux.chmod(0o755)
    monkeypatch.setenv("PATH", "/nulle/part")
    monkeypatch.setenv("RAG_SOFFICE_BIN", "/inexistant/soffice")
    assert client.get("/api/health").json()["soffice"] is False
    monkeypatch.setenv("RAG_SOFFICE_BIN", str(faux))
    assert client.get("/api/health").json()["soffice"] is True
