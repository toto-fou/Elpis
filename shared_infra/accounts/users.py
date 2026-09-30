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
import json
import secrets
import sqlite3
import time
from typing import Any, Dict, List, Optional

from shared_infra.db._connection import db, db_conn
from shared_infra.db._dialect import begin_write, group_concat, insert_id, savepoint


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


def get_user_by_id(uid: int) -> Optional[sqlite3.Row]:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT * FROM users WHERE id=?", (uid,))
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
    if not _USERNAME_CANON_RE.match(username):
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


def verify_user(username: str, password: str) -> Optional[int]:
    row = get_user(username)
    if not row: return None
    ph = _hash_password(password, row["pass_salt"])
    if secrets.compare_digest(ph, row["pass_hash"]):
        return int(row["id"])
    return None


def reset_user_password(target_user_id: int, new_password: str) -> bool:
    salt_hex = secrets.token_hex(16)
    ph = _hash_password(new_password, salt_hex)
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("UPDATE users SET pass_salt=?, pass_hash=? WHERE id=?", (salt_hex, ph, target_user_id))
        changed = cur.rowcount > 0
        conn.commit()
        return changed


def bump_session_min_ts(target_user_id: int, ts: Optional[float] = None) -> bool:
    """Force-logout d'un utilisateur : lève l'époque de révocation par-user
    (``users.session_min_ts``). Toute session dont ``_login_ts`` précède ``ts``
    est rejetée par le gate de session (``deps.require_user_id`` étape 3).

    Réutilisé après un changement/reset de mot de passe pour qu'une session
    volée ou encore active ne survive PAS au changement. Même mécanisme que
    l'action admin « révoquer les sessions d'un utilisateur »
    (``admin/security.py`` revoke-user).
    """
    if ts is None:
        ts = time.time()
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("UPDATE users SET session_min_ts=? WHERE id=?", (ts, target_user_id))
        changed = cur.rowcount > 0
        conn.commit()
        return changed


def revoke_session_sid(sid: str, user_id: Optional[int] = None,
                       ts: Optional[float] = None) -> bool:
    """Révoque UNE session par son identifiant ``_sid`` (posé au login).

    AUDIT 2026-08-01 (E4) — le logout ne révoquait rien côté serveur : la
    session est un cookie signé sans store, donc ``session.clear()`` n'agit que
    sur le navigateur qui obéit. Un cookie capturé restait valide jusqu'à
    ``max_age`` (24 h). ``bump_session_min_ts`` aurait fermé TOUTES les sessions
    de l'utilisateur — pas ce qu'on attend d'un logout — d'où cette révocation
    ciblée, qui laisse les autres appareils connectés.
    """
    if not sid or not isinstance(sid, str):
        return False
    if ts is None:
        ts = time.time()
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO revoked_sessions (sid, user_id, revoked_at) "
            "VALUES (?, ?, ?) ON CONFLICT(sid) DO NOTHING",
            (sid[:128], int(user_id) if user_id is not None else None, ts),
        )
        conn.commit()
        return True


def is_session_revoked(sid: str) -> bool:
    """Vrai si ce ``_sid`` a été révoqué (logout explicite).

    Lecture indexée sur la clé primaire — coût négligeable, comparable au
    SELECT ``session_min_ts`` déjà fait par le gate de session.
    """
    if not sid or not isinstance(sid, str):
        return False
    with db_conn() as conn:
        cur = conn.cursor()
        row = cur.execute(
            "SELECT 1 FROM revoked_sessions WHERE sid=?", (sid[:128],)
        ).fetchone()
        return row is not None


def purge_expired_revocations(max_age_sec: float) -> int:
    """Supprime les révocations devenues inutiles.

    Passé ``max_age_sec``, la session serait de toute façon rejetée par le gate
    ``_login_ts`` : garder la ligne ne sert plus à rien. Appelé par la
    maintenance périodique.
    """
    cutoff = time.time() - max(0.0, float(max_age_sec))
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM revoked_sessions WHERE revoked_at < ?", (cutoff,))
        n = cur.rowcount or 0
        conn.commit()
        return n


def clear_session_min_ts(target_user_id: int) -> bool:
    """Annule une révocation par-user précédente (``session_min_ts`` → 0) —
    laisse une ANCIENNE session reprendre (undo d'un force-logout par erreur).

    Comme ``bump_session_min_ts``, ``db_conn()`` NE commit PAS implicitement :
    sans le ``conn.commit()`` ci-dessous, l'UPDATE serait annulé à la fermeture
    de la connexion (transaction différée sqlite3) → reset silencieusement sans
    effet."""
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("UPDATE users SET session_min_ts=0 WHERE id=?", (target_user_id,))
        changed = cur.rowcount > 0
        conn.commit()
        return changed


def delete_user_full(target_user_id: int) -> bool:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM chats WHERE user_id=?", (target_user_id,))
        cur.execute("DELETE FROM saved_prompts WHERE user_id=?", (target_user_id,))
        cur.execute("DELETE FROM shared_prompts WHERE to_user_id=? OR from_user_id=?", (target_user_id, target_user_id))
        cur.execute("DELETE FROM user_groups WHERE user_id=?", (target_user_id,))
        # Accès aux serveurs d'inférence (lot B4) : la ligne ne doit pas
        # survivre au compte — un id SQLite peut être réattribué.
        from shared_infra.llm.engine_access import delete_principal_rows
        delete_principal_rows(conn, "user", target_user_id)
        # Jetons personnels (opencode, outils, vision — EXT.1) : même raison.
        # Point de sauvegarde : l'erreur « table absente » (base antérieure à
        # la migration 0022) est avalée au milieu d'une transaction
        # d'écriture (PostgreSQL l'avorterait sinon).
        try:
            with savepoint(conn, "tool_tokens"):
                from shared_infra.accounts.tokens import delete_for_user
                delete_for_user(target_user_id, conn=cur)
        except sqlite3.OperationalError:
            pass
        cur.execute("DELETE FROM users WHERE id=?", (target_user_id,))
        changed = cur.rowcount > 0
        conn.commit()
        return changed


def get_username_by_id(user_id: int) -> Optional[str]:
    row = get_user_by_id(user_id)
    return row["username"] if row else None


def update_user_avatar(user_id: int, filename: str) -> None:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("UPDATE users SET avatar=? WHERE id=?", (filename, user_id))
        conn.commit()


def get_user_settings(user_id: int) -> Dict[str, Any]:
    row = get_user_by_id(user_id)
    if not row or not row["settings_json"]: return {}
    try:
        parsed = json.loads(row["settings_json"])
        return parsed if isinstance(parsed, dict) else {}
    except (ValueError, TypeError):
        # AUDIT 2026-08-02 (E15) — ex-``except: return {}`` nu (attrapait
        # jusqu'à KeyboardInterrupt). Un settings_json corrompu (écriture
        # concurrente, disque plein) ramenait TOUS les réglages de
        # l'utilisateur aux défauts EN SILENCE — et le premier
        # PUT /api/settings suivant (fusion {**current, **data} avec
        # current={}) écrasait définitivement la ligne. On logge fort pour
        # que l'incident soit diagnostiquable au lieu d'être découvert par
        # « mes réglages ont disparu ».
        import logging
        logging.getLogger("uvicorn.error").error(
            "[users] settings_json corrompu pour uid=%s — retour aux "
            "défauts ; la prochaine sauvegarde écrasera la ligne", user_id)
        return {}


def update_user_settings(user_id: int, settings: Dict[str, Any]) -> None:
    with db_conn() as conn:
        cur = conn.cursor()
        js = json.dumps(settings, ensure_ascii=False)
        cur.execute("UPDATE users SET settings_json=? WHERE id=?", (js, user_id))
        conn.commit()


def merge_user_settings(user_id: int, mutate) -> Dict[str, Any]:
    """Lecture-modification-écriture ATOMIQUE de ``users.settings_json``.

    ``mutate(settings: dict) -> None`` modifie le dict EN PLACE ; le résultat est
    réécrit sous la MÊME transaction que la lecture. Retourne le dict écrit
    (``{}`` si l'utilisateur n'existe pas).

    AUDIT 2026-08-02 (E5) — le correctif E7 n'a rendu atomique que
    ``chats.meta_json``. ``users.settings_json`` gardait le RMW nu
    (``get_user_settings`` hors transaction puis ``update_user_settings``
    réécrivant le dict ENTIER) : deux écrivains concurrents — onglet A bascule le
    profil réseau pendant que l'onglet B enregistre un réglage, ou un ``PUT
    /api/settings`` user en même temps qu'un ``sandbox-quota`` admin — partaient
    du même état lu ; le second écrasait le premier, faisant retomber
    ``network_profile_id`` (ou le quota) sur une valeur périmée alors que l'UI
    affiche l'autre. ``BEGIN IMMEDIATE`` prend le verrou d'écriture DÈS la
    lecture. Même patron que ``db/chats.py:_merge_meta_json``.
    """
    conn = db()
    try:
        conn.isolation_level = None          # gestion manuelle des transactions
        cur = conn.cursor()
        begin_write(conn)
        try:
            cur.execute("SELECT settings_json FROM users WHERE id=?", (user_id,))
            row = cur.fetchone()
            if not row:
                cur.execute("COMMIT")
                return {}
            try:
                settings = json.loads(row["settings_json"] or "{}")
                if not isinstance(settings, dict):
                    settings = {}
            except (KeyError, TypeError, ValueError):
                settings = {}
            mutate(settings)
            cur.execute("UPDATE users SET settings_json=? WHERE id=?",
                        (json.dumps(settings, ensure_ascii=False), user_id))
            cur.execute("COMMIT")
            return settings
        except Exception:
            try:
                cur.execute("ROLLBACK")
            except Exception:
                pass
            raise
    finally:
        conn.close()


def get_users_lite(exclude_user_id: int, respect_groups: bool = True) -> List[Dict[str, Any]]:
    # BUG FIX (medium) : migration vers db_conn() — équivalent strict du
    # try/finally manuel mais imperméable à une exception levée AVANT
    # l'entrée du try (ex : DB_PATH inaccessible au moment du db()).
    with db_conn() as conn:
        cur = conn.cursor()

        # Helper: fetch all users with their groups concatenated
        def _all_users_with_groups(exclude_id):
            cur.execute(f"""
                SELECT u.id, u.username,
                       {group_concat("g.name", ", ")} as "groups"
                FROM users u
                LEFT JOIN user_groups ug ON u.id = ug.user_id
                LEFT JOIN "groups" g ON ug.group_id = g.id
                WHERE u.id != ?
                GROUP BY u.id
                ORDER BY u.username ASC
            """, (exclude_id,))
            return [{"id": r["id"], "username": r["username"], "groups": r["groups"] or ""} for r in cur.fetchall()]

        if not respect_groups:
            return _all_users_with_groups(exclude_user_id)

        cur.execute("SELECT group_id FROM user_groups WHERE user_id=?", (exclude_user_id,))
        my_groups = [r[0] for r in cur.fetchall()]

        if not my_groups:
            # User has no groups — show everyone with their group info
            return _all_users_with_groups(exclude_user_id)

        # User has groups — only show users in at least one common group
        placeholders = ",".join("?" * len(my_groups))
        cur.execute(f"""
            SELECT u.id, u.username,
                   {group_concat("g2.name", ",", distinct=True)} as "groups"
            FROM users u
            JOIN user_groups ug ON u.id = ug.user_id AND ug.group_id IN ({placeholders})
            LEFT JOIN user_groups ug2 ON u.id = ug2.user_id
            LEFT JOIN "groups" g2 ON ug2.group_id = g2.id
            WHERE u.id != ?
            GROUP BY u.id
            ORDER BY u.username ASC
        """, (*my_groups, exclude_user_id))
        rows = cur.fetchall()
        return [{"id": r["id"], "username": r["username"], "groups": r["groups"] or ""} for r in rows]
