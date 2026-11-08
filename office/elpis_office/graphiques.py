# SPDX-License-Identifier: MIT
"""office/elpis_office/graphiques.py — graphiques des outils ``chart_*`` dans un fichier Office.

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
import math
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
    lang: str = "en-US"                        # langue du document : séparateurs et en-têtes


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


def preparer(env: Env, ids: List[str], titre_image: bool = True, lang: str = "en-US") -> Dict[str, Rendu]:
    """Charge et convertit tous les graphiques cités (un seul passage Node/LibreOffice).

    ``titre_image=False`` : une image n'embarque pas le titre du graphique (la
    diapo porte déjà le sien) ; ``lang`` règle les séparateurs des nombres des graphiques natifs."""
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
        r = Rendu(id=gid, kind=kind, titre=titre, mode="image", lang=lang)
        table = el.get("table") or {}
        r.colonnes = [str(c) for c in table.get("columns") or []]
        r.lignes = [list(x) for x in table.get("rows") or []]
        if el.get("render") == "table" or kind == "table":
            r.mode = "table"
        elif el.get("render") == "kpi" or kind == "kpi":
            r.mode = "kpi"
            r.tuiles = [dict(t) for t in el.get("kpi") or []]
        elif kind in NATIFS:
            natif = _natif(option, kind, env, lang)
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


# Langue d'affichage des nombres (LibreOffice ignore c:lang, pas ce préfixe) ; l'anglais est celui par défaut.
_LCID = {"fr": "[$-40C]", "de": "[$-407]", "es": "[$-C0A]", "it": "[$-410]"}
_ESPACE_POURCENT = {"fr", "de", "es"}


def _decimales(valeurs: List[Optional[float]]) -> int:
    """Décimales utiles des valeurs (0 à 2) : « 12 000 » et non « 12 000, » (#,##0.## sur un entier)."""
    for n in (0, 1):
        if all(v is None or abs(v * 10 ** n - round(v * 10 ** n)) < 1e-9 for v in valeurs):
            return n
    return 2


def _format(unit: str, valeurs: List[Optional[float]], lang: str) -> Tuple[str, str]:
    """(format de l'axe, format des étiquettes) selon l'unité, les valeurs et la langue du document.
    Pas de titre d'axe pour une unité : elle figure déjà sur chaque graduation."""
    prefixe = _LCID.get(lang[:2].lower(), "")
    n = _decimales(valeurs)
    nombres = [abs(v) for v in valeurs if v is not None]
    axe = "#,##0" if max(nombres, default=0) >= 10 else "#,##0.0#"
    etiquette = "#,##0" + ("." + "0" * n if n else "")
    if unit == "%":
        suffixe = '" %"' if lang[:2].lower() in _ESPACE_POURCENT else '"%"'
        return f"{prefixe}{axe}{suffixe}", f"{prefixe}{etiquette}{suffixe}"
    suffixe = f'" {unit.replace(chr(34), "")}"' if unit else ""
    return f"{prefixe}{axe}{suffixe}", f"{prefixe}{etiquette}{suffixe}"


def _part(lang: str) -> str:
    """Format d'une part de camembert : « 46 % » en français."""
    prefixe = _LCID.get(lang[:2].lower(), "")
    return f"{prefixe}0 %" if lang[:2].lower() in _ESPACE_POURCENT else f"{prefixe}0%"


def _tendance(s: Dict[str, Any]) -> bool:
    """Droite de tendance du moteur (ligne muette « Tendance… ») : reprise en courbe de tendance du fichier."""
    return s.get("type") == "line" and bool(s.get("silent")) and str(s.get("name") or "").startswith("Tendance")


def _natif(option: Dict[str, Any], kind: str, env: Env, lang: str = "en-US") -> Optional[Dict[str, Any]]:
    el = option.get("_elpis") or {}
    unit = str(el.get("unit") or "")
    series = [s for s in option.get("series") or [] if isinstance(s, dict)]
    valeurs = [_val(v) for s in series if not s.get("silent") for v in s.get("data") or []]
    nf, etiquettes = _format(unit, valeurs, lang)
    y_title: Optional[str] = None
    base: Dict[str, Any] = {"title": _titre(option) or None, "number_format": nf,
                            "data_label_format": etiquettes}

    if kind in ("pie", "donut"):
        if not series:
            return None
        data = [d for d in series[0].get("data") or [] if isinstance(d, dict)]
        # Étiquettes en pourcentage : un format d'unité (« 0,5 M€ ») les fausserait.
        base["number_format"], base["data_label_format"] = None, _part(lang)
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
        tendances = [s for s in series if _tendance(s)]
        if tendances and len(nuages) == 1:
            nuages[0]["trendline"] = True           # même régression : une droite sur tous les points
        if len(series) > len(nuages) + (len(tendances) if len(nuages) == 1 else 0):
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
    empile = any(s.get("stack") for s in gardees)
    noms = {str(s.get("name") or "") for s in gardees}
    reprises = set() if empile else {str(s.get("name"))[len("Tendance "):] for s in series
                                     if _tendance(s) and str(s.get("name"))[len("Tendance "):] in noms}
    if len(gardees) + len(reprises) < len(series):
        env.notes.warn("trend line of the chart is not carried into the file")
    if not gardees:
        return None
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
    ser: List[Dict[str, Any]] = [{"name": str(s.get("name") or f"série {i + 1}"),
            "values": [_val(v) for v in s.get("data") or []],
            **({"trendline": True} if str(s.get("name") or "") in reprises else {})}
           for i, s in enumerate(gardees)]
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
def _libelles_ajustes(option: Dict[str, Any]) -> Dict[str, Any]:
    """Libellés d'un axe de catégories tous affichés : au plus la largeur d'une colonne à 640 px,
    retour à la ligne au-delà (« Marketing & ventes » ne touche plus « Frais généraux »)."""
    axe = option.get("xAxis")
    if not isinstance(axe, dict) or axe.get("type") != "category" or not isinstance(axe.get("axisLabel"), dict):
        return option
    libelle, n = axe["axisLabel"], len(axe.get("data") or [])
    if libelle.get("interval") != 0 or n < 2:
        return option
    grille: Dict[str, Any] = option["grid"] if isinstance(option.get("grid"), dict) else {}
    marges = sum(float(v) for v in (grille.get("left"), grille.get("right")) if isinstance(v, (int, float)))
    colonne = int((LARGEUR_PX - marges - 48) / n) - 8          # 48 px : graduations de l'axe des valeurs
    largeur = libelle.get("width")
    if isinstance(largeur, (int, float)) and largeur <= colonne:
        return option
    return {**option, "xAxis": {**axe, "axisLabel": {**libelle, "width": max(colonne, 32), "overflow": "break"}}}


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
        sorties = env.echarts_svg([_libelles_ajustes(o) for _, o in travaux])
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


# (milliers, décimale) par langue ; espace fine insécable en français : un nombre ne se coupe pas.
_SEPARATEURS = {"fr": ("\u202f", ","), "en": (",", "."), "de": (".", ","), "es": (".", ","), "it": (".", ",")}


def cellule(v: Any, lang: str = "fr-FR", milliers: Optional[bool] = None) -> str:
    """Nombre d'une cellule dans la langue du document (2 décimales au plus) ; un entier n'a de
    séparateur de milliers que sur demande (une année reste « 2026 »)."""
    if v is None:
        return ""
    if isinstance(v, bool) or not isinstance(v, (int, float)) or (isinstance(v, float) and not math.isfinite(v)):
        return str(v)
    mil, dec = _SEPARATEURS.get(lang[:2].lower(), _SEPARATEURS["fr"])
    if isinstance(v, int):
        brut = f"{v:,d}" if milliers else str(v)
    else:
        brut = f"{v:,.2f}" if milliers is not False else f"{v:.2f}"
        brut = brut.rstrip("0").rstrip(".")
    return brut.replace(",", "\x00").replace(".", dec).replace("\x00", mil)


def cellules_tableau(lignes: List[List[Any]], lang: str) -> List[List[str]]:
    """Cellules d'un tableau de données : milliers séparés, sauf dans une colonne d'années (1900 à 2100)."""
    largeur = max((len(ln) for ln in lignes), default=0)
    annees = [all(isinstance(x, int) and not isinstance(x, bool) and 1900 <= x <= 2100
                  for x in (ln[j] for ln in lignes if j < len(ln)) if x is not None)
              for j in range(largeur)]
    return [[cellule(v, lang, milliers=not annees[j]) for j, v in enumerate(ln)] for ln in lignes]
