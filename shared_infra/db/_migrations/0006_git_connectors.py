# SPDX-License-Identifier: MIT
"""
0006_git_connectors — Table ``git_connectors`` (Connecteurs Git par-utilisateur).

Feature « Connecteurs Git » : remplace le fichier sale ``.git-credentials.json``
de la sandbox (lisible par l'agent, keyé par provider) par un store DB
**host-only**, keyé par ``(owner_user_id, host[, label])`` pour supporter les
instances self-hosted ET le multi-comptes, utilisé UNIFORMÉMENT par push/pull
ET la création de PR/MR.

Tokens en CLAIR en v1 (``token_scheme='plain'``) — aligné sur la posture
existante (``ax_credentials`` est déjà en clair, outil interne). La colonne
``token_scheme`` est réservée pour basculer vers un chiffrement Fernet plus tard
SANS changement de schéma (juste re-wrap des lignes ``plain``).

CRUD : ``shared_infra/git/connectors.py``. Idempotent (``IF NOT EXISTS``).
Ne commit PAS (le runner de migrations commit à la fin).
"""
from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS git_connectors (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_user_id INTEGER NOT NULL,
            provider_type TEXT NOT NULL,          -- github | gitlab | bitbucket-cloud
                                                  -- | bitbucket-server | gitea | generic
            host          TEXT NOT NULL,          -- lowercase (github.com, gitlab.acme.internal:8443)
            api_base      TEXT NOT NULL DEFAULT '',
            label         TEXT NOT NULL DEFAULT '',
            username      TEXT NOT NULL DEFAULT '',
            token_enc     TEXT NOT NULL,
            token_scheme  TEXT NOT NULL DEFAULT 'plain',   -- 'plain' | 'fernet' (réservé)
            created_at    REAL NOT NULL,
            updated_at    REAL NOT NULL,
            last_used     REAL,
            FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE CASCADE
        )
        """
    )
    # Multi-comptes sur un même host distingués par label ; empêche les doublons
    # exacts (même owner+host+label).
    cur.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_gitconn_owner_host_label "
        "ON git_connectors(owner_user_id, host, label)"
    )
    # Sert la résolution par host (le chemin chaud du résolveur).
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_gitconn_owner_host "
        "ON git_connectors(owner_user_id, host)"
    )
