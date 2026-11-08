# SPDX-License-Identifier: MIT
"""office/elpis_office/rendu_pdf.py — rendu de pages d'un PDF en PNG, lancé par office_preview dans un processus à part (temps et mémoire bornés)."""
from __future__ import annotations

import base64
import io
import json
import resource
import sys

CPU_S, MEMOIRE = 30, 1 << 30
TEXTE_MAX, PAGES_LUES_MAX, TEXTE_PAGE_MAX = 1500, 1000, 20_000


def main() -> int:
    resource.setrlimit(resource.RLIMIT_CPU, (CPU_S, CPU_S + 5))       # PDF piégé : le noyau l'arrête
    resource.setrlimit(resource.RLIMIT_AS, (MEMOIRE, MEMOIRE))
    entete, _, pdf = sys.stdin.buffer.read().partition(b"\n")
    demande = json.loads(entete)
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(pdf)
    try:
        total = len(doc)
        if demande.get("textes"):                  # texte de chaque page, sans rendu (numéros du sommaire)
            sys.stdout.write(json.dumps({"total": total, "textes": [_texte(doc, n)[:TEXTE_PAGE_MAX]
                                                                    for n in range(1, min(total, PAGES_LUES_MAX) + 1)]}))
            return 0
        pages = [n for n in demande["pages"] if 1 <= n <= total]
        rendus = []
        for n in pages:
            page = doc[n - 1]
            try:
                largeur, hauteur = page.get_size()
                image = page.render(scale=demande["cote"] / max(largeur, hauteur, 1)).to_pil()
                textes = page.get_textpage()
                try:
                    texte = textes.get_text_range().replace("\r\n", "\n").strip()
                finally:
                    textes.close()
            finally:
                page.close()
            tampon = io.BytesIO()
            image.convert("RGB").save(tampon, "PNG", optimize=True)
            rendus.append({"page": n, "size": f"{image.width}x{image.height}",
                           "text": texte if len(texte) <= TEXTE_MAX else texte[:TEXTE_MAX] + "…",
                           "png": base64.b64encode(tampon.getvalue()).decode("ascii")})
    finally:
        doc.close()
    sys.stdout.write(json.dumps({"total": total, "pages": rendus}))
    return 0


def _texte(doc, n: int) -> str:
    page = doc[n - 1]
    try:
        textes = page.get_textpage()
        try:
            return textes.get_text_range().replace("\r\n", "\n")
        finally:
            textes.close()
    finally:
        page.close()


if __name__ == "__main__":
    sys.exit(main())
