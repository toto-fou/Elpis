# SPDX-License-Identifier: MIT
# tests/rag_app/_extracteur_docs.py — documents témoins générés à la volée (aucun binaire commité).
from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path


def pdf_simple(chemin: Path) -> None:
    """Titre en gras 20 pt à (72, 100) et un paragraphe de 11 pt à (72, 130), unité = point."""
    from fpdf import FPDF
    pdf = FPDF(unit="pt", format="A4")
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 20)
    pdf.text(72, 100, "Titre principal")
    pdf.set_font("Helvetica", "", 11)
    pdf.set_xy(72, 130)
    pdf.multi_cell(200, 14, "Premier paragraphe de texte assez long pour passer a la ligne et tester les boites.")
    pdf.output(str(chemin))


def pdf_structure(chemin: Path) -> None:
    """Quatre pages : en-tête et pied répétés, titres de trois niveaux, deux colonnes, liste, tableau à bordures."""
    from fpdf import FPDF
    pdf = FPDF(unit="pt", format="A4")
    for p in range(1, 5):
        pdf.add_page()
        pdf.set_font("Helvetica", "", 9)
        pdf.text(72, 40, "Rapport annuel - confidentiel")
        pdf.text(280, 810, f"Page {p}")
        if p > 1:
            pdf.set_font("Helvetica", "", 11)
            pdf.set_xy(72, 100)
            pdf.multi_cell(450, 14, f"Contenu de la page {p}. " + "Texte courant. " * 30)
            continue
        pdf.set_font("Helvetica", "B", 22)
        pdf.text(72, 100, "Rapport sur le climat")
        pdf.set_font("Helvetica", "B", 14)
        pdf.text(72, 140, "1. Introduction")
        pdf.set_font("Helvetica", "", 11)
        pdf.set_xy(72, 150)
        pdf.multi_cell(220, 14, "Colonne de gauche. Ceci est un long paragraphe qui se poursuit sur plusieurs lignes "
                                "pour tester la lecture en colonnes et l'ordre de lecture du document.")
        pdf.set_xy(320, 150)
        pdf.multi_cell(220, 14, "Colonne de droite. Un autre paragraphe, lui aussi assez long pour passer a la "
                                "ligne plusieurs fois de suite dans la page.")
        pdf.set_font("Helvetica", "B", 11)
        pdf.text(72, 300, "Une sous-partie en gras")
        pdf.set_font("Helvetica", "", 11)
        pdf.set_xy(72, 310)
        pdf.multi_cell(450, 14, "- premier point de liste\n- deuxieme point de liste qui est assez long pour passer "
                                "sur une deuxieme ligne dans la page\n- troisieme point")
        pdf.set_xy(72, 400)
        pdf.set_font("Helvetica", "", 10)
        with pdf.table(col_widths=(100, 100, 100), text_align="LEFT") as table:
            for rang in (("Nom", "Age", "Ville"), ("Alice", "30", "Paris"), ("Bob", "25", "Lyon")):
                ligne = table.row()
                for cellule in rang:
                    ligne.cell(cellule)
    pdf.output(str(chemin))


def pdf_sans_texte(chemin: Path) -> None:
    """Une page qui ne contient qu'une image : aucune couche de texte."""
    from fpdf import FPDF
    from PIL import Image
    image = Image.new("RGB", (200, 100), (230, 230, 230))
    pdf = FPDF(unit="pt", format="A4")
    pdf.add_page()
    pdf.image(image, x=72, y=100, w=300)
    pdf.output(str(chemin))


def pdf_scan_ocr(chemin: Path) -> None:
    """Deux pages image dont la seconde porte du texte : la première reste sans texte."""
    from fpdf import FPDF
    from PIL import Image
    pdf = FPDF(unit="pt", format="A4")
    for _ in range(2):
        pdf.add_page()
        pdf.image(Image.new("RGB", (100, 100), (250, 250, 250)), x=0, y=0, w=595, h=842)
    pdf.output(str(chemin))


def pdf_chiffre(chemin: Path, source: Path, utilisateur: str = "secret", algorithme: str = "AES-128") -> None:
    from pypdf import PdfReader, PdfWriter
    ecrivain = PdfWriter()
    ecrivain.append(PdfReader(str(source)))
    ecrivain.encrypt(utilisateur, owner_password="proprietaire", algorithm=algorithme)
    with open(chemin, "wb") as fh:
        ecrivain.write(fh)


def pdf_paysage(chemin: Path) -> None:
    """Texte écrit couché dans le contenu, remis droit à l'écran par /Rotate 90 (page affichée de 842 x 595 pt)."""
    from fpdf import FPDF
    from pypdf import PdfReader, PdfWriter
    pdf = FPDF(unit="pt", format="A4")
    pdf.add_page()
    pdf.set_font("Helvetica", "", 14)
    with pdf.rotation(90, 100, 300):
        pdf.text(100, 300, "Bonjour le monde en paysage")
    brut = chemin.with_suffix(".brut.pdf")
    pdf.output(str(brut))
    ecrivain = PdfWriter()
    ecrivain.append(PdfReader(str(brut)))
    ecrivain.pages[0].rotate(90)
    with open(chemin, "wb") as fh:
        ecrivain.write(fh)
    brut.unlink()


def pdf_recadre(chemin: Path, source: Path) -> None:
    """Zone d'affichage (CropBox) décalée de (40, 60) points par rapport à la MediaBox."""
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import RectangleObject
    ecrivain = PdfWriter()
    ecrivain.append(PdfReader(str(source)))
    ecrivain.pages[0].cropbox = RectangleObject([40, 100, 500, 700])
    with open(chemin, "wb") as fh:
        ecrivain.write(fh)


def docx_temoin(chemin: Path) -> None:
    from docx import Document
    doc = Document()
    doc.core_properties.title = "Guide de test"
    doc.add_heading("Guide de démarrage", level=1)
    doc.add_paragraph("Ce guide explique comment démarrer le service.")
    doc.add_heading("Installation", level=2)
    doc.add_paragraph("Premier élément", style="List Bullet")
    doc.add_paragraph("Second élément", style="List Bullet")
    doc.add_paragraph("Étape une", style="List Number")
    doc.add_paragraph("Étape deux", style="List Number")
    tableau = doc.add_table(rows=3, cols=2)
    for i, (a, b) in enumerate((("Nom", "Valeur"), ("port", "8000"), ("hôte", "localhost"))):
        tableau.rows[i].cells[0].text, tableau.rows[i].cells[1].text = a, b
    from docx.oxml import parse_xml
    from docx.oxml.ns import nsdecls
    controle = parse_xml(f'<w:sdt {nsdecls("w")}><w:sdtContent><w:p><w:r><w:t>Dans un contrôle de contenu</w:t></w:r>'
                         "</w:p></w:sdtContent></w:sdt>")
    doc.element.body.insert(len(doc.element.body) - 1, controle)
    doc.add_paragraph("Fin du document.")
    doc.save(str(chemin))


def pptx_temoin(chemin: Path) -> None:
    from pptx import Presentation
    from pptx.util import Inches
    prs = Presentation()
    diapo = prs.slides.add_slide(prs.slide_layouts[1])
    diapo.shapes.title.text = "Bilan trimestriel"
    diapo.placeholders[1].text_frame.text = "Chiffre d'affaires en hausse"
    diapo.placeholders[1].text_frame.add_paragraph().text = "Nouveaux clients"
    diapo.notes_slide.notes_text_frame.text = "Insister sur la croissance."
    diapo2 = prs.slides.add_slide(prs.slide_layouts[5])
    diapo2.shapes.title.text = "Détail des ventes"
    table = diapo2.shapes.add_table(2, 2, Inches(1), Inches(2), Inches(4), Inches(1)).table
    for i, v in enumerate(("Région", "Ventes", "Nord", "120")):
        table.cell(i // 2, i % 2).text = v
    prs.save(str(chemin))


def xlsx_temoin(chemin: Path, lignes: int = 100) -> None:
    from openpyxl import Workbook
    classeur = Workbook()
    feuille = classeur.active
    feuille.title = "Ventes"
    feuille.append(["Produit", "Quantité", "Prix"])
    for i in range(lignes):
        feuille.append([f"article-{i:03d}", i, round(i * 1.5, 2)])
    autre = classeur.create_sheet("Notes")
    autre.append(["Remarque"])
    autre.append(["Données de test"])
    classeur.create_sheet("Vide")
    classeur.save(str(chemin))


def docx_piege(chemin: Path, mo: int = 80) -> None:
    """DOCX valide, minuscule sur disque, dont le XML principal se décompresse en `mo` Mo."""
    from docx import Document
    modele = chemin.with_suffix(".modele.docx")
    Document().save(str(modele))
    with zipfile.ZipFile(modele) as src, zipfile.ZipFile(chemin, "w", zipfile.ZIP_DEFLATED) as dst:
        for entree in src.infolist():
            if entree.filename != "word/document.xml":
                dst.writestr(entree, src.read(entree.filename))
                continue
            xml = src.read(entree.filename).decode("utf-8")
            debut, fin = xml.split("<w:body>")[0] + "<w:body>", "</w:body></w:document>"
            motif = ("<w:p><w:r><w:t>aaaaaaaa</w:t></w:r></w:p>" * 2000).encode("utf-8")
            with dst.open(entree.filename, "w") as sortie:
                sortie.write(debut.encode("utf-8"))
                for _ in range(mo * 1024 * 1024 // len(motif)):
                    sortie.write(motif)
                sortie.write(fin.encode("utf-8"))
    modele.unlink()


TEXTES = {
    "note.txt": "Premier paragraphe.\nSuite du premier.\n\nSecond paragraphe.\n",
    "doc.md": "---\ntitle: Titre du front matter\n---\n# Titre un\n\nParagraphe un\nsur deux lignes.\n\n## Sous-titre\n\n"
              "- a\n- b\n  - c\n\n| x | y |\n| --- | --- |\n| 1 | 2 |\n\n```python\nprint('ok')\n```\n\nFin.\n",
    "page.html": "<html><head><title>Ma page</title><style>p{}</style></head><body><h1>Titre HTML</h1>"
                "<p>Un <b>paragraphe</b> simple.</p><script>var x=1;</script><ul><li>un</li><li>deux<ul><li>sous</li></ul></li></ul>"
                "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><pre>code  indente</pre></body></html>",
    "code.py": "def f():\n    return 1\n\n\ndef g():\n    return 2\n",
    "data.json": json.dumps({"a": 1, "b": [1, 2]}, indent=2),
    "conf.yaml": "nom: test\nliste:\n  - un\n  - deux\n",
    "table.csv": "nom;age\nAlice;30\nBob;25\n",
}


def pdf_mixte(chemin: Path) -> None:
    """Page 1 avec du texte, page 2 réduite à une image (à passer à l'OCR)."""
    from fpdf import FPDF
    from PIL import Image
    pdf = FPDF(unit="pt", format="A4")
    pdf.add_page()
    pdf.set_font("Helvetica", "", 11)
    pdf.text(72, 100, "Page de texte natif lisible sans OCR.")
    pdf.add_page()
    pdf.image(Image.new("RGB", (100, 100), (250, 250, 250)), x=0, y=0, w=595, h=842)
    pdf.output(str(chemin))
