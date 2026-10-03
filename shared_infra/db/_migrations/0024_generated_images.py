# SPDX-License-Identifier: MIT
"""
0024_generated_images — Images produites par le moteur d'images.

Une ligne par image : le message du chat ne porte qu'une référence (id), le
fichier vit sous ``user_db/generated_images/<user_id>/`` et la ligne garde son
chemin RELATIF à cette racine (``shared_infra/image/store.py``). Rétention
glissante par compte (``image.keep_per_user``).

Le DDL est celui du schéma de référence (``shared_infra/db/_schema.py``) : sur
une base neuve, ``create_all`` l'a déjà posé et la migration est tamponnée.
Idempotent. Ne commit PAS (le runner commit à la fin).
"""
from __future__ import annotations

from typing import Any


def migrate(conn: Any) -> None:
    from shared_infra.db._schema import ensure_tables
    ensure_tables(conn, ("generated_images",))
