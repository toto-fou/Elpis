# SPDX-License-Identifier: MIT
"""Lecture tolérante d'un appel d'outil « chart » produit par un modèle.

Principe : on accepte tout ce qu'un modèle (petit, quantifié, peu attentif à la
casse) écrit raisonnablement, on le ramène à UNE forme canonique, et on note
chaque correction pour la lui renvoyer (il apprend sans échec).

  - type : casse, accents, camelCase, synonymes FR/EN, fautes légères ;
  - data : lignes (objets), tableau avec ligne d'en-tête, colonnes {col: [...]},
           dictionnaire {libellé: valeur}, texte CSV / Markdown, JSON en chaîne,
           ancienne forme Chart.js (labels + datasets) ;
  - nombres : « 1 234,5 € », « 12 % », « 1,2 M », « (300) », « − 4 » ;
  - colonnes : « Ventes » trouve « ventes », « cout » trouve « coût ».

Aucune dépendance hors bibliothèque standard.
"""
from __future__ import annotations

import csv
import difflib
import io
import json
import math
import re
import unicodedata
from datetime import date, datetime
from typing import Any

# ── Pliage de chaînes ─────────────────────────────────────────────────────


def fold(s: Any) -> str:
    """« Polar Area », « polarArea », « polar-area » → « polar_area »."""
    s = str(s or "")
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", s)          # camelCase → snake
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[^0-9a-zA-Z]+", "_", s.lower())
    return s.strip("_")


# ── Types de graphiques ──────────────────────────────────────────────────
# Clé = type canonique ; valeurs = alias (déjà « pliés »). Un alias peut porter
# des options implicites (« stacked_bar » → bar + stacked).
KINDS: dict[str, list[str]] = {
    "auto": ["auto", "chart", "graph_auto", "graphique", "graphe_auto", "default", "any"],
    "bar": ["bar", "bars", "barre", "barres", "column", "columns", "colonne", "colonnes",
            "baton", "batons", "bar_chart", "barchart", "diagramme_en_barres",
            "diagramme_barres", "grouped_bar", "histo", "vertical_bar"],
    "line": ["line", "lines", "ligne", "lignes", "courbe", "courbes", "line_chart",
             "linechart", "trend", "tendance", "evolution", "time_series", "serie_temporelle"],
    "area": ["area", "aire", "aires", "surface", "area_chart", "zone"],
    "pie": ["pie", "camembert", "secteur", "secteurs", "circulaire", "diagramme_circulaire",
            "pie_chart", "piechart", "tarte", "pie_of_pie", "bar_of_pie"],
    "donut": ["donut", "doughnut", "anneau", "beignet", "ring", "donut_chart"],
    "rose": ["rose", "nightingale", "polar_area", "polararea", "rose_chart", "aire_polaire"],
    "scatter": ["scatter", "nuage", "nuage_de_points", "points", "dispersion", "xy",
                "correlation", "scatter_plot", "scatterplot"],
    "bubble": ["bubble", "bulle", "bulles", "bubble_chart"],
    "heatmap": ["heatmap", "heat_map", "carte_de_chaleur", "chaleur", "matrix", "matrice",
                "carte_thermique"],
    "calendar": ["calendar", "calendrier", "calendar_heatmap", "contributions"],
    "treemap": ["treemap", "tree_map", "carte_proportionnelle", "mosaique", "rectangles"],
    "sunburst": ["sunburst", "soleil", "rayons_de_soleil", "anneaux", "multi_niveaux"],
    "sankey": ["sankey", "flux", "flow", "flows", "alluvial", "diagramme_de_flux"],
    "chord": ["chord", "corde", "cordes", "diagramme_d_accords", "accords"],
    "graph": ["graph", "network", "reseau", "graphe", "force", "noeuds", "relations",
              "liens", "network_graph"],
    "tree": ["tree", "arbre", "organigramme", "org_chart", "orgchart", "hierarchie",
             "hierarchy", "arborescence"],
    "funnel": ["funnel", "entonnoir", "tunnel", "conversion", "funnel_chart"],
    "gauge": ["gauge", "jauge", "compteur", "speedometer", "cadran"],
    "progress": ["progress", "progression", "avancement", "barre_de_progression", "progress_bar"],
    "kpi": ["kpi", "stat", "stats", "chiffre_cle", "chiffres_cles", "indicateur",
            "indicateurs", "tuile", "big_number", "metric", "metrics"],
    "radar": ["radar", "araignee", "toile", "toile_d_araignee", "spider", "web"],
    "polar_bar": ["polar_bar", "barres_polaires", "radial_bar", "radial", "barre_radiale"],
    "boxplot": ["boxplot", "box_plot", "box", "boite_a_moustaches", "moustaches",
                "violin", "violon", "boites"],
    "histogram": ["histogram", "distribution", "repartition", "frequences", "frequence"],
    "candlestick": ["candlestick", "candle", "chandelier", "chandeliers", "bougie",
                    "bougies", "ohlc", "boursier", "cours", "japanese_candlestick"],
    "waterfall": ["waterfall", "cascade", "chute_d_eau", "pont", "bridge", "waterfall_chart"],
    "gantt": ["gantt", "planning", "diagramme_de_gantt", "timeline", "chronologie", "frise",
              "roadmap", "calendrier_projet"],
    "parallel": ["parallel", "parallele", "paralleles", "coordonnees_paralleles",
                 "parallel_coordinates"],
    "stream": ["stream", "streamgraph", "theme_river", "themeriver", "riviere", "flot"],
    "table": ["table", "tableau", "grid", "grille", "datatable"],
}

# Alias qui portent une option en plus du type.
ALIAS_OPTIONS: dict[str, dict[str, Any]] = {
    "stacked_bar": {"_kind": "bar", "stacked": True},
    "barres_empilees": {"_kind": "bar", "stacked": True},
    "stacked_column": {"_kind": "bar", "stacked": True},
    "horizontal_bar": {"_kind": "bar", "horizontal": True},
    "hbar": {"_kind": "bar", "horizontal": True},
    "barres_horizontales": {"_kind": "bar", "horizontal": True},
    "bar_horizontal": {"_kind": "bar", "horizontal": True},
    "stacked_area": {"_kind": "area", "stacked": True},
    "aires_empilees": {"_kind": "area", "stacked": True},
    "stepped": {"_kind": "line", "step": True},
    "step": {"_kind": "line", "step": True},
    "escalier": {"_kind": "line", "step": True},
    "spline": {"_kind": "line", "smooth": True},
    "lissee": {"_kind": "line", "smooth": True},
    "percent_bar": {"_kind": "bar", "stacked": True, "percent": True},
    "barres_100": {"_kind": "bar", "stacked": True, "percent": True},
}

# « histogramme » veut dire « diagramme en barres » pour beaucoup de Français :
# tranché par la forme des données (voir resolve_ambiguous_kind).
AMBIGUOUS = {"histogramme": ("bar", "histogram"), "histogrammes": ("bar", "histogram")}

KIND_NAMES = [k for k in KINDS]
_ALIAS_TO_KIND: dict[str, str] = {}
for _k, _aliases in KINDS.items():
    for _a in _aliases:
        _ALIAS_TO_KIND[_a] = _k


def resolve_kind(raw: Any) -> tuple[str | None, dict[str, Any], str | None]:
    """→ (type canonique | None si ambigu/inconnu, options implicites, note)."""
    f = fold(raw)
    if not f:
        return "auto", {}, None
    if f in _ALIAS_TO_KIND:
        k = _ALIAS_TO_KIND[f]
        note = None if str(raw) == k else f"type '{raw}' read as '{k}'"
        return k, {}, note
    if f in ALIAS_OPTIONS:
        o = dict(ALIAS_OPTIONS[f])
        k = o.pop("_kind")
        extra = ", ".join(f"{a}={str(b).lower()}" for a, b in o.items())
        return k, o, f"type '{raw}' read as '{k}' + {extra}"
    if f in AMBIGUOUS:
        return None, {"_ambiguous": AMBIGUOUS[f]}, None
    # Retirer un suffixe parasite (« bar_chart_v2 », « line_graph »)
    for suffix in ("_chart", "_graph", "_plot", "_diagram", "_diagramme"):
        if f.endswith(suffix) and f[: -len(suffix)] in _ALIAS_TO_KIND:
            k = _ALIAS_TO_KIND[f[: -len(suffix)]]
            return k, {}, f"type '{raw}' read as '{k}'"
    close = difflib.get_close_matches(f, list(_ALIAS_TO_KIND) + list(ALIAS_OPTIONS), n=1, cutoff=0.78)
    if close:
        c = close[0]
        if c in ALIAS_OPTIONS:
            o = dict(ALIAS_OPTIONS[c]); k = o.pop("_kind")
            return k, o, f"type '{raw}' read as '{k}' (closest match)"
        k = _ALIAS_TO_KIND[c]
        return k, {}, f"type '{raw}' read as '{k}' (closest match)"
    return None, {}, None


# ── Nombres ──────────────────────────────────────────────────────────────

_NULLS = {"", "-", "–", "—", "n/a", "na", "nan", "null", "none", "nd", "n.d.", "?", "/"}
_CURRENCIES = {"€": "€", "eur": "€", "euro": "€", "euros": "€", "$": "$", "usd": "$",
               "£": "£", "gbp": "£", "chf": "CHF", "¥": "¥", "jpy": "¥"}
_SCALES = {"k": 1e3, "m": 1e6, "md": 1e9, "mds": 1e9, "mrd": 1e9, "g": 1e9, "b": 1e9,
           "bn": 1e9, "mio": 1e6, "mn": 1e6, "milliers": 1e3, "millions": 1e6,
           "milliards": 1e9, "t": 1e12}


class Num:
    """Nombre lu + unité éventuellement reconnue (« % », « € »)."""
    __slots__ = ("value", "unit", "coerced")

    def __init__(self, value: float | None, unit: str | None = None, coerced: bool = False):
        self.value, self.unit, self.coerced = value, unit, coerced


def to_number(v: Any) -> Num:
    """Lit un nombre « à la française » ou autre. ``value=None`` si illisible."""
    if v is None:
        return Num(None)
    if isinstance(v, bool):
        return Num(1.0 if v else 0.0, coerced=True)
    if isinstance(v, (int, float)):
        f = float(v)
        return Num(f if math.isfinite(f) else None, coerced=not math.isfinite(f))
    if not isinstance(v, str):
        return Num(None)
    s = v.strip()
    if s.lower() in _NULLS:
        return Num(None, coerced=True)
    unit = None
    s = s.replace("−", "-").replace(" ", " ").replace(" ", " ")
    neg = False
    if s.startswith("(") and s.endswith(")"):
        neg, s = True, s[1:-1].strip()
    if "%" in s:
        unit, s = "%", s.replace("%", "").strip()
    # Devise et multiplicateur en suffixe / préfixe (« 1,2 M€ », « $3.5k », « 12 k€ »)
    low = s.lower()
    for sym, u in sorted(_CURRENCIES.items(), key=lambda kv: -len(kv[0])):
        if low.endswith(sym) or low.startswith(sym):
            unit = unit or u
            s = s[len(sym):] if low.startswith(sym) else s[: len(s) - len(sym)]
            s, low = s.strip(), s.strip().lower()
            break
    mult = 1.0
    m = re.match(r"^([+-]?[\d\s.,']+)\s*([A-Za-zéèûµ°/²³]{1,8})\.?$", s)
    if m and m.group(2).lower() in _SCALES:
        mult, s = _SCALES[m.group(2).lower()], m.group(1).strip()
    elif m:                                            # « 3,4 j », « 8 ms », « 2 Go »
        unit, s = unit or m.group(2), m.group(1).strip()
    s = s.replace(" ", "").replace("'", "")
    if s.startswith("+"):
        s = s[1:]
    if not re.fullmatch(r"-?[\d.,]+", s or "x"):
        return Num(None)
    if "," in s and "." in s:
        # Le dernier séparateur est le décimal : 1.234,5 (DE/FR) ou 1,234.5 (US)
        if s.rfind(",") > s.rfind("."):
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", "")
    elif s.count(",") > 1:
        s = s.replace(",", "")                       # 1,234,567
    elif "," in s:
        s = s.replace(",", ".")                      # 12,5 (décimal français)
    elif s.count(".") > 1:
        s = s.replace(".", "")                       # 1.234.567
    try:
        f = float(s) * mult
    except ValueError:
        return Num(None)
    if neg:
        f = -abs(f)
    return Num(f if math.isfinite(f) else None, unit, coerced=True)


# ── Dates ────────────────────────────────────────────────────────────────

_MONTHS = {
    "jan": 1, "janv": 1, "janvier": 1, "january": 1, "feb": 2, "fev": 2, "fevr": 2,
    "fevrier": 2, "february": 2, "mar": 3, "mars": 3, "march": 3, "apr": 4, "avr": 4,
    "avril": 4, "april": 4, "may": 5, "mai": 5, "jun": 6, "juin": 6, "june": 6, "jul": 7,
    "juil": 7, "juillet": 7, "july": 7, "aug": 8, "aou": 8, "aout": 8, "august": 8,
    "sep": 9, "sept": 9, "septembre": 9, "september": 9, "oct": 10, "octobre": 10,
    "october": 10, "nov": 11, "novembre": 11, "november": 11, "dec": 12, "decembre": 12,
    "december": 12,
}


def to_date(v: Any) -> str | None:
    """→ « AAAA-MM-JJ » (ou avec l'heure) si la valeur est une date complète."""
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if not isinstance(v, str):
        return None
    s = v.strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?(Z|[+-]\d{2}:?\d{2})?", s):
        try:
            datetime.fromisoformat(s.replace("Z", "+00:00"))
            return s.replace(" ", "T")
        except ValueError:
            return None
    m = re.fullmatch(r"(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})", s)          # 15/01/2024 (FR)
    if m:
        d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        try:
            return date(y, mo, d).isoformat()
        except ValueError:
            return None
    m = re.fullmatch(r"(\d{1,2})(?:er)?\s+([A-Za-zéèûôÉ.]+)\s+(\d{4})", s)  # 3 mars 2024
    if m:
        mo = _MONTHS.get(fold(m.group(2)))
        if mo:
            try:
                return date(int(m.group(3)), mo, int(m.group(1))).isoformat()
            except ValueError:
                return None
    return None


def month_key(v: Any) -> str | None:
    """« 2024-03 », « mars 2024 », « Mar 2024 » → « 2024-03 » (tri chronologique)."""
    if not isinstance(v, str):
        return None
    s = v.strip()
    if re.fullmatch(r"\d{4}-\d{2}", s):
        return s
    m = re.fullmatch(r"([A-Za-zéèûôÉ.]+)\.?\s+(\d{4})", s)
    if m and fold(m.group(1)) in _MONTHS:
        return f"{m.group(2)}-{_MONTHS[fold(m.group(1))]:02d}"
    return None


# ── Forme des données → lignes ──────────────────────────────────────────


class Notes:
    """Corrections (le modèle a écrit autre chose, on a compris) et
    avertissements (on a dû choisir ou ignorer quelque chose)."""

    def __init__(self) -> None:
        self.fixes: list[str] = []
        self.warnings: list[str] = []

    def fix(self, msg: str | None) -> None:
        if msg and msg not in self.fixes:
            self.fixes.append(msg)

    def warn(self, msg: str | None) -> None:
        if msg and msg not in self.warnings:
            self.warnings.append(msg)


def _parse_text_table(s: str, notes: Notes) -> list[dict] | None:
    lines = [ln for ln in s.strip().splitlines() if ln.strip()]
    if len(lines) < 2:
        return None
    if lines[0].lstrip().startswith("|"):                        # tableau Markdown
        rows = []
        for ln in lines:
            if re.fullmatch(r"\s*\|?[\s:|-]+\|?\s*", ln):
                continue
            rows.append([c.strip() for c in ln.strip().strip("|").split("|")])
        notes.fix("Markdown table read as data")
        return _rows_with_header(rows, notes)
    sample = "\n".join(lines[:5])
    delim = max([";", "\t", ",", "|"], key=sample.count)
    rows = list(csv.reader(io.StringIO("\n".join(lines)), delimiter=delim))
    notes.fix("CSV text read as data")
    return _rows_with_header(rows, notes)


def _rows_with_header(rows: list[list], notes: Notes) -> list[dict]:
    header = [str(h).strip() or f"col{i+1}" for i, h in enumerate(rows[0])]
    out = []
    for r in rows[1:]:
        if not isinstance(r, (list, tuple)) or not any(x not in (None, "") for x in r):
            continue
        out.append({header[i] if i < len(header) else f"col{i+1}": r[i] for i in range(len(r))})
    return out


def to_records(data: Any, notes: Notes, labels: Any = None) -> list[dict]:
    """Ramène toute forme raisonnable de données à une liste de lignes."""
    if data is None:
        return []
    if isinstance(data, str):
        s = data.strip()
        if s[:1] in "[{":
            try:
                parsed = json.loads(s)
                notes.fix("data sent as a JSON string: decoded")
                return to_records(parsed, notes, labels)
            except ValueError:
                pass
        return _parse_text_table(s, notes) or []
    if isinstance(data, dict):
        vals = list(data.values())
        if vals and all(isinstance(v, list) for v in vals):
            n = max(len(v) for v in vals)
            if len({len(v) for v in vals}) > 1:
                notes.warn("columns of different lengths: padded with empty values")
            notes.fix("{column: [values]} converted to rows")
            keys = list(data)
            return [{k: (data[k][i] if i < len(data[k]) else None) for k in keys} for i in range(n)]
        if vals and all(not isinstance(v, (list, dict)) for v in vals):
            notes.fix("{label: value} converted to rows")
            return [{"libellé": k, "valeur": v} for k, v in data.items()]
        if vals and all(isinstance(v, dict) for v in vals):
            notes.fix("{label: {...}} converted to rows")
            return [{"libellé": k, **v} for k, v in data.items()]
        return [data]
    if not isinstance(data, list) or not data:
        return []
    if all(isinstance(r, dict) for r in data):
        # Forme Chart.js d'origine : [{label, data:[…]}] + labels
        if all("data" in {fold(k) for k in r} for r in data) and \
                all(isinstance(_get_ci(r, "data"), list) for r in data):
            return _from_chartjs(labels, data, notes)
        return [{str(k).strip(): v for k, v in r.items()} for r in data]
    if all(isinstance(r, (list, tuple)) for r in data):
        first = data[0]
        if first and all(isinstance(x, str) for x in first) and len(data) > 1 and \
                any(not isinstance(x, str) for r in data[1:] for x in r):
            notes.fix("first row used as header")
            return _rows_with_header(data, notes)
        width = max(len(r) for r in data)
        names = (["libellé", "valeur"] if width == 2 else
                 ["x", "y", "valeur"] if width == 3 else [f"col{i+1}" for i in range(width)])
        notes.fix(f"rows without header: columns named {', '.join(names)}")
        return [{names[i]: r[i] for i in range(len(r))} for r in data]
    if all(not isinstance(r, (list, dict)) for r in data):
        if labels and isinstance(labels, list):
            notes.fix("values + labels converted to rows")
            return [{"libellé": labels[i] if i < len(labels) else f"#{i+1}", "valeur": v}
                    for i, v in enumerate(data)]
        notes.fix("list of values converted to rows")
        return [{"valeur": v} for v in data]
    return []


def _get_ci(d: dict, key: str) -> Any:
    for k, v in d.items():
        if fold(k) == key:
            return v
    return None


def _from_chartjs(labels: Any, datasets: list[dict], notes: Notes) -> list[dict]:
    """labels=[…] + datasets=[{label, data}] → lignes (une colonne par série)."""
    notes.fix("legacy labels + datasets converted to rows")
    labels = labels if isinstance(labels, list) else []
    n = max([len(labels)] + [len(_get_ci(d, "data") or []) for d in datasets])
    if any(len(_get_ci(d, "data") or []) != len(labels) for d in datasets) and labels:
        notes.warn("series and labels of different lengths: padded with empty values")
    rows = []
    for i in range(n):
        row: dict[str, Any] = {"libellé": labels[i] if i < len(labels) else f"#{i+1}"}
        for j, d in enumerate(datasets):
            name = str(_get_ci(d, "label") or f"série {j+1}")
            vals = _get_ci(d, "data") or []
            row[name] = vals[i] if i < len(vals) else None
        rows.append(row)
    return rows


# ── Colonnes ─────────────────────────────────────────────────────────────

# Noms qui désignent une dimension même quand les valeurs sont des nombres.
_DIM_NAMES = {"annee", "an", "year", "years", "annees", "date", "jour", "day", "mois",
              "month", "semaine", "week", "trimestre", "quarter", "periode", "period",
              "heure", "hour", "time", "temps", "id", "code", "rang", "rank", "numero"}


class Column:
    __slots__ = ("name", "kind", "unit", "n_coerced", "dates", "months", "example")

    def __init__(self, name: str):
        self.name = name
        self.kind = "text"           # text | number | date
        self.unit: str | None = None
        self.n_coerced = 0
        self.dates = False
        self.months = False
        self.example: tuple | None = None

    def __repr__(self) -> str:
        return f"{self.name}:{self.kind}"


def profile(rows: list[dict]) -> list[Column]:
    names: list[str] = []
    for r in rows:
        for k in r:
            if k not in names:
                names.append(k)
    cols = []
    for name in names:
        c = Column(name)
        vals = [r.get(name) for r in rows if r.get(name) not in (None, "")]
        if not vals:
            c.kind = "text"
            cols.append(c)
            continue
        nums = [to_number(v) for v in vals]
        n_ok = sum(1 for n in nums if n.value is not None)
        units = {n.unit for n in nums if n.unit}
        dated = sum(1 for v in vals if to_date(v))
        monthy = sum(1 for v in vals if month_key(v))
        if dated >= 0.8 * len(vals):
            c.kind, c.dates = "date", True
        elif monthy >= 0.8 * len(vals):
            c.kind, c.months = "text", True
        elif n_ok >= 0.8 * len(vals):
            c.kind = "number"
            c.unit = units.pop() if len(units) == 1 else None
            c.n_coerced = sum(1 for v, n in zip(vals, nums)
                              if n.value is not None and not isinstance(v, (int, float)))
            # « année: 2021 », « heure: "9 h" » → dimension, pas mesure
            if fold(name) in _DIM_NAMES and \
                    all(float(n.value).is_integer() for n in nums if n.value is not None):
                c.kind = "text"
            else:
                ex = next(((v, n.value) for v, n in zip(vals, nums)
                           if n.value is not None and isinstance(v, str)), None)
                c.example = ex
        cols.append(c)
    return cols


def match_column(wanted: Any, cols: list[Column], notes: Notes, role: str) -> Column | None:
    """Trouve la colonne demandée sans exiger la bonne casse ni les accents."""
    if wanted in (None, ""):
        return None
    w = str(wanted)
    for c in cols:
        if c.name == w:
            return c
    fw = fold(w)
    for c in cols:
        if fold(c.name) == fw:
            notes.fix(f"{role} '{w}' read as column '{c.name}'")
            return c
    for c in cols:
        fc = fold(c.name)
        if fw and (fw in fc or fc in fw):
            notes.fix(f"{role} '{w}' read as column '{c.name}'")
            return c
    close = difflib.get_close_matches(fw, [fold(c.name) for c in cols], n=1, cutoff=0.7)
    if close:
        c = next(c for c in cols if fold(c.name) == close[0])
        notes.fix(f"{role} '{w}' read as column '{c.name}' (closest match)")
        return c
    notes.warn(f"{role} '{w}': no such column ({', '.join(c.name for c in cols)}), ignored")
    return None


def num(v: Any) -> float | None:
    return to_number(v).value
