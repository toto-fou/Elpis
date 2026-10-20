# SPDX-License-Identifier: MIT
# rag_app/extracteur/format_docx.py — extraction DOCX (python-docx) : titres par style, listes, tableaux Markdown.
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .blocs import Collecteur, cellule, compacter
from .erreurs import ErreurExtracteur

_TITRE_STYLE = re.compile(r"(?:heading|titre|überschrift|encabezado|intestazione)\s*(\d)", re.I)
_TITRE_ID = re.compile(r"^(?:heading|titre)(\d)$", re.I)
_NS_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def _niveau_titre(paragraphe: Any) -> int:
    style = paragraphe.style
    for _ in range(6):
        if style is None:
            break
        nom = (style.name or "")
        m = _TITRE_STYLE.search(nom) or _TITRE_ID.match(style.style_id or "")
        if m:
            return max(1, min(6, int(m.group(1))))
        if nom.strip().lower() in ("title", "titre"):
            return 1
        style = style.base_style
    plan = paragraphe._p.pPr.find(f"{_NS_W}outlineLvl") if paragraphe._p.pPr is not None else None
    if plan is not None:
        try:
            return max(1, min(6, int(plan.get(f"{_NS_W}val")) + 1))
        except (TypeError, ValueError):
            return 0
    return 0


def _liste(paragraphe: Any) -> tuple[bool, bool, int]:
    ppr = paragraphe._p.pPr
    nom = (paragraphe.style.name or "").lower() if paragraphe.style is not None else ""
    num = ppr.find(f"{_NS_W}numPr") if ppr is not None else None
    if num is None and not nom.startswith("list"):
        return False, False, 0
    niveau = 0
    if num is not None:
        ilvl = num.find(f"{_NS_W}ilvl")
        if ilvl is not None:
            try:
                niveau = int(ilvl.get(f"{_NS_W}val"))
            except (TypeError, ValueError):
                niveau = 0
    return True, "number" in nom or "numéro" in nom, niveau


def _elements(parent: Any):
    for el in parent.iterchildren():
        if el.tag == f"{_NS_W}sdt":
            contenu = el.find(f"{_NS_W}sdtContent")
            if contenu is not None:
                yield from _elements(contenu)
        elif el.tag in (f"{_NS_W}p", f"{_NS_W}tbl"):
            yield el


def _lignes_tableau(table: Any) -> list[list[str]]:
    rangs: list[list[str]] = []
    for rang in table.rows:
        vues: set[int] = set()
        cellules: list[str] = []
        for c in rang.cells:
            if id(c._tc) in vues:
                continue
            vues.add(id(c._tc))
            cellules.append(cellule(c.text))
        if any(cellules):
            rangs.append(cellules)
    return rangs


def extraire(chemin: Path, col: Collecteur, meta: dict[str, Any]) -> None:
    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph
    try:
        doc = Document(str(chemin))
    except MemoryError:
        raise
    except Exception as exc:  # noqa: BLE001 — toute erreur d'ouverture = fichier illisible
        raise ErreurExtracteur("corrupt", f"DOCX illisible : {type(exc).__name__}")
    meta["title"] = (doc.core_properties.title or "").strip() or None
    elements = list(_elements(doc.element.body))
    items: list[str] = []
    rang = 0
    ordonnee = False

    def vider_liste() -> None:
        nonlocal items, rang
        if items:
            col.ajouter("list", "\n".join(items))
        items, rang = [], 0

    for n, element in enumerate(elements):
        if n % 200 == 0:
            col.progresser(n, len(elements))
        if element.tag == f"{_NS_W}p":
            p = Paragraph(element, doc)
            texte = compacter(p.text)
            if not texte:
                continue
            niveau = _niveau_titre(p)
            if niveau:
                vider_liste()
                meta["title"] = meta["title"] or (texte if niveau == 1 else None)
                col.ajouter("heading", texte, level=niveau)
                continue
            en_liste, numerotee, profondeur = _liste(p)
            if en_liste:
                if items and numerotee != ordonnee:
                    vider_liste()
                ordonnee = numerotee
                rang += 1 if profondeur == 0 else 0
                marque = f"{rang}." if numerotee else "-"
                items.append("  " * profondeur + f"{marque} {texte}")
                continue
            vider_liste()
            col.ajouter("paragraph", texte)
        elif element.tag == f"{_NS_W}tbl":
            vider_liste()
            col.tableau(iter(_lignes_tableau(Table(element, doc))))
    vider_liste()
    col.progresser(len(elements), len(elements))
