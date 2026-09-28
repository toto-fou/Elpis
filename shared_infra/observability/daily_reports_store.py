# SPDX-License-Identifier: MIT
"""
shared_infra.observability.daily_reports_store — Stockage des rapports quotidiens d'usage IA.

Une ligne par jour (``date`` = clé primaire "YYYY-MM-DD"), avec le snapshot JSON
des métriques d'équipe calculé par ``shared_infra/observability/metrics/daily_report.py``. Sert
l'historique consultable côté admin (« Rapport du jour » + jours précédents) et
permet l'idempotence du digest (on ne génère/notifie qu'une fois par jour).

Purgé par la passe de maintenance (``DAILY_REPORT_RETENTION_DAYS``).
"""
from __future__ import annotations

import json
import logging
import time
from typing import Any, Dict, List, Optional

from shared_infra.db._connection import db_conn

logger = logging.getLogger("uvicorn.error")


def init_daily_reports_db() -> None:
    """Crée la table ``daily_usage_reports``. Idempotent — DDL du schéma de
    référence."""
    from shared_infra.db._schema import ensure_tables
    with db_conn() as conn:
        ensure_tables(conn, ("daily_usage_reports",))
        conn.commit()


def store_daily_report(date: str, payload: Dict[str, Any]) -> None:
    """Insère/remplace le rapport d'un jour (upsert sur la PK ``date``)."""
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO daily_usage_reports(date, payload_json, created_at) VALUES(?,?,?) "
            "ON CONFLICT(date) DO UPDATE SET payload_json=excluded.payload_json, "
            "created_at=excluded.created_at",
            (date, json.dumps(payload, ensure_ascii=False, default=str), time.time()),
        )
        conn.commit()


def report_exists(date: str) -> bool:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT 1 FROM daily_usage_reports WHERE date=? LIMIT 1", (date,))
        return cur.fetchone() is not None


def get_daily_report(date: str) -> Optional[Dict[str, Any]]:
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("SELECT payload_json FROM daily_usage_reports WHERE date=?", (date,))
        row = cur.fetchone()
    if not row:
        return None
    try:
        return json.loads(row[0])
    except Exception:
        return None


def list_daily_reports(limit: int = 60) -> List[Dict[str, Any]]:
    """Liste légère (date + created_at) des rapports récents, sans le payload."""
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            "SELECT date, created_at FROM daily_usage_reports ORDER BY date DESC LIMIT ?",
            (int(limit),))
        return [dict(r) for r in cur.fetchall()]


def purge_daily_reports(retention_days: int = 400) -> int:
    """Supprime les rapports de plus de ``retention_days``. ``<=0`` → no-op.

    Best-effort : ne lève jamais. Retourne le nb de lignes supprimées."""
    if retention_days <= 0:
        return 0
    try:
        with db_conn() as conn:
            cur = conn.cursor()
            cutoff = time.time() - retention_days * 86400
            cur.execute("DELETE FROM daily_usage_reports WHERE created_at < ?", (cutoff,))
            count = cur.rowcount
            conn.commit()
            if count:
                logger.info("[maintenance] %d daily_usage_reports purgé(s) (>%dj).",
                            count, retention_days)
            return count
    except Exception:
        logger.debug("[maintenance] purge_daily_reports failed (non-fatal)", exc_info=True)
        return 0
