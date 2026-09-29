# SPDX-License-Identifier: MIT
"""
backend.routes._legacy — Compatibility shim.

Why this file still exists
--------------------------
Historically all 135+ HTTP routes, all SSE/cron infrastructure, and a long
list of helpers lived in a single 6000-line module called
``backend.routes._legacy``. They have all been extracted into focused
sibling modules (``auth.py``, ``chats.py``, ``pipelines.py``, ``_helpers.py``,
``_events_bus.py``, ``_pty.py``, etc.).

External callers (``app.py``, ``admin_app.py``, ``backend/routes/admin.py``)
historically imported names directly from this module. Rather than rewrite
every import site, this file simply re-exports everything those callers
need so the historical import surface keeps working unchanged.

How callers should target new code
----------------------------------
- For NEW code, import the destination module directly:

      from shared_infra.routes._helpers import _no_cache
      from shared_infra.observability.events_bus import system_events
      from shared_infra.terminal.pty import _terminals, _kill_terminal

- For OLD code that still does ``from backend.routes._legacy import …``,
  the names below keep it working. No urgency to rewrite — these
  re-exports are essentially zero-cost.

What's still genuinely defined here
-----------------------------------
- ``router``: re-bound from ``backend.routes._state.router`` so historical
  ``@router.get(...)`` decorators in the (now non-existent) routes
  resolved consistently. Kept because admin.py and the package façade
  still walk this module's symbols.
- ``logger``: the uvicorn.error logger. A few places use
  ``backend.routes._legacy.logger`` directly.
- ``_cron_started``: legacy boolean kept for backward compat. The live
  one used by /api/system-events lives in ``backend.routes.events``.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter  # noqa: F401 — re-exported for backward compat

logger = logging.getLogger("uvicorn.error")


# ─────────────────────────────────────────────────────────────────────────────
#  ROUTER  (re-bound from _state)
# ─────────────────────────────────────────────────────────────────────────────
# Historically this module created its own ``APIRouter()`` and every
# ``@router.get(...)`` in the now-extracted routes hung off it. After the
# extraction the canonical router lives in ``backend.routes._state``;
# we re-export it here under the same name so any straggler import
# (``from backend.routes._legacy import router``) still resolves.
# PROJECT_ROOT was once defined here; keep it re-exported for compat.
from shared_infra.config import PROJECT_ROOT  # noqa: F401, E402

# ─────────────────────────────────────────────────────────────────────────────
#  EVENTS / SCHEDULER / MODEL CACHE  — re-exported from _events_bus.py
# ─────────────────────────────────────────────────────────────────────────────
from shared_infra.observability.events_bus import (  # noqa: F401, E402
    CURRENT_LOADED_MODELS,
    PipelineEvents,
    SSELogHandler,
    SystemEvents,
    _cron_matches,
    _ensure_model_poller,
    _local_cleanup_loop,
    _model_cache,
    _model_cache_hash,
    _model_cache_lock,
    _model_poll_loop,
    _refresh_model_cache,
    _register_bg_task,
    pipeline_events,
    shutdown_bg_tasks,
    sse_handler,
    start_cron_scheduler,
    system_events,
)

# ─────────────────────────────────────────────────────────────────────────────
#  HELPERS  — re-exported from _helpers.py
# ─────────────────────────────────────────────────────────────────────────────
from shared_infra.routes._helpers import (  # noqa: F401, E402
    AVATAR_DIR,
    DEFAULT_CONFIG_PATH,
    RAG_CONFIG_PATH,
    ROLE_LABELS,
    USER_CONFIG_DIR,
    _get_sandbox_path,
    _get_session_cfg,
    _get_work_path,
    _make_backup_zip,
    _msg_text,
    _ndjson_line,
    _no_cache,
    _read_json_file,
    _require_admin,
    _require_staff,
    _sandbox_size_bytes,
    _session_uid_any,
    _shutdown_stream_worker,
    _user_cfg_path,
    _write_json_atomic,
    bump_sandbox_usage,
    invalidate_sandbox_usage,
    # Compteur d'usage disque mis en cache + single-flight (audit perf
    # 2026-08-08) — à préférer à ``_sandbox_size_bytes`` partout où la valeur
    # est LUE (jauges, listes) plutôt que recalculée pour elle-même.
    sandbox_usage_bytes,
    validate_password,
)
from shared_infra.routes._state import router  # noqa: F401, E402

# ─────────────────────────────────────────────────────────────────────────────
#  TERMINAL / PTY  — re-exported from _pty.py
# ─────────────────────────────────────────────────────────────────────────────
from shared_infra.terminal.pty import (  # noqa: F401, E402
    _PTY_IDLE_TIMEOUT_SEC,
    _SESSION_DB_RETENTION_SEC,
    _SID_RE,
    _WS_INPUT_RATE_CAPACITY,
    _WS_INPUT_RATE_REFILL,
    _WS_MAX_CTRL_BYTES,
    DEFAULT_SID,
    MAX_SESSIONS_PER_USER,
    _cleanup_idle_terminals,
    _count_user_sessions,
    _delete_session_row,
    _fcntl,
    _get_or_create_terminal,
    _get_session_row,
    _init_terminal_sessions_table,
    _insert_session_row,
    _kill_local_session,
    _kill_terminal,
    _list_session_rows,
    _new_sid,
    _purge_abandoned_session_rows,
    _rename_session_row,
    _spawn_terminal,
    _struct,
    _term_global_lock,
    _terminal_ws_loop,
    _terminals,
    _termios,
    _touch_session_row,
    _valid_sid,
    _ws_auth_uid,
    shutdown_all_terminals,
)

# ─────────────────────────────────────────────────────────────────────────────
#  Module-local state still owned here
# ─────────────────────────────────────────────────────────────────────────────
# Legacy boolean. The live one used by ``/api/system-events`` to gate the
# cron-scheduler bootstrap moved to ``backend.routes.events`` along with
# the SSE endpoint. Kept here at False for any caller that still reads the
# attribute (none should, but it's literally one byte of compat).
_cron_started = False
