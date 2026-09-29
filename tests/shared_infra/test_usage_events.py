# SPDX-License-Identifier: MIT
"""
tests/shared_infra/test_usage_events.py — Registre d'usage : écriture, contexte
et absence de double comptage.

Le défaut que ces tests verrouillent : un tour outillé était journalisé DEUX
fois (une fois par la boucle, une fois par la route), et tout ce qui tournait
sans navigateur — routines, webhooks, sous-agents — n'était journalisé nulle
part. Les deux symptômes venaient du même choix : mesurer chez l'appelant.
"""
from __future__ import annotations

import asyncio
import time

import pytest


@pytest.fixture()
def db(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    legacy.init_db()
    from shared_infra.accounts.users import create_user
    assert create_user("alice", "pw") == 1
    assert create_user("bob", "pw") == 2
    return legacy


def _rows(db):
    with db.db_conn() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM usage_events ORDER BY id").fetchall()]


# ── Schéma / écriture ───────────────────────────────────────────────────────

@pytest.mark.sqlite_only   # introspection PRAGMA de la migration SQLite
def test_migration_cree_la_table_et_ses_index(db):
    with db.db_conn() as conn:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(usage_events)")}
        idx = {r[1] for r in conn.execute("PRAGMA index_list(usage_events)")}
        met = {r[1] for r in conn.execute("PRAGMA table_info(metric_events)")}
    assert {"ts", "user_id", "source", "origin_id", "parent_id", "model",
            "input_tokens", "output_tokens", "cache_read_tokens",
            "status", "error_kind"} <= cols
    assert {"idx_usage_ts", "idx_usage_user_ts", "idx_usage_source_ts"} <= idx
    # metric_events gagne l'attribution par ID (le tag username restait un
    # piège au rename).
    assert "user_id" in met


def test_tour_sans_token_ni_erreur_nest_pas_enregistre(db):
    from shared_infra.observability.usage_store import record_usage
    assert record_usage(user_id=1, source="chat") is False
    # ...mais un échec compte : c'est lui qui alimente le taux d'erreur.
    assert record_usage(user_id=1, source="chat", status="error") is True
    assert len(_rows(db)) == 1


def test_record_usage_ne_leve_jamais(db, monkeypatch):
    """Une métrique perdue est un incident de télémétrie, pas de conversation."""
    import shared_infra.observability.usage_store as ue

    def _boom():
        raise RuntimeError("base indisponible")

    monkeypatch.setattr(ue, "db_conn", _boom)
    assert ue.record_usage(user_id=1, source="chat", input_tokens=10) is False


def test_valeurs_negatives_ramenees_a_zero(db):
    from shared_infra.observability.usage_store import record_usage
    record_usage(user_id=1, source="chat", input_tokens=-5, output_tokens=7)
    assert _rows(db)[0]["input_tokens"] == 0


# ── Contexte d'usage ────────────────────────────────────────────────────────

def test_scope_nomme_la_source_et_attribue_le_user(db):
    from shared_infra.observability.usage_ctx import record_turn_usage, usage_scope
    with usage_scope("routine", user_id=2, origin_id="routine:7:run:3"):
        record_turn_usage(usage={"prompt_tokens": 900, "completion_tokens": 100},
                          model="qwen3", path="tools", iterations=4)
    row = _rows(db)[0]
    assert row["source"] == "routine" and row["user_id"] == 2
    assert row["origin_id"] == "routine:7:run:3"
    assert row["input_tokens"] == 900 and row["output_tokens"] == 100


def test_sans_scope_la_conso_reste_visible_en_non_attribuee(db):
    """Un chemin qui oublie de se nommer ne DISPARAÎT pas : il apparaît en
    « unknown », donc il se corrige."""
    from shared_infra.observability.usage_ctx import record_turn_usage
    record_turn_usage(usage={"prompt_tokens": 10, "completion_tokens": 1}, model="m")
    assert _rows(db)[0]["source"] == "unknown"


def test_le_scope_imbrique_herite_du_user_et_pointe_le_parent(db):
    from shared_infra.observability.usage_ctx import record_turn_usage, usage_scope

    async def enfant():
        with usage_scope("subagent", origin_id="c1#task-a", parent_id="c1"):
            record_turn_usage(usage={"prompt_tokens": 50, "completion_tokens": 5})

    async def parent():
        with usage_scope("chat", user_id=1, origin_id="c1"):
            record_turn_usage(usage={"prompt_tokens": 300, "completion_tokens": 40})
            # Tâche fille : le contexte est COPIÉ à la création — c'est ce qui
            # rattache un sous-agent à l'utilisateur qui l'a déclenché.
            await asyncio.create_task(enfant())

    asyncio.run(parent())
    rows = _rows(db)
    enfant_row = [r for r in rows if r["source"] == "subagent"][0]
    assert enfant_row["user_id"] == 1          # hérité du parent
    assert enfant_row["parent_id"] == "c1"


def test_le_scope_est_restaure_en_sortie_de_bloc(db):
    from shared_infra.observability.usage_ctx import current_usage_ctx, usage_scope
    with usage_scope("chat", user_id=1):
        with usage_scope("compression"):
            assert current_usage_ctx().source == "compression"
        assert current_usage_ctx().source == "chat"


def test_tokens_de_cache_anthropic_conserves(db):
    from shared_infra.observability.usage_ctx import record_turn_usage, usage_scope
    with usage_scope("chat", user_id=1):
        record_turn_usage(usage={"prompt_tokens": 100, "completion_tokens": 10,
                                 "cache_read_input_tokens": 4000,
                                 "cache_creation_input_tokens": 500},
                          model="claude-opus-5")
    row = _rows(db)[0]
    assert row["cache_read_tokens"] == 4000 and row["cache_creation_tokens"] == 500
    # Le cache n'est PAS replié dans input_tokens (il n'y est pas facturé pareil).
    assert row["input_tokens"] == 100


# ── Non-régression : plus aucun double comptage ─────────────────────────────

def test_aucun_chemin_ne_journalise_plus_de_tokens_dans_metric_events():
    """Le double comptage venait de log_metric('total_tokens') appelé À LA FOIS
    par la boucle et par la route. Ce test échoue si un appel réapparaît."""
    import pathlib
    import re
    racine = pathlib.Path(__file__).resolve().parents[2]
    motif = re.compile(r"""log_metric\(\s*["'](total_tokens|input_tokens|"""
                       r"""output_tokens|task_child_tokens)["']""")
    coupables = []
    for rel in ("llm_core", "chatbot_app", "shared_infra"):
        for f in (racine / rel).rglob("*.py"):
            if motif.search(f.read_text(encoding="utf-8", errors="ignore")):
                coupables.append(str(f.relative_to(racine)))
    assert not coupables, f"tokens re-journalisés dans metric_events : {coupables}"


# ── Agrégats ────────────────────────────────────────────────────────────────

def test_totaux_et_regroupements(db):
    from shared_infra.observability.usage_store import record_usage, usage_group, usage_totals
    now = time.time()
    record_usage(user_id=1, source="chat", model="a", input_tokens=100, output_tokens=10, ts=now)
    record_usage(user_id=2, source="routine", model="b", input_tokens=900, output_tokens=90, ts=now)
    record_usage(user_id=2, source="routine", model="b", status="error", ts=now)

    t = usage_totals(now - 3600)
    assert t["total_tokens"] == 1100 and t["turns"] == 3 and t["failures"] == 1
    par_source = {r["key"]: r["value"] for r in usage_group("source", now - 3600)}
    assert par_source == {"routine": 990, "chat": 110}
    # Dimension inconnue → liste vide, jamais d'interpolation SQL sauvage.
    assert usage_group("'; DROP TABLE usage_events; --", now - 3600) == []


def test_fenetre_temporelle_bornee(db):
    from shared_infra.observability.usage_store import record_usage, usage_totals
    now = time.time()
    record_usage(user_id=1, source="chat", input_tokens=1, ts=now - 40 * 86400)
    record_usage(user_id=1, source="chat", input_tokens=2, ts=now)
    assert usage_totals(now - 86400)["turns"] == 1
    assert usage_totals(now - 60 * 86400)["turns"] == 2


def test_purge_par_fenetre_et_retention(db):
    from shared_infra.db._connection import db_conn
    from shared_infra.observability.usage_store import delete_usage_events, purge_usage_events, record_usage

    def count_usage_events():
        with db_conn() as conn:
            return conn.execute("SELECT COUNT(*) FROM usage_events").fetchone()[0]
    now = time.time()
    for i in range(4):
        record_usage(user_id=1, source="chat", input_tokens=1, ts=now - i * 86400)
    assert count_usage_events() == 4
    assert delete_usage_events(to_ts=now - 2.5 * 86400) == 1   # le plus vieux
    assert purge_usage_events(0) == 0            # 0 = purge désactivée
    assert purge_usage_events(1) == 2            # rétention 1 j : reste le seau du jour
    assert count_usage_events() == 1
