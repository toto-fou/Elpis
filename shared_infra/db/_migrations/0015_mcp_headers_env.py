# SPDX-License-Identifier: MIT
"""
0015_mcp_headers_env — En-têtes supplémentaires et variables d'environnement.

Problème résolu
===============
Un serveur MCP ne portait qu'UN créneau d'authentification, et il visait
toujours ``Authorization``. Or beaucoup de services en demandent DEUX : un
jeton de transport (« Bearer ») **et** une clé applicative dans un en-tête
propre (``X-API-Key``, ``X-Api-Token``…). C'est le cas de l'image wiki.js MCP.
Le seul chemin qui existait était la clé ``headers`` de la config perso, à
moitié câblée : lue par le transport, mais absente de l'interface, stockée EN
CLAIR dans ``settings_json`` et RENVOYÉE au navigateur à chaque GET — donc
inutilisable pour un secret.

Symétriquement, un serveur ``stdio`` n'avait aucun moyen de recevoir ses
variables d'environnement, qui sont la façon dont se configure la majorité des
serveurs MCP npm/npx (``WIKIJS_URL``, ``WIKIJS_TOKEN``…). Le seul recours était
de les poser sur le processus de l'application entière.

Deux colonnes, mêmes garanties que ``auth_enc``
===============================================
``headers_enc`` et ``env_enc`` portent chacune une LISTE de paires
``[{"name": …, "value": …}]`` sérialisée en JSON puis chiffrée (Fernet), sous
le schéma commun ``extra_scheme``. Les valeurs ne sont JAMAIS sérialisées vers
HTTP : les vues publiques ne rendent que le nom et un booléen ``has_value``,
exactement comme ``has_auth`` pour le secret principal.

Un schéma SÉPARÉ de ``key_scheme`` : les deux créneaux sont indépendants. Une
entrée peut n'avoir aucune auth principale (``auth_enc=''``, donc
``key_scheme='plain'``) tout en portant des en-têtes chiffrés — réutiliser la
même colonne aurait fait décoder du Fernet comme du texte brut.

Pas de backfill : aucune ligne partagée n'a jamais porté ces champs (ils
n'existaient que côté perso, en clair, et la reprise de ces entrées-là se fait
au vol dans ``merge_personal_mcp``). Les lignes existantes gardent ``''``,
c'est-à-dire « aucune paire ».

Idempotent. Ne commit PAS (le runner commit à la fin).
"""
from __future__ import annotations

import sqlite3


def _has_column(conn: sqlite3.Connection, table: str, column: str) -> bool:
    try:
        rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    except sqlite3.Error:
        return False
    return any((r[1] if not isinstance(r, sqlite3.Row) else r["name"]) == column
               for r in rows)


def migrate(conn: sqlite3.Connection) -> None:
    for col, default in (("headers_enc", "''"),
                         ("env_enc", "''"),
                         ("extra_scheme", "'plain'")):
        if not _has_column(conn, "mcp_shared_servers", col):
            conn.execute(
                f"ALTER TABLE mcp_shared_servers "
                f"ADD COLUMN {col} TEXT NOT NULL DEFAULT {default}"
            )
