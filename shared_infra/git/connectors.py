# SPDX-License-Identifier: MIT
"""
shared_infra.git.connectors — CRUD des Connecteurs Git par-utilisateur.

Store **host-only** des credentials git (remplace le fichier sandbox sale).
Keyé par ``(owner_user_id, host[, label])`` → self-hosted + multi-comptes.

INVARIANT DE SÉCURITÉ : le TOKEN n'est JAMAIS renvoyé par les fonctions de
listing/lecture exposées aux routes (``list_connectors`` / ``get_connector``).
Seuls ``find_for_host`` / ``find_for_provider`` — appelés par le résolveur
host-side (``shared_infra.git.resolver``) — renvoient le token déchiffré, et ne
sont jamais sérialisés vers HTTP.

Tokens en clair en v1 (``token_scheme='plain'``). ``_encode_token`` /
``_decode_token`` isolent ce choix pour qu'un futur 'fernet' soit un drop-in.
"""
from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

from shared_infra.db._connection import db_conn
from shared_infra.db._dialect import insert_id

# Types de provider supportés (l'UI propose ce menu ; ``generic`` = compare-URL).
PROVIDER_TYPES = (
    "github", "gitlab", "bitbucket-cloud", "bitbucket-server", "gitea", "generic",
)


# ── Token scheme (v1: plain ; réservé pour 'fernet') ──────────────────────────
def _encode_token(token: str) -> tuple[str, str]:
    """(token_enc, scheme) à stocker. v1 = clair."""
    return (token or ""), "plain"


def _decode_token(token_enc: str, scheme: str) -> str:
    # 'plain' → tel quel. Réservé : 'fernet' déchiffrerait ici.
    return token_enc or ""


_PUBLIC_COLS = ("id", "owner_user_id", "provider_type", "host", "api_base",
                "label", "username", "token_scheme", "created_at", "updated_at", "last_used")


def _public(row) -> Dict[str, Any]:
    """Vue SANS token (réponses HTTP)."""
    d = {k: row[k] for k in _PUBLIC_COLS}
    d["has_token"] = bool(row["token_enc"])
    return d


def _with_token(row) -> Dict[str, Any]:
    """Vue AVEC token déchiffré (résolveur host-side uniquement)."""
    d = {k: row[k] for k in _PUBLIC_COLS}
    d["token"] = _decode_token(row["token_enc"], row["token_scheme"])
    return d


# ── CRUD public (token-free) ──────────────────────────────────────────────────
def list_connectors(owner_user_id: int) -> List[Dict[str, Any]]:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT * FROM git_connectors WHERE owner_user_id=? ORDER BY host ASC, label ASC",
            (owner_user_id,))
        return [_public(r) for r in cur.fetchall()]


def get_connector(owner_user_id: int, connector_id: int) -> Optional[Dict[str, Any]]:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT * FROM git_connectors WHERE id=? AND owner_user_id=?",
                    (connector_id, owner_user_id))
        r = cur.fetchone()
        return _public(r) if r else None


def create_connector(owner_user_id: int, provider_type: str, host: str, *,
                     token: str, api_base: str = "", label: str = "",
                     username: str = "") -> int:
    tok_enc, scheme = _encode_token(token)
    now = time.time()
    with db_conn() as conn:
        cur = conn.cursor()
        new_id = insert_id(
            cur,
            "INSERT INTO git_connectors(owner_user_id, provider_type, host, api_base, "
            "label, username, token_enc, token_scheme, created_at, updated_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?)",
            (owner_user_id, provider_type, (host or "").lower(), api_base or "",
             label or "", username or "", tok_enc, scheme, now, now))
        conn.commit()
        return new_id


def update_connector(owner_user_id: int, connector_id: int, **fields) -> bool:
    """Met à jour les champs fournis (non-None). ``token`` vide/absent = inchangé."""
    sets: List[str] = []
    vals: List[Any] = []
    for k in ("provider_type", "host", "api_base", "label", "username"):
        if fields.get(k) is not None:
            v = fields[k]
            if k == "host":
                v = str(v).lower()
            sets.append(f"{k}=?")
            vals.append(v)
    tok = fields.get("token")
    if tok:                                    # non-vide → on remplace le token
        tok_enc, scheme = _encode_token(tok)
        sets += ["token_enc=?", "token_scheme=?"]
        vals += [tok_enc, scheme]
    if not sets:
        return False
    sets.append("updated_at=?")
    vals.append(time.time())
    vals += [connector_id, owner_user_id]
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute(f"UPDATE git_connectors SET {', '.join(sets)} "
                    f"WHERE id=? AND owner_user_id=?", vals)
        conn.commit()
        return cur.rowcount > 0


def delete_connector(owner_user_id: int, connector_id: int) -> bool:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM git_connectors WHERE id=? AND owner_user_id=?",
                    (connector_id, owner_user_id))
        conn.commit()
        return cur.rowcount > 0


# ── Résolution host-side (token INCLUS — jamais sérialisé HTTP) ───────────────
def find_for_host(owner_user_id: int, host: str) -> List[Dict[str, Any]]:
    """Connecteurs pour ``host``, token inclus, triés last_used desc puis
    created_at desc (départage multi-comptes : le plus récemment utilisé gagne)."""
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT * FROM git_connectors WHERE owner_user_id=? AND host=? "
            "ORDER BY COALESCE(last_used,0) DESC, created_at DESC",
            (owner_user_id, (host or "").lower()))
        return [_with_token(r) for r in cur.fetchall()]


def find_for_provider(owner_user_id: int, provider_type: str) -> List[Dict[str, Any]]:
    """Fallback par type de provider quand aucun connecteur ne matche le host."""
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT * FROM git_connectors WHERE owner_user_id=? AND provider_type=? "
            "ORDER BY COALESCE(last_used,0) DESC, created_at DESC",
            (owner_user_id, provider_type))
        return [_with_token(r) for r in cur.fetchall()]


def get_connector_secret(owner_user_id: int, connector_id: int) -> Optional[Dict[str, Any]]:
    """Connecteur AVEC token (host-side uniquement — ex. test de connexion).
    Ne JAMAIS sérialiser le résultat vers HTTP tel quel."""
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT * FROM git_connectors WHERE id=? AND owner_user_id=?",
                    (connector_id, owner_user_id))
        r = cur.fetchone()
        return _with_token(r) if r else None


def list_connector_hosts(owner_user_id: int) -> List[str]:
    """Hosts enregistrés par ce user — sert l'allowlist SSRF (self-hosted).
    (2026-09-11, P4) sur un hôte d'outils DISTANT (base locale vide), rappel
    vers l'app (``shared_infra.toolhost.client``)."""
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT DISTINCT host FROM git_connectors WHERE owner_user_id=?",
                    (owner_user_id,))
        hosts = [r["host"] for r in cur.fetchall() if r["host"]]
    if not hosts:
        try:
            from shared_infra.toolhost import client as _thc
            if _thc.enabled():
                hosts = list(_thc.connector_hosts(int(owner_user_id)))
        except Exception:                                       # noqa: BLE001
            pass
    return hosts


def bump_last_used(connector_id: int) -> None:
    """Best-effort (jamais bloquant)."""
    try:
        with db_conn() as conn:
            conn.execute("UPDATE git_connectors SET last_used=? WHERE id=?",
                         (time.time(), connector_id))
            conn.commit()
    except Exception:
        pass
