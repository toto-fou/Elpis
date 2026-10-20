# SPDX-License-Identifier: MIT
# rag_app/extracteur/format_texte.py — extraction des textes bruts : txt, md, code, données et CSV en flux.
from __future__ import annotations

import codecs
import csv
import re
from pathlib import Path
from typing import Any

from .blocs import Collecteur, cellule, compacter
from .erreurs import ErreurExtracteur

_TITRE_ATX = re.compile(r"^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$")
_CLOTURE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
_LISTE = re.compile(r"^(\s*)([-*+]|\d{1,9}[.)])[ \t]+\S")
_REGLE = re.compile(r"^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$")
_SEP_TABLEAU = re.compile(r"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$")
_SOULIGNE = re.compile(r"^ {0,3}(=+|-+)[ \t]*$")
_CITATION = re.compile(r"^\s*(>\s?)+")
_LATINS = ("cp1250", "cp1252", "cp1254", "cp1257", "iso8859_1", "iso8859_2", "iso8859_9", "iso8859_15", "latin_1",
           "mac_roman", "mac_latin2", "cp850", "cp437")
_CODE_CIBLE = 1200
_CODE_MAX = 4000


def detecter_encodage(echantillon: bytes) -> str:
    for marque, nom in ((codecs.BOM_UTF8, "utf-8-sig"), (codecs.BOM_UTF16_LE, "utf-16"), (codecs.BOM_UTF16_BE, "utf-16")):
        if echantillon.startswith(marque):
            return nom
    if b"\x00" in echantillon[:8192]:
        raise ErreurExtracteur("corrupt", "Contenu binaire dans un fichier texte.")
    try:
        echantillon.decode("utf-8")
        return "utf-8"
    except UnicodeDecodeError as exc:
        if exc.start >= len(echantillon) - 4:
            return "utf-8"
    try:
        from charset_normalizer import from_bytes
        meilleur = from_bytes(echantillon).best()
        if meilleur is not None and meilleur.encoding:
            return "cp1252" if meilleur.encoding.startswith(_LATINS) else meilleur.encoding
    except Exception:  # noqa: BLE001 — détection facultative
        pass
    return "cp1252"


def lire_texte(chemin: Path) -> str:
    with open(chemin, "rb") as fh:
        encodage = detecter_encodage(fh.read(65536))
    texte = chemin.read_bytes().decode(encodage, errors="replace")
    return texte.replace("\r\n", "\n").replace("\r", "\n") if "\r" in texte else texte


def _paragraphes_txt(texte: str, col: Collecteur) -> None:
    for morceau in re.split(r"\n[ \t]*\n+", texte):
        lignes = [ligne.rstrip() for ligne in morceau.split("\n") if ligne.strip()]
        col.ajouter("paragraph", "\n".join(lignes).strip())


def _grouper_code(texte: str, col: Collecteur) -> None:
    courant: list[str] = []
    taille = 0

    def vider() -> None:
        nonlocal courant, taille
        col.ajouter("code", "\n".join(courant).strip("\n").rstrip())
        courant, taille = [], 0

    for ligne in texte.split("\n"):
        if not ligne.strip() and taille >= _CODE_CIBLE:
            vider()
            continue
        courant.append(ligne.rstrip())
        taille += len(ligne) + 1
        if taille >= _CODE_MAX:
            vider()
    if courant:
        vider()


def _liste_md(lignes: list[str], debut: int) -> tuple[list[str], int]:
    items: list[str] = []
    j = debut
    while j < len(lignes):
        ligne = lignes[j]
        if not ligne.strip():
            suivant = next((x for x in lignes[j + 1:] if x.strip()), "")
            if suivant and (_LISTE.match(suivant) or suivant.startswith("  ")):
                j += 1
                continue
            break
        if _LISTE.match(ligne) or ligne.startswith((" ", "\t")) or (items and not _TITRE_ATX.match(ligne)
                                                                    and not _CLOTURE.match(ligne)):
            items.append(ligne.rstrip())
            j += 1
            continue
        break
    return items, j


def _ferme(ligne: str, marque: str) -> bool:
    nu = ligne.strip()
    return len(nu) >= len(marque) and set(nu) == {marque[0]}


def markdown_vers_blocs(texte: str, col: Collecteur, meta: dict[str, Any]) -> None:
    lignes = texte.split("\n")
    titre: str | None = None
    para: list[str] = []
    i = 0
    if lignes and lignes[0].strip() == "---":
        fin = next((k for k in range(1, min(len(lignes), 60)) if lignes[k].strip() in ("---", "...")), None)
        if fin is not None:
            for brut in lignes[1:fin]:
                m = re.match(r"^title:\s*[\"']?(.+?)[\"']?\s*$", brut)
                if m:
                    titre = meta["title"] = m.group(1)
            i = fin + 1

    def vider() -> None:
        if para:
            col.ajouter("paragraph", compacter(" ".join(para)))
            para.clear()

    while i < len(lignes):
        ligne = lignes[i]
        cloture = _CLOTURE.match(ligne)
        if cloture:
            vider()
            marque = cloture.group(1)
            corps: list[str] = []
            i += 1
            while i < len(lignes) and not _ferme(lignes[i], marque):
                corps.append(lignes[i].rstrip())
                i += 1
            col.ajouter("code", "\n".join(corps).strip("\n"))
            i += 1
            continue
        if not ligne.strip():
            vider()
            i += 1
            continue
        atx = _TITRE_ATX.match(ligne)
        if atx:
            vider()
            texte_titre = compacter(atx.group(2))
            if titre is None and len(atx.group(1)) == 1:
                titre = meta["title"] = texte_titre
            col.ajouter("heading", texte_titre, level=len(atx.group(1)))
            i += 1
            continue
        souligne = _SOULIGNE.match(ligne)
        if souligne and para:
            niveau = 1 if souligne.group(1).startswith("=") else 2
            texte_titre = compacter(" ".join(para))
            para.clear()
            if titre is None and niveau == 1:
                titre = meta["title"] = texte_titre
            col.ajouter("heading", texte_titre, level=niveau)
            i += 1
            continue
        if _REGLE.match(ligne):
            vider()
            i += 1
            continue
        if "|" in ligne and i + 1 < len(lignes) and _SEP_TABLEAU.match(lignes[i + 1]) and "-" in lignes[i + 1]:
            vider()
            rangs: list[str] = []
            while i < len(lignes) and lignes[i].strip() and "|" in lignes[i]:
                rangs.append(lignes[i].strip())
                i += 1
            col.ajouter("table", "\n".join(rangs))
            continue
        if _LISTE.match(ligne):
            vider()
            items, i = _liste_md(lignes, i)
            col.ajouter("list", "\n".join(items))
            continue
        para.append(_CITATION.sub("", ligne).strip())
        i += 1
    vider()


def _delimiteur(echantillon: str, ext: str) -> str:
    if ext == ".tsv":
        return "\t"
    premiere = next((ligne for ligne in echantillon.splitlines() if ligne.strip()), "")
    comptes = {d: premiere.count(d) for d in (",", ";", "\t", "|")}
    meilleur = max(comptes, key=lambda d: comptes[d])
    return meilleur if comptes[meilleur] else ","


def _csv(chemin: Path, ext: str, col: Collecteur) -> None:
    with open(chemin, "rb") as fh:
        encodage = detecter_encodage(fh.read(65536))
    csv.field_size_limit(5_000_000)
    with open(chemin, encoding=encodage, errors="replace", newline="") as fh:
        delimiteur = _delimiteur(fh.read(8192), ext)
        fh.seek(0)
        try:
            col.tableau(([cellule(c) for c in ligne] for ligne in csv.reader(fh, delimiter=delimiteur)
                         if any(c.strip() for c in ligne)))
        except csv.Error as exc:
            raise ErreurExtracteur("corrupt", f"CSV illisible : {exc}")


def extraire(chemin: Path, ext: str, format_: str, col: Collecteur, meta: dict[str, Any]) -> None:
    col.progresser(0, 1)
    if format_ == "csv":
        _csv(chemin, ext, col)
    else:
        texte = lire_texte(chemin)
        if format_ == "md":
            markdown_vers_blocs(texte, col, meta)
        elif format_ == "txt":
            _paragraphes_txt(texte, col)
        else:
            _grouper_code(texte, col)
    col.progresser(1, 1)
