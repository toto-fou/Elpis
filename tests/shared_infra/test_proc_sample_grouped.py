# SPDX-License-Identifier: MIT
"""Télémétrie de process groupée — une ligne au lieu de dix.

Le sampler écrivait dix lignes ``metric_events`` par échantillon (une par
jauge), soit 51 % des lignes de la table. Il en écrit désormais une seule,
les jauges dans ``tags_json``.

L'enjeu de non-régression est la LECTURE : les lignes de l'ancien format
restent en base jusqu'au bout de la rétention (90 j), donc les courbes du
dashboard doivent afficher les deux sans discontinuité.
"""
import json
import time

import pytest

from shared_infra.db import _connection as _legacy
from shared_infra.observability.metrics import process_sampler as ps


@pytest.fixture
def db(tmp_path, monkeypatch):
    monkeypatch.setattr(_legacy, "DB_PATH", str(tmp_path / "app.db"))
    _legacy.reset_pool()
    _legacy.init_db()
    yield
    _legacy.reset_pool()


def _insert(event_type, value, tags, at):
    with _legacy.db_conn() as conn:
        conn.execute(
            "INSERT INTO metric_events(event_type, value, tags_json, created_at) "
            "VALUES (?,?,?,?)",
            (event_type, value, json.dumps(tags), at))
        conn.commit()


def _old(gauge, value, at):
    _insert(gauge, value, {"pid": 1}, at)


def _new(gauges, at):
    _insert(ps.PROC_SAMPLE_EVENT, 1.0, {"pid": 1, **gauges}, at)


# ── Écriture ────────────────────────────────────────────────────────────────

def test_un_echantillon_ecrit_une_seule_ligne(db, monkeypatch):
    monkeypatch.setattr(ps, "_SAMPLES", [("proc_rss_mb", lambda: 42.0),
                                         ("proc_num_fds", lambda: 7.0)])
    ps.sample_once()
    with _legacy.db_conn() as conn:
        rows = conn.execute("SELECT event_type, tags_json FROM metric_events").fetchall()
    assert len(rows) == 1, "dix jauges ne doivent plus faire dix lignes"
    assert rows[0][0] == ps.PROC_SAMPLE_EVENT
    tags = json.loads(rows[0][1])
    assert tags["proc_rss_mb"] == 42.0
    assert tags["proc_num_fds"] == 7.0
    assert "pid" in tags


def test_un_accesseur_qui_leve_n_empeche_pas_les_autres(db, monkeypatch):
    def boom():
        raise RuntimeError("psutil absent")
    monkeypatch.setattr(ps, "_SAMPLES", [("proc_rss_mb", lambda: 12.0),
                                         ("proc_num_fds", boom)])
    collected = ps.sample_once()
    assert collected == {"proc_rss_mb": 12.0}
    with _legacy.db_conn() as conn:
        tags = json.loads(conn.execute("SELECT tags_json FROM metric_events").fetchone()[0])
    assert tags["proc_rss_mb"] == 12.0
    assert "proc_num_fds" not in tags


def test_aucune_ligne_si_rien_n_a_pu_etre_collecte(db, monkeypatch):
    def boom():
        raise RuntimeError("nope")
    monkeypatch.setattr(ps, "_SAMPLES", [("proc_rss_mb", boom)])
    assert ps.sample_once() == {}
    with _legacy.db_conn() as conn:
        assert conn.execute("SELECT COUNT(*) FROM metric_events").fetchone()[0] == 0


# ── Lecture : les deux formats cohabitent ───────────────────────────────────

def test_la_courbe_couvre_les_deux_formats(db):
    """Le cas qui compte : une base à cheval sur le déploiement."""
    from shared_infra.observability.metrics.engine import _proc_trend_chart
    now = time.time()
    _old("proc_rss_mb", 100.0, now - 3 * 3600)      # avant la bascule
    _new({"proc_rss_mb": 200.0}, now - 1 * 3600)    # après

    data = _proc_trend_chart([("proc_rss_mb", "RSS", "1,2,3", True)], days=7)
    valeurs = [v for v in data["datasets"][0]["data"] if v is not None]
    assert 100.0 in valeurs and 200.0 in valeurs, \
        "la courbe ne doit pas se couper à la date de bascule"


def test_la_courbe_prend_le_max_par_heure(db):
    """Multi-worker : c'est le pire worker qui doit ressortir."""
    from shared_infra.observability.metrics.engine import _proc_trend_chart
    now = time.time()
    _new({"proc_rss_mb": 100.0}, now - 60)
    _new({"proc_rss_mb": 350.0}, now - 50)
    data = _proc_trend_chart([("proc_rss_mb", "RSS", "1,2,3", True)], days=7)
    assert max(v for v in data["datasets"][0]["data"] if v is not None) == 350.0


def test_une_jauge_absente_des_tags_ne_devient_pas_un_zero(db):
    """``json_extract`` rend NULL sur une clé absente.

    Sans le filtre ``v IS NOT NULL``, un accesseur indisponible (psutil manquant,
    par exemple) tracerait une courbe à plat à zéro — indiscernable d'un
    compteur réellement nul, donc trompeur.
    """
    from shared_infra.observability.metrics.engine import _proc_trend_chart
    now = time.time()
    _new({"proc_rss_mb": 100.0}, now - 60)          # pas de proc_num_fds
    data = _proc_trend_chart([("proc_num_fds", "fd", "1,2,3", False)], days=7)
    assert data["datasets"][0]["data"] == []


def test_l_ordre_des_points_est_chronologique(db):
    from shared_infra.observability.metrics.engine import _proc_trend_chart
    now = time.time()
    for i in (5, 1, 3):
        _new({"proc_rss_mb": float(i)}, now - i * 3600)
    data = _proc_trend_chart([("proc_rss_mb", "RSS", "1,2,3", True)], days=7)
    assert data["datasets"][0]["data"] == [5.0, 3.0, 1.0]


# ── Battement du planificateur ──────────────────────────────────────────────

def test_le_battement_est_lu_dans_les_deux_formats(db):
    now = time.time()
    with _legacy.db_conn() as conn:
        assert ps.last_heartbeat_at(conn) == 0.0, "aucune donnée → jamais vu"

    _old("proc_scheduler_alive", 1.0, now - 600)
    with _legacy.db_conn() as conn:
        assert ps.last_heartbeat_at(conn) == pytest.approx(now - 600)

    _new({"proc_scheduler_alive": 1.0}, now - 60)
    with _legacy.db_conn() as conn:
        assert ps.last_heartbeat_at(conn) == pytest.approx(now - 60)


def test_un_worker_non_leader_ne_compte_pas_comme_battement(db):
    """En multi-worker, les non-leaders écrivent 0 — ce n'est pas un signe de vie."""
    now = time.time()
    _new({"proc_scheduler_alive": 0.0}, now - 60)
    with _legacy.db_conn() as conn:
        assert ps.last_heartbeat_at(conn) == 0.0
