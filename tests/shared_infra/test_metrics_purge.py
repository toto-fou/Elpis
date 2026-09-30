# SPDX-License-Identifier: MIT
"""
tests/shared_infra/test_metrics_purge.py — Réinitialisation des métriques et
jeton de scrape.

Avant, la seule façon de remettre un graphique à zéro était d'attendre la
rétention (90 jours) ou d'ouvrir la base à la main : après un incident ou une
campagne de tests, l'historique faussait durablement toutes les moyennes.

Deux garde-fous vérifiés ici : ``dry_run`` annonce le volume AVANT de
supprimer, et la liste des tables purgeables est FERMÉE (aucun nom de table ne
vient de la requête).
"""
from __future__ import annotations

import json
import time

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    legacy.init_db()
    from shared_infra.accounts.users import create_user
    create_user("admin", "pw")          # id=1
    create_user("staff", "pw")          # id=2
    with legacy.db_conn() as conn:
        conn.execute("UPDATE users SET is_admin=1 WHERE id=1")
        conn.execute("UPDATE users SET is_admin=2 WHERE id=2")   # modérateur
        conn.commit()
    import shared_infra.observability.tool_metrics_store as am
    am.init_tool_metrics_db()
    import shared_infra.scheduling.routines_store as routines
    routines.init_routines_db()

    # Config isolée : le jeton de scrape s'écrit dans config.json.
    cfg = tmp_path / "config.json"
    cfg.write_text("{}", encoding="utf-8")
    import shared_infra.routes.admin.metrics as mod
    monkeypatch.setattr(mod, "read_config_json",
                        lambda: json.loads(cfg.read_text(encoding="utf-8")))
    monkeypatch.setattr(mod, "write_config_json",
                        lambda c: cfg.write_text(json.dumps(c), encoding="utf-8"))

    def _fake_uid(request: Request):
        uid = request.headers.get("x-test-user")
        if not uid:
            raise HTTPException(401, "auth requise")
        return int(uid)

    monkeypatch.setattr(mod, "require_user_id", _fake_uid)

    from shared_infra.routes.admin._state import admin_router
    app = FastAPI()
    app.include_router(admin_router)
    return TestClient(app), legacy


ADMIN = {"x-test-user": "1"}
STAFF = {"x-test-user": "2"}


def _seed(legacy, n=5, source="chat", ts=None):
    from shared_infra.observability.usage_store import record_usage
    base = ts if ts is not None else time.time()
    for i in range(n):
        record_usage(user_id=1, source=source, model="m",
                     input_tokens=10, output_tokens=1, ts=base - i * 60)


def _count(legacy, table):
    with legacy.db_conn() as conn:
        return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]


# ── Purge ───────────────────────────────────────────────────────────────────

def test_dry_run_annonce_sans_supprimer(client):
    tc, legacy = client
    _seed(legacy, 5)
    r = tc.post("/api/admin/metrics/purge",
                json={"targets": ["usage_events"], "dry_run": True}, headers=ADMIN)
    assert r.status_code == 200
    body = r.json()
    assert body["dry_run"] is True
    assert body["counted"]["usage_events"] == 5
    assert body["deleted"] == {}
    assert _count(legacy, "usage_events") == 5


def test_purge_effective_et_bornee_dans_le_temps(client):
    tc, legacy = client
    now = time.time()
    _seed(legacy, 3, ts=now)                       # récents
    _seed(legacy, 2, ts=now - 10 * 86400)          # vieux
    r = tc.post("/api/admin/metrics/purge",
                json={"targets": ["usage_events"], "to": now - 86400,
                      "dry_run": False}, headers=ADMIN)
    assert r.json()["deleted"]["usage_events"] == 2
    assert _count(legacy, "usage_events") == 3


def test_purge_selective_par_source(client):
    tc, legacy = client
    _seed(legacy, 3, source="chat")
    _seed(legacy, 4, source="routine")
    r = tc.post("/api/admin/metrics/purge",
                json={"targets": ["usage_events"], "sources": ["routine"],
                      "dry_run": False}, headers=ADMIN)
    assert r.json()["deleted"]["usage_events"] == 4
    assert _count(legacy, "usage_events") == 3


def test_purge_selective_par_type_devenement(client):
    tc, legacy = client
    legacy.log_metric("llm_latency", 1.0, {"model": "m"})
    legacy.log_metric("write_tps", 50.0, {"model": "m"})
    r = tc.post("/api/admin/metrics/purge",
                json={"targets": ["metric_events"], "event_types": ["llm_latency"],
                      "dry_run": False}, headers=ADMIN)
    assert r.json()["deleted"]["metric_events"] == 1
    assert _count(legacy, "metric_events") == 1


def test_cible_inconnue_refusee(client):
    tc, _ = client
    r = tc.post("/api/admin/metrics/purge",
                json={"targets": ["users"], "dry_run": False}, headers=ADMIN)
    assert r.status_code == 400
    assert "inconnue" in r.json()["detail"].lower()


def test_sans_cible_rien_nest_supprime(client):
    tc, legacy = client
    _seed(legacy, 3)
    assert tc.post("/api/admin/metrics/purge", json={}, headers=ADMIN).status_code == 400
    assert tc.post("/api/admin/metrics/purge", json={"targets": []},
                   headers=ADMIN).status_code == 400
    assert _count(legacy, "usage_events") == 3


def test_purge_reservee_a_ladmin_strict(client):
    tc, legacy = client
    _seed(legacy, 2)
    assert tc.post("/api/admin/metrics/purge",
                   json={"targets": ["usage_events"]}, headers=STAFF).status_code == 403
    assert tc.post("/api/admin/metrics/purge",
                   json={"targets": ["usage_events"]}).status_code == 401
    assert _count(legacy, "usage_events") == 2


def test_purge_effective_journalisee_a_laudit(client, monkeypatch):
    tc, legacy = client
    _seed(legacy, 2)
    vus = []
    import shared_infra.security.audit as audit
    monkeypatch.setattr(audit, "audit_event",
                        lambda **kw: vus.append(kw))
    tc.post("/api/admin/metrics/purge",
            json={"targets": ["usage_events"], "dry_run": True}, headers=ADMIN)
    assert not vus, "un dry_run ne doit rien journaliser"
    tc.post("/api/admin/metrics/purge",
            json={"targets": ["usage_events"], "dry_run": False}, headers=ADMIN)
    assert vus and vus[0]["action"] == "admin.metrics.purge"
    assert vus[0]["details"]["deleted"]["usage_events"] == 2


# ── Export (le filet avant purge) ───────────────────────────────────────────

def test_export_du_registre_en_csv(client):
    tc, legacy = client
    _seed(legacy, 3)
    r = tc.get("/api/admin/export-metrics?target=usage_events&days=1", headers=ADMIN)
    assert r.status_code == 200
    lignes = r.text.strip().splitlines()
    assert lignes[0].startswith("ts,user_id,source")
    # Réflexion (sous-ensemble de la sortie) et exécution (L5) exportées.
    entete = lignes[0].split(",")
    assert {"thinking_tokens", "run_id"} <= set(entete)
    assert len(lignes) == 4          # en-tête + 3
    assert tc.get("/api/admin/export-metrics?target=users", headers=ADMIN).status_code == 400


# ── Jeton de scrape ─────────────────────────────────────────────────────────

def test_prometheus_refuse_sans_session_ni_jeton(client):
    tc, _ = client
    assert tc.get("/api/admin/metrics/prometheus").status_code == 401


def test_jeton_de_scrape_genere_puis_revoque(client):
    tc, _ = client
    assert tc.get("/api/admin/metrics/scrape-token", headers=ADMIN).json() == {
        "configured": False, "token": None}
    tok = tc.post("/api/admin/metrics/scrape-token",
                  json={"action": "generate"}, headers=ADMIN).json()["token"]
    assert tok and len(tok) >= 32

    # Un collecteur n'a pas de session : les deux présentations fonctionnent.
    assert tc.get("/api/admin/metrics/prometheus",
                  headers={"Authorization": f"Bearer {tok}"}).status_code == 200
    assert tc.get(f"/api/admin/metrics/prometheus?token={tok}").status_code == 200
    assert tc.get("/api/admin/metrics/prometheus?token=faux").status_code == 401

    tc.post("/api/admin/metrics/scrape-token", json={"action": "revoke"}, headers=ADMIN)
    assert tc.get("/api/admin/metrics/prometheus",
                  headers={"Authorization": f"Bearer {tok}"}).status_code == 401


def test_gestion_du_jeton_reservee_a_ladmin(client):
    tc, _ = client
    assert tc.get("/api/admin/metrics/scrape-token", headers=STAFF).status_code == 403
    assert tc.post("/api/admin/metrics/scrape-token",
                   json={"action": "generate"}, headers=STAFF).status_code == 403


def test_export_prometheus_expose_lexploitation(client):
    """Les séries qu'un exploitant veut alerter : conso par source, statut des
    tours, santé du planificateur. Aucune n'était exposée."""
    tc, legacy = client
    _seed(legacy, 2, source="routine")
    body = tc.get("/api/admin/metrics/prometheus", headers=ADMIN).text
    for serie in ("elpis_tokens_total", "elpis_turns_total", "elpis_tokens_offhours",
                  "elpis_tokens_by_source", "elpis_turns_by_source",
                  "elpis_turns_by_status", "elpis_tokens_by_model",
                  "elpis_routine_runs", "elpis_scheduler_last_seen_seconds",
                  "elpis_maintenance_last_run_seconds",
                  "elpis_scheduler_skipped_minutes_24h"):
        assert serie in body, serie
    assert 'elpis_tokens_by_source{window="1d",source="routine"} 22' in body
    # La série morte : elle sommait ``total_tokens`` de metric_events, que plus
    # personne n'émet — elle aurait exporté 0 pour toujours.
    assert "elpis_tokens_24h" not in body


def test_prometheus_expose_les_trois_fenetres(client):
    """Un collecteur ne peut PAS reconstituer 30 jours depuis une jauge 24 h :
    il faut lui donner les trois fenêtres."""
    tc, legacy = client
    now = time.time()
    _seed(legacy, 1, ts=now)                       # dans les 3 fenêtres
    _seed(legacy, 1, ts=now - 3 * 86400)           # 7 j et 30 j
    _seed(legacy, 1, ts=now - 20 * 86400)          # 30 j seulement
    _seed(legacy, 1, ts=now - 60 * 86400)          # hors de toutes
    body = tc.get("/api/admin/metrics/prometheus", headers=ADMIN).text
    vals = {}
    for ligne in body.splitlines():
        if ligne.startswith("elpis_turns_total{"):
            fenetre = ligne.split('window="')[1].split('"')[0]
            vals[fenetre] = int(ligne.rsplit(" ", 1)[1])
    assert vals == {"1d": 1, "7d": 2, "30d": 3}
