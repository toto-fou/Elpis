# SPDX-License-Identifier: MIT
"""
backend.db.groups — User groups CRUD and membership.

Tables touched: ``groups``, ``user_groups``, ``users`` (read-only for listings).

Functions (11):

- :func:`create_group`, :func:`list_groups`, :func:`get_group`,
  :func:`update_group`, :func:`delete_group`
- :func:`get_group_members` — roster of a group
- :func:`get_user_groups` — groups a user belongs to
- :func:`set_user_groups` — replace a user's group assignments in bulk
- :func:`add_user_to_group`, :func:`remove_user_from_group`
- :func:`get_all_users_with_groups` — admin dashboard view (joined)
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any, Dict, List, Optional

from shared_infra.db._connection import db_conn
from shared_infra.db._dialect import group_concat, insert_id

logger = logging.getLogger("uvicorn.error")


def create_group(name: str, description: str = "") -> int:
    with db_conn() as conn:
        cur = conn.cursor()
        gid = insert_id(cur, 'INSERT INTO "groups"(name, description, created_at) VALUES(?,?,?)',
                        (name, description, time.time()))
        conn.commit()
        return gid


def list_groups() -> List[Dict[str, Any]]:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT g.id, g.name, g.description, g.created_at,
                   COUNT(ug.user_id) as member_count
            FROM "groups" g
            LEFT JOIN user_groups ug ON g.id = ug.group_id
            GROUP BY g.id
            ORDER BY g.name ASC
        """)
        rows = cur.fetchall()
        return [dict(r) for r in rows]


def get_group(group_id: int) -> Optional[Dict[str, Any]]:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute('SELECT * FROM "groups" WHERE id=?', (group_id,))
        row = cur.fetchone()
        return dict(row) if row else None


def update_group(group_id: int, name: str, description: str) -> bool:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute('UPDATE "groups" SET name=?, description=? WHERE id=?', (name, description, group_id))
        changed = cur.rowcount > 0
        conn.commit()
        return changed


def delete_group(group_id: int) -> bool:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM user_groups WHERE group_id=?", (group_id,))
        # Accès aux serveurs d'inférence (lot B4) : la politique part avec le
        # groupe (un id réattribué hériterait sinon de ses restrictions).
        from shared_infra.llm.engine_access import delete_principal_rows
        delete_principal_rows(conn, "group", group_id)
        cur.execute('DELETE FROM "groups" WHERE id=?', (group_id,))
        changed = cur.rowcount > 0
        conn.commit()
        return changed


def get_group_members(group_id: int) -> List[Dict[str, Any]]:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT u.id, u.username, u.avatar
            FROM users u
            JOIN user_groups ug ON u.id = ug.user_id
            WHERE ug.group_id=?
            ORDER BY u.username ASC
        """, (group_id,))
        rows = cur.fetchall()
        return [dict(r) for r in rows]


def get_user_groups(user_id: int) -> List[Dict[str, Any]]:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT g.id, g.name, g.description
            FROM "groups" g
            JOIN user_groups ug ON g.id = ug.group_id
            WHERE ug.user_id=?
            ORDER BY g.name ASC
        """, (user_id,))
        rows = cur.fetchall()
        return [dict(r) for r in rows]


def set_user_groups(user_id: int, group_ids: List[int]) -> None:
    """Remplace l'appartenance aux groupes d'un compte (tout ou rien).

    AUDIT 2026-09-16 — chaque INSERT était enveloppé d'un ``except: pass`` :
    un id de groupe inexistant (groupe supprimé entre-temps, saisie erronée)
    était SILENCIEUSEMENT ignoré, l'appel rendait « ok » et l'administrateur
    croyait l'accès accordé. Les ids sont désormais vérifiés AVANT l'écriture
    et un id inconnu lève ``ValueError`` (400 côté route) — sans toucher à
    l'appartenance existante.
    """
    ids: List[int] = []
    for g in group_ids or []:
        try:
            ids.append(int(g))
        except (TypeError, ValueError):
            raise ValueError(f"Identifiant de groupe invalide : {g!r}")
    with db_conn() as conn:
        cur = conn.cursor()
        if ids:
            marks = ",".join("?" * len(ids))
            connus = {int(r[0]) for r in
                      cur.execute(f'SELECT id FROM "groups" WHERE id IN ({marks})', ids).fetchall()}
            inconnus = [g for g in ids if g not in connus]
            if inconnus:
                raise ValueError("Groupe introuvable : "
                                 + ", ".join(str(g) for g in inconnus))
        cur.execute("DELETE FROM user_groups WHERE user_id=?", (user_id,))
        for gid in dict.fromkeys(ids):
            cur.execute("INSERT INTO user_groups(user_id, group_id) VALUES(?,?)",
                        (user_id, gid))
        conn.commit()
    # L'appartenance change l'accès HÉRITÉ aux serveurs d'inférence : cache de
    # ce process vidé, empreinte partagée touchée pour les autres workers.
    try:
        from shared_infra.llm import engine_access as _ea
        _ea.invalidate_cache(int(user_id))
    except Exception:                                            # noqa: BLE001
        logger.debug("[groups] invalidation du cache d'accès échouée", exc_info=True)


def add_user_to_group(user_id: int, group_id: int) -> None:
    # db_conn() (context manager) garantit la fermeture même si cursor()/execute
    # lève AVANT le try — l'ancien pattern db()+try/finally fuyait dans ce cas.
    with db_conn() as conn:
        conn.execute("INSERT INTO user_groups(user_id, group_id) VALUES(?,?) "
                     "ON CONFLICT(user_id, group_id) DO NOTHING", (user_id, group_id))
        conn.commit()


def remove_user_from_group(user_id: int, group_id: int) -> None:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM user_groups WHERE user_id=? AND group_id=?", (user_id, group_id))
        conn.commit()


def get_all_users_with_groups() -> List[Dict[str, Any]]:
    with db_conn() as conn:
        cur = conn.cursor()
        # AUDIT 2026-09-01 (passe 6, B5) — ``settings_json`` ramené par la MÊME
        # requête : la route admin refaisait ensuite un ``get_user_settings``
        # (= ``SELECT * FROM users``) PAR compte (1+N). Le JSON est parsé ici
        # en clé privée ``_settings`` et le brut n'est PAS exposé (la route
        # sérialise ces dicts tels quels vers le navigateur).
        cur.execute(f"""
            SELECT u.id, u.username, u.is_admin, u.created_at, u.avatar,
                   u.settings_json,
                   {group_concat("g.name", ", ")} as group_names,
                   {group_concat("g.id", ",")} as group_ids
            FROM users u
            LEFT JOIN user_groups ug ON u.id = ug.user_id
            LEFT JOIN "groups" g ON ug.group_id = g.id
            GROUP BY u.id
            ORDER BY u.username ASC
        """)
        rows = cur.fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["group_names"] = d["group_names"] or ""
            d["group_ids"] = [int(x) for x in d["group_ids"].split(",") if x] if d["group_ids"] else []
            raw = d.pop("settings_json", None)
            try:
                parsed = json.loads(raw) if raw else {}
                d["_settings"] = parsed if isinstance(parsed, dict) else {}
            except (ValueError, TypeError):
                d["_settings"] = {}
            result.append(d)
        return result
