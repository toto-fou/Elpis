# SPDX-License-Identifier: MIT
# rag_app/extracteur/localiser.py — retrouve un passage dans un PDF : page et rectangles (points, haut-gauche).
from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher
from typing import Any

from .erreurs import ErreurExtracteur
from .pdf_page import Segment, TableauPdf, lire_page

_JETONS = re.compile(r"[^\W_]+")
_COUPURE = re.compile(r"(?<=[^\W\d_]{2})-\r?\n(?=[^\W\d_A-Z])|[\u00ad\ufffe]\r?\n?")
_CIBLE_MAX = 400
_VOISINS = 3
_CANDIDATES = 3
_BLOC_MIN = 3


def jetons(texte: str) -> list[str]:
    return _JETONS.findall(unicodedata.normalize("NFKC", texte).casefold())


def _flux_jetons(elements: list[Any]) -> tuple[list[str], list[tuple[int, int]], list[Any]]:
    """Jetons de la page dans l'ordre de lecture, avec les mots (indices) qui les portent."""
    mots: list[tuple[Any, int]] = []
    jets: list[str] = []
    spans: list[tuple[int, int]] = []
    segments = [e for e in elements if isinstance(e, (Segment, TableauPdf))]
    saute = False
    for i, el in enumerate(segments):
        if isinstance(el, TableauPdf):
            texte = " ".join(" ".join(r) for r in el.lignes)
            debut = len(mots)
            mots.append((el, i))
            for j in jetons(texte):
                jets.append(j)
                spans.append((debut, debut))
            continue
        for k, m in enumerate(el.mots):
            if saute:
                saute = False
                continue
            debut = len(mots)
            mots.append((m, i))
            texte, fin = m.t, debut
            suivant = segments[i + 1] if i + 1 < len(segments) else None
            if (k == len(el.mots) - 1 and isinstance(suivant, Segment) and suivant.mots
                    and re.search(r"[^\W\d_]{2}-$", texte) and suivant.mots[0].t[:1].islower()):
                texte = texte[:-1] + suivant.mots[0].t
                mots.append((suivant.mots[0], i + 1))
                fin, saute = debut + 1, True
            for j in jetons(texte):
                jets.append(j)
                spans.append((debut, fin))
    return jets, spans, mots


def _evaluer(page: Any, cible: list[str]) -> dict[str, Any]:
    lue = lire_page(page)
    jets, spans, mots = _flux_jetons(lue.elements)
    resultat = {"score": 0.0, "boxes": [], "page_width": round(lue.largeur, 2), "page_height": round(lue.hauteur, 2)}
    if not jets:
        return resultat
    blocs = [b for b in SequenceMatcher(None, cible, jets, autojunk=False).get_matching_blocks()
             if b.size >= min(_BLOC_MIN, len(cible))]
    if not blocs:
        return resultat
    grappes: list[list[Any]] = []
    for b in sorted(blocs, key=lambda b: b.b):
        if grappes and b.b - (grappes[-1][-1].b + grappes[-1][-1].size) <= 40:
            grappes[-1].append(b)
        else:
            grappes.append([b])
    meilleure = max(grappes, key=lambda g: sum(b.size for b in g))
    resultat["score"] = round(min(1.0, sum(b.size for b in meilleure) / len(cible)), 3)
    premier, dernier = meilleure[0].b, meilleure[-1].b + meilleure[-1].size - 1
    indices = range(spans[premier][0], spans[dernier][1] + 1)
    lignes: dict[int, list[Any]] = {}
    for idx in indices:
        element, segment = mots[idx]
        lignes.setdefault(segment, []).append(element)
    boites = []
    for segment in sorted(lignes):
        pris = lignes[segment]
        boites.append([round(min(m.x0 for m in pris), 1), round(min(m.y0 for m in pris), 1),
                       round(max(m.x1 for m in pris), 1), round(max(m.y1 for m in pris), 1)])
    resultat["boxes"] = boites
    return resultat


def _pages_candidates(chemin: str, cible: list[str], total: int, deja: set[int]) -> list[int]:
    import pypdfium2 as pdfium
    n_gramme = min(4, len(cible))
    gabarits = {tuple(cible[i:i + n_gramme]) for i in range(len(cible) - n_gramme + 1)}
    pdf = pdfium.PdfDocument(chemin)
    notes: list[tuple[int, int]] = []
    try:
        for n in range(1, total + 1):
            if n in deja:
                continue
            page = pdf[n - 1]
            try:
                texte = page.get_textpage().get_text_range()
            finally:
                page.close()
            j = jetons(_COUPURE.sub("", texte))
            commun = len(gabarits & {tuple(j[i:i + n_gramme]) for i in range(len(j) - n_gramme + 1)})
            if commun:
                notes.append((commun, n))
    finally:
        pdf.close()
    return [n for _, n in sorted(notes, reverse=True)[:_CANDIDATES]]


def localiser(chemin: str, texte: str, indice: Any = None) -> dict[str, Any]:
    cible = jetons(texte)[:_CIBLE_MAX]
    if not cible:
        raise ErreurExtracteur("empty_text", "Le texte à localiser ne contient aucun mot.", 422)
    import pdfplumber
    try:
        pdf = pdfplumber.open(chemin)
    except Exception:  # noqa: BLE001
        raise ErreurExtracteur("corrupt", "PDF illisible.")
    meilleur: dict[str, Any] = {"page": None, "boxes": [], "score": 0.0}
    vus: set[int] = set()
    try:
        total = len(pdf.pages)

        def essayer(n: int) -> float:
            vus.add(n)
            page = pdf.pages[n - 1]
            try:
                res = _evaluer(page, cible)
            finally:
                page.close()
            if res["score"] > meilleur["score"]:
                meilleur.update(page=n, **res)
            return res["score"]

        ordre: list[int] = []
        if isinstance(indice, int) and 1 <= indice <= total:
            ordre = [indice] + [p for d in range(1, _VOISINS + 1) for p in (indice + d, indice - d) if 1 <= p <= total]
        for n in ordre:
            if essayer(n) >= 0.9:
                return meilleur
        if meilleur["score"] < 0.6:
            for n in _pages_candidates(chemin, cible, total, vus):
                if essayer(n) >= 0.9:
                    break
    finally:
        pdf.close()
    if meilleur["score"] < 0.5:
        return {"page": None, "boxes": [], "score": meilleur["score"]}
    return meilleur
