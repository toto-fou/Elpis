# SPDX-License-Identifier: MIT
"""
backend.ax_memory.credentials — Per-site credential storage.

Stores (username, password) tuples per (owner, normalized site) so the agent
can auto-fill login forms without re-asking. One active credential per couple;
saving a new one replaces the existing row (atomic UPSERT).

AUDIT 2026-08-23 — ``owner`` est OBLIGATOIRE en lecture comme en ecriture.
La cle etait le site SEUL : le mot de passe enregistre par un compte etait
reinjecte, en silence, dans la session Playwright de n'importe quel autre.
Un ``owner`` vide ne lit ni n'ecrit rien (fail-closed) plutot que de retomber
sur la ligne d'autrui.

Table: ``ax_credentials``.

Public API:
    save_credentials, get_credentials, list_credentials, delete_credentials
"""
from __future__ import annotations

import time
from typing import Optional

# Re-use private helpers still living in _legacy: the DB lock, connection
# factory, normalize_url (which needs the site alias table still in _legacy)
# and the module-level logger. This keeps the refactor mechanical.
from shared_infra.memory.ax._legacy import (
    _DB_LOCK,
    _conn,
    normalize_url,
    log,
)


def save_credentials(url: str, username: str, password: str,
                     *, owner: str) -> bool:
    """
    Enregistre un couple (username, password) pour (owner, site normalise).
    Ecrase le couple existant de CE proprietaire (un seul par couple).
    Retourne True si ecrit, False sinon (``owner`` vide = refus).
    """
    if not url or not username or not password or not owner:
        return False
    site, _ = normalize_url(url)
    if not site:
        return False
    try:
        with _DB_LOCK, _conn() as c:
            c.execute("""
                INSERT INTO ax_credentials
                    (owner, site, username, password, last_ok, use_count)
                VALUES (?, ?, ?, ?, ?, 1)
                ON CONFLICT(owner, site) DO UPDATE SET
                    username  = excluded.username,
                    password  = excluded.password,
                    last_ok   = excluded.last_ok,
                    use_count = ax_credentials.use_count + 1
            """, (owner, site, username, password, time.time()))
        log.info("[ax] creds saved for owner=%s site=%s user=%s",
                 owner, site, username)
        return True
    except Exception as e:
        log.warning("[ax] save_credentials failed: %s", e)
        return False


def get_credentials(url: str, *, owner: str) -> Optional[dict]:
    """
    Recupere les credentials de CE proprietaire pour le site normalise.
    Retourne {'username': ..., 'password': ..., 'use_count': N} ou None.
    Un ``owner`` vide rend None : on ne sert jamais la ligne d'un autre compte.
    """
    if not url or not owner:
        return None
    site, _ = normalize_url(url)
    if not site:
        return None
    try:
        with _conn() as c:
            row = c.execute("""
                SELECT username, password, use_count, last_ok
                  FROM ax_credentials
                 WHERE site = ? AND owner = ?
            """, (site, owner)).fetchone()
        if not row:
            return None
        return {
            "username":  row["username"],
            "password":  row["password"],
            "use_count": row["use_count"],
            "last_ok":   row["last_ok"],
        }
    except Exception as e:
        log.warning("[ax] get_credentials failed: %s", e)
        return None


def list_credentials(*, owner: Optional[str] = None) -> list[dict]:
    """
    Liste les credentials (pour admin/debug). ``owner=None`` = tous les
    comptes — reserve a l'administration, jamais au chemin outil.
    """
    try:
        with _conn() as c:
            if owner is None:
                rows = c.execute("""
                    SELECT owner, site, username, password, use_count, last_ok
                      FROM ax_credentials
                     ORDER BY last_ok DESC
                """).fetchall()
            else:
                rows = c.execute("""
                    SELECT owner, site, username, password, use_count, last_ok
                      FROM ax_credentials
                     WHERE owner = ?
                     ORDER BY last_ok DESC
                """, (owner,)).fetchall()
        return [dict(r) for r in rows]
    except Exception:
        return []


def delete_credentials(url_or_site: str, *, owner: Optional[str] = None) -> bool:
    """Supprime les credentials d'un site. Accepte une URL ou un site normalise.

    ``owner=None`` supprime pour TOUS les comptes (route d'administration) ;
    un ``owner`` explicite ne touche que ses propres lignes.
    """
    if not url_or_site:
        return False
    # Essaie les deux : si ca ressemble a une URL on normalise, sinon site direct
    if url_or_site.startswith("http"):
        site, _ = normalize_url(url_or_site)
    else:
        site = url_or_site
    if not site:
        return False
    try:
        with _DB_LOCK, _conn() as c:
            if owner is None:
                cur = c.execute(
                    "DELETE FROM ax_credentials WHERE site = ?", (site,))
            else:
                cur = c.execute(
                    "DELETE FROM ax_credentials WHERE site = ? AND owner = ?",
                    (site, owner))
            return cur.rowcount > 0
    except Exception:
        return False
