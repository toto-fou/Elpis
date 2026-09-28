# SPDX-License-Identifier: MIT
"""
tests/shared_infra/test_usage_offhours.py — Ce qui tourne quand personne ne
regarde.

Scénario que l'application ratait entièrement : une routine s'exécute à 3 h du
matin, consomme des tokens, échoue peut-être — et AUCUN écran d'administration
ne pouvait le montrer. Les vues d'activité lisaient ``message_sent``, émis par
la seule route de chat interactive ; les runs de routines n'étaient lus par
aucun provider.

Ces tests vérifient la chaîne complète : le scope posé par l'exécuteur, la
consommation attribuée à son propriétaire, et les widgets qui la restituent.
"""
from __future__ import annotations

import asyncio
import time
from datetime import datetime, timedelta

import pytest


@pytest.fixture()
def db(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    legacy.init_db()
    from shared_infra.accounts.users import create_user
    create_user("alice", "pw")     # id=1
    create_user("bob", "pw")       # id=2
    import shared_infra.scheduling.routines_store as routines
    routines.init_routines_db()
    import shared_infra.observability.tool_metrics_store as am
    am.init_tool_metrics_db()
    return legacy


def _nuit_derniere(heure=3):
    """Horodatage de cette nuit à ``heure`` (heure locale), toujours passé."""
    d = datetime.now().replace(hour=heure, minute=0, second=0, microsecond=0)
    if d > datetime.now():
        d -= timedelta(days=1)
    return d.timestamp()


def test_lexecuteur_de_routine_pose_le_scope(db, monkeypatch):
    """Le point exact qui rendait l'activité nocturne invisible : la mesure se
    faisait chez l'appelant, et seul l'appelant interactif était instrumenté."""
    import shared_infra.scheduling.routines_scheduler as S
    vus = {}
    monkeypatch.setattr(S, "set_usage_context",
                        lambda source, **kw: vus.update({"source": source, **kw}))
    # On interrompt tout de suite après la pose du scope : c'est elle qu'on teste.
    monkeypatch.setattr(S, "run_chat_key", lambda rid, run: f"routine:{rid}:run:{run}")

    def _boom(uid):
        raise RuntimeError("stop")

    import shared_infra.db as dbmod
    monkeypatch.setattr("shared_infra.accounts.users.get_username_by_id", _boom)
    monkeypatch.setattr(S, "mark_run_error", lambda *a, **k: None)

    asyncio.run(S.execute_routine_run({"id": 7, "owner_user_id": 2}, 3,
                                      trigger="schedule"))
    assert vus["source"] == "routine"
    assert vus["user_id"] == 2
    assert vus["origin_id"] == "routine:7:run:3"

    vus.clear()
    asyncio.run(S.execute_routine_run({"id": 7, "owner_user_id": 2}, 4,
                                      trigger="webhook"))
    assert vus["source"] == "webhook", "un webhook ne se pilote pas comme un cron"


def test_conso_nocturne_attribuee_et_ventilee(db):
    """Une routine de bob à 3 h : visible, rattachée à bob, comptée hors plage."""
    from shared_infra.observability.usage_store import record_usage
    from shared_infra.observability.metrics._usage_providers import (
        KPIUsageOffHoursProvider, UsageBySourceProvider, UsageUserPeaksProvider)

    nuit = _nuit_derniere(3)
    record_usage(user_id=2, source="routine", model="qwen3", path="tools",
                 origin_id="routine:7:run:3", input_tokens=9000,
                 output_tokens=400, iterations=12, ts=nuit)
    record_usage(user_id=2, source="subagent", model="qwen3",
                 parent_id="routine:7:run:3", input_tokens=500,
                 output_tokens=50, ts=nuit + 60)

    par_source = {l: v for l, v in zip(
        UsageBySourceProvider().get_data(scope_hours=24)["labels"],
        UsageBySourceProvider().get_data(scope_hours=24)["datasets"][0]["data"])}
    assert par_source["Routine"] == 9400
    assert par_source["Sous-agent"] == 550, "la conso des sous-agents doit remonter"

    hors = KPIUsageOffHoursProvider().get_data(scope_hours=24)
    assert hors["value"] == "100.0 %"

    table = UsageUserPeaksProvider().get_data(scope_hours=24)
    ligne = [r for r in table["rows"] if r["utilisateur"] == "bob"][0]
    assert ligne["tours"] == 2
    assert ligne["hors_plage"] == "100.0 %"
    assert "/" in ligne["pic"], "le pic doit être daté, pas un simple index"


def test_conso_de_jour_nest_pas_comptee_hors_plage(db):
    from shared_infra.observability.usage_store import record_usage
    from shared_infra.observability.metrics._usage_providers import KPIUsageOffHoursProvider
    # 10 h un jour ouvré : dans la plage par défaut (8 h–19 h, lun–ven).
    d = datetime.now().replace(hour=10, minute=0, second=0, microsecond=0)
    while d.isoweekday() > 5 or d > datetime.now():
        d -= timedelta(days=1)
    record_usage(user_id=1, source="chat", input_tokens=100, output_tokens=10,
                 ts=d.timestamp())
    assert KPIUsageOffHoursProvider().get_data(scope_hours=168)["value"] == "0.0 %"


def test_les_runs_de_routines_sont_visibles_cote_admin(db):
    """Aucun des ~60 providers ne lisait ``editor_routine_runs`` : l'exécution
    planifiée n'existait pas du point de vue de l'exploitant."""
    from shared_infra.scheduling.routines_store import (
        admit_and_insert_run, mark_run_error, mark_run_ok)
    from shared_infra.observability.metrics._usage_providers import (
        KPIRoutineRunsProvider, RoutineRunsTimelineProvider)
    with db.db_conn() as conn:
        conn.execute("INSERT INTO editor_routines(id, owner_user_id, name, cron_expr, "
                     "task_prompt, enabled, created_at, updated_at) "
                     "VALUES (1, 2, 'nuit', '0 3 * * *', 'travaille', 1, ?, ?)",
                     (time.time(), time.time()))
        conn.commit()
    ok_id = admit_and_insert_run(1, 2, trigger="schedule", cap=10, worker_boot_id="t")
    mark_run_ok(ok_id, summary="fait", duration_ms=1200,
                input_tokens=900, output_tokens=100)
    ko_id = admit_and_insert_run(1, 2, trigger="webhook", cap=10, worker_boot_id="t")
    mark_run_error(ko_id, error="échec réseau", duration_ms=800)

    kpi = KPIRoutineRunsProvider().get_data(scope_hours=24)
    assert kpi["value"] == 2 and "1 en erreur" in kpi["detail"]
    assert kpi["color"] == "rose"

    chart = RoutineRunsTimelineProvider().get_data(scope_hours=24)
    assert {ds["label"] for ds in chart["datasets"]} == {"Réussi", "Erreur"}
    assert len(chart["labels"]) == len(chart["datasets"][0]["data"])


def test_sante_du_planificateur_et_minutes_enjambees(db):
    """Trois signaux qu'il fallait deviner en lisant les logs."""
    from shared_infra.observability.metrics._usage_providers import KPISchedulerHealthProvider
    prov = KPISchedulerHealthProvider()
    assert prov.get_data()["value"] == "Arrêtée"     # aucun battement

    db.log_metric("proc_scheduler_alive", 1, {"pid": 42})
    db.log_metric("maintenance_pass", 1, {})
    assert prov.get_data()["value"] == "Active"
    assert "aucune minute enjambée" in prov.get_data()["detail"]

    db.log_metric("scheduler_skip", 4, {"from": "x", "to": "y"})
    d = prov.get_data()
    assert d["color"] == "amber" and "4 minute(s)" in d["detail"]


def test_la_fenetre_pilote_vraiment_les_widgets(db):
    """Le sélecteur 1 j / 7 j / 30 j ne touchait que quatre providers sur
    soixante : passer en « 30 j » laissait la plupart des chiffres à 24 h, sans
    que rien ne le signale — et plusieurs titres annonçaient « (24h) » en dur."""
    import inspect
    from shared_infra.observability.usage_store import record_usage
    from shared_infra.observability.metrics.engine import DEFAULT_WIDGETS, registry

    # Toute valeur qui DÉPEND d'une période doit lire la fenêtre. Les jauges
    # instantanées (RAM, disque, taille de base, état moteur) l'ignorent.
    INSTANTANEES = {"kpi_users", "kpi_chats", "kpi_db_size", "kpi_disk",
                    "kpi_ram", "kpi_llm_status", "system_load"}
    figes = {p.id for p in registry.providers
             if "scope_hours" not in inspect.signature(p.get_data).parameters}
    assert (figes & DEFAULT_WIDGETS) <= INSTANTANEES, \
        f"widgets curés sourds à la fenêtre : {sorted((figes & DEFAULT_WIDGETS) - INSTANTANEES)}"

    now = time.time()
    record_usage(user_id=1, source="chat", input_tokens=100, ts=now)
    record_usage(user_id=1, source="chat", input_tokens=1000, ts=now - 3 * 86400)
    record_usage(user_id=1, source="chat", input_tokens=10000, ts=now - 20 * 86400)
    from shared_infra.observability.metrics._usage_providers import KPIUsageTurnsProvider
    p = KPIUsageTurnsProvider()
    assert (p.get_data(scope_hours=24)["value"],
            p.get_data(scope_hours=168)["value"],
            p.get_data(scope_hours=720)["value"]) == (1, 2, 3)
    # Une fenêtre hors liste retombe sur 24 h plutôt que de scanner la table.
    assert p.get_data(scope_hours=99999)["value"] == 1


def test_granularite_adaptee_a_la_fenetre(db):
    """24 h en seaux d'heure, 7 j et 30 j en jours : 720 points seraient
    illisibles."""
    from shared_infra.observability.usage_store import record_usage
    from shared_infra.observability.metrics._usage_providers import UsageTimelineProvider
    now = time.time()
    for j in range(31):
        record_usage(user_id=1, source="chat", input_tokens=10, ts=now - j * 86400)
    p = UsageTimelineProvider()
    h24 = p.get_data(scope_hours=24)
    j30 = p.get_data(scope_hours=720)
    assert h24["meta"]["granularity"] == "hour" and len(h24["labels"]) == 25
    assert j30["meta"]["granularity"] == "day" and 30 <= len(j30["labels"]) <= 32
    # 30 j doit VRAIMENT couvrir 30 jours de données, pas seulement les afficher.
    assert sum(j30["datasets"][0]["data"]) > sum(h24["datasets"][0]["data"])


def test_le_rapport_quotidien_parle_dexploitation(db):
    """Le digest ne parlait que d'activité humaine : il ignorait les routines,
    la part hors plage et la santé de la planification."""
    from shared_infra.observability.metrics.daily_report import REPORT_WIDGET_IDS, build_daily_report
    for wid in ("usage_tokens", "usage_offhours", "routine_runs", "scheduler_health"):
        assert wid in REPORT_WIDGET_IDS
    payload = build_daily_report(scope_hours=24, date="2026-08-12")
    assert "exploitation" in {s["id"] for s in payload["sections"]}
    assert not [k for k, v in payload["widgets"].items()
                if isinstance(v, dict) and "error" in v]
