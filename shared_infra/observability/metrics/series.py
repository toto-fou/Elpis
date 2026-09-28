# SPDX-License-Identifier: MIT
"""
shared_infra.observability.metrics.series — Séries temporelles : un axe X qui est une frise.

Ce que faisait l'ancien moteur
==============================
Les graphiques horaires groupaient par ``strftime('%H:00')`` et triaient le
libellé par ordre alphabétique. Deux conséquences, toutes deux visibles à
l'écran :

1. **Repli sur 24 h.** Une fenêtre à cheval sur minuit fusionnait hier-14 h
   avec aujourd'hui-14 h dans le même point. L'axe X n'était pas une frise,
   c'était un cadran d'horloge.
2. **Les creux disparaissaient.** ``GROUP BY`` n'émet que les seaux qui
   existent : une heure sans activité — typiquement la nuit — ne valait pas
   « 0 », elle n'existait pas, et la courbe reliait 23 h à 6 h en ligne droite.
   Impossible, dans ces conditions, de voir quand la plateforme travaille
   toute seule.

Ce module remplace les deux par un **calendrier explicite** : on calcule
d'abord tous les seaux de la fenêtre, puis on y verse ce que la base renvoie.
Un seau sans données vaut 0, et chaque libellé porte sa date.

Fuseau
======
``metrics.timezone`` (vide = fuseau du serveur). Le découpage HORAIRE est
exact quel que soit le fuseau : les frontières d'heure locale coïncident avec
celles d'UTC (tous les décalages réels sont des multiples de 15 min et les
changements d'heure tombent sur une frontière d'heure). Le découpage JOURNALIER
passe par le calendrier local de SQLite (``localtime``), donc exact aussi, y
compris les jours de 23 h ou 25 h. Un fuseau explicite différent de celui du
serveur retombe sur un décalage fixe — approximation assumée, bornée aux deux
jours de bascule par an.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone, tzinfo
from typing import Any, Dict, List, Optional, Sequence, Tuple

from shared_infra.db._connection import db_conn
from shared_infra.db._dialect import cast_int, local_strftime, utc_strftime

logger = logging.getLogger("uvicorn.error")

HOUR = 3600
DAY = 86400


def resolve_tz() -> Tuple[tzinfo, str, bool]:
    """(tzinfo, nom, est_le_fuseau_serveur). Repli silencieux sur le serveur."""
    name = ""
    try:
        from shared_infra.config import METRICS_TIMEZONE
        name = (METRICS_TIMEZONE or "").strip()
    except Exception:
        name = ""
    if name:
        try:
            from zoneinfo import ZoneInfo
            return ZoneInfo(name), name, False
        except Exception:
            logger.warning("[metrics] fuseau %r inconnu — repli sur le serveur", name)
    local = datetime.now().astimezone().tzinfo or timezone.utc
    return local, (datetime.now(local).tzname() or "local"), True


@dataclass
class BucketPlan:
    """Calendrier de la fenêtre : la vérité de l'axe X."""
    granularity: str                     # "hour" | "day"
    edges: List[float]                   # début de chaque seau (epoch)
    keys: List[Any]                      # clé telle que SQL la renverra
    labels: List[str]                    # libellé ISO local ("2026-08-12T14:00")
    tz_name: str = ""
    is_server_tz: bool = True
    origin: float = 0.0
    tz: Optional[tzinfo] = field(default=None, repr=False)

    def index_of(self) -> Dict[Any, int]:
        return {k: i for i, k in enumerate(self.keys)}


def plan_buckets(since: float, until: Optional[float] = None,
                 granularity: str = "hour") -> BucketPlan:
    """Construit tous les seaux de la fenêtre, y compris ceux qui seront vides."""
    tz, tz_name, is_server = resolve_tz()
    end = float(until if until is not None else time.time())
    start = float(since)
    if end <= start:
        end = start + 1

    if granularity == "day":
        d0 = datetime.fromtimestamp(start, tz).replace(
            hour=0, minute=0, second=0, microsecond=0)
        edges: List[float] = []
        keys: List[Any] = []
        labels: List[str] = []
        cur = d0
        # Pas d'arithmétique en secondes : on avance d'un JOUR de calendrier,
        # ce qui reste juste les jours de changement d'heure (23 h / 25 h).
        while cur.timestamp() < end:
            edges.append(cur.timestamp())
            keys.append(cur.strftime("%Y-%m-%d"))
            labels.append(cur.strftime("%Y-%m-%d"))
            cur = (cur + timedelta(days=1, hours=2)).replace(
                hour=0, minute=0, second=0, microsecond=0)
        return BucketPlan("day", edges, keys, labels, tz_name, is_server,
                          edges[0] if edges else start, tz)

    # Horaire : origine = début de l'heure locale contenant ``since``.
    h0 = datetime.fromtimestamp(start, tz).replace(minute=0, second=0, microsecond=0)
    origin = h0.timestamp()
    n = max(1, int((end - origin) // HOUR) + 1)
    # Garde-fou : une fenêtre de 30 j en horaire = 720 points, c'est la limite
    # lisible d'un graphique — au-delà, l'appelant doit passer en journalier.
    n = min(n, 24 * 31)
    edges = [origin + i * HOUR for i in range(n)]
    keys = list(range(n))
    labels = [datetime.fromtimestamp(e, tz).strftime("%Y-%m-%dT%H:00") for e in edges]
    return BucketPlan("hour", edges, keys, labels, tz_name, is_server, origin, tz)


def _bucket_expr(plan: BucketPlan, ts_col: str) -> Tuple[str, List[Any]]:
    """Expression SQL de la clé de seau + ses paramètres."""
    if plan.granularity == "day":
        if plan.is_server_tz:
            return (local_strftime("%Y-%m-%d", ts_col), [])
        off = int(datetime.now(plan.tz).utcoffset().total_seconds()) if plan.tz else 0
        return (utc_strftime("%Y-%m-%d", f"{ts_col} + ?"), [off])
    return (cast_int(f"({ts_col} - ?) / {HOUR}"), [plan.origin])


def aggregate_series(
    *,
    table: str,
    ts_col: str,
    value_expr: str,
    plan: BucketPlan,
    where_sql: str = "1=1",
    params: Optional[Sequence[Any]] = None,
    group_col: Optional[str] = None,
) -> Dict[Any, Dict[Any, float]]:
    """Agrège ``table`` par seau (et par série si ``group_col``).

    Retourne ``{clé_de_série: {clé_de_seau: valeur}}``. Aucun remplissage ici :
    c'est ``to_chart`` qui pose le calendrier. ``table``, ``ts_col``,
    ``value_expr`` et ``group_col`` viennent TOUJOURS du code appelant, jamais
    d'une entrée utilisateur.
    """
    if not plan.edges:
        return {}
    key_expr, key_params = _bucket_expr(plan, ts_col)
    lo = plan.edges[0]
    hi = plan.edges[-1] + (DAY if plan.granularity == "day" else HOUR)
    sel_grp = f", {group_col} AS grp" if group_col else ""
    grp_by = f", {group_col}" if group_col else ""
    sql = (f"SELECT {key_expr} AS bkey{sel_grp}, {value_expr} AS val "
           f"FROM {table} "
           f"WHERE ({where_sql}) AND {ts_col} >= ? AND {ts_col} < ? "
           f"GROUP BY bkey{grp_by}")
    args = [*key_params, *(params or []), lo, hi]
    out: Dict[Any, Dict[Any, float]] = {}
    try:
        with db_conn() as conn:
            rows = conn.execute(sql, args).fetchall()
    except Exception:
        logger.debug("[metrics] aggregate_series a échoué (%s)", table, exc_info=True)
        return {}
    for r in rows:
        d = dict(r)
        series = d.get("grp") if group_col else ""
        out.setdefault(series if series is not None else "", {})[d["bkey"]] = d["val"] or 0
    return out


# ── Rendu Chart.js ──────────────────────────────────────────────────────────

# Palette alignée sur les tokens d'accent de l'app (bleu = accent unique, le
# reste sert à distinguer des séries, jamais à décorer).
PALETTE = ("59,130,246", "16,185,129", "245,158,11", "139,92,246",
           "239,68,68", "6,182,212", "249,115,22", "132,204,22")


def to_chart(plan: BucketPlan, data: Dict[Any, Dict[Any, float]], *,
             kind: str = "line", labels_map: Optional[Dict[Any, str]] = None,
             stacked: bool = False, round_to: Optional[int] = None) -> Dict[str, Any]:
    """Verse les agrégats dans le calendrier — les seaux absents valent 0."""
    idx = plan.index_of()
    datasets = []
    for i, (series, points) in enumerate(sorted(data.items(), key=lambda kv: str(kv[0]))):
        values = [0.0] * len(plan.keys)
        for bkey, val in points.items():
            pos = idx.get(bkey)
            if pos is None:
                continue                      # hors fenêtre (bord de requête)
            values[pos] = round(val, round_to) if round_to is not None else val
        color = PALETTE[i % len(PALETTE)]
        label = (labels_map or {}).get(series, str(series) if series != "" else "Total")
        ds: Dict[str, Any] = {"label": label, "data": values}
        if kind == "bar":
            ds.update({"backgroundColor": f"rgba({color},0.75)", "borderRadius": 4})
        else:
            ds.update({"borderColor": f"rgb({color})",
                       "backgroundColor": f"rgba({color},0.12)",
                       "tension": 0.35, "fill": True, "borderWidth": 2,
                       "pointRadius": 0, "pointHoverRadius": 4})
        if stacked:
            ds["stack"] = "all"
        datasets.append(ds)
    if not datasets:
        datasets = [{"label": "Total", "data": [0.0] * len(plan.keys),
                     "borderColor": f"rgb({PALETTE[0]})",
                     "backgroundColor": f"rgba({PALETTE[0]},0.12)",
                     "tension": 0.35, "fill": True, "borderWidth": 2,
                     "pointRadius": 0}]
    return {
        "labels": plan.labels,
        "datasets": datasets,
        # Métadonnées lues par le front : il n'a plus à deviner ni le pas ni le
        # fuseau pour formater l'axe — l'ancien front affichait des libellés
        # bruts et laissait croire à une frise là où il n'y en avait pas.
        "meta": {"granularity": plan.granularity, "timezone": plan.tz_name,
                 "start": plan.edges[0] if plan.edges else 0,
                 "end": plan.edges[-1] if plan.edges else 0,
                 "stacked": stacked},
    }


def granularity_for(hours: int) -> str:
    """24 h → horaire ; au-delà → journalier (720 points illisibles sinon)."""
    return "hour" if int(hours) <= 48 else "day"
