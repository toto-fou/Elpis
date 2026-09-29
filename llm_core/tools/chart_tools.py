# SPDX-License-Identifier: MIT
# tools/chart_tools.py
"""
Chart.js + table generation — v2.

New vs v1:
  • generate_table   : produce a Markdown/HTML table alongside charts.
  • heatmap type     : matrix visualization (Chart.js matrix controller).
  • Input validation : data/label length consistency, typed dataset checks.
  • Clear errors with hints.

Types:
  Native     : bar, line, pie, doughnut, radar, polarArea, scatter, bubble
  Composite  : area, stepped, waterfall, gauge, funnel, progress, heatmap

Tools registered: chart_trend, chart_proportion, chart_distribution,
                  chart_financial (all over a shared _core), generate_table
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

from fastmcp import Context, FastMCP

from ._models import ErrEnvelope, GenerateChartResult, GenerateTableResult
from ._toolkit import (
    err,
    get_username,
    ok,
    tag_kw,
    tool_kw,
    tool_kw_idempotent,
)

# ── Category descriptor (see fs_tools.CATEGORY for the contract) ──────
CATEGORY = {
    "name":  "chart",
    "label": "Graphiques",
    "icon":  "ph-chart-bar",
    "color": "emerald",
    # No "tools" list — captured automatically at registration time.
}

# Category carried IN the protocol (tags + meta), built by the shared
# toolkit — one place to change if a FastMCP version ever rejects meta=.
_TOOL_KW = tool_kw(CATEGORY)

# v18 — Both chart tools are idempotent: same args (labels + datasets) →
# same chart file written to the user's charts dir. Calling twice
# overwrites with identical content, no observable change.
_TOOL_KW_IDEMP = tool_kw_idempotent(CATEGORY)

PALETTES = {
    "vibrant":  ["#3b82f6","#ef4444","#10b981","#f59e0b","#8b5cf6","#06b6d4","#f97316","#84cc16","#ec4899","#6366f1","#14b8a6","#e11d48"],
    "pastel":   ["#93c5fd","#fca5a5","#86efac","#fcd34d","#c4b5fd","#67e8f9","#fdba74","#bef264","#f9a8d4","#a5b4fc"],
    "dark":     ["#1e40af","#991b1b","#065f46","#92400e","#5b21b6","#155e75","#9a3412","#3f6212","#9d174d","#3730a3"],
    "mono":     ["#1e293b","#334155","#475569","#64748b","#94a3b8","#cbd5e1","#e2e8f0","#f1f5f9"],
    "warm":     ["#ef4444","#f97316","#f59e0b","#eab308","#d946ef","#ec4899","#f43f5e","#fb923c"],
    "cool":     ["#3b82f6","#06b6d4","#14b8a6","#10b981","#8b5cf6","#6366f1","#0ea5e9","#22d3ee"],
    "earth":    ["#78350f","#92400e","#854d0e","#3f6212","#065f46","#1e3a5f","#581c87","#713f12"],
    "neon":     ["#00ff87","#00d4ff","#ff006e","#fb5607","#8338ec","#ffbe0b","#3a86ff","#ff006e"],
}

VALID_TYPES = {"bar","line","pie","doughnut","radar","polarArea","scatter","bubble",
               "area","stepped","waterfall","gauge","funnel","progress","heatmap",
               # Advanced families (plugins vendored in frontend/vendor/):
               "treemap","sunburst","boxplot","violin","candlestick","ohlc","sankey",
               "pie_of_pie","bar_of_pie"}

# Size guards — a model (or a compromised upstream) can emit a multi-million-point
# config that both janks the browser at render time AND gets embedded DURABLY into
# every chat save (DB bloat). The cache only bounds the file COUNT, never a single
# chart's size, so we reject oversized specs up front. Env-overridable.
MAX_DATASETS = max(1, int(os.environ.get("TOOL_CHART_MAX_DATASETS", "50") or 50))
MAX_POINTS_PER_DATASET = max(1, int(os.environ.get("TOOL_CHART_MAX_POINTS", "5000") or 5000))
MAX_TOTAL_POINTS = max(1, int(os.environ.get("TOOL_CHART_MAX_TOTAL_POINTS", "20000") or 20000))

# Types whose data maps 1:1 to `labels` (each value IS a labelled slice/axis/bar), so
# a length mismatch is a real error. radar + pie/doughnut/polarArea belong here (their
# slices/axes are the labels). Composite single-value types (gauge/waterfall/funnel/
# progress) and coordinate/matrix types (scatter/bubble/heatmap) are exempt.
_LENGTH_STRICT = {"bar", "line", "area", "stepped", "pie", "doughnut", "polarArea", "radar",
                  "pie_of_pie", "bar_of_pie"}

# ── Tool families ────────────────────────────────────────────────────────────
# The single fat generate_chart is split into 4 focused tools (comparisons,
# proportions, distributions, finance). Each exposes only its family's types +
# relevant params; they all funnel through the shared _core in register().
TREND_TYPES = {"bar", "line", "area", "stepped", "radar", "polarArea"}
PROPORTION_TYPES = {"pie", "doughnut", "gauge", "funnel", "progress",
                    "treemap", "sunburst", "pie_of_pie", "bar_of_pie"}
DISTRIBUTION_TYPES = {"scatter", "bubble", "heatmap", "boxplot", "violin"}
FINANCIAL_TYPES = {"candlestick", "ohlc", "waterfall", "sankey"}
_TYPE_TO_TOOL = {}
for _grp, _tool in ((TREND_TYPES, "chart_trend"), (PROPORTION_TYPES, "chart_proportion"),
                    (DISTRIBUTION_TYPES, "chart_distribution"), (FINANCIAL_TYPES, "chart_financial")):
    for _t in _grp:
        _TYPE_TO_TOOL[_t] = _tool

# Animation presets. JSON-safe parts are emitted straight into options.animation /
# .animations; the two effects needing JS callbacks (stagger, progressive) emit an
# `options._anim` hint that the front-end turns into scriptable delay functions
# (same client-injection pattern as matrix/treemap). Ref: chartjs.org animations docs.
ANIMATION_PRESETS = {"default", "none", "grow", "fade", "sweep", "stagger", "progressive"}
# Types that get a canvas gradient fill when gradient=True (fill/area based).
_GRADIENT_TYPES = {"line", "area", "stepped", "bar", "radar"}

HEATMAP_GRADIENT = ["#0a2540","#1e3a8a","#2563eb","#3b82f6","#60a5fa","#93c5fd","#dbeafe","#fef3c7","#fde68a","#fcd34d","#f59e0b","#d97706","#b45309","#7c2d12"]


# ── Helpers ──────────────────────────────────────────────────────────────────

def _err(msg, hint=""):
    # Harmonized error envelope (tools/_toolkit.py): keeps {ok:false,error}
    # for backward compat, routes the hint into the standard `fix` field.
    return err("invalid_chart_spec", msg, fix=hint or None)


# ── Chart persistence: store the config, hand the model a tiny ref ───
# Instead of returning the full Chart.js JSON for the model to copy into
# its reply (0.5-2k tokens of context, and JSON it can mangle),
# generate_chart SAVES the config and returns a short `chart_id`. The
# model emits a ```chart-ref``` block with just the id; the chat UI
# fetches the config from /api/charts/{id} and renders it. Content-
# addressed (sha1 of the config) so the same chart is never stored twice.
def _safe_username(username):
    return "".join(c for c in (username or "") if c.isalnum() or c in "-_") or "guest"


# ── Cross-UID writability (Docker migration) ─────────────────────────────
# The chart config is written by the HOST MCP-tool process, but the user's
# sandbox tree is ALSO touched by the per-user Docker container running as
# UID 10001 (volume -v <sandbox>:/work:rw). Whichever side creates a dir
# first owns it; default perms (0o755 / 0o644) then make the OTHER side fail
# with EACCES — the exact cross-UID bug fs_tools already guards against
# (cf. the sandbox agent's umask 0000). chart_tools historically did NOT,
# so a container-owned .charts/ → PermissionError on every generate_chart.
# We relax dirs to 0o777 and files to 0o666 (sandbox-local, per-user tree →
# the broad bits are acceptable). Best-effort: chmod can itself fail if we
# don't own the path — never let that mask the real write outcome.
def _chmod_cross_writable(p: Path, is_dir: bool = False) -> None:
    try:
        # SÉCURITÉ : ``os.chmod`` déréférence les symlinks — jamais élargir
        # les droits d'une cible hors sandbox (cf. fs_tools homonyme).
        if os.path.islink(p):
            return
        os.chmod(p, 0o777 if is_dir else 0o666)
    except OSError:
        pass


# ── Chart cache location: /tmp, NOT the sandbox ──────────────────────────
# Charts are a TRANSIENT cache. generate_chart writes the config here and
# hands the model `!id`; at chat-save time embed_chart_configs() copies the
# config DURABLY into the conversation row (DB), after which this file is
# disposable. Writing under the per-user Docker sandbox mount
# (-v <sandbox>:/work) caused cross-UID PermissionError (host tool process
# vs container UID 10001) AND polluted the sandbox. We therefore write to a
# host-local temp dir, outside the mount: no UID conflict, no pollution, and
# /tmp being cleared on reboot is harmless (the durable copy lives in the DB).
# Override the base with CHART_CACHE_DIR if /tmp is unsuitable.
#
# MUST stay mirrored with shared_infra/charts/routes.py::_charts_dir — both
# the writer (here) and the reader/embedder (route) have to agree on the path.
def _charts_base() -> Path:
    return Path(os.environ.get("CHART_CACHE_DIR")
                or (Path(tempfile.gettempdir()) / "elpis_charts"))


def _charts_dir(username, root_base=None):
    # ``root_base`` kept for signature back-compat; no longer used (charts no
    # longer live under the sandbox). Path: <tmp>/elpis_charts/<username>/.
    base = _charts_base()
    d = base / _safe_username(username)
    d.mkdir(parents=True, exist_ok=True)
    # /tmp is shared; widen so a second host process (e.g. the FastAPI worker
    # embedding configs) under a different umask can still read/replace.
    _chmod_cross_writable(base, is_dir=True)
    _chmod_cross_writable(d, is_dir=True)
    return d


# How many config files to keep in a user's .charts/ cache. This is only
# a CACHE bound: every chart is also embedded durably into the chat that
# references it (see backend/routes/charts.py), so pruning here never
# makes a chart vanish from a conversation — it just means a cache miss
# that the /api/charts endpoint serves from the saved chat instead.
# Raise it on a busy multi-user instance via the env var.
_CHART_CACHE_MAX = max(50, int(os.environ.get("TOOL_CHART_CACHE_MAX", "1000") or 1000))


def _prune_charts(d, keep=None):
    """Bound the .charts/ directory - drop the oldest configs past `keep`."""
    if keep is None:
        keep = _CHART_CACHE_MAX
    try:
        files = sorted(d.glob("*.json"), key=lambda p: p.stat().st_mtime)
        for p in files[:-keep]:
            try:
                p.unlink()
            except OSError:
                pass
    except OSError:
        pass


def _save_chart_config(cfg, username, root_base=None):
    """Persist a Chart.js config, return its short content-hash id.

    ``root_base`` is accepted for signature back-compat (the register()
    closure still passes it) but is IGNORED — charts now live in a host-local
    temp dir, not under the sandbox. See _charts_dir.

    Raises ``OSError`` (cleaned up, no stale tmp) if the cache dir is not
    writable / disk full — the caller turns it into a user-facing error
    envelope rather than a raw 500.
    """
    # allow_nan=False backstop: NaN/Infinity would serialize as bare NaN/Infinity
    # tokens (invalid JSON) that the browser's JSON.parse rejects → silent 404/error.
    # Validation already rejects these in user data; this guards composite arithmetic.
    payload = json.dumps(cfg, ensure_ascii=False, sort_keys=True, allow_nan=False)
    chart_id = hashlib.sha1(payload.encode("utf-8")).hexdigest()[:12]
    d = _charts_dir(username, root_base)
    path = d / f"{chart_id}.json"
    if not path.exists():
        tmp = path.with_suffix(".json.tmp")
        try:
            tmp.write_text(json.dumps(cfg, ensure_ascii=False, allow_nan=False), encoding="utf-8")
            os.replace(tmp, path)
        except OSError:
            # Clean up a half-written tmp so the dir doesn't accumulate
            # cruft, then let the caller surface a clear message.
            try:
                tmp.unlink()
            except OSError:
                pass
            raise
        # Relax the new file so the container-UID can read it too (and a
        # later same-id rewrite from either side overwrites cleanly).
        _chmod_cross_writable(path, is_dir=False)
        _prune_charts(d)
    return chart_id

def _c(n, pal="vibrant"):
    p = PALETTES.get(pal, PALETTES["vibrant"])
    return [p[i % len(p)] for i in range(n)]

def _a(h, alpha=0.15):
    h = h.lstrip("#")
    return f"rgba({int(h[:2],16)},{int(h[2:4],16)},{int(h[4:6],16)},{alpha})"

def _deep_merge(base, over, _depth=0):
    # Depth guard: a deeply-nested ``config_override`` from the model would otherwise
    # blow the Python recursion limit → RecursionError (uncaught → raw 500). Past the
    # cap we stop merging and take the override subtree verbatim.
    if _depth > 64:
        return over
    r = dict(base)
    for k, v in over.items():
        if k in r and isinstance(r[k], dict) and isinstance(v, dict):
            r[k] = _deep_merge(r[k], v, _depth + 1)
        else:
            r[k] = v
    return r


def _fmt_num(n) -> str:
    """Human-friendly number for in-chart labels: integral floats lose the '.0'."""
    try:
        f = float(n)
    except (TypeError, ValueError):
        return str(n)
    if not math.isfinite(f):
        return str(n)
    return str(int(f)) if f.is_integer() else f"{f:g}"


def _labels_look_like_dates(labels) -> Optional[str]:
    """When ``time_axis`` is requested, the x values must be dates the date-fns
    adapter can parse. Return the first label that is NOT date-like (so the caller
    can reject with a clear message), or ``None`` if all are fine / list empty.
    Numeric epochs and ISO-ish strings are accepted; category labels ("Q1") are not."""
    for lab in (labels or []):
        if isinstance(lab, bool):
            return repr(lab)
        if isinstance(lab, (int, float)):
            continue  # epoch millis
        if not isinstance(lab, str):
            return repr(lab)
        s = lab.strip().replace("Z", "+00:00").replace("/", "-")
        try:
            datetime.fromisoformat(s)
            continue
        except ValueError:
            pass
        try:
            datetime.fromisoformat(s.split("T")[0].split(" ")[0])
            continue
        except ValueError:
            return lab
    return None


def _num(v, default: float = 0.0) -> float:
    """Coerce une valeur fournie par le modèle (JSON NON fiable) en float.
    ``None`` ou non-numérique → ``default``.

    Les builders composites (gauge/waterfall/funnel/progress/heatmap) font de
    l'arithmétique sur ``data``/``max`` alors que la validation autorise des
    ``null`` (« null for missing »). Sans cette coercition, un ``null`` ou une
    chaîne parasite levait TypeError/ValueError → exception brute au lieu d'un
    résultat d'outil propre."""
    try:
        if v is None:
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def _validate_datasets(chart_type: str, labels: List[str],
                       datasets: List[Dict]) -> Optional[Dict]:
    """Return error dict or None."""
    if not datasets:
        return _err("at least one dataset required", hint="datasets=[{label, data}]")
    if len(datasets) > MAX_DATASETS:
        return _err(f"too many datasets ({len(datasets)} > {MAX_DATASETS})",
                    hint="Aggregate series or split into several charts.")

    # Hierarchy types carry 'tree' instead of a flat 'data' array — validate their own
    # shape and return (the generic data loop below would reject them for missing data).
    if chart_type in ("treemap", "sunburst"):
        for i, ds in enumerate(datasets):
            tree = ds.get("tree") if isinstance(ds, dict) else None
            if not isinstance(tree, list) or not tree:
                return _err(f"dataset[{i}] {chart_type} needs a non-empty 'tree'",
                            hint="tree=[{name, value}] (sunburst: {name, value, children?})")
        return None

    total_pts = 0
    for i, ds in enumerate(datasets):
        if not isinstance(ds, dict):
            return _err(f"dataset[{i}] must be an object",
                        hint="{label:str, data:list, type?:str, color?:str, yAxisID?:str}")
        data = ds.get("data")
        if data is None:
            return _err(f"dataset[{i}] missing 'data'", hint="Each dataset needs data=[...]")
        if not isinstance(data, list):
            return _err(f"dataset[{i}].data must be a list")
        if len(data) > MAX_POINTS_PER_DATASET:
            return _err(f"dataset[{i}] has too many points ({len(data)} > {MAX_POINTS_PER_DATASET})",
                        hint="Downsample the series before charting.")
        total_pts += len(data)

        # For scatter/bubble, data items are {x,y} or {x,y,r} — coordinates must be
        # finite numbers (x/y/r drive the axes; NaN/str silently break the render).
        if chart_type in ("scatter", "bubble"):
            _coord_keys = ("x", "y", "r") if chart_type == "bubble" else ("x", "y")
            for j, pt in enumerate(data):
                if not isinstance(pt, dict) or "x" not in pt or "y" not in pt:
                    return _err(f"dataset[{i}].data[{j}] must be {{x,y}} for {chart_type}",
                                hint="scatter/bubble use coordinate objects")
                if chart_type == "bubble" and "r" not in pt:
                    return _err(f"dataset[{i}].data[{j}] must have 'r' for bubble",
                                hint="bubble points: {x, y, r}")
                for _k in _coord_keys:
                    _val = pt.get(_k)
                    if isinstance(_val, bool) or not isinstance(_val, (int, float)) \
                            or not math.isfinite(_val):
                        return _err(f"dataset[{i}].data[{j}].{_k} must be a finite number",
                                    hint="scatter/bubble coordinates must be numeric")
        elif chart_type == "heatmap":
            # Heatmap : data = [[row, col, value], ...] OU [{row, col, value}, ...]
            # — PAS des nombres plats. L'ancien code tombait dans la branche
            # numérique ci-dessous et rejetait donc TOUT heatmap valide
            # ("must be number (got list)") → la fonctionnalité était cassée.
            for j, pt in enumerate(data):
                ok_list = isinstance(pt, (list, tuple)) and len(pt) >= 3
                ok_dict = isinstance(pt, dict) and ("value" in pt or "v" in pt)
                if not (ok_list or ok_dict):
                    return _err(
                        f"dataset[{i}].data[{j}] must be [row,col,value] or "
                        f"{{row,col,value}} for heatmap",
                        hint="heatmap: data=[[0,0,5],[0,1,3]] or [{row,col,value}]")
        elif chart_type in ("boxplot", "violin"):
            # data items are a list of raw samples OR a precomputed box object.
            for j, pt in enumerate(data):
                ok_list = isinstance(pt, (list, tuple)) and len(pt) >= 1
                ok_dict = isinstance(pt, dict) and all(
                    k in pt for k in ("min", "q1", "median", "q3", "max"))
                if not (ok_list or ok_dict):
                    return _err(
                        f"dataset[{i}].data[{j}] must be a list of numbers or "
                        f"{{min,q1,median,q3,max}} for {chart_type}",
                        hint="boxplot: data=[[1,2,3,4], ...] or [{min,q1,median,q3,max}]")
        elif chart_type in ("candlestick", "ohlc"):
            for j, pt in enumerate(data):
                if not isinstance(pt, dict) or "x" not in pt \
                        or not all(k in pt for k in ("o", "h", "l", "c")):
                    return _err(f"dataset[{i}].data[{j}] must be {{x,o,h,l,c}} for {chart_type}",
                                hint="financial: data=[{x:'2024-01-02',o:1,h:2,l:0,c:1.5}, ...]")
        elif chart_type == "sankey":
            for j, pt in enumerate(data):
                if not isinstance(pt, dict) or not all(k in pt for k in ("from", "to", "flow")):
                    return _err(f"dataset[{i}].data[{j}] must be {{from,to,flow}} for sankey",
                                hint="sankey: data=[{from:'A',to:'B',flow:5}, ...]")
        else:
            # Numeric data check. Reject bool (bool ⊂ int → True/False would chart as
            # 1/0) and non-finite floats: NaN/Infinity survive to json.dumps as bare
            # NaN/Infinity tokens, which the browser's JSON.parse rejects → the chart
            # silently 404s. null is allowed (missing point).
            for j, v in enumerate(data):
                if v is None: continue
                if isinstance(v, bool) or not isinstance(v, (int, float)):
                    return _err(f"dataset[{i}].data[{j}] must be a number (got {type(v).__name__})",
                                hint="Use numbers, or null for missing. Text → use labels param.")
                if isinstance(v, float) and not math.isfinite(v):
                    return _err(f"dataset[{i}].data[{j}] is not finite (NaN/Infinity)",
                                hint="Chart data must be finite numbers or null.")
            # Length consistency with labels — only for types that map data 1:1 to
            # labels (radar + pie/doughnut/polarArea included: their axes/slices ARE the
            # labels). Composite single-value types are exempt (see _LENGTH_STRICT).
            if labels and chart_type in _LENGTH_STRICT and len(data) != len(labels):
                return _err(f"dataset[{i}].data length ({len(data)}) != labels length ({len(labels)})",
                            hint="Pad data with null or trim labels to match.")

    if total_pts == 0:
        return _err("no data points to plot", hint="Every dataset's 'data' is empty.")
    if total_pts > MAX_TOTAL_POINTS:
        return _err(f"too many total points ({total_pts} > {MAX_TOTAL_POINTS})",
                    hint="Downsample or split into several charts.")
    return None


# ── Standard dataset builder ─────────────────────────────────────────────────

def _build_dataset(ds, i, chart_type, colors, total_datasets=1, palette="vibrant"):
    d = {"label": ds.get("label", f"Serie {i+1}"), "data": ds.get("data", [])}
    c = ds.get("color") or colors[i % len(colors)]
    ds_type = ds.get("type") or chart_type
    n_items = len(d["data"])

    for key in ("yAxisID","xAxisID","stack","order","hidden","pointRadius","pointStyle",
                "borderWidth","borderDash","borderColor","backgroundColor","fill","tension",
                "stepped","cutout","circumference","rotation","borderRadius","barPercentage",
                "categoryPercentage","base","minBarLength","indexAxis","clip","segment"):
        if key in ds:
            d[key] = ds[key]

    if ds.get("type"):
        d["type"] = ds["type"]

    if ds_type in ("line", "area", "stepped"):
        d.setdefault("borderColor", c)
        d.setdefault("backgroundColor", _a(c, 0.12 if ds_type == "area" else 0.05))
        d.setdefault("tension", ds.get("tension", 0.4))
        d.setdefault("borderWidth", 2)
        d.setdefault("pointRadius", ds.get("pointRadius", 3))
        if ds_type == "area":
            d.setdefault("fill", ds.get("fill", "origin"))
        elif ds_type == "stepped":
            d["stepped"] = ds.get("stepped", True)
            d.setdefault("fill", False)
        else:
            d.setdefault("fill", ds.get("fill", False))

    elif ds_type in ("pie", "doughnut", "polarArea"):
        d.setdefault("backgroundColor", _c(n_items, palette))
        d.setdefault("borderWidth", 2)
        d.setdefault("borderColor", "#ffffff")
        if ds_type == "doughnut":
            d.setdefault("cutout", ds.get("cutout", "60%"))

    elif ds_type == "radar":
        d.setdefault("borderColor", c)
        d.setdefault("backgroundColor", _a(c, 0.2))
        d.setdefault("borderWidth", 2)
        d.setdefault("pointRadius", 3)

    elif ds_type == "bar":
        d.setdefault("backgroundColor", c)
        d.setdefault("borderColor", c)
        d.setdefault("borderRadius", 4)

    elif ds_type in ("scatter", "bubble"):
        d.setdefault("backgroundColor", _a(c, 0.6))
        d.setdefault("borderColor", c)
        if ds_type == "scatter":
            d.setdefault("pointRadius", ds.get("pointRadius", 5))

    return d


# ── Composite builders ───────────────────────────────────────────────────────

def _build_waterfall(labels, datasets, colors):
    """Cumulative up/down bars. data=[+10, -5, +3]."""
    if not datasets: return None
    ds0 = datasets[0]
    data = ds0.get("data", [])
    pos = ds0.get("color_positive", "#10b981")
    neg = ds0.get("color_negative", "#ef4444")
    running = 0.0
    bars = []
    bar_colors = []
    for raw in data:
        v = _num(raw)
        start = running
        end = running + v
        bars.append([start, end])
        bar_colors.append(pos if v >= 0 else neg)
        running = end
    return {
        "type": "bar",
        "data": {
            "labels": labels or [f"Step {i+1}" for i in range(len(data))],
            "datasets": [{
                "label": ds0.get("label", "Waterfall"),
                "data": bars,
                "backgroundColor": bar_colors,
                "borderColor": bar_colors,
                "borderWidth": 1,
                "borderSkipped": False,
            }],
        },
        "options": {
            "responsive": True,
            "plugins": {"legend": {"display": False}},
            "scales": {"y": {"beginAtZero": True}},
        },
    }


def _build_gauge(labels, datasets, colors, title):
    if not datasets: return None
    ds0 = datasets[0]
    data = ds0.get("data", [0])
    val = _num(data[0]) if data else 0.0
    mx = _num(ds0.get("max", 100), 100.0)
    unit = ds0.get("unit", "")
    remaining = max(0, mx - val)
    color = ds0.get("color") or colors[0]
    return {
        "type": "doughnut",
        "data": {
            "labels": [labels[0] if labels else "Value", "Remaining"],
            "datasets": [{
                "data": [val, remaining],
                "backgroundColor": [color, "#e5e7eb"],
                "borderWidth": 0,
                "circumference": 180,
                "rotation": 270,
                "cutout": "75%",
            }],
        },
        "options": {
            "responsive": True,
            "plugins": {"legend": {"display": False},
                        "tooltip": {"enabled": False},
                        # Rendered in-canvas by the front-end 'elpisCenterText' plugin
                        # (JSON-driven, no callback). Fixes the old bug where the gauge
                        # value only reached the tool summary, never the UI.
                        "centerText": {"text": f"{_fmt_num(val)}{unit}",
                                       "subtext": f"/ {_fmt_num(mx)}{unit}"}},
        },
        "_extra_md": f"\n\n**{_fmt_num(val)}{unit} / {_fmt_num(mx)}{unit}**",
    }


def _build_funnel(labels, datasets, colors):
    if not datasets: return None
    ds0 = datasets[0]
    data = [_num(v) for v in ds0.get("data", [])]
    if labels and len(labels) == len(data):
        pairs = sorted(zip(labels, data), key=lambda p: -p[1])
        labs = [p[0] for p in pairs]
        vals = [p[1] for p in pairs]
    else:
        vals = sorted(data, reverse=True)
        labs = labels or [f"Stage {i+1}" for i in range(len(vals))]
    return {
        "type": "bar",
        "data": {
            "labels": labs,
            "datasets": [{
                "label": ds0.get("label", "Funnel"),
                "data": vals,
                "backgroundColor": _c(len(vals), "warm"),
                "borderRadius": 4,
            }],
        },
        "options": {
            "indexAxis": "y",
            "responsive": True,
            "plugins": {"legend": {"display": False}},
        },
    }


def _build_progress(labels, datasets, colors):
    if not datasets: return None
    ds0 = datasets[0]
    data = [_num(v) for v in ds0.get("data", [])]
    mx = _num(ds0.get("max", 100), 100.0)
    return {
        "type": "bar",
        "data": {
            "labels": labels or [f"Item {i+1}" for i in range(len(data))],
            "datasets": [
                {
                    "label": ds0.get("label", "Progress"),
                    "data": data,
                    "backgroundColor": colors[0],
                    "borderRadius": 6,
                    "stack": "s",
                },
                {
                    "label": "Remaining",
                    "data": [max(0, mx - v) for v in data],
                    "backgroundColor": "#e5e7eb",
                    "stack": "s",
                },
            ],
        },
        "options": {
            "indexAxis": "y",
            "responsive": True,
            "plugins": {"legend": {"display": False}},
            "scales": {
                "x": {"stacked": True, "max": mx},
                "y": {"stacked": True},
            },
        },
    }


def _build_heatmap(labels, datasets):
    """True heatmap via the chartjs-chart-matrix controller (vendored). Category axes
    carry the row/col labels (the old scatter version stashed them in a non-standard
    'callback_labels' key that nothing read, so labels were always lost). Cell colours
    are a static per-cell array (JSON-safe); the front-end injects the scriptable
    width/height (they can't cross JSON) from the '_heatmap' hint.

    dataset[0] = {
      label, data: [[row_idx, col_idx, value], ...] OR [{row,col,value}, ...],
      rows: [row labels], cols: [col labels]   # optional
    }
    """
    if not datasets: return None
    ds0 = datasets[0]
    data = ds0.get("data", [])
    rows = ds0.get("rows") or []
    cols = ds0.get("cols") or labels or []

    # Flatten to (row, col, value) integer-indexed cells.
    points = []
    vals = []
    max_r = max_c = -1
    for entry in data:
        if isinstance(entry, dict):
            r, c, v = entry.get("row", 0), entry.get("col", 0), entry.get("value", entry.get("v", 0))
        elif isinstance(entry, (list, tuple)) and len(entry) >= 3:
            r, c, v = entry[0], entry[1], entry[2]
        else:
            continue
        r, c, v = int(_num(r)), int(_num(c)), _num(v)
        points.append({"r": r, "c": c, "v": v})
        vals.append(v)
        max_r, max_c = max(max_r, r), max(max_c, c)

    if not points:
        return None

    vmin, vmax = min(vals), max(vals)
    n_cols = max(len(cols), max_c + 1)
    n_rows = max(len(rows), max_r + 1)

    def color_for(v):
        if vmax == vmin:
            return HEATMAP_GRADIENT[len(HEATMAP_GRADIENT) // 2]
        ratio = (v - vmin) / (vmax - vmin)
        idx = int(ratio * (len(HEATMAP_GRADIENT) - 1))
        return HEATMAP_GRADIENT[max(0, min(idx, len(HEATMAP_GRADIENT) - 1))]

    # Category-axis label arrays (fall back to numeric indices when not provided).
    x_labels = [str(cols[i]) if i < len(cols) else str(i) for i in range(n_cols)]
    y_labels = [str(rows[i]) if i < len(rows) else str(i) for i in range(n_rows)]

    matrix_data = [{"x": x_labels[p["c"]], "y": y_labels[p["r"]], "v": p["v"]} for p in points]
    bg = [color_for(p["v"]) for p in points]

    return {
        "type": "matrix",
        "data": {
            "datasets": [{
                "label": ds0.get("label", "Heatmap"),
                "data": matrix_data,
                "backgroundColor": bg,       # static per-cell colours (scriptable array)
                "borderWidth": 0,
                "_heatmap": {"cols": n_cols, "rows": n_rows},  # front-end sizes cells from this
            }],
        },
        "options": {
            "responsive": True,
            "plugins": {"legend": {"display": False}},
            "scales": {
                "x": {"type": "category", "labels": x_labels, "offset": True,
                      "ticks": {"display": bool(cols)}, "grid": {"display": False},
                      "title": {"display": bool(cols), "text": "Column"}},
                "y": {"type": "category", "labels": y_labels, "offset": True, "reverse": True,
                      "ticks": {"display": bool(rows)}, "grid": {"display": False},
                      "title": {"display": bool(rows), "text": "Row"}},
            },
        },
        "_extra_md": f"\n\n<sub>heatmap: {len(points)} cells, values {vmin}..{vmax}</sub>",
    }


# ── Advanced families (chartjs-chart-* controllers, vendored front-side) ──────
# These emit JSON-only configs; the front-end injects the few genuinely scriptable
# options a plugin needs (matrix cell size, treemap colour/label) — see
# _enrichAdvancedConfig in _rendering.js. NEVER emit a JS-function string here.

def _build_treemap(labels, datasets):
    """chartjs-chart-treemap. tree=[{name,value}, ...] (flat). Colour by value
    (gradient) is injected client-side from the '_treemap' hint."""
    if not datasets: return None
    ds0 = datasets[0]
    tree = ds0.get("tree") or []
    norm = []
    for it in tree:
        if isinstance(it, dict):
            norm.append({"name": str(it.get("name", it.get("label", ""))),
                         "value": _num(it.get("value", it.get("v", 0)))})
        else:
            norm.append({"name": "", "value": _num(it)})
    norm = [t for t in norm if t["value"] > 0]
    if not norm:
        return None
    vals = [t["value"] for t in norm]
    return {
        "type": "treemap",
        "data": {"datasets": [{
            "label": ds0.get("label", "Treemap"),
            "tree": norm,
            "key": "value",
            "borderWidth": 1,
            "borderColor": "#ffffff",
            "spacing": 1,
            "_treemap": {"vmin": min(vals), "vmax": max(vals), "gradient": HEATMAP_GRADIENT},
        }]},
        "options": {"responsive": True, "plugins": {"legend": {"display": False}}},
    }


def _build_sunburst(labels, datasets):
    """No maintained Chart.js sunburst plugin → approximate with concentric doughnut
    rings (one dataset per hierarchy depth). Because a parent's value is the sum of its
    children and children are emitted in parent order, ring angles stay roughly aligned.
    tree=[{name, value, children?:[...]}, ...]."""
    if not datasets: return None
    tree = datasets[0].get("tree") or []
    palette = PALETTES["vibrant"]
    rings: List[List[Dict]] = []

    def walk(nodes, depth, inherited=None):
        if not isinstance(nodes, list):
            return
        while len(rings) <= depth:
            rings.append([])
        for k, node in enumerate(nodes):
            if isinstance(node, dict):
                name = str(node.get("name", node.get("label", "")))
                children = node.get("children") or []
                if children:
                    val = sum((_num(c.get("value", 0)) if isinstance(c, dict) else _num(c))
                              for c in children)
                else:
                    val = _num(node.get("value", node.get("v", 0)))
            else:
                name, children, val = "", [], _num(node)
            color = inherited or palette[(len(rings[depth]) + k) % len(palette)]
            rings[depth].append({"name": name, "value": val, "color": color})
            if children:
                walk(children, depth + 1, color)

    walk(tree, 0)
    rings = [r for r in rings if r]
    if not rings:
        return None
    datasets_cfg = [{
        "data": [x["value"] for x in level],
        "backgroundColor": [x["color"] for x in level],
        "borderWidth": 1, "borderColor": "#ffffff",
    } for level in rings]
    return {
        "type": "doughnut",
        "data": {"labels": [x["name"] for x in rings[0]], "datasets": datasets_cfg},
        "options": {"responsive": True, "cutout": "25%",
                    "plugins": {"legend": {"display": True, "position": "bottom"}}},
    }


def _build_boxplot(labels, datasets, kind="boxplot"):
    """@sgratzl/chartjs-chart-boxplot. Each dataset.data item is a list of raw samples
    (the controller computes quartiles) or a {min,q1,median,q3,max} box object; one item
    per category label."""
    if not datasets: return None
    colors = _c(len(datasets), "cool")
    built = []
    for i, ds in enumerate(datasets):
        c = ds.get("color") or colors[i % len(colors)]
        built.append({
            "label": ds.get("label", f"Serie {i+1}"),
            "data": ds.get("data", []),
            "backgroundColor": _a(c, 0.3),
            "borderColor": c,
            "borderWidth": 1.5,
            "itemRadius": 2,
            "outlierBackgroundColor": c,
        })
    n_groups = len(built[0]["data"]) if built else 0
    return {
        "type": kind,
        "data": {"labels": labels or [f"Group {i+1}" for i in range(n_groups)],
                 "datasets": built},
        "options": {"responsive": True,
                    "plugins": {"legend": {"display": len(built) > 1, "position": "bottom"}}},
    }


def _build_financial(labels, datasets, kind="candlestick"):
    """chartjs-chart-financial. data=[{x,o,h,l,c}] with x a date/timestamp; needs the
    (vendored) date-fns adapter for the time x-axis."""
    if not datasets: return None
    ds0 = datasets[0]
    return {
        "type": kind,
        "data": {"datasets": [{
            "label": ds0.get("label", kind.upper()),
            "data": ds0.get("data", []),
        }]},
        "options": {
            "responsive": True,
            "plugins": {"legend": {"display": False}},
            "scales": {
                "x": {"type": "time",
                      "time": {"tooltipFormat": "PP",
                               "displayFormats": {"day": "d MMM", "week": "d MMM",
                                                  "month": "MMM yyyy", "year": "yyyy"}}},
                "y": {"beginAtZero": False},
            },
        },
    }


def _build_sankey(labels, datasets):
    """chartjs-chart-sankey. data=[{from,to,flow}]; optional labels={id:display}."""
    if not datasets: return None
    ds0 = datasets[0]
    ds = {
        "label": ds0.get("label", "Flow"),
        "data": ds0.get("data", []),
        "colorMode": ds0.get("colorMode", "gradient"),
        "borderWidth": 0,
    }
    node_labels = ds0.get("labels") or ds0.get("nodeLabels")
    if isinstance(node_labels, dict):
        ds["labels"] = node_labels
    return {
        "type": "sankey",
        "data": {"datasets": [ds]},
        "options": {"responsive": True, "plugins": {"legend": {"display": False}}},
    }


def _build_pie_of_pie(labels, datasets, kind="pie_of_pie", palette="vibrant"):
    """Excel-style pie-of-pie / bar-of-pie: a primary pie whose aggregated 'Other' slice
    is exploded into a secondary pie (pie_of_pie) or bar (bar_of_pie). Returns a custom
    ``_composite`` dict; the front-end renders the two configs into one two-canvas card.

    Split rule (deterministic): explicit ``explode`` label list → else ``split_threshold``
    (share < X%) → else the smallest ``split_count`` slices (default 3)."""
    if not datasets: return None
    ds0 = datasets[0]
    data = [_num(v) for v in ds0.get("data", [])]
    if not data:
        return None
    labs = [str(x) for x in (labels or [])]
    while len(labs) < len(data):
        labs.append(f"Item {len(labs)+1}")
    pairs = list(zip(labs, data[:len(labs)]))

    explode = ds0.get("explode")
    if explode:
        eset = set(explode)
        members = [p for p in pairs if p[0] in eset]
        majors = [p for p in pairs if p[0] not in eset]
    else:
        total = sum(abs(v) for _, v in pairs) or 1.0
        threshold = ds0.get("split_threshold")
        if threshold:
            thr = float(threshold)
            members = [p for p in pairs if (abs(p[1]) / total) * 100 < thr]
            majors = [p for p in pairs if (abs(p[1]) / total) * 100 >= thr]
        else:
            n = max(1, int(ds0.get("split_count", 3) or 3))
            order = sorted(range(len(pairs)), key=lambda idx: abs(pairs[idx][1]))
            small = set(order[:n])
            members = [pairs[idx] for idx in range(len(pairs)) if idx in small]
            majors = [pairs[idx] for idx in range(len(pairs)) if idx not in small]
    if not members:                       # nothing qualified → explode the smallest one
        members, majors = pairs[-1:], pairs[:-1]

    other_label = ds0.get("split_label", "Autres")
    other_val = sum(v for _, v in members)
    primary_labels = [l for l, _ in majors] + [other_label]
    primary_data = [v for _, v in majors] + [other_val]
    prim_colors = _c(len(primary_labels), palette)
    prim_colors[-1] = "#94a3b8"           # muted 'Other' slice
    sec_colors = _c(len(members), palette)

    primary = {
        "type": "doughnut" if ds0.get("doughnut") else "pie",
        "data": {"labels": primary_labels,
                 "datasets": [{"data": primary_data, "backgroundColor": prim_colors,
                               "borderColor": "#ffffff", "borderWidth": 2}]},
        "options": {"responsive": True, "maintainAspectRatio": False,
                    "plugins": {"legend": {"display": True, "position": "bottom"}}},
    }
    sec_title = {"display": True, "text": f"Détail : {other_label}", "font": {"size": 12}}
    if kind == "bar_of_pie":
        secondary = {
            "type": "bar",
            "data": {"labels": [l for l, _ in members],
                     "datasets": [{"data": [v for _, v in members],
                                   "backgroundColor": sec_colors, "borderRadius": 4}]},
            "options": {"indexAxis": "y", "responsive": True, "maintainAspectRatio": False,
                        "plugins": {"legend": {"display": False}, "title": sec_title}},
        }
    else:
        secondary = {
            "type": "pie",
            "data": {"labels": [l for l, _ in members],
                     "datasets": [{"data": [v for _, v in members],
                                   "backgroundColor": sec_colors,
                                   "borderColor": "#ffffff", "borderWidth": 2}]},
            "options": {"responsive": True, "maintainAspectRatio": False,
                        "plugins": {"legend": {"display": True, "position": "bottom"},
                                    "title": sec_title}},
        }
    return {
        "_composite": "pie_of_pie",
        "variant": kind,
        "primary": primary,
        "secondary": secondary,
        "split": {"label": other_label,
                  "members": [{"label": l, "value": v} for l, v in members]},
    }


def _build_annotations(anns):
    if not anns: return {}
    am = {}
    for i, a in enumerate(anns):
        t = a.get("type", "line")
        col = a.get("color", "#ef4444")
        lbl = a.get("label", "")
        if t == "line":
            v = a.get("value")
            axis = a.get("axis", "y")
            e = {"type": "line", "borderColor": col, "borderWidth": 2, "borderDash": [6, 6]}
            e[f"{axis}Min"] = v
            e[f"{axis}Max"] = v
            if lbl:
                e["label"] = {"display": True, "content": lbl, "position": "end",
                              "backgroundColor": col, "color": "#fff", "font": {"size": 10}}
            am[f"a{i}"] = e
        elif t == "box":
            e = {"type": "box",
                 "xMin": a.get("xMin"), "xMax": a.get("xMax"),
                 "yMin": a.get("yMin"), "yMax": a.get("yMax"),
                 "backgroundColor": _a(col, 0.1),
                 "borderColor": col, "borderWidth": 1}
            if lbl:
                e["label"] = {"display": True, "content": lbl, "font": {"size": 10}, "color": col}
            am[f"a{i}"] = e
    return {"annotation": {"annotations": am}} if am else {}


# ── Animation presets / gradients / decimation ───────────────────────────────

def _animation_overlay(animation, chart_type):
    """Options overlay for a preset. Keys land in options: `animation`, `animations`,
    `_anim` (a client-injection hint for the callback-based presets)."""
    a = (animation or "default").lower()
    radial = chart_type in ("pie", "doughnut", "gauge", "pie_of_pie", "bar_of_pie", "sunburst")
    if a == "none":
        return {"animation": False}
    if a == "grow":
        if radial:
            return {"animation": {"animateScale": True, "animateRotate": True, "duration": 900}}
        return {"animation": {"duration": 900, "easing": "easeOutBack"}}
    if a == "fade":
        return {"animation": {"duration": 700},
                "animations": {"colors": {"type": "color",
                                          "properties": ["backgroundColor", "borderColor"],
                                          "from": "transparent"}}}
    if a == "sweep":
        return {"animation": {"animateRotate": True, "animateScale": False,
                              "duration": 1100, "easing": "easeOutSine"}}
    if a == "stagger":
        return {"animation": {"duration": 600},
                "_anim": {"mode": "stagger", "step": 60, "dsStep": 120}}
    if a == "progressive":
        return {"animation": {"duration": 600}, "_anim": {"mode": "progressive", "step": 18}}
    # "default" / unknown
    return {"animation": {"duration": 800, "easing": "easeOutQuart"}}


def _apply_animation(cfg, animation, chart_type):
    a = (animation or "default").lower()
    if a == "default":
        return  # keep the front-end's own default animation; emit nothing (tiny config)
    overlay = _animation_overlay(a, chart_type)

    def _merge(opts):
        for k, v in overlay.items():
            if k == "animations" and isinstance(opts.get("animations"), dict) and isinstance(v, dict):
                opts["animations"] = {**opts["animations"], **v}
            else:
                opts[k] = v

    if cfg.get("_composite"):
        for sub in ("primary", "secondary"):
            if isinstance(cfg.get(sub), dict):
                _merge(cfg[sub].setdefault("options", {}))
    else:
        _merge(cfg.setdefault("options", {}))


def _apply_gradient(cfg, chart_type):
    """Flag datasets for a client-injected canvas gradient fill (needs the 2d ctx →
    can't cross JSON). Only for fill/area-based types; no-op on composites/plugins."""
    if cfg.get("_composite") or chart_type not in _GRADIENT_TYPES:
        return
    for ds in cfg.get("data", {}).get("datasets", []):
        if isinstance(ds, dict):
            ds["_gradient"] = True


def _apply_decimation(cfg, chart_type):
    """Enable the built-in LTTB decimation plugin for large line/scatter series.
    Best-effort: Chart.js only engages it when data is in {x,y} point format."""
    if cfg.get("_composite") or chart_type not in ("line", "area", "stepped", "scatter"):
        return
    opts = cfg.setdefault("options", {})
    opts.setdefault("plugins", {})["decimation"] = {
        "enabled": True, "algorithm": "lttb", "samples": 500}
    opts["parsing"] = opts.get("parsing", False)


# ── Registration ─────────────────────────────────────────────────────────────

def register(mcp: FastMCP, root_base) -> None:

    def _finish_chart(cfg, chart_type, datasets, username):
        """Persist the built config, return the token-light handle.
        Both generate_chart return paths funnel through here."""
        extra = cfg.pop("_extra_md", "")
        try:
            chart_id = _save_chart_config(cfg, username, root_base)
        except ValueError:
            # allow_nan=False backstop tripped: a non-finite number reached the
            # serializer (should be caught by _validate_datasets, but composite
            # arithmetic on extreme inputs could still overflow to inf).
            return _err("chart contains non-finite numbers (NaN/Infinity)",
                        hint="All numeric values must be finite.")
        except OSError as e:
            # Cross-UID PermissionError (host MCP process vs container-10001
            # owning the sandbox tree) or disk-full. Surface a clear, actionable
            # envelope instead of a raw 500 — the chart simply isn't produced.
            return err(
                "chart_write_failed",
                f"Could not save the chart config: {e}",
                fix=("The chart cache directory is not writable by the tool "
                     "process (cross-UID sandbox permissions). Retry; if it "
                     "persists, an admin should ensure the user's sandbox "
                     "'.charts' directory is writable by the host tool user."),
            )
        n_ds = len(datasets) if isinstance(datasets, list) else 0
        n_pts = sum(len(d.get("data", [])) for d in datasets
                    if isinstance(d, dict)) if isinstance(datasets, list) else 0
        summary = f"{chart_type} \u00b7 {n_ds} dataset(s) \u00b7 {n_pts} point(s)"
        if extra:
            summary += " \u00b7 " + str(extra).strip().lstrip("*").strip()
        ref = f"!{chart_id}"
        return ok(
            ref=ref,
            # Token-frugal result: the FULL placement rule lives ONCE in the tool
            # docstring + FRAGMENT_CHART.md (injected per-turn), so this per-call
            # hint stays a short reminder instead of ~75 tokens repeated in every
            # tool result carried by tool_history. `ref` is bare (no backticks) so
            # the model can copy it verbatim onto its own line.
            hint=f"Put {ref} on its own line where the chart should appear.",
            chart_id=chart_id,
            chart_type=chart_type,
            summary=summary,
        )

    def _core(
        _username,
        chart_type,
        labels: List[str] = [],
        datasets: List[Dict[str, Any]] = [],
        title: str = "",
        subtitle: str = "",
        stacked: bool = False,
        horizontal: bool = False,
        palette: str = "vibrant",
        legend: bool = True,
        y_min: Optional[float] = None,
        y_max: Optional[float] = None,
        x_label: str = "",
        y_label: str = "",
        y2_label: str = "",
        time_axis: bool = False,
        log_scale: bool = False,
        show_values: bool = False,
        annotations: List[Dict[str, Any]] = [],
        aspect_ratio: Optional[float] = None,
        config_override: Dict[str, Any] = {},
        animation: str = "default",
        gradient: bool = False,
        decimation: bool = False,
        allowed=None,
        tool_name: str = "generate_chart",
    ):
        """Shared engine behind the 4 chart_* tools. `allowed` scopes chart_type to a
        family (cross-tool hint on mismatch); the wrappers below expose only the params
        relevant to their family. Not itself an MCP tool.

TYPES: bar, line, area, stepped, pie, doughnut, radar, polarArea, scatter, bubble,
       waterfall, gauge, funnel, progress, heatmap, treemap, sunburst, boxplot, violin,
       candlestick, ohlc, sankey, pie_of_pie, bar_of_pie.

DATASETS (standard): [{"label":"Name","data":[10,20,30]}]
  + per-dataset: type, color, fill, tension, stepped, borderDash, pointStyle,
                  yAxisID ("y2" for dual axis), stack, order, indexAxis.

SCATTER/BUBBLE: data=[{x,y}] or [{x,y,r}].
HEATMAP: data=[[row,col,value], ...]. Optional rows=[...], cols=[...].

COMPOSITE:
  waterfall  : data=[+10,-5,+3] cumulative.
  gauge      : data=[75], max=100, unit="%".
  funnel     : data=[1000,750,300] auto-sorted horizontal.
  progress   : data=[75,40], max=100.
  heatmap    : matrix visualization.

ADVANCED (finite numbers only):
  treemap    : datasets=[{tree:[{name,value}, ...]}]  (area by value).
  sunburst   : datasets=[{tree:[{name,value,children:[...]}, ...]}]  (nested rings).
  boxplot/violin : datasets=[{data:[[raw,samples], ...]}], labels=group names.
  candlestick/ohlc : datasets=[{data:[{x:"2024-01-02",o,h,l,c}, ...]}]  (date x-axis).
  sankey     : datasets=[{data:[{from,to,flow}, ...], labels?:{id:"Display"}}].
  pie_of_pie / bar_of_pie : standard pie series; the smallest slices collapse into an
    "Autres" slice exploded in a 2nd chart. Control via per-dataset explode=[labels] |
    split_threshold=<pct> | split_count=<n, default 3>, split_label="Autres".

OPTIONS: y2_label (dual axis), time_axis (ISO date labels), log_scale, annotations,
         show_values, config_override for raw Chart.js merge.
PALETTES: vibrant, pastel, dark, mono, warm, cool, earth, neon."""
        if allowed is not None and chart_type not in allowed:
            _right = _TYPE_TO_TOOL.get(chart_type)
            return _err(
                f"'{chart_type}' isn't a {tool_name} type",
                hint=(f"Use {_right} for '{chart_type}'." if _right
                      else f"This tool handles: {', '.join(sorted(allowed))}."))
        if chart_type not in VALID_TYPES:
            return _err(f"unknown type '{chart_type}'",
                        hint=f"Use: {', '.join(sorted(VALID_TYPES))}")
        if animation and animation not in ANIMATION_PRESETS:
            animation = "default"

        # Validate. NB : on n'assigne PAS à ``err`` — c'est le helper
        # d'enveloppe importé (`from ._toolkit import err`) ; le masquer ici
        # le rendrait inappelable plus bas dans la fonction (fragilité).
        _verr = _validate_datasets(chart_type, labels, datasets)
        if _verr:
            return _verr

        # A time axis needs date-parseable labels (the date-fns adapter is now
        # vendored, but "Q1"/"Jan" style labels still throw at render time).
        if time_axis:
            _bad = _labels_look_like_dates(labels)
            if _bad is not None:
                return _err(f"time_axis=True needs ISO date labels; got {_bad!r}",
                            hint="Use dates like '2024-01-15', or set time_axis=False.")

        colors = _c(max(len(datasets), len(labels), 1), palette)

        # Composite types
        cfg = None
        if chart_type == "gauge":
            cfg = _build_gauge(labels, datasets, colors, title)
        elif chart_type == "waterfall":
            cfg = _build_waterfall(labels, datasets, colors)
        elif chart_type == "funnel":
            cfg = _build_funnel(labels, datasets, colors)
        elif chart_type == "progress":
            cfg = _build_progress(labels, datasets, colors)
        elif chart_type == "heatmap":
            cfg = _build_heatmap(labels, datasets)
            if cfg is None:
                return _err("heatmap: empty data",
                            hint="data=[[row,col,value], ...] with at least one entry")
        elif chart_type == "treemap":
            cfg = _build_treemap(labels, datasets)
            if cfg is None:
                return _err("treemap: empty tree", hint="tree=[{name, value}, ...]")
        elif chart_type == "sunburst":
            cfg = _build_sunburst(labels, datasets)
            if cfg is None:
                return _err("sunburst: empty tree",
                            hint="tree=[{name, value, children?}, ...]")
        elif chart_type in ("boxplot", "violin"):
            cfg = _build_boxplot(labels, datasets, chart_type)
        elif chart_type in ("candlestick", "ohlc"):
            cfg = _build_financial(labels, datasets, chart_type)
        elif chart_type == "sankey":
            cfg = _build_sankey(labels, datasets)
        elif chart_type in ("pie_of_pie", "bar_of_pie"):
            cfg = _build_pie_of_pie(labels, datasets, chart_type, palette)
            if cfg is None:
                return _err("pie_of_pie: no data", hint="data=[...], labels=[...]")

        if cfg is not None:
            if title:
                if cfg.get("_composite"):
                    # Two-canvas composite: the title belongs on the primary chart.
                    cfg["primary"].setdefault("options", {}).setdefault("plugins", {})[
                        "title"] = {"display": True, "text": title,
                                    "font": {"size": 14, "weight": "bold"}}
                elif "plugins" in cfg.get("options", {}):
                    cfg["options"]["plugins"].setdefault("title", {
                        "display": True, "text": title,
                        "font": {"size": 14, "weight": "bold"}})
            _apply_animation(cfg, animation, chart_type)
            if gradient:
                _apply_gradient(cfg, chart_type)
            if decimation:
                _apply_decimation(cfg, chart_type)
            if config_override:
                cfg = _deep_merge(cfg, config_override)
            return _finish_chart(cfg, chart_type, datasets, _username)

        # Standard types
        real_type = {"area": "line", "stepped": "line"}.get(chart_type, chart_type)
        n_ds = len(datasets)
        built = [_build_dataset(ds, i, chart_type, colors, total_datasets=n_ds, palette=palette)
                 for i, ds in enumerate(datasets)]

        cfg = {
            "type": real_type,
            "data": {"labels": labels, "datasets": built},
            "options": {
                "responsive": True,
                "maintainAspectRatio": aspect_ratio is not None,
                "plugins": {"legend": {"display": legend, "position": "bottom",
                                       "labels": {"font": {"size": 11}}}},
            },
        }
        if aspect_ratio:
            cfg["options"]["aspectRatio"] = aspect_ratio

        if title:
            tc = {"display": True, "text": title, "font": {"size": 14, "weight": "bold"}}
            if subtitle:
                tc["text"] = [title, subtitle]
                tc["font"] = [{"size": 14, "weight": "bold"},
                              {"size": 11, "weight": "normal", "style": "italic"}]
            cfg["options"]["plugins"]["title"] = tc

        if horizontal and real_type == "bar":
            cfg["options"]["indexAxis"] = "y"

        # Scales
        scales = {}
        if real_type not in ("pie", "doughnut", "polarArea", "radar"):
            yc = {}
            if y_min is not None: yc["min"] = y_min
            if y_max is not None: yc["max"] = y_max
            if y_label: yc["title"] = {"display": True, "text": y_label}
            if stacked: yc["stacked"] = True
            if log_scale: yc["type"] = "logarithmic"
            if yc: scales["y"] = yc

            if any(ds.get("yAxisID") == "y2" for ds in datasets) or y2_label:
                y2 = {"position": "right", "grid": {"drawOnChartArea": False}}
                if y2_label: y2["title"] = {"display": True, "text": y2_label}
                scales["y2"] = y2
                scales.setdefault("y", {})

            xc = {}
            if x_label: xc["title"] = {"display": True, "text": x_label}
            if stacked: xc["stacked"] = True
            if time_axis:
                xc["type"] = "time"
                xc["time"] = {"tooltipFormat": "PP",
                              "displayFormats": {"day": "d MMM", "week": "d MMM",
                                                 "month": "MMM yyyy", "year": "yyyy"}}
            if xc: scales["x"] = xc

        if scales: cfg["options"]["scales"] = scales
        if annotations:
            cfg["options"]["plugins"].update(_build_annotations(annotations))
        if show_values:
            cfg["options"]["plugins"]["datalabels"] = {
                "display": True, "color": "#475569",
                "font": {"size": 11, "weight": "bold"},
                "anchor": "end" if chart_type == "bar" else "center",
                "align": "end" if chart_type == "bar" else "center",
            }
        _apply_animation(cfg, animation, chart_type)
        if gradient:
            _apply_gradient(cfg, chart_type)
        if decimation:
            _apply_decimation(cfg, chart_type)
        if config_override:
            cfg = _deep_merge(cfg, config_override)

        return _finish_chart(cfg, chart_type, datasets, _username)

    # ── The 4 family-focused chart tools (thin wrappers over _core) ───────
    @mcp.tool(**_TOOL_KW_IDEMP)
    def chart_trend(
        ctx: Context,
        chart_type: str,
        labels: List[str] = [],
        datasets: List[Dict[str, Any]] = [],
        title: str = "",
        subtitle: str = "",
        stacked: bool = False,
        horizontal: bool = False,
        palette: str = "vibrant",
        legend: bool = True,
        y_min: Optional[float] = None,
        y_max: Optional[float] = None,
        x_label: str = "",
        y_label: str = "",
        y2_label: str = "",
        time_axis: bool = False,
        log_scale: bool = False,
        show_values: bool = False,
        annotations: List[Dict[str, Any]] = [],
        aspect_ratio: Optional[float] = None,
        animation: str = "default",
        gradient: bool = False,
        decimation: bool = False,
        config_override: Dict[str, Any] = {},
    ) -> Union[GenerateChartResult, ErrEnvelope]:
        """Comparisons & trends over categories/time. Saves the chart, returns a handle.

chart_type: bar | line | area | stepped | radar | polarArea.
Result `ref` is a one-token handle like `!a1b2c3d4e5f6` — put it on its OWN line
(no backticks) where the chart should appear; the UI renders it.

DATASETS: [{"label":"Name","data":[10,20,30]}] + per-dataset color, type (mixed
  charts), fill, tension, yAxisID:"y2" (dual axis), stack, order.
OPTIONS: stacked, horizontal (bar), y2_label, time_axis (ISO date labels), log_scale,
  annotations=[{type:"line",value,axis,label}], show_values.
animation: default | none | grow | fade | sweep | stagger | progressive.
gradient=True: gradient fill. decimation=True: LTTB downsampling for huge series.
PALETTES: vibrant, pastel, dark, mono, warm, cool, earth, neon."""
        return _core(
            get_username(ctx), chart_type, labels=labels, datasets=datasets, title=title,
            subtitle=subtitle, stacked=stacked, horizontal=horizontal, palette=palette,
            legend=legend, y_min=y_min, y_max=y_max, x_label=x_label, y_label=y_label,
            y2_label=y2_label, time_axis=time_axis, log_scale=log_scale,
            show_values=show_values, annotations=annotations, aspect_ratio=aspect_ratio,
            animation=animation, gradient=gradient, decimation=decimation,
            config_override=config_override, allowed=TREND_TYPES, tool_name="chart_trend")

    @mcp.tool(**_TOOL_KW_IDEMP)
    def chart_proportion(
        ctx: Context,
        chart_type: str,
        labels: List[str] = [],
        datasets: List[Dict[str, Any]] = [],
        title: str = "",
        subtitle: str = "",
        palette: str = "vibrant",
        legend: bool = True,
        animation: str = "default",
        config_override: Dict[str, Any] = {},
    ) -> Union[GenerateChartResult, ErrEnvelope]:
        """Parts of a whole & hierarchies. Saves the chart, returns a handle.

chart_type: pie | doughnut | gauge | funnel | progress | treemap | sunburst |
  pie_of_pie | bar_of_pie. Result `ref` (e.g. `!a1b2c3d4e5f6`) goes on its OWN line
  (no backticks) where the chart should appear.

DATA by type:
  pie/doughnut/funnel/progress: [{"data":[40,35,25]}], labels=slice names.
  gauge   : [{"data":[75],"max":100,"unit":"%"}].
  treemap : [{"tree":[{name,value}, ...]}].
  sunburst: [{"tree":[{name,value,children:[...]}, ...]}].
  pie_of_pie/bar_of_pie: normal pie series; smallest slices collapse into an "Autres"
    slice exploded in a 2nd chart. Per-dataset: explode=[labels] | split_threshold=<pct>
    | split_count=<n, default 3>, split_label.
animation: default | none | grow | fade | sweep | stagger | progressive.
PALETTES: vibrant, pastel, dark, mono, warm, cool, earth, neon."""
        return _core(
            get_username(ctx), chart_type, labels=labels, datasets=datasets, title=title,
            subtitle=subtitle, palette=palette, legend=legend, animation=animation,
            config_override=config_override, allowed=PROPORTION_TYPES,
            tool_name="chart_proportion")

    @mcp.tool(**_TOOL_KW_IDEMP)
    def chart_distribution(
        ctx: Context,
        chart_type: str,
        labels: List[str] = [],
        datasets: List[Dict[str, Any]] = [],
        title: str = "",
        subtitle: str = "",
        palette: str = "vibrant",
        legend: bool = True,
        x_label: str = "",
        y_label: str = "",
        log_scale: bool = False,
        animation: str = "default",
        gradient: bool = False,
        config_override: Dict[str, Any] = {},
    ) -> Union[GenerateChartResult, ErrEnvelope]:
        """Distributions & correlations. Saves the chart, returns a handle.

chart_type: scatter | bubble | heatmap | boxplot | violin. Result `ref` (e.g.
  `!a1b2c3d4e5f6`) goes on its OWN line (no backticks) where the chart should appear.

DATA by type:
  scatter : [{"data":[{x,y}, ...]}].   bubble: [{"data":[{x,y,r}, ...]}].
  heatmap : [{"data":[[row,col,value], ...], "rows":[...], "cols":[...]}].
  boxplot/violin: [{"data":[[raw,samples], ...]}], labels=group names.
animation: default | none | grow | fade | stagger. gradient=True for point fills.
PALETTES: vibrant, pastel, dark, mono, warm, cool, earth, neon."""
        return _core(
            get_username(ctx), chart_type, labels=labels, datasets=datasets, title=title,
            subtitle=subtitle, palette=palette, legend=legend, x_label=x_label,
            y_label=y_label, log_scale=log_scale, animation=animation, gradient=gradient,
            config_override=config_override, allowed=DISTRIBUTION_TYPES,
            tool_name="chart_distribution")

    @mcp.tool(**_TOOL_KW_IDEMP)
    def chart_financial(
        ctx: Context,
        chart_type: str,
        labels: List[str] = [],
        datasets: List[Dict[str, Any]] = [],
        title: str = "",
        subtitle: str = "",
        palette: str = "vibrant",
        legend: bool = True,
        animation: str = "default",
        config_override: Dict[str, Any] = {},
    ) -> Union[GenerateChartResult, ErrEnvelope]:
        """Finance & flow. Saves the chart, returns a handle.

chart_type: candlestick | ohlc | waterfall | sankey. Result `ref` (e.g. `!a1b2c3d4e5f6`)
  goes on its OWN line (no backticks) where the chart should appear.

DATA by type:
  candlestick/ohlc: [{"data":[{x:"2024-01-02",o,h,l,c}, ...]}]  (date x-axis).
  waterfall       : [{"data":[+10,-5,+3]}]  (cumulative up/down), labels=step names.
  sankey          : [{"data":[{from,to,flow}, ...], "labels":{id:"Display"}}].
animation: default | none | grow | fade | stagger.
PALETTES: vibrant, pastel, dark, mono, warm, cool, earth, neon."""
        return _core(
            get_username(ctx), chart_type, labels=labels, datasets=datasets, title=title,
            subtitle=subtitle, palette=palette, legend=legend, animation=animation,
            config_override=config_override, allowed=FINANCIAL_TYPES,
            tool_name="chart_financial")

    # ── generate_table ───────────────────────────────────────────────────
    @mcp.tool(**_TOOL_KW_IDEMP)
    def generate_table(
        ctx: Context,
        headers: List[str],
        rows: List[List[Any]],
        format: str = "markdown",
        title: str = "",
        align: List[str] = [],
        max_col_width: int = 60,
        totals_row: bool = False,
        totals_cols: List[int] = [],
        footnote: str = "",
    ) -> Union[GenerateTableResult, ErrEnvelope]:
        """Generate a formatted table for inclusion in a chat reply.

  format='markdown' (default) | 'html' | 'csv'
  align=['left','right','center', ...]  per-column alignment (markdown+html)
  totals_row=True + totals_cols=[1,2,...]  appends a Totals row summing numeric cols
  max_col_width : truncate long cells (markdown/html only)
  footnote : small note appended under the table

Returns {ok, format, table_markdown (or table_html / table_csv), rows_count}."""
        _username = get_username(ctx)
        if not headers:
            return _err("headers required")
        if not isinstance(rows, list):
            return _err("rows must be a list of lists")
        ncols = len(headers)
        for i, r in enumerate(rows):
            if not isinstance(r, list):
                return _err(f"row {i} must be a list")
            if len(r) != ncols:
                return _err(f"row {i} has {len(r)} cells, expected {ncols}",
                            hint="Pad with '' or None to match header count.")

        def _cell_str(v):
            if v is None: return ""
            if isinstance(v, float):
                if v != v: return ""  # NaN
                if v == int(v): return str(int(v))
                return f"{v:.4g}"
            s = str(v)
            if max_col_width and len(s) > max_col_width:
                s = s[:max_col_width-1] + "…"
            return s

        # Totals row
        final_rows = list(rows)
        if totals_row and totals_cols:
            t_row = [""] * ncols
            t_row[0] = "Total"
            for col_idx in totals_cols:
                if 0 <= col_idx < ncols:
                    try:
                        total = sum(
                            float(r[col_idx]) for r in rows
                            if r[col_idx] not in (None, "")
                               and isinstance(r[col_idx], (int, float))
                        )
                        if total == int(total):
                            t_row[col_idx] = str(int(total))
                        else:
                            t_row[col_idx] = f"{total:.4g}"
                    except Exception:
                        t_row[col_idx] = "?"
            final_rows.append(t_row)

        fmt = (format or "markdown").strip().lower()

        # Whitelist d'alignement — la valeur finit dans un style CSS HTML
        # (``text-align:{a}``) → sans whitelist, un align contrôlé pourrait casser
        # le contexte CSS (injection). Limité aux valeurs légitimes.
        def _safe_align(a_val):
            a_val = str(a_val or "").lower()
            return a_val if a_val in ("left", "center", "right") else "left"

        if fmt == "markdown":
            # Align row
            align_markers = []
            for i in range(ncols):
                a = (align[i] if i < len(align) else "left").lower()
                if a == "right":    align_markers.append("---:")
                elif a == "center": align_markers.append(":---:")
                else:               align_markers.append(":---")
            parts = []
            if title:
                parts.append(f"**{title}**\n")
            parts.append("| " + " | ".join(_cell_str(h) for h in headers) + " |")
            parts.append("| " + " | ".join(align_markers) + " |")
            for r in final_rows:
                parts.append("| " + " | ".join(_cell_str(v) for v in r) + " |")
            if footnote:
                _fn = str(footnote).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                parts.append(f"\n<sub>{_fn}</sub>")
            table_md = "\n".join(parts)
            return {"ok": True, "format": "markdown",
                    "table_markdown": table_md,
                    "rows_count": len(final_rows),
                    "hint": "Include table_markdown as-is in your response."}

        if fmt == "html":
            def _esc(s):
                return (s.replace("&","&amp;").replace("<","&lt;")
                         .replace(">","&gt;").replace('"',"&quot;"))
            parts = []
            if title:
                parts.append(f"<h4>{_esc(title)}</h4>")
            parts.append('<table class="md-table">')
            parts.append("<thead><tr>")
            for i, h in enumerate(headers):
                a = _safe_align(align[i] if i < len(align) else "left")
                parts.append(f'<th style="text-align:{a}">{_esc(_cell_str(h))}</th>')
            parts.append("</tr></thead>")
            parts.append("<tbody>")
            for r_i, r in enumerate(final_rows):
                is_total = (totals_row and totals_cols and r_i == len(final_rows) - 1)
                tr_class = ' class="totals"' if is_total else ""
                parts.append(f"<tr{tr_class}>")
                for i, v in enumerate(r):
                    a = _safe_align(align[i] if i < len(align) else "left")
                    parts.append(f'<td style="text-align:{a}">{_esc(_cell_str(v))}</td>')
                parts.append("</tr>")
            parts.append("</tbody></table>")
            if footnote:
                parts.append(f'<p class="footnote"><small>{_esc(footnote)}</small></p>')
            return {"ok": True, "format": "html",
                    "table_html": "\n".join(parts),
                    "rows_count": len(final_rows)}

        if fmt == "csv":
            def _csv_cell(v):
                s = _cell_str(v) if v is not None else ""
                if any(c in s for c in ',"\n\r'):
                    s = '"' + s.replace('"', '""') + '"'
                return s
            lines = [",".join(_csv_cell(h) for h in headers)]
            for r in final_rows:
                lines.append(",".join(_csv_cell(v) for v in r))
            return {"ok": True, "format": "csv",
                    "table_csv": "\n".join(lines),
                    "rows_count": len(final_rows)}

        return _err(f"unknown format '{format}'", hint="Use: markdown | html | csv")

    # ── Resource: a stored chart config by id ────────────────────────
    # Lets an MCP client (e.g. the agentic pipeline) fetch a chart by id
    # instead of carrying the config in context.
    @mcp.resource("chart://{username}/{chart_id}",
                  mime_type="application/json", **tag_kw(CATEGORY))
    def chart_resource(username: str, chart_id: str) -> str:
        """A previously generated Chart.js config, as JSON."""
        safe_id = "".join(c for c in (chart_id or "") if c.isalnum())
        path = _charts_dir(username, root_base) / f"{safe_id}.json"
        if not path.is_file():
            return json.dumps({"ok": False, "error": "chart_not_found",
                               "chart_id": chart_id})
        return path.read_text(encoding="utf-8")
