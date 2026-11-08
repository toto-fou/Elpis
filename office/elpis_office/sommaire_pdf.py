# SPDX-License-Identifier: MIT
"""office/elpis_office/sommaire_pdf.py — numéros du sommaire dans le PDF d'un .docx : les signets d'un premier rendu donnent la page de chaque titre, les numéros vont dans une copie, un second rendu les montre ; le fichier n'est jamais modifié."""
from __future__ import annotations

import io
import itertools
import re
from typing import Any, Callable, Dict, List, Optional, Tuple

from ._docx.ooxml.util import make, qn
from .commun import OfficeError
from .paquet import PaquetInvalide, controler_zip

ENTREES_MAX = 2_000
_PAGEREF = re.compile(r"^\s*PAGEREF\s+(\S+)", re.IGNORECASE)
_ESPACES = re.compile(r"\s+")


def _normal(texte: str) -> str:
    return _ESPACES.sub(" ", texte).strip().casefold()


def entrees_sans_numero(document: Any) -> List[Tuple[Any, str]]:
    """(élément fldChar « separate », texte du titre visé) des renvois PAGEREF du corps sans numéro enregistré."""
    signets = {b.get(qn("w:name")): b.getparent() for b in document.element.body.iter(qn("w:bookmarkStart"))}
    entrees: List[Tuple[Any, str]] = []
    vus: set = set()                                # un paragraphe de zone de texte est aussi dans son parent
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
                if separe is not None and separe not in vus and vide and cible is not None and cible.tag == qn("w:p"):
                    titre = "".join(t.text or "" for t in cible.iter(qn("w:t"))).strip()
                    if titre:
                        vus.add(separe)
                        entrees.append((separe, titre))
                instruction, separe = None, None
            elif noeud.tag == qn("w:t") and separe is not None and (noeud.text or "").strip():
                vide = False
        if len(entrees) >= ENTREES_MAX:
            break
    return entrees


def situer(titres: List[str], signets: List[Dict[str, Any]]) -> List[Optional[int]]:
    """Page (à partir de 1) de chaque titre : le signet du PDF qui porte ce titre, dans l'ordre du document."""
    marques = [(_normal(str(s.get("titre") or "")), s.get("page")) for s in signets]
    trouves: List[Optional[int]] = []
    k = 0
    for titre in titres:
        cherche, page = _normal(titre), None
        # Dans l'ordre (titres répétés) ; un second sommaire repart du début.
        for j in itertools.chain(range(k, len(marques)), range(0, k)):
            nom, numero = marques[j]
            if isinstance(numero, int) and (nom == cherche or nom.endswith(" " + cherche)):
                page, k = numero + 1, j + 1
                break
        trouves.append(page)
    return trouves


def _pages_renumerotees(document: Any) -> bool:
    """Une section qui recommence ou change sa numérotation (i, ii…) : le numéro affiché n'est plus celui de la page."""
    for types in document.element.body.iter(qn("w:pgNumType")):
        if types.get(qn("w:start")) is not None or (types.get(qn("w:fmt")) or "decimal") != "decimal":
            return True
    return False


def pdf_numerote(data: bytes, convertir: Callable[[bytes, str, str], bytes]) -> Tuple[bytes, int]:
    """PDF d'un .docx avec les numéros de son sommaire (nombre d'entrées numérotées ; 0 : un seul rendu)."""
    pdf = convertir(data, ".docx", "pdf")
    try:
        archive = controler_zip(data, "document")   # même plafond que les outils Word avant de tout charger
        if b"PAGEREF" not in archive.read("word/document.xml"):
            return pdf, 0
        import docx

        document = docx.Document(io.BytesIO(data))
        entrees = entrees_sans_numero(document)
        if not entrees or _pages_renumerotees(document):
            return pdf, 0
        from .apercu import lire_pdf

        pages = situer([t for _, t in entrees], lire_pdf(pdf, {"signets": True})["signets"])
        numerotees = 0
        for (separe, _), page in zip(entrees, pages):
            if page is None:
                continue
            execution, texte = make("w:r"), make("w:t")
            texte.text = str(page)
            execution.append(texte)
            separe.getparent().addnext(execution)
            numerotees += 1
        if not numerotees:
            return pdf, 0
        copie = io.BytesIO()
        document.save(copie)
        return convertir(copie.getvalue(), ".docx", "pdf"), numerotees
    except (OfficeError, PaquetInvalide, KeyError, ValueError, OSError):
        return pdf, 0                               # le sommaire reste sans numéros, l'export réussit
