# SPDX-License-Identifier: MIT
"""
0009_revoked_sessions — Table ``revoked_sessions`` (révocation PAR SESSION).

Le logout ne révoquait RIEN côté serveur : la session est un cookie signé
(Starlette ``SessionMiddleware``), sans store, et ``session.clear()`` +
``delete_cookie`` n'agissent que sur le navigateur qui obéit. Un cookie capturé
(poste partagé, extension, restauration d'onglets, log de proxy) restait donc
valide jusqu'à ``max_age`` — 24 h par défaut — malgré la déconnexion.
Finding E4 de l'audit 2026-08-01.

Les deux mécanismes existants (``security.session.global_min_ts`` et
``users.session_min_ts``) révoquent TOUTES les sessions d'un utilisateur : les
employer au logout déconnecterait aussi ses autres appareils, ce qui n'est pas
ce que « se déconnecter » veut dire. On révoque donc par identifiant de session
(``_sid``, posé au login), ce qui laisse les autres appareils intacts.

Purge : une ligne devient inutile passé ``max_age`` (le gate ``_login_ts``
rejette alors la session de toute façon) — cf. ``purge_expired_revocations``
dans ``shared_infra/accounts/users.py``, appelé par la maintenance.

Ne commit PAS : le runner de migrations commit en fin d'application.
"""
from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    cur.execute(
        "CREATE TABLE IF NOT EXISTS revoked_sessions ("
        "  sid        TEXT PRIMARY KEY,"
        "  user_id    INTEGER,"
        "  revoked_at REAL NOT NULL"
        ")"
    )
    # Purge par ancienneté → index sur la date.
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_revoked_sessions_at "
        "ON revoked_sessions(revoked_at)"
    )
