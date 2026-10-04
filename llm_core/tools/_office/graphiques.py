# SPDX-License-Identifier: MIT
"""llm_core/tools/_office/graphiques.py — graphiques des outils ``chart_*`` dans un fichier Office.

Le modèle trace le graphique avec ``chart_<type>`` (qui lui rend ``!id``),
puis écrit ce ``!id`` dans le contenu. On repart de l'option ECharts STOCKÉE :
ce qui entre dans le fichier est exactement ce que le chat a montré.

  - natif   barres, courbes, aires, secteurs, anneau, radar, nuage, bulles,
            histogramme → graphique OOXML éditable (« Modifier les données ») ;
  - table   ``chart_table`` → vrai tableau ;
  - kpi     ``chart_kpi`` → tuiles (PowerPoint) ou tableau (Word) ;
  - image   tout le reste → rendu ECharts côté serveur (Node, SVG) puis PNG 2x
            (LibreOffice). Sans Node ou sans LibreOffice, ou si le rendu d'un
            graphique échoue : tableau de ses données, avertissement au modèle
            et ligne de journal pour l'exploitant — jamais d'échec de l'outil.
"""
from __future__ import annotations

import base64
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from .commun import Env, OfficeError

logger = logging.getLogger("uvicorn.error")

# !id rendu par chart_* : 12 caractères hexadécimaux (sha1 tronqué). Bornes
# explicites plutôt que ``\b`` : « _!id_ » (italique Markdown) doit être reconnu
# par REF comme par REF_SEULE, sinon le graphique n'est jamais préparé.
REF = re.compile(r"(?<![0-9A-Za-z])!([0-9a-f]{12})(?![0-9A-Za-z])")
REF_SEULE = re.compile(r"^\s*[`*_]*!([0-9a-f]{12})[`*_]*\s*$")

NATIFS = {"bar", "line", "area", "pie", "donut", "radar", "scatter", "bubble", "histogram"}

LARGEUR_PX, HAUTEUR_PX = 640, 360


@dataclass
class Rendu:
    id: str
    kind: str
    titre: str
    mode: str                                  # natif | table | kpi | image
    natif: Dict[str, Any] = field(default_factory=dict)
    colonnes: List[str] = field(default_factory=list)
    lignes: List[List[Any]] = field(default_factory=list)
    tuiles: List[Dict[str, Any]] = field(default_factory=list)
    png: bytes = b""
    ratio: float = HAUTEUR_PX / LARGEUR_PX     # hauteur / largeur de l'image


def ref_de(valeur: Any) -> Optional[str]:
    """« !a1b2c3d4e5f6 », « a1b2c3d4e5f6 », « `!a1b2…` » → l'identifiant, sinon None."""
    if not isinstance(valeur, str):
        return None
    m = re.fullmatch(r"\s*[`*_]*!?([0-9a-f]{12})[`*_]*\s*", valeur)
    return m.group(1) if m else None


def refs_dans(valeur: Any) -> List[str]:
    """Toutes les références ``!id`` d'une valeur quelconque (texte, listes et
    objets imbriqués) : ce qui est cité, quel que soit le nom du champ. Le ``!``
    est exigé ici : 12 caractères hexadécimaux dans un texte ne sont pas une
    référence (l'identifiant nu n'est accepté que dans un champ de graphique)."""
    if isinstance(valeur, str):
        return REF.findall(valeur)
    if isinstance(valeur, dict):
        return [x for v in valeur.values() for x in refs_dans(v)]
    if isinstance(valeur, (list, tuple)):
        return [x for v in valeur for x in refs_dans(v)]
    return []


def rendu(rendus: Dict[str, "Rendu"], gid: str) -> "Rendu":
    """Le graphique préparé ``gid`` ; jamais de ``KeyError`` vers le modèle."""
    r = rendus.get(gid)
    if r is None:
        raise OfficeError(f"chart !{gid} not found", code="chart_not_found",
                          fix="create the chart first with a chart_<type> tool and copy the "
                              "`ref` it returns (e.g. !a1b2c3d4e5f6) exactly")
    return r


def preparer(env: Env, ids: List[str], titre_image: bool = True) -> Dict[str, Rendu]:
    """Charge et convertit tous les graphiques cités (un seul passage Node/LibreOffice).

    ``titre_image=False`` : une image n'embarque pas le titre du graphique (la
    diapo porte déjà le sien)."""
    rendus: Dict[str, Rendu] = {}
    a_dessiner: List[Tuple[Rendu, Dict[str, Any]]] = []
    for gid in dict.fromkeys(ids):
        option = env.graphique(gid)
        if not isinstance(option, dict):
            raise OfficeError(
                f"chart !{gid} not found",
                fix="create the chart first with a chart_<type> tool and copy the `ref` it "
                    "returns (e.g. !a1b2c3d4e5f6) exactly, alone on its line",
                code="chart_not_found")
        el = option.get("_elpis") or {}
        kind = str(el.get("kind") or "")
        titre = _titre(option)
        r = Rendu(id=gid, kind=kind, titre=titre, mode="image")
        table = el.get("table") or {}
        r.colonnes = [str(c) for c in table.get("columns") or []]
        r.lignes = [list(x) for x in table.get("rows") or []]
        if el.get("render") == "table" or kind == "table":
            r.mode = "table"
        elif el.get("render") == "kpi" or kind == "kpi":
            r.mode = "kpi"
            r.tuiles = [dict(t) for t in el.get("kpi") or []]
        elif kind in NATIFS:
            natif = _natif(option, kind, env)
            if natif:
                r.mode, r.natif = "natif", natif
        if r.mode == "image":
            a_dessiner.append((r, option if titre_image else
                               {k: v for k, v in option.items() if k != "title"}))
        rendus[gid] = r
    if a_dessiner:
        _dessiner(env, a_dessiner)
    return rendus


def _titre(option: Dict[str, Any]) -> str:
    t = option.get("title")
    if isinstance(t, list):
        t = t[0] if t else {}
    return str((t or {}).get("text") or "").strip() if isinstance(t, dict) else ""


# ── Natif : lecture de l'option ECharts produite par _chart ─────────────────
def _val(item: Any) -> Optional[float]:
    if isinstance(item, dict):
        item = item.get("value")
    if isinstance(item, (list, tuple)):
        item = item[-1] if item else None
    if isinstance(item, bool) or item in (None, "-", ""):
        return None
    try:
        return float(item)
    except (TypeError, ValueError):
        return None


def _axe(o: Any) -> Dict[str, Any]:
    if isinstance(o, list):
        o = o[0] if o else {}
    return o if isinstance(o, dict) else {}


def _format(unit: str) -> Tuple[str, Optional[str]]:
    """(format de nombre Excel, titre d'axe) selon l'unité. Pas de titre d'axe
    pour une unité : elle figure déjà sur chaque graduation."""
    if unit == "%":
        return '0.0" %"', None
    if unit:
        u = unit.replace('"', "")
        return f'#,##0.##" {u}"', None    # l'unité est déjà sur chaque graduation
    return "#,##0.##", None


def _natif(option: Dict[str, Any], kind: str, env: Env) -> Optional[Dict[str, Any]]:
    el = option.get("_elpis") or {}
    unit = str(el.get("unit") or "")
    nf, y_title = _format(unit)
    series = [s for s in option.get("series") or [] if isinstance(s, dict)]
    base: Dict[str, Any] = {"title": _titre(option) or None, "number_format": nf}

    if kind in ("pie", "donut"):
        if not series:
            return None
        data = [d for d in series[0].get("data") or [] if isinstance(d, dict)]
        # Étiquettes en pourcentage : un format d'unité (« 0,5 M€ ») les fausserait.
        base["number_format"] = None
        return {**base, "chart_type": "doughnut" if kind == "donut" else "pie",
                "categories": [str(d.get("name", "")) for d in data],
                "series": [{"name": str(series[0].get("name") or "valeur"),
                            "values": [_val(d) for d in data]}]}

    if kind == "radar":
        radar = _axe(option.get("radar"))
        axes = [str(i.get("name", "")) for i in radar.get("indicator") or [] if isinstance(i, dict)]
        data = [d for d in (series[0].get("data") if series else None) or [] if isinstance(d, dict)]
        if not axes or not data:
            return None
        return {**base, "chart_type": "radar_markers", "categories": axes,
                "series": [{"name": str(d.get("name", "")),
                            "values": [_val(v) for v in d.get("value") or []]} for d in data]}

    if kind in ("scatter", "bubble"):
        nuages: List[Dict[str, Any]] = []
        for s in series:
            if s.get("type") not in ("scatter", "effectScatter") or s.get("silent"):
                continue          # droite de tendance, repères : non repris
            pts = []
            for d in s.get("data") or []:
                v = d.get("value") if isinstance(d, dict) else d
                if isinstance(v, (list, tuple)) and len(v) >= 2:
                    try:
                        p = [float(v[0]), float(v[1])]
                        if kind == "bubble":
                            p.append(float(v[2]) if len(v) > 2 and v[2] is not None else 1.0)
                        pts.append(p)
                    except (TypeError, ValueError):
                        continue
            if pts:
                nuages.append({"name": str(s.get("name") or f"série {len(nuages) + 1}"), "points": pts})
        if not nuages:
            return None
        if len(series) > len(nuages):
            env.notes.warn("trend line or markers of the chart are not carried into the file")
        xa, ya = _axe(option.get("xAxis")), _axe(option.get("yAxis"))
        return {**base, "chart_type": "bubble" if kind == "bubble" else "scatter",
                "categories": [], "series": nuages,
                "x_title": xa.get("name") or None, "y_title": ya.get("name") or y_title}

    # Cartésiens : bar / line / area / histogram
    xa, ya = _axe(option.get("xAxis")), _axe(option.get("yAxis"))
    horizontal = ya.get("type") == "category"
    cat_axis, val_axis = (ya, xa) if horizontal else (xa, ya)
    cats = [str(c) for c in cat_axis.get("data") or []]
    if not cats:
        return None
    gardees = [s for s in series if not s.get("silent")]
    if len(gardees) < len(series):
        env.notes.warn("trend line of the chart is not carried into the file")
    if not gardees:
        return None
    empile = any(s.get("stack") for s in gardees)
    pourcent = empile and val_axis.get("max") == 100 and unit == "%"
    if kind in ("bar", "histogram"):
        t = "bar" if horizontal else "column"
        t += "_stacked" if empile else ("" if horizontal else "_clustered")
    elif kind == "area" or any(s.get("areaStyle") for s in gardees):
        t = "area_stacked" if empile else "area"
    else:
        t = "line_markers" if len(cats) <= 24 else "line"
        if empile:
            t = "line_stacked"
    ser = [{"name": str(s.get("name") or f"série {i + 1}"),
            "values": [_val(v) for v in s.get("data") or []]} for i, s in enumerate(gardees)]
    if horizontal and cat_axis.get("inverse"):
        # ECharts lit la 1re catégorie en haut ; Word/PowerPoint en bas.
        cats = cats[::-1]
        for s in ser:
            s["values"] = s["values"][::-1]
    out = {**base, "chart_type": t, "categories": cats, "series": ser,
           "x_title": (cat_axis.get("name") or None),
           "y_title": (val_axis.get("name") or y_title)}
    if out["y_title"] and unit and out["y_title"] == unit:
        out["y_title"] = None
    if pourcent:
        out["y_max"] = 100
    if any(s.get("smooth") for s in gardees) and t.startswith("line"):
        out["smooth"] = True
    if len(ser) == 1 and kind != "histogram":
        out["legend"] = "none"
    return out


# ── Image : ECharts côté serveur puis PNG ──────────────────────────────────
def _dessiner(env: Env, travaux: List[Tuple[Rendu, Dict[str, Any]]]) -> None:
    def repli(rs: List[Rendu], raison: str) -> None:
        for r in rs:
            r.mode = "table"
        if rs:
            noms = ", ".join(f"!{r.id} ({r.kind})" for r in rs)
            env.notes.warn(f"{noms}: inserted as a data table ({raison})")
            logger.warning("[office] graphique(s) %s en tableau : %s", noms, raison)

    if env.echarts_svg is None or env.svg_png is None:
        for r, _ in travaux:
            r.mode = "table"
        noms = ", ".join(f"!{r.id} ({r.kind})" for r, _ in travaux)
        env.notes.warn(f"{noms}: inserted as a data table (chart images need Node.js and "
                       "LibreOffice on the server)")
        return
    try:
        sorties = env.echarts_svg([o for _, o in travaux])
    except Exception as e:                      # noqa: BLE001 — repli documenté
        repli([r for r, _ in travaux], f"server-side chart rendering failed: {e}")
        return
    a_convertir: List[Tuple[Rendu, str]] = []
    for (r, _), sortie in zip(travaux, sorties):
        svg = str((sortie or {}).get("svg") or "")
        if not svg:
            repli([r], f"chart rendering failed: {(sortie or {}).get('error') or 'empty output'}")
            continue
        m = re.search(r'<svg[^>]*\bwidth="(\d+(?:\.\d+)?)"[^>]*\bheight="(\d+(?:\.\d+)?)"', svg)
        if m:
            w, h = float(m.group(1)), float(m.group(2))
            r.ratio = h / w if w else r.ratio
            tete = m.group(0).replace(f'width="{m.group(1)}"', f'width="{w * 2:g}"') \
                .replace(f'height="{m.group(2)}"', f'height="{h * 2:g}"')
            svg = svg.replace(m.group(0), tete, 1)          # PNG 2x : net à l'impression
        a_convertir.append((r, svg))
    if not a_convertir:
        return
    try:
        pngs = env.svg_png([svg for _, svg in a_convertir])
    except Exception as e:                      # noqa: BLE001 — repli documenté
        repli([r for r, _ in a_convertir], f"PNG conversion failed: {e}")
        return
    for (r, _), png in zip(a_convertir, pngs):
        if png:
            r.png = png
        else:
            repli([r], "PNG conversion failed")


def data_uri(png: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")


def cellule(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, float):
        return f"{v:,.2f}".replace(",", " ").replace(".", ",").rstrip("0").rstrip(",")
    return str(v)
