# SPDX-License-Identifier: MIT
# rag_app/extracteur/format_html.py — extraction HTML (html.parser) : titres, paragraphes, listes, tableaux, code.
from __future__ import annotations

import re
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

from .blocs import Collecteur, cellule, compacter
from .format_texte import detecter_encodage

_IGNORES = {"script", "style", "noscript", "template", "svg", "iframe", "object"}
_BLOCS = {"p", "div", "section", "article", "header", "footer", "nav", "aside", "main", "blockquote", "figure",
          "figcaption", "form", "fieldset", "details", "summary", "address", "dl", "dt", "dd", "hr", "body"}
_META_CHARSET = re.compile(rb"<meta[^>]+charset=[\"']?\s*([A-Za-z0-9_\-]+)", re.I)


class _Analyseur(HTMLParser):
    def __init__(self, col: Collecteur) -> None:
        super().__init__(convert_charrefs=True)
        self.col = col
        self.titre_page: str | None = None
        self._ignore = 0
        self._dans_titre = False
        self._tampon: list[str] = []
        self._niveau_titre = 0
        self._pre = False
        self._pre_tampon: list[str] = []
        self._profondeur_liste = 0
        self._items: list[str] = []
        self._item_courant: list[str] | None = None
        self._niveau_item = 0
        self._tables: list[list[list[str]]] = []
        self._cellule: list[str] | None = None
        self._rang: list[str] | None = None

    def _vider_texte(self) -> None:
        texte = compacter("".join(self._tampon))
        self._tampon = []
        if texte:
            self.col.ajouter("paragraph", texte)

    def _fin_item(self) -> None:
        if self._item_courant is not None:
            texte = compacter("".join(self._item_courant))
            if texte:
                self._items.append("  " * max(0, self._niveau_item - 1) + "- " + texte)
        self._item_courant = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in _IGNORES:
            self._ignore += 1
            return
        if self._ignore:
            return
        if tag == "title":
            self._dans_titre = True
            return
        if self._tables:
            if tag in ("tr",):
                self._rang = []
            elif tag in ("td", "th"):
                self._cellule = []
            elif tag == "br" and self._cellule is not None:
                self._cellule.append(" ")
            elif tag == "table":
                self._tables.append([])
            return
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self._vider_texte()
            self._niveau_titre = int(tag[1])
        elif tag == "pre":
            self._vider_texte()
            self._pre = True
            self._pre_tampon = []
        elif tag in ("ul", "ol"):
            if self._profondeur_liste == 0:
                self._vider_texte()
            else:
                self._fin_item()
            self._profondeur_liste += 1
        elif tag == "li":
            self._fin_item()
            self._niveau_item = self._profondeur_liste
            self._item_courant = []
        elif tag == "table":
            self._vider_texte()
            self._tables.append([])
        elif tag == "br":
            self._ecrire("\n" if self._pre else " ")
        elif tag in _BLOCS and self._profondeur_liste == 0:
            self._vider_texte()

    def handle_endtag(self, tag: str) -> None:
        if tag in _IGNORES:
            self._ignore = max(0, self._ignore - 1)
            return
        if self._ignore:
            return
        if tag == "title":
            self._dans_titre = False
            return
        if self._tables:
            if tag in ("td", "th") and self._cellule is not None and self._rang is not None:
                self._rang.append(cellule("".join(self._cellule)))
                self._cellule = None
            elif tag == "tr" and self._rang is not None:
                if any(self._rang):
                    self._tables[-1].append(self._rang)
                self._rang = None
            elif tag == "table":
                rangs = self._tables.pop()
                if not self._tables:
                    if rangs:
                        self.col.tableau(iter(rangs))
                elif self._cellule is not None:
                    self._cellule.append(" ".join(" ".join(r) for r in rangs))
            return
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6") and self._niveau_titre:
            texte = compacter("".join(self._tampon))
            self._tampon = []
            if texte:
                self.col.ajouter("heading", texte, level=self._niveau_titre)
            self._niveau_titre = 0
        elif tag == "pre":
            self._pre = False
            self.col.ajouter("code", "".join(self._pre_tampon).strip("\n").rstrip())
        elif tag == "li":
            self._fin_item()
        elif tag in ("ul", "ol"):
            self._fin_item()
            self._profondeur_liste = max(0, self._profondeur_liste - 1)
            if self._profondeur_liste == 0 and self._items:
                self.col.ajouter("list", "\n".join(self._items))
                self._items = []
        elif tag in _BLOCS and self._profondeur_liste == 0:
            self._vider_texte()

    def _ecrire(self, texte: str) -> None:
        if self._cellule is not None:
            self._cellule.append(texte)
        elif self._pre:
            self._pre_tampon.append(texte)
        elif self._item_courant is not None:
            self._item_courant.append(texte)
        else:
            self._tampon.append(texte)

    def handle_data(self, data: str) -> None:
        if self._ignore:
            return
        if self._dans_titre:
            self.titre_page = compacter((self.titre_page or "") + data)
            return
        if self._tables and self._cellule is None:
            return
        self._ecrire(data)

    def terminer(self) -> None:
        self._fin_item()
        if self._items:
            self.col.ajouter("list", "\n".join(self._items))
        self._vider_texte()


def extraire(chemin: Path, col: Collecteur, meta: dict[str, Any]) -> None:
    col.progresser(0, 1)
    brut = chemin.read_bytes()
    declare = _META_CHARSET.search(brut[:4096])
    try:
        texte = brut.decode("utf-8")
    except UnicodeDecodeError:
        encodage = declare.group(1).decode("ascii", "ignore") if declare else detecter_encodage(brut[:65536])
        try:
            texte = brut.decode(encodage, errors="replace")
        except LookupError:
            texte = brut.decode("cp1252", errors="replace")
    analyseur = _Analyseur(col)
    try:
        analyseur.feed(texte)
        analyseur.close()
        analyseur.terminer()
    finally:
        meta["title"] = analyseur.titre_page
    col.progresser(1, 1)
