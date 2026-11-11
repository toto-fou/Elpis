# SPDX-License-Identifier: MIT
# tests/rag_app/test_extracteur_formats.py — extraction par format : blocs, titres, tableaux, pages et boîtes.
from __future__ import annotations

import json
import shutil

import pytest
from fastapi.testclient import TestClient

from rag_app import app as A

from . import _extracteur_docs as docs

ENTETE = {"Authorization": "Bearer jeton-test"}


@pytest.fixture
def client():
    return TestClient(A.app, client=("127.0.0.1", 50000))


@pytest.fixture
def extraire(client, magasin_rag):
    def _extraire(nom: str, **corps):
        ext = "." + nom.rsplit(".", 1)[1]
        rep = client.post("/api/extract", json={"source": f"sources/{nom}", "ext": ext, **corps}, headers=ENTETE)
        assert rep.status_code == 200, rep.text
        lignes = [json.loads(ligne) for ligne in rep.text.splitlines()]
        return lignes[-1], lignes[:-1]
    return _extraire


def _resultat(final):
    assert final["type"] == "result", final
    return final["meta"], final["blocks"], final["warnings"]


def _sources(magasin_rag):
    return magasin_rag / "sources"


# ─── PDF ────────────────────────────────────────────────────────────────────
def test_pdf_blocs_pages_et_boites_en_points(extraire, magasin_rag):
    docs.pdf_simple(_sources(magasin_rag) / "a.pdf")
    meta, blocs, _ = _resultat(extraire("a.pdf")[0])
    assert meta == {"pages": 1, "title": "Titre principal", "text_layer": True, "mime": "application/pdf"}
    titre, para = blocs
    assert (titre["kind"], titre["level"], titre["page"]) == ("heading", 1, 1)
    # Origine en haut à gauche : le texte posé à y = 100 pt (ligne de base) est AU-DESSUS de y = 130 pt.
    x0, y0, x1, y1 = titre["boxes"][0]
    assert 70 < x0 < 76 and 80 < y0 < 90 and 100 < y1 < 108 and 200 < x1 < 210
    assert para["kind"] == "paragraph" and para["text"].startswith("Premier paragraphe de texte")
    assert para["boxes"][0][1] > y1
    assert all(len(b) == 4 for b in para["boxes"])


def test_pdf_progress_puis_result(extraire, magasin_rag):
    docs.pdf_structure(_sources(magasin_rag) / "s.pdf")
    final, progres = extraire("s.pdf")
    assert final["type"] == "result"
    assert progres and all(p["type"] == "progress" and p["total"] == 4 for p in progres)
    assert progres[-1]["done"] == 4


def test_pdf_structure_titres_listes_tableaux_colonnes(extraire, magasin_rag):
    docs.pdf_structure(_sources(magasin_rag) / "s.pdf")
    meta, blocs, _ = _resultat(extraire("s.pdf")[0])
    titres = [(b["level"], b["text"]) for b in blocs if b["kind"] == "heading"]
    assert titres == [(1, "Rapport sur le climat"), (2, "1. Introduction"), (3, "Une sous-partie en gras")]
    textes = [b["text"] for b in blocs if b["kind"] == "paragraph" and b["page"] == 1]
    # Deux colonnes : chacune forme son propre paragraphe, sans lignes entrelacées.
    assert textes[0].startswith("Colonne de gauche") and "Colonne de droite" not in textes[0]
    assert textes[1].startswith("Colonne de droite")
    liste = next(b for b in blocs if b["kind"] == "list")
    assert liste["text"].splitlines()[0] == "- premier point de liste" and len(liste["text"].splitlines()) == 3
    tableau = next(b for b in blocs if b["kind"] == "table")
    assert tableau["text"].splitlines()[0] == "| Nom | Age | Ville |" and "| Bob | 25 | Lyon |" in tableau["text"]
    # En-tête et pied de page répétés sur chaque page : retirés.
    assert not any("confidentiel" in b["text"] or b["text"].startswith("Page ") for b in blocs)
    assert meta["pages"] == 4 and {b["page"] for b in blocs} == {1, 2, 3, 4}


def test_pdf_sans_texte_est_no_text(extraire, magasin_rag):
    docs.pdf_sans_texte(_sources(magasin_rag) / "scan.pdf")
    final, _ = extraire("scan.pdf")
    assert final["type"] == "error" and final["code"] == "no_text"
    assert "OCR" in final["message"]


def test_pdf_chiffre_est_encrypted(extraire, magasin_rag):
    docs.pdf_simple(_sources(magasin_rag) / "clair.pdf")
    docs.pdf_chiffre(_sources(magasin_rag) / "chiffre.pdf", _sources(magasin_rag) / "clair.pdf")
    final, _ = extraire("chiffre.pdf")
    assert final["type"] == "error" and final["code"] == "encrypted"


@pytest.mark.parametrize("algorithme", ["AES-128", "AES-256", "RC4-128"])
def test_pdf_protege_sans_mot_de_passe_utilisateur_reste_lisible(extraire, magasin_rag, algorithme):
    docs.pdf_simple(_sources(magasin_rag) / "clair.pdf")
    docs.pdf_chiffre(_sources(magasin_rag) / "restreint.pdf", _sources(magasin_rag) / "clair.pdf", "", algorithme)
    meta, blocs, _ = _resultat(extraire("restreint.pdf")[0])
    assert blocs[0]["text"] == "Titre principal"


def test_pdf_corrompu(extraire, magasin_rag):
    (_sources(magasin_rag) / "faux.pdf").write_bytes(b"%PDF-1.4\nce n'est pas un vrai pdf" + b"\x00" * 50)
    final, _ = extraire("faux.pdf")
    assert final["type"] == "error" and final["code"] == "corrupt"


def test_pdf_page_pivotee_et_recadree_gardent_le_repere_de_la_page_affichee(extraire, magasin_rag):
    docs.pdf_simple(_sources(magasin_rag) / "a.pdf")
    docs.pdf_recadre(_sources(magasin_rag) / "crop.pdf", _sources(magasin_rag) / "a.pdf")
    _, blocs, _ = _resultat(extraire("crop.pdf")[0])
    # CropBox [40, 100, 500, 700] : le titre (x = 72, y_haut = 84) devient x = 32, y = 84 - (842 - 700) = -58 : hors zone.
    textes = [b["text"] for b in blocs]
    assert "Titre principal" not in textes
    para = next(b for b in blocs if b["kind"] == "paragraph")
    x0, y0, _, _ = para["boxes"][0]
    assert 30 < x0 < 40 and 0 < y0 < 40


# ─── Office ─────────────────────────────────────────────────────────────────
def test_docx_titres_listes_tableaux(extraire, magasin_rag):
    docs.docx_temoin(_sources(magasin_rag) / "g.docx")
    meta, blocs, _ = _resultat(extraire("g.docx")[0])
    assert meta["title"] == "Guide de test" and meta["pages"] is None and meta["text_layer"] is True
    assert meta["mime"].endswith("wordprocessingml.document")
    assert [(b["kind"], b.get("level")) for b in blocs[:3]] == [("heading", 1), ("paragraph", None), ("heading", 2)]
    listes = [b["text"] for b in blocs if b["kind"] == "list"]
    assert listes == ["- Premier élément\n- Second élément", "1. Étape une\n2. Étape deux"]
    tableau = next(b for b in blocs if b["kind"] == "table")
    assert tableau["text"] == "| Nom | Valeur |\n| --- | --- |\n| port | 8000 |\n| hôte | localhost |"
    assert [b["text"] for b in blocs[-2:]] == ["Dans un contrôle de contenu", "Fin du document."]


def test_pptx_une_diapositive_est_une_page(extraire, magasin_rag):
    docs.pptx_temoin(_sources(magasin_rag) / "d.pptx")
    meta, blocs, _ = _resultat(extraire("d.pptx")[0])
    assert meta["pages"] == 2 and meta["title"] == "Bilan trimestriel"
    t1 = blocs[0]
    assert (t1["kind"], t1["level"], t1["page"], t1["slide"]) == ("heading", 1, 1, 1)
    assert t1["boxes"] and len(t1["boxes"][0]) == 4
    assert any(b["kind"] == "list" and "Nouveaux clients" in b["text"] and b["page"] == 1 for b in blocs) or any(
        b["kind"] == "paragraph" and "Chiffre d'affaires" in b["text"] for b in blocs)
    assert any(b["text"] == "Notes : Insister sur la croissance." for b in blocs)
    tableau = next(b for b in blocs if b["kind"] == "table")
    assert tableau["page"] == 2 and tableau["text"].startswith("| Région | Ventes |")


def test_xlsx_feuilles_en_tableaux_avec_entete_repetee(extraire, magasin_rag):
    docs.xlsx_temoin(_sources(magasin_rag) / "v.xlsx", lignes=100)
    meta, blocs, _ = _resultat(extraire("v.xlsx")[0])
    ventes = [b for b in blocs if b["kind"] == "table" and b["sheet"] == "Ventes"]
    assert len(ventes) == 3 and all(b["text"].startswith("| Produit | Quantité | Prix |") for b in ventes)
    assert "| article-099 | 99 | 148.5 |" in ventes[-1]["text"]
    assert [b["text"] for b in blocs if b["kind"] == "heading"] == ["Ventes", "Notes"]  # la feuille vide est ignorée
    assert any(b["sheet"] == "Notes" and "Données de test" in b["text"] for b in blocs if b["kind"] == "table")


def test_ooxml_chiffre_et_corrompu(extraire, magasin_rag):
    (_sources(magasin_rag) / "ole.docx").write_bytes(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 100)
    (_sources(magasin_rag) / "mauvais.xlsx").write_bytes(b"PK\x03\x04pas une archive")
    assert extraire("ole.docx")[0]["code"] == "encrypted"
    assert extraire("mauvais.xlsx")[0]["code"] == "corrupt"


def test_archive_piegee_est_too_large_sans_la_decompresser(extraire, magasin_rag, monkeypatch):
    monkeypatch.setenv("RAG_EXTRACT_ZIP_MAX_MB", "50")
    docs.docx_piege(_sources(magasin_rag) / "bombe.docx", mo=80)
    assert (_sources(magasin_rag) / "bombe.docx").stat().st_size < 1_000_000
    assert extraire("bombe.docx")[0]["code"] == "too_large"


def test_memoire_epuisee_dans_l_enfant_est_too_large(extraire, magasin_rag, monkeypatch):
    monkeypatch.setenv("RAG_EXTRACT_MEM_MB", "450")
    morceau = b"ligne de texte ordinaire\n" * 40_000
    with open(_sources(magasin_rag) / "enorme.txt", "wb") as fh:
        for _ in range(110):
            fh.write(morceau)
    assert extraire("enorme.txt")[0]["code"] == "too_large"


# ─── Texte ──────────────────────────────────────────────────────────────────
def test_texte_brut_et_markdown(extraire, magasin_rag):
    for nom, contenu in docs.TEXTES.items():
        (_sources(magasin_rag) / nom).write_text(contenu, encoding="utf-8")
    meta, blocs, _ = _resultat(extraire("note.txt")[0])
    assert [b["text"] for b in blocs] == ["Premier paragraphe.\nSuite du premier.", "Second paragraphe."]
    assert meta["mime"] == "text/plain" and meta["pages"] is None
    meta, blocs, _ = _resultat(extraire("doc.md")[0])
    assert meta["title"] == "Titre du front matter"
    assert [(b["kind"], b.get("level")) for b in blocs] == [
        ("heading", 1), ("paragraph", None), ("heading", 2), ("list", None), ("table", None), ("code", None),
        ("paragraph", None)]
    assert blocs[1]["text"] == "Paragraphe un sur deux lignes."
    assert blocs[3]["text"] == "- a\n- b\n  - c" and blocs[5]["text"] == "print('ok')"


def test_html_titres_listes_tableaux_et_scripts_ignores(extraire, magasin_rag):
    (_sources(magasin_rag) / "page.html").write_text(docs.TEXTES["page.html"], encoding="utf-8")
    meta, blocs, _ = _resultat(extraire("page.html")[0])
    assert meta["title"] == "Ma page"
    assert [(b["kind"], b["text"]) for b in blocs] == [
        ("heading", "Titre HTML"), ("paragraph", "Un paragraphe simple."), ("list", "- un\n- deux\n  - sous"),
        ("table", "| A | B |\n| --- | --- |\n| 1 | 2 |"), ("code", "code  indente")]
    assert blocs[0]["level"] == 1
    assert not any("var x" in b["text"] or "p{}" in b["text"] for b in blocs)


def test_code_json_yaml_csv(extraire, magasin_rag):
    for nom, contenu in docs.TEXTES.items():
        (_sources(magasin_rag) / nom).write_text(contenu, encoding="utf-8")
    _, blocs, _ = _resultat(extraire("code.py")[0])
    assert all(b["kind"] == "code" for b in blocs) and "def g():" in blocs[-1]["text"]
    meta, blocs, _ = _resultat(extraire("data.json")[0])
    assert blocs[0]["kind"] == "code" and meta["mime"] == "application/json"
    _, blocs, _ = _resultat(extraire("conf.yaml")[0])
    assert "nom: test" in blocs[0]["text"]
    _, blocs, _ = _resultat(extraire("table.csv")[0])
    assert blocs == [{"kind": "table", "text": "| nom | age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |"}]


def test_csv_en_flux_decoupe_par_paquets(extraire, magasin_rag):
    lignes = ["id,valeur"] + [f"{i},v{i}" for i in range(500)]
    (_sources(magasin_rag) / "gros.csv").write_text("\n".join(lignes), encoding="utf-8")
    _, blocs, _ = _resultat(extraire("gros.csv")[0])
    assert len(blocs) == 13 and all(b["text"].startswith("| id | valeur |") for b in blocs)
    assert "| 499 | v499 |" in blocs[-1]["text"]


def test_encodage_latin1_et_binaire(extraire, magasin_rag):
    (_sources(magasin_rag) / "vieux.txt").write_bytes("Café crème à l'été".encode("latin-1"))
    (_sources(magasin_rag) / "binaire.txt").write_bytes(b"abc\x00\x01\x02def" * 100)
    _, blocs, _ = _resultat(extraire("vieux.txt")[0])
    assert blocs[0]["text"] == "Café crème à l'été"
    assert extraire("binaire.txt")[0]["code"] == "corrupt"


def test_max_chars_tronque_avec_avertissement(extraire, magasin_rag):
    (_sources(magasin_rag) / "long.txt").write_text("\n\n".join(f"Paragraphe numéro {i} " + "x" * 90 for i in range(50)))
    meta, blocs, avertissements = _resultat(extraire("long.txt", max_chars=1000)[0])
    assert sum(len(b["text"]) for b in blocs) <= 1000
    assert [a["code"] for a in avertissements] == ["truncated"]


def test_fichier_vide_est_no_text(extraire, magasin_rag):
    (_sources(magasin_rag) / "vide.txt").write_text("  \n\n ")
    assert extraire("vide.txt")[0]["code"] == "no_text"


def test_taille_maximale(extraire, magasin_rag, monkeypatch):
    monkeypatch.setenv("RAG_EXTRACT_MAX_BYTES", "100")
    (_sources(magasin_rag) / "gros.txt").write_text("x" * 500)
    assert extraire("gros.txt")[0]["code"] == "too_large"
