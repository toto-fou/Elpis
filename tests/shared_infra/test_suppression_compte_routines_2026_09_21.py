# SPDX-License-Identifier: MIT
"""Audit 2026-09-21 (M5, faux positif) — les routines d'un compte supprimé
partent avec lui : ``ON DELETE CASCADE`` + ``PRAGMA foreign_keys=ON`` posé sur
chaque connexion. Ce test fige ce contrat (retirer le PRAGMA les ferait
survivre et tourner pour un compte fantôme)."""
from __future__ import annotations


def test_routines_supprimees_avec_le_compte(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_ENCRYPTION_KEY", "cle-de-test")
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    legacy.init_db()
    import shared_infra.scheduling.routines_store as rt
    rt.init_routines_db()
    from shared_infra.accounts.users import create_user, delete_user_full
    uid = create_user("bob", "Motdepasse-123")
    rt.create_routine(uid, name="r", cron_expr="* * * * *", model=None,
                      system_prompt="", task_prompt="t", mcp_servers=[])
    assert len(rt.list_enabled_routines()) == 1
    assert delete_user_full(uid) is True
    assert rt.list_enabled_routines() == []
