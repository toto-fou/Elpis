# SPDX-License-Identifier: MIT
"""shared_infra.chat.prompt_templates_store — Templates de prompt (2026-09-21).

Table ``prompt_templates`` (migration 0020). Un template appartient à UN compte ;
toutes les requêtes filtrent par ``user_id``. Conception :
docs/templates-prompt-design-2026-09-21.md.
"""
from __future__ import annotations

import re
import sqlite3
import time
from typing import Any, Dict, List, Optional

from shared_infra.db._connection import db_conn
from shared_infra.db._dialect import insert_id

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")
TITLE_MAX = 120
CONTENT_MAX = 20_000
PER_USER_MAX = 200


class TemplateError(ValueError):
    """Entrée refusée ; ``status`` = code HTTP à renvoyer."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def normalize(data: Any) -> Dict[str, str]:
    """Champs d'un template reçus du client → valeurs validées. Lève
    ``TemplateError`` (400) sur une entrée invalide."""
    d = data if isinstance(data, dict) else {}
    name = str(d.get("name") or "").strip().lower()
    if name.startswith("/"):
        name = name[1:]
    if not NAME_RE.match(name):
        raise TemplateError("Raccourci invalide : lettres minuscules, chiffres, - et _ "
                            "(40 caractères au plus), sans espace.")
    content = str(d.get("content") or "")
    if not content.strip():
        raise TemplateError("Contenu requis.")
    if len(content) > CONTENT_MAX:
        raise TemplateError(f"Contenu trop long ({CONTENT_MAX} caractères au plus).")
    title = " ".join(str(d.get("title") or "").split())[:TITLE_MAX] or name
    return {"name": name, "title": title, "content": content}


def list_templates(user_id: int) -> List[Dict[str, Any]]:
    with db_conn() as conn:
        rows = conn.execute(
            "SELECT id, name, title, content, created_at, updated_at "
            "FROM prompt_templates WHERE user_id=? ORDER BY name", (user_id,)).fetchall()
        return [dict(r) for r in rows]


def create_template(user_id: int, data: Any) -> Dict[str, Any]:
    t = normalize(data)
    now = time.time()
    with db_conn() as conn:
        n = conn.execute("SELECT COUNT(*) FROM prompt_templates WHERE user_id=?",
                         (user_id,)).fetchone()[0]
        if n >= PER_USER_MAX:
            raise TemplateError(f"Limite de {PER_USER_MAX} templates atteinte.", 409)
        try:
            new_id = insert_id(
                conn.cursor(),
                "INSERT INTO prompt_templates(user_id, name, title, content, created_at, updated_at) "
                "VALUES(?,?,?,?,?,?)", (user_id, t["name"], t["title"], t["content"], now, now))
        except sqlite3.IntegrityError:
            raise TemplateError(f"Un template s'appelle déjà « {t['name']} ».", 409)
        conn.commit()
        return {"id": new_id, **t, "created_at": now, "updated_at": now}


def update_template(user_id: int, template_id: int, data: Any) -> Optional[Dict[str, Any]]:
    """``None`` si le template n'existe pas pour ce compte."""
    t = normalize(data)
    now = time.time()
    with db_conn() as conn:
        try:
            cur = conn.execute(
                "UPDATE prompt_templates SET name=?, title=?, content=?, updated_at=? "
                "WHERE id=? AND user_id=?",
                (t["name"], t["title"], t["content"], now, template_id, user_id))
        except sqlite3.IntegrityError:
            raise TemplateError(f"Un template s'appelle déjà « {t['name']} ».", 409)
        conn.commit()
        if cur.rowcount == 0:
            return None
        row = conn.execute("SELECT id, name, title, content, created_at, updated_at "
                           "FROM prompt_templates WHERE id=? AND user_id=?",
                           (template_id, user_id)).fetchone()
        return dict(row) if row else None


def delete_template(user_id: int, template_id: int) -> bool:
    with db_conn() as conn:
        cur = conn.execute("DELETE FROM prompt_templates WHERE id=? AND user_id=?",
                           (template_id, user_id))
        conn.commit()
        return cur.rowcount > 0
