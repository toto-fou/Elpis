# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_chart_tools.py

Outils graphiques ``chart_<type>`` (rendu ECharts) :
- lecture tolérante (types, nombres « 1 234,5 € », formes de données, colonnes) ;
- les 30 types compilent une option JSON pure (aucune fonction, aucun NaN) ;
- cas relevés au banc ornith-1.5-9B (cascade écarts + cumuls, heatmap
  « Lundi matin », group numérique, group = catégorie) ;
- garde-fou anti-boucle (appel identique déjà refusé) ;
- outils de bout en bout (stub MCP + vrai FastMCP pour les schémas) ;
- helpers de durabilité de la route (scan des refs, embed).
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from llm_core.tools import chart_tools as CT  # noqa: E402
from llm_core.tools._chart import PER_TYPE, run_chart  # noqa: E402
from llm_core.tools._chart.normalise import (  # noqa: E402
    Notes,
    fold,
    resolve_kind,
    to_number,
    to_records,
)


def _pur(o) -> bool:
    """Aucune fonction : uniquement des types JSON."""
    if isinstance(o, dict):
        return all(isinstance(k, str) and _pur(v) for k, v in o.items())
    if isinstance(o, list):
        return all(_pur(v) for v in o)
    return o is None or isinstance(o, (str, int, float, bool))


def _run(kind, **args):
    res, opt, drawn = run_chart({"type": kind, **args})
    return res, opt, drawn


# ══════════════════════════════════════════════════════════════════════════
#  Lecture tolérante
# ══════════════════════════════════════════════════════════════════════════

def test_fold_et_types():
    assert fold("polarArea") == "polar_area"
    cas = {"Bar": "bar", "camembert": "pie", "polarArea": "rose", "doughnut": "donut",
           "Nuage de points": "scatter", "scater": "scatter", "OHLC": "candlestick",
           "violin": "boxplot", "Organigramme": "tree"}
    for raw, attendu in cas.items():
        assert resolve_kind(raw)[0] == attendu, raw
    assert resolve_kind("stacked_bar")[:2] == ("bar", {"stacked": True})
    assert resolve_kind("zzz")[0] is None


@pytest.mark.parametrize("raw,valeur,unite", [
    ("1 234,5 €", 1234.5, "€"), ("12 %", 12.0, "%"), ("1,2 M€", 1.2e6, "€"),
    ("(300)", -300.0, None), ("−4", -4.0, None), ("1.234,5", 1234.5, None),
    ("1,234.5", 1234.5, None), ("3,4 j", 3.4, "j"), ("n/a", None, None), ("abc", None, None),
])
def test_nombres(raw, valeur, unite):
    n = to_number(raw)
    assert (n.value, n.unit) == (valeur, unite)


def test_formes_de_donnees():
    n = Notes()
    assert to_records({"a": [1, 2], "b": [3, 4]}, n) == [{"a": 1, "b": 3}, {"a": 2, "b": 4}]
    assert to_records({"Nord": 3}, n) == [{"libellé": "Nord", "valeur": 3}]
    assert to_records([["x", "y"], ["a", 1]], n) == [{"x": "a", "y": 1}]
    assert to_records("r;v\nA;1\nB;2", n) == [{"r": "A", "v": "1"}, {"r": "B", "v": "2"}]
    assert to_records("| r | v |\n|---|---|\n| A | 1 |", n) == [{"r": "A", "v": "1"}]
    assert to_records('[{"a": 1}]', n) == [{"a": 1}]
    assert to_records([{"label": "s", "data": [1, 2]}], n, labels=["x", "y"]) == \
        [{"libellé": "x", "s": 1}, {"libellé": "y", "s": 2}]


def test_colonnes_sans_casse_et_corrections_renvoyees():
    res, _, _ = _run("bar", x="MOIS", y=["Ventes"],
                     data=[{"mois": "a", "ventes": "1 200 €"}, {"mois": "b", "ventes": 2}])
    assert res["ok"] is True
    assert any("column 'mois'" in f for f in res["fixes"])
    assert any("read as numbers" in f for f in res["fixes"])


def test_lignes_vides_refusees_avec_exemple():
    res, opt, _ = _run("table", data=[{}])
    assert res["ok"] is False and opt is None
    assert res["error"] == "invalid_chart_spec" and res["example"]["data"]


# ══════════════════════════════════════════════════════════════════════════
#  Les 30 types : une option JSON pure
# ══════════════════════════════════════════════════════════════════════════

_MOIS = ["janv.", "févr.", "mars", "avr."]
EXEMPLES = {
    "bar": {"data": [{"mois": m, "ventes": v, "coûts": v - 30} for m, v in zip(_MOIS, [120, 98, 143, 160])],
            "lines": [{"value": 130, "label": "objectif"}], "show_values": True},
    "line": {"data": [{"semaine": f"S{i}", "API": 180 + i} for i in range(1, 9)], "trend": True},
    "area": {"data": [{"mois": m, "a": i, "b": 2 * i} for i, m in enumerate(_MOIS, 1)], "stack": "stacked"},
    "stream": {"data": [{"mois": f"2026-0{i}", "canal": c, "n": i * 10 + k}
                        for i in range(1, 5) for k, c in enumerate(["Tél", "Web"])]},
    "radar": {"data": [{"solution": "A", "coût": 7, "sécurité": 9, "support": 8},
                       {"solution": "B", "coût": 9, "sécurité": 6, "support": 6}]},
    "polar_bar": {"data": [{"jour": j, "n": v} for j, v in zip(["lun.", "mar.", "mer."], [8, 9, 7])]},
    "waterfall": {"data": [{"étape": "Budget", "montant": 1200}, {"étape": "Recrutements", "montant": -180},
                           {"étape": "Subvention", "montant": 140}]},
    "pie": {"data": {"Fixe": 45, "Mobile": 35, "Box": 20}},
    "donut": {"data": {"Windows": 1240, "macOS": 180}},
    "rose": {"data": {"Matériel": 34, "Logiciel": 51, "Réseau": 28}},
    "treemap": {"data": [{"direction": d, "service": s, "budget": b} for d, s, b in
                         [("Tech", "Infra", 820), ("Tech", "Dév", 640), ("RH", "Paie", 160)]]},
    "sunburst": {"data": [{"canal": c, "source": s, "visites": v} for c, s, v in
                          [("Recherche", "A", 4200), ("Recherche", "B", 1300), ("Direct", "Favori", 2100)]]},
    "funnel": {"data": {"Visites": 12000, "Formulaire": 4300, "Compte": 1650}},
    "histogram": {"data": [{"âge": 20 + (i * 7) % 40} for i in range(60)]},
    "boxplot": {"data": [{"équipe": e, "délai": v} for e in "AB" for v in (1, 2, 3, 4, 9)]},
    "scatter": {"data": [{"surface": s, "prix": 4 * s} for s in (30, 45, 60, 90)], "trend": True},
    "bubble": {"data": [{"surface": s, "prix": 4 * s, "pièces": s // 20} for s in (30, 45, 60, 90)]},
    "heatmap": {"data": [{"jour": j, "heure": h, "appels": i + k} for i, j in enumerate(["lun.", "mar."])
                         for k, h in enumerate(["9 h", "14 h"])]},
    "calendar": {"data": [{"date": f"2026-01-{d:02d}", "commits": d % 5} for d in range(1, 29)]},
    "parallel": {"data": [{"gamme": g, "cœurs": c, "RAM": r} for g, c, r in [("E", 8, 32), ("H", 64, 512)]]},
    "sankey": {"data": [{"source": "Budget", "target": "Salaires", "value": 62},
                        {"source": "Budget", "target": "Locaux", "value": 18}]},
    "chord": {"data": [{"source": "RH", "target": "Finances", "value": 30},
                       {"source": "Finances", "target": "RH", "value": 12}]},
    "graph": {"data": [{"source": "Portail", "target": "Annuaire"}, {"source": "Portail", "target": "GED"}]},
    "tree": {"data": [{"nom": "DSI", "parent": ""}, {"nom": "Études", "parent": "DSI"}]},
    "gantt": {"data": [{"tâche": "Cadrage", "début": "2026-09-01", "fin": "2026-09-12"},
                       {"tâche": "Pilote", "début": "2026-10-05", "fin": "2026-10-23"}]},
    "candlestick": {"data": [{"date": f"2026-03-0{i}", "open": 100 + i, "high": 104 + i, "low": 99 + i,
                              "close": 102 + i} for i in range(1, 7)], "trend": True},
    "gauge": {"data": [{"indicateur": "Disponibilité", "valeur": 99.2, "max": 100}], "unit": "%"},
    "progress": {"data": [{"chantier": "MFA", "fait": 1210, "total": 1500}]},
    "kpi": {"data": [{"indicateur": "Tickets", "valeur": 1284, "précédent": 1190}]},
    "table": {"data": [{"mesure": "Latence", "valeur": 8, "unité": "ms"}]},
}


def test_exemples_couvrent_tous_les_types():
    assert set(EXEMPLES) == set(PER_TYPE)


@pytest.mark.parametrize("kind", list(PER_TYPE))
def test_chaque_type_compile_une_option_pure(kind):
    res, opt, drawn = _run(kind, **EXEMPLES[kind])
    assert res["ok"] is True, res
    assert res["summary"]
    json.dumps(opt, allow_nan=False)
    assert _pur(opt)
    assert opt["_elpis"]["table"]["columns"]


# ══════════════════════════════════════════════════════════════════════════
#  Cas relevés au banc ornith-1.5-9B (2026-10-04)
# ══════════════════════════════════════════════════════════════════════════

def test_heatmap_avec_noms_pas_d_indices():
    data = [{"jour": j, "heure": h, "appels": v} for j in ("lun.", "mar.", "mer.")
            for h, v in zip(("9 h", "11 h", "14 h"), (4, 9, 12))]
    _, opt, _ = _run("heatmap", data=data)
    cells = {tuple(d["value"][:2]) for d in opt["series"][0]["data"]}
    assert len(cells) == 9


def test_heatmap_dimension_fusionnee():
    res, _, _ = _run("heatmap", data=[{"jour": "Lundi matin", "appels": 12},
                                      {"jour": "Lundi après-midi", "appels": 9},
                                      {"jour": "Mardi matin", "appels": 15},
                                      {"jour": "Mardi après-midi", "appels": 8}])
    assert res["ok"] is True and "2x2" in res["summary"]


def test_cascade_cumuls_et_ecarts():
    res, _, _ = _run("waterfall", x="étape", y=["total"], data=[
        {"étape": "Budget initial", "total": 1200, "variance": 0},
        {"étape": "Recrutements", "total": 1020, "variance": -180},
        {"étape": "Licences", "total": 925, "variance": -95},
        {"étape": "Subvention", "total": 1065, "variance": 140},
        {"étape": "Énergie", "total": 990, "variance": -75}])
    assert "final total 990" in res["summary"]


def test_cascade_total_par_type_ou_par_valeur():
    lignes = [{"étape": "Budget initial", "valeur": 1200, "type": "base"},
              {"étape": "Recrutements", "valeur": -180, "type": "sortie"},
              {"étape": "Subvention", "valeur": 140, "type": "entree"},
              {"étape": "Réalisé", "valeur": 1160, "type": "total"}]
    assert "final total 1 160" in _run("waterfall", data=lignes)[0]["summary"]
    sans_type = [{k: v for k, v in r.items() if k != "type"} for r in lignes]
    assert "final total 1 160" in _run("waterfall", data=sans_type)[0]["summary"]


def test_cascade_total_incoherent_signale():
    res, _, _ = _run("waterfall", data=[{"poste": "Budget initial", "variation": 0, "total": 1200},
                                        {"poste": "Recrutements", "variation": -180, "total": 1020},
                                        {"poste": "Énergie", "variation": -75, "total": 945},
                                        {"poste": "Réalisé", "variation": -300, "total": 900}])
    assert any("add up to" in w for w in res.get("warnings", []))


def test_group_numerique_ou_egal_a_x_ignore():
    data = [{"trimestre": "T1", "2024": 120, "2025": 135}, {"trimestre": "T2", "2024": 98, "2025": 110}]
    assert "series: 2024, 2025" in _run("bar", group="2024", data=data)[0]["summary"]
    assert "series: 2024, 2025" in _run("bar", group="trimestre", y=["2024", "2025"], data=data)[0]["summary"]


def test_sankey_avec_boucle_devient_reseau():
    _, _, drawn = _run("sankey", data=[{"source": "A", "target": "B", "value": 1},
                                       {"source": "B", "target": "A", "value": 1}])
    assert drawn == "graph"


# ══════════════════════════════════════════════════════════════════════════
#  Garde-fou anti-boucle
# ══════════════════════════════════════════════════════════════════════════

def test_appel_identique_deja_refuse():
    a = {"type": "heatmap", "data": [{"jour": "lun.", "appels": 3}]}
    r1, _, _ = run_chart(a, session="u:c1")
    assert r1["error"] == "invalid_chart_spec" and "repeated" not in r1
    r2, _, _ = run_chart(a, session="u:c1")
    assert r2["error"] == "repeated_call" and r2["repeated"] == 2
    assert "do not send it again unchanged" in r2["message"] and r2["next_action"]
    r3, _, _ = run_chart(a, session="u:c2")          # autre conversation : compteur à part
    assert "repeated" not in r3


# ══════════════════════════════════════════════════════════════════════════
#  Outils de bout en bout
# ══════════════════════════════════════════════════════════════════════════

class _StubMCP:
    def __init__(self):
        self.tools = {}

    def tool(self, name=None, **_kw):
        def deco(fn):
            self.tools[name or fn.__name__] = fn
            return fn
        return deco

    def resource(self, *_a, **_kw):
        return lambda fn: fn


def _tools(tmp_path, monkeypatch):
    monkeypatch.setenv("CHART_CACHE_DIR", str(tmp_path))
    mcp = _StubMCP()
    CT.register(mcp, root_base=str(tmp_path))
    return mcp.tools


def test_un_outil_par_type(tmp_path, monkeypatch):
    tools = _tools(tmp_path, monkeypatch)
    assert set(tools) == {f"chart_{k}" for k in PER_TYPE}
    assert not {"chart_trend", "generate_table", "generate_chart"} & set(tools)


def test_chart_bar_persiste_une_option_echarts(tmp_path, monkeypatch):
    res = _tools(tmp_path, monkeypatch)["chart_bar"](
        None, data=[{"trimestre": "T1", "ventes": 10}, {"trimestre": "T2", "ventes": 20}], title="T")
    assert res["ok"] is True and res["ref"] == "!" + res["chart_id"]
    assert res["chart_type"] == "bar"
    stored = json.loads((tmp_path / "guest" / f"{res['chart_id']}.json").read_text())
    assert stored["series"][0]["type"] == "bar" and stored["title"]["text"] == "T"
    assert "fixes" not in res        # valeurs par défaut non transmises → aucune correction parasite


def test_chart_table_remplace_generate_table(tmp_path, monkeypatch):
    res = _tools(tmp_path, monkeypatch)["chart_table"](None, data=[{"mesure": "Latence", "valeur": 8}])
    stored = json.loads((tmp_path / "guest" / f"{res['chart_id']}.json").read_text())
    assert stored["_elpis"]["render"] == "table"
    assert stored["_elpis"]["table"]["rows"] == [["Latence", 8]]


def test_donnees_trop_grandes_refusees(tmp_path, monkeypatch):
    monkeypatch.setattr(CT, "MAX_ROWS", 3)
    res = _tools(tmp_path, monkeypatch)["chart_line"](None, data=[{"x": i, "y": i} for i in range(5)])
    assert res["ok"] is False and "too large" in res["message"]


def test_schemas_fastmcp_enum_et_validation_permissive(tmp_path, monkeypatch):
    """Vrai FastMCP : l'enum est ANNONCÉ (grammaire llama.cpp) mais « Stacked » passe
    quand même la validation et la lecture tolérante le corrige."""
    from fastmcp import Client, FastMCP
    monkeypatch.setenv("CHART_CACHE_DIR", str(tmp_path))
    mcp = FastMCP("t")
    CT.register(mcp, root_base=str(tmp_path))

    async def go():
        async with Client(mcp) as c:
            tools = {t.name: t for t in await c.list_tools()}
            r = await c.call_tool("chart_bar", {"data": [{"m": "a", "v": 1}, {"m": "b", "v": 2}],
                                                "stack": "Stacked"}, raise_on_error=False)
            bad = await c.call_tool("chart_bar", {"data": [{"m": "a", "v": 1}], "palette": "x"},
                                    raise_on_error=False)
            return tools, r, bad
    tools, r, bad = asyncio.run(go())
    assert len(tools) == len(PER_TYPE)
    props = tools["chart_bar"].inputSchema["properties"]
    assert props["stack"]["enum"] == ["none", "stacked", "percent"]
    assert props["data"]["items"]["type"] == "object" and props["data"]["minItems"] == 1
    assert tools["chart_bar"].inputSchema.get("additionalProperties") is False
    assert "stack" not in tools["chart_pie"].inputSchema["properties"]   # options propres au type
    assert not r.is_error and json.loads(r.content[0].text)["summary"].startswith("bar stacked")
    assert bad.is_error                                                  # argument inconnu


# ══════════════════════════════════════════════════════════════════════════
#  Route : durabilité des refs (inchangée)
# ══════════════════════════════════════════════════════════════════════════

def test_route_scan_chart_ref_ids():
    from shared_infra.charts import routes as R
    ids = R._scan_chart_ref_ids("intro !a1b2c3d4e5f6 then\n```chart-ref\nffeeddccbbaa\n```")
    assert ids == {"a1b2c3d4e5f6", "ffeeddccbbaa"}
    assert R._scan_chart_ref_ids("colour #a1b2c3 and sha 1234567") == set()


def test_route_embed_chart_configs(tmp_path, monkeypatch):
    from shared_infra.charts import routes as R
    monkeypatch.setenv("CHART_CACHE_DIR", str(tmp_path))
    cid = "0123456789ab"
    d = tmp_path / "guest"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{cid}.json").write_text(json.dumps({"series": [{"type": "bar"}], "_elpis": {"kind": "bar"}}))
    monkeypatch.setattr(R, "get_username_by_id", lambda uid: "guest")
    monkeypatch.setattr(R, "get_chat", lambda uid, cid_: None)
    out = R.embed_chart_configs(1, "chatX", [{"role": "assistant", "content": f"here !{cid} done"}])
    assert out[0]["charts"][cid]["_elpis"]["kind"] == "bar"
