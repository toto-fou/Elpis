# SPDX-License-Identifier: MIT
"""SQL réécrit pour être commun aux moteurs (chantier multi-moteurs, lot A).

Chaque site réécrit garde EXACTEMENT son comportement SQLite : upserts
(``ON CONFLICT`` au lieu de ``INSERT OR …``), id inséré, purges de rétention
en table dérivée, verrou d'écriture, alias et table ``groups`` cités.
"""
import time

import pytest

from shared_infra.db import _connection as _legacy


@pytest.fixture
def base(tmp_path, monkeypatch):
    import shared_infra.config as _config
    monkeypatch.setattr(_legacy, "DB_PATH", str(tmp_path / "app.db"))
    monkeypatch.setattr(_config, "DB_PATH", str(tmp_path / "app.db"))
    _legacy.reset_pool()
    _legacy.init_db()
    yield
    _legacy.reset_pool()


def _count(sql, params=()):
    with _legacy.db_conn() as c:
        return c.execute(sql, params).fetchone()[0]


def test_ajout_a_un_groupe_idempotent(base):
    from shared_infra.accounts import groups as G
    from shared_infra.accounts.users import create_user
    uid = create_user("alice", "pw-alice-1")
    gid = G.create_group("equipe", "")
    assert isinstance(gid, int) and gid > 0
    G.add_user_to_group(uid, gid)
    G.add_user_to_group(uid, gid)
    assert _count("SELECT COUNT(*) FROM user_groups WHERE user_id=?", (uid,)) == 1
    lignes = {r["username"]: r for r in G.get_all_users_with_groups()}
    assert lignes["alice"]["group_names"] == "equipe"
    assert lignes["alice"]["group_ids"] == [gid]


def test_liste_des_comptes_avec_leurs_groupes(base):
    from shared_infra.accounts import groups as G
    from shared_infra.accounts.users import create_user, get_users_lite
    a = create_user("alice", "pw-alice-1")
    b = create_user("bob", "pw-bob-1")
    g1, g2 = G.create_group("un", ""), G.create_group("deux", "")
    G.set_user_groups(a, [g1, g2])
    G.set_user_groups(b, [g1])
    vus = {u["username"]: u["groups"] for u in get_users_lite(a, respect_groups=True)}
    assert set(vus) == {"bob"} and vus["bob"] == "un"
    tous = {u["username"]: u["groups"] for u in get_users_lite(b, respect_groups=False)}
    assert sorted(tous["alice"].split(", ")) == ["deux", "un"]


def test_rapport_quotidien_remplace_la_ligne_du_jour(base):
    from shared_infra.observability import daily_reports_store as R
    R.store_daily_report("2026-09-26", {"v": 1})
    R.store_daily_report("2026-09-26", {"v": 2})
    assert _count("SELECT COUNT(*) FROM daily_usage_reports") == 1
    assert R.get_daily_report("2026-09-26")["v"] == 2


def test_fusion_des_reglages_sous_verrou(base):
    from shared_infra.accounts.users import create_user, merge_user_settings
    uid = create_user("alice", "pw-alice-1")
    out = merge_user_settings(uid, lambda s: s.update({"a": 1}))
    assert out == {"a": 1}
    out = merge_user_settings(uid, lambda s: s.update({"b": 2}))
    assert out == {"a": 1, "b": 2}
    with _legacy.db_conn() as c:
        assert not c.in_transaction


def test_notifications_bornees_par_compte(base, monkeypatch):
    from shared_infra.notifications import store as N
    from shared_infra.accounts.users import create_user
    uid = create_user("alice", "pw-alice-1")
    monkeypatch.setattr(N, "_MAX_PER_USER", 3)
    ids = [N.create_notification(uid, "info", f"t{i}", "") for i in range(5)]
    assert all(isinstance(i, int) and i > 0 for i in ids)
    with _legacy.db_conn() as c:
        restants = [r[0] for r in c.execute(
            "SELECT id FROM notifications WHERE owner_user_id=? ORDER BY id", (uid,))]
    assert restants == ids[-3:]


def test_cache_d_ancres_garde_les_plus_recentes(base):
    from shared_infra.desktop import anchors as A
    now = time.time()
    with _legacy.db_conn() as c:
        for i in range(10):
            c.execute("INSERT INTO editor_action_cache(scope, query_norm, auto_id, updated_at) "
                      "VALUES('s', ?, 'x', ?)", (f"q{i}", now - 100 + i))
        c.commit()
    A.prune_action_cache(max_rows=5, keep=4)
    with _legacy.db_conn() as c:
        gardees = [r[0] for r in c.execute(
            "SELECT query_norm FROM editor_action_cache ORDER BY updated_at")]
    assert gardees == ["q6", "q7", "q8", "q9"]


def test_dedoublonnage_des_livraisons_webhook(base):
    from shared_infra.scheduling import routines_store as S
    assert S.record_webhook_delivery("d-1", 7) is True
    assert S.record_webhook_delivery("d-1", 7) is False
    assert S.record_webhook_delivery("d-1", 8) is True
