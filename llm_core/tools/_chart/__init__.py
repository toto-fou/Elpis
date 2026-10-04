# SPDX-License-Identifier: MIT
"""Moteur des outils graphiques ``chart_<type>`` (rendu Apache ECharts).

Le modèle ne fournit qu'un tableau de lignes et, au besoin, quelles colonnes
jouent quel rôle (x, y, group, size). Tout le reste (séries, matrice de
heatmap, nœuds de sankey, quartiles, classes d'histogramme…) est construit ici :

  - ``normalise``       lecture tolérante (casse, synonymes, « 1 234,5 € », CSV…) ;
  - ``spec``            arguments → spécification canonique, rôles des colonnes ;
  - ``compile_echarts`` spécification → option ECharts en JSON pur (aucune
                        fonction : couleurs d'interface en jetons ``@nom``,
                        mise en forme posée par le navigateur).

Chaque correction appliquée est renvoyée au modèle (``fixes``), chaque choix
imposé aussi (``warnings``) : il apprend sans échec. Un appel IDENTIQUE à un
appel déjà refusé dans la même conversation reçoit un refus explicite qui
demande de changer d'approche (garde-fou anti-boucle, propre à ces outils).
"""
from __future__ import annotations

import hashlib
import json
from collections import OrderedDict
from typing import Any, Dict, List, Optional, Tuple

from .compile_echarts import compile_option
from .spec import SpecError, build_spec

# ── Paramètres exposés (schéma JSON annoncé au modèle) ─────────────────────
# Les ``enum`` sont imposés par la grammaire de llama.cpp au décodage ; la
# validation côté serveur reste permissive pour que la lecture tolérante
# rattrape les connecteurs sans grammaire.
ROW_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "additionalProperties": {"type": ["string", "number", "boolean", "null"]},
}

PARAM_SCHEMAS: Dict[str, Dict[str, Any]] = {
    "data": {"type": "array", "items": ROW_SCHEMA, "minItems": 1,
             "description": "Rows of the table: one object per row, same keys in every row, "
                            "numbers as numbers."},
    "title": {"type": "string"},
    "x": {"type": "string", "description": "Column for categories, labels or dates."},
    "y": {"type": "array", "items": {"type": "string"},
          "description": "Numeric column(s) to plot. Default: every numeric column."},
    "group": {"type": "string", "description": "Column that splits rows into series / colours."},
    "size": {"type": "string", "description": "Numeric column for the bubble size."},
    "unit": {"type": "string", "description": "Unit of the values: €, %, h, kg…"},
    "stack": {"type": "string", "enum": ["none", "stacked", "percent"]},
    "horizontal": {"type": "boolean"},
    "sort": {"type": "string", "enum": ["none", "asc", "desc"]},
    "top": {"type": "integer",
            "description": "Keep the N largest categories, fold the rest into « Autres »."},
    "show_values": {"type": "boolean"},
    "highlight": {"type": "string", "description": "Category to emphasise (others greyed)."},
    "lines": {"type": "array", "description": "Reference lines (target, threshold).",
              "items": {"type": "object",
                        "properties": {"value": {"type": "number"}, "label": {"type": "string"}},
                        "required": ["value"], "additionalProperties": False}},
    "trend": {"type": "boolean",
              "description": "Add a linear trend (moving average for candlestick)."},
}

# Paramètres facultatifs : valeur par défaut neutre (absente de l'appel).
PARAM_DEFAULTS: Dict[str, Any] = {
    "title": "", "x": None, "y": None, "group": None, "size": None, "unit": "",
    "stack": "none", "horizontal": False, "sort": "none", "top": None, "show_values": False,
    "highlight": None, "lines": None, "trend": False,
}

_CART = ["x", "y", "group", "unit", "stack", "horizontal", "sort", "top", "show_values",
         "highlight", "lines", "trend"]

# type → (rôle en une phrase, forme d'une ligne, options propres au type)
PER_TYPE: "OrderedDict[str, Tuple[str, str, List[str]]]" = OrderedDict([
    ("bar", ("Bar chart: compare values across categories.",
             '{"month":"Jan","sales":12,"costs":8} (one column per series), '
             'or long format {"month","region","sales"} + group="region"', _CART)),
    ("line", ("Line chart: evolution over time or an ordered axis.",
              '{"month":"Jan","sales":12}', ["x", "y", "group", "unit", "lines", "trend",
                                             "show_values"])),
    ("area", ("Area chart: evolution of volumes (stack=stacked for parts of a total).",
              '{"month":"Jan","files":40,"backups":55}', ["x", "y", "group", "unit", "stack",
                                                          "lines"])),
    ("stream", ("Streamgraph: evolution of several categories over dates.",
                '{"month":"2026-01","channel":"Phone","requests":120}', ["x", "y", "group", "unit"])),
    ("radar", ("Radar chart: profile of entities across several criteria.",
               '{"solution":"A","cost":7,"security":9,"support":8}', ["x", "y", "group"])),
    ("polar_bar", ("Polar bar chart: values around a circle (days, hours, directions).",
                   '{"day":"Mon","logins":820}', ["x", "y", "group", "unit", "stack"])),
    ("waterfall", ("Waterfall: how a starting value becomes a final one, step by step.",
                   '{"step":"Initial budget","amount":1200}, then the deltas '
                   '{"step":"Hiring","amount":-180}', ["x", "y", "unit"])),
    ("pie", ("Pie chart: share of a whole (up to 6 parts).", '{"label":"Windows","value":1240}',
             ["x", "y", "unit", "top", "highlight"])),
    ("donut", ("Donut chart: share of a whole, total in the centre.",
               '{"label":"Windows","value":1240}', ["x", "y", "unit", "top", "highlight"])),
    ("rose", ("Nightingale rose: shares drawn as radii.", '{"cause":"Network","incidents":28}',
              ["x", "y", "unit", "top"])),
    ("treemap", ("Treemap: sizes of a hierarchy as nested rectangles.",
                 '{"direction":"Tech","service":"Infra","budget":820} (one text column per level)',
                 ["x", "y", "unit"])),
    ("sunburst", ("Sunburst: a hierarchy as rings.",
                  '{"channel":"Search","source":"Engine A","visits":4200}', ["x", "y", "unit"])),
    ("funnel", ("Funnel: successive stages of a process.", '{"stage":"Visits","count":12000}',
                ["x", "y", "unit"])),
    ("histogram", ("Histogram: distribution of raw values (bins computed for you).",
                   '{"age":34}, one row per raw value', ["y", "group", "unit"])),
    ("boxplot", ("Box plot: spread of raw values per group.",
                 '{"team":"A","delay":3.2}, one row per raw value', ["x", "y", "group", "unit",
                                                                    "lines"])),
    ("scatter", ("Scatter plot: relation between two measures.", '{"surface":45,"price":210}',
                 ["x", "y", "group", "unit", "trend", "lines"])),
    ("bubble", ("Bubble chart: two measures and a size.", '{"surface":45,"price":210,"rooms":2}',
                ["x", "y", "group", "size", "unit"])),
    ("heatmap", ("Heatmap: a value for each pair of two categories.",
                 '{"day":"Mon","hour":"9 h","calls":12} (names, not indexes)', ["x", "y", "unit"])),
    ("calendar", ("Calendar heatmap: one value per day.", '{"date":"2026-01-05","commits":7}',
                  ["x", "y", "unit"])),
    ("parallel", ("Parallel coordinates: compare items on several measures.",
                  '{"model":"A","cores":8,"ram":32,"price":3.2}', ["y", "group"])),
    ("sankey", ("Sankey: flows between stages (no loops).",
                '{"source":"Budget","target":"Salaries","value":780}', ["unit"])),
    ("chord", ("Chord diagram: exchanges between members.",
               '{"source":"HR","target":"Finance","value":30}', ["unit"])),
    ("graph", ("Network graph: links between nodes.", '{"source":"Portal","target":"Directory"}',
               ["group"])),
    ("tree", ("Tree / org chart.", '{"name":"Studies","parent":"CIO"}', ["x"])),
    ("gantt", ("Gantt chart: tasks over time.",
               '{"task":"Pilot","start":"2026-10-05","end":"2026-10-23"}', ["x", "group"])),
    ("candlestick", ("Candlestick: open/high/low/close per date (trend = moving average).",
                     '{"date":"2026-03-02","open":101.2,"high":104,"low":100.5,"close":103.1}',
                     ["x", "trend"])),
    ("gauge", ("Gauge: one value against a maximum.",
               '{"label":"Availability","value":99.2,"max":100}', ["unit"])),
    ("progress", ("Progress bars: done vs total per item.",
                  '{"item":"MFA","done":1210,"total":1500}', ["x", "y", "unit"])),
    ("kpi", ("Key figures as tiles, with the change vs a previous value.",
             '{"label":"Tickets","value":1284,"previous":1190}', ["unit"])),
    ("table", ("Table of exact figures (sortable in the UI).",
               '{"measure":"Latency","value":8,"unit":"ms"}', [])),
])


def tool_description(kind: str) -> str:
    desc, row, _ = PER_TYPE[kind]
    return (f"{desc}\nRows: {row}.\n"
            "Returns `ref` (e.g. !a1b2c3d4e5f6): write it alone on its own line where the "
            "chart goes. `summary` says what was drawn, `fixes` what was understood for you.")


# ── Garde-fou anti-boucle ─────────────────────────────────────────────────
# Les petits modèles renvoient souvent EXACTEMENT le même appel après un refus
# (mesuré : ornith-9B, 4 appels identiques de suite). On mémorise, par
# conversation, l'empreinte des appels refusés ; au 2e envoi identique, le
# retour le dit en toutes lettres. Mémoire bornée, par processus.
_REFUS: "OrderedDict[str, int]" = OrderedDict()
_REFUS_MAX = 4096


def _empreinte(session: str, args: Any) -> str:
    canon = json.dumps(args, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha1(f"{session}\x00{canon}".encode()).hexdigest()


def _refus(session: Optional[str], args: Any, out: Dict[str, Any]) -> Dict[str, Any]:
    if not session:
        return out
    k = _empreinte(session, args)
    n = _REFUS.pop(k, 0) + 1
    _REFUS[k] = n
    while len(_REFUS) > _REFUS_MAX:
        _REFUS.popitem(last=False)
    if n >= 2:
        out["error"] = "repeated_call"
        out["repeated"] = n
        out["message"] = (f"SAME call as before, already refused {n - 1} time(s) for the same "
                          f"reason: do not send it again unchanged. {out.get('message', '')}")
        out["next_action"] = ("Change the call as `fix` says (use `example` as a model), or tell "
                              "the user what is missing and answer without a chart.")
    return out


def run_chart(args: Dict[str, Any], session: Optional[str] = None
              ) -> Tuple[Dict[str, Any], Optional[Dict[str, Any]], Optional[str]]:
    """Exécute un appel → (retour pour le modèle, option ECharts | None, type tracé | None).

    Le retour d'échec suit l'enveloppe d'Elpis (``ok/error/message/fix``),
    complétée de ``example`` (lignes attendues) et, en cas de répétition, de
    ``repeated``/``next_action``."""
    try:
        spec = build_spec(args)
        option, summary = compile_option(spec)
    except SpecError as e:
        out: Dict[str, Any] = {"ok": False, "error": "invalid_chart_spec", "message": e.message}
        if e.fix:
            out["fix"] = e.fix
        if e.example is not None:
            out["example"] = {"data": e.example}
        return _refus(session, args, out), None, None
    result: Dict[str, Any] = {"ok": True, "summary": summary, "chart_type": spec.kind}
    if spec.notes.fixes:
        result["fixes"] = spec.notes.fixes
    if spec.notes.warnings:
        result["warnings"] = spec.notes.warnings
    return result, option, spec.kind


__all__ = ["PER_TYPE", "PARAM_SCHEMAS", "PARAM_DEFAULTS", "ROW_SCHEMA", "run_chart",
           "tool_description", "SpecError"]
