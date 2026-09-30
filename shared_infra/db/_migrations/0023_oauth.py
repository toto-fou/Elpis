# SPDX-License-Identifier: MIT
"""
0023_oauth — Autorisation OAuth 2.1 des clients MCP (2026-09-30, lot EXT.4).

Pose les tables ``oauth_clients`` (clients enregistrés dynamiquement, par
document de métadonnées ou à la main), ``oauth_codes`` (codes d'autorisation à
usage unique) et ``oauth_tokens`` (jetons d'accès et de rafraîchissement
opaques). Seules des empreintes SHA-256 sont stockées (cf.
``shared_infra/mcp/oauth.py``).

Sur PostgreSQL et MariaDB, les migrations couvertes par le schéma de référence
sont tamponnées sans être rejouées : les tables y sont posées au démarrage par
``ensure_tables`` (``oauth._prepare``).

Idempotent. Ne commit PAS (le runner commit à la fin).
"""
from __future__ import annotations

from typing import Any


def migrate(conn: Any) -> None:
    from shared_infra.db._schema import ensure_tables
    ensure_tables(conn, ("oauth_clients", "oauth_codes", "oauth_tokens"))
