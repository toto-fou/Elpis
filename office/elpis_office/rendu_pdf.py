# SPDX-License-Identifier: MIT
"""office/elpis_office/rendu_pdf.py — rendu de pages d'un PDF en PNG, lancé par office_preview dans un processus à part (temps et mémoire bornés)."""
from __future__ import annotations

import base64
import io
import json
import resource
import sys

CPU_S, MEMOIRE = 30, 1 << 30
TEXTE_MAX, SIGNETS_MAX = 1500, 5000
PAGES_BLANCS, OBJETS_MAX = 400, 20000
IMAGE, TRACE, FORME = 3, 2, 5                      # FPDF_PAGEOBJ_*


def mesurer(doc, total: int) -> list:
    """Par page : bas du contenu (points depuis le bas, pied de page exclu) et figure en tête de page."""
    mesures = []
    for i in range(min(total, PAGES_BLANCS)):
        page = doc[i]
        try:
            largeur, hauteur = page.get_size()
            objets = []
            for n, objet in enumerate(page.get_objects(max_depth=1)):
                if n >= OBJETS_MAX:
                    break
                _, bas, _, haut = objet.get_bounds()
                if haut > 0.09 * hauteur and bas < 0.93 * hauteur:     # hors pied et en-tête
                    objets.append((objet.type, bas, haut))
            if not objets:
                mesures.append({"h": hauteur, "bas": None, "figure": False, "debut": ""})
                continue
            sommet = max(h for _, _, h in objets)
            tete = [t for t, _, h in objets if h >= sommet - 0.35 * hauteur]
            textes = page.get_textpage()
            try:
                debut = textes.get_text_bounded(0, sommet - 0.5 * hauteur, largeur, sommet)[:400]
            finally:
                textes.close()
            # Plus grande bande vide entre deux contenus dans la moitié basse (au-dessus des notes de bas de page).
            trou, fin = 0.0, None
            for _, b, h in sorted(objets, key=lambda o: -o[2]):
                if fin is not None and h < fin and fin <= 0.5 * hauteur:
                    trou = max(trou, fin - h)
                fin = b if fin is None else min(fin, b)
            mesures.append({"h": hauteur, "bas": min(b for _, b, _ in objets), "trou": trou, "debut": debut,
                            "figure": any(t in (IMAGE, FORME) for t in tete) or tete.count(TRACE) >= 8})
        finally:
            page.close()
    return mesures


def main() -> int:
    resource.setrlimit(resource.RLIMIT_CPU, (CPU_S, CPU_S + 5))       # PDF piégé : le noyau l'arrête
    resource.setrlimit(resource.RLIMIT_AS, (MEMOIRE, MEMOIRE))
    entete, _, pdf = sys.stdin.buffer.read().partition(b"\n")
    demande = json.loads(entete)
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(pdf)
    try:
        total = len(doc)
        if demande.get("blancs"):                  # pages qui finissent tôt : figure suivante trop haute
            sys.stdout.write(json.dumps({"total": total, "blancs": mesurer(doc, total)}))
            return 0
        if demande.get("signets"):                 # signets du PDF (un par titre) : page exacte de chaque titre
            signets = []
            for item in doc.get_toc():
                cible = item.get_dest()
                signets.append({"titre": item.get_title()[:500],
                                "page": cible.get_index() if cible is not None else None})
                if len(signets) >= SIGNETS_MAX:
                    break
            sys.stdout.write(json.dumps({"total": total, "signets": signets}))
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


if __name__ == "__main__":
    sys.exit(main())
