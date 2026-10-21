# SPDX-License-Identifier: MIT
"""Arguments d'appel (tolérants) → spécification canonique ``Spec``.

Le modèle ne décrit QUE : un type, un tableau de lignes et, au besoin, quelles
colonnes jouent quel rôle (x, y, group, size). Tout le reste (axes, séries,
matrice de heatmap, nœuds de sankey, quartiles…) est construit ici et dans
``compile_echarts`` — jamais par le modèle.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .normalise import (
    Column,
    Notes,
    fold,
    match_column,
    num,
    profile,
    resolve_kind,
    to_records,
)

MAX_ROWS = 10_000
MAX_SERIES = 8          # au-delà : repli « Autres » (pas de 9e couleur)

STACKS = {"none", "stacked", "percent"}
SORTS = {"none", "asc", "desc"}

# Arguments reconnus et leurs alias (modèles habitués à d'autres outils).
ARG_ALIASES = {
    "type": ["type", "chart_type", "kind", "chart", "graph_type", "charttype", "chart_kind",
             "graphique", "type_graphique"],
    "data": ["data", "rows", "records", "values", "donnees", "dataset", "data_table",
             "datatable", "table", "points", "items", "lignes", "datasets"],
    "x": ["x", "x_field", "xfield", "category", "categories", "label_column", "labels_column",
          "x_column", "dimension", "axe_x", "abscisse", "name_field"],
    "y": ["y", "y_field", "yfield", "value_field", "measure", "measures", "y_column",
          "y_columns", "metrics", "axe_y", "ordonnee", "value", "values_field"],
    "group": ["group", "series", "serie", "color", "color_field", "colorfield", "group_by",
              "groupby", "split", "legend_field", "groupe", "couleur", "series_field"],
    "size": ["size", "size_field", "r", "radius", "taille"],
    "title": ["title", "titre", "name", "chart_title"],
    "subtitle": ["subtitle", "sous_titre", "subtitle_text", "description"],
    "unit": ["unit", "unite", "units", "suffix"],
    "stack": ["stack", "stacked", "stacking", "empile", "percent", "normalize"],
    "horizontal": ["horizontal", "orientation", "index_axis", "indexaxis"],
    "sort": ["sort", "order", "tri", "sort_order"],
    "top": ["top", "top_n", "limit", "max_items", "max_categories"],
    "show_values": ["show_values", "labels_on", "show_labels", "data_labels",
                    "datalabels", "afficher_valeurs"],
    "highlight": ["highlight", "emphasis", "focus", "mettre_en_avant", "surligner"],
    "lines": ["lines", "annotations", "reference_lines", "ref_lines", "marklines", "targets",
              "objectifs", "seuils"],
    "trend": ["trend", "trendline", "trend_line", "regression", "tendance"],
}
_ARG_LOOKUP = {a: k for k, al in ARG_ALIASES.items() for a in al}


@dataclass
class Spec:
    kind: str
    rows: list[dict]
    cols: list[Column]
    notes: Notes
    x: Column | None = None
    ys: list[Column] = field(default_factory=list)
    group: Column | None = None
    size: Column | None = None
    levels: list[Column] = field(default_factory=list)
    extra: dict[str, Column | None] = field(default_factory=dict)   # rôles nommés
    opts: dict[str, Any] = field(default_factory=dict)
    tree: list[dict] | None = None                                    # données imbriquées
    auto_from: str | None = None


class SpecError(Exception):
    def __init__(self, message: str, fix: str = "", example: Any = None):
        super().__init__(message)
        self.message, self.fix, self.example = message, fix, example


def _bool(v: Any) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return bool(v)
    return fold(v) in {"true", "yes", "oui", "1", "vrai", "on", "y"}


def canonical_args(raw: dict, notes: Notes) -> dict:
    """Renomme les arguments alias (``chart_type`` → ``type``…)."""
    out: dict[str, Any] = {}
    labels = None
    for k, v in (raw or {}).items():
        fk = fold(k)
        if fk == "labels":
            labels = v
            continue
        canon = _ARG_LOOKUP.get(fk)
        if canon is None:
            notes.warn(f"unknown argument '{k}': ignored")
            continue
        if canon != k:
            notes.fix(f"argument '{k}' read as '{canon}'")
        # « stacked: true » / « percent: true » → stack
        if canon == "stack" and fk in {"stacked", "empile"}:
            v = "stacked" if _bool(v) else "none"
        elif canon == "stack" and fk in {"percent", "normalize"}:
            v = "percent" if _bool(v) else out.get("stack", "none")
        elif canon == "horizontal" and fk in {"orientation", "index_axis", "indexaxis"}:
            v = fold(v) in {"horizontal", "y", "h"}
        out[canon] = v
    if labels is not None:
        out["_labels"] = labels
    return out


# ── Rôles par nom de colonne ─────────────────────────────────────────────

ROLE_NAMES = {
    "source": ["source", "from", "de", "origine", "depuis", "src", "emetteur", "provenance"],
    "target": ["target", "to", "vers", "destination", "dest", "cible", "recepteur"],
    "open": ["open", "o", "ouverture", "ouv", "first"],
    "high": ["high", "h", "haut", "plus_haut", "max_jour", "hi"],
    "low": ["low", "l", "bas", "plus_bas", "min_jour", "lo"],
    "close": ["close", "c", "cloture", "fermeture", "dernier", "last"],
    "start": ["start", "debut", "date_debut", "begin", "start_date", "commence", "depart",
              "du"],
    "end": ["end", "fin", "date_fin", "finish", "end_date", "echeance", "au", "until"],
    "max": ["max", "maximum", "objectif", "cible", "target", "total", "sur", "plafond",
            "capacite"],
    "previous": ["previous", "precedent", "avant", "n_1", "prev", "last_period",
                 "periode_precedente", "reference"],
    "parent": ["parent", "parent_id", "manager", "responsable", "chef", "pere", "rattache_a",
               "superieur", "reports_to"],
    "min_": ["min", "minimum"],
    "q1": ["q1", "quartile1", "premier_quartile", "p25"],
    "median": ["median", "mediane", "q2", "p50"],
    "q3": ["q3", "quartile3", "troisieme_quartile", "p75"],
}


def by_name(cols: list[Column], role: str, kinds: tuple[str, ...] | None = None) -> Column | None:
    names = ROLE_NAMES[role]
    for c in cols:
        if fold(c.name) in names and (kinds is None or c.kind in kinds):
            return c
    return None


def dims(cols: list[Column]) -> list[Column]:
    return [c for c in cols if c.kind in ("text", "date")]


def measures(cols: list[Column]) -> list[Column]:
    return [c for c in cols if c.kind == "number"]


# ── Construction ─────────────────────────────────────────────────────────


def build_spec(raw_args: dict) -> Spec:
    notes = Notes()
    args = canonical_args(raw_args, notes)

    # Données d'abord : le type « auto » ou ambigu se tranche sur leur forme.
    data = args.get("data")
    rows = to_records(data, notes, labels=args.get("_labels"))
    if not rows:
        raise SpecError(
            "data is empty or unreadable",
            fix="data = a list of rows, one per category or point.",
            example=[{"mois": "janv.", "ventes": 120}, {"mois": "févr.", "ventes": 135}])
    if len(rows) > MAX_ROWS:
        notes.warn(f"{len(rows)} rows: only the first {MAX_ROWS} are kept")
        rows = rows[:MAX_ROWS]

    if not any(v not in (None, "") for r in rows if isinstance(r, dict) for v in r.values()):
        raise SpecError(
            "data has no values (empty rows)",
            fix="each row is an object with the SAME keys, all filled",
            example=[{"nom": "Débit", "valeur": 120, "unité": "Mo/s"},
                     {"nom": "Latence", "valeur": 8, "unité": "ms"}])

    tree = None
    if any(isinstance(r, dict) and any(fold(k) == "children" for k in r) for r in rows):
        tree = rows                                    # hiérarchie déjà imbriquée
    cols = profile(rows) if tree is None else profile(_flatten_tree(rows))

    raw_type = args.get("type", "auto")
    kind, implicit, note = resolve_kind(raw_type)
    if kind is None and implicit.get("_ambiguous"):
        bar_or_hist = implicit["_ambiguous"]
        kind = bar_or_hist[1] if (not dims(cols) and len(measures(cols)) == 1 and len(rows) >= 10) \
            else bar_or_hist[0]
        note = f"type '{raw_type}' read as '{kind}' (from the data)"
    if kind is None:
        notes.warn(f"unknown type '{raw_type}': chosen automatically")
        kind = "auto"
    notes.fix(note)

    opts: dict[str, Any] = {
        "title": str(args.get("title") or "").strip(),
        "subtitle": str(args.get("subtitle") or "").strip(),
        "unit": str(args.get("unit") or "").strip(),
        "stack": "none", "horizontal": False, "sort": "none", "top": 0,
        "show_values": False, "highlight": None, "lines": [], "trend": False,
        "smooth": False, "step": False,
    }
    opts.update({k: v for k, v in implicit.items() if k in ("smooth", "step", "horizontal")})
    if implicit.get("stacked"):
        opts["stack"] = "percent" if implicit.get("percent") else "stacked"

    st = args.get("stack")
    if st is not None:
        fs = fold(st) if not isinstance(st, bool) else ("stacked" if st else "none")
        fs = {"true": "stacked", "yes": "stacked", "oui": "stacked", "stack": "stacked",
              "empile": "stacked", "false": "none", "non": "none", "no": "none",
              "100": "percent", "pourcent": "percent", "pourcentage": "percent",
              "normalized": "percent", "normalise": "percent"}.get(fs, fs)
        if fs in STACKS:
            opts["stack"] = fs
        else:
            notes.warn(f"unknown stack '{st}' (none | stacked | percent): ignored")
    if "horizontal" in args:
        opts["horizontal"] = _bool(args["horizontal"])
    if "sort" in args:
        fs = fold(args["sort"])
        fs = {"ascending": "asc", "croissant": "asc", "descending": "desc",
              "decroissant": "desc", "false": "none", "true": "desc"}.get(fs, fs)
        if fs in SORTS:
            opts["sort"] = fs
        else:
            notes.warn(f"unknown sort '{args['sort']}' (none | asc | desc): ignored")
    if "top" in args:
        t = num(args["top"])
        opts["top"] = int(t) if t and t > 0 else 0
    if "show_values" in args:
        opts["show_values"] = _bool(args["show_values"])
    if args.get("highlight") not in (None, "", []):
        h = args["highlight"]
        opts["highlight"] = [str(x) for x in h] if isinstance(h, list) else [str(h)]
    if args.get("lines"):
        opts["lines"] = _norm_lines(args["lines"], notes)
    if "trend" in args:
        opts["trend"] = _bool(args["trend"])

    spec = Spec(kind=kind, rows=rows, cols=cols, notes=notes, opts=opts, tree=tree)

    # Rôles explicites (tolérants à la casse et aux accents)
    xs = args.get("x")
    if isinstance(xs, list):
        spec.levels = [c for c in (match_column(v, cols, notes, "x") for v in xs) if c]
        spec.x = spec.levels[0] if spec.levels else None
    else:
        spec.x = match_column(xs, cols, notes, "x")
    ys = args.get("y")
    if ys not in (None, "", []):
        ys = ys if isinstance(ys, list) else [ys]
        spec.ys = [c for c in (match_column(v, cols, notes, "y") for v in ys) if c]
    spec.group = match_column(args.get("group"), cols, notes, "group")
    if spec.group is not None and spec.group.kind == "number":
        # « group » découpe en séries : une colonne de VALEURS n'a rien à y faire
        notes.fix(f"group '{spec.group.name}' is a numeric column: ignored "
                  "(one series per numeric column)")
        spec.group = None
    spec.size = match_column(args.get("size"), cols, notes, "size")

    if spec.kind == "auto":
        spec.auto_from = "auto"
        spec.kind = choose_kind(spec)
        notes.fix(f"type auto chose '{spec.kind}'")

    # Unité : explicite, sinon lue dans les valeurs (« 12 % », « 30 € »)
    if not opts["unit"]:
        units = {c.unit for c in (spec.ys or measures(cols)) if c.unit}
        if len(units) == 1:
            opts["unit"] = units.pop()
    n_coerced = sum(c.n_coerced for c in cols if c.kind == "number")
    if n_coerced:
        ex = next((c.example for c in cols if c.kind == "number" and c.example), None)
        exs = f" ('{ex[0]}' -> {ex[1]:g})" if ex else ""
        notes.fix(f"{n_coerced} value(s) written as text read as numbers{exs}")
    return spec


def _norm_lines(lines: Any, notes: Notes) -> list[dict]:
    out = []
    items = lines if isinstance(lines, list) else [lines]
    for it in items:
        if isinstance(it, (int, float, str)) and num(it) is not None:
            out.append({"value": num(it), "label": ""})
        elif isinstance(it, dict):
            v = None
            for k, val in it.items():
                if fold(k) in {"value", "y", "valeur", "y_min", "ymin", "at", "seuil"}:
                    v = num(val)
            lab = next((str(val) for k, val in it.items()
                        if fold(k) in {"label", "name", "libelle", "text", "nom"}), "")
            if v is not None:
                out.append({"value": v, "label": lab})
            else:
                notes.warn("reference line without a value: ignored")
    return out


def _flatten_tree(nodes: list[dict], depth: int = 0) -> list[dict]:
    out = []
    for n in nodes or []:
        if not isinstance(n, dict):
            continue
        row = {k: v for k, v in n.items() if fold(k) != "children"}
        out.append(row)
        kids = next((v for k, v in n.items() if fold(k) == "children"), None)
        if isinstance(kids, list):
            out.extend(_flatten_tree(kids, depth + 1))
    return out


def is_nested(rows: list[dict], parent: Column, child: Column) -> bool:
    """Hiérarchie (chaque enfant sous UN parent, homonymes tolérés) plutôt que
    croisement (chaque valeur de ``child`` répétée sous tous les parents) ?"""
    parents_of: dict[Any, set] = {}
    for r in rows:
        parents_of.setdefault(r.get(child.name), set()).add(r.get(parent.name))
    n_par = len({r.get(parent.name) for r in rows})
    if n_par < 2 or len(parents_of) <= n_par:
        return False
    shared = sum(1 for ps in parents_of.values() if len(ps) > 1)
    return shared / len(parents_of) < 0.5


def choose_kind(spec: Spec) -> str:
    """Type « auto » : choix prudent d'après la forme des données."""
    cols, rows = spec.cols, spec.rows
    if spec.tree is not None:
        return "treemap" if any(fold(c.name) in {"value", "valeur"} for c in cols) else "tree"
    d, m = dims(cols), measures(cols)
    if by_name(cols, "open") and by_name(cols, "close") and by_name(cols, "high"):
        return "candlestick"
    if by_name(cols, "source", ("text",)) and by_name(cols, "target", ("text",)):
        return "sankey"
    if by_name(cols, "parent"):
        return "tree"
    if by_name(cols, "start", ("date",)) and by_name(cols, "end", ("date",)):
        return "gantt"
    if len(rows) == 1 and m:
        return "gauge" if by_name(cols, "max", ("number",)) else "kpi"
    if not d:
        if len(m) == 1:
            return "histogram"
        return "bubble" if len(m) >= 3 else "scatter"
    if len(d) >= 2 and len(m) >= 1 and is_nested(rows, d[0], d[1]):
        return "treemap"
    x = d[0]
    if x.dates or x.months:
        return "line"
    if len(m) == 1 and len(d) == 1 and 2 <= len(rows) <= 6:
        vals = [num(r.get(m[0].name)) for r in rows]
        if all(v is not None and v >= 0 for v in vals):
            s = sum(vals)  # type: ignore[arg-type]
            if m[0].unit == "%" or 98 <= s <= 102:
                return "donut"
    return "bar"
