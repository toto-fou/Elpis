# SPDX-License-Identifier: MIT
"""
0022_tool_tokens — Jetons personnels gardés en EMPREINTE (2026-09-30, lot EXT.1).

Avant : ``code_remote_tokens`` gardait EN CLAIR un jeton ``pcr_`` par compte,
réaffiché à la demande (page Code, installeur, ``opencode.json``). Désormais
``tool_tokens`` garde plusieurs jetons nommés par compte, dont seule
l'empreinte SHA-256 est stockée : un jeton se montre une fois, à sa création,
puis se régénère (cf. ``shared_infra/accounts/tokens.py``).

Cette migration :

* pose ``tool_tokens`` (DDL du schéma de référence) ;
* convertit chaque jeton de ``code_remote_tokens`` en empreinte (type
  ``opencode``) : les postes déjà appairés continuent de fonctionner ;
* supprime ``code_remote_tokens`` ;
* vide ``code_pairings``, dont la colonne ``token`` portait un jeton en clair
  le temps d'un appairage (5 min au plus) : le jeton est désormais créé au
  moment où la CLI le récupère, jamais stocké.

Sur PostgreSQL et MariaDB, les migrations couvertes par le schéma de
référence sont tamponnées sans être rejouées : la même conversion y est faite
à l'exécution, en DML seul (``tokens.convert_legacy``).

Code autonome (une migration ne dépend pas du code applicatif qui évolue),
idempotent. Ne commit PAS (le runner commit à la fin).
"""
from __future__ import annotations

import hashlib
import time
from typing import Any


def migrate(conn: Any) -> None:
    from shared_infra.db._dialect import has_table
    from shared_infra.db._schema import ensure_tables
    ensure_tables(conn, ("tool_tokens",))
    if has_table(conn, "code_remote_tokens"):
        # Jointure sur ``users`` : un jeton orphelin (compte supprimé avant le
        # correctif du 2026-09-20) n'a plus de propriétaire à qui revenir.
        rows = conn.execute(
            "SELECT t.user_id, t.token, t.created_at FROM code_remote_tokens t "
            "JOIN users u ON u.id = t.user_id").fetchall()
        for uid, tok, created in rows:
            tok = str(tok or "")
            if not tok:
                continue
            digest = hashlib.sha256(tok.encode("utf-8")).hexdigest()
            if conn.execute("SELECT 1 FROM tool_tokens WHERE token_hash=?",
                            (digest,)).fetchone():
                continue
            conn.execute(
                "INSERT INTO tool_tokens(user_id, kind, name, token_hash, hint, "
                "families, created_at) VALUES(?,?,?,?,?,?,?)",
                (int(uid), "opencode", "opencode", digest, tok[-4:], "",
                 float(created or 0) or time.time()))
        conn.execute("DROP TABLE code_remote_tokens")
    if has_table(conn, "code_pairings"):
        conn.execute("DELETE FROM code_pairings")
