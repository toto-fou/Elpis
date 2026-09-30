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
from typing import Optional

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
    call_id:     Optional[str] = None,
    started_at:  Optional[float] = None,
    category:    Optional[str] = None,
    exit_code:   Optional[int] = None,
    args_bytes:  Optional[int] = None,
    result_bytes: Optional[int] = None,
) -> None:
    """Enregistre une ligne dans ``tool_call_metrics``.

    Best-effort : un échec d'écriture ne doit JAMAIS interrompre l'appelant.
    Le truncate de ``error_short`` est borné à 500 chars. ``ts`` : fin de
    l'appel ; ``started_at`` : son début (horloge murale) ; ``exit_code`` :
    celui de la commande pour un outil shell.

    :param status: ``"success"``, ``"error"``, ``"blocked"`` (l'outil n'a pas
        tourné : arguments illisibles), ``"timeout"`` (sans réponse dans son
        délai).
    """
    try:
        with db_conn() as conn:
            cur = conn.cursor()
            cur.execute(
                "INSERT INTO tool_call_metrics("
                "run_id, user_id, pipeline_id, node_id, member_id, "
                "tool_name, server_name, status, duration_ms, error_short, ts, "
                "call_id, started_at, category, exit_code, args_bytes, result_bytes) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    run_id, int(user_id), pipeline_id,
                    str(node_id) if node_id is not None else None,
                    member_id, tool_name, server_name,
                    status, int(duration_ms or 0),
                    (error_short or "")[:500] if error_short else None,
                    time.time(),
                    str(call_id)[:128] if call_id else None,
                    float(started_at) if started_at is not None else None,
                    (category or None) and str(category)[:64],
                    int(exit_code) if exit_code is not None else None,
                    int(args_bytes) if args_bytes is not None else None,
                    int(result_bytes) if result_bytes is not None else None,
                ),
            )
            conn.commit()
    except Exception:
        import logging
        logging.getLogger("uvicorn.error").debug(
            "[tool_call_metrics] write failed (non-fatal)", exc_info=True,
        )
