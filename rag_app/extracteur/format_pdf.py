# SPDX-License-Identifier: MIT
# rag_app/extracteur/format_pdf.py — extraction PDF : paragraphes, listes, titres par taille de police, boîtes.
from __future__ import annotations

import math
import re
import statistics
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .blocs import Collecteur, LimiteAtteinte
from .erreurs import ErreurExtracteur
from .pdf_page import PageLue, Segment, TableauPdf, lire_page, nettoyer

_MARQUE = re.compile(r"^(?:[•▪●◦·‣▸►■□○◆›»→\-–—*]|\d{1,3}[.)]|[a-z]\))\s+\S|^[•▪●◦·‣▸►■□○◆›»→]\S")
_PUCE = re.compile(r"^[•▪●◦·‣▸►■□○◆›»→\-–—*]\s*")
_NUMERO = re.compile(r"^\d{1,3}(?:\.\d+)*[.)]\s")
_FIN_PHRASE = (".", ",", ";", ":", "?", "!")


@dataclass(slots=True)
class Para:
    page: int
    kind: str
    textes: list[str] = field(default_factory=list)
    rects: list[list[float]] = field(default_factory=list)
    tailles: list[float] = field(default_factory=list)
    gras: int = 0
    y0: float = 0.0
    y1: float = 0.0
    hauteur_page: float = 0.0
    lignes: list[list[str]] = field(default_factory=list)
    niveau: int = 0

    @property
    def taille(self) -> float:
        return statistics.fmean(self.tailles) if self.tailles else 0.0

    @property
    def chars(self) -> int:
        return sum(len(t) for t in self.textes)


def _joindre(lignes: list[str]) -> str:
    sortie = ""
    for ligne in lignes:
        if not sortie:
            sortie = ligne
        elif sortie.endswith("­"):
            sortie = sortie[:-1] + ligne
        elif re.search(r"[^\W\d_]{2}-$", sortie) and ligne[:1].islower():
            sortie = sortie[:-1] + ligne
        else:
            sortie += " " + ligne
    return sortie


def _rect(s: Segment | TableauPdf) -> list[float]:
    return [round(s.x0, 1), round(s.y0, 1), round(s.x1, 1), round(s.y1, 1)]


def fusionner_rects(rects: list[list[float]]) -> list[list[float]]:
    sortie: list[list[float]] = []
    for r in rects:
        p = sortie[-1] if sortie else None
        if p and abs(p[0] - r[0]) <= 2 and abs(p[2] - r[2]) <= 2 and r[1] - p[3] <= 0.8 * (r[3] - r[1]):
            p[1], p[3] = min(p[1], r[1]), max(p[3], r[3])
            p[0], p[2] = min(p[0], r[0]), max(p[2], r[2])
        else:
            sortie.append(list(r))
    return sortie


def paragraphes(page_lue: PageLue, numero: int) -> list[Para]:
    sortie: list[Para] = []
    courant: Para | None = None
    prec: Segment | None = None
    for el in page_lue.elements:
        if isinstance(el, TableauPdf):
            sortie.append(Para(numero, "table", rects=[_rect(el)], lignes=el.lignes, y0=el.y0, y1=el.y1,
                               hauteur_page=page_lue.hauteur))
            courant = prec = None
            continue
        texte = el.texte
        marque = bool(_MARQUE.match(texte))
        nouveau = courant is None or prec is None
        if not nouveau and courant is not None and prec is not None:
            ecart = el.y0 - prec.y1
            taille = max(el.taille, prec.taille)
            if el.y0 < prec.y0 - 0.5 * prec.taille or abs(el.taille - prec.taille) > 0.15 * prec.taille:
                nouveau = True
            elif courant.kind == "list":
                nouveau = ecart > (1.2 if marque else 0.5) * taille
            else:
                nouveau = ecart > 0.5 * taille or marque
        if nouveau or courant is None:
            courant = Para(numero, "list" if marque else "paragraph", y0=el.y0, hauteur_page=page_lue.hauteur)
            sortie.append(courant)
            courant.textes.append(_PUCE.sub("- ", texte) if marque and _PUCE.match(texte) else texte)
        elif courant.kind == "list" and marque:
            courant.textes.append(_PUCE.sub("- ", texte) if _PUCE.match(texte) else texte)
        elif courant.kind == "list":
            courant.textes[-1] = _joindre([courant.textes[-1], texte])
        else:
            courant.textes.append(texte)
        courant.rects.append(_rect(el))
        courant.tailles.append(el.taille)
        courant.gras += 1 if el.gras else 0
        courant.y1 = el.y1
        prec = el
    return sortie


def _retirer_repetitions(paras: list[Para], pages: int) -> list[Para]:
    if pages < 3:
        return paras

    def cle(p: Para) -> str | None:
        if p.kind != "paragraph" or len(p.textes) != 1 or p.hauteur_page <= 0:
            return None
        if p.y1 > 0.09 * p.hauteur_page and p.y0 < 0.91 * p.hauteur_page:
            return None
        return re.sub(r"\d+", "#", p.textes[0].lower())

    pages_par_cle: dict[str, set[int]] = {}
    for p in paras:
        k = cle(p)
        if k:
            pages_par_cle.setdefault(k, set()).add(p.page)
    seuil = max(3, int(0.4 * pages))
    return [p for p in paras if not ((k := cle(p)) and len(pages_par_cle[k]) >= seuil)]


def _candidat_titre(p: Para) -> bool:
    if len(re.findall(r"\w", " ".join(p.textes))) < 2:
        return False
    if p.kind == "list":
        return len(p.textes) == 1 and len(p.rects) == 1 and p.chars <= 250 and bool(_NUMERO.match(p.textes[0]))
    return p.kind == "paragraph" and len(p.textes) <= 3 and p.chars <= 250


def _classer_titres(paras: list[Para]) -> None:
    corps = Counter()
    for p in paras:
        if p.kind == "paragraph":
            for t, taille in zip(p.textes, p.tailles):
                corps[round(taille * 2) / 2] += len(t)
    if not corps:
        return
    taille_corps = corps.most_common(1)[0][0]
    classes: dict[int, list[Para]] = {}
    gras_titres: list[Para] = []
    for p in paras:
        if not _candidat_titre(p):
            continue
        rapport = (p.taille or taille_corps) / taille_corps
        if rapport >= 1.15:
            classes.setdefault(round(math.log(rapport) / math.log(1.2)), []).append(p)
        elif (len(p.textes) == 1 and p.gras and p.chars <= 120 and rapport >= 0.95
              and not p.textes[0].rstrip().endswith(_FIN_PHRASE)):
            gras_titres.append(p)
    ordre = sorted(classes, reverse=True)
    for rang, classe in enumerate(ordre, start=1):
        for p in classes[classe]:
            _titrer(p, min(rang, 5))
    for p in gras_titres:
        _titrer(p, min(len(ordre) + 1, 6))


def _titrer(p: Para, niveau: int) -> None:
    p.kind, p.niveau = "heading", niveau
    if p.textes and p.textes[0].startswith("- "):
        p.textes[0] = p.textes[0][2:]


def emettre(paras: list[Para], col: Collecteur) -> None:
    for p in paras:
        boites = fusionner_rects(p.rects)
        if p.kind == "table":
            col.tableau(iter(p.lignes), page=p.page, boxes=boites)
        elif p.kind == "heading":
            col.ajouter("heading", _joindre(p.textes), level=p.niveau, page=p.page, boxes=boites)
        elif p.kind == "list":
            col.ajouter("list", "\n".join(p.textes), page=p.page, boxes=boites)
        else:
            col.ajouter("paragraph", _joindre(p.textes), page=p.page, boxes=boites)


def _titre_metadonnees(pdf: Any) -> str | None:
    brut = (pdf.metadata or {}).get("Title")
    if isinstance(brut, bytes):
        brut = brut.decode("utf-16" if brut[:2] in (b"\xfe\xff", b"\xff\xfe") else "latin-1", errors="replace")
    texte = nettoyer(str(brut or "")).strip()
    return texte or None


def _erreur_ouverture(exc: Exception) -> ErreurExtracteur:
    if isinstance(exc, MemoryError):
        raise exc
    nom = type(exc).__name__ + " " + type(exc.args[0]).__name__ if exc.args else type(exc).__name__
    if "Password" in nom or "Encrypt" in nom or "encrypt" in str(exc).lower():
        return ErreurExtracteur("encrypted", "PDF protégé par mot de passe.")
    return ErreurExtracteur("corrupt", "PDF illisible.")


def _texte_pypdf(chemin: Path, col: Collecteur, meta: dict[str, Any]) -> None:
    import pypdf
    try:
        lecteur = pypdf.PdfReader(str(chemin))
        if lecteur.is_encrypted and not lecteur.decrypt(""):
            raise ErreurExtracteur("encrypted", "PDF protégé par mot de passe.")
        total = meta["pages"] = len(lecteur.pages)
        for n in range(1, total + 1):
            col.progresser(n - 1, total)
            texte = nettoyer(lecteur.pages[n - 1].extract_text() or "")
            for morceau in re.split(r"\n\s*\n", texte):
                ligne = " ".join(morceau.split())
                col.ajouter("paragraph", ligne, page=n)
    except ErreurExtracteur:
        raise
    except LimiteAtteinte:
        raise
    except Exception as exc:  # noqa: BLE001 — pypdf lève des types variés sur les fichiers abîmés
        raise _erreur_ouverture(exc)


def extraire(chemin: Path, col: Collecteur, meta: dict[str, Any]) -> None:
    import pdfplumber
    try:
        pdf = pdfplumber.open(str(chemin))
    except Exception as exc:  # noqa: BLE001
        erreur = _erreur_ouverture(exc)
        if erreur.code == "encrypted":
            raise erreur
        col.avertir("fallback_pypdf", "Lecture dégradée (pdfplumber a échoué) : sans positions.")
        try:
            _texte_pypdf(chemin, col, meta)
        finally:
            _fin(col, meta)
        return
    paras: list[Para] = []
    total = meta["pages"] = len(pdf.pages)
    caracteres = 0
    try:
        meta["title"] = _titre_metadonnees(pdf)
        for n in range(1, total + 1):
            col.progresser(n - 1, total)
            page = pdf.pages[n - 1]
            try:
                lue = lire_page(page)
            except Exception:  # noqa: BLE001 — une page abîmée n'arrête pas le document
                col.avertir("page_error", f"Page {n} illisible.", page=n)
                continue
            finally:
                page.close()
            nouveaux = paragraphes(lue, n)
            paras.extend(nouveaux)
            caracteres += sum(p.chars for p in nouveaux)
            if caracteres > col.max_chars * 1.1:
                col.avertir("truncated", f"Texte tronqué à {col.max_chars} caractères.")
                break
    finally:
        pdf.close()
    paras = _retirer_repetitions(paras, total)
    _classer_titres(paras)
    if meta["title"] is None:
        meta["title"] = next((_joindre(p.textes) for p in paras if p.kind == "heading" and p.niveau == 1), None)
    col.progresser(total, total)
    try:
        emettre(paras, col)
    finally:
        _fin(col, meta)


def _fin(col: Collecteur, meta: dict[str, Any]) -> None:
    avec_texte = {b.get("page") for b in col.blocs}
    tronque = any(a["code"] == "truncated" for a in col.avertissements)
    meta["pages_sans_texte"] = [] if tronque else [n for n in range(1, (meta.get("pages") or 0) + 1) if n not in avec_texte]
    meta["text_layer"] = bool(avec_texte)
