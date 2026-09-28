# SPDX-License-Identifier: MIT
"""
0012_drop_unused_metric_index — Retire ``idx_metrics_user_date``, jamais utilisé.

Ce que mesurait le constat
==========================
Sur la base de développement (39,5 Mo), ``metric_events`` et ses index pèsent
19,9 Mo — la moitié du fichier, pour 1,28 Mo de conversations réelles. Dans ce
total, ``idx_metrics_user_date`` occupe **2,51 Mo**. Trois vérifications, toutes
concordantes :

1. **Aucune requête ne filtre sur ``user_id``.** Balayage de toutes les requêtes
   ``FROM metric_events`` du code : zéro ``WHERE user_id``. Le seul endroit qui
   mentionne la colonne (``routes/admin/metrics.py``) la lit en SORTIE, ce qui
   n'a pas besoin d'index.
2. **Aucun appelant ne renseigne la colonne.** ``log_metric`` accepte bien un
   ``user_id``, mais aucun de ses appels ne le passe.
3. **28 lignes sur 146 740 ont un ``user_id`` non nul** — les rares écrites
   avant que l'attribution ne déménage.

L'index a été posé par la migration 0011 en anticipation d'une attribution
par-utilisateur dans ``metric_events``. Cette attribution existe bel et bien
désormais — mais dans ``usage_events``, qui est précisément la table que 0011 a
créée pour ça, avec ses propres index (``idx_usage_user_ts``). Garder celui-ci
revient à payer une écriture de B-tree à chaque métrique pour une lecture qui
n'arrivera jamais.

``idx_metrics_type_date`` est CONSERVÉ : le plan d'exécution confirme qu'il sert
toutes les requêtes réelles, dont le KPI 24 h en index couvrant.

Réversible
==========
Un ``DROP INDEX`` ne touche aucune donnée. Pour revenir en arrière :

    CREATE INDEX idx_metrics_user_date ON metric_events(user_id, created_at DESC);
"""
from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    conn.execute("DROP INDEX IF EXISTS idx_metrics_user_date")
