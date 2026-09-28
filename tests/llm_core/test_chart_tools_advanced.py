# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_chart_tools_advanced.py

Couvre les ajouts de la vague « fiabiliser + enrichir les graphiques » :
- validation durcie (NaN/Inf/bool, plafonds, radar/pie longueur, gauge exempt,
  scatter typé, data vide, _deep_merge borné) ;
- options réparées (gauge centerText, heatmap → matrix, time_axis) ;
- familles avancées (treemap, sunburst, boxplot, financial, sankey, pie_of_pie) ;
- generate_chart / generate_table de bout en bout via un stub MCP ;
- helpers de durabilité de la route (scan des refs, embed).

Tout est JSON-only : chaque config produite DOIT se sérialiser avec allow_nan=False
(aucune fonction, aucun NaN) — c'est la garantie du round-trip navigateur.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from llm_core.tools import chart_tools as CT  # noqa: E402


def _is_err(res) -> bool:
    return isinstance(res, dict) and res.get("ok") is False


def _json_safe(cfg):
    """Round-trips exactly like the persistence layer (no NaN/Inf, no functions)."""
    return json.loads(json.dumps(cfg, allow_nan=False))


# ══════════════════════════════════════════════════════════════════════════
#  Validation durcie
# ══════════════════════════════════════════════════════════════════════════

def test_reject_nan_and_inf():
    assert _is_err(CT._validate_datasets("bar", ["a"], [{"data": [float("nan")]}]))
    assert _is_err(CT._validate_datasets("line", ["a"], [{"data": [float("inf")]}]))


def test_reject_bool_data():
    # bool ⊂ int → True/False traçait 1/0 silencieusement.
    assert _is_err(CT._validate_datasets("bar", ["a", "b"], [{"data": [True, False]}]))


def test_radar_length_now_enforced():
    # radar dépend de labels==data ; était exclu à tort du contrôle.
    assert _is_err(CT._validate_datasets("radar", ["a", "b", "c"], [{"data": [1, 2]}]))
    assert CT._validate_datasets("radar", ["a", "b", "c"], [{"data": [1, 2, 3]}]) is None


def test_pie_length_mismatch():
    assert _is_err(CT._validate_datasets("pie", ["a", "b", "c"], [{"data": [1, 2]}]))
    assert CT._validate_datasets("pie", ["a", "b", "c"], [{"data": [1, 2, 3]}]) is None


def test_gauge_exempt_from_length_check():
    # gauge n'utilise que data[0] : labels plus longs ne doivent PAS être rejetés.
    assert CT._validate_datasets("gauge", ["Value", "extra"], [{"data": [75]}]) is None


def test_size_caps():
    over_ds = [{"data": [1]} for _ in range(CT.MAX_DATASETS + 1)]
    assert _is_err(CT._validate_datasets("bar", ["a"], over_ds))
    assert _is_err(CT._validate_datasets("line", [], [{"data": [0] * (CT.MAX_POINTS_PER_DATASET + 1)}]))


def test_empty_data_rejected():
    assert _is_err(CT._validate_datasets("bar", ["a"], [{"data": []}]))


def test_scatter_bubble_coord_typing():
    assert _is_err(CT._validate_datasets("scatter", [], [{"data": [{"x": "a", "y": 2}]}]))
    assert _is_err(CT._validate_datasets("bubble", [], [{"data": [{"x": 1, "y": 2}]}]))  # missing r
    assert CT._validate_datasets("bubble", [], [{"data": [{"x": 1, "y": 2, "r": 3}]}]) is None


def test_deep_merge_depth_guard():
    node = deep = {}
    for _ in range(500):
        node["a"] = {}
        node = node["a"]
    # Ne doit pas lever RecursionError.
    assert isinstance(CT._deep_merge({"a": {}}, deep), dict)


# ══════════════════════════════════════════════════════════════════════════
#  Options réparées
# ══════════════════════════════════════════════════════════════════════════

def test_gauge_center_text_reaches_config():
    cfg = CT._build_gauge(["Score"], [{"data": [75], "max": 100, "unit": "%"}], CT._c(4), "")
    ct = cfg["options"]["plugins"]["centerText"]
    assert ct["text"] == "75%" and ct["subtext"] == "/ 100%"
    _json_safe(cfg)


def test_heatmap_is_matrix_with_labels():
    cfg = CT._build_heatmap([], [{"data": [[0, 0, 5], [0, 1, 3], [1, 0, 1]],
                                  "rows": ["r0", "r1"], "cols": ["c0", "c1"]}])
    assert cfg["type"] == "matrix"
    assert cfg["options"]["scales"]["x"]["labels"] == ["c0", "c1"]
    assert cfg["options"]["scales"]["y"]["labels"] == ["r0", "r1"]
    # each cell references its category label + carries the grid hint for the front-end.
    assert cfg["data"]["datasets"][0]["_heatmap"] == {"cols": 2, "rows": 2}
    assert cfg["data"]["datasets"][0]["data"][0]["x"] == "c0"
    _json_safe(cfg)


def test_time_axis_label_validation():
    assert CT._labels_look_like_dates(["2024-01-15", "2024-02-01"]) is None
    assert CT._labels_look_like_dates(["Q1", "Q2"]) == "Q1"


def test_fmt_num():
    assert CT._fmt_num(75.0) == "75"
    assert CT._fmt_num(75.5) == "75.5"
    assert CT._fmt_num("x") == "x"


# ══════════════════════════════════════════════════════════════════════════
#  Familles avancées — builders + validation
# ══════════════════════════════════════════════════════════════════════════

def test_treemap_builder_and_validation():
    assert _is_err(CT._validate_datasets("treemap", [], [{"data": [1, 2]}]))  # needs 'tree'
    assert CT._validate_datasets("treemap", [], [{"tree": [{"name": "A", "value": 1}]}]) is None
    cfg = CT._build_treemap([], [{"label": "T", "tree": [{"name": "A", "value": 10},
                                                         {"name": "B", "value": 5}]}])
    assert cfg["type"] == "treemap"
    assert cfg["data"]["datasets"][0]["key"] == "value"
    _json_safe(cfg)


def test_sunburst_builds_concentric_rings():
    cfg = CT._build_sunburst([], [{"tree": [
        {"name": "A", "value": 10, "children": [{"name": "a1", "value": 6},
                                                {"name": "a2", "value": 4}]},
        {"name": "B", "value": 5},
    ]}])
    assert cfg["type"] == "doughnut"
    # two hierarchy levels → two ring datasets.
    assert len(cfg["data"]["datasets"]) == 2
    _json_safe(cfg)


def test_boxplot_and_violin():
    assert CT._validate_datasets("boxplot", ["g"], [{"data": [[1, 2, 3]]}]) is None
    assert _is_err(CT._validate_datasets("boxplot", ["g"], [{"data": [5]}]))  # bare scalar
    cfg = CT._build_boxplot(["G1", "G2"], [{"label": "S", "data": [[1, 2, 3, 4], [2, 3, 4]]}])
    assert cfg["type"] == "boxplot"
    cfgv = CT._build_boxplot(["G1"], [{"data": [[1, 2, 3]]}], "violin")
    assert cfgv["type"] == "violin"
    _json_safe(cfg)
    _json_safe(cfgv)


def test_financial_needs_ohlc():
    assert _is_err(CT._validate_datasets("candlestick", [], [{"data": [{"x": 1, "o": 1}]}]))
    ok_data = [{"data": [{"x": "2024-01-02", "o": 1, "h": 2, "l": 0.5, "c": 1.5}]}]
    assert CT._validate_datasets("candlestick", [], ok_data) is None
    cfg = CT._build_financial([], ok_data, "candlestick")
    assert cfg["type"] == "candlestick"
    assert cfg["options"]["scales"]["x"]["type"] == "time"
    _json_safe(cfg)


def test_sankey_shape():
    assert _is_err(CT._validate_datasets("sankey", [], [{"data": [{"from": "A"}]}]))
    ok_data = [{"data": [{"from": "A", "to": "B", "flow": 5}]}]
    assert CT._validate_datasets("sankey", [], ok_data) is None
    cfg = CT._build_sankey([], ok_data)
    assert cfg["type"] == "sankey"
    _json_safe(cfg)


def test_pie_of_pie_split_smallest_n():
    cfg = CT._build_pie_of_pie(["A", "B", "C", "D", "E"], [{"data": [50, 30, 10, 6, 4]}],
                               "pie_of_pie")
    assert cfg["_composite"] == "pie_of_pie"
    # smallest 3 (C=10,D=6,E=4) collapse into "Autres" (=20); A,B stay major.
    assert cfg["primary"]["data"]["labels"] == ["A", "B", "Autres"]
    assert cfg["primary"]["data"]["datasets"][0]["data"][-1] == 20.0
    assert [m["label"] for m in cfg["split"]["members"]] == ["C", "D", "E"]
    _json_safe(cfg)


def test_pie_of_pie_explicit_explode_and_bar_variant():
    cfg = CT._build_pie_of_pie(["A", "B", "C"], [{"data": [50, 30, 20], "explode": ["B", "C"]}],
                               "bar_of_pie")
    assert cfg["variant"] == "bar_of_pie"
    assert cfg["secondary"]["type"] == "bar"
    assert cfg["primary"]["data"]["labels"] == ["A", "Autres"]
    assert {m["label"] for m in cfg["split"]["members"]} == {"B", "C"}


# ══════════════════════════════════════════════════════════════════════════
#  generate_chart / generate_table de bout en bout (stub MCP)
# ══════════════════════════════════════════════════════════════════════════

class _StubMCP:
    def __init__(self):
        self.tools = {}

    def tool(self, **_kw):
        def deco(fn):
            self.tools[fn.__name__] = fn
            return fn
        return deco

    def resource(self, *_a, **_kw):
        def deco(fn):
            return fn
        return deco


def _tools(tmp_path, monkeypatch):
    monkeypatch.setenv("CHART_CACHE_DIR", str(tmp_path))
    mcp = _StubMCP()
    CT.register(mcp, root_base=str(tmp_path))
    return mcp.tools


def test_four_tools_registered(tmp_path, monkeypatch):
    tools = _tools(tmp_path, monkeypatch)
    assert {"chart_trend", "chart_proportion", "chart_distribution",
            "chart_financial", "generate_table"} <= set(tools)
    assert "generate_chart" not in tools   # the fat tool is gone


def test_chart_trend_end_to_end_bar(tmp_path, monkeypatch):
    fn = _tools(tmp_path, monkeypatch)["chart_trend"]
    res = fn(ctx=None, chart_type="bar", labels=["Q1", "Q2"],
             datasets=[{"label": "Rev", "data": [10, 20]}], title="T")
    assert res["ok"] is True
    assert res["ref"].startswith("!") and res["chart_type"] == "bar"
    stored = json.loads((tmp_path / "guest" / f"{res['chart_id']}.json").read_text())
    assert stored["type"] == "bar"
    assert stored["options"]["plugins"]["title"]["text"] == "T"


def test_chart_proportion_composite_persisted(tmp_path, monkeypatch):
    fn = _tools(tmp_path, monkeypatch)["chart_proportion"]
    res = fn(ctx=None, chart_type="pie_of_pie", labels=["A", "B", "C", "D"],
             datasets=[{"data": [40, 30, 20, 10]}], title="Share")
    assert res["ok"] is True
    stored = json.loads((tmp_path / "guest" / f"{res['chart_id']}.json").read_text())
    assert stored["_composite"] == "pie_of_pie"
    assert stored["primary"]["options"]["plugins"]["title"]["text"] == "Share"


def test_family_scoping_points_to_right_tool(tmp_path, monkeypatch):
    tools = _tools(tmp_path, monkeypatch)
    # a proportion type asked from the trend tool → rejected with a redirect hint.
    err = tools["chart_trend"](ctx=None, chart_type="pie", labels=["a"], datasets=[{"data": [1]}])
    assert _is_err(err) and "chart_proportion" in (err.get("fix") or "")
    err2 = tools["chart_financial"](ctx=None, chart_type="bar", datasets=[{"data": [1]}])
    assert _is_err(err2) and "chart_trend" in (err2.get("fix") or "")


def test_chart_trend_rejects_nan(tmp_path, monkeypatch):
    fn = _tools(tmp_path, monkeypatch)["chart_trend"]
    assert _is_err(fn(ctx=None, chart_type="bar", labels=["a"],
                      datasets=[{"data": [float("nan")]}]))


def test_animation_presets(tmp_path, monkeypatch):
    tools = _tools(tmp_path, monkeypatch)
    base = tmp_path / "guest"

    def cfg(res):
        return json.loads((base / f"{res['chart_id']}.json").read_text())

    # stagger → client-injection hint on options._anim
    r = tools["chart_trend"](ctx=None, chart_type="bar", labels=["a", "b"],
                             datasets=[{"data": [1, 2]}], animation="stagger")
    assert cfg(r)["options"]["_anim"]["mode"] == "stagger"

    # progressive → hint (line only)
    r = tools["chart_trend"](ctx=None, chart_type="line", labels=["a", "b", "c"],
                             datasets=[{"data": [1, 2, 3]}], animation="progressive")
    assert cfg(r)["options"]["_anim"]["mode"] == "progressive"

    # none → animation disabled (pure JSON)
    r = tools["chart_trend"](ctx=None, chart_type="bar", labels=["a"],
                             datasets=[{"data": [1]}], animation="none")
    assert cfg(r)["options"]["animation"] is False

    # grow on a radial type → animateScale (pure JSON)
    r = tools["chart_proportion"](ctx=None, chart_type="doughnut", labels=["a", "b"],
                                  datasets=[{"data": [1, 2]}], animation="grow")
    assert cfg(r)["options"]["animation"]["animateScale"] is True

    # unknown preset falls back silently (no crash)
    r = tools["chart_trend"](ctx=None, chart_type="bar", labels=["a"],
                             datasets=[{"data": [1]}], animation="bogus")
    assert r["ok"] is True


def test_gradient_and_decimation_hints(tmp_path, monkeypatch):
    tools = _tools(tmp_path, monkeypatch)
    base = tmp_path / "guest"

    def cfg(res):
        return json.loads((base / f"{res['chart_id']}.json").read_text())

    r = tools["chart_trend"](ctx=None, chart_type="line", labels=["a", "b"],
                             datasets=[{"data": [1, 2]}], gradient=True, decimation=True)
    c = cfg(r)
    assert c["data"]["datasets"][0]["_gradient"] is True
    assert c["options"]["plugins"]["decimation"]["algorithm"] == "lttb"
    # gradient is a no-op on non-fill types (pie)
    r2 = tools["chart_proportion"](ctx=None, chart_type="pie", labels=["a", "b"],
                                   datasets=[{"data": [1, 2]}])
    assert "_gradient" not in cfg(r2)["data"]["datasets"][0]


def test_generate_table_markdown_html_csv(tmp_path, monkeypatch):
    fn = _tools(tmp_path, monkeypatch)["generate_table"]
    md = fn(ctx=None, headers=["Name", "Score"], rows=[["Alice", 92], ["Bob", 87]])
    assert md["ok"] and "| Alice | 92 |" in md["table_markdown"]

    tot = fn(ctx=None, headers=["Item", "Qty"], rows=[["A", 3], ["B", 5]],
             totals_row=True, totals_cols=[1])
    assert "Total" in tot["table_markdown"] and "| 8 |" in tot["table_markdown"]

    csv = fn(ctx=None, headers=["a", "b"], rows=[["x,y", 'q"z']], format="csv")
    assert '"x,y"' in csv["table_csv"] and '"q""z"' in csv["table_csv"]


def test_generate_table_html_escapes_and_whitelists_align(tmp_path, monkeypatch):
    fn = _tools(tmp_path, monkeypatch)["generate_table"]
    res = fn(ctx=None, headers=["<x>"], rows=[["<b>hi</b>"]], format="html",
             align=["right; color:red"])   # malicious align must be dropped
    html = res["table_html"]
    assert "&lt;x&gt;" in html and "&lt;b&gt;hi" in html
    assert "color:red" not in html          # _safe_align whitelist → falls back to 'left'
    assert "text-align:left" in html


def test_generate_table_row_length_mismatch(tmp_path, monkeypatch):
    fn = _tools(tmp_path, monkeypatch)["generate_table"]
    assert _is_err(fn(ctx=None, headers=["a", "b"], rows=[["only-one"]]))


# ══════════════════════════════════════════════════════════════════════════
#  Route : durabilité des refs
# ══════════════════════════════════════════════════════════════════════════

def test_route_scan_chart_ref_ids():
    from shared_infra.charts import routes as R
    ids = R._scan_chart_ref_ids("intro !a1b2c3d4e5f6 then\n```chart-ref\nffeeddccbbaa\n```")
    assert ids == {"a1b2c3d4e5f6", "ffeeddccbbaa"}
    # a bare hex colour / short sha must NOT be mistaken for a 12-hex ref.
    assert R._scan_chart_ref_ids("colour #a1b2c3 and sha 1234567") == set()


def test_route_embed_chart_configs(tmp_path, monkeypatch):
    from shared_infra.charts import routes as R
    monkeypatch.setenv("CHART_CACHE_DIR", str(tmp_path))
    # seed a cache file for user 'guest'
    cid = "0123456789ab"
    d = tmp_path / "guest"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{cid}.json").write_text(json.dumps({"type": "bar", "data": {"datasets": []}}))

    monkeypatch.setattr(R, "get_username_by_id", lambda uid: "guest")
    monkeypatch.setattr(R, "get_chat", lambda uid, cid_: None)

    msgs = [{"role": "assistant", "content": f"here !{cid} done"}]
    out = R.embed_chart_configs(1, "chatX", msgs)
    assert out[0]["charts"][cid]["type"] == "bar"
