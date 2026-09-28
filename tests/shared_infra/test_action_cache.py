# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_action_cache.py — cache d'actions (mémoire
inter-session des ancres résolues). Round-trip UPSERT/lookup + bornage.
"""
from __future__ import annotations

import pytest


@pytest.fixture
def sc(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    import shared_infra.desktop.anchors as scenarios
    scenarios.init_action_cache_db()
    return scenarios


def test_record_and_lookup_roundtrip(sc):
    sc.record_action_anchor("alice::vm1", "Enregistrer", "saveBtn",
                            role="button", center=[120, 240])
    rec = sc.lookup_action_anchor("alice::vm1", "Enregistrer")
    assert rec is not None
    assert rec["auto_id"] == "saveBtn"
    assert rec["role"] == "button"
    assert rec["center"] == [120, 240]


def test_lookup_is_case_insensitive_on_query(sc):
    sc.record_action_anchor("alice::vm1", "Enregistrer", "saveBtn")
    assert sc.lookup_action_anchor("alice::vm1", "ENREGISTRER")["auto_id"] == "saveBtn"


def test_lookup_unknown_returns_none(sc):
    assert sc.lookup_action_anchor("alice::vm1", "jamais vu") is None


def test_upsert_updates_auto_id_and_counts_hits(sc):
    sc.record_action_anchor("alice::vm1", "Ouvrir", "openV1")
    sc.record_action_anchor("alice::vm1", "Ouvrir", "openV2")   # l'UI a changé d'auto_id
    rec = sc.lookup_action_anchor("alice::vm1", "Ouvrir")
    assert rec["auto_id"] == "openV2"
    # hits incrémenté
    import shared_infra.db._connection as legacy
    with legacy.db_conn() as conn:
        row = conn.execute(
            "SELECT hits FROM editor_action_cache WHERE scope=? AND query_norm=?",
            ("alice::vm1", "ouvrir")).fetchone()
    assert int(row["hits"]) == 2


def test_record_noop_on_empty_auto_id(sc):
    sc.record_action_anchor("alice::vm1", "Vide", "")
    assert sc.lookup_action_anchor("alice::vm1", "Vide") is None


def test_record_noop_on_empty_query(sc):
    sc.record_action_anchor("alice::vm1", "", "someId")
    # rien d'inséré → la requête vide ne retourne rien
    assert sc.lookup_action_anchor("alice::vm1", "") is None


def test_scopes_are_isolated(sc):
    sc.record_action_anchor("alice::vm1", "X", "a1")
    sc.record_action_anchor("bob::vm1", "X", "b1")
    assert sc.lookup_action_anchor("alice::vm1", "X")["auto_id"] == "a1"
    assert sc.lookup_action_anchor("bob::vm1", "X")["auto_id"] == "b1"


def test_prune_caps_rows(sc):
    for i in range(20):
        sc.record_action_anchor("alice::vm1", f"q{i}", f"id{i}")
    purged = sc.prune_action_cache(max_rows=10, keep=8)
    assert purged == 12
    import shared_infra.db._connection as legacy
    with legacy.db_conn() as conn:
        n = conn.execute("SELECT COUNT(*) AS n FROM editor_action_cache").fetchone()["n"]
    assert n == 8


def test_prune_noop_under_cap(sc):
    sc.record_action_anchor("alice::vm1", "q", "id")
    assert sc.prune_action_cache(max_rows=10, keep=8) == 0


# ── E1 : TTL (stale-on-read + éviction par âge) ──────────────────────────────

def _age(scope, query_norm):
    """Vieillit une entrée du cache (updated_at → epoch ~0) pour simuler le TTL."""
    import shared_infra.db._connection as legacy
    with legacy.db_conn() as conn:
        conn.execute("UPDATE editor_action_cache SET updated_at=1.0 WHERE scope=? AND query_norm=?",
                     (scope, query_norm))
        conn.commit()


def test_lookup_ignores_stale_entry(sc):
    sc.record_action_anchor("alice::vm1", "Vieux", "oldId")
    _age("alice::vm1", "vieux")
    assert sc.lookup_action_anchor("alice::vm1", "Vieux") is None   # stale-on-read


def test_lookup_keeps_fresh_entry(sc):
    sc.record_action_anchor("alice::vm1", "Frais", "freshId")
    assert sc.lookup_action_anchor("alice::vm1", "Frais")["auto_id"] == "freshId"


def test_prune_evicts_by_age_even_under_size_cap(sc):
    sc.record_action_anchor("alice::vm1", "ancien", "a")
    sc.record_action_anchor("alice::vm1", "recent", "b")
    _age("alice::vm1", "ancien")
    purged = sc.prune_action_cache(max_rows=10000, keep=8000)   # bien sous le cap taille
    assert purged == 1                                          # seul l'ÂGE purge
    assert sc.lookup_action_anchor("alice::vm1", "recent")["auto_id"] == "b"
    assert sc.lookup_action_anchor("alice::vm1", "ancien") is None


def test_ttl_disabled_keeps_old_entries(sc, monkeypatch):
    monkeypatch.setattr(sc, "ACTION_CACHE_TTL_S", 0)            # 0 = pas de TTL
    sc.record_action_anchor("alice::vm1", "Vieux", "oldId")
    _age("alice::vm1", "vieux")
    assert sc.lookup_action_anchor("alice::vm1", "Vieux")["auto_id"] == "oldId"
    assert sc.prune_action_cache(max_rows=10000, keep=8000) == 0
