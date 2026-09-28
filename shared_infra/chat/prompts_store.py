# SPDX-License-Identifier: MIT
"""backend.db.prompts — Saved prompts and sharing.

Tables: ``saved_prompts``, ``shared_prompts``.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional
import time

from shared_infra.db._connection import db_conn
from shared_infra.db._dialect import insert_id


def save_prompt(user_id: int, title: str, content: str) -> int:
    with db_conn() as conn:
        cur = conn.cursor()
        pid = insert_id(cur, "INSERT INTO saved_prompts(user_id, title, content, created_at) VALUES(?,?,?,?)",
                        (user_id, title, content, time.time()))
        conn.commit()
        return pid


def list_saved_prompts(user_id: int) -> List[Dict[str, Any]]:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT * FROM saved_prompts WHERE user_id=? ORDER BY created_at DESC", (user_id,))
        rows = cur.fetchall()
        return [dict(r) for r in rows]


def delete_prompt(user_id: int, prompt_id: int) -> bool:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM saved_prompts WHERE id=? AND user_id=?", (prompt_id, user_id))
        changed = cur.rowcount > 0
        conn.commit()
        return changed


def get_prompt_by_id(user_id: int, prompt_id: int) -> Optional[Dict[str, Any]]:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT * FROM saved_prompts WHERE id=? AND user_id=?", (prompt_id, user_id))
        row = cur.fetchone()
        return dict(row) if row else None


def share_prompt_to_users(from_user_id: int, to_user_ids: List[int], title: str, content: str) -> None:
    with db_conn() as conn:
        cur = conn.cursor()
        now = time.time()
        for to_uid in to_user_ids:
            cur.execute("INSERT INTO shared_prompts(from_user_id, to_user_id, title, content, created_at) VALUES(?,?,?,?,?)", (from_user_id, to_uid, title, content, now))
        conn.commit()


def list_shared_prompts(user_id: int) -> List[Dict[str, Any]]:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("""
            SELECT sp.id, sp.title, sp.content, sp.created_at, u.username as from_username
            FROM shared_prompts sp
            JOIN users u ON sp.from_user_id = u.id
            WHERE sp.to_user_id = ?
            ORDER BY sp.created_at DESC
        """, (user_id,))
        rows = cur.fetchall()
        return [dict(r) for r in rows]


def delete_shared_prompt(user_id: int, prompt_id: int) -> bool:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM shared_prompts WHERE id=? AND to_user_id=?", (prompt_id, user_id))
        changed = cur.rowcount > 0
        conn.commit()
        return changed


def clear_all_shared_prompts(user_id: int) -> bool:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM shared_prompts WHERE to_user_id=?", (user_id,))
        changed = cur.rowcount > 0
        conn.commit()
        return changed
