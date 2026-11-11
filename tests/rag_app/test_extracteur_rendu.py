# SPDX-License-Identifier: MIT
# tests/rag_app/test_extracteur_rendu.py — rendu WebP des pages, conversion LibreOffice en cache, localisation.
from __future__ import annotations

import io
import json
import os
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from rag_app import app as A
from rag_app.extracteur import conversion, prison

from . import _extracteur_docs as docs

ENTETE = {"Authorization": "Bearer jeton-test"}
AVEC_SOFFICE = bool(shutil.which("soffice"))


@pytest.fixture
def client():
    return TestClient(A.app, client=("127.0.0.1", 50000))


def _rendre(client, source, ext=".pdf", page=1, **extra):
    return client.post("/api/render", json={"source": source, "ext": ext, "page": page, **extra}, headers=ENTETE)


def _localiser(client, source, texte, ext=".pdf", **extra):
    rep = client.post("/api/locate", json={"source": source, "ext": ext, "text": texte, **extra}, headers=ENTETE)
    assert rep.status_code == 200, rep.text
    return rep.json()


def _image(rep) -> Image.Image:
    assert rep.status_code == 200, rep.text
    return Image.open(io.BytesIO(rep.content))


def _sombre(image: Image.Image, boite) -> float:
    """Part de pixels sombres dans une boîte exprimée en points (rendu à 72 dpi : 1 point = 1 pixel)."""
    x0, y0, x1, y1 = (int(v) for v in boite)
    zone = image.convert("L").crop((x0, y0, x1, y1))
    pixels = zone.tobytes()
    return sum(1 for p in pixels if p < 140) / max(1, len(pixels))


# ─── rendu ──────────────────────────────────────────────────────────────────
def test_rendu_webp_taille_selon_le_dpi(client, magasin_rag):
    docs.pdf_simple(magasin_rag / "sources" / "a.pdf")
    rep = _rendre(client, "sources/a.pdf")
    assert rep.headers["content-type"] == "image/webp" and rep.content[:4] == b"RIFF" and rep.content[8:12] == b"WEBP"
    image = _image(rep)
    assert abs(image.width - 595.28 * 110 / 72) <= 1 and abs(image.height - 841.89 * 110 / 72) <= 1
    assert (rep.headers["x-rag-pages"], rep.headers["x-rag-page-width"]) == ("1", "595.28")
    petit = _image(_rendre(client, "sources/a.pdf", dpi=72))
    assert abs(petit.width - 595.28) <= 1 and abs(petit.height - 841.89) <= 1


def test_les_boites_extraites_recouvrent_le_texte_dans_le_rendu(client, magasin_rag):
    docs.pdf_simple(magasin_rag / "sources" / "a.pdf")
    blocs = json_blocs(client, "sources/a.pdf")
    page = _image(_rendre(client, "sources/a.pdf", dpi=72))
    for bloc in blocs:
        for boite in bloc["boxes"]:
            assert _sombre(page, boite) > 0.04, boite
    assert _sombre(page, [300, 300, 560, 700]) == 0  # une zone vide reste blanche
    assert _sombre(page, [72, 20, 400, 70]) == 0       # au-dessus du titre (repère haut-gauche)


def test_rendu_page_recadree_suit_la_zone_affichee(client, magasin_rag):
    docs.pdf_simple(magasin_rag / "sources" / "a.pdf")
    docs.pdf_recadre(magasin_rag / "sources" / "crop.pdf", magasin_rag / "sources" / "a.pdf")
    image = _image(_rendre(client, "sources/crop.pdf", dpi=72))
    assert image.size == (460, 600)
    para = json_blocs(client, "sources/crop.pdf")[-1]
    assert _sombre(image, para["boxes"][0]) > 0.04


def test_page_en_paysage_par_rotate_garde_le_repere_de_l_ecran(client, magasin_rag):
    docs.pdf_paysage(magasin_rag / "sources" / "p.pdf")
    bloc = json_blocs(client, "sources/p.pdf")[0]
    assert bloc["text"] == "Bonjour le monde en paysage"
    image = _image(_rendre(client, "sources/p.pdf", dpi=72))
    assert abs(image.width - 841.89) <= 1 and abs(image.height - 595.28) <= 1
    assert bloc["boxes"][0][0] > 500 and _sombre(image, bloc["boxes"][0]) > 0.04
    res = _localiser(client, "sources/p.pdf", "le monde en paysage")
    assert res["page"] == 1 and res["page_width"] == 841.89 and _sombre(image, res["boxes"][0]) > 0.04


def json_blocs(client, source):
    rep = client.post("/api/extract", json={"source": source, "ext": ".pdf"}, headers=ENTETE)
    return json.loads(rep.text.splitlines()[-1])["blocks"]


def test_rendu_refus(client, magasin_rag, monkeypatch):
    docs.pdf_simple(magasin_rag / "sources" / "a.pdf")
    (magasin_rag / "sources" / "n.txt").write_text("texte")
    rep = _rendre(client, "sources/a.pdf", page=2)
    assert rep.status_code == 404 and rep.json()["detail"]["code"] == "page_out_of_range"
    rep = _rendre(client, "sources/n.txt", ".txt")
    assert rep.status_code == 415 and rep.json()["detail"]["code"] == "unsupported"
    assert _rendre(client, "sources/absent.pdf").status_code == 404
    assert _rendre(client, "../a.pdf").status_code == 400
    monkeypatch.setenv("RAG_RENDER_MAX_PIXELS", "1000")
    rep = _rendre(client, "sources/a.pdf")
    assert rep.status_code == 413 and rep.json()["detail"]["code"] == "too_large"


def test_rendu_pdf_corrompu_ou_chiffre(client, magasin_rag):
    docs.pdf_simple(magasin_rag / "sources" / "a.pdf")
    docs.pdf_chiffre(magasin_rag / "sources" / "c.pdf", magasin_rag / "sources" / "a.pdf")
    (magasin_rag / "sources" / "f.pdf").write_bytes(b"%PDF-1.4 abime")
    assert _rendre(client, "sources/c.pdf").json()["detail"]["code"] == "encrypted"
    assert _rendre(client, "sources/f.pdf").json()["detail"]["code"] == "corrupt"


@pytest.mark.skipif(not AVEC_SOFFICE, reason="LibreOffice absent")
def test_docx_converti_par_soffice_puis_servi_du_cache(client, magasin_rag, monkeypatch):
    docs.docx_temoin(magasin_rag / "sources" / "g.docx")
    image = _image(_rendre(client, "sources/g.docx", ".docx"))
    assert image.width > 500
    converti = list((magasin_rag.parent / "cache" / "conv").glob("*.pdf"))
    assert len(converti) == 1 and len(converti[0].stem.split("-")[0]) == 64
    assert not list((magasin_rag.parent / "cache" / "tmp").glob("*"))

    async def interdit(*a, **k):
        raise AssertionError("soffice relancé alors que le PDF est en cache")

    monkeypatch.setattr(conversion, "_soffice", interdit)
    assert _image(_rendre(client, "sources/g.docx", ".docx")).size == image.size


@pytest.mark.skipif(not AVEC_SOFFICE, reason="LibreOffice absent")
def test_pptx_et_xlsx_ont_des_pages(client, magasin_rag):
    docs.pptx_temoin(magasin_rag / "sources" / "d.pptx")
    docs.xlsx_temoin(magasin_rag / "sources" / "v.xlsx", lignes=30)
    assert _rendre(client, "sources/d.pptx", ".pptx", page=2).status_code == 200
    assert _rendre(client, "sources/d.pptx", ".pptx", page=3).status_code == 404
    assert _rendre(client, "sources/v.xlsx", ".xlsx").status_code == 200


def test_soffice_absent_est_signale(client, magasin_rag, monkeypatch):
    docs.docx_temoin(magasin_rag / "sources" / "g.docx")
    monkeypatch.setenv("PATH", "/nulle/part")
    monkeypatch.setenv("RAG_SOFFICE_BIN", "")
    rep = _rendre(client, "sources/g.docx", ".docx")
    assert rep.status_code == 503 and rep.json()["detail"]["code"] == "soffice_unavailable"


def test_conversion_dans_la_prison_bwrap_avec_un_profil_protege(tmp_path, monkeypatch):
    travail = tmp_path / "travail"
    argv = conversion.argv_soffice("/usr/bin/soffice", travail, ".docx", "/usr/bin/bwrap")
    assert argv[0] == "/usr/bin/bwrap" and "--unshare-all" in argv and "--die-with-parent" in argv
    assert argv[argv.index("--bind") + 1:argv.index("--bind") + 3] == [str(travail), "/job"]
    assert argv[argv.index("--") + 1:] == [
        "/usr/bin/soffice", "--headless", "--norestore", "--nologo", "--nodefault", "--nolockcheck",
        "-env:UserInstallation=file:///job/profil", "--convert-to", "pdf", "--outdir", "/job/sortie",
        "/job/document.docx"]
    for interdit in ("/home", str(tmp_path.parent), os.environ.get("HOME", "/root")):
        assert not any(a == interdit for a in argv)
    sans = conversion.argv_soffice("/usr/bin/soffice", travail, ".docx", "")
    assert sans[0] == "/usr/bin/soffice" and sans[-1] == f"{travail}/document.docx"
    assert "--ro-bind" in conversion.argv_soffice("/opt/lo/program/soffice", travail, ".docx", "/usr/bin/bwrap")
    assert "BlockUntrustedRefererLinks" in conversion._PROFIL_XCU and "DisableMacrosExecution" in conversion._PROFIL_XCU
    monkeypatch.setenv("RAG_ISOLATION", "none")
    assert prison.bwrap_utilisable() == "" and prison.exiger() == ""


@pytest.mark.skipif(not AVEC_SOFFICE, reason="LibreOffice absent")
def test_profil_protege_ecrit_avant_le_lancement_et_isolation_exigee(client, magasin_rag, monkeypatch):
    docs.docx_temoin(magasin_rag / "sources" / "g.docx")
    vus = []
    vrai = conversion.asyncio.create_subprocess_exec

    async def espion(*argv, **kw):
        if "--convert-to" in argv:
            profil = Path(kw["env"]["HOME"]) / "user" / "registrymodifications.xcu"
            vus.append((argv, profil.read_text(encoding="utf-8"), kw["env"]))
        return await vrai(*argv, **kw)

    monkeypatch.setattr(conversion.asyncio, "create_subprocess_exec", espion)
    assert _rendre(client, "sources/g.docx", ".docx").status_code == 200
    argv, profil, env = vus[0]
    assert "MacroSecurityLevel" in profil and set(env) == {"PATH", "HOME", "LANG", "TMPDIR"}
    if prison.bwrap_utilisable():
        assert argv[0].endswith("bwrap") and client.get("/api/health").json()["isolated"] is True
    from docx import Document
    autre = Document()
    autre.add_paragraph("Autre document, autre empreinte.")
    autre.save(str(magasin_rag / "sources" / "h.docx"))
    monkeypatch.setenv("RAG_ISOLATION", "bwrap")
    monkeypatch.setattr(prison, "bwrap_utilisable", lambda: "")
    rep = _rendre(client, "sources/h.docx", ".docx")
    assert rep.status_code == 503 and rep.json()["detail"]["code"] == "isolation_unavailable"


@pytest.mark.skipif(not AVEC_SOFFICE, reason="LibreOffice absent")
def test_conversion_trop_longue_est_timeout_et_ne_laisse_rien(client, magasin_rag, monkeypatch):
    docs.docx_temoin(magasin_rag / "sources" / "g.docx")
    monkeypatch.setenv("RAG_SOFFICE_TIMEOUT_S", "0.2")
    rep = _rendre(client, "sources/g.docx", ".docx")
    assert rep.status_code == 504 and rep.json()["detail"]["code"] == "timeout"
    cache = magasin_rag.parent / "cache"
    assert not list((cache / "tmp").glob("*")) and not list((cache / "conv").glob("*.pdf"))


# ─── localisation ───────────────────────────────────────────────────────────
def test_localiser_un_passage_normalise_casse_espaces_et_ponctuation(client, magasin_rag):
    docs.pdf_structure(magasin_rag / "sources" / "s.pdf")
    res = _localiser(client, "sources/s.pdf", "  COLONNE   de droite.\nUn autre paragraphe, lui aussi assez long")
    assert res["page"] == 1 and res["score"] >= 0.9
    image = _image(_rendre(client, "sources/s.pdf", dpi=72))
    assert all(b[0] > 300 for b in res["boxes"])  # colonne de droite
    assert all(_sombre(image, b) > 0.04 for b in res["boxes"])


def test_localiser_choisit_la_bonne_page_avec_ou_sans_indice(client, magasin_rag):
    docs.pdf_structure(magasin_rag / "sources" / "s.pdf")
    # Chaque page 2 à 4 commence par « Contenu de la page N. » : N distingue les pages.
    for n in (2, 3, 4):
        assert _localiser(client, "sources/s.pdf", f"Contenu de la page {n}. Texte courant. Texte")["page"] == n
        assert _localiser(client, "sources/s.pdf", f"Contenu de la page {n}. Texte courant", page_hint=1)["page"] == n
        assert _localiser(client, "sources/s.pdf", f"Contenu de la page {n}. Texte courant", page_hint=n)["page"] == n


def test_localiser_ligne_coupee_par_un_trait_d_union(client, magasin_rag):
    from fpdf import FPDF
    pdf = FPDF(unit="pt", format="A4")
    pdf.add_page()
    pdf.set_font("Helvetica", "", 11)
    pdf.text(72, 100, "Le service d'informa-")
    pdf.text(72, 114, "tion de la societe est ouvert.")
    pdf.output(str(magasin_rag / "sources" / "t.pdf"))
    res = _localiser(client, "sources/t.pdf", "service d'information de la societe")
    assert res["page"] == 1 and len(res["boxes"]) >= 1 and res["score"] >= 0.9


def test_localiser_passage_absent(client, magasin_rag):
    docs.pdf_structure(magasin_rag / "sources" / "s.pdf")
    res = _localiser(client, "sources/s.pdf", "phrase qui ne figure nulle part dans le document de test")
    assert res["page"] is None and res["boxes"] == []


def test_localiser_dans_une_cellule_de_tableau(client, magasin_rag):
    docs.pdf_structure(magasin_rag / "sources" / "s.pdf")
    res = _localiser(client, "sources/s.pdf", "| Alice | 30 | Paris |")
    assert res["page"] == 1 and len(res["boxes"]) == 1 and res["boxes"][0][1] > 390


@pytest.mark.skipif(not AVEC_SOFFICE, reason="LibreOffice absent")
def test_localiser_dans_un_docx_converti(client, magasin_rag):
    docs.docx_temoin(magasin_rag / "sources" / "g.docx")
    res = _localiser(client, "sources/g.docx", "Ce guide explique comment démarrer le service.", ".docx")
    assert res["page"] == 1 and res["boxes"]


def test_localiser_refus(client, magasin_rag):
    (magasin_rag / "sources" / "n.txt").write_text("texte")
    rep = client.post("/api/locate", json={"source": "sources/n.txt", "ext": ".txt", "text": "texte"}, headers=ENTETE)
    assert rep.status_code == 415
    docs.pdf_simple(magasin_rag / "sources" / "a.pdf")
    rep = client.post("/api/locate", json={"source": "sources/a.pdf", "ext": ".pdf", "text": "... --- ..."}, headers=ENTETE)
    assert rep.status_code == 422 and rep.json()["detail"]["code"] == "empty_text"
