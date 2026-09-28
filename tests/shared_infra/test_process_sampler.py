# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_process_sampler.py — sampler de métriques per-process.

Couvre le contrat de robustesse de ``sample_once`` :
  • chaque compteur collecté est persisté EXACTEMENT une fois, tagué par PID —
    désormais dans UNE seule ligne ``proc_sample`` portant toutes les jauges,
    au lieu d'une ligne par jauge (cf. process_sampler.sample_once) ;
  • un accesseur qui lève est ignoré sans casser les autres (un compteur
    indisponible ne doit jamais masquer les compteurs sains) ;
  • un ``log_metric`` qui lève est avalé (best-effort, ne casse pas le tick).

La cohabitation en LECTURE des deux formats est couverte à part, dans
``test_proc_sample_grouped.py``.

Et le watchdog scheduler : ``scheduler_alive`` False quand non-leader, et la
logique de péremption du dernier tick.
"""
from __future__ import annotations

import os

import shared_infra.observability.metrics.process_sampler as PS
import shared_infra.scheduling.routines_scheduler as S


def test_sample_once_persists_each_metric_once(monkeypatch):
    logged = []
    # sample_once fait ``from shared_infra.db import log_metric`` → on patche là.
    import shared_infra.db as DB
    monkeypatch.setattr(DB, "log_metric",
                        lambda et, val, tags=None: logged.append((et, val, tags)))

    # Accesseurs déterministes (pas de dépendance à l'état runtime réel).
    fake = [
        ("proc_a", lambda: 1.0),
        ("proc_b", lambda: 2.0),
    ]
    monkeypatch.setattr(PS, "_SAMPLES", fake)

    got = PS.sample_once()

    assert got == {"proc_a": 1.0, "proc_b": 2.0}
    # UNE seule écriture, quel que soit le nombre de jauges.
    assert len(logged) == 1
    event_type, _value, tags = logged[0]
    assert event_type == PS.PROC_SAMPLE_EVENT
    assert tags["proc_a"] == 1.0
    assert tags["proc_b"] == 2.0
    assert tags["pid"] == os.getpid()


def test_sample_once_survives_failing_accessor(monkeypatch):
    logged = []
    import shared_infra.db as DB
    monkeypatch.setattr(DB, "log_metric",
                        lambda et, val, tags=None: logged.append((et, val, tags)))

    def _boom():
        raise RuntimeError("source indisponible")

    monkeypatch.setattr(PS, "_SAMPLES", [
        ("proc_ok", lambda: 42.0),
        ("proc_broken", _boom),
        ("proc_ok2", lambda: 7.0),
    ])

    got = PS.sample_once()

    # L'accesseur cassé est absent ; les autres sont bien collectés.
    assert got == {"proc_ok": 42.0, "proc_ok2": 7.0}
    assert len(logged) == 1
    tags = logged[0][2]
    assert tags["proc_ok"] == 42.0 and tags["proc_ok2"] == 7.0
    assert "proc_broken" not in tags


def test_sample_once_swallows_log_metric_failure(monkeypatch):
    import shared_infra.db as DB

    def _boom(*a, **k):
        raise RuntimeError("DB indisponible")

    monkeypatch.setattr(DB, "log_metric", _boom)
    monkeypatch.setattr(PS, "_SAMPLES", [("proc_a", lambda: 1.0)])

    # Ne doit PAS lever malgré l'échec de persistance.
    got = PS.sample_once()
    # La valeur a bien été collectée (l'échec est côté persistance).
    assert got == {"proc_a": 1.0}


def test_scheduler_alive_false_when_not_leader(monkeypatch):
    import shared_infra.scheduling.cron_lock as CL
    monkeypatch.setattr(CL, "_acquired", False, raising=False)
    assert S.scheduler_alive() is False


def test_scheduler_alive_true_when_leader_and_recent_tick(monkeypatch):
    import shared_infra.scheduling.cron_lock as CL
    monkeypatch.setattr(CL, "_acquired", True, raising=False)
    import time as _t
    monkeypatch.setattr(S, "_last_tick", _t.time(), raising=False)
    assert S.scheduler_alive() is True


def test_scheduler_alive_false_when_leader_but_stale_tick(monkeypatch):
    import shared_infra.scheduling.cron_lock as CL
    monkeypatch.setattr(CL, "_acquired", True, raising=False)
    import time as _t
    # Tick périmé : leader mais boucle morte.
    monkeypatch.setattr(S, "_last_tick",
                        _t.time() - (S.TICK_SECONDS * 10), raising=False)
    assert S.scheduler_alive() is False
