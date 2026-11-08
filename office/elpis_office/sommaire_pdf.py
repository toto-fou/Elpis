# SPDX-License-Identifier: MIT
"""office/elpis_office/sommaire_pdf.py — numéros du sommaire dans le PDF d'un .docx : un premier rendu situe chaque titre, les numéros vont dans une copie, un second rendu les montre ; le fichier n'est jamais modifié."""
from __future__ import annotations

import io
import re
from typing import Any, Callable, List, Optional, Tuple

from ._docx.ooxml.util import make, qn

_PAGEREF = re.compile(r"^\s*PAGEREF\s+(\S+)", re.IGNORECASE)
_POINTILLES = re.compile(r"\.{4,}\s*\d*\s*$")
_ESPACES = re.compile(r"\s+")


def _normal(texte: str) -> str:
    return _ESPACES.sub(" ", texte).strip().casefold()


def entrees_sans_numero(document: Any) -> List[Tuple[Any, str]]:
    """(élément fldChar « separate », texte du titre visé) des renvois PAGEREF du corps sans numéro enregistré."""
    signets = {b.get(qn("w:name")): b.getparent() for b in document.element.body.iter(qn("w:bookmarkStart"))}
    entrees = []
    for p in document.element.body.iter(qn("w:p")):
        instruction, separe, vide = None, None, True
        for noeud in p.iter(qn("w:instrText"), qn("w:fldChar"), qn("w:t")):
            if noeud.tag == qn("w:instrText"):
                m = _PAGEREF.match(noeud.text or "")
                instruction = m.group(1) if m else instruction
            elif noeud.tag == qn("w:fldChar") and noeud.get(qn("w:fldCharType")) == "separate":
                separe, vide = noeud, True
            elif noeud.tag == qn("w:fldChar") and noeud.get(qn("w:fldCharType")) == "end":
                cible = signets.get(instruction)
                if separe is not None and vide and cible is not None and cible.tag == qn("w:p"):
                    titre = "".join(t.text or "" for t in cible.iter(qn("w:t"))).strip()
                    if titre:
                        entrees.append((separe, titre))
                instruction, separe = None, None
            elif noeud.tag == qn("w:t") and separe is not None and (noeud.text or "").strip():
                vide = False
    return entrees


def situer(titres: List[str], pages: List[str]) -> List[Optional[int]]:
    """Page (à partir de 1) de chaque titre, dans l'ordre du document, après les pages du sommaire lui-même."""
    lignes = [[_normal(x) for x in page.split("\n") if x.strip()] for page in pages]
    sommaire = [i for i, ls in enumerate(lignes) if any(_POINTILLES.search(x) for x in ls)]
    courant = sommaire[0] + 1 if sommaire else 0
    while courant in sommaire:                      # les pages du sommaire se suivent
        courant += 1
    trouves: List[Optional[int]] = []
    for titre in titres:
        cherche = _normal(titre)
        # Une ligne qui est le titre (numéroté ou non) ; à défaut, le titre coupé sur plusieurs lignes.
        page = next((i for i in range(courant, len(lignes))
                     if any(x == cherche or x.endswith(" " + cherche) for x in lignes[i])), None)
        if page is None:
            page = next((i for i in range(courant, len(lignes)) if cherche in " ".join(lignes[i])), None)
        trouves.append(None if page is None else page + 1)
        if page is not None:
            courant = page
    return trouves


def pdf_numerote(data: bytes, convertir: Callable[[bytes, str, str], bytes]) -> Tuple[bytes, int]:
    """PDF d'un .docx avec les numéros de son sommaire (nombre d'entrées numérotées ; 0 : un seul rendu)."""
    import docx

    from .apercu import lire_pdf

    pdf = convertir(data, ".docx", "pdf")
    try:
        document = docx.Document(io.BytesIO(data))
    except Exception:                               # noqa: BLE001 — LibreOffice l'a lu, pas python-docx
        return pdf, 0
    entrees = entrees_sans_numero(document)
    if not entrees:
        return pdf, 0
    pages = situer([t for _, t in entrees], lire_pdf(pdf, {"textes": True})["textes"])
    numerotees = 0
    for (separe, _), page in zip(entrees, pages):
        if page is None:
            continue
        execution = make("w:r")
        texte = make("w:t")
        texte.text = str(page)
        execution.append(texte)
        separe.getparent().addnext(execution)
        numerotees += 1
    if not numerotees:
        return pdf, 0
    copie = io.BytesIO()
    document.save(copie)
    return convertir(copie.getvalue(), ".docx", "pdf"), numerotees
