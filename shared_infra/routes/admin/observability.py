# SPDX-License-Identifier: MIT
"""
shared_infra/routes/admin/observability.py — endpoints REST pour le
dashboard d'observabilité (Phase 1 task #5).

Trois endpoints :

- ``GET /api/admin/observability/tool-failures`` — détail des derniers
  appels d'outils en échec (status != 'success'), avec filtres par
  fenêtre temporelle et statut.
- ``GET /api/admin/observability/tool-summary``  — agrégation
  ``get_tool_call_metrics_summary`` exposée tel quel pour les widgets
  bar volume / latency. (Utile en complément de ``/api/admin/stats/widgets``
  qui appelle les providers du registry — ici on a le détail brut.)
- ``GET /api/admin/observability/audit-recent`` — lecture du log d'audit
  via ``read_recent_audit_lines`` avec filtres (action prefix, user_id).

Conventions :
- Auth : ``is_admin`` check identique aux autres routes admin
  (cf. metrics.py:289). Le ``@require_perm("admin")`` viendra en Phase 3
  avec le RBAC complet.
- Réponses JSON, no-cache (data temps réel).
- Limites : ``limit`` cap à 500 lignes pour éviter d'inonder l'UI.

Ces endpoints alimentent l'onglet ``tab_observability`` (ajouté en
parallèle) qui complète le dashboard existant avec un focus *runtime
agentique* (vs le dashboard générique CPU/RAM/login).
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from shared_infra.accounts.users import get_user_by_id
from shared_infra.routes.admin._state import admin_router
from shared_infra.security.audit import read_recent_audit_lines
from shared_infra.security.deps import require_user_id

logger = logging.getLogger("uvicorn.error")


def _require_staff(request: Request) -> int:
    """Porte d'accès de la zone Métriques (LECTURE) : admin OU modérateur.

    Alignée sur ``metrics.py`` (``is_admin in (1, 2)``). Le test ``not
    me["is_admin"]`` utilisé auparavant était vrai par accident pour les mêmes
    rôles, mais divergeait dès l'ajout d'une valeur : deux portes différentes
    pour une même zone de la console est un piège, pas une nuance.
    """
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    if not me or me["is_admin"] not in (1, 2):
        raise HTTPException(403, "Staff required")
    return uid


def _require_admin(request: Request) -> int:
    """Admin seul (``is_admin == 1``) : actions qui modifient l'état.

    Audit 2026-09-22, H6 : l'ancienne ``_require_admin`` de ce module laissait
    passer le modérateur (elle est devenue ``_require_staff``, lecture seule).
    """
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    if not me or me["is_admin"] != 1:
        raise HTTPException(403, "Admin required")
    return uid


def _no_cache(payload: Any) -> JSONResponse:
    return JSONResponse(payload, headers={"Cache-Control": "no-cache"})


# ──────────────────────────────────────────────────────────────────────────
# 1. Tool failures — détail des dernières erreurs/blocked/timeout
# ──────────────────────────────────────────────────────────────────────────

@admin_router.get("/api/admin/observability/tool-failures")
def api_admin_obs_tool_failures(
    request: Request,
    hours: int = 24,
    limit: int = 50,
    status: Optional[str] = None,
):
    """Liste les derniers appels d'outils en échec, plus récents en premier.

    :param hours:  fenêtre temporelle (clamped 1..720).
    :param limit:  max lignes retournées (clamped 1..500).
    :param status: filtre ``status`` exact si fourni (``error``, ``blocked``,
                   ``timeout``). Par défaut : tous les non-success.

    Réponse ::

        {
          "items": [
            {
              "ts":         1714200000.123,
              "tool_name":  "shell.run",
              "status":     "error",
              "duration_ms": 1234,
              "error_short": "...",
              "node_id":     "n_call",
              "member_id":   null,
              "run_id":      "r_001"
            },
            ...
          ],
          "total": 50,
          "hours": 24
        }
    """
    _require_staff(request)

    # Clamps défensifs (évite qu'un client mal-écrit hammer la DB)
    hours = max(1, min(720, int(hours)))
    limit = max(1, min(500, int(limit)))
    valid_statuses = {"error", "blocked", "timeout"}
    if status and status not in valid_statuses:
        raise HTTPException(400, f"status must be one of {sorted(valid_statuses)}")

    import time as _time

    from shared_infra.observability.usage_store import db_conn

    since = _time.time() - hours * 3600
    where = ["ts > ?"]
    params: List[Any] = [since]
    if status:
        where.append("status = ?")
        params.append(status)
    else:
        where.append("status != 'success'")

    where_sql = " AND ".join(where)
    items: List[Dict[str, Any]] = []
    try:
        with db_conn() as conn:
            rows = conn.execute(
                f"SELECT ts, run_id, user_id, pipeline_id, node_id, member_id, "
                f"       tool_name, server_name, status, duration_ms, error_short "
                f"FROM tool_call_metrics WHERE {where_sql} "
                f"ORDER BY ts DESC LIMIT ?",
                params + [limit],
            ).fetchall()
            for r in rows:
                items.append({
                    "ts":          r[0],
                    "run_id":      r[1],
                    "user_id":     r[2],
                    "pipeline_id": r[3],
                    "node_id":     r[4],
                    "member_id":   r[5],
                    "tool_name":   r[6],
                    "server_name": r[7],
                    "status":      r[8],
                    "duration_ms": r[9],
                    "error_short": r[10],
                })
    except Exception as e:
        logger.warning("[obs/tool-failures] query failed: %s", e)

    return _no_cache({
        "items": items,
        "total": len(items),
        "hours": hours,
    })


# ──────────────────────────────────────────────────────────────────────────
# 2. Tool summary — agrégation totals + per_tool + recent_failures
# ──────────────────────────────────────────────────────────────────────────

@admin_router.get("/api/admin/observability/tool-summary")
def api_admin_obs_tool_summary(
    request: Request,
    hours: int = 24,
    limit: int = 100,
):
    """Wrapper sur ``get_tool_call_metrics_summary`` côté HTTP.

    Récupère ``totals`` (n, total_ms, n_error, n_blocked, n_timeout),
    ``per_tool`` (top N par appels), ``recent_failures`` (20 dernières
    erreurs).

    Sans ``user_id`` ni ``run_id`` (vue admin globale), on appelle
    avec ``user_id=None, run_id=None``. Mais la fonction underlying
    exige au moins un des deux — donc on lui passe ``since_ts`` et un
    user_id 0 spécial qui ne match rien... non, on adapte différemment :
    on appelle la query directe ici (équivalent global).
    """
    _require_staff(request)
    hours = max(1, min(720, int(hours)))
    limit = max(1, min(500, int(limit)))

    import time as _time

    from shared_infra.observability.usage_store import db_conn

    since = _time.time() - hours * 3600
    try:
        with db_conn() as conn:
            # totals
            totals_row = conn.execute(
                "SELECT COUNT(*) AS n, "
                "       COALESCE(SUM(duration_ms),0) AS total_ms, "
                "       SUM(CASE WHEN status='error'   THEN 1 ELSE 0 END) AS n_error, "
                "       SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END) AS n_blocked, "
                "       SUM(CASE WHEN status='timeout' THEN 1 ELSE 0 END) AS n_timeout "
                "FROM tool_call_metrics WHERE ts > ?",
                (since,),
            ).fetchone()
            totals = {
                "n":         int(totals_row[0] or 0),
                "total_ms":  int(totals_row[1] or 0),
                "n_error":   int(totals_row[2] or 0),
                "n_blocked": int(totals_row[3] or 0),
                "n_timeout": int(totals_row[4] or 0),
            }
            # per tool
            per_tool_rows = conn.execute(
                "SELECT tool_name, COUNT(*) AS n, "
                "       COALESCE(SUM(duration_ms),0) AS total_ms, "
                "       SUM(CASE WHEN status!='success' THEN 1 ELSE 0 END) AS n_failed "
                "FROM tool_call_metrics WHERE ts > ? "
                "GROUP BY tool_name ORDER BY n DESC LIMIT ?",
                (since, limit),
            ).fetchall()
            per_tool = [{
                "tool_name": r[0],
                "n":         int(r[1]),
                "total_ms":  int(r[2]),
                "n_failed":  int(r[3]),
                "avg_ms":    int(r[2] // r[1]) if r[1] else 0,
            } for r in per_tool_rows]
    except Exception as e:
        logger.warning("[obs/tool-summary] query failed: %s", e)
        totals, per_tool = {"n": 0}, []

    return _no_cache({
        "totals":   totals,
        "per_tool": per_tool,
        "hours":    hours,
    })


# ──────────────────────────────────────────────────────────────────────────
# 3. Audit recent — lecture filtrée du log d'audit
# ──────────────────────────────────────────────────────────────────────────

@admin_router.get("/api/admin/observability/audit-recent")
def api_admin_obs_audit_recent(
    request: Request,
    hours: int = 24,
    limit: int = 100,
    action_prefix: str = "",
    filter_user_id: Optional[int] = None,
):
    """Lit les lignes d'audit récentes (fichiers ``audit-YYYY-MM-DD.jsonl``).

    :param hours:         fenêtre temporelle (clamped 1..168).
    :param limit:         max lignes retournées (clamped 1..500).
    :param action_prefix: filtre ``action.startswith(prefix)``. Préfixes
                         réellement émis : ``"auth."`` (logins),
                         ``"code.exec."`` (exécutions de code),
                         ``"user.sandbox."`` (sandbox utilisateur),
                         ``"admin."`` (actions executors/sandbox admin).
    :param filter_user_id: filtre user_id exact (différent du caller).

    Réponse ::

        {
          "items": [{ts, iso, service, user_id, username, action, details}, ...],
          "total": N,
          "hours": 24
        }
    """
    _require_staff(request)
    hours = max(1, min(168, int(hours)))   # audit = forte volumétrie, cap court
    limit = max(1, min(500, int(limit)))

    import time as _time
    since = _time.time() - hours * 3600
    prefix = (action_prefix or "").strip() or None

    items = read_recent_audit_lines(
        limit=limit,
        since_ts=since,
        action_prefix=prefix,
        user_id=filter_user_id,
    )

    return _no_cache({
        "items": items,
        "total": len(items),
        "hours": hours,
    })
