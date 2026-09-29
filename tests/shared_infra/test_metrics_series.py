# SPDX-License-Identifier: MIT
"""
tests/shared_infra/test_metrics_series.py — Un axe X qui est une frise.

Deux défauts verrouillés ici, tous deux visibles à l'écran avant correction :

  1. Les graphiques horaires groupaient par ``strftime('%H:00')`` : une fenêtre
     de 24 h à cheval sur minuit fusionnait hier-14 h avec aujourd'hui-14 h
     dans le même point.
  2. ``GROUP BY`` n'émet que les seaux existants : une heure sans activité —
     typiquement la nuit — n'était pas « 0 », elle n'existait pas, et la courbe
     reliait 23 h à 6 h en ligne droite.
"""
from __future__ import annotations

import time
from datetime import datetime

import pytest


@pytest.fixture()
def db(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    legacy.init_db()
    return legacy


def _seed(ts_list):
    from shared_infra.observability.usage_store import record_usage
    for ts in ts_list:
        record_usage(user_id=1, source="chat", model="m",
                     input_tokens=10, output_tokens=1, ts=ts)


def test_le_calendrier_couvre_toute_la_fenetre(db):
    from shared_infra.observability.metrics.series import plan_buckets
    now = time.time()
    plan = plan_buckets(now - 24 * 3600, now, "hour")
    assert plan.granularity == "hour"
    assert len(plan.edges) == len(plan.labels) == 25   # 24 h + le seau courant
    # Les libellés PORTENT leur date : c'est ce qui distingue une frise d'un
    # cadran d'horloge.
    assert all(len(l) == 16 and l[10] == "T" for l in plan.labels)
    assert plan.labels == sorted(plan.labels)          # strictement croissants


def test_les_seaux_vides_valent_zero(db):
    """Une nuit calme doit se voir comme une ligne à 0, pas comme un trou."""
    from shared_infra.observability.metrics.series import aggregate_series, plan_buckets, to_chart
    now = time.time()
    _seed([now, now - 3600])            # deux heures actives sur vingt-quatre
    plan = plan_buckets(now - 24 * 3600, now, "hour")
    chart = to_chart(plan, aggregate_series(
        table="usage_events", ts_col="ts", value_expr="COUNT(*)", plan=plan))
    data = chart["datasets"][0]["data"]
    assert len(data) == len(chart["labels"])
    assert data.count(0) == len(data) - 2
    assert sum(data) == 2


def test_une_fenetre_a_cheval_sur_minuit_ne_se_replie_pas(db):
    """Même heure, deux jours différents ⇒ deux points distincts."""
    from shared_infra.observability.metrics.series import aggregate_series, plan_buckets, to_chart
    # Ancrage sur une heure locale connue : 14 h aujourd'hui et 14 h hier.
    aujourdhui = datetime.now().replace(minute=0, second=0, microsecond=0)
    h14 = aujourdhui.replace(hour=14).timestamp()
    h14_hier = h14 - 86400
    _seed([h14, h14_hier])
    plan = plan_buckets(h14_hier - 3600, h14 + 3600, "hour")
    chart = to_chart(plan, aggregate_series(
        table="usage_events", ts_col="ts", value_expr="COUNT(*)", plan=plan))
    actifs = [(l, v) for l, v in zip(chart["labels"], chart["datasets"][0]["data"]) if v]
    assert len(actifs) == 2, actifs
    assert actifs[0][0][:10] != actifs[1][0][:10]      # deux dates différentes
    assert all(v == 1 for _, v in actifs)              # aucun cumul


def test_series_par_groupe_et_metadonnees(db):
    from shared_infra.observability.metrics.series import aggregate_series, plan_buckets, to_chart
    from shared_infra.observability.usage_store import record_usage
    now = time.time()
    record_usage(user_id=1, source="chat", input_tokens=100, ts=now)
    record_usage(user_id=1, source="routine", input_tokens=900, ts=now)
    plan = plan_buckets(now - 3600, now, "hour")
    chart = to_chart(plan, aggregate_series(
        table="usage_events", ts_col="ts",
        value_expr="COALESCE(SUM(input_tokens),0)", plan=plan, group_col="source"),
        stacked=True, labels_map={"chat": "Chat", "routine": "Routine"})
    assert {ds["label"] for ds in chart["datasets"]} == {"Chat", "Routine"}
    # Le front n'a plus à DEVINER le pas ni le fuseau pour formater l'axe.
    assert chart["meta"]["granularity"] == "hour"
    assert chart["meta"]["timezone"]
    assert chart["meta"]["stacked"] is True


def test_granularite_journaliere_sur_les_longues_fenetres(db):
    from shared_infra.observability.metrics.series import granularity_for, plan_buckets
    assert granularity_for(24) == "hour"
    assert granularity_for(168) == "day"
    assert granularity_for(720) == "day"
    now = time.time()
    plan = plan_buckets(now - 7 * 86400, now, "day")
    assert plan.granularity == "day"
    assert 7 <= len(plan.edges) <= 9
    assert all(len(l) == 10 for l in plan.labels)      # AAAA-MM-JJ


def test_les_seaux_horaires_sont_bornes(db):
    """Une fenêtre de 30 j en horaire ferait 720 points illisibles : le
    constructeur borne au lieu de produire un graphique inutilisable."""
    from shared_infra.observability.metrics.series import plan_buckets
    now = time.time()
    plan = plan_buckets(now - 90 * 86400, now, "hour")
    assert len(plan.edges) <= 24 * 31


def test_serie_vide_rend_un_graphique_a_zero_pas_une_erreur(db):
    from shared_infra.observability.metrics.series import plan_buckets, to_chart
    now = time.time()
    plan = plan_buckets(now - 3600, now, "hour")
    chart = to_chart(plan, {})
    assert chart["datasets"] and set(chart["datasets"][0]["data"]) == {0.0}
