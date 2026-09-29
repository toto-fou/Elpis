# SPDX-License-Identifier: MIT
"""
0013_encrypt_personal_mcp_auth — Chiffre les secrets MCP PERSO au repos.

Problème résolu : ``settings.mcp_servers`` stockait le jeton en CLAIR
(``authorization: "Bearer eyJ…"`` ou ``basic_auth: {username, token}``) dans
``users.settings_json``, et le renvoyait au navigateur à chaque
``GET /api/settings``. La bibliothèque partagée (``0010_mcp_shared_servers``)
chiffre déjà le sien en Fernet : cette migration aligne le magasin perso sur le
même contrat — ``auth_mode`` / ``auth_user`` / ``auth_enc`` / ``key_scheme``.

Un ``authorization`` de la forme « Bearer <jeton> » devient le mode ``bearer``
avec le jeton NU : c'est ce qui rend le nouveau mode utile dès le premier
démarrage, et ça supprime le piège de format (casse, espace, espace final) que
le mode brut faisait porter à l'utilisateur.

Le chiffrement peut être indisponible (pas de clé Fernet résoluble). On
journalise et on laisse CETTE entrée en clair plutôt que de lever : une
exception avorterait le runner et bloquerait toutes les migrations suivantes.
``personal_to_config`` reste tolérant au legacy, donc une entrée non convertie
continue de fonctionner.

Idempotent : une entrée portant déjà ``auth_enc`` est laissée telle quelle.
Ne commit PAS (le runner commit à la fin).
"""
from __future__ import annotations

import json
import logging
import sqlite3

logger = logging.getLogger("uvicorn.error")


def _convert(srv: dict) -> tuple[dict, bool]:
    """Retourne (entrée convertie, a_changé)."""
    if not isinstance(srv, dict):
        return srv, False
    if srv.get("auth_enc"):
        return srv, False                      # déjà migrée

    basic = srv.get("basic_auth")
    raw = srv.get("authorization")

    mode = user = secret = ""
    if isinstance(basic, dict):
        user = str(basic.get("username") or "")
        secret = str(basic.get("password") or basic.get("token") or "")
        mode = "basic" if (user and secret) else ""
    elif raw:
        s = str(raw).strip()
        if s[:7].lower() == "bearer ":
            mode, secret = "bearer", s[7:].strip()
        else:
            mode, secret = "raw", s

    if not mode or not secret:
        # Rien d'exploitable : on retire quand même les clés legacy vides.
        if basic is not None or raw is not None:
            srv.pop("basic_auth", None)
            srv.pop("authorization", None)
            return srv, True
        return srv, False

    from shared_infra.security.encryption import encrypt  # import tardif : clé lue ici
    enc = encrypt(secret)

    srv.pop("basic_auth", None)
    srv.pop("authorization", None)
    srv["auth_mode"] = mode
    srv["auth_user"] = user
    srv["auth_enc"] = enc
    srv["key_scheme"] = "fernet"
    return srv, True


def migrate(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    try:
        cur.execute("SELECT id, settings_json FROM users "
                    "WHERE settings_json IS NOT NULL AND settings_json != ''")
        rows = cur.fetchall()
    except sqlite3.OperationalError:
        return                                  # table users absente (base neuve)

    n_users = n_srv = 0
    for row in rows:
        uid = row[0]
        try:
            settings = json.loads(row[1])
        except Exception:
            continue
        if not isinstance(settings, dict):
            continue
        servers = settings.get("mcp_servers")
        if not isinstance(servers, list) or not servers:
            continue

        changed = 0
        try:
            for i, srv in enumerate(servers):
                servers[i], did = _convert(srv)
                changed += 1 if did else 0
        except Exception as e:
            # Typiquement EncryptionUnavailable. On laisse CE compte en clair.
            logger.warning(
                "[migration 0013] secrets MCP perso laissés en clair pour "
                "l'utilisateur %s : %s", uid, e)
            continue

        if changed:
            settings["mcp_servers"] = servers
            cur.execute("UPDATE users SET settings_json=? WHERE id=?",
                        (json.dumps(settings, ensure_ascii=False), uid))
            n_users += 1
            n_srv += changed

    if n_srv:
        logger.info("[migration 0013] %d serveur(s) MCP perso chiffré(s) "
                    "sur %d compte(s).", n_srv, n_users)
