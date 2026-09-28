# SPDX-License-Identifier: MIT
"""
0011_usage_events — Registre d'usage LLM réel, attribué, une ligne par tour.

Problème résolu
===============
Toute la télémétrie de tokens vivait dans ``metric_events``, une table EAV
(``event_type``/``value``/``tags_json``) écrite PAR L'APPELANT. Trois défauts
structurels en découlaient, tous vérifiés dans le code :

1. **Double comptage.** Le chemin outils logge ``total_tokens`` deux fois pour
   le MÊME tour : une fois dans la boucle (mode ``mcp_native``) et une fois
   dans la route de chat (mode ``mcp``). Le défaut est documenté depuis l'audit
   dans ``shared_infra/observability/routes_usage.py`` — l'onglet Utilisation s'en protège en
   n'additionnant jamais total et input+output, mais le tableau de bord admin
   somme naïvement : ses « Tokens (24 h) » valent environ le double du réel.

2. **Attribution absente.** Le tag ``user`` est le *username* (un rename
   orpheline l'historique), il n'y a ni ``chat_id`` ni notion de SOURCE. Un run
   de routine nocturne, un webhook ou un sous-agent produisent donc des tokens
   qu'aucune vue ne sait rattacher — et les vues d'activité (DAU, heatmap
   jour × heure) lisent ``message_sent``, émis UNIQUEMENT par la route de chat
   interactive : tout ce qui tourne pendant que personne n'est au navigateur
   s'affiche à zéro.

3. **Modèle faux.** La boucle outils tague ``LLAMA_MODEL`` (constante de
   configuration) au lieu du modèle réellement ciblé — les répartitions par
   modèle mentent dès qu'un connecteur externe sert le tour.

Cette table est le registre unique : **une ligne par tour LLM**, écrite en UN
seul endroit (fin de tour, dans la boucle), avec l'``usage`` réel du backend et
le contexte porté par ``shared_infra/observability/usage_ctx.py``. Ce qui rend l'activité
hors heures visible n'est pas un widget de plus : c'est le déplacement du point
de mesure, de la route vers la boucle, par où passent AUSSI les routines, les
webhooks et les sous-agents.

``metric_events`` survit pour les compteurs non-LLM (connexions, écritures
sandbox, RAG, ``proc_*``) et gagne une colonne ``user_id`` pour cesser de
dépendre du username. Pas de backfill : l'historique de tokens est
double-compté, donc non reconstituable — les vues neuves annoncent la date de
démarrage du registre (``MIN(ts)``) plutôt que d'inventer un passé.

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
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS usage_events (
            id                    INTEGER PRIMARY KEY AUTOINCREMENT,
            ts                    REAL    NOT NULL,   -- epoch (UTC), fin de tour
            user_id               INTEGER,            -- l'ID, JAMAIS le username
            source                TEXT    NOT NULL DEFAULT 'unknown',
            -- chat | routine | webhook | subagent | title | compression
            -- | scenario | remote | unknown
            origin_id             TEXT    NOT NULL DEFAULT '',
            -- chat_id, run_chat_key(routine,run), child_id du sous-agent…
            parent_id             TEXT    NOT NULL DEFAULT '',
            -- sous-agent → origin_id du tour parent (chaînage de la conso)
            model                 TEXT    NOT NULL DEFAULT '',
            connector             TEXT    NOT NULL DEFAULT '',
            path                  TEXT    NOT NULL DEFAULT '',
            -- classic | tools | forced_tool | open_tools
            input_tokens          INTEGER NOT NULL DEFAULT 0,
            output_tokens         INTEGER NOT NULL DEFAULT 0,
            submitted_tokens      INTEGER NOT NULL DEFAULT 0,
            -- cumul des prompts de TOUTES les itérations d'outils (vérité
            -- de facturation API), ≠ input_tokens du dernier appel
            cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
            cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
            duration_ms           INTEGER NOT NULL DEFAULT 0,
            iterations            INTEGER NOT NULL DEFAULT 0,
            status                TEXT    NOT NULL DEFAULT 'ok',
            -- ok | error | aborted | timeout | tool_limit
            error_kind            TEXT    NOT NULL DEFAULT ''
        )
        """
    )
    # Chemins chauds des providers : fenêtre temporelle d'abord (toutes les
    # vues sont bornées), puis découpe par utilisateur / source / modèle.
    cur.execute("CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events(ts DESC)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_usage_user_ts ON usage_events(user_id, ts DESC)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_usage_source_ts ON usage_events(source, ts DESC)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_usage_model_ts ON usage_events(model, ts DESC)")
    # Taux d'erreur : index partiel, comme tool_call_metrics — les tours en
    # échec sont rares, on ne veut pas scanner les tours ok pour les trouver.
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_usage_status_ts "
        "ON usage_events(status, ts DESC) WHERE status != 'ok'"
    )

    # ── metric_events : attribution par ID (le username restait dans tags_json,
    #    un rename orphelinait l'historique). Colonne nullable : les lignes
    #    existantes gardent NULL, les vues les traitent comme non attribuées.
    if not _has_column(conn, "metric_events", "user_id"):
        cur.execute("ALTER TABLE metric_events ADD COLUMN user_id INTEGER")
    # NOTE — un index ``(user_id, created_at DESC)`` était posé ici. La
    # migration 0012 le retire : aucune requête ne filtre metric_events sur
    # user_id, aucun appelant de log_metric ne renseigne la colonne, et
    # l'attribution par-utilisateur vit dans usage_events (ci-dessus) avec ses
    # propres index. On ne le crée donc plus, pour ne pas le rétablir sur une
    # base neuve juste avant que 0012 ne le supprime.
