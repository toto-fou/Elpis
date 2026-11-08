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


def _objets(doc, i: int) -> tuple:
    """(largeur, hauteur, objets (type, bas, haut, hauteur utile), texte du haut de page) d'une page."""
    page = doc[i]
    try:
        largeur, hauteur = page.get_size()
        objets = []
        for n, objet in enumerate(page.get_objects(max_depth=1)):
            if n >= OBJETS_MAX:
                break
            try:
                gauche, bas, droite, haut = objet.get_bounds()
            except Exception:                      # noqa: BLE001 — un objet illisible ne compte pas
                continue
            objets.append((objet.type, round(gauche), round(bas), round(droite), round(haut)))
        textes = page.get_textpage()
        try:
            debut = textes.get_text_bounded(0, 0.45 * hauteur, largeur, 0.93 * hauteur)[:400]
        finally:
            textes.close()
    finally:
        page.close()
    return largeur, hauteur, objets, debut


def mesurer(doc, total: int) -> list:
    """Par page : bas du contenu, plus grand vide au-dessus des notes, figure en tête et sa hauteur (en points)."""
    pages = [_objets(doc, i) for i in range(min(total, PAGES_BLANCS))]
    reperes: dict = {}
    for _, hauteur, objets, _ in pages:
        for o in set(objets):
            if o[2] > 0.80 * hauteur or o[4] < 0.15 * hauteur:
                reperes[o] = reperes.get(o, 0) + 1
    meubles = {o for o, n in reperes.items() if n >= max(2, len(pages) // 2)}
    mesures = []
    for _, hauteur, objets, debut in pages:
        corps = sorted((o for o in objets if o not in meubles and o[4] > 0.09 * hauteur and o[2] < 0.93 * hauteur),
                       key=lambda o: -o[4])
        if not corps:
            mesures.append({"h": hauteur, "bas": None, "trou": 0, "figure": False, "bloc": 0, "debut": debut})
            continue
        trou, fin = 0, None
        for o in corps:
            if fin is not None and o[4] < fin and o[4] <= 0.35 * hauteur:
                trou = max(trou, fin - o[4])
            fin = o[2] if fin is None else min(fin, o[2])
        tete = next((o for o in corps if o[0] in (IMAGE, FORME) or (o[0] == TRACE and o[4] - o[2] > 28)), None)
        figure = tete is not None and tete[4] >= corps[0][4] - 60
        bloc_haut = bloc_bas = corps[0][4]
        for _, _, bas, _, haut in corps:
            if haut < bloc_bas - 24:
                break
            bloc_bas = min(bloc_bas, bas)
        mesures.append({"h": hauteur, "bas": min(o[2] for o in corps), "trou": trou, "figure": figure,
                        "bloc": bloc_haut - bloc_bas, "debut": debut})
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
        if demande.get("blancs"):
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
