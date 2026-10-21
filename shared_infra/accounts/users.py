# SPDX-License-Identifier: MIT
"""
backend.db.users — Users, authentication, settings, avatars.

Tables: ``users`` (primary), plus cascading deletes into ``chats``,
``saved_prompts``, ``shared_prompts``, ``user_groups`` when a user is deleted.

Password hashing: PBKDF2-HMAC-SHA256 with 150,000 iterations and per-user
16-byte salt. Verification uses :func:`secrets.compare_digest` to resist
timing attacks.
"""
from __future__ import annotations

import hashlib
import secrets
import sqlite3
import time
from typing import Any, Dict, List, Optional

from shared_infra.db._connection import db_conn
from shared_infra.db._dialect import insert_id


def _hash_password(password: str, salt_hex: str) -> str:
    salt = bytes.fromhex(salt_hex)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 150_000)
    return dk.hex()


def get_user(username: str) -> Optional[sqlite3.Row]:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT * FROM users WHERE username=?", (username,))
        row = cur.fetchone()
        return row


def get_all_users() -> List[Dict[str, Any]]:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT id, username, is_admin, created_at, avatar FROM users ORDER BY username ASC")
        rows = cur.fetchall()
        return [dict(r) for r in rows]


import re as _re

# Charset canonique d'un username : EXACTEMENT celui que ``safe_sandbox_name``
# / ``safe_username`` conservent (``[^A-Za-z0-9_-]`` supprimé, sémantique
# delete). Imposer ce charset à la CRÉATION rend le mapping username → dossier
# sandbox/mémoire **injectif** : sinon « jean dupont » (espace) et « jeandupont »,
# ou « José » et « Jos », partagent le même ``{sandbox}/jeandupont`` → mémoire
# lue/écrite/effacée en croisé entre deux comptes distincts (audit F16).
_USERNAME_CANON_RE = _re.compile(r"^[A-Za-z0-9_-]+$")


def _canon_username(username: str) -> str:
    return _re.sub(r"[^A-Za-z0-9_-]", "", username or "")


def validate_username(username: str) -> None:
    """Lève ``ValueError`` si ``username`` briserait l'injectivité du mapping
    vers le dossier sandbox/mémoire. Appelé par ``create_user`` (choke point
    unique de toute création). Les comptes existants non canoniques sont
    tolérés (déjà sur disque) mais ne peuvent PLUS être re-créés ni collisionnés."""
    if not username or not username.strip():
        raise ValueError("username vide")
    if not _USERNAME_CANON_RE.fullmatch(username):
        raise ValueError(
            "username invalide : seuls les caractères A-Z a-z 0-9 _ - sont "
            "autorisés (pas d'espace ni d'accent — ils créeraient une collision "
            "de dossier avec un autre compte)."
        )
    # Anti-collision avec un compte PRÉ-EXISTANT non canonique : « jean dupont »
    # (déjà en base) canonise en « jeandupont » → refuser la création d'un
    # « jeandupont » qui partagerait son dossier.
    for u in get_all_users():
        _other = u.get("username") or ""
        if _other != username and _canon_username(_other) == username:
            raise ValueError(
                f"username en collision de dossier avec le compte existant "
                f"« {_other} » (même forme canonique)."
            )


def create_user(username: str, password: str, is_admin: int = 0, must_change_pwd: int = 0) -> int:
    validate_username(username)
    salt_hex = secrets.token_hex(16)
    ph = _hash_password(password, salt_hex)
    # BUG FIX (medium) : migration vers db_conn() — le pattern manuel
    # ``conn = db(); try: ... finally: conn.close()`` fuyait la connexion
    # si une exception survenait entre ``db()`` et l'entrée du try. Le
    # context manager est strictement équivalent et imperméable à ce cas.
    with db_conn() as conn:
        cur = conn.cursor()
        uid = insert_id(
            cur,
            "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin, settings_json, must_change_pwd) VALUES(?,?,?,?,?,?,?)",
            (username, salt_hex, ph, time.time(), is_admin, "{}", must_change_pwd),
        )
        conn.commit()
    return uid


def reset_user_password(target_user_id: int, new_password: str) -> bool:
    salt_hex = secrets.token_hex(16)
    ph = _hash_password(new_password, salt_hex)
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("UPDATE users SET pass_salt=?, pass_hash=? WHERE id=?", (salt_hex, ph, target_user_id))
        changed = cur.rowcount > 0
        conn.commit()
        return changed


