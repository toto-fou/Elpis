# SPDX-License-Identifier: MIT
"""office/elpis_office/excel.py — xlsx_read : feuilles, tableaux et cellules d'un classeur Excel de la sandbox (openpyxl, en flux)."""
from __future__ import annotations

import datetime as dt
import io
import posixpath
import re
from typing import Any, Dict, Iterable, Iterator, List, Optional, Tuple

from lxml import etree

from .commun import Env, OfficeError, booleen, canon, entier, lire_fichier
from .paquet import PaquetInvalide, controler_zip

ALIAS_READ: Dict[str, Iterable[str]] = {
    "path": ["file", "filename", "file_path", "fichier", "chemin", "workbook", "classeur"],
    "sheet": ["feuille", "onglet", "tab", "worksheet", "sheet_name"],
    "start": ["start_row", "from_row", "row", "ligne", "first_row"],
    "limit": ["rows", "max_rows", "count", "nb"],
    "find": ["search", "query", "chercher", "rechercher", "q", "grep", "text"],
    "formulas": ["formules", "show_formulas", "with_formulas"],
}
LIGNES_DEFAUT, LIGNES_MAX, COLONNES_MAX, TEXTE_MAX = 100, 500, 60, 300
TROUVES_MAX, CELLULES_FOUILLEES_MAX, FORMULES_MAX = 50, 2_000_000, 200
_S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
_PR = "{http://schemas.openxmlformats.org/package/2006/relationships}"


def _valeur(cellule: Any) -> Any:
    """Valeur telle que l'affiche Excel quand c'est utile : dates ISO, pourcentages, textes bornés."""
    v = cellule.value
    if isinstance(v, dt.datetime):
        return v.date().isoformat() if v.time() == dt.time() else v.isoformat(timespec="seconds")
    if isinstance(v, (dt.date, dt.time)):
        return v.isoformat()
    if isinstance(v, (int, float)) and not isinstance(v, bool) and "%" in str(cellule.number_format or ""):
        return f"{v * 100:.10g} %"
    if isinstance(v, str) and len(v) > TEXTE_MAX:
        return v[:TEXTE_MAX] + "…"
    return v


def _cible(dossier: str, cible: str) -> str:
    """Partie visée par une relation : chemin absolu dans le paquet, ou relatif au dossier de la source."""
    return cible.lstrip("/") if cible.startswith("/") else posixpath.normpath(posixpath.join(dossier, cible))


def _tableaux(archive) -> List[Dict[str, str]]:
    """Tableaux Excel (ListObjects) par feuille, lus dans le paquet : openpyxl en flux ne les voit pas."""
    try:
        classeur = etree.fromstring(archive.read("xl/workbook.xml"))
        liens = etree.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    except (KeyError, etree.XMLSyntaxError):
        return []
    cibles = {r.get("Id"): r.get("Target", "") for r in liens.iter(f"{_PR}Relationship")}
    out = []
    for feuille in classeur.iter(f"{_S}sheet"):
        chemin = _cible("xl", cibles.get(feuille.get(f"{_R}id"), ""))
        rels = posixpath.join(posixpath.dirname(chemin), "_rels", posixpath.basename(chemin) + ".rels")
        try:
            liens_feuille = etree.fromstring(archive.read(rels))
        except (KeyError, etree.XMLSyntaxError):
            continue
        for lien in liens_feuille.iter(f"{_PR}Relationship"):
            if not lien.get("Type", "").endswith("/table"):
                continue
            partie = _cible(posixpath.dirname(chemin), lien.get("Target", ""))
            try:
                table = etree.fromstring(archive.read(partie))
            except (KeyError, etree.XMLSyntaxError):
                continue
            out.append({"table": table.get("displayName") or table.get("name") or "",
                        "sheet": feuille.get("name", ""), "range": table.get("ref", "")})
    return out


def _feuille(classeur: Any, voulue: Any) -> Any:
    noms = classeur.sheetnames
    if voulue in (None, ""):
        visibles = [n for n in noms if classeur[n].sheet_state == "visible"]
        return classeur[(visibles or noms)[0]]
    nom = {n.casefold(): n for n in noms}.get(str(voulue).strip().casefold())
    k = entier(voulue)
    if nom is None and k is not None and 1 <= k <= len(noms):
        nom = noms[k - 1]
    if nom is None:
        raise OfficeError(f"sheet {voulue!r} does not exist", code="bad_index",
                          fix=f"sheets of this workbook: {', '.join(noms)} (a name, or a number from 1)")
    return classeur[nom]


def _dimension(feuille: Any) -> str:
    try:
        return feuille.calculate_dimension()
    except ValueError:                              # feuille sans dimension déclarée
        return ""


def _lignes(feuille: Any, debut: int, nb: int) -> Tuple[List[Dict[str, Any]], Optional[int], int]:
    """Lignes non vides de ``debut`` (1-based), au plus ``nb`` ; rend aussi la ligne suivante et la largeur."""
    lignes: List[Dict[str, Any]] = []
    suite, largeur = None, 0
    for cellules in feuille.iter_rows(min_row=debut, max_col=COLONNES_MAX):
        valeurs = [_valeur(c) for c in cellules]
        while valeurs and valeurs[-1] in (None, ""):
            valeurs.pop()
        if not valeurs:
            continue
        numero = next((c.row for c in cellules if getattr(c, "row", None)), None)
        if len(lignes) >= nb:
            suite = numero
            break
        lignes.append({"row": numero, "cells": valeurs})
        largeur = max(largeur, len(valeurs))
    return lignes, suite, largeur


def _colonne(n: int) -> str:
    lettres = ""
    while n:
        n, reste = divmod(n - 1, 26)
        lettres = chr(65 + reste) + lettres
    return lettres


def _chercher(classeur: Any, motif: str) -> Tuple[List[Dict[str, Any]], bool]:
    cherche, vues = motif.casefold(), 0
    trouves: List[Dict[str, Any]] = []
    for feuille in classeur.worksheets:
        for cellules in feuille.iter_rows():
            for c in cellules:
                vues += 1
                if vues > CELLULES_FOUILLEES_MAX:
                    return trouves, True
                if c.value is not None and cherche in str(c.value).casefold():
                    trouves.append({"sheet": feuille.title, "cell": f"{_colonne(c.column)}{c.row}",
                                    "value": _valeur(c)})
                    if len(trouves) >= TROUVES_MAX:
                        return trouves, True
    return trouves, False


def _formules(brut: bytes, nom: str, debut: int, fin: int) -> Iterator[Dict[str, str]]:
    from openpyxl import load_workbook

    classeur = load_workbook(io.BytesIO(brut), read_only=True, data_only=False)
    try:
        for cellules in classeur[nom].iter_rows(min_row=debut, max_row=fin, max_col=COLONNES_MAX):
            for c in cellules:
                if isinstance(c.value, str) and c.value.startswith("="):
                    yield {"cell": f"{_colonne(c.column)}{c.row}", "formula": c.value}
    finally:
        classeur.close()


def xlsx_read(args: Dict[str, Any], env: Env) -> Dict[str, Any]:
    from openpyxl import load_workbook

    a = canon(args, ALIAS_READ, env.notes)
    rel, brut = lire_fichier(env, a.get("path"), "xlsx", "workbook")
    try:
        archive = controler_zip(brut, f"workbook '{rel}'")
        tableaux, graphiques = _tableaux(archive), sum(
            1 for n in archive.namelist() if re.fullmatch(r"xl/charts/chart\d+\.xml", n))
        classeur = load_workbook(io.BytesIO(brut), read_only=True, data_only=True)
    except PaquetInvalide as e:
        raise OfficeError(str(e), code="bad_file", fix="check that the file is a valid .xlsx workbook")
    except Exception as e:                          # noqa: BLE001 — classeur illisible
        raise OfficeError(f"the workbook cannot be read: {e}", code="bad_file",
                          fix="check that the file is an .xlsx or .xlsm workbook (.xls is not read)")
    try:
        feuilles = []
        for f in classeur.worksheets:
            feuilles.append({"sheet": f.title, "size": _dimension(f), "rows": f.max_row or 0,
                             "columns": f.max_column or 0, **({"hidden": True} if f.sheet_state != "visible" else {})})
        res: Dict[str, Any] = {"path": env.espace.afficher(rel), "sheets": feuilles}
        if tableaux:
            res["tables"] = tableaux
        if graphiques:
            res["charts"] = graphiques
        if a.get("find"):
            trouves, tronque = _chercher(classeur, str(a["find"]))
            res["matches"] = trouves
            if tronque:
                res["matches_note"] = "search stopped early: narrow the text, or read a sheet"
            if not trouves:
                res["matches_note"] = f"'{a['find']}' not found (case ignored)"
            if a.get("sheet") in (None, ""):
                return res
        feuille = _feuille(classeur, a.get("sheet"))
        debut = max(1, entier(a.get("start")) or 1)
        nb = min(max(1, entier(a.get("limit")) or LIGNES_DEFAUT), LIGNES_MAX)
        lignes, suite, largeur = _lignes(feuille, debut, nb)
        res.update({"sheet": feuille.title, "columns": [_colonne(i) for i in range(1, largeur + 1)],
                    "rows": lignes})
        if (feuille.max_column or 0) > COLONNES_MAX:
            res["columns_note"] = f"only the first {COLONNES_MAX} columns are listed"
        if suite is not None:
            res["next_row"] = suite
            res["note"] = f"more rows: call xlsx_read again with start={suite}"
    finally:
        classeur.close()
    if booleen(a.get("formulas")) and res.get("rows"):
        fin = res["rows"][-1]["row"]
        res["formulas"] = list(_formules(brut, res["sheet"], debut, fin))[:FORMULES_MAX]
    return res
