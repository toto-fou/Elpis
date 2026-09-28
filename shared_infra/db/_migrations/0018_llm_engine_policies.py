# SPDX-License-Identifier: MIT
"""
0018_llm_engine_policies — Table ``llm_engine_policies`` (visibilité des
serveurs d'inférence et droit de gérer les modèles, par utilisateur ou groupe).

Problème résolu (2026-09-16) : tout compte voyait et utilisait le serveur
intégré ET tous les connecteurs partagés, et pouvait charger / décharger les
modèles du moteur intégré. L'admin choisit désormais, depuis l'onglet
Utilisateurs, les serveurs qu'un compte ou un groupe peut utiliser, et si ce
principal peut gérer les modèles.

Une ligne par principal :

- ``engine_keys`` : liste JSON de clés de moteur (``"builtin"``,
  ``"conn:<id>"``, ou ``"*"`` = tous) ; ``NULL`` = ce principal n'impose AUCUNE
  restriction de serveurs. Une liste vide ``[]`` = aucun serveur.
- ``can_manage_models`` : 1 / 0, ou ``NULL`` = non réglé (hérite).

L'absence de ligne équivaut à une ligne tout-``NULL``. La résolution
(utilisateur > union des groupes > tous) vit dans
``shared_infra/llm/engine_access.py``. Idempotent. Ne commit PAS (le runner de
migrations commit à la fin).
"""
from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS llm_engine_policies (
            principal_type     TEXT NOT NULL
                               CHECK (principal_type IN ('user', 'group')),
            principal_id       INTEGER NOT NULL,
            engine_keys        TEXT NULL,       -- JSON list ; NULL = pas de restriction
            can_manage_models  INTEGER NULL,    -- 1 / 0 ; NULL = non réglé
            updated_at         REAL NOT NULL,
            PRIMARY KEY (principal_type, principal_id)
        )
        """
    )
