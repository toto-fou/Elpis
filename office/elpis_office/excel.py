# SPDX-License-Identifier: MIT
"""office/elpis_office/excel.py — xlsx_read (feuilles, tableaux, cellules d'un classeur, openpyxl en flux) et xlsx_create (XlsxWriter)."""
from __future__ import annotations

import datetime as dt
import io
import posixpath
import re
from functools import lru_cache
from typing import Any, Dict, Iterable, Iterator, List, Optional, Tuple

from lxml import etree

from . import formules as F
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
# Formule sans <v> (ou <v/> vide) avant la fin de sa cellule ; en temps linéaire (pas de \s* adjacents).
_SANS_RESULTAT = re.compile(rb"(?:</f>|<f\b[^<>]*/>)\s*(?:(?:<v\s*/>|<v>\s*</v>)\s*)?</c>")


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


def _lignes(feuille: Any, debut: int, nb: int, formules: Any = None) -> Tuple[List[Dict[str, Any]], Optional[int], int, int]:
    """Lignes non vides dès ``debut`` (au plus ``nb``), ligne suivante, largeur et formules sans résultat montrées {formula}."""
    lignes: List[Dict[str, Any]] = []
    suite, largeur, sans_resultat = None, 0, 0
    textes = formules.iter_rows(min_row=debut, max_col=COLONNES_MAX) if formules is not None else None
    for cellules in feuille.iter_rows(min_row=debut, max_col=COLONNES_MAX):
        valeurs: List[Any] = [_valeur(c) for c in cellules]
        for k, c in enumerate(next(textes, ()) if textes is not None else ()):
            # t="str" sans valeur : résultat vide enregistré (=IF(…;"";…)), pas une formule à calculer.
            if k < len(valeurs) and valeurs[k] in (None, "") and getattr(cellules[k], "data_type", "") != "str" \
                    and isinstance(c.value, str) and c.value.startswith("="):
                valeurs[k] = {"formula": c.value}
                sans_resultat += 1
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
    return lignes, suite, largeur, sans_resultat


def _sans_resultat(archive: Any, titre: str) -> bool:
    """La feuille a-t-elle des formules sans résultat enregistré (classeur écrit par un programme, jamais recalculé) ?"""
    try:
        classeur = etree.fromstring(archive.read("xl/workbook.xml"))
        liens = etree.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    except (KeyError, etree.XMLSyntaxError):
        return False
    cibles = {r.get("Id"): r.get("Target", "") for r in liens.iter(f"{_PR}Relationship")}
    partie = next((_cible("xl", cibles.get(f.get(f"{_R}id"), "")) for f in classeur.iter(f"{_S}sheet")
                   if f.get("name") == titre), None)
    if partie is None:
        return False
    motif, reste = _SANS_RESULTAT, b""
    try:
        with archive.open(partie) as flux:
            while bloc := flux.read(1 << 20):
                if motif.search(reste + bloc):
                    return True
                reste = bloc[-256:]
    except KeyError:
        return False
    return False


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
        formules = None
        if _sans_resultat(archive, feuille.title):
            textes = load_workbook(io.BytesIO(brut), read_only=True, data_only=False)
            formules = textes[feuille.title]
        try:
            lignes, suite, largeur, sans_resultat = _lignes(feuille, debut, nb, formules)
        finally:
            if formules is not None:
                textes.close()
        res.update({"sheet": feuille.title, "columns": [_colonne(i) for i in range(1, largeur + 1)],
                    "rows": lignes})
        if sans_resultat:
            res["formulas_note"] = (f"{sans_resultat} cell(s) hold a formula with no saved result, shown as "
                                    "{formula}: the file was written by a program and never recalculated. Excel "
                                    "or LibreOffice computes them on opening; office_export shows them in a PDF.")
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
FORMULES_CONTROLEES_MAX, DEFAUTS_MONTRES = 5_000, 6
_FORMAT_DATE = {"en": "mm/dd/yyyy", "de": "dd.mm.yyyy"}
# Langue des formats (LCID) : LibreOffice affiche alors 1 234,50 € ; Excel suit les réglages du poste.
_LCID = {"fr": "[$-40C]", "de": "[$-407]", "es": "[$-C0A]", "it": "[$-410]"}
_MONNAIES = {"€": '#,##0.00 "€"', "$": '"$"#,##0.00', "£": '"£"#,##0.00', "CHF": '#,##0.00 "CHF"'}
_NOM_INTERDIT = re.compile(r"[\\/?*\[\]:]")
_FONCTION = re.compile(r"(?<![A-Za-z0-9._])([A-Za-z_][A-Za-z0-9._]*)\s*\(")    # linéaire : un départ par nom
_EPOQUE = dt.datetime(1899, 12, 30)
_NUMERIQUES = ("number", "currency", "percent", "date")


def _lignes_de(donnees: Any, notes: Notes) -> List[Dict[str, Any]]:
    """Lignes d'une feuille ; une première ligne de textes est l'en-tête, comme dans un tableur."""
    if isinstance(donnees, list) and len(donnees) > 1 and all(isinstance(r, (list, tuple)) for r in donnees) \
            and donnees[0] and all(isinstance(x, str) and x.strip() for x in donnees[0]):
        entete = [str(x).strip() for x in donnees[0]]
        return [{entete[i]: v for i, v in enumerate(r) if i < len(entete)} for r in donnees[1:]]
    return to_records(donnees, notes)


def _formule(v: Any) -> bool:
    return isinstance(v, str) and v.startswith("=")


def _type_colonne(valeurs: List[Any]) -> Tuple[str, Optional[str]]:
    """(genre, format Excel) d'une colonne d'après ses constantes ; « formula » si elle n'a que des formules."""
    pleines = [v for v in valeurs if v not in (None, "") and not _formule(v)]
    if not pleines:
        return ("formula" if any(_formule(v) for v in valeurs) else "text"), None
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


def _typee(v: Any, genre: str) -> Any:
    """Valeur écrite dans la cellule, et vue par les formules : formule, date, nombre ou texte."""
    if v in (None, ""):
        return None
    if _formule(v):
        return v
    if genre == "date":
        return dt.datetime.fromisoformat(str(to_date(v)))
    if genre in ("percent", "currency", "number"):
        n = to_number(v).value or 0.0
        return n / 100 if genre == "percent" and not isinstance(v, (int, float)) else float(n)
    return v if isinstance(v, (int, float, bool)) else str(v)


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


class _Feuille:
    """Une feuille à écrire : en-têtes, genre des colonnes et cellules typées (lignes et colonnes à partir de 1)."""

    def __init__(self, nom: str, lignes: List[Dict[str, Any]], spec: Dict[str, Any]) -> None:
        self.nom, self.n = nom, len(lignes)
        self.entetes = list(dict.fromkeys(k for ligne in lignes for k in ligne))
        self.genres = {k: _type_colonne([ligne.get(k) for ligne in lignes]) for k in self.entetes}
        self.table = booleen(spec.get("table"), False) and bool(self.entetes)
        self.totaux = booleen(spec.get("totals")) and self.n > 0
        self.cellules: Dict[Tuple[int, int], Any] = {(1, c): str(k) for c, k in enumerate(self.entetes, 1)}
        for r, ligne in enumerate(lignes, 2):
            for c, k in enumerate(self.entetes, 1):
                v = _typee(ligne.get(k), self.genres[k][0])
                if v is not None:
                    self.cellules[(r, c)] = v

    def modele(self) -> Dict[Tuple[int, int], Any]:
        """Cellules vues par le calcul des formules : dates en numéros de série, comme dans Excel."""
        return {k: (v - _EPOQUE).total_seconds() / 86400 if isinstance(v, dt.datetime) else v
                for k, v in self.cellules.items()}

    def formules(self) -> Iterator[Tuple[str, str]]:
        for (r, c), v in self.cellules.items():
            if _formule(v):
                yield f"{_colonne(c)}{r}", v


class _Formats:
    """Formats XlsxWriter partagés ; codes de nombre préfixés de la langue du classeur."""

    def __init__(self, classeur: Any, lang: str) -> None:
        self.classeur, self.prefixe = classeur, _LCID.get(lang[:2], "")
        self.date = _FORMAT_DATE.get(lang[:2], "dd/mm/yyyy")
        self.espace_pourcent = lang[:2] == "fr"           # 12,5 % en typographie française
        self._vus: Dict[Tuple[Any, ...], Any] = {}

    def code(self, code: str) -> str:
        if self.espace_pourcent and code.endswith("%") and not code.endswith(" %"):
            code = code[:-1] + " %"
        return code

    def __call__(self, code: Optional[str] = None, **style: Any) -> Any:
        if code:
            style["num_format"] = self.prefixe + self.code(code)
        cle = tuple(sorted(style.items()))
        if cle not in self._vus:
            self._vus[cle] = self.classeur.add_format(style) if style else None
        return self._vus[cle]

    def du_genre(self, genre: str, code: Optional[str], **style: Any) -> Any:
        return self(self.date if genre == "date" else code, **style)


def _genre_resultat(f: _Feuille, feuilles: Dict[str, _Feuille], formule: str, v: Any) -> Tuple[str, Optional[str]]:
    """Genre d'une formule d'une colonne sans constantes : celui de la cellule qu'elle calcule, comme Excel."""
    if isinstance(v, (str, bool)):                  # texte, booléen ou code d'erreur
        return "text", None
    exterieure, ref = F.premiere_reference(formule, f.nom)
    genre, code = "number", None
    source = feuilles.get(ref[0]) if ref is not None and exterieure not in F.COMPTES else None
    if source is not None and ref is not None and 2 <= ref[1] <= source.n + 1 and ref[2] <= len(source.entetes):
        genre, code = source.genres[source.entetes[ref[2] - 1]]
    if genre not in _NUMERIQUES:
        genre = "number"
    if genre == "number":
        code = "#,##0" if isinstance(v, float) and v.is_integer() else "#,##0.00"
    return genre, code


def _largeur(v: Any, genre: str, code: Optional[str], formats: _Formats) -> int:
    """Caractères affichés par une cellule une fois formatée (1 234,50 € et non 1234.5) : la colonne s'y ajuste."""
    if v in (None, ""):
        return 0
    if isinstance(v, dt.datetime) or (genre == "date" and isinstance(v, (int, float))):
        return len(formats.date)
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return len(str(v))
    decimales, litteraux, pourcent = _gabarit(formats.code(code or "#,##0.00"))
    nombre = v * 100 if pourcent else v
    return len(f"{nombre:,.{decimales}f}") + litteraux


@lru_cache(maxsize=256)
def _gabarit(code: str) -> Tuple[int, int, bool]:
    """(décimales, caractères littéraux, pourcentage) d'un format numérique, lus une fois par format."""
    decimales = len(code.split(".", 1)[1].split("%")[0].split(" ")[0].split('"')[0]) if "." in code else 0
    return decimales, len(re.sub(r'\[[^\]]*\]|[#0,.]', "", code.replace('"', ""))), "%" in code


def _ecrire_feuille(feuille: Any, f: _Feuille, feuilles: Dict[str, _Feuille], modele: F.Classeur,
                    formats: _Formats) -> Dict[str, Any]:
    genres = dict(f.genres)
    par_formule: Dict[str, List[Tuple[str, Optional[str]]]] = {k: [] for k, (g, _) in genres.items() if g == "formula"}
    largeurs = [len(str(k)) for k in f.entetes]
    non_calculees: List[str] = []
    for (r, c), v in sorted(f.cellules.items()):
        if r == 1:
            continue
        k = f.entetes[c - 1]
        genre, code = genres[k]
        if _formule(v):
            resultat = modele.resultat(f.nom, r, c)
            if resultat is None:
                non_calculees.append(f"{_colonne(c)}{r}")
            if genre == "formula":
                genre, code = _genre_resultat(f, feuilles, v, resultat)
                par_formule[k].append((genre, code))
            feuille.write_formula(r - 1, c - 1, v, formats.du_genre(genre, code),
                                  "" if resultat is None else resultat)
            largeurs[c - 1] = max(largeurs[c - 1], _largeur(resultat, genre, code, formats))
            continue
        if isinstance(v, dt.datetime):
            feuille.write_datetime(r - 1, c - 1, v, formats.du_genre("date", None))
        elif genre in ("percent", "currency", "number"):
            feuille.write_number(r - 1, c - 1, v, formats(code))
        else:
            feuille.write(r - 1, c - 1, v)
        largeurs[c - 1] = max(largeurs[c - 1], _largeur(v, genre, code, formats))
    for k, vus in par_formule.items():
        distincts = set(vus)
        genres[k] = distincts.pop() if len(distincts) == 1 else (
            ("number", "#,##0.00") if vus and all(g in _NUMERIQUES for g, _ in vus) else ("text", None))
    n, m = f.n, len(f.entetes)
    totaux = {}
    if f.totaux:
        for c, k in enumerate(f.entetes, 1):
            somme = genres[k][0] in ("number", "currency")
            modele.poser(f.nom, n + 2, c, f"=SUBTOTAL(109,{_colonne(c)}2:{_colonne(c)}{n + 1})" if somme
                         else ("Total" if c == 1 else None))
            if somme:
                totaux[c] = modele.resultat(f.nom, n + 2, c)
                largeurs[c - 1] = max(largeurs[c - 1], _largeur(totaux[c], *genres[k], formats) + 1)  # gras
    for c, largeur in enumerate(largeurs):
        feuille.set_column(c, c, min(max(8, largeur + 2), 60))
    if f.table:
        colonnes = []
        for c, k in enumerate(f.entetes, 1):
            genre, code = genres[k]
            fmt = formats.du_genre(genre, code) if genre in _NUMERIQUES else None
            col: Dict[str, Any] = {"header": str(k), **({"format": fmt} if fmt is not None else {})}
            if f.totaux:
                col.update({"total_function": "sum", "total_value": "" if totaux[c] is None else totaux[c]}
                           if c in totaux else ({"total_string": "Total"} if c == 1 else {}))
            colonnes.append(col)
        feuille.add_table(0, 0, n + (1 if f.totaux else 0), m - 1,
                          {"columns": colonnes, "style": "Table Style Medium 2", "total_row": f.totaux})
    else:
        style_entete: Dict[str, Any] = {"bold": True, "font_color": "#FFFFFF", "bg_color": "#1F4E79",
                                        "border": 1, "border_color": "#1F4E79"}
        for c, k in enumerate(f.entetes):
            droite = genres[k][0] in _NUMERIQUES
            feuille.write(0, c, str(k), formats(**style_entete, **({"align": "right"} if droite else {})))
        if n and m:
            feuille.autofilter(0, 0, n, m - 1)
        if f.totaux:
            gras = formats(bold=True, top=1)
            for c in range(m):
                feuille.write_blank(n + 1, c, None, gras)
            feuille.write(n + 1, 0, "Total", gras)
            for c, valeur in totaux.items():
                lettre = _colonne(c)
                feuille.write_formula(n + 1, c - 1, f"=SUBTOTAL(109,{lettre}2:{lettre}{n + 1})",
                                      formats(genres[f.entetes[c - 1]][1] or "#,##0.00", bold=True, top=1),
                                      "" if valeur is None else valeur)
    feuille.freeze_panes(1, 0)
    bilan: Dict[str, Any] = {"sheet": feuille.get_name(), "rows": n, "columns": m,
                             "types": {str(k): genres[k][0] for k in f.entetes}}
    if non_calculees:
        bilan["computed_on_opening"] = non_calculees[:10] + (["…"] if len(non_calculees) > 10 else [])
    return bilan


def _controler_formules(feuilles: List[_Feuille], notes: Notes) -> None:
    """Avertit des formules sûrement fausses (feuille absente, fonction inconnue…) : Excel y afficherait une erreur."""
    noms = [f.nom for f in feuilles]
    defauts: List[str] = []
    vues = 0
    for f in feuilles:
        for cellule, formule in f.formules():
            vues += 1
            if vues > FORMULES_CONTROLEES_MAX:
                break
            defauts += [f"'{f.nom}'!{cellule} {formule}: {d}" for d in F.controler(formule, noms)]
    for d in defauts[:DEFAUTS_MONTRES]:
        notes.warn(f"{d}; Excel will show an error there")
    if len(defauts) > DEFAUTS_MONTRES:
        notes.warn(f"… and {len(defauts) - DEFAUTS_MONTRES} more formula problems")


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
    textes = [t for t in textes_de(feuilles) if not t.startswith("=")]       # « E2:E4 » n'est pas de l'italien
    lang = choisir_langue(a.get("lang"), [str(a.get("title") or ""), *textes], env.notes)
    prepas: List[_Feuille] = []
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
        prepas.append(_Feuille(_nom_feuille(spec.get("name"), i, vus, env.notes), lignes, spec))
    _controler_formules(prepas, env.notes)
    modele = F.Classeur()
    for f in prepas:
        modele.ajouter(f.nom, f.modele())
        if f.totaux:
            for c in range(1, len(f.entetes) + 1):
                modele.reserver(f.nom, f.n + 2, c)
            modele.etendre(f.nom)
    sortie = io.BytesIO()
    # Préfixe _xlfn. seulement si une formule en a besoin : l'option coûte ~150 substitutions par formule.
    futures = any(F.fonction_future(nom.upper()) for nom in
                  {m for f in prepas for _, formule in f.formules() for m in _FONCTION.findall(formule)})
    classeur = xlsxwriter.Workbook(sortie, {"in_memory": True, "strings_to_numbers": False,
                                            "strings_to_formulas": False, "strings_to_urls": False,
                                            "use_future_functions": futures})
    classeur.set_properties({"title": texte(a.get("title")) or "", "author": texte(a.get("author")) or ""})
    formats = _Formats(classeur, lang)
    par_nom = {f.nom.casefold(): f for f in prepas}
    bilan = [_ecrire_feuille(classeur.add_worksheet(f.nom), f, par_nom, modele, formats) for f in prepas]
    classeur.close()
    res = ecrire(env, rel, sortie.getvalue())
    return {**res, "sheets": bilan,
            "summary": f"{'Replaced' if res['old_sha256'] else 'Created'} {res['path']}: "
                       + ", ".join(f"{b['sheet']} ({b['rows']} rows × {b['columns']} columns)" for b in bilan)}
