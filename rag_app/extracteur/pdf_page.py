# SPDX-License-Identifier: MIT
# rag_app/extracteur/pdf_page.py — lecture géométrique d'une page PDF (pdfplumber) : lignes, colonnes, tableaux.
from __future__ import annotations

import re
import statistics
from dataclasses import dataclass, field
from typing import Any

_GRAS = ("bold", "black", "heavy", "semibold", "demi", "-bd", ",bd")
_LIGATURES = str.maketrans({"ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl",
                            "ﬅ": "st", "ﬆ": "st"})
_CONTROLES = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
_GOUTTIERE = 10.0
_TABLES_PAGE_MAX = 3000


@dataclass(slots=True)
class Mot:
    t: str
    x0: float
    y0: float
    x1: float
    y1: float
    gras: bool


@dataclass(slots=True)
class Segment:
    mots: list[Mot]
    x0: float
    y0: float
    x1: float
    y1: float
    taille: float
    gras: bool

    @property
    def texte(self) -> str:
        return " ".join(m.t for m in self.mots)


@dataclass(slots=True)
class TableauPdf:
    lignes: list[list[str]]
    x0: float
    y0: float
    x1: float
    y1: float


@dataclass(slots=True)
class PageLue:
    largeur: float
    hauteur: float
    elements: list[Segment | TableauPdf] = field(default_factory=list)


def nettoyer(texte: str) -> str:
    return _CONTROLES.sub("", texte.translate(_LIGATURES))


def _mots(page: Any, ox: float, oy: float, largeur: float, hauteur: float, exclus: list[tuple]) -> list[Mot]:
    sortie: list[Mot] = []
    for w in page.extract_words(x_tolerance=1.0, x_tolerance_ratio=0.15, y_tolerance=3, keep_blank_chars=False,
                                use_text_flow=False, extra_attrs=["fontname"]):
        if not w.get("upright", True):
            continue
        x0, y0, x1, y1 = w["x0"] - ox, w["top"] - oy, w["x1"] - ox, w["bottom"] - oy
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        if not (0 <= cx <= largeur and 0 <= cy <= hauteur):
            continue
        if any(a <= cx <= c and b <= cy <= d for a, b, c, d in exclus):
            continue
        texte = nettoyer(w["text"])
        if texte:
            nom = str(w.get("fontname", "")).lower()
            sortie.append(Mot(texte, x0, y0, x1, y1, any(g in nom for g in _GRAS)))
    return sortie


def _grappes(mots: list[Mot]) -> list[list[Mot]]:
    grappes: list[list[Mot]] = []
    for m in sorted(mots, key=lambda m: (m.y0, m.x0)):
        for g in reversed(grappes[-8:]):
            ref = g[0]
            recouvrement = min(m.y1, ref.y1) - max(m.y0, ref.y0)
            if recouvrement >= 0.5 * min(m.y1 - m.y0, ref.y1 - ref.y0):
                g.append(m)
                break
        else:
            grappes.append([m])
    return grappes


def _segment(mots: list[Mot]) -> Segment:
    tailles = [m.y1 - m.y0 for m in mots]
    lettres = sum(len(m.t) for m in mots)
    gras = sum(len(m.t) for m in mots if m.gras)
    return Segment(mots, min(m.x0 for m in mots), min(m.y0 for m in mots), max(m.x1 for m in mots),
                   max(m.y1 for m in mots), statistics.median(tailles), gras * 2 > lettres)


def _segments(mots: list[Mot]) -> list[Segment]:
    sortie: list[Segment] = []
    for grappe in _grappes(mots):
        grappe.sort(key=lambda m: m.x0)
        seuil = max(8.0, 1.8 * statistics.median(m.y1 - m.y0 for m in grappe))
        courant = [grappe[0]]
        for m in grappe[1:]:
            if m.x0 - max(c.x1 for c in courant) > seuil:
                sortie.append(_segment(courant))
                courant = [m]
            else:
                courant.append(m)
        sortie.append(_segment(courant))
    return sortie


def _couper(items: list[Any], axe: str, seuil_y: float = 0.0) -> list[list[Any]]:
    a0, a1 = ("x0", "x1") if axe == "x" else ("y0", "y1")
    seuil = _GOUTTIERE if axe == "x" else seuil_y
    groupes: list[list[Any]] = []
    limite = None
    for it in sorted(items, key=lambda i: getattr(i, a0)):
        if limite is None or getattr(it, a0) - limite >= seuil:
            groupes.append([it])
            limite = getattr(it, a1)
        else:
            groupes[-1].append(it)
            limite = max(limite, getattr(it, a1))
    return groupes


def ordonner(items: list[Any], seuil_y: float = 0.0) -> list[Any]:
    """Ordre de lecture par coupes XY : colonnes d'abord, puis bandes séparées par plus qu'un interligne."""
    if len(items) < 2:
        return items
    for axe in ("x", "y"):
        groupes = _couper(items, axe, seuil_y)
        if len(groupes) > 1:
            return [i for g in groupes for i in ordonner(g, seuil_y)]
    return sorted(items, key=lambda i: (round(i.y0), i.x0))


def _tableaux(page: Any, ox: float, oy: float) -> list[TableauPdf]:
    try:
        if len(page.lines) + len(page.rects) < 4 or len(page.lines) + len(page.rects) > _TABLES_PAGE_MAX:
            return []
        trouves = page.find_tables()
    except Exception:  # noqa: BLE001 — détection facultative, jamais bloquante
        return []
    sortie: list[TableauPdf] = []
    for t in trouves:
        try:
            donnees = t.extract(x_tolerance=1.0, x_tolerance_ratio=0.15)
        except Exception:  # noqa: BLE001
            continue
        lignes = [[nettoyer(" ".join(str(c or "").split())) for c in rang] for rang in donnees]
        lignes = [r for r in lignes if any(r)]
        cellules = [c for r in lignes for c in r]
        if len(lignes) < 2 or max((len(r) for r in lignes), default=0) < 2 or not cellules:
            continue
        if sum(1 for c in cellules if c) * 2 < len(cellules):
            continue
        x0, y0, x1, y1 = t.bbox
        sortie.append(TableauPdf(lignes, x0 - ox, y0 - oy, x1 - ox, y1 - oy))
    return sortie


def lire_page(page: Any) -> PageLue:
    """Éléments d'une page dans l'ordre de lecture, coordonnées en points, origine en haut à gauche."""
    cadre = page.cropbox
    ox, oy = cadre[0], cadre[1]
    largeur, hauteur = cadre[2] - cadre[0], cadre[3] - cadre[1]
    tableaux = _tableaux(page, ox, oy)
    mots = _mots(page, ox, oy, largeur, hauteur, [(t.x0, t.y0, t.x1, t.y1) for t in tableaux])
    segments = _segments(mots) if mots else []
    seuil = 0.45 * statistics.median(s.taille for s in segments) if segments else 0.0
    return PageLue(largeur, hauteur, ordonner([*segments, *tableaux], seuil))
