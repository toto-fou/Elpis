# SPDX-License-Identifier: MIT
"""
Les deux canaux d'événements (pipeline, métriques) suivent la racine runtime
(2026-09-20). Ils étaient en dur dans ``/tmp`` : sous ``PrivateTmp=yes`` chaque
service recevait son propre fichier et le canal se scindait en silence.
"""
from __future__ import annotations

from pathlib import Path


def test_chemins_historiques_sans_racine(monkeypatch):
    import shared_infra.observability.events_bus as eb
    import shared_infra.observability.metrics.broadcast as bc
    assert bc.EVENTS_FILE == Path("/tmp/elpis_metric_events.jsonl")
    holders = [getattr(eb, n) for n in dir(eb) if hasattr(getattr(eb, n), "EVENTS_FILE")]
    assert holders and all(h.EVENTS_FILE == Path("/tmp/elpis_pipeline_events.jsonl") for h in holders)


def test_les_deux_canaux_passent_par_runtime_path():
    src_eb = Path("shared_infra/observability/events_bus.py").read_text(encoding="utf-8")
    src_bc = Path("shared_infra/observability/metrics/broadcast.py").read_text(encoding="utf-8")
    assert 'runtime_path("pipeline_events.jsonl", "ELPIS_PIPELINE_EVENTS_FILE"' in src_eb
    assert 'runtime_path("metric_events.jsonl", "ELPIS_METRIC_EVENTS_FILE"' in src_bc
    assert 'Path("/tmp/elpis_pipeline_events.jsonl")' not in src_eb.replace('"/tmp/elpis_pipeline_events.jsonl")', "")
    

def test_runtime_path_suit_la_racine_quand_elle_est_posee(monkeypatch, tmp_path):
    import importlib
    monkeypatch.setenv("ELPIS_RUNTIME_DIR", str(tmp_path / "rt"))
    import shared_infra.runtime.runtime_dir as rd
    rd = importlib.reload(rd)
    try:
        assert rd.runtime_path("pipeline_events.jsonl", "ELPIS_PIPELINE_EVENTS_FILE",
                               "/tmp/elpis_pipeline_events.jsonl") == tmp_path / "rt" / "pipeline_events.jsonl"
        monkeypatch.setenv("ELPIS_PIPELINE_EVENTS_FILE", str(tmp_path / "x.jsonl"))
        assert rd.runtime_path("pipeline_events.jsonl", "ELPIS_PIPELINE_EVENTS_FILE",
                               "/tmp/elpis_pipeline_events.jsonl") == tmp_path / "x.jsonl"
    finally:
        monkeypatch.delenv("ELPIS_RUNTIME_DIR")
        importlib.reload(rd)
