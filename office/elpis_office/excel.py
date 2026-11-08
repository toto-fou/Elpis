# SPDX-License-Identifier: MIT
"""office/elpis_office/excel.py — xlsx_read : feuilles, tableaux et cellules d'un classeur Excel de la sandbox (openpyxl, en flux)."""
from __future__ import annotations

import datetime as dt
import io
import posixpath
import re
from typing import Any, Dict, Iterable, Iterator, List, Optional, Tuple

from lxml import etree

from ._chart.normalise import Notes, to_date, to_number, to_records
from .commun import Env, OfficeError, booleen, canon, chemin_sortie, ecrire, entier, lire_fichier, texte
from .langue import choisir as choisir_langue, textes_de
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


# ── xlsx_create ─────────────────────────────────────────────────────────────
ALIAS_CREATE: Dict[str, Iterable[str]] = {
    "path": ALIAS_READ["path"],
    "sheets": ["feuilles", "onglets", "tabs", "worksheets"],
    "data": ["rows", "lignes", "donnees", "table", "content", "contenu"],
    "title": ["titre"],
    "author": ["auteur", "by"],
    "lang": ["language", "langue", "locale"],
}
ALIAS_FEUILLE: Dict[str, Iterable[str]] = {
    "name": ["sheet", "title", "nom", "feuille", "onglet"],
    "data": ALIAS_CREATE["data"],
    "table": ["excel_table", "as_table", "tableau"],
    "totals": ["total", "totaux", "sum_row"],
}
LIGNES_CREATION_MAX = 50_000
_FORMAT_DATE = {"en": "mm/dd/yyyy", "de": "dd.mm.yyyy"}
_MONNAIES = {"€": '#,##0.00 "€"', "$": '"$"#,##0.00', "£": '"£"#,##0.00', "CHF": '#,##0.00 "CHF"'}
_NOM_INTERDIT = re.compile(r"[\\/?*\[\]:]")


def _lignes_de(donnees: Any, notes: Notes) -> List[Dict[str, Any]]:
    """Lignes d'une feuille ; une première ligne de textes est l'en-tête, comme dans un tableur."""
    if isinstance(donnees, list) and len(donnees) > 1 and all(isinstance(r, (list, tuple)) for r in donnees) \
            and donnees[0] and all(isinstance(x, str) and x.strip() for x in donnees[0]):
        entete = [str(x).strip() for x in donnees[0]]
        return [{entete[i]: v for i, v in enumerate(r) if i < len(entete)} for r in donnees[1:]]
    return to_records(donnees, notes)


def _type_colonne(valeurs: List[Any]) -> Tuple[str, Optional[str]]:
    """(genre, format Excel) d'une colonne : date, pourcentage, monnaie, nombre, sinon texte."""
    pleines = [v for v in valeurs if v not in (None, "") and not (isinstance(v, str) and v.startswith("="))]
    if not pleines:
        return "text", None
    if all(not isinstance(v, (int, float)) and to_date(v) for v in pleines):
        return "date", None
    nombres = [to_number(v) for v in pleines]
    if any(n.value is None for n in nombres):
        return "text", None
    unites = {n.unit for n in nombres}
    if unites == {"%"}:
        return "percent", "0.0%"
    unite = next(iter(unites)) if len(unites) == 1 else None
    if unite is not None and unite in _MONNAIES:
        return "currency", _MONNAIES[unite]
    entiers = all(float(n.value).is_integer() for n in nombres if n.value is not None)
    return "number", ("#,##0" if entiers else "#,##0.00")


def _nom_feuille(brut: Any, i: int, vus: set, notes: Notes) -> str:
    nom = _NOM_INTERDIT.sub(" ", str(brut or f"Feuille{i + 1}")).strip(" '")[:31] or f"Feuille{i + 1}"
    base, k = nom, 2
    while nom.casefold() in vus:
        nom = f"{base[:28]} ({k})"
        k += 1
    if str(brut or "") and nom != str(brut):
        notes.fix(f"sheet name '{brut}' saved as '{nom}' (31 characters, no []:*?/\\)")
    vus.add(nom.casefold())
    return nom


def _ecrire_feuille(classeur: Any, feuille: Any, lignes: List[Dict[str, Any]], spec: Dict[str, Any],
                    format_date: str) -> Dict[str, Any]:
    entetes = list(dict.fromkeys(k for ligne in lignes for k in ligne))
    genres = {k: _type_colonne([ligne.get(k) for ligne in lignes]) for k in entetes}
    formats = {k: classeur.add_format({"num_format": f}) for k, (_, f) in genres.items() if f}
    fmt_date = classeur.add_format({"num_format": format_date})
    largeurs = [len(str(k)) for k in entetes]
    for r, ligne in enumerate(lignes, start=1):
        for c, k in enumerate(entetes):
            v = ligne.get(k)
            genre = genres[k][0]
            if v in (None, ""):
                continue
            if isinstance(v, str) and v.startswith("="):
                feuille.write_formula(r, c, v, formats.get(k), "")      # résultat inconnu ici : pas de 0 en cache
            elif genre == "date":
                feuille.write_datetime(r, c, dt.datetime.fromisoformat(str(to_date(v))), fmt_date)
            elif genre in ("percent", "currency", "number"):
                n = to_number(v).value or 0.0
                feuille.write_number(r, c, n / 100 if genre == "percent" and not isinstance(v, (int, float)) else n,
                                     formats.get(k))
            else:
                feuille.write(r, c, v if isinstance(v, (int, float, bool)) else str(v))
            largeurs[c] = max(largeurs[c], len(str(v)))
    for c, largeur in enumerate(largeurs):
        feuille.set_column(c, c, min(max(8, largeur + 2), 60))
    n, m = len(lignes), len(entetes)
    numeriques = [c for c, k in enumerate(entetes) if genres[k][0] in ("number", "currency")]
    sommes = {c: sum(to_number(ligne.get(entetes[c])).value or 0.0 for ligne in lignes
                     if not str(ligne.get(entetes[c]) or "").startswith("=")) for c in numeriques}
    totaux = booleen(spec.get("totals"))
    if booleen(spec.get("table"), False) and m:
        colonnes = []
        for c, k in enumerate(entetes):
            col: Dict[str, Any] = {"header": str(k), **({"format": formats[k]} if k in formats else {})}
            if totaux:
                col.update({"total_function": "sum", "total_value": sommes[c]} if c in numeriques else
                           ({"total_string": "Total"} if c == 0 else {}))
            colonnes.append(col)
        feuille.add_table(0, 0, n + (1 if totaux else 0), m - 1,
                          {"columns": colonnes, "style": "Table Style Medium 2", "total_row": totaux})
    else:
        style_entete = {"bold": True, "font_color": "#FFFFFF", "bg_color": "#1F4E79", "border": 1,
                        "border_color": "#1F4E79"}
        entete = classeur.add_format(style_entete)
        entete_droite = classeur.add_format({**style_entete, "align": "right"})
        for c, k in enumerate(entetes):
            feuille.write(0, c, str(k), entete if genres[k][0] == "text" else entete_droite)
        if n and m:
            feuille.autofilter(0, 0, n, m - 1)
        if totaux and n:
            gras = classeur.add_format({"bold": True, "top": 1})
            for c in range(m):
                feuille.write_blank(n + 1, c, None, gras)
            feuille.write(n + 1, 0, "Total", gras)
            for c in numeriques:
                lettre = _colonne(c + 1)
                feuille.write_formula(n + 1, c, f"=SUBTOTAL(109,{lettre}2:{lettre}{n + 1})",
                                      classeur.add_format({"bold": True, "top": 1,
                                                           "num_format": genres[entetes[c]][1] or "General"}),
                                      sommes[c])
    feuille.freeze_panes(1, 0)
    return {"sheet": feuille.get_name(), "rows": n, "columns": m,
            "types": {str(k): genres[k][0] for k in entetes}}


def xlsx_create(args: Dict[str, Any], env: Env) -> Dict[str, Any]:
    import xlsxwriter

    a = canon(args, ALIAS_CREATE, env.notes)
    rel = chemin_sortie(a.get("path"), "xlsx", env.notes)
    feuilles = a.get("sheets")
    if feuilles in (None, "", []) and a.get("data") is not None:
        feuilles = [{"name": a.get("title") or "Feuille1", "data": a["data"]}]
    if isinstance(feuilles, dict):
        feuilles = [feuilles]
    if not isinstance(feuilles, list) or not feuilles:
        raise OfficeError("sheets is empty", code="empty_content",
                          fix="sheets = [{name, data: rows}], one object per sheet",
                          example=[{"name": "Ventes", "data": [{"mois": "janv.", "ventes": 120},
                                                              {"mois": "févr.", "ventes": 135}]}])
    lang = choisir_langue(a.get("lang"), [str(a.get("title") or ""), *textes_de(feuilles)], env.notes)
    format_date = _FORMAT_DATE.get(lang[:2], "dd/mm/yyyy")
    sortie = io.BytesIO()
    classeur = xlsxwriter.Workbook(sortie, {"in_memory": True, "strings_to_numbers": False,
                                            "strings_to_formulas": False, "strings_to_urls": False})
    classeur.set_properties({"title": texte(a.get("title")) or "", "author": texte(a.get("author")) or ""})
    bilan: List[Dict[str, Any]] = []
    vus: set = set()
    total = 0
    for i, brut in enumerate(feuilles):
        spec = canon(brut if isinstance(brut, dict) else {"data": brut}, ALIAS_FEUILLE, env.notes,
                     f"sheets[{i}].")
        lignes = _lignes_de(spec.get("data"), env.notes)
        if not lignes:
            raise OfficeError(f"sheets[{i}]: no rows", code="empty_content",
                              fix="data = a list of rows: [{column: value}, …] or [[header…], [values…]]")
        if total + len(lignes) > LIGNES_CREATION_MAX:
            env.notes.warn(f"sheets[{i}]: rows beyond {LIGNES_CREATION_MAX} in total were left out")
            lignes = lignes[:max(0, LIGNES_CREATION_MAX - total)]
        total += len(lignes)
        feuille = classeur.add_worksheet(_nom_feuille(spec.get("name"), i, vus, env.notes))
        bilan.append(_ecrire_feuille(classeur, feuille, lignes, spec, format_date))
    classeur.close()
    res = ecrire(env, rel, sortie.getvalue())
    return {**res, "sheets": bilan,
            "summary": f"{'Replaced' if res['old_sha256'] else 'Created'} {res['path']}: "
                       + ", ".join(f"{b['sheet']} ({b['rows']} rows × {b['columns']} columns)" for b in bilan)}
