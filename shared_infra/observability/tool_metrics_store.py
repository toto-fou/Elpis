# SPDX-License-Identifier: MIT
"""
shared_infra.observability.tool_metrics_store — Métriques d'appels d'outils (observabilité).

Table
=====

  - ``tool_call_metrics`` : une ligne par appel d'outil (nom, statut, durée,
    erreur courte). Alimente les dashboards d'observabilité admin
    (``shared_infra/routes/admin/observability.py`` + ``metrics/_v17_providers``).

Note historique : ce module hébergeait aussi le blackboard persistant, les
``run_metrics`` par appel LLM, les ``webhook_deliveries`` et la mémoire
long-terme — tout cela appartenait au moteur agentique maison, retiré au profit
de Flowise. La mémoire long-terme du chatbot vit désormais dans
``llm_core.memory`` + ``shared_infra.memory.store`` (Markdown + FTS5).
"""
from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

from shared_infra.db._connection import db_conn

# ──────────────────────────────────────────────────────────────────────────────
# Init de la table — appelé depuis init_db() au démarrage de l'app.
# Idempotent ; le DDL vient du schéma de référence (shared_infra/db/_schema.py).
# ──────────────────────────────────────────────────────────────────────────────

def init_tool_metrics_db() -> None:
    """Crée la table ``tool_call_metrics`` (une ligne par appel d'outil) et
    ses index. Idempotent — le DDL vient du schéma de référence
    (``shared_infra/db/_schema.py``)."""
    from shared_infra.db._schema import ensure_tables
    with db_conn() as conn:
        ensure_tables(conn, ("tool_call_metrics",))
        conn.commit()


def purge_tool_call_metrics(retention_days: int = 90) -> int:
    """Supprime les ``tool_call_metrics`` de plus de ``retention_days`` jours.

    Cette table grossit d'une ligne par appel d'outil et n'avait AUCUNE purge :
    sur un serveur qui tourne des mois sans redémarrage, elle croît sans borne.
    Appelée par la passe de maintenance quotidienne (``shared_infra.ops.maintenance``).
    ``retention_days <= 0`` → no-op (purge désactivée). Retourne le nb de lignes
    supprimées. Best-effort : ne lève jamais (la maintenance ne doit pas crasher).
    """
    if retention_days <= 0:
        return 0
    try:
        with db_conn() as conn:
            cur = conn.cursor()
            cutoff = time.time() - retention_days * 86400
            cur.execute("DELETE FROM tool_call_metrics WHERE ts < ?", (cutoff,))
            count = cur.rowcount
            conn.commit()
            if count:
                import logging
                logging.getLogger("uvicorn.error").info(
                    "[maintenance] %d tool_call_metrics purgé(s) (>%dj).", count, retention_days)
            return count
    except Exception:
        import logging
        logging.getLogger("uvicorn.error").debug(
            "[maintenance] purge_tool_call_metrics failed (non-fatal)", exc_info=True)
        return 0


def record_tool_call_metric(
    run_id:      str,
    user_id:     int,
    tool_name:   str,
    *,
    pipeline_id: Optional[int] = None,
    node_id:     Optional[str] = None,
    member_id:   Optional[str] = None,
    server_name: Optional[str] = None,
    status:      str = "success",
    duration_ms: int = 0,
    error_short: Optional[str] = None,
) -> None:
    """Enregistre une ligne dans ``tool_call_metrics``.

    Best-effort : un échec d'écriture ne doit JAMAIS interrompre l'appelant.
    Le truncate de ``error_short`` est borné à 500 chars.

    :param status: ``"success"``, ``"error"``, ``"blocked"``, ``"timeout"``.
    """
    try:
        with db_conn() as conn:
            cur = conn.cursor()
            cur.execute(
                "INSERT INTO tool_call_metrics("
                "run_id, user_id, pipeline_id, node_id, member_id, "
                "tool_name, server_name, status, duration_ms, error_short, ts) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (
                    run_id, int(user_id), pipeline_id,
                    str(node_id) if node_id is not None else None,
                    member_id, tool_name, server_name,
                    status, int(duration_ms or 0),
                    (error_short or "")[:500] if error_short else None,
                    time.time(),
                ),
            )
            conn.commit()
    except Exception:
        import logging
        logging.getLogger("uvicorn.error").debug(
            "[tool_call_metrics] write failed (non-fatal)", exc_info=True,
        )


def get_tool_call_metrics_summary(
    run_id: Optional[str] = None,
    *,
    user_id: Optional[int] = None,
    since_ts: Optional[float] = None,
    limit: int = 100,
) -> Dict[str, Any]:
    """Agrégation des tool calls : totaux + breakdown par outil + erreurs récentes.

    Au moins un de ``run_id`` ou ``user_id`` doit être passé (sinon ça scanne
    toute la table — pas voulu).
    """
    if not run_id and not user_id:
        raise ValueError("get_tool_call_metrics_summary requires run_id or user_id")
    where = []
    params: List[Any] = []
    if run_id:
        where.append("run_id=?")
        params.append(run_id)
    if user_id:
        where.append("user_id=?")
        params.append(int(user_id))
    if since_ts:
        where.append("ts >= ?")
        params.append(float(since_ts))
    where_sql = " AND ".join(where)

    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute(
            f"SELECT COUNT(*) AS n, "
            f"       COALESCE(SUM(duration_ms),0) AS total_ms, "
            f"       SUM(CASE WHEN status='error'   THEN 1 ELSE 0 END) AS n_error, "
            f"       SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END) AS n_blocked, "
            f"       SUM(CASE WHEN status='timeout' THEN 1 ELSE 0 END) AS n_timeout "
            f"FROM tool_call_metrics WHERE {where_sql}",
            params,
        )
        totals = dict(cur.fetchone() or {})

        cur.execute(
            f"SELECT tool_name, "
            f"       COUNT(*) AS n, "
            f"       COALESCE(SUM(duration_ms),0) AS total_ms, "
            f"       SUM(CASE WHEN status!='success' THEN 1 ELSE 0 END) AS n_failed "
            f"FROM tool_call_metrics WHERE {where_sql} "
            f"GROUP BY tool_name ORDER BY n DESC LIMIT ?",
            params + [int(limit)],
        )
        per_tool = [dict(r) for r in cur.fetchall()]

        cur.execute(
            f"SELECT ts, tool_name, status, error_short, node_id, member_id "
            f"FROM tool_call_metrics WHERE {where_sql} AND status!='success' "
            f"ORDER BY ts DESC LIMIT 20",
            params,
        )
        recent_failures = [dict(r) for r in cur.fetchall()]

        return {
            "totals": totals,
            "per_tool": per_tool,
            "recent_failures": recent_failures,
        }
