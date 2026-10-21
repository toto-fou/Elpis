# SPDX-License-Identifier: MIT
"""``Spec`` → option Apache ECharts (JSON pur, aucune fonction).

Conventions partagées avec le rendu navigateur (``web/rendu.js``) :
  - les couleurs d'interface sont des JETONS « @nom » (``@surface``, ``@ink``,
    ``@muted``, ``@up``, ``@down``, ``@seq``…) résolus selon le thème clair /
    sombre au moment du rendu — le serveur ne connaît pas le thème ;
  - la palette des séries vient du thème ECharts enregistré côté navigateur ;
  - ``_elpis`` porte les indications de mise en forme (unité, tableau, KPI) ;
    les clés ``_lbl`` d'une série disent comment formater ses étiquettes.
"""
from __future__ import annotations

import math
import statistics
from collections import OrderedDict, defaultdict
from datetime import datetime, timedelta
from typing import Any

from .normalise import fold, month_key, num, to_date, to_number
from .spec import MAX_SERIES, Spec, SpecError, by_name, dims, measures

OTHER = "Autres"
MONTHS_FR = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.",
             "oct.", "nov.", "déc."]
ORDINAL_RAMP = ["#256abf", "#2a78d6", "#3987e5", "#5598e7", "#6da7ec", "#86b6ef"]


# ── Mise en forme française (résumés et étiquettes statiques) ──────────────


def fr(v: float | None, unit: str = "", digits: int = 2) -> str:
    if v is None:
        return "—"
    a = abs(v)
    if a >= 1e9:
        s, suf = v / 1e9, " Md"
    elif a >= 1e6:
        s, suf = v / 1e6, " M"
    elif a >= 1e4:
        s, suf = v / 1e3, " k"
    else:
        s, suf = v, ""
    txt = f"{s:,.{digits}f}".rstrip("0").rstrip(".") if digits else f"{s:,.0f}"
    txt = txt.replace(",", " ").replace(".", ",").replace("-", "−")
    u = "" if not unit else (unit if unit == "%" else unit)
    sep = " " if u else ""
    return f"{txt}{suf}{sep}{u}" if not suf or not u else f"{txt}{suf}{u}"


def _nice_ceil(v: float) -> float:
    if v <= 0:
        return 1.0
    e = 10 ** math.floor(math.log10(v))
    for m in (1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10):
        if m * e >= v:
            return m * e
    return 10 * e


# ── Assemblage catégories × séries (barres, courbes, secteurs…) ───────────


def _label(v: Any) -> str:
    if v is None:
        return "(vide)"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def cartesian(spec: Spec, multi: bool = True) -> tuple[list[str], list[dict], str, list[str]]:
    """→ (catégories, séries [{name, data}], nom de x, noms des mesures)."""
    rows, cols, notes = spec.rows, spec.cols, spec.notes
    d, m = dims(cols), measures(cols)
    x = spec.x or next((c for c in d if c.dates or c.months), None) or (d[0] if d else None)
    used = {c.name for c in (x, spec.group, spec.size) if c}
    ys = spec.ys or [c for c in m if c.name not in used]
    if not ys:
        raise SpecError(
            f"no numeric column to plot (columns: {', '.join(c.name for c in cols)})",
            fix="add a column of numbers, or name it with y=[\"column\"]",
            example=[{"catégorie": "A", "valeur": 12}, {"catégorie": "B", "valeur": 7}])
    group = spec.group
    if group is not None and (group is x or len(ys) > 1):
        # Données « larges » (une colonne par série) : group ferait perdre des séries
        spec.notes.fix(f"group '{group.name}' ignored: "
                       + ("it is already the category (x)" if group is x else
                          "one column per series, all plotted"))
        group = None
    if multi and group is None and len(ys) == 1 and x is not None:
        others = [c for c in d if c is not x]
        if others and spec.kind not in ("pie", "donut", "rose", "funnel", "waterfall"):
            group = others[0]
            notes.fix(f"long format: series = column '{group.name}'")
    spec.group = group
    if group is not None and len(ys) > 1:
        notes.warn(f"group + several y: only '{ys[0].name}' is plotted")
        ys = ys[:1]

    # Ordre des catégories : apparition, ou chronologique pour les dates
    cats: "OrderedDict[str, Any]" = OrderedDict()
    for i, r in enumerate(rows):
        key = _label(r.get(x.name)) if x else f"#{i + 1}"
        cats.setdefault(key, r.get(x.name) if x else key)
    keys = list(cats)
    if x is not None and (x.dates or x.months):
        sk = (lambda k: to_date(cats[k]) or "") if x.dates else (lambda k: month_key(cats[k]) or "")
        if keys != sorted(keys, key=sk):
            keys.sort(key=sk)
            notes.fix(f"'{x.name}' sorted chronologically")

    series: "OrderedDict[str, dict[str, float | None]]" = OrderedDict()
    dup = False
    for i, r in enumerate(rows):
        key = _label(r.get(x.name)) if x else f"#{i + 1}"
        if group is not None:
            names = [(_label(r.get(group.name)), ys[0])]
        else:
            names = [(c.name, c) for c in ys]
        for sname, col in names:
            v = num(r.get(col.name))
            s = series.setdefault(sname, {})
            if key in s and s[key] is not None and v is not None:
                s[key] = (s[key] or 0) + v
                dup = True
            elif key not in s or s[key] is None:
                s[key] = v
    if dup:
        notes.warn(f"several rows share the same '{x.name if x else 'x'}': summed")

    out = [{"name": n, "data": [s.get(k) for k in keys]} for n, s in series.items()]

    # Tri et repli « top N »
    totals = [sum(abs(s["data"][i] or 0) for s in out) for i in range(len(keys))]
    order = list(range(len(keys)))
    if spec.opts["sort"] in ("asc", "desc"):
        order.sort(key=lambda i: totals[i], reverse=spec.opts["sort"] == "desc")
    top = spec.opts["top"]
    if top and len(keys) > top:
        best = sorted(order, key=lambda i: -totals[i])[:top]
        keep = [i for i in order if i in best]
        rest = [i for i in order if i not in best]
        new_keys = [keys[i] for i in keep] + [OTHER]
        for s in out:
            s["data"] = [s["data"][i] for i in keep] + [sum(s["data"][i] or 0 for i in rest)]
        notes.fix(f"top {top}: {len(rest)} categories folded into '{OTHER}'")
        keys = new_keys
    else:
        keys = [keys[i] for i in order]
        for s in out:
            s["data"] = [s["data"][i] for i in order]

    if len(out) > MAX_SERIES:
        ranked = sorted(out, key=lambda s: -sum(abs(v or 0) for v in s["data"]))
        keep_s, rest_s = ranked[:MAX_SERIES - 1], ranked[MAX_SERIES - 1:]
        other = {"name": OTHER, "data": [sum(s["data"][i] or 0 for s in rest_s)
                                         for i in range(len(keys))]}
        out = [s for s in out if s in keep_s] + [other]
        notes.fix(f"{len(rest_s)} series folded into '{OTHER}' (8 colours max)")

    # Deux mesures d'échelles très différentes sur un même axe : prévenir
    if len(out) == 2 and group is None:
        a = max((abs(v) for v in out[0]["data"] if v is not None), default=0)
        b = max((abs(v) for v in out[1]["data"] if v is not None), default=0)
        if a and b and max(a, b) / min(a, b) > 25:
            notes.warn("two series with very different scales: one chart per series would read better")
    return keys, out, (x.name if x else ""), [c.name for c in ys]


# ── Options communes ─────────────────────────────────────────────────────


def _base(spec: Spec) -> dict:
    o: dict[str, Any] = {"animationDuration": 500, "animationEasing": "cubicOut"}
    t = spec.opts["title"]
    if t or spec.opts["subtitle"]:
        o["title"] = {"text": t, "subtext": spec.opts["subtitle"], "left": 4, "top": 2}
    o["_elpis"] = {"kind": spec.kind, "unit": spec.opts["unit"], "table": _table(spec)}
    return o


def _table(spec: Spec) -> dict:
    names = [c.name for c in spec.cols]
    return {"columns": names,
            "rows": [[r.get(n) for n in names] for r in spec.rows[:500]],
            "truncated": len(spec.rows) > 500}


def _legend(o: dict, n: int, force: bool = False) -> None:
    if n > 1 or force:
        o["legend"] = {"type": "scroll", "top": 30 if o.get("title") else 4, "left": "center",
                       "icon": "roundRect", "itemWidth": 12, "itemHeight": 8}


def _grid(o: dict, bottom: int = 28) -> None:
    top = 34
    if o.get("title"):
        top += 26 + (16 if o["title"].get("subtext") else 0)
    if o.get("legend"):
        top += 26
    o["grid"] = {"top": top, "left": 12, "right": 20, "bottom": bottom}


def _zoom(o: dict, n: int, axis: str = "x", threshold: int = 30) -> int:
    if n <= threshold:
        return 28
    key = "xAxisIndex" if axis == "x" else "yAxisIndex"
    o["dataZoom"] = [{"type": "inside", key: 0},
                     {"type": "slider", key: 0, "height": 18, "bottom": 6,
                      "showDetail": False, "brushSelect": False}]
    return 56


def _value_label(spec: Spec, pos: str = "top") -> dict:
    return {"show": True, "position": pos, "color": "@ink2", "fontSize": 11}


def _mark_lines(spec: Spec, axis: str) -> dict | None:
    if not spec.opts["lines"]:
        return None
    return {"symbol": "none", "silent": False,
            "lineStyle": {"type": "dashed", "color": "@ink2", "width": 1.5},
            "label": {"position": "insideEndTop", "color": "@ink2", "fontSize": 11},
            "data": [{axis: ln["value"], "name": ln["label"] or fr(ln["value"], spec.opts["unit"]),
                      "label": {"formatter": ln["label"] or fr(ln["value"], spec.opts["unit"])}}
                     for ln in spec.opts["lines"]]}


def _regression(xs: list[float], ys: list[float]) -> tuple[float, float, float] | None:
    pts = [(a, b) for a, b in zip(xs, ys) if a is not None and b is not None]
    if len(pts) < 3:
        return None
    n = len(pts)
    mx = sum(p[0] for p in pts) / n
    my = sum(p[1] for p in pts) / n
    sxx = sum((p[0] - mx) ** 2 for p in pts)
    if sxx == 0:
        return None
    sxy = sum((p[0] - mx) * (p[1] - my) for p in pts)
    a = sxy / sxx
    b = my - a * mx
    ss_tot = sum((p[1] - my) ** 2 for p in pts) or 1
    ss_res = sum((p[1] - (a * p[0] + b)) ** 2 for p in pts)
    return a, b, 1 - ss_res / ss_tot


# ── Cartésiens : barres, courbes, aires ──────────────────────────────────


def c_bar_line(spec: Spec) -> tuple[dict, str]:
    kind = spec.kind
    cats, series, xname, ynames = cartesian(spec)
    o = _base(spec)
    unit = spec.opts["unit"]
    stack = spec.opts["stack"]
    if stack == "percent":
        for i in range(len(cats)):
            tot = sum(abs(s["data"][i] or 0) for s in series)
            for s in series:
                v = s["data"][i]
                s["data"][i] = None if v is None or not tot else round(100 * v / tot, 2)
        unit = o["_elpis"]["unit"] = "%"
    horizontal = spec.opts["horizontal"] and kind == "bar"
    if kind == "bar" and not horizontal and len(cats) > 8 and \
            sum(len(c) for c in cats) / max(1, len(cats)) > 14:
        horizontal = True
        spec.notes.fix("long labels: horizontal bars")
    cat_axis: dict[str, Any] = {"type": "category", "data": cats, "axisTick": {"show": False},
                                "boundaryGap": kind == "bar"}
    if xname:
        cat_axis["name"] = xname if not horizontal else ""
    val_axis: dict[str, Any] = {"type": "value", "_fmt": True}
    if stack == "percent":
        val_axis["max"] = 100
    if len(ynames) == 1 and spec.group is None:
        val_axis["name"] = ynames[0]
    hl = set(spec.opts["highlight"] or [])
    out = []
    for si, s in enumerate(series):
        ser: dict[str, Any] = {"type": "bar" if kind == "bar" else "line", "name": s["name"],
                               "data": s["data"], "emphasis": {"focus": "series"}}
        if kind == "bar":
            ser["barMaxWidth"] = 44
            last = si == len(series) - 1 or stack == "none"
            r = 4 if last else 0
            ser["itemStyle"] = {"borderRadius": [0, r, r, 0] if horizontal else [r, r, 0, 0]}
            if stack != "none":
                ser["stack"] = "total"
                ser["itemStyle"].update({"borderColor": "@surface", "borderWidth": 1})
            if hl:
                ser["data"] = [v if c in hl else {"value": v, "itemStyle": {"color": "@muted"}}
                               for c, v in zip(cats, s["data"])]
        else:
            ser.update({"showSymbol": len(cats) <= 24, "symbolSize": 7,
                        "lineStyle": {"width": 2}, "smooth": spec.opts["smooth"],
                        "connectNulls": False})
            if spec.opts["step"]:
                ser["step"] = "middle"
            if kind == "area" or stack != "none":
                ser["areaStyle"] = {"opacity": 0.85 if stack != "none" else 0.16}
                if stack != "none":
                    ser["stack"] = "total"
                    ser["lineStyle"] = {"width": 1}
                    ser["showSymbol"] = False
        if spec.opts["show_values"]:
            pos = "right" if horizontal else ("inside" if stack != "none" else "top")
            ser["label"] = _value_label(spec, pos)
            ser["_lbl"] = {"v": None}
            ser["labelLayout"] = {"hideOverlap": True}
        out.append(ser)
    ml = _mark_lines(spec, "xAxis" if horizontal else "yAxis")
    if ml:
        out[0]["markLine"] = ml
    if spec.opts["trend"] and kind in ("line", "area", "bar"):
        for s in series[:3]:
            reg = _regression(list(range(len(cats))), s["data"])
            if reg:
                a, b, r2 = reg
                out.append({"type": "line", "name": f"Tendance {s['name']}", "symbol": "none",
                            "data": [round(a * i + b, 4) for i in range(len(cats))],
                            "lineStyle": {"type": "dashed", "width": 1.5, "color": "@ink2"},
                            "itemStyle": {"color": "@ink2"}, "tooltip": {"show": False}, "silent": True})
                spec.notes.fix(f"trend '{s['name']}': slope {fr(a, unit)}/step, R² = {r2:.2f}")
    o["series"] = out
    _legend(o, len(series))
    o["tooltip"] = {"trigger": "axis",
                    "axisPointer": {"type": "shadow" if kind == "bar" else "line"}}
    if horizontal:
        cat_axis["inverse"] = True
        o["xAxis"], o["yAxis"] = val_axis, cat_axis
        bottom = _zoom(o, len(cats), "y", 40)
    else:
        o["xAxis"], o["yAxis"] = cat_axis, val_axis
        bottom = _zoom(o, len(cats))
    _grid(o, bottom)
    summ = (f"{kind}{' horizontal' if horizontal else ''}"
            f"{'' if stack == 'none' else ' ' + stack} · x={xname or 'row number'} ({len(cats)}) · "
            f"series: {', '.join(s['name'] for s in series)}")
    return o, summ


def c_stream(spec: Spec) -> tuple[dict, str]:
    cats, series, xname, _ = cartesian(spec)
    x = spec.x or next((c for c in dims(spec.cols) if c.dates or c.months), None)
    if x is None:
        spec.kind = "area"
        spec.opts["stack"] = "stacked"
        spec.notes.fix("stream without dates: stacked areas instead")
        return c_bar_line(spec)
    o = _base(spec)

    def iso(k: str) -> str:
        return to_date(k) or (month_key(k) + "-01" if month_key(k) else k)
    data = [[iso(c), s["data"][i] or 0, s["name"]] for s in series for i, c in enumerate(cats)]
    o["singleAxis"] = {"type": "time", "top": 60 if o.get("title") else 40, "bottom": 30,
                       "left": 20, "right": 20, "axisTick": {"show": False}}
    o["series"] = [{"type": "themeRiver", "data": data,
                    "emphasis": {"focus": "self"}, "label": {"show": False}}]
    o["tooltip"] = {"trigger": "axis", "axisPointer": {"type": "line"}}
    _legend(o, len(series), force=True)
    return o, f"stream · {len(cats)} dates · {len(series)} series"


# ── Parts d'un tout ──────────────────────────────────────────────────────


def c_pie(spec: Spec) -> tuple[dict, str]:
    if spec.group is not None:
        spec.notes.warn("group ignored for a pie: values summed per category")
        spec.group = None
    cats, series, xname, ynames = cartesian(spec, multi=False)
    if len(series) > 1:
        spec.notes.warn(f"a pie shows one measure: '{series[0]['name']}' (others ignored)")
    vals = series[0]["data"]
    items = [(c, v) for c, v in zip(cats, vals) if v is not None]
    neg = [c for c, v in items if v < 0]
    if neg:
        spec.notes.warn(f"negative values cannot be pie slices: {', '.join(neg[:3])} ignored")
        items = [(c, v) for c, v in items if v >= 0]
    items.sort(key=lambda p: -p[1])
    if len(items) > MAX_SERIES and not spec.opts["top"]:
        keep, rest = items[:MAX_SERIES - 1], items[MAX_SERIES - 1:]
        items = keep + [(OTHER, sum(v for _, v in rest))]
        spec.notes.fix(f"{len(rest)} small slices folded into '{OTHER}'")
    total = sum(v for _, v in items)
    o = _base(spec)
    hl = set(spec.opts["highlight"] or [])
    data = []
    for c, v in items:
        it: dict[str, Any] = {"name": c, "value": v}
        if c == OTHER:
            it["itemStyle"] = {"color": "@muted"}
        if hl and c not in hl:
            it["itemStyle"] = {"color": "@muted", "opacity": 0.55}
        data.append(it)
    kind = spec.kind
    ser: dict[str, Any] = {
        "type": "pie", "name": ynames[0] if ynames else "", "data": data,
        "center": ["50%", "56%"], "avoidLabelOverlap": True,
        "itemStyle": {"borderColor": "@surface", "borderWidth": 2,
                      "borderRadius": 4 if kind == "donut" else 0},
        "label": {"formatter": "{b}\n{d} %", "color": "@ink2", "fontSize": 11, "lineHeight": 15},
        "_lbl": {"pct": True},
        "labelLine": {"length": 8, "length2": 10},
        "emphasis": {"scale": True, "scaleSize": 4},
    }
    if kind == "donut":
        ser["radius"] = ["44%", "68%"]
        o["graphic"] = [{"type": "text", "left": "center", "top": "51%",
                         "style": {"text": fr(total, spec.opts["unit"]), "fill": "@ink",
                                   "fontSize": 20, "fontWeight": 600, "textAlign": "center"}}]
    elif kind == "rose":
        ser["radius"] = ["14%", "70%"]
        ser["roseType"] = "area"
        ser["itemStyle"]["borderRadius"] = 4
    else:
        ser["radius"] = ["0%", "68%"]
    o["series"] = [ser]
    o["tooltip"] = {"trigger": "item"}
    shares = ", ".join(f"{c} {100 * v / total:.0f} %" for c, v in items[:4]) if total else ""
    return o, f"{kind} · {len(items)} slices · total {fr(total, spec.opts['unit'])} · {shares}"


def c_funnel(spec: Spec) -> tuple[dict, str]:
    cats, series, _, ynames = cartesian(spec, multi=False)
    items = sorted([(c, v) for c, v in zip(cats, series[0]["data"]) if v is not None],
                   key=lambda p: -p[1])
    first = items[0][1] if items else 1
    o = _base(spec)
    data = []
    for i, (c, v) in enumerate(items):
        pct = 100 * v / first if first else 0
        data.append({"name": c, "value": v,
                     "itemStyle": {"color": ORDINAL_RAMP[min(i, len(ORDINAL_RAMP) - 1)]},
                     "label": {"formatter": f"{c}  {fr(v, spec.opts['unit'])} · {pct:.0f} %"}})
    o["series"] = [{"type": "funnel", "data": data, "sort": "descending", "gap": 2,
                    "left": "4%", "width": "56%", "top": 60 if o.get("title") else 20, "bottom": 10,
                    "minSize": "14%", "label": {"position": "right", "color": "@ink", "fontSize": 12},
                    "labelLine": {"length": 12, "lineStyle": {"color": "@grid"}},
                    "itemStyle": {"borderColor": "@surface", "borderWidth": 0}}]
    o["tooltip"] = {"trigger": "item"}
    conv = fr(100 * items[-1][1] / first, "%", 1) if items and first else "—"
    return o, f"funnel · {len(items)} stages · final conversion {conv}"


def c_gauge(spec: Spec) -> tuple[dict, str]:
    m = spec.ys or measures(spec.cols)
    mx_col = by_name(spec.cols, "max", ("number",))
    vals = [c for c in m if c is not mx_col]
    if not vals:
        raise SpecError("gauge: no numeric value",
                        example=[{"indicateur": "Taux de service", "valeur": 72, "max": 100}])
    if len(spec.rows) > 1:
        spec.notes.fix("several rows: progress bars instead of a gauge")
        spec.kind = "progress"
        return c_progress(spec)
    r = spec.rows[0]
    v = num(r.get(vals[0].name)) or 0
    unit = spec.opts["unit"]
    mx = num(r.get(mx_col.name)) if mx_col else None
    if not mx:
        mx = 100 if (unit == "%" or 0 <= v <= 100) else _nice_ceil(v * 1.1)
    d = dims(spec.cols)
    name = str(r.get(d[0].name)) if d else vals[0].name
    o = _base(spec)
    ser: dict[str, Any] = {
        "type": "gauge", "startAngle": 210, "endAngle": -30, "min": 0, "max": mx,
        "radius": "88%", "center": ["50%", "58%"],
        "progress": {"show": True, "width": 16, "roundCap": True, "itemStyle": {"color": "@series1"}},
        "axisLine": {"roundCap": True, "lineStyle": {"width": 16, "color": [[1, "@track"]]}},
        "pointer": {"show": False}, "axisTick": {"show": False}, "splitLine": {"show": False},
        "axisLabel": {"show": False}, "anchor": {"show": False},
        "title": {"offsetCenter": [0, "34%"], "color": "@ink2", "fontSize": 13},
        "detail": {"valueAnimation": True, "offsetCenter": [0, "0%"], "fontSize": 30,
                   "fontWeight": 600, "color": "@ink",
                   "formatter": fr(v, unit) + f"\n{{sub|sur {fr(mx, unit)}}}",
                   "rich": {"sub": {"fontSize": 12, "color": "@ink2", "padding": [6, 0, 0, 0]}}},
        "data": [{"value": v, "name": name}],
    }
    if spec.opts["lines"]:
        ser["axisTick"] = {"show": False}
        spec.notes.warn("reference lines are not drawn on a gauge")
    o["series"] = [ser]
    return o, f"gauge · {name} = {fr(v, unit)} of {fr(mx, unit)} ({100 * v / mx:.0f} %)"


def c_progress(spec: Spec) -> tuple[dict, str]:
    mx_col = by_name(spec.cols, "max", ("number",))
    if mx_col is not None and mx_col in spec.ys:
        spec.ys = [c for c in spec.ys if c is not mx_col]
    if spec.ys == [] and mx_col is not None:
        spec.ys = [c for c in measures(spec.cols) if c is not mx_col][:1]
    cats, series, xname, _ = cartesian(spec, multi=False)
    vals = series[0]["data"]
    maxes = []
    if mx_col is not None:
        by_cat = {}
        for i, r in enumerate(spec.rows):
            key = _label(r.get(xname)) if xname else f"#{i + 1}"
            by_cat[key] = num(r.get(mx_col.name))
        maxes = [by_cat.get(c) or 100 for c in cats]
    else:
        g = 100 if all((v or 0) <= 100 for v in vals) else _nice_ceil(max(v or 0 for v in vals))
        maxes = [g] * len(cats)
    pct = [round(100 * (v or 0) / m, 1) if m else 0 for v, m in zip(vals, maxes)]
    unit = spec.opts["unit"]
    o = _base(spec)
    o["_elpis"]["unit"] = "%"
    o["xAxis"] = {"type": "value", "max": 100, "show": False}
    o["yAxis"] = {"type": "category", "data": cats, "inverse": True, "axisLine": {"show": False},
                  "axisTick": {"show": False}, "axisLabel": {"color": "@ink2", "fontSize": 12}}
    o["series"] = [{"type": "bar", "data": [
        {"value": p, "label": {"formatter": f"{fr(v, unit)} / {fr(m, unit)}  ({p:.0f} %)"}}
        for p, v, m in zip(pct, vals, maxes)],
        "barWidth": 14, "showBackground": True,
        "backgroundStyle": {"color": "@track", "borderRadius": 7},
        "itemStyle": {"borderRadius": 7},
        "label": {"show": True, "position": "right", "color": "@ink2", "fontSize": 11}}]
    o["tooltip"] = {"trigger": "axis", "axisPointer": {"type": "none"}}
    _grid(o)
    o["grid"]["right"] = 150
    return o, f"progress · {len(cats)} bars · {', '.join(f'{c} {p:.0f} %' for c, p in list(zip(cats, pct))[:4])}"


def c_kpi(spec: Spec) -> tuple[dict, str]:
    d, m = dims(spec.cols), measures(spec.cols)
    prev = by_name(spec.cols, "previous", ("number",))
    mx = by_name(spec.cols, "max", ("number",))
    vcols = spec.ys or [c for c in m if c not in (prev, mx)]
    if not vcols:
        raise SpecError("kpi: no numeric value",
                        example=[{"indicateur": "Chiffre d'affaires", "valeur": 1250000,
                                  "précédent": 1100000}])
    unit = spec.opts["unit"]
    tiles = []
    if len(spec.rows) == 1 and len(vcols) > 1 and not d:
        r = spec.rows[0]
        for c in vcols[:8]:
            tiles.append({"label": c.name, "value": fr(num(r.get(c.name)), c.unit or unit)})
    else:
        for r in spec.rows[:8]:
            raw = to_number(r.get(vcols[0].name))
            v, ru = raw.value, raw.unit or vcols[0].unit or unit
            t: dict[str, Any] = {"label": str(r.get(d[0].name)) if d else vcols[0].name,
                                 "value": fr(v, ru)}
            if prev is not None:
                p = num(r.get(prev.name))
                if p not in (None, 0) and v is not None:
                    delta = 100 * (v - p) / abs(p)
                    t["delta"] = ("+" if delta >= 0 else "−") + fr(abs(delta), "%", 1)
                    t["sign"] = "up" if delta > 0 else ("down" if delta < 0 else "flat")
                    t["ref"] = f"vs {fr(p, ru)}"
            tiles.append(t)
    o = _base(spec)
    o["_elpis"]["render"] = "kpi"
    o["_elpis"]["kpi"] = tiles
    return o, "kpi · " + " · ".join(f"{t['label']} {t['value']}" for t in tiles[:4])


def _nest(spec: Spec, levels: list, value_col) -> list[dict]:
    root: dict[str, Any] = {"children": OrderedDict()}
    for r in spec.rows:
        node = root
        for lv in levels:
            key = r.get(lv.name)
            if key in (None, ""):
                break
            node = node["children"].setdefault(str(key), {"name": str(key), "children": OrderedDict(),
                                                          "value": 0.0})
        v = num(r.get(value_col.name)) if value_col else 1.0
        node["value"] = (node.get("value") or 0) + (v or 0)

    def conv(n: dict) -> dict:
        kids = [conv(c) for c in n["children"].values()]
        out: dict[str, Any] = {"name": n["name"]}
        if kids:
            out["children"] = kids
            out["value"] = sum(k.get("value", 0) for k in kids)
        else:
            out["value"] = n.get("value", 0)
        return out
    return [conv(c) for c in root["children"].values()]


def _tree_from_rows(spec: Spec) -> tuple[list[dict], int]:
    """Hiérarchie : imbriquée (children), par parent, ou une colonne par niveau."""
    if spec.tree is not None:
        def norm(n: dict) -> dict:
            name = next((str(v) for k, v in n.items() if fold(k) in {"name", "nom", "label", "libelle"}), "")
            val = next((num(v) for k, v in n.items() if fold(k) in {"value", "valeur", "v", "size"}), None)
            kids = next((v for k, v in n.items() if fold(k) == "children"), None)
            out: dict[str, Any] = {"name": name}
            if isinstance(kids, list) and kids:
                out["children"] = [norm(k) for k in kids if isinstance(k, dict)]
                out["value"] = sum(c.get("value", 0) or 0 for c in out["children"])
            else:
                out["value"] = val if val is not None else 1
            return out
        nodes = [norm(n) for n in spec.tree]
        return nodes, _depth(nodes)
    parent = by_name(spec.cols, "parent")
    if parent is not None:
        d = [c for c in dims(spec.cols) if c is not parent]
        name_col = spec.x if spec.x and spec.x is not parent else (d[0] if d else None)
        if name_col is None:
            raise SpecError("tree: needs a name column and a parent column",
                            example=[{"nom": "Direction", "parent": ""},
                                     {"nom": "Ventes", "parent": "Direction"}])
        vcol = (spec.ys or [c for c in measures(spec.cols)] or [None])[0]
        nodes: dict[str, dict] = OrderedDict()
        for r in spec.rows:
            n = str(r.get(name_col.name))
            nodes[n] = {"name": n, "children": [], "_p": r.get(parent.name),
                        "value": num(r.get(vcol.name)) if vcol else 1}
        roots = []
        for n in nodes.values():
            p = n.pop("_p")
            if p not in (None, "") and str(p) in nodes and str(p) != n["name"]:
                nodes[str(p)]["children"].append(n)
            else:
                roots.append(n)

        def clean(n: dict) -> dict:
            if not n["children"]:
                n.pop("children")
            else:
                n["children"] = [clean(c) for c in n["children"]]
            return n
        roots = [clean(n) for n in roots]
        return roots, _depth(roots)
    levels = spec.levels or [c for c in dims(spec.cols)]
    vcol = (spec.ys or [c for c in measures(spec.cols)] or [None])[0]
    if not levels:
        raise SpecError("hierarchy: needs at least one text column (one level)",
                        example=[{"région": "Nord", "ville": "Lille", "ventes": 120}])
    if len(levels) > 1 and not spec.levels:
        spec.notes.fix("levels: " + " > ".join(c.name for c in levels))
    nodes = _nest(spec, levels, vcol)
    return nodes, len(levels)


def _depth(nodes: list[dict]) -> int:
    return 1 + max((_depth(n.get("children", [])) for n in nodes if n.get("children")), default=0) \
        if nodes else 0


def c_treemap(spec: Spec) -> tuple[dict, str]:
    nodes, depth = _tree_from_rows(spec)
    o = _base(spec)
    total = sum(n.get("value", 0) or 0 for n in nodes)
    if spec.kind == "treemap":
        o["series"] = [{
            "type": "treemap", "data": nodes, "roam": False, "nodeClick": "zoomToNode",
            "top": 64 if o.get("title") else 10, "bottom": 34, "left": 4, "right": 4,
            "breadcrumb": {"show": depth > 1, "bottom": 4, "itemStyle": {"color": "@track",
                                                                          "textStyle": {"color": "@ink"}}},
            "label": {"show": True, "formatter": "{b}", "fontSize": 12},
            "upperLabel": {"show": depth > 1, "height": 20, "color": "#ffffff"},
            "itemStyle": {"borderColor": "@surface", "borderWidth": 2, "gapWidth": 2},
            "levels": [{"itemStyle": {"borderColor": "@surface", "borderWidth": 3, "gapWidth": 3}},
                       {"colorSaturation": [0.35, 0.6],
                        "itemStyle": {"borderColorSaturation": 0.65, "gapWidth": 1, "borderWidth": 1}}],
        }]
    else:
        o["series"] = [{
            "type": "sunburst", "data": nodes, "radius": ["12%", "92%"],
            "center": ["50%", "55%"], "sort": None, "nodeClick": "rootToNode",
            "emphasis": {"focus": "ancestor"},
            "itemStyle": {"borderColor": "@surface", "borderWidth": 2},
            "label": {"rotate": "radial", "minAngle": 8, "fontSize": 11, "color": "#ffffff"},
            "levels": [{}, {"r0": "12%", "r": "45%"}, {"r0": "45%", "r": "72%"},
                       {"r0": "72%", "r": "92%", "label": {"position": "outside", "color": "@ink2",
                                                           "rotate": "tangential"}}][:depth + 1],
        }]
    o["tooltip"] = {"trigger": "item"}
    return o, f"{spec.kind} · {len(nodes)} groups · {depth} level(s) · total {fr(total, spec.opts['unit'])}"


def c_tree(spec: Spec) -> tuple[dict, str]:
    nodes, depth = _tree_from_rows(spec)
    root = nodes[0] if len(nodes) == 1 else {"name": spec.opts["title"] or "Racine", "children": nodes}

    def count(n: dict) -> int:
        return 1 + sum(count(c) for c in n.get("children", []))
    n = count(root)
    o = _base(spec)
    orient = "LR"
    o["series"] = [{
        "type": "tree", "data": [root], "orient": orient, "roam": True,
        "top": 60 if o.get("title") else 30, "bottom": 30, "left": 90 if orient == "LR" else 20,
        "right": 160 if orient == "LR" else 20,
        "symbol": "circle", "symbolSize": 9, "initialTreeDepth": 3, "expandAndCollapse": True,
        "itemStyle": {"color": "@series1", "borderColor": "@series1"},
        "lineStyle": {"color": "@grid", "width": 1.5, "curveness": 0.5},
        "label": {"position": "left" if orient == "LR" else "top", "verticalAlign": "middle",
                  "align": "right" if orient == "LR" else "center", "fontSize": 12, "color": "@ink"},
        "leaves": {"label": {"position": "right" if orient == "LR" else "bottom",
                             "align": "left" if orient == "LR" else "center"}},
        "animationDurationUpdate": 500,
    }]
    o["tooltip"] = {"trigger": "item", "triggerOn": "mousemove"}
    return o, f"tree · {n} nodes · depth {depth}"


# ── Flux et réseaux ──────────────────────────────────────────────────────


def _edges(spec: Spec) -> tuple[list[tuple[str, str, float]], str, str]:
    cols = spec.cols
    d = dims(cols)
    src = by_name(cols, "source", ("text", "date")) or (spec.x if spec.x in d else None) or \
        (d[0] if d else None)
    tgt = by_name(cols, "target", ("text", "date")) or next((c for c in d if c is not src), None)
    if src is None or tgt is None or src is tgt:
        raise SpecError(
            f"{spec.kind}: needs two name columns (source, target); columns received: "
            f"{', '.join(c.name for c in cols)}",
            fix="one row per link: source, target, value",
            example=[{"source": "Budget", "target": "Salaires", "value": 60},
                     {"source": "Budget", "target": "Locaux", "value": 25}])
    vcol = (spec.ys or measures(cols) or [None])[0]
    agg: "OrderedDict[tuple[str, str], float]" = OrderedDict()
    self_loops = 0
    for r in spec.rows:
        a, b = r.get(src.name), r.get(tgt.name)
        if a in (None, "") or b in (None, ""):
            continue
        a, b = str(a), str(b)
        if a == b:
            self_loops += 1
            continue
        v = num(r.get(vcol.name)) if vcol else 1.0
        if v is None or v <= 0:
            continue
        agg[(a, b)] = agg.get((a, b), 0) + v
    if self_loops:
        spec.notes.warn(f"{self_loops} self-link(s) ignored")
    return [(a, b, v) for (a, b), v in agg.items()], src.name, tgt.name


def _has_cycle(edges: list[tuple[str, str, float]]) -> bool:
    g = defaultdict(list)
    for a, b, _ in edges:
        g[a].append(b)
    state: dict[str, int] = {}

    def visit(n: str) -> bool:
        state[n] = 1
        for m in g[n]:
            if state.get(m) == 1 or (state.get(m) is None and visit(m)):
                return True
        state[n] = 2
        return False
    return any(state.get(n) is None and visit(n) for n in list(g))


def c_sankey(spec: Spec) -> tuple[dict, str]:
    edges, s, t = _edges(spec)
    if _has_cycle(edges):
        spec.notes.fix("the flows form a loop (A -> B -> A): impossible in a sankey, drawn as a network")
        spec.kind = "graph"
        return c_graph(spec)
    nodes = list(OrderedDict.fromkeys([e[0] for e in edges] + [e[1] for e in edges]))
    o = _base(spec)
    o["series"] = [{
        "type": "sankey", "data": [{"name": n} for n in nodes],
        "links": [{"source": a, "target": b, "value": v} for a, b, v in edges],
        "top": 60 if o.get("title") else 16, "bottom": 16, "left": 8, "right": 110,
        "nodeWidth": 14, "nodeGap": 12, "layoutIterations": 64, "draggable": True,
        "emphasis": {"focus": "adjacency"},
        "lineStyle": {"color": "gradient", "curveness": 0.5, "opacity": 0.32},
        "itemStyle": {"borderWidth": 0, "borderRadius": 2},
        "label": {"color": "@ink", "fontSize": 12},
    }]
    o["tooltip"] = {"trigger": "item"}
    total_out = defaultdict(float)
    for a, _, v in edges:
        total_out[a] += v
    return o, f"sankey · {len(nodes)} nodes · {len(edges)} flows · {s} -> {t}"


def c_chord(spec: Spec) -> tuple[dict, str]:
    edges, s, t = _edges(spec)
    nodes = list(OrderedDict.fromkeys([e[0] for e in edges] + [e[1] for e in edges]))
    o = _base(spec)
    o["series"] = [{
        "type": "chord", "data": [{"name": n} for n in nodes],
        "links": [{"source": a, "target": b, "value": v} for a, b, v in edges],
        "center": ["50%", "55%"], "radius": ["70%", "80%"], "padAngle": 3, "minAngle": 6,
        "clockwise": True, "lineStyle": {"color": "gradient", "opacity": 0.45},
        "itemStyle": {"borderColor": "@surface", "borderWidth": 1},
        "emphasis": {"focus": "adjacency"},
        "label": {"show": True, "color": "@ink", "fontSize": 12, "distance": 6},
    }]
    o["tooltip"] = {"trigger": "item"}
    return o, f"chord · {len(nodes)} nodes · {len(edges)} links"


def c_graph(spec: Spec) -> tuple[dict, str]:
    edges, s, t = _edges(spec)
    deg: dict[str, float] = defaultdict(float)
    for a, b, _v in edges:
        deg[a] += 1
        deg[b] += 1
    nodes = list(OrderedDict.fromkeys([e[0] for e in edges] + [e[1] for e in edges]))
    cat_of: dict[str, str] = {}
    cats: list[str] = []
    if spec.group is not None:
        src_col = by_name(spec.cols, "source", ("text", "date")) or dims(spec.cols)[0]
        tgt_col = by_name(spec.cols, "target", ("text", "date")) or next(
            (c for c in dims(spec.cols) if c is not src_col and c is not spec.group), None)
        for col in (src_col, tgt_col):
            for r in spec.rows:
                g = r.get(spec.group.name)
                if col is not None and g not in (None, ""):
                    cat_of.setdefault(str(r.get(col.name)), str(g))
        cats = list(OrderedDict.fromkeys(cat_of.values()))[:MAX_SERIES]
    mx = max(deg.values(), default=1)
    vmax = max((v for *_, v in edges), default=1)
    o = _base(spec)
    data = []
    for n in nodes:
        it: dict[str, Any] = {"name": n, "symbolSize": round(10 + 26 * math.sqrt(deg[n] / mx), 1),
                              "value": deg[n]}
        if cats:
            it["category"] = cats.index(cat_of[n]) if cat_of.get(n) in cats else len(cats)
        data.append(it)
    ser: dict[str, Any] = {
        "type": "graph", "layout": "force", "data": data,
        "links": [{"source": a, "target": b, "value": v,
                   "lineStyle": {"width": round(1 + 4 * v / vmax, 2)}} for a, b, v in edges],
        "roam": True, "draggable": True,
        "force": {"repulsion": 220, "edgeLength": [40, 110], "gravity": 0.16},
        "edgeSymbol": ["none", "arrow"], "edgeSymbolSize": 6,
        "label": {"show": len(nodes) <= 60, "position": "right", "fontSize": 11, "color": "@ink"},
        "lineStyle": {"color": "source", "opacity": 0.45, "curveness": 0.12},
        "emphasis": {"focus": "adjacency", "lineStyle": {"width": 3, "opacity": 0.9}},
        "top": 60 if o.get("title") else 20,
    }
    if cats:
        ser["categories"] = [{"name": c} for c in cats] + (
            [{"name": "autre", "itemStyle": {"color": "@muted"}}]
            if any("category" in d and d["category"] == len(cats) for d in data) else [])
        _legend(o, len(cats), force=True)
    o["series"] = [ser]
    o["tooltip"] = {"trigger": "item"}
    hubs = sorted(deg.items(), key=lambda kv: -kv[1])[:3]
    return o, f"graph · {len(nodes)} nodes · {len(edges)} links · most connected: " + \
        ", ".join(f"{k} ({int(v)})" for k, v in hubs)


# ── Distributions et relations ───────────────────────────────────────────


def c_scatter(spec: Spec) -> tuple[dict, str]:
    cols = spec.cols
    m = measures(cols)
    xs = spec.x if spec.x is not None else None
    ys = spec.ys[0] if spec.ys else None
    pool = [c for c in m if c not in (xs, ys, spec.size)]
    if xs is None:
        xs = pool.pop(0) if pool else None
    if ys is None:
        ys = pool.pop(0) if pool else None
    if xs is None or ys is None:
        raise SpecError(
            f"{spec.kind} : il faut deux colonnes numériques (x et y) — colonnes : "
            f"{', '.join(repr(c) for c in cols)}",
            example=[{"surface": 45, "prix": 210000}, {"surface": 70, "prix": 305000}])
    size = spec.size
    if spec.kind == "bubble" and size is None:
        size = pool.pop(0) if pool else None
        if size is None:
            spec.notes.warn("bubble without a third measure: equal sizes")
    d = [c for c in dims(cols)]
    group = spec.group
    if group is None and d:
        cand = d[0]
        n_unique = len({r.get(cand.name) for r in spec.rows})
        if n_unique <= MAX_SERIES and n_unique < len(spec.rows):
            group = cand
            spec.notes.fix(f"colour by '{group.name}'")
    name_col = next((c for c in d if c is not group and
                     len({r.get(c.name) for r in spec.rows}) == len(spec.rows)), None)
    x_is_date = xs.kind == "date"
    groups: "OrderedDict[str, list]" = OrderedDict()
    smax = max((num(r.get(size.name)) or 0 for r in spec.rows), default=1) if size else 1
    for r in spec.rows:
        gx = r.get(xs.name)
        xv = to_date(gx) if x_is_date else num(gx)
        yv = num(r.get(ys.name))
        if xv is None or yv is None:
            continue
        g = str(r.get(group.name)) if group else ys.name
        it: dict[str, Any] = {"value": [xv, yv]}
        if size:
            sv = num(r.get(size.name)) or 0
            it["value"].append(sv)
            it["symbolSize"] = round(8 + 40 * math.sqrt(max(sv, 0) / smax), 1) if smax else 10
        if name_col:
            it["name"] = str(r.get(name_col.name))
        groups.setdefault(g, []).append(it)
    if len(groups) > MAX_SERIES:
        keys = list(groups)
        rest = keys[MAX_SERIES - 1:]
        merged = [p for k in rest for p in groups.pop(k)]
        groups[OTHER] = merged
        spec.notes.fix(f"{len(rest)} groups folded into '{OTHER}'")
    o = _base(spec)
    series = []
    for g, pts in groups.items():
        ser: dict[str, Any] = {"type": "scatter", "name": g, "data": pts,
                               "symbolSize": 9, "emphasis": {"focus": "series"},
                               "itemStyle": {"opacity": 0.8 if spec.kind == "scatter" else 0.6,
                                             "borderColor": "@surface", "borderWidth": 1}}
        if g == OTHER:
            ser["itemStyle"]["color"] = "@muted"
        series.append(ser)
    if spec.opts["trend"] and not x_is_date:
        allp = [p["value"] for pts in groups.values() for p in pts]
        reg = _regression([p[0] for p in allp], [p[1] for p in allp])
        if reg:
            a, b, r2 = reg
            x0, x1 = min(p[0] for p in allp), max(p[0] for p in allp)
            series.append({"type": "line", "name": f"Tendance (R² = {r2:.2f})", "symbol": "none",
                           "data": [[x0, a * x0 + b], [x1, a * x1 + b]],
                           "lineStyle": {"type": "dashed", "width": 1.5, "color": "@ink2"},
                           "itemStyle": {"color": "@ink2"}, "tooltip": {"show": False}, "silent": True})
            spec.notes.fix(f"trend: y = {a:.3g}*x + {b:.3g} (R² = {r2:.2f})")
    ml = _mark_lines(spec, "yAxis")
    if ml:
        series[0]["markLine"] = ml
    o["series"] = series
    o["xAxis"] = {"type": "time" if x_is_date else "value", "scale": True, "name": xs.name,
                  "nameLocation": "middle", "nameGap": 26, "_fmt": not x_is_date,
                  "splitLine": {"show": True}}
    o["yAxis"] = {"type": "value", "scale": True, "name": ys.name, "_fmt": True}
    o["tooltip"] = {"trigger": "item"}
    o["_elpis"]["axes"] = [xs.name, ys.name] + ([size.name] if size else [])
    _legend(o, len(series))
    _grid(o, 40)
    n = sum(len(p) for p in groups.values())
    return o, f"{spec.kind} · {n} points · x={xs.name} · y={ys.name}" + \
        (f" · taille={size.name}" if size else "") + (f" · couleur={group.name}" if group else "")


def _split_dim(vals: list) -> tuple[list[str], list[str], str] | None:
    """« Lundi matin », « Lundi après-midi »… → (jours, créneaux) si cela forme une grille."""
    for sep in (" × ", " x ", " / ", " - ", " – ", ", ", " "):
        parts = [str(v).split(sep, 1) if v is not None and sep in str(v) else None for v in vals]
        if not all(p and p[0].strip() and p[1].strip() for p in parts):
            continue
        a = [p[0].strip() for p in parts]  # type: ignore[index]
        b = [p[1].strip() for p in parts]  # type: ignore[index]
        na, nb = len(set(a)), len(set(b))
        if na >= 2 and nb >= 2 and len(set(zip(a, b))) == len(vals) and na * nb <= 2 * len(vals):
            return a, b, sep
    return None


def c_heatmap(spec: Spec) -> tuple[dict, str]:
    cols, rows = spec.cols, spec.rows
    d, m = dims(cols), measures(cols)
    xcol = spec.x if spec.x in d else None
    ycol = None
    vcol = None
    for c in spec.ys:
        if c in d and ycol is None:
            ycol = c
        elif c in m and vcol is None:
            vcol = c
    rest_d = [c for c in d if c not in (xcol, ycol)]
    xcol = xcol or (rest_d.pop(0) if rest_d else None)
    ycol = ycol or (rest_d.pop(0) if rest_d else None)
    vcol = vcol or (m[0] if m else None)
    cells: list[tuple[str, str, float | None]] = []
    if xcol is not None and ycol is None and len(m) >= 2:
        # Format large : une ligne par x, une colonne numérique par y
        vs = spec.ys if all(c in m for c in spec.ys) and spec.ys else m
        for r in rows:
            for c in vs:
                cells.append((_label(r.get(xcol.name)), c.name, num(r.get(c.name))))
        spec.notes.fix("wide format: one numeric column per heatmap row")
    elif xcol is not None and ycol is None and xcol.kind == "date":
        spec.kind = "calendar"
        spec.notes.fix("a single date column: calendar instead of a heatmap")
        return c_calendar(spec)
    elif xcol is not None and ycol is None and vcol is not None and \
            _split_dim([r.get(xcol.name) for r in rows]) is not None:
        a, b, sep = _split_dim([r.get(xcol.name) for r in rows])  # type: ignore[misc]
        for r, aa, bb in zip(rows, a, b):
            cells.append((aa, bb, num(r.get(vcol.name))))
        spec.notes.fix(f"'{xcol.name}' held both dimensions ('{rows[0].get(xcol.name)}'): "
                       "split into rows x columns")
    elif xcol is None or ycol is None or vcol is None:
        raise SpecError(
            "heatmap: needs two category columns (x, y) and a value; received: "
            + ", ".join(repr(c) for c in cols),
            fix="one row per cell: row name, column name and value (NAMES, not indexes)",
            example=[{"jour": "lun.", "heure": "9 h", "appels": 12},
                     {"jour": "lun.", "heure": "10 h", "appels": 18}])
    else:
        for r in rows:
            cells.append((_label(r.get(xcol.name)), _label(r.get(ycol.name)), num(r.get(vcol.name))))
    xs = list(OrderedDict.fromkeys(c[0] for c in cells))
    ys = list(OrderedDict.fromkeys(c[1] for c in cells))
    vals = [c[2] for c in cells if c[2] is not None]
    if not vals:
        raise SpecError("heatmap: no numeric value")
    lo, hi = min(vals), max(vals)
    o = _base(spec)
    diverging = lo < 0 < hi
    o["visualMap"] = {"min": -max(abs(lo), hi) if diverging else lo,
                      "max": max(abs(lo), hi) if diverging else hi,
                      "calculable": True, "orient": "horizontal",
                      "left": "center", "bottom": 2, "itemWidth": 12, "itemHeight": 160,
                      "inRange": {"color": "@div" if diverging else "@seq"},
                      "textStyle": {"color": "@ink2"}}
    o["xAxis"] = {"type": "category", "data": xs, "splitArea": {"show": False},
                  "axisTick": {"show": False}, "axisLine": {"show": False}}
    o["yAxis"] = {"type": "category", "data": ys, "inverse": True,
                  "axisTick": {"show": False}, "axisLine": {"show": False}}
    vmin_, vmax_ = o["visualMap"]["min"], o["visualMap"]["max"]

    def cell(a: str, b: str, v: float | None) -> Any:
        """Couleur du texte selon la case : jeton résolu par thème (la rampe
        s'inverse en sombre, le jeton aussi)."""
        if v is None:
            return [xs.index(a), ys.index(b), "-"]
        r = (v - vmin_) / (vmax_ - vmin_) if vmax_ > vmin_ else 0.5
        strong = abs(r - 0.5) > 0.3 if diverging else r > 0.55
        return {"value": [xs.index(a), ys.index(b), v], "name": f"{a} · {b} : {fr(v, spec.opts['unit'])}",
                "label": {"color": "@onhi" if strong else "@onlo"}}
    o["series"] = [{"type": "heatmap", "data": [cell(a, b, v) for a, b, v in cells],
                    "label": {"show": len(cells) <= 120, "fontSize": 10},
                    "_lbl": {"v": 2},
                    "itemStyle": {"borderColor": "@surface", "borderWidth": 2, "borderRadius": 3},
                    "emphasis": {"itemStyle": {"borderColor": "@ink", "borderWidth": 1}},
                    "tooltip": {"formatter": "{b}"}}]
    o["tooltip"] = {"trigger": "item"}
    _grid(o, 64)
    hot = max(cells, key=lambda c: c[2] if c[2] is not None else -math.inf)
    return o, f"heatmap · {len(xs)}x{len(ys)} cells · max {fr(hot[2], spec.opts['unit'])} ({hot[0]}, {hot[1]})"


def c_calendar(spec: Spec) -> tuple[dict, str]:
    dcol = spec.x if spec.x is not None and spec.x.kind == "date" else \
        next((c for c in spec.cols if c.kind == "date"), None)
    vcol = (spec.ys or measures(spec.cols) or [None])[0]
    if dcol is None or vcol is None:
        raise SpecError("calendar: needs a date column (YYYY-MM-DD) and a value",
                        example=[{"date": "2026-01-05", "visites": 34}])
    pts = {}
    for r in spec.rows:
        d = to_date(r.get(dcol.name))
        v = num(r.get(vcol.name))
        if d and v is not None:
            d = d[:10]
            pts[d] = pts.get(d, 0) + v
    years = sorted({d[:4] for d in pts})[:3]
    o = _base(spec)
    o["calendar"] = []
    o["series"] = []
    top = 70 if o.get("title") else 40
    for i, y in enumerate(years):
        o["calendar"].append({
            "range": y, "top": top + i * 150, "left": 36, "right": 12, "cellSize": ["auto", 15],
            "splitLine": {"show": False}, "itemStyle": {"borderColor": "@surface", "borderWidth": 2,
                                                        "color": "@track"},
            "yearLabel": {"show": len(years) > 1, "color": "@ink2"},
            "dayLabel": {"firstDay": 1, "nameMap": ["D", "L", "M", "M", "J", "V", "S"],
                         "color": "@ink2", "fontSize": 10},
            "monthLabel": {"nameMap": MONTHS_FR, "color": "@ink2", "fontSize": 11}})
        o["series"].append({"type": "heatmap", "coordinateSystem": "calendar", "calendarIndex": i,
                            "tooltip": {"formatter": "{b}"},
                            "data": [{"value": [d, v], "name": f"{int(d[8:])} {MONTHS_FR[int(d[5:7]) - 1]} "
                                      f"{d[:4]} : {fr(v, spec.opts['unit'])}"}
                                     for d, v in sorted(pts.items()) if d.startswith(y)]})
    vals = list(pts.values())
    o["visualMap"] = {"min": min(vals), "max": max(vals), "calculable": False, "orient": "horizontal",
                      "left": "center", "top": top + len(years) * 150 - 24, "itemWidth": 12,
                      "itemHeight": 140, "inRange": {"color": "@seq"}, "textStyle": {"color": "@ink2"}}
    o["tooltip"] = {"trigger": "item"}
    o["_elpis"]["height"] = top + len(years) * 150 + 20
    best = max(pts.items(), key=lambda kv: kv[1])
    return o, f"calendar · {len(pts)} days · {', '.join(years)} · max {fr(best[1], spec.opts['unit'])} on {best[0]}"


def _quartiles(xs: list[float]) -> tuple[float, float, float, float, float, list[float]]:
    xs = sorted(xs)
    if len(xs) == 1:
        v = xs[0]
        return v, v, v, v, v, []
    q1, med, q3 = statistics.quantiles(xs, n=4, method="inclusive")
    iqr = q3 - q1
    lo_f, hi_f = q1 - 1.5 * iqr, q3 + 1.5 * iqr
    inside = [v for v in xs if lo_f <= v <= hi_f]
    out = [v for v in xs if v < lo_f or v > hi_f]
    return min(inside), q1, med, q3, max(inside), out


def c_boxplot(spec: Spec) -> tuple[dict, str]:
    cols = spec.cols
    pre = {k: by_name(cols, k, ("number",)) for k in ("min_", "q1", "median", "q3")}
    mxc = by_name(cols, "max", ("number",))
    d, m = dims(cols), measures(cols)
    groups: "OrderedDict[str, list[float]]" = OrderedDict()
    boxes: list[list[float]] = []
    outliers: list[list[Any]] = []
    raw_pts: list[list[Any]] = []
    if all(pre.values()) and mxc:
        g = d[0] if d else None
        names = []
        for i, r in enumerate(spec.rows):
            names.append(_label(r.get(g.name)) if g else f"#{i + 1}")
            boxes.append([num(r.get(c.name)) for c in (pre["min_"], pre["q1"], pre["median"],
                                                        pre["q3"], mxc)])  # type: ignore[union-attr]
        spec.notes.fix("precomputed quartiles used as given")
    else:
        g = spec.group or spec.x or (d[0] if d else None)
        vcols = [c for c in (spec.ys or m)]
        if g is not None and vcols:
            for r in spec.rows:
                v = num(r.get(vcols[0].name))
                if v is not None:
                    groups.setdefault(_label(r.get(g.name)), []).append(v)
        elif len(vcols) >= 1:
            for c in vcols:
                groups[c.name] = [v for v in (num(r.get(c.name)) for r in spec.rows) if v is not None]
            if len(vcols) > 1:
                spec.notes.fix("one box per numeric column")
        if not groups:
            raise SpecError("boxplot: needs raw values (one row per measurement)",
                            example=[{"équipe": "A", "délai": 3.2}, {"équipe": "A", "délai": 4.1},
                                     {"équipe": "B", "délai": 2.7}])
        names = list(groups)
        for gi, xs in enumerate(groups.values()):
            lo, q1, med, q3, hi, out = _quartiles(xs)
            boxes.append([round(v, 4) for v in (lo, q1, med, q3, hi)])
            outliers += [[gi, v] for v in out]
            if len(xs) <= 60:
                raw_pts += [[gi, v] for v in xs]
    o = _base(spec)
    o["xAxis"] = {"type": "category", "data": names, "axisTick": {"show": False},
                  "name": (spec.group or spec.x or (d[0] if d else None)).name if (spec.group or spec.x or d) else ""}
    o["yAxis"] = {"type": "value", "scale": True, "_fmt": True,
                  "name": (spec.ys or m or [None])[0].name if (spec.ys or m) else ""}
    o["series"] = [{"type": "boxplot", "name": "Distribution", "data": boxes, "boxWidth": [12, 46],
                    "itemStyle": {"color": "@series1a", "borderColor": "@series1", "borderWidth": 1.5}}]
    if raw_pts:
        o["series"].append({"type": "scatter", "name": "Valeurs", "data": raw_pts, "symbolSize": 5,
                            "itemStyle": {"color": "@ink2", "opacity": 0.35}, "z": 3})
        o["xAxis"]["jitter"] = 22
        o["xAxis"]["jitterOverlap"] = False
    if outliers:
        o["series"].append({"type": "scatter", "name": "Valeurs atypiques", "data": outliers,
                            "symbolSize": 7, "itemStyle": {"color": "@down"}, "z": 4})
    ml = _mark_lines(spec, "yAxis")
    if ml:
        o["series"][0]["markLine"] = ml
    o["tooltip"] = {"trigger": "item"}
    _legend(o, len(o["series"]))
    _grid(o, 36)
    return o, f"boxplot · {len(names)} groups · medians: " + \
        ", ".join(f"{n} {fr(b[2], spec.opts['unit'])}" for n, b in list(zip(names, boxes))[:4])


def c_histogram(spec: Spec) -> tuple[dict, str]:
    m = measures(spec.cols)
    vcol = (spec.ys or m or [None])[0]
    if vcol is None:
        raise SpecError("histogram: needs a column of raw values",
                        example=[{"âge": 34}, {"âge": 41}, {"âge": 29}])
    group = spec.group
    groups: "OrderedDict[str, list[float]]" = OrderedDict()
    for r in spec.rows:
        v = num(r.get(vcol.name))
        if v is not None:
            groups.setdefault(str(r.get(group.name)) if group else vcol.name, []).append(v)
    allv = sorted(v for vs in groups.values() for v in vs)
    if len(allv) < 2:
        raise SpecError("histogram: at least 2 values")
    q1, _, q3 = statistics.quantiles(allv, n=4)
    iqr = q3 - q1
    lo, hi = allv[0], allv[-1]
    width = 2 * iqr / (len(allv) ** (1 / 3)) if iqr > 0 else (hi - lo) / max(1, math.ceil(math.log2(len(allv)) + 1))
    nb = max(5, min(40, math.ceil((hi - lo) / width))) if width > 0 else 1
    step = (hi - lo) / nb if nb and hi > lo else 1
    # Pas « rond » pour des bornes lisibles
    mag = 10 ** math.floor(math.log10(step)) if step > 0 else 1
    step = min((mag * k for k in (1, 2, 2.5, 5, 10) if mag * k >= step), default=step)
    start = math.floor(lo / step) * step
    nb = max(1, math.ceil((hi - start) / step + 1e-9))
    if start + nb * step <= hi:
        nb += 1
    edges = [start + i * step for i in range(nb + 1)]
    labels = [f"{fr(edges[i], digits=2)} – {fr(edges[i + 1], digits=2)}" for i in range(nb)]
    o = _base(spec)
    series = []
    for g, vs in groups.items():
        counts = [0] * nb
        for v in vs:
            i = min(nb - 1, int((v - start) // step))
            counts[i] += 1
        series.append({"type": "bar", "name": g, "data": counts, "barCategoryGap": "4%",
                       "barGap": "0%", "itemStyle": {"borderRadius": [3, 3, 0, 0]},
                       "emphasis": {"focus": "series"}})
    o["series"] = series
    o["xAxis"] = {"type": "category", "data": labels, "name": vcol.name, "nameLocation": "middle",
                  "nameGap": 28, "axisTick": {"show": False}, "axisLabel": {"hideOverlap": True}}
    o["yAxis"] = {"type": "value", "name": "effectif", "minInterval": 1}
    o["tooltip"] = {"trigger": "axis", "axisPointer": {"type": "shadow"}}
    mean = statistics.fmean(allv)
    med = statistics.median(allv)
    o["_elpis"]["unit"] = ""
    _legend(o, len(series))
    _grid(o, 44)
    return o, (f"histogram · {len(allv)} values · {nb} bins of {fr(step)} · "
               f"mean {fr(mean, spec.opts['unit'])} · median {fr(med, spec.opts['unit'])}")


def c_candlestick(spec: Spec) -> tuple[dict, str]:
    cols = spec.cols
    o_, h_, l_, c_ = (by_name(cols, k, ("number",)) for k in ("open", "high", "low", "close"))
    m = measures(cols)
    if not all((o_, h_, l_, c_)):
        if len(m) == 4:
            o_, h_, l_, c_ = m
            spec.notes.warn("OHLC columns not named: order assumed open, high, low, close")
        else:
            raise SpecError(
                "candlestick: needs open, high, low, close columns",
                example=[{"date": "2026-03-02", "open": 101.2, "high": 104.0, "low": 100.5,
                          "close": 103.1}])
    xcol = spec.x or next((c for c in cols if c.kind == "date"), None) or (dims(cols) or [None])[0]
    rows = spec.rows
    if xcol is not None and xcol.kind == "date":
        rows = sorted(rows, key=lambda r: to_date(r.get(xcol.name)) or "")
    cats = [_label(r.get(xcol.name)) if xcol else f"#{i + 1}" for i, r in enumerate(rows)]
    data, bad = [], 0
    for r in rows:
        ov, hv, lv, cv = (num(r.get(c.name)) for c in (o_, h_, l_, c_))  # type: ignore[union-attr]
        if None in (ov, hv, lv, cv):
            data.append("-")
            continue
        if not (lv <= min(ov, cv) and hv >= max(ov, cv)):  # type: ignore[operator]
            bad += 1
            lv, hv = min(ov, cv, lv), max(ov, cv, hv)  # type: ignore[type-var]
        data.append([ov, cv, lv, hv])
    if bad:
        spec.notes.warn(f"{bad} inconsistent candle(s) (low above open/close...): range widened")
    o = _base(spec)
    o["xAxis"] = {"type": "category", "data": cats, "boundaryGap": True, "axisTick": {"show": False}}
    o["yAxis"] = {"type": "value", "scale": True, "_fmt": True}
    o["series"] = [{"type": "candlestick", "name": spec.opts["title"] or "Cours", "data": data,
                    "barMaxWidth": 14,
                    "itemStyle": {"color": "@surface", "borderColor": "@gain",
                                  "color0": "@loss", "borderColor0": "@loss", "borderWidth": 1.5}}]
    if spec.opts["trend"]:
        closes = [d[1] if isinstance(d, list) else None for d in data]
        ma = []
        for i in range(len(closes)):
            win = [v for v in closes[max(0, i - 4): i + 1] if v is not None]
            ma.append(round(sum(win) / len(win), 4) if len(win) == 5 else "-")
        o["series"].append({"type": "line", "name": "Moyenne mobile 5", "data": ma, "symbol": "none",
                            "smooth": True, "lineStyle": {"width": 1.5, "color": "@series1"}})
        spec.notes.fix("trend on prices: 5-period moving average")
    o["tooltip"] = {"trigger": "axis", "axisPointer": {"type": "cross"}}
    _legend(o, len(o["series"]))
    _grid(o, _zoom(o, len(cats), "x", 40))
    first = next((d for d in data if isinstance(d, list)), None)
    last = next((d for d in reversed(data) if isinstance(d, list)), None)
    var = f"{100 * (last[1] - first[0]) / first[0]:+.1f} %" if first and last and first[0] else "—"
    return o, f"candlestick · {len(cats)} periods · change {var}"


_TOTAL_NAMES = {"total", "solde", "resultat", "net", "final", "cloture", "fin", "ending",
                "solde_final", "resultat_net", "total_general", "realise", "reel", "arrivee",
                "sous_total", "subtotal", "budget_final", "montant_final"}
_START_WORDS = ("initial", "depart", "debut", "ouverture", "solde_initial", "report", "base")
_DELTA_NAMES = {"variation", "ecart", "delta", "variance", "montant", "impact", "mouvement",
                "flux", "change", "diff", "difference", "evolution", "effet", "contribution"}
_KIND_COL_NAMES = {"type", "nature", "kind", "role", "sens", "categorie_ligne", "genre"}
_LEVEL_VALUES = {"base", "total", "sous_total", "subtotal", "solde", "initial", "depart", "debut",
                 "fin", "final", "realise", "cloture", "start", "end", "niveau", "level", "absolute"}


def _waterfall_columns(spec: Spec) -> None:
    """Choisit la colonne d'ÉCARTS : un modèle envoie souvent écarts ET cumuls.

    Si une colonne est le cumul d'une autre (à une ligne près : la dernière est
    souvent un « total » approximatif), on trace les écarts et les lignes de
    niveau (départ, total) prennent leur valeur dans les cumuls."""
    m = measures(spec.cols)
    named = next((c for c in m if fold(c.name) in _DELTA_NAMES), None)
    cand = spec.ys[0] if spec.ys else (named or (m[0] if m else None))
    if cand is None:
        return
    vals = {c.name: [num(r.get(c.name)) for r in spec.rows] for c in m}

    def cumule(cum: list, d: list) -> bool:
        pas = list(zip(cum[1:], cum[:-1], d[1:]))
        bons = sum(1 for a, b, c in pas if None not in (a, b, c)
                   and abs(a - (b + c)) <= max(0.01, 0.005 * abs(a)))
        return len(pas) >= 2 and bons >= len(pas) - 1 and bons >= 2

    for a, b in ((cand, o) for o in m if o is not cand):
        if cumule(vals[a.name], vals[b.name]):            # cand = cumuls, b = écarts
            spec.notes.fix(f"'{a.name}' is a running total: steps read from '{b.name}'")
            delta, cum = b, a
            break
        if cumule(vals[b.name], vals[a.name]):            # cand = écarts, b = cumuls
            delta, cum = a, b
            break
    else:
        spec.ys = [cand]
        return
    spec.ys = [delta]
    spec.opts["_wf_cum"] = vals[cum.name]


def _is_level(spec: Spec, label: str, idx: int, n: int, v: float, running: float) -> bool:
    f = fold(label)
    kc = next((c for c in dims(spec.cols) if fold(c.name) in _KIND_COL_NAMES), None)
    if kc is not None and spec.x is not None and kc is not spec.x:
        row = next((r for r in spec.rows if _label(r.get(spec.x.name)) == label), None)
        if row is not None and fold(row.get(kc.name)) in _LEVEL_VALUES:
            return True
    if f in _TOTAL_NAMES or f.startswith(("total", "solde", "resultat", "sous_total")):
        return True
    if idx == 0 and any(w in f for w in _START_WORDS):
        return True
    # Dernière ligne égale au cumul : c'est un total, pas un écart
    return idx == n - 1 and idx > 1 and abs(v - running) <= max(0.01, 0.005 * abs(running))


def c_waterfall(spec: Spec) -> tuple[dict, str]:
    _waterfall_columns(spec)
    if spec.x is None:
        d = [c for c in dims(spec.cols) if fold(c.name) not in _KIND_COL_NAMES]
        spec.x = d[0] if d else None
    cats, series, _, _ = cartesian(spec, multi=False)
    vals = series[0]["data"]
    unit = spec.opts["unit"]
    base, up, down, tot = [], [], [], []
    running = 0.0
    totals = 0
    cum = spec.opts.get("_wf_cum")
    cum_of = {}
    if cum is not None and spec.x is not None:
        cum_of = {_label(r.get(spec.x.name)): v for r, v in zip(spec.rows, cum)}
    for i, (c, v) in enumerate(zip(cats, vals)):
        v = v or 0
        level = _is_level(spec, c, i, len(cats), v, running) or (i == 0 and cum is not None and v == 0)
        if level and cum_of.get(c) is not None:
            v = cum_of[c]                                  # niveau : valeur du cumul
        if level and i > 0 and abs(v - running) > max(0.01, 0.005 * abs(running)):
            spec.notes.warn(f"'{c}' = {fr(v, unit)} but the steps add up to "
                            f"{fr(running, unit)}: check the data")
        if level:
            base.append("-"); up.append("-"); down.append("-")
            tot.append({"value": v, "label": {"formatter": fr(v, unit)}})
            running = v
            totals += 1 if i == len(cats) - 1 or i > 0 else 0
            continue
        lo = min(running, running + v)
        base.append(round(lo, 6))
        if v >= 0:
            up.append({"value": v, "label": {"formatter": "+" + fr(v, unit)}}); down.append("-")
        else:
            down.append({"value": -v, "label": {"formatter": fr(v, unit)}}); up.append("-")
        tot.append("-")
        running += v
    if not totals or tot[-1] == "-":
        cats = cats + ["Total"]
        base.append("-"); up.append("-"); down.append("-")
        tot.append({"value": round(running, 6), "label": {"formatter": fr(running, unit)}})
        spec.notes.fix("a 'Total' bar was added at the end")
    o = _base(spec)
    lab = {"show": True, "position": "top", "color": "@ink2", "fontSize": 11}
    o["xAxis"] = {"type": "category", "data": cats, "axisTick": {"show": False},
                  "axisLabel": {"interval": 0, "width": 96, "overflow": "break", "lineHeight": 14}}
    o["yAxis"] = {"type": "value", "_fmt": True}
    common = {"type": "bar", "stack": "w", "barMaxWidth": 52}
    o["series"] = [
        {**common, "name": "_base", "data": base, "itemStyle": {"color": "transparent"},
         "emphasis": {"disabled": True}, "tooltip": {"show": False}, "silent": True},
        {**common, "name": "Hausse", "data": up, "label": lab,
         "itemStyle": {"color": "@up", "borderRadius": [3, 3, 0, 0]}},
        {**common, "name": "Baisse", "data": down, "label": {**lab, "position": "bottom"},
         "itemStyle": {"color": "@down", "borderRadius": [3, 3, 0, 0]}},
        {**common, "name": "Total", "data": tot, "label": lab,
         "itemStyle": {"color": "@neutral", "borderRadius": [3, 3, 0, 0]}},
    ]
    o["tooltip"] = {"trigger": "axis", "axisPointer": {"type": "shadow"}}
    o["legend"] = {"data": ["Hausse", "Baisse", "Total"], "top": 30 if o.get("title") else 4,
                   "icon": "roundRect", "itemWidth": 12, "itemHeight": 8}
    _grid(o)
    return o, f"waterfall · {len(cats)} steps · final total {fr(running, unit)}"


def c_gantt(spec: Spec) -> tuple[dict, str]:
    cols = spec.cols
    dates = [c for c in cols if c.kind == "date"]
    st = by_name(cols, "start", ("date",)) or (dates[0] if dates else None)
    en = by_name(cols, "end", ("date",)) or next((c for c in dates if c is not st), None)
    dur = next((c for c in measures(cols) if fold(c.name) in
                {"duree", "duration", "jours", "days", "nb_jours", "duree_jours"}), None)
    task = spec.x if spec.x is not None and spec.x.kind == "text" else \
        next((c for c in dims(cols) if c.kind == "text"), None)
    if st is None or task is None or (en is None and dur is None):
        raise SpecError(
            "gantt: needs a task, a start date and an end date (or a duration in days)",
            example=[{"tâche": "Cadrage", "début": "2026-01-05", "fin": "2026-01-16"},
                     {"tâche": "Développement", "début": "2026-01-19", "fin": "2026-03-13"}])
    group = spec.group or next((c for c in dims(cols) if c.kind == "text" and c is not task), None)
    items = []
    for r in spec.rows:
        s = to_date(r.get(st.name))
        if not s:
            continue
        sd = datetime.fromisoformat(s[:10])
        if en is not None and to_date(r.get(en.name)):
            ed = datetime.fromisoformat(to_date(r.get(en.name))[:10]) + timedelta(days=1)  # type: ignore[index]
        elif dur is not None and num(r.get(dur.name)):
            ed = sd + timedelta(days=num(r.get(dur.name)) or 1)  # type: ignore[arg-type]
        else:
            continue
        if ed <= sd:
            spec.notes.warn(f"'{r.get(task.name)}': end before start, swapped")
            sd, ed = ed - timedelta(days=1), sd + timedelta(days=1)
        items.append((str(r.get(task.name)), sd, ed, str(r.get(group.name)) if group else ""))
    if not items:
        raise SpecError("gantt: no readable date (YYYY-MM-DD or DD/MM/YYYY)")
    tasks = list(OrderedDict.fromkeys(i[0] for i in items))
    groups = list(OrderedDict.fromkeys(i[3] for i in items))[:MAX_SERIES]
    t0 = min(i[1] for i in items)
    t1 = max(i[2] for i in items)
    pad = max(timedelta(days=1), (t1 - t0) * 0.02)

    def ms(d: datetime) -> int:
        return int(d.timestamp() * 1000)
    o = _base(spec)
    series = []
    for g in groups:
        base = ["-"] * len(tasks)
        span: list[Any] = ["-"] * len(tasks)
        for name, sd, ed, gg in items:
            if gg != g:
                continue
            i = tasks.index(name)
            base[i] = ms(sd)
            days = (ed - sd).days
            span[i] = {"value": ms(ed) - ms(sd),
                       "tooltip": {"formatter": f"{name}<br/>{sd.day} {MONTHS_FR[sd.month - 1]} → "
                                                f"{(ed - timedelta(days=1)).day} "
                                                f"{MONTHS_FR[(ed - timedelta(days=1)).month - 1]} "
                                                f"({days} j)"}}
        series.append({"type": "bar", "stack": f"g{g}", "data": base, "silent": True,
                       "itemStyle": {"color": "transparent"}, "emphasis": {"disabled": True},
                       "tooltip": {"show": False}, "barGap": "-100%", "name": f"_base{g}"})
        series.append({"type": "bar", "stack": f"g{g}", "name": g or "Tâches", "data": span,
                       "barGap": "-100%", "barMaxWidth": 18,
                       "itemStyle": {"borderRadius": 4}, "emphasis": {"focus": "series"}})
    today = datetime.now()
    if t0 <= today <= t1:
        series[1]["markLine"] = {"symbol": "none", "silent": True,
                                 "lineStyle": {"color": "@down", "type": "solid", "width": 1.5},
                                 "label": {"formatter": "aujourd'hui", "color": "@down", "fontSize": 10},
                                 "data": [{"xAxis": ms(today)}]}
    o["series"] = series
    # Axe « value » en millisecondes (l'empilement base + durée n'existe pas sur un axe
    # « time ») ; le navigateur formate les graduations en dates (_date).
    o["xAxis"] = {"type": "value", "min": ms(t0 - pad), "max": ms(t1 + pad), "position": "top",
                  "splitLine": {"show": True}, "axisLabel": {"hideOverlap": True}, "_date": True,
                  "splitNumber": 6, "axisLine": {"show": False}, "axisTick": {"show": False}}
    o["yAxis"] = {"type": "category", "data": tasks, "inverse": True, "axisTick": {"show": False}}
    o["tooltip"] = {"trigger": "item"}
    if groups != [""]:
        o["legend"] = {"data": [g for g in groups], "top": 30 if o.get("title") else 4,
                       "icon": "roundRect", "itemWidth": 12, "itemHeight": 8}
    _grid(o, 12)
    o["grid"]["top"] += 24
    o["_elpis"]["height"] = max(260, 90 + 30 * len(tasks))
    return o, (f"gantt · {len(tasks)} tasks · from {t0.date().isoformat()} to "
               f"{(t1 - timedelta(days=1)).date().isoformat()} ({(t1 - t0).days} days)")


def c_parallel(spec: Spec) -> tuple[dict, str]:
    m = spec.ys or measures(spec.cols)
    if len(m) < 2:
        raise SpecError("parallel: needs at least two numeric columns",
                        example=[{"modèle": "A", "prix": 21000, "conso": 5.2, "puissance": 110}])
    d = dims(spec.cols)
    group = spec.group or (d[0] if d and len({r.get(d[0].name) for r in spec.rows}) <= MAX_SERIES
                           else None)
    o = _base(spec)
    o["parallelAxis"] = [{"dim": i, "name": c.name, "nameTextStyle": {"color": "@ink2"}, "_fmt": True}
                         for i, c in enumerate(m)]
    o["parallel"] = {"left": 40, "right": 60, "top": 70 if o.get("title") else 46, "bottom": 30,
                     "parallelAxisDefault": {"nameLocation": "end", "nameGap": 14,
                                             "axisLine": {"lineStyle": {"color": "@grid"}},
                                             "axisLabel": {"color": "@ink2"}, "splitLine": {"show": False}}}
    groups: "OrderedDict[str, list]" = OrderedDict()
    for r in spec.rows:
        g = str(r.get(group.name)) if group else "lignes"
        groups.setdefault(g, []).append([num(r.get(c.name)) for c in m])
    o["series"] = [{"type": "parallel", "name": g, "data": rows, "smooth": False,
                    "lineStyle": {"width": 1.6, "opacity": 0.55},
                    "emphasis": {"lineStyle": {"width": 3, "opacity": 1}}} for g, rows in groups.items()]
    _legend(o, len(groups))
    if "legend" in o:
        o["legend"].pop("top", None)
        o["legend"]["bottom"] = 0
        o["parallel"]["bottom"] = 40
    return o, f"parallel · {len(spec.rows)} rows · {len(m)} axes"


def c_radar(spec: Spec) -> tuple[dict, str]:
    d, m = dims(spec.cols), measures(spec.cols)
    ys = spec.ys or m
    if len(ys) >= 3 and len(spec.rows) < len(ys) and spec.group is None:
        # Une ligne par entité, une colonne par axe : transposer
        ent = spec.x or (d[0] if d else None)
        axes = [c.name for c in ys]
        series = [{"name": _label(r.get(ent.name)) if ent else f"#{i + 1}",
                   "data": [num(r.get(c.name)) for c in ys]} for i, r in enumerate(spec.rows)]
        spec.notes.fix("one row per entity: axes = numeric columns")
    else:
        axes, series, _, _ = cartesian(spec)
    mx = max((v for s in series for v in s["data"] if v is not None), default=1)
    top = _nice_ceil(mx)
    o = _base(spec)
    o["radar"] = {"indicator": [{"name": a, "max": top} for a in axes], "radius": "62%",
                  "center": ["50%", "57%"], "splitNumber": 4,
                  "axisName": {"color": "@ink2", "fontSize": 12},
                  "splitLine": {"lineStyle": {"color": "@grid"}}, "splitArea": {"show": False},
                  "axisLine": {"lineStyle": {"color": "@grid"}}}
    o["series"] = [{"type": "radar", "symbolSize": 5,
                    "data": [{"name": s["name"], "value": s["data"],
                              "areaStyle": {"opacity": 0.12}, "lineStyle": {"width": 2}}
                             for s in series[:MAX_SERIES]], "emphasis": {"focus": "self"}}]
    o["tooltip"] = {"trigger": "item"}
    _legend(o, len(series))
    return o, f"radar · {len(axes)} axes · {len(series)} series"


def c_polar_bar(spec: Spec) -> tuple[dict, str]:
    cats, series, _, _ = cartesian(spec)
    o = _base(spec)
    o["polar"] = {"radius": ["14%", "74%"], "center": ["50%", "56%"]}
    o["angleAxis"] = {"type": "category", "data": cats, "startAngle": 90,
                      "axisLine": {"lineStyle": {"color": "@grid"}}, "axisTick": {"show": False},
                      "axisLabel": {"color": "@ink2"}}
    o["radiusAxis"] = {"axisLabel": {"show": False}, "axisLine": {"show": False},
                       "axisTick": {"show": False}, "splitLine": {"lineStyle": {"color": "@grid"}}}
    o["series"] = [{"type": "bar", "name": s["name"], "data": s["data"], "coordinateSystem": "polar",
                    "stack": "p" if spec.opts["stack"] != "none" else None, "roundCap": True,
                    "emphasis": {"focus": "series"}} for s in series]
    o["tooltip"] = {"trigger": "item"}
    _legend(o, len(series))
    return o, f"polar_bar · {len(cats)} categories · {len(series)} series"


def c_table(spec: Spec) -> tuple[dict, str]:
    o = _base(spec)
    o["_elpis"]["render"] = "table"
    return o, f"table · {len(spec.rows)} rows · {len(spec.cols)} columns"


COMPILERS = {
    "bar": c_bar_line, "line": c_bar_line, "area": c_bar_line, "stream": c_stream,
    "pie": c_pie, "donut": c_pie, "rose": c_pie, "funnel": c_funnel, "gauge": c_gauge,
    "progress": c_progress, "kpi": c_kpi, "treemap": c_treemap, "sunburst": c_treemap,
    "tree": c_tree, "sankey": c_sankey, "chord": c_chord, "graph": c_graph,
    "scatter": c_scatter, "bubble": c_scatter, "heatmap": c_heatmap, "calendar": c_calendar,
    "boxplot": c_boxplot, "histogram": c_histogram, "candlestick": c_candlestick,
    "waterfall": c_waterfall, "gantt": c_gantt, "parallel": c_parallel, "radar": c_radar,
    "polar_bar": c_polar_bar, "table": c_table,
}


def compile_option(spec: Spec) -> tuple[dict, str]:
    if spec.tree is not None and spec.kind not in ("treemap", "sunburst", "tree", "table"):
        spec.notes.fix(f"nested data (children): treemap instead of '{spec.kind}'")
        spec.kind = "treemap"
    fn = COMPILERS[spec.kind]
    return fn(spec)
