# SPDX-License-Identifier: MIT
"""
0010_mcp_shared_servers — Table ``mcp_shared_servers`` (bibliothèque MCP partagée).

Problème résolu : ``settings.mcp_servers`` est une liste PAR UTILISATEUR. Un
admin qui enregistre « Jenkins » (SSE + Basic auth) le range dans SES settings —
personne d'autre ne le voit, et chaque collègue doit re-saisir l'URL ET le
token, ce qui diffuse un secret d'instance dans autant de lignes
``settings_json`` que de comptes.

Cette table est la bibliothèque COMMUNE : l'admin publie une fois, tous les
comptes la voient. Chaque utilisateur choisit ensuite lesquels afficher dans son
panneau Outils (``settings.shared_mcp_visible`` — vide par défaut, donc CACHÉ
tant qu'il n'a rien coché).

Le secret d'authentification est chiffré au repos (``key_scheme='fernet'``, cf.
``shared_infra/security/encryption.py``) et n'est JAMAIS sérialisé vers HTTP : les routes
publiques ne renvoient que ``has_auth``. La résolution URL + en-tête se fait
côté serveur, au moment du tour de chat.

Même patron que ``0007_llm_connectors`` (connecteurs LLM partagés), qui résout
déjà exactement ce problème pour les backends d'inférence. Idempotent. Ne
commit PAS (le runner de migrations commit à la fin).
"""
from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS mcp_shared_servers (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            name         TEXT NOT NULL DEFAULT '',
            type         TEXT NOT NULL DEFAULT 'sse',   -- 'sse' | 'stdio'
            url          TEXT NOT NULL DEFAULT '',      -- type='sse'
            command      TEXT NOT NULL DEFAULT '',      -- type='stdio'
            auth_mode    TEXT NOT NULL DEFAULT '',      -- '' | 'basic' | 'raw'
            auth_user    TEXT NOT NULL DEFAULT '',      -- auth_mode='basic'
            auth_enc     TEXT NOT NULL DEFAULT '',      -- token / header brut, chiffré
            key_scheme   TEXT NOT NULL DEFAULT 'fernet',-- 'fernet' | 'plain'
            enabled      INTEGER NOT NULL DEFAULT 1,
            created_at   REAL NOT NULL,
            updated_at   REAL NOT NULL
        )
        """
    )
    # Chemin chaud : lister les serveurs publiés (tout compte authentifié).
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_mcpshared_enabled "
        "ON mcp_shared_servers(enabled)"
    )
