# SPDX-License-Identifier: MIT
"""
0025_usage_entree_inclusive — Entrée des connecteurs Anthropic ramenée au sens
commun : cache compris.

llama.cpp et les moteurs compatibles OpenAI comptent le cache lu DANS l'entrée ;
Anthropic l'y AJOUTE (``input_tokens`` = tokens neufs seulement). Le code
normalise désormais à la source (``providers/anthropic._normalize_usage``) ; ici,
les lignes déjà écrites passent au même sens, pour que « entrée = cache + utile »
vaille sur tout l'historique :

- ``usage_events`` : lignes des connecteurs Anthropic, lignes sans moteur
  (``connector`` vide, avant L5.1) qui portent du cache — seul Anthropic en
  remplissait alors —, et toute ligne où le cache dépasse l'entrée
  (impossible au sens commun : connecteur Anthropic supprimé depuis) ;
- ``runs`` : mêmes règles, sur le moteur de l'exécution.

Base serveur existante : jouée par ``run_pending`` (``PORTABLE``), pas
tamponnée avec le schéma de référence (cf. ``_connection._migrate``).

Sans cache (cas courant : Elpis ne pose pas de ``cache_control``), rien ne
change. Base neuve : aucune ligne, migration tamponnée. Ne commit PAS (le
runner commit à la fin).
"""
from __future__ import annotations

from typing import Any

# SQL valable sur SQLite, PostgreSQL et MariaDB : la suite multi-moteurs la
# rejoue telle quelle (cf. tests/conftest.py).
PORTABLE = True


def migrate(conn: Any) -> None:
    from shared_infra.db._dialect import table_names
    tables = set(table_names(conn))
    keys = []
    if "llm_connectors" in tables:
        keys = [f"conn:{int(r[0])}" for r in conn.execute(
            "SELECT id FROM llm_connectors WHERE wire = 'anthropic'").fetchall()]
    marks = ", ".join("?" * len(keys))
    with_cache = "(cache_read_tokens > 0 OR cache_creation_tokens > 0)"
    if "usage_events" in tables:
        engines = "connector = '' OR cache_read_tokens > input_tokens"
        if keys:
            engines += f" OR connector IN ({marks})"
        conn.execute(
            "UPDATE usage_events SET "
            "input_tokens = input_tokens + cache_read_tokens + cache_creation_tokens, "
            "submitted_tokens = submitted_tokens + cache_read_tokens + cache_creation_tokens "
            f"WHERE {with_cache} AND ({engines})", tuple(keys))
    if "runs" in tables:
        engines = "cache_read_tokens > input_tokens"
        if keys:
            engines += f" OR engine IN ({marks})"
        conn.execute(
            "UPDATE runs SET input_tokens = input_tokens + cache_read_tokens + cache_creation_tokens "
            f"WHERE {with_cache} AND ({engines})", tuple(keys))
