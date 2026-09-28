# SPDX-License-Identifier: MIT
"""shared_infra/desktop/anchors.py — mémoire INTER-SESSION des ancres résolues.

Quand une requête textuelle (« Enregistrer ») est résolue vers un élément
portant un ``auto_id`` STABLE (UIA AutomationId / AT-SPI accessible-id), on
épingle le couple (scope, requête) → auto_id. La résolution suivante — live ou
autre worker — repique directement le même contrôle au lieu de re-deviner :
anti-flapping, et le modèle ne « redécouvre » pas l'UI à chaque fois.
``scope`` = ``username::target`` (calqué sur ``_desktop_session._obs_key``).

(2026-09-12) Extrait de ``scheduling/scenarios_store.py`` quand les scénarios
rejouables ont été retirés : ce cache n'a jamais été à eux — c'est
``llm_core._desktop_session`` (ciblage live) qui le lit et l'écrit.
Best-effort de bout en bout : aucune erreur DB ne remonte, le cache est un
bonus, jamais un point de panne du chemin de résolution.
"""
from __future__ import annotations

import os
import time
from typing import Any, Dict, Optional

from shared_infra.db._connection import db_conn
from shared_infra.db._dialect import no_limit

# TTL GÉNÉREUX (30 j) : une ancre auto_id est censée rester stable entre
# sessions, c'est tout l'intérêt du cache ; le TTL ne sert qu'à évincer les
# entrées VRAIMENT anciennes (app désinstallée, refonte d'UI). La cohérence fine
# est déjà assurée à la lecture par resolve_element (le label doit encore
# contenir la requête). Réglable par ``APP_ACTION_CACHE_TTL_S``.
ACTION_CACHE_TTL_S = float(os.environ.get("APP_ACTION_CACHE_TTL_S", "") or (30 * 86400))


def init_action_cache_db() -> None:
    """Crée la table (idempotent). DDL du schéma de référence."""
    from shared_infra.db._schema import ensure_tables
    with db_conn() as conn:
        ensure_tables(conn, ("editor_action_cache",))
        conn.commit()


def record_action_anchor(scope: str, query_norm: str, auto_id: str,
                         role: str = "", center: Optional[Any] = None) -> None:
    """Épingle (UPSERT) l'ancre stable ``auto_id`` apprise pour (scope, requête).
    No-op si ``auto_id`` est vide (rien de stable à mémoriser)."""
    aid = str(auto_id or "").strip()
    if not aid or not str(query_norm or "").strip():
        return
    cx = cy = None
    if isinstance(center, (list, tuple)) and len(center) >= 2:
        try:
            cx, cy = int(center[0]), int(center[1])
        except (TypeError, ValueError):
            cx = cy = None
    try:
        with db_conn() as conn:
            cur = conn.cursor()
            cur.execute(
                "INSERT INTO editor_action_cache(scope, query_norm, auto_id, role, "
                "center_x, center_y, hits, updated_at) VALUES(?,?,?,?,?,?,1,?) "
                "ON CONFLICT(scope, query_norm) DO UPDATE SET "
                "auto_id=excluded.auto_id, role=excluded.role, "
                "center_x=excluded.center_x, center_y=excluded.center_y, "
                "hits=editor_action_cache.hits+1, updated_at=excluded.updated_at",
                (str(scope), str(query_norm).strip().lower(), aid, str(role or ""),
                 cx, cy, time.time()))
            conn.commit()
    except Exception:
        pass


def lookup_action_anchor(scope: str, query_norm: str) -> Optional[Dict[str, Any]]:
    """Renvoie l'ancre épinglée ``{auto_id, role, center}`` pour (scope, requête)
    ou None. Une entrée plus vieille que ``ACTION_CACHE_TTL_S`` est ignorée
    (stale-on-read). Best-effort (table absente / DB occupée → None)."""
    if not str(query_norm or "").strip():
        return None
    try:
        with db_conn() as conn:
            cur = conn.cursor()
            cur.execute(
                "SELECT auto_id, role, center_x, center_y, updated_at FROM editor_action_cache "
                "WHERE scope=? AND query_norm=?",
                (str(scope), str(query_norm).strip().lower()))
            row = cur.fetchone()
    except Exception:
        return None
    if not row or not (row["auto_id"] or ""):
        return None
    try:                                       # stale-on-read : ignore les ancres trop vieilles
        if ACTION_CACHE_TTL_S > 0 and (time.time() - float(row["updated_at"] or 0)) > ACTION_CACHE_TTL_S:
            return None
    except (TypeError, ValueError):
        pass
    ctr = None
    if row["center_x"] is not None and row["center_y"] is not None:
        ctr = [int(row["center_x"]), int(row["center_y"])]
    return {"auto_id": str(row["auto_id"]), "role": str(row["role"] or ""), "center": ctr}


def prune_action_cache(max_rows: int = 10000, keep: int = 8000) -> int:
    """Borne le cache par ÂGE (TTL) PUIS par TAILLE (si > ``max_rows``, garde
    les ``keep`` plus récentes). Renvoie le nombre de lignes purgées."""
    purged = 0
    try:
        with db_conn() as conn:
            cur = conn.cursor()
            if ACTION_CACHE_TTL_S > 0:
                cur.execute("DELETE FROM editor_action_cache WHERE updated_at < ?",
                            (time.time() - ACTION_CACHE_TTL_S,))
                purged += cur.rowcount
            cur.execute("SELECT COUNT(*) AS n FROM editor_action_cache")
            n = int((cur.fetchone() or {"n": 0})["n"] or 0)
            if n > int(max_rows):
                # Clé primaire (scope, query_norm) plutôt que ``rowid`` (propre
                # à SQLite), table dérivée pour MySQL/MariaDB.
                cur.execute(
                    "DELETE FROM editor_action_cache WHERE (scope, query_norm) IN ("
                    "SELECT scope, query_norm FROM (SELECT scope, query_norm "
                    "FROM editor_action_cache ORDER BY updated_at DESC "
                    f"LIMIT {no_limit()} OFFSET ?) AS perimees)", (int(keep),))
                purged += cur.rowcount
            conn.commit()
            return purged
    except Exception:
        return 0
