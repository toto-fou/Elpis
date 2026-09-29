# SPDX-License-Identifier: MIT
"""
tests/shared_infra/test_usage_thinking.py — La part de réflexion dans le
registre d'usage, ses agrégats et la route utilisateur.

Invariant central : ``thinking_tokens`` est un SOUS-ENSEMBLE de
``output_tokens``. Il ne s'ajoute jamais au total — il le découpe. Un test le
vérifie à l'écriture (borne posée en base), un autre à la lecture (les vues
qui somment ``input + output`` restent justes).
"""
from __future__ import annotations

import time

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient


@pytest.fixture()
def db(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    legacy.init_db()
    from shared_infra.accounts.users import create_user
    assert create_user("alice", "pw") == 1
    return legacy


def _rows(db):
    with db.db_conn() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM usage_events ORDER BY id").fetchall()]


# ── Schéma ──────────────────────────────────────────────────────────────────

@pytest.mark.sqlite_only   # introspection PRAGMA de la migration SQLite
def test_migration_ajoute_la_colonne(db):
    with db.db_conn() as conn:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(usage_events)")}
    assert "thinking_tokens" in cols


# ── Écriture ────────────────────────────────────────────────────────────────

def test_la_reflexion_est_stockee_a_part(db):
    from shared_infra.observability.usage_store import record_usage
    assert record_usage(user_id=1, source="chat", input_tokens=1000,
                        output_tokens=800, thinking_tokens=600) is True
    row = _rows(db)[0]
    assert row["output_tokens"] == 800
    assert row["thinking_tokens"] == 600


def test_la_reflexion_ne_peut_pas_depasser_la_sortie(db):
    """Borne posée À L'ÉCRITURE : l'invariant doit être vrai en base, pas
    seulement dans la vue qui l'a calculé (une mesure estimée peut être
    trop généreuse)."""
    from shared_infra.observability.usage_store import record_usage
    record_usage(user_id=1, source="chat", input_tokens=10,
                 output_tokens=40, thinking_tokens=999)
    assert _rows(db)[0]["thinking_tokens"] == 40


def test_tour_sans_reflexion_reste_a_zero(db):
    from shared_infra.observability.usage_store import record_usage
    record_usage(user_id=1, source="chat", input_tokens=10, output_tokens=20)
    assert _rows(db)[0]["thinking_tokens"] == 0


# ── Agrégats ────────────────────────────────────────────────────────────────

def test_totaux_derivent_la_reponse_sans_gonfler_le_total(db):
    from shared_infra.observability.usage_store import record_usage, usage_totals
    record_usage(user_id=1, source="chat", input_tokens=100,
                 output_tokens=80, thinking_tokens=50)
    record_usage(user_id=1, source="chat", input_tokens=200,
                 output_tokens=40, thinking_tokens=10)
    t = usage_totals(time.time() - 3600)
    assert t["input_tokens"] == 300
    assert t["output_tokens"] == 120
    assert t["thinking_tokens"] == 60
    assert t["response_tokens"] == 60
    # Le total facturé n'a PAS bougé : la réflexion découpe la sortie.
    assert t["total_tokens"] == 420


def test_metriques_thinking_et_response_du_group_by(db):
    from shared_infra.observability.usage_store import record_usage, usage_group
    record_usage(user_id=1, source="chat", input_tokens=10,
                 output_tokens=100, thinking_tokens=70)
    record_usage(user_id=1, source="routine", input_tokens=10,
                 output_tokens=100, thinking_tokens=5)
    since = time.time() - 3600
    par_source = {r["key"]: r["value"]
                  for r in usage_group("source", since, metric="thinking")}
    assert par_source == {"chat": 70, "routine": 5}
    reponses = {r["key"]: r["value"]
                for r in usage_group("source", since, metric="response")}
    assert reponses == {"chat": 30, "routine": 95}


def test_group_by_expose_la_reflexion_a_cote_des_tokens(db):
    from shared_infra.observability.usage_store import record_usage, usage_group
    record_usage(user_id=1, source="chat", input_tokens=10,
                 output_tokens=100, thinking_tokens=70)
    row = usage_group("source", time.time() - 3600)[0]
    assert row["tokens"] == 110 and row["thinking_tokens"] == 70


# ── Widget admin ────────────────────────────────────────────────────────────

def test_kpi_reflexion_rapporte_la_part_de_sortie(db):
    from shared_infra.observability.metrics._usage_providers import KPIUsageThinkingProvider
    from shared_infra.observability.usage_store import record_usage
    record_usage(user_id=1, source="chat", input_tokens=5000,
                 output_tokens=1000, thinking_tokens=750)
    d = KPIUsageThinkingProvider().get_data(24)
    # 75 % de la SORTIE — surtout pas de l'entrée, qui n'a rien à voir avec
    # le raisonnement.
    assert d["value"] == "75.0 %"
    assert "réflexion" in d["detail"] and "réponse" in d["detail"]


def test_kpi_reflexion_ne_pretend_pas_zero_sans_mesure(db):
    """Un registre sans mesure et un modèle qui ne raisonne pas se
    ressemblent : on ne tranche pas à leur place."""
    from shared_infra.observability.metrics._usage_providers import KPIUsageThinkingProvider
    from shared_infra.observability.usage_store import record_usage
    record_usage(user_id=1, source="chat", input_tokens=10, output_tokens=100)
    assert KPIUsageThinkingProvider().get_data(24)["value"] == "—"


def test_frise_reflexion_vs_reponse_a_deux_series(db):
    from shared_infra.observability.metrics._usage_providers import UsageThinkingTimelineProvider
    from shared_infra.observability.usage_store import record_usage
    record_usage(user_id=1, source="chat", input_tokens=10,
                 output_tokens=100, thinking_tokens=70)
    chart = UsageThinkingTimelineProvider().get_data(24)
    labels = {ds["label"] for ds in chart["datasets"]}
    assert labels == {"Réflexion", "Réponse"}
    par_label = {ds["label"]: sum(ds["data"]) for ds in chart["datasets"]}
    assert par_label["Réflexion"] == 70 and par_label["Réponse"] == 30


# ── Route utilisateur ───────────────────────────────────────────────────────

@pytest.fixture()
def client(db, monkeypatch):
    import shared_infra.observability.tool_metrics_store as am
    am.init_tool_metrics_db()
    import shared_infra.scheduling.routines_store as routines
    routines.init_routines_db()
    import shared_infra.observability.routes_usage as usage_mod

    def _fake_uid(request: Request):
        uid = request.headers.get("x-test-user")
        if not uid:
            raise HTTPException(401, "auth requise")
        return int(uid)

    monkeypatch.setattr(usage_mod, "require_user_id", _fake_uid)
    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_usage_me_expose_la_decoupe_de_la_sortie(client):
    from shared_infra.observability.usage_store import record_usage
    record_usage(user_id=1, source="chat", input_tokens=1000,
                 output_tokens=800, thinking_tokens=600)
    tk = client.get("/api/usage/me", headers={"x-test-user": "1"}).json()["tokens"]
    assert tk["input"] == 1000 and tk["output"] == 800
    assert tk["thinking"] == 600 and tk["response"] == 200
    # thinking + response == output ; total inchangé.
    assert tk["thinking"] + tk["response"] == tk["output"]
    assert tk["total"] == 1800


def test_usage_me_sans_reflexion_renvoie_des_zeros(client):
    tk = client.get("/api/usage/me", headers={"x-test-user": "1"}).json()["tokens"]
    assert tk["thinking"] == 0 and tk["response"] == 0
