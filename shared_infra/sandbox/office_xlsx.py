# SPDX-License-Identifier: MIT
"""shared_infra.sandbox.office_xlsx — lecture d'un classeur .xlsx EN FLUX.

Pourquoi ce module (2026-09-18)
===============================
La grille de l'éditeur passait par LibreOffice : le classeur ENTIER était
converti en CSV avant le premier pixel. Mesuré sur cette machine, chaîne
complète (conversion + découpage) :

    15,6 Mo · 3 feuilles · 240 000 lignes  →  13,7 s + 1,3 s, 28 Mo de cache
    25,9 Mo · 5 feuilles · 400 000 lignes  →  24,9 s + 2,1 s, 47 Mo de cache

Soit ~50 s pour 50 Mo : au-delà du délai de conversion (60 s par défaut, partagé
avec les autres aperçus), et pour rien — un écran montre 40 lignes.

Ici, le fichier est lu TEL QUEL : `zipfile` + `ElementTree.iterparse` sur la
feuille demandée. Le coût devient proportionnel à ce qu'on REGARDE :

    200 premières lignes  →  13 ms      (contre 15 s de conversion préalable)
    parcours complet      →  ~60 000 lignes/s, mémoire stable (~20 Mo)

Ce que ça change pour l'utilisateur : un classeur de 50 Mo s'ouvre tout de
suite, et seules les feuilles réellement ouvertes sont lues.

Fidélité de rendu
=================
LibreOffice écrivait les valeurs « telles qu'affichées ». On refait donc ce
travail : `styles.xml` donne le code de format de chaque cellule, appliqué ici
(dates, heures, pourcentages, décimales, milliers, texte, booléens, erreurs).
Les cas exotiques (sections conditionnelles ou colorées, fractions, notation
scientifique personnalisée) retombent sur un rendu simple — jamais sur une
valeur brute trompeuse pour une date.

Sécurité
========
Mêmes garde-fous que le reste du module d'aperçu : aucune entité XML (les
parties sont refusées si elles contiennent ``<!DOCTYPE``/``<!ENTITY``), tailles
bornées (chaînes partagées, styles, cellule, colonnes, lignes), et l'archive
a déjà été validée par ``office_preview.check_ooxml`` (ratio de compression,
noms de membres, famille du document).
"""
from __future__ import annotations

import logging
import re
import zipfile
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple
from xml.etree import ElementTree as ET

logger = logging.getLogger("uvicorn.error")

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
NS_REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"

# Bornes de lecture (le reste des plafonds d'affichage vit dans office_preview).
SST_MAX_ITEMS = 2_000_000          # chaînes partagées retenues
SST_MAX_CHARS = 64 * 1024 * 1024   # …et leur poids cumulé
STYLES_MAX_XF = 65_536
HEAD_BYTES = 16 * 1024             # en-tête de feuille lu pour ``<dimension>``

_DIM_RE = re.compile(rb'<dimension[^>]*\sref="([A-Z]+\d+)(?::([A-Z]+)(\d+))?"')
_UNSAFE = (b"<!DOCTYPE", b"<!ENTITY")

# Formats intégrés qui sont des DATES ou des HEURES (ECMA-376, § 18.8.30).
_BUILTIN_DATE = {14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47}
_BUILTIN_CODES = {
    0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00",
    9: "0%", 10: "0.00%", 11: "0.00E+00", 12: "# ?/?", 13: "# ??/??",
    14: "mm-dd-yy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy",
    18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss",
    22: "m/d/yy h:mm",
    37: "#,##0 ;(#,##0)", 38: "#,##0 ;[Red](#,##0)",
    39: "#,##0.00;(#,##0.00)", 40: "#,##0.00;[Red](#,##0.00)",
    45: "mm:ss", 46: "[h]:mm:ss", 47: "mmss.0", 48: "##0.0E+0", 49: "@",
}
# Origine des numéros de série Excel (1900) : le 1 vaut le 1899-12-31, décalé
# d'un jour par le faux 29 février 1900 que le format perpétue.
_EPOCH_1900 = datetime(1899, 12, 30)
_EPOCH_1904 = datetime(1904, 1, 1)


def _nom(tag: str) -> str:
    """Nom LOCAL d'une balise : les parties d'un classeur sont normalement
    dans l'espace de noms SpreadsheetML, mais des générateurs (et des fichiers
    de test) l'omettent — l'ancien lecteur les acceptait, celui-ci aussi."""
    return tag.rsplit("}", 1)[-1]


_XMLNS_RE = re.compile(rb'<worksheet[^>]*\sxmlns="([^"]+)"')


def _espace_du_flux(head: bytes) -> str:
    """Espace de noms de la feuille, lu dans son en-tête.

    Le déduire ici plutôt que de le découvrir en cours de route garde la boucle
    de lecture sur une comparaison de balise entière (le plus rapide), tout en
    acceptant une feuille écrite sans espace de noms."""
    m = _XMLNS_RE.search(head)
    return "{" + m.group(1).decode("utf-8", "replace") + "}" if m else ""


class XlsxError(Exception):
    """Classeur illisible (archive saine mais contenu inattendu)."""


# ─────────────────────────────────────────────────────────────────────────────
#  Accès aux parties de l'archive
# ─────────────────────────────────────────────────────────────────────────────
def _safe_open(zf: zipfile.ZipFile, name: str):
    """Flux d'une partie XML, refusée si elle déclare des entités."""
    try:
        info = zf.getinfo(name)
    except KeyError:
        raise XlsxError(f"partie absente : {name}")
    f = zf.open(info)
    head = f.read(1024)
    if any(m in head for m in _UNSAFE):
        f.close()
        raise XlsxError("entités XML refusées")
    return _Prefixed(head, f)


class _Prefixed:
    """Flux « en-tête déjà lu + reste » (pour sonder avant de parser)."""

    def __init__(self, head: bytes, rest):
        self._head, self._rest, self._pos = head, rest, 0

    def read(self, n: int = -1) -> bytes:
        if self._pos < len(self._head):
            if n is None or n < 0:
                out = self._head[self._pos:] + self._rest.read()
                self._pos = len(self._head)
                return out
            out = self._head[self._pos:self._pos + n]
            self._pos += len(out)
            if len(out) < n:
                out += self._rest.read(n - len(out))
            return out
        return self._rest.read(n if n is not None else -1)

    def peek(self) -> bytes:
        """En-tête déjà lu (sert à repérer l'espace de noms sans consommer)."""
        return self._head

    def close(self) -> None:
        try:
            self._rest.close()
        except Exception:                                        # noqa: BLE001
            pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()
        return False


def _rels_map(zf: zipfile.ZipFile, part: str) -> Dict[str, str]:
    """``rId`` → cible, relative au dossier de la partie."""
    p = Path(part)
    rels = f"{p.parent.as_posix()}/_rels/{p.name}.rels".lstrip("./")
    out: Dict[str, str] = {}
    try:
        with _safe_open(zf, rels) as f:
            root = ET.parse(f).getroot()
    except (XlsxError, ET.ParseError, OSError):
        return out
    base = p.parent.as_posix()
    for rel in root.iter():
        if _nom(rel.tag) != "Relationship":
            continue
        rid, target = rel.get("Id"), rel.get("Target")
        if not rid or not target:
            continue
        if target.startswith("/"):
            out[rid] = target.lstrip("/")
        else:
            out[rid] = str(Path(base, target).as_posix()).lstrip("./")
    return out


def workbook_part(zf: zipfile.ZipFile) -> str:
    """Partie principale du classeur (``xl/workbook.xml`` sauf indication)."""
    try:
        with _safe_open(zf, "_rels/.rels") as f:
            for rel in ET.parse(f).getroot().iter():
                if str(rel.get("Type", "")).endswith("/officeDocument"):
                    return str(rel.get("Target", "")).lstrip("/") or "xl/workbook.xml"
    except (XlsxError, ET.ParseError, OSError):
        pass
    return "xl/workbook.xml"


def sheets(zf: zipfile.ZipFile) -> List[Dict[str, Any]]:
    """Feuilles du classeur : nom, état masqué, partie XML, base de dates."""
    wb = workbook_part(zf)
    try:
        with _safe_open(zf, wb) as f:
            root = ET.parse(f).getroot()
    except (XlsxError, ET.ParseError, OSError):
        return []
    rels = _rels_map(zf, wb)
    base = Path(wb).parent.as_posix()
    date1904 = False
    out: List[Dict[str, Any]] = []
    for node in root.iter():
        nom = _nom(node.tag)
        if nom == "workbookPr":
            date1904 = str(node.get("date1904", "false")).lower() in ("1", "true")
            continue
        if nom != "sheet":
            continue
        rid = node.get(NS_REL + "id") or node.get("id") or ""
        member = rels.get(rid, "")
        if not member:
            # Classeur sans relation exploitable : repli sur l'ordre des parties.
            member = f"{base}/worksheets/sheet{len(out) + 1}.xml"
        out.append({
            "name": str(node.get("name", "")),
            "hidden": str(node.get("state", "visible")) != "visible",
            "member": member,
            "date1904": date1904,
        })
    return out


def dimension(zf: zipfile.ZipFile, member: str) -> Optional[Tuple[int, int]]:
    """``(lignes, colonnes)`` déclarées par la feuille, sans la lire en entier.

    ``<dimension ref="A1:L80001"/>`` est écrit par Excel comme par LibreOffice
    et vit dans les premiers octets : la taille de la grille est donc connue
    immédiatement, même sur un classeur de 50 Mo. Absent ⇒ ``None`` (l'appelant
    compte alors les lignes au fil de la lecture).
    """
    try:
        with _safe_open(zf, member) as f:
            head = f.read(HEAD_BYTES)
    except (XlsxError, OSError):
        return None
    m = _DIM_RE.search(head)
    if not m:
        return None
    if m.group(2) is None:                    # une seule cellule (ex. « A1 »)
        col, row = _split_ref(m.group(1).decode("ascii", "replace"))
        return max(1, row), max(1, col + 1)
    try:
        rows = int(m.group(3))
    except (TypeError, ValueError):
        return None
    cols = _col_index(m.group(2).decode("ascii", "replace")) + 1
    return max(1, rows), max(1, cols)


def count_rows(zf: zipfile.ZipFile, member: str, *, max_rows: int = 1_048_576) -> int:
    """Nombre de lignes d'une feuille par BALAYAGE D'OCTETS (aucun XML analysé).

    Sert au repli quand ``<dimension>`` manque : décompresser et compter
    ``<row`` coûte une fraction du temps d'une lecture complète (mesuré : ~1 s
    là où bâtir la feuille en demande quatorze), et la grille connaît sa taille
    dès l'ouverture au lieu de l'apprendre en défilant.
    """
    total = 0
    reste = b""
    try:
        f = _safe_open(zf, member)
    except XlsxError:
        return 0
    try:
        while True:
            bloc = f.read(1 << 20)
            if not bloc:
                break
            data = reste + bloc
            total += data.count(b"<row ") + data.count(b"<row>")
            reste = data[-5:]           # une balise peut être coupée en deux
            if total > max_rows:
                return max_rows
    finally:
        f.close()
    return total


# ─────────────────────────────────────────────────────────────────────────────
#  Chaînes partagées et formats
# ─────────────────────────────────────────────────────────────────────────────
def shared_strings(zf: zipfile.ZipFile) -> List[str]:
    """Table des chaînes partagées, lue EN FLUX et bornée.

    ``_read_member`` du module d'aperçu plafonne une partie à 2 Mo : cette
    table-là dépasse allègrement sur un vrai classeur, il lui faut son propre
    chemin (mais avec des bornes)."""
    out: List[str] = []
    total = 0
    try:
        f = _safe_open(zf, "xl/sharedStrings.xml")
    except XlsxError:
        return out
    try:
        for _, el in ET.iterparse(f, events=("end",)):
            if _nom(el.tag) != "si":
                continue
            # Une entrée peut être découpée en plusieurs « runs » (<r><t>…).
            txt = "".join(t.text or "" for t in el.iter() if _nom(t.tag) == "t")
            el.clear()
            out.append(txt)
            total += len(txt)
            if len(out) >= SST_MAX_ITEMS or total >= SST_MAX_CHARS:
                logger.warning("[office] chaînes partagées tronquées (%d entrées)", len(out))
                break
    except ET.ParseError:
        pass
    finally:
        f.close()
    return out


def number_formats(zf: zipfile.ZipFile) -> List[str]:
    """Code de format de chaque style (index ``s`` d'une cellule → code)."""
    codes: List[str] = []
    custom: Dict[int, str] = {}
    try:
        f = _safe_open(zf, "xl/styles.xml")
    except XlsxError:
        return codes
    try:
        with f:
            root = ET.parse(f).getroot()
    except (ET.ParseError, OSError):
        return codes
    for fmt in root.iter():
        if _nom(fmt.tag) != "numFmt":
            continue
        try:
            custom[int(fmt.get("numFmtId", "-1"))] = str(fmt.get("formatCode", ""))
        except (TypeError, ValueError):
            continue
    for xfs in root.iter():
        if _nom(xfs.tag) != "cellXfs":
            continue
        for xf in xfs:
            if _nom(xf.tag) != "xf":
                continue
            try:
                fid = int(xf.get("numFmtId", "0"))
            except (TypeError, ValueError):
                fid = 0
            codes.append(custom.get(fid, _BUILTIN_CODES.get(fid, "General")))
            if len(codes) >= STYLES_MAX_XF:
                break
        break
    return codes


# ─────────────────────────────────────────────────────────────────────────────
#  Rendu d'une valeur « telle qu'affichée »
# ─────────────────────────────────────────────────────────────────────────────
def _strip_sections(code: str) -> str:
    """Un code de format porte jusqu'à quatre sections (positif ; négatif ;
    zéro ; texte). On garde la première, seule utile à un affichage en lecture,
    et on retire les couleurs et conditions entre crochets."""
    depth = 0
    out = []
    for ch in code:
        if ch == '"':
            depth ^= 1
        if ch == ";" and not depth:
            break
        out.append(ch)
    s = "".join(out)
    return re.sub(r"\[(?!h\]|hh\]|mm\]|ss\])[^\]]*\]", "", s)


def _jour_et_horloge(low: str) -> Tuple[bool, bool]:
    """``(un jour ?, une horloge ?)`` d'un code de format en minuscules.

    ⚠ ``m`` est le PIÈGE des formats Excel : mois dans ``yyyy-mm-dd``, minutes
    dans ``h:mm:ss``. La règle du format (ECMA-376, § 18.8.31) : un ``m`` qui
    suit une heure ou précède des secondes compte les minutes. Sans elle,
    ``h:mm:ss`` passait pour une date et une durée s'affichait « 1899-12-30 ».
    """
    net = re.sub(r'"[^"]*"|\\.', "", low)
    jour = bool(re.search(r"[yd]", net))
    horloge = "h" in net or "s" in net
    for m in re.finditer(r"m+", net):
        avant = net[:m.start()].rstrip(" :.-/")
        apres = net[m.end():].lstrip(" :.-/")
        minutes = avant.endswith("h") or avant.endswith("[h]") or apres.startswith("s")
        if minutes:
            horloge = True
        else:
            jour = True
    return jour, horloge


def is_date_format(code: str, builtin_id: Optional[int] = None) -> bool:
    if builtin_id is not None and builtin_id in _BUILTIN_DATE:
        return True
    body = _strip_sections(code or "")
    body = re.sub(r'"[^"]*"', "", body)          # littéraux entre guillemets
    body = re.sub(r"\\.", "", body)              # échappements
    return bool(re.search(r"[ymdhs]", body, re.IGNORECASE)) and "General" not in body


_COL_CACHE: Dict[str, int] = {}


def _col_of(ref: str) -> int:
    """Colonne (0-based) d'une référence ``B7`` — le préfixe de lettres est
    mémoïsé : il n'y a qu'une poignée de colonnes pour des millions de
    cellules, et ce décodage était le deuxième poste de coût."""
    i = 0
    for ch in ref:
        if ch.isdigit():
            break
        i += 1
    letters = ref[:i]
    col = _COL_CACHE.get(letters)
    if col is None:
        col = _COL_CACHE[letters] = _col_index(letters) if letters else 0
        if len(_COL_CACHE) > 4096:
            _COL_CACHE.clear()
    return col


def _split_ref(ref: str) -> Tuple[int, int]:
    """``"B7"`` → (colonne 0-based, ligne 1-based)."""
    i = 0
    while i < len(ref) and ref[i].isalpha():
        i += 1
    col = _col_of(ref) if i else 0
    try:
        row = int(ref[i:]) if ref[i:] else 0
    except ValueError:
        row = 0
    return col, row


def _col_index(letters: str) -> int:
    n = 0
    for ch in letters.upper():
        if not ("A" <= ch <= "Z"):
            break
        n = n * 26 + (ord(ch) - 64)
    return max(0, n - 1)


def _fmt_date(serial: float, fmt: "Format", date1904: bool) -> str:
    if fmt.elapsed:
        # Durée ([h]:mm:ss) : on garde les heures cumulées, pas l'horloge.
        total = float(serial) * 24.0
        h = int(total)
        reste = (total - h) * 60.0
        return f"{h}:{int(reste):02d}:{int(round((reste - int(reste)) * 60)):02d}"
    epoch = _EPOCH_1904 if date1904 else _EPOCH_1900
    try:
        dt = epoch + timedelta(days=float(serial))
    except (OverflowError, ValueError):
        return _fmt_number(serial, GENERAL)
    a_date, a_heure = fmt.has_day, fmt.has_clock
    if a_date and a_heure:
        return (f"{dt.year:04d}-{dt.month:02d}-{dt.day:02d} "
                f"{dt.hour:02d}:{dt.minute:02d}:{dt.second:02d}")
    if a_heure:
        return f"{dt.hour:02d}:{dt.minute:02d}:{dt.second:02d}"
    return f"{dt.year:04d}-{dt.month:02d}-{dt.day:02d}"


def _decimals(code: str) -> int:
    m = re.search(r"\.([0#?]+)", code)
    return len(m.group(1)) if m else 0


def _fmt_number(value: float, fmt: "Format") -> str:
    if fmt.general:
        # Rendu court et exact : 3.0 → « 3 », 0.30000000000000004 → « 0.3 ».
        if value == int(value) and abs(value) < 1e15:
            return str(int(value))
        texte = repr(value)
        return texte.rstrip("0").rstrip(".") if "." in texte and "e" not in texte else texte
    if fmt.percent:
        value *= 100.0
    try:
        s = f"{value:,.{fmt.decimals}f}" if fmt.thousands else f"{value:.{fmt.decimals}f}"
    except (ValueError, OverflowError):
        return str(value)
    return s + "%" if fmt.percent else s


class Format:
    """Format d'affichage PRÉ-MÂCHÉ (un par style du classeur).

    Le travail d'analyse — sections, dates, décimales, milliers, pourcentage —
    est fait UNE fois par style, jamais par cellule : sur 3 millions de
    cellules, refaire ces expressions régulières à chaque valeur coûtait douze
    fois le temps de lecture (mesuré : 16,3 s contre 1,3 s)."""

    __slots__ = ("code", "is_date", "decimals", "thousands", "percent", "general",
                 "elapsed", "has_day", "has_clock")

    def __init__(self, code: str):
        self.code = code or "General"
        body = _strip_sections(self.code).strip()
        low = body.lower()
        self.general = (not body) or body in ("General", "@")
        self.is_date = is_date_format(self.code)
        self.elapsed = "[h]" in low
        self.percent = "%" in body
        self.decimals = _decimals(body)
        self.thousands = "," in re.sub(r'"[^"]*"', "", body).split(".")[0]
        # Jour et/ou horloge : décidé ICI, pas à chaque cellule.
        self.has_day, self.has_clock = _jour_et_horloge(low)


GENERAL = Format("General")


def compile_formats(codes: List[str]) -> List[Format]:
    """Codes de style → formats pré-mâchés, avec mémoïsation des codes répétés
    (un classeur a des centaines de styles pour une poignée de formats)."""
    cache: Dict[str, Format] = {}
    out: List[Format] = []
    for c in codes:
        f = cache.get(c)
        if f is None:
            f = cache[c] = Format(c)
        out.append(f)
    return out


def format_value(raw: Optional[str], cell_type: Optional[str], fmt: "Format | str",
                 date1904: bool = False) -> str:
    """Valeur affichée d'une cellule, à partir de sa valeur brute et de son
    format (c'est ce que LibreOffice écrivait à notre place)."""
    if raw is None:
        return ""
    if cell_type in ("s", "str", "inlineStr"):
        return raw
    if cell_type == "b":
        return "VRAI" if raw not in ("0", "", "false", "FALSE") else "FAUX"
    if cell_type == "e":
        return raw
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return raw
    if isinstance(fmt, str):
        fmt = Format(fmt)
    if fmt.is_date:
        return _fmt_date(value, fmt, date1904)
    return _fmt_number(value, fmt)


# ─────────────────────────────────────────────────────────────────────────────
#  Lecture d'une feuille EN FLUX
# ─────────────────────────────────────────────────────────────────────────────
def iter_rows(zf: zipfile.ZipFile, sheet: Dict[str, Any], sst: List[str],
              formats: List["Format"], *, max_cols: int, cell_chars: int,
              stop_row: Optional[int] = None) -> Iterator[Tuple[int, List[str], bool]]:
    """Génère ``(numéro de ligne, cellules, tronquée)`` dans l'ordre du document.

    Les lignes vides ne sont PAS écrites par Excel : le numéro rendu est celui
    du document (l'appelant comble les trous). La mémoire ne dépend pas de la
    taille du classeur — chaque élément est libéré après usage (``clear``).
    """
    date1904 = bool(sheet.get("date1904"))
    try:
        f = _safe_open(zf, sheet["member"])
    except XlsxError:
        return
    # Noms qualifiés et fonctions résolus UNE fois : dans une boucle qui voit
    # des millions de cellules, chaque recherche d'attribut se paie.
    tag_row, tag_c, tag_v, tag_t = NS + "row", NS + "c", NS + "v", NS + "t"
    col_of, cache_col, nb_fmts, nb_sst = _col_of, _COL_CACHE, len(formats), len(sst)
    ns = _espace_du_flux(f.peek())
    tag_row, tag_c, tag_v, tag_t = ns + "row", ns + "c", ns + "v", ns + "t"
    try:
        for _, el in ET.iterparse(f, events=("end",)):
            if el.tag != tag_row:
                continue
            try:
                r = int(el.get("r") or 0)
            except (TypeError, ValueError):
                r = 0
            cells: List[str] = []
            tronquee = False
            for c in el:
                if c.tag != tag_c:
                    continue
                ref = c.get("r")
                if ref:
                    idx = cache_col.get(ref[:2] if len(ref) > 1 and not ref[1].isdigit()
                                        else ref[:1])
                    if idx is None:
                        idx = col_of(ref)
                else:
                    idx = len(cells)
                if idx >= max_cols:
                    tronquee = True
                    continue
                t = c.get("t")
                if t == "inlineStr":
                    txt = "".join(x.text or "" for x in c.iter(tag_t))
                else:
                    # Enfants parcourus à la main : ``find`` reconstruit un
                    # chemin à chaque appel, pour un ou deux enfants ici.
                    raw = None
                    for enfant in c:
                        if enfant.tag == tag_v:
                            raw = enfant.text
                            break
                    if t == "s":
                        try:
                            j = int(raw or 0)
                        except (TypeError, ValueError):
                            j = -1
                        txt = sst[j] if 0 <= j < nb_sst else ""
                    else:
                        si = c.get("s")
                        if si is None:
                            fmt = formats[0] if nb_fmts else GENERAL
                        else:
                            try:
                                k = int(si)
                            except (TypeError, ValueError):
                                k = 0
                            fmt = formats[k] if 0 <= k < nb_fmts else GENERAL
                        txt = format_value(raw, t, fmt, date1904)
                if len(txt) > cell_chars:
                    txt = txt[:cell_chars] + "…"
                    tronquee = True
                while len(cells) < idx:
                    cells.append("")
                cells.append(txt)
            el.clear()
            while cells and cells[-1] == "":
                cells.pop()
            yield r, cells, tronquee
            if stop_row is not None and r >= stop_row:
                return
    except ET.ParseError:
        logger.warning("[office] feuille %s illisible (XML)", sheet.get("member"))
    finally:
        f.close()
