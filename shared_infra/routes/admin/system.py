# SPDX-License-Identifier: MIT
"""
Admin system endpoints — terminal/PTY stats.

Auto-extracted from the former monolithic ``backend/routes/admin.py``.
The endpoint bodies are byte-for-byte identical to the originals.
"""
from __future__ import annotations

import logging
import os
import time

from fastapi import Request


# Helpers shared with _legacy. Single source of truth.
from shared_infra.routes._legacy import (
    _require_admin, _terminals, _term_global_lock,
    _PTY_IDLE_TIMEOUT_SEC, MAX_SESSIONS_PER_USER,
)

# Routers — owned by ``_state``. We import them so endpoint decorators
# below register on the SAME singleton router instances mounted by
# ``app.py`` / ``admin_app.py``.
from shared_infra.routes.admin._state import admin_router

logger = logging.getLogger("uvicorn.error")


@admin_router.get("/api/admin/terminal/stats")
def api_terminal_stats(request: Request):
    """Worker-local PTY stats. Admin-only.

    Returns what THIS worker is hosting — each worker has its own
    view. The ``worker_pid`` field lets you stitch results together
    if you call this endpoint several times and hit different
    workers.
    """
    _require_admin(request)
    with _term_global_lock:
        snapshot = [
            {
                "uid": st.get("uid"),
                "sid": st.get("sid"),
                "tid": st.get("tid"),
                "pid": st.get("pid"),
                "alive": bool(st.get("alive")),
                "last_io_age_sec": max(0, int(time.time() - st.get("last_io", 0))),
            }
            for st in _terminals.values()
        ]
    return {
        "worker_pid": os.getpid(),
        "count": len(snapshot),
        "idle_timeout_sec": _PTY_IDLE_TIMEOUT_SEC,
        "max_sessions_per_user": MAX_SESSIONS_PER_USER,
        "sessions": snapshot,
    }



# ═════════════════════════════════════════════════════════════════════════════
#  SECURITY / SESSIONS
# ═════════════════════════════════════════════════════════════════════════════
# Admin endpoints surfaced by the "Cookies & sessions" section of the
# Configuration tab. They cover SESSION REVOCATION:
#
#      • POST /api/admin/security/sessions/revoke-all
#        Bumps security.session.global_min_ts to now in config.json. The
#        next request from any session whose _login_ts is older is
#        invalidated by _session_uid_any. Equivalent to "force-logout
#        every connected user", but without rotating SESSION_SECRET (no
#        gunicorn restart needed).
#      • POST /api/admin/security/sessions/revoke-user/{user_id}
#        Same idea but per-user: writes time.time() into
#        users.session_min_ts. Cheap (one UPDATE).
#      • GET /api/admin/security/sessions
#        Stats overview: totals, last-revocation timestamps.
#
# (no explicit endpoint) The cookie attributes (cookie_name,
#      same_site, https_only, max_age_sec, idle_timeout_sec)
#      live in the main config.json under security.session.
#      They are saved via the existing POST /api/admin/config-file
#      pipeline — no special endpoint needed.
#
# Login rate-limiting was removed in v3.4 (local-team deployments don't
# need brute-force protection at the application layer). See auth.py
# module docstring for the rationale.
# ═════════════════════════════════════════════════════════════════════════════
