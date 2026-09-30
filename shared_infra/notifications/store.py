# SPDX-License-Identifier: MIT
"""shared_infra.notifications.store — Centre de notifications par utilisateur.

Table : ``notifications``. Chaque ligne est une notification destinée à UN
utilisateur (``owner_user_id``), produite par une source backend (v1 : fin de
run de routine, succès ou échec). Le schéma reste générique (``kind`` + couple
``ref_type``/``ref_id``) pour accueillir d'autres sources plus tard (compression,
quota sandbox dépassé…).

Toutes les fonctions sont *tenant-gated* : filtrées par ``owner_user_id`` — un
user ne voit/altère jamais les notifications d'un autre.
"""
from __future__ import annotations

import time
from typing import Any, Dict, List

from shared_infra.db._connection import db_conn
from shared_infra.db._dialect import insert_id

# Rétention : on borne le nombre de notifications conservées par utilisateur pour
# éviter une croissance non bornée (le centre n'est pas une archive). La purge a
# lieu de façon opportuniste à chaque création.
_MAX_PER_USER = 200


def create_notification(
    owner_user_id: int,
    kind: str,
    title: str,
    body: str = "",
    ref_type: str = "",
    # int (chats, routines…) ou str (doc_id OCR) — SQLite est à typage
    # dynamique, la colonne accepte les deux tels quels.
    ref_id: int | str | None = None,
) -> int:
    """Insère une notification et purge le surplus au-delà de ``_MAX_PER_USER``.

    Retourne l'``id`` de la ligne créée.
    """
    with db_conn() as conn:
        cur = conn.cursor()
        nid = insert_id(
            cur,
            "INSERT INTO notifications(owner_user_id, kind, title, body, ref_type, ref_id, read_at, created_at) "
            "VALUES(?,?,?,?,?,?,NULL,?)",
            (owner_user_id, kind, (title or "")[:300], (body or "")[:4000],
             ref_type or "", ref_id, time.time()),
        )
        # Purge : ne garde que les _MAX_PER_USER plus récentes pour ce user.
        cur.execute(
            "DELETE FROM notifications WHERE owner_user_id=? AND id NOT IN ("
            "  SELECT id FROM (SELECT id FROM notifications WHERE owner_user_id=? "
            "  ORDER BY created_at DESC, id DESC LIMIT ?) AS garde)",
            (owner_user_id, owner_user_id, _MAX_PER_USER),
        )
        conn.commit()
        return nid


def list_notifications(owner_user_id: int, limit: int = 50,
                       before_id: int | None = None) -> List[Dict[str, Any]]:
    """Liste les notifications du user, plus récentes d'abord.

    ``before_id`` : curseur de pagination « charger plus » = l'``id`` de la
    dernière ligne reçue. (2026-09-20) Le tri est ``created_at DESC, id DESC``
    et les ids ne suivent PAS l'ordre de création (horloge, insertions
    différées, plusieurs workers) : paginer sur ``id<?`` seul sautait toute
    notification plus ancienne par la date mais d'id supérieur — invisible à
    jamais, alors que le badge la comptait. Le curseur est donc le couple
    ``(created_at, id)`` de la ligne référencée ; si elle a été purgée entre
    deux pages, repli sur ``id<?``. ``None`` = première page.
    """
    with db_conn() as conn:
        cur = conn.cursor()
        if before_id is not None:
            ref = cur.execute(
                "SELECT created_at FROM notifications WHERE owner_user_id=? AND id=?",
                (owner_user_id, int(before_id)),
            ).fetchone()
            if ref is not None:
                cur.execute(
                    "SELECT id, kind, title, body, ref_type, ref_id, read_at, created_at "
                    "FROM notifications WHERE owner_user_id=? "
                    "AND (created_at<? OR (created_at=? AND id<?)) "
                    "ORDER BY created_at DESC, id DESC LIMIT ?",
                    (owner_user_id, ref[0], ref[0], int(before_id), int(limit)),
                )
            else:
                cur.execute(
                    "SELECT id, kind, title, body, ref_type, ref_id, read_at, created_at "
                    "FROM notifications WHERE owner_user_id=? AND id<? "
                    "ORDER BY created_at DESC, id DESC LIMIT ?",
                    (owner_user_id, int(before_id), int(limit)),
                )
        else:
            cur.execute(
                "SELECT id, kind, title, body, ref_type, ref_id, read_at, created_at "
                "FROM notifications WHERE owner_user_id=? ORDER BY created_at DESC, id DESC LIMIT ?",
                (owner_user_id, int(limit)),
            )
        return [_as_sqlite_row(dict(r)) for r in cur.fetchall()]


def _as_sqlite_row(d: Dict[str, Any]) -> Dict[str, Any]:
    """``ref_id`` est déclaré INTEGER en SQLite mais reçoit aussi des
    identifiants texte (doc_id OCR) ; SQLite range « 42 » en entier 42 et garde
    le reste en texte. Hors SQLite la colonne est texte : on rend la même
    valeur qu'SQLite (entier quand elle est numérique) — le front compare
    l'identifiant d'une routine à un entier."""
    v = d.get("ref_id")
    if isinstance(v, str) and v.lstrip("-").isdigit():
        d["ref_id"] = int(v)
    return d


def prune_ref_notifications(owner_user_id: int, ref_type: str, ref_id: int | str,
                            keep: int) -> int:
    """Ne garde que les ``keep`` notifications les plus récentes d'UNE source
    (``ref_type``/``ref_id``) pour ce user — cap par routine (« garder X récaps
    de cette routine »), indépendant du cap global ``_MAX_PER_USER``.
    ``keep <= 0`` → no-op. Tenant-gated. Retourne le nb supprimé."""
    try:
        keep = int(keep)
    except (TypeError, ValueError):
        return 0
    if keep <= 0:
        return 0
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM notifications WHERE owner_user_id=? AND ref_type=? AND ref_id=? "
            "AND id NOT IN (SELECT id FROM (SELECT id FROM notifications WHERE owner_user_id=? "
            "AND ref_type=? AND ref_id=? ORDER BY created_at DESC, id DESC LIMIT ?) AS garde)",
            (owner_user_id, ref_type or "", ref_id, owner_user_id, ref_type or "",
             ref_id, keep),
        )
        n = cur.rowcount
        conn.commit()
        return int(n)


def count_unread(owner_user_id: int) -> int:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT COUNT(*) FROM notifications WHERE owner_user_id=? AND read_at IS NULL",
            (owner_user_id,),
        )
        return int(cur.fetchone()[0])


def mark_read(owner_user_id: int, notif_id: int) -> bool:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "UPDATE notifications SET read_at=? WHERE id=? AND owner_user_id=? AND read_at IS NULL",
            (time.time(), notif_id, owner_user_id),
        )
        changed = cur.rowcount > 0
        conn.commit()
        return changed


def mark_unread(owner_user_id: int, notif_id: int) -> bool:
    """Repasse une notification en non-lue (``read_at=NULL``). Tenant-gated.

    Permet à l'utilisateur de « garder pour traiter plus tard » une notif déjà
    soldée. No-op silencieux si l'id n'est pas le sien ou est déjà non-lue.
    """
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "UPDATE notifications SET read_at=NULL "
            "WHERE id=? AND owner_user_id=? AND read_at IS NOT NULL",
            (notif_id, owner_user_id),
        )
        changed = cur.rowcount > 0
        conn.commit()
        return changed


def mark_all_read(owner_user_id: int) -> int:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "UPDATE notifications SET read_at=? WHERE owner_user_id=? AND read_at IS NULL",
            (time.time(), owner_user_id),
        )
        n = cur.rowcount
        conn.commit()
        return int(n)


def delete_notification(owner_user_id: int, notif_id: int) -> bool:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM notifications WHERE id=? AND owner_user_id=?",
            (notif_id, owner_user_id),
        )
        changed = cur.rowcount > 0
        conn.commit()
        return changed


def clear_all(owner_user_id: int) -> int:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("DELETE FROM notifications WHERE owner_user_id=?", (owner_user_id,))
        n = cur.rowcount
        conn.commit()
        return int(n)
