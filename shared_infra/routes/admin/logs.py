# SPDX-License-Identifier: MIT
"""
Admin logs endpoint — recent log entries with filters.

Auto-extracted from the former monolithic ``backend/routes/admin.py``.
The endpoint bodies are byte-for-byte identical to the originals.
"""
from __future__ import annotations

import logging

from fastapi import HTTPException, Request
from fastapi.responses import (
    JSONResponse,
)

from shared_infra.accounts.users import (
    get_user_by_id,
)
from shared_infra.security.deps import require_user_id

# Helpers shared with _legacy. Single source of truth.
from shared_infra.routes._legacy import (
    system_events,
)

# Routers — owned by ``_state``. We import them so endpoint decorators
# below register on the SAME singleton router instances mounted by
# ``app.py`` / ``admin_app.py``.
from shared_infra.routes.admin._state import admin_router

logger = logging.getLogger("uvicorn.error")


@admin_router.get("/api/admin/logs/recent")
def api_admin_logs_recent(request: Request):
    """Return recent log entries with optional filters.

    Query parameters
    ----------------
    ``limit``       : int, default 500, capped at 5000
    ``services``    : CSV (e.g. ``main,admin``)
    ``levels``      : CSV (e.g. ``ERROR,WARNING``)
    ``categories``  : CSV (e.g. ``admin,auth,http``)
    ``since_ts``    : float UNIX timestamp — only events after this point

    Sources
    -------
    Primary source is the unified JSONL file written by
    ``backend.access_logging`` — it captures BOTH ``main`` and ``admin``
    process activity (HTTP requests, application events, errors). The
    in-memory ring buffer maintained by ``system_events`` is used as a
    BACKWARD-COMPATIBLE fallback (when the file is empty / not yet rotated)
    so the admin Logs tab is never blank on a fresh deploy.

    Returned shape (backward-compatible with the original endpoint)::

        {
          "logs": [ {"id": <ts>, "message": "...", "level": "..."} ],
          "events": [ <full-record-with-service/category/extras> ],
          "filters_applied": {...},
          "available_services":  ["main", "admin"],
          "available_levels":    ["DEBUG","INFO","WARNING","ERROR","CRITICAL"],
          "available_categories":["http","auth","admin","security","system","app"],
        }
    """
    # require_user_id : applique la porte de validité de session (révocation,
    # max-age, idle, must_change_pwd) avant le check staff — sinon un cookie
    # staff révoqué garderait l'accès aux access-logs (uid/IP).
    uid = require_user_id(request)
    me = get_user_by_id(int(uid))
    if not me or me["is_admin"] not in (1, 2):
        raise HTTPException(403, "Staff required")

    # ── Read & validate query params ────────────────────────────────
    qp = request.query_params
    try:
        limit = max(1, min(int(qp.get("limit", "500")), 5000))
    except ValueError:
        limit = 500

    def _csv(name: str):
        v = qp.get(name)
        if not v:
            return None
        return [x.strip() for x in v.split(",") if x.strip()]

    services = _csv("services")
    levels = _csv("levels")
    categories = _csv("categories")
    try:
        since_ts = float(qp["since_ts"]) if "since_ts" in qp else None
    except ValueError:
        since_ts = None

    # ── Primary source: unified JSONL file ──────────────────────────
    events = []
    try:
        from shared_infra.observability.access_logging import read_recent_events
        events = read_recent_events(
            limit=limit,
            services=services,
            levels=levels,
            categories=categories,
            since_ts=since_ts,
        )
    except Exception as exc:
        logger.warning(f"[admin/logs] read_recent_events failed: {exc}")

    # ── Backward-compatible ``logs`` field (in-memory ring buffer) ──
    # The original endpoint returned only this. Keep it populated so older
    # frontends that read response.logs continue to work without changes.
    legacy_logs = []
    try:
        legacy_logs = system_events.get_recent_logs()
    except Exception:
        pass

    return JSONResponse(
        {
            "logs":   legacy_logs,    # legacy shape, do not remove
            "events": events,         # new structured shape
            "filters_applied": {
                "limit":      limit,
                "services":   services,
                "levels":     levels,
                "categories": categories,
                "since_ts":   since_ts,
            },
            "available_services":   ["main", "admin"],
            "available_levels":     ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"],
            "available_categories": ["http", "auth", "admin", "security", "system", "app"],
        },
        headers={"Cache-Control": "no-cache"},
    )
