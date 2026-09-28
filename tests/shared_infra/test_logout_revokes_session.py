# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_logout_revokes_session.py

La session est un cookie SIGNÉ (Starlette ``SessionMiddleware``), sans store
serveur : ``session.clear()`` + ``delete_cookie`` n'agissent que sur un
navigateur qui coopère. Avant le correctif, se déconnecter ne révoquait donc
RIEN — un cookie capturé (poste partagé, extension, restauration d'onglets,
log de proxy) restait valide jusqu'à ``max_age``, 24 h par défaut.

La révocation doit être CIBLÉE sur la session déconnectée : ``session_min_ts``
aurait fermé toutes les sessions du compte, ce qui n'est pas ce qu'on attend
d'un logout. Régression du finding E4 de l'audit 2026-08-01.
"""
from __future__ import annotations

import sqlite3
import time

import pytest


@pytest.fixture()
def db(tmp_path, monkeypatch):
    """Base jetable dont le schéma vient de la MIGRATION réelle (0009).

    On applique la migration du dépôt plutôt qu'un CREATE TABLE recopié : le
    test casse donc aussi si la migration diverge du code qui l'utilise.
    """
    import importlib
    import shared_infra.db._connection as legacy

    path = tmp_path / "test.db"

    def _open():
        conn = sqlite3.connect(str(path))
        conn.row_factory = sqlite3.Row
        return conn

    monkeypatch.setattr(legacy, "db", _open)

    mod = importlib.import_module(
        "shared_infra.db._migrations.0009_revoked_sessions")
    conn = _open()
    try:
        mod.migrate(conn)
        conn.commit()
    finally:
        conn.close()
    return path


def test_revocation_ciblee_sur_une_seule_session(db):
    from shared_infra.accounts.users import (
        is_session_revoked, revoke_session_sid, purge_expired_revocations)

    sid_poste_a = "sid-appareil-A"
    sid_poste_b = "sid-appareil-B"

    assert is_session_revoked(sid_poste_a) is False
    assert is_session_revoked(sid_poste_b) is False

    # L'utilisateur se déconnecte depuis l'appareil A.
    assert revoke_session_sid(sid_poste_a, user_id=7) is True

    assert is_session_revoked(sid_poste_a) is True, (
        "le logout n'a rien révoqué côté serveur : un cookie capturé reste "
        "utilisable jusqu'à max_age"
    )
    assert is_session_revoked(sid_poste_b) is False, (
        "le logout a aussi fermé l'AUTRE appareil — la révocation doit être "
        "ciblée sur la session déconnectée"
    )


def test_revocation_idempotente(db):
    from shared_infra.accounts.users import is_session_revoked, revoke_session_sid

    revoke_session_sid("sid-x", user_id=1)
    revoke_session_sid("sid-x", user_id=1)      # ne doit pas lever
    assert is_session_revoked("sid-x") is True


def test_sid_vide_ignore(db):
    from shared_infra.accounts.users import is_session_revoked, revoke_session_sid

    assert revoke_session_sid("", user_id=1) is False
    assert is_session_revoked("") is False
    assert is_session_revoked(None) is False


def test_purge_des_revocations_perimees(db):
    from shared_infra.accounts.users import (
        is_session_revoked, revoke_session_sid, purge_expired_revocations)

    # Révocation ancienne (au-delà de max_age) → purgeable : la session
    # correspondante est de toute façon rejetée par le gate _login_ts.
    revoke_session_sid("vieux", user_id=1, ts=time.time() - 90_000)
    revoke_session_sid("recent", user_id=1)

    n = purge_expired_revocations(max_age_sec=86_400)
    assert n == 1
    assert is_session_revoked("vieux") is False
    assert is_session_revoked("recent") is True
