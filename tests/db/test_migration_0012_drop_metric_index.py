# SPDX-License-Identifier: MIT
"""Migration 0012 — retrait d'``idx_metrics_user_date``.

L'index coûtait 2,51 Mo et une écriture de B-tree par métrique, pour une
lecture qui n'existe pas : aucune requête ne filtre ``metric_events`` sur
``user_id``, aucun appelant de ``log_metric`` ne renseigne la colonne.
L'attribution par-utilisateur vit dans ``usage_events``, avec ses propres index.
"""
import pathlib
import re
import sqlite3

import pytest

from shared_infra.db import _connection as _legacy

# Migration historique d'une base SQLite (une base serveur naît du schéma de référence).
pytestmark = pytest.mark.sqlite_only


@pytest.fixture
def fresh_db(tmp_path, monkeypatch):
    monkeypatch.setattr(_legacy, "DB_PATH", str(tmp_path / "app.db"))
    _legacy.reset_pool()
    _legacy.init_db()
    yield
    _legacy.reset_pool()


def _indexes(table="metric_events"):
    with _legacy.db_conn() as conn:
        return {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?",
            (table,))}


def test_l_index_inutilise_est_absent_d_une_base_neuve(fresh_db):
    assert "idx_metrics_user_date" not in _indexes()


def test_l_index_utile_est_conserve(fresh_db):
    """Le plan d'exécution de toutes les requêtes réelles passe par lui."""
    assert "idx_metrics_type_date" in _indexes()


def test_la_colonne_user_id_reste(fresh_db):
    """On retire l'INDEX, pas la donnée : 28 lignes historiques la portent."""
    with _legacy.db_conn() as conn:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(metric_events)")}
    assert "user_id" in cols


def test_la_migration_est_enregistree(fresh_db):
    with _legacy.db_conn() as conn:
        names = {r[0] for r in conn.execute("SELECT name FROM schema_migrations")}
    assert any(n.startswith("0012") for n in names)


def test_l_index_est_bien_droppe_sur_une_base_qui_le_portait(tmp_path, monkeypatch):
    """Cas réel : une base existante où 0011 a déjà tourné."""
    db = tmp_path / "legacy.db"
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE metric_events (id INTEGER PRIMARY KEY, "
                 "event_type TEXT, value REAL, tags_json TEXT, "
                 "created_at REAL, user_id INTEGER)")
    conn.execute("CREATE INDEX idx_metrics_user_date "
                 "ON metric_events(user_id, created_at DESC)")
    conn.commit()
    conn.close()

    monkeypatch.setattr(_legacy, "DB_PATH", str(db))
    _legacy.reset_pool()
    _legacy.init_db()
    try:
        assert "idx_metrics_user_date" not in _indexes()
    finally:
        _legacy.reset_pool()


def test_l_index_n_est_plus_recree_par_la_migration_0011():
    """Sans ça, une base neuve le poserait juste avant que 0012 ne l'enlève.

    Inutile mais surtout trompeur : on lirait dans 0011 une intention que le
    code ne tient plus.
    """
    src = pathlib.Path(
        "shared_infra/db/_migrations/0011_usage_events.py").read_text(encoding="utf-8")
    creations = re.findall(r"CREATE INDEX[^\"']*idx_metrics_user_date", src)
    assert creations == []
