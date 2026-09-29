# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_chart_tools_robust.py

Robustesse des tools graphiques (llm_core/tools/chart_tools.py).

Régressions couvertes :
- heatmap : la validation acceptait des nombres plats et rejetait le format
  documenté [[row,col,value], ...] → heatmap totalement cassé.
- builders composites (gauge/waterfall/funnel/progress/heatmap) : la validation
  autorise des ``null`` dans data, mais l'arithmétique (mx - v, running + v,
  sorted, min/max) levait TypeError sur None / ValueError sur un ``max`` non
  numérique → exception brute au lieu d'un résultat d'outil propre.

On teste les helpers module-level (pas besoin d'un serveur FastMCP).
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from llm_core.tools.chart_tools import (  # noqa: E402
    _build_funnel,
    _build_gauge,
    _build_heatmap,
    _build_progress,
    _build_waterfall,
    _c,
    _num,
    _validate_datasets,
)

COLORS = _c(8, "vibrant")


# ── _num ───────────────────────────────────────────────────────────────
def test_num_coerces_safely():
    assert _num(5) == 5.0
    assert _num("3.5") == 3.5
    assert _num(None) == 0.0
    assert _num(None, 100.0) == 100.0
    assert _num("not-a-number") == 0.0
    assert _num([1, 2]) == 0.0  # liste → default, pas de crash


# ── heatmap validation (le gros bug) ───────────────────────────────────
def test_heatmap_validation_accepts_matrix_list():
    assert _validate_datasets("heatmap", [], [{"data": [[0, 0, 5], [0, 1, 3]]}]) is None


def test_heatmap_validation_accepts_dict_cells():
    assert _validate_datasets(
        "heatmap", [], [{"data": [{"row": 0, "col": 0, "value": 5}]}]
    ) is None


def test_heatmap_validation_rejects_flat_numbers():
    # Un heatmap avec des nombres plats n'a pas de sens → erreur explicite.
    res = _validate_datasets("heatmap", [], [{"data": [1, 2, 3]}])
    assert isinstance(res, dict) and res.get("ok") is False


def test_bar_still_requires_numbers():
    # Non-régression : la branche numérique standard reste stricte.
    res = _validate_datasets("bar", ["a"], [{"data": [[1, 2]]}])
    assert isinstance(res, dict) and res.get("ok") is False


# ── composite builders : None / non numérique ne crashent plus ─────────
def test_progress_handles_none_and_bad_max():
    cfg = _build_progress([], [{"data": [75, None, 40], "max": "oops"}], COLORS)
    assert cfg and cfg["type"] == "bar"
    # "Remaining" calculé sans TypeError (max par défaut 100).
    remaining = cfg["data"]["datasets"][1]["data"]
    assert all(isinstance(x, (int, float)) for x in remaining)


def test_gauge_handles_none_value_and_bad_max():
    cfg = _build_gauge([], [{"data": [None], "max": "abc", "unit": "%"}], COLORS, "")
    assert cfg and cfg["type"] == "doughnut"
    vals = cfg["data"]["datasets"][0]["data"]
    assert all(isinstance(x, (int, float)) for x in vals)


def test_waterfall_handles_none():
    cfg = _build_waterfall([], [{"data": [10, None, 5]}], COLORS)
    assert cfg and cfg["type"] == "bar"
    bars = cfg["data"]["datasets"][0]["data"]
    assert len(bars) == 3  # None traité comme 0, pas de crash


def test_funnel_handles_none_no_sort_crash():
    # sorted() sur [1000, None, 300] lèverait TypeError sans coercition.
    cfg = _build_funnel([], [{"data": [1000, None, 300]}], COLORS)
    assert cfg and cfg["type"] == "bar"
    assert len(cfg["data"]["datasets"][0]["data"]) == 3


def test_heatmap_build_handles_bad_value():
    cfg = _build_heatmap([], [{"data": [[0, 0, "x"], [0, 1, 3]]}])
    # Heatmap now renders via the chartjs-chart-matrix controller (category axes carry
    # the row/col labels; the old scatter fallback lost them).
    assert cfg and cfg["type"] == "matrix"
    # min/max calculés sur des floats coercés (pas de TypeError mixte).
    assert len(cfg["data"]["datasets"][0]["data"]) == 2
