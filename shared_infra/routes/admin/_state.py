# SPDX-License-Identifier: MIT
"""
backend.routes.admin._state — Singleton routers shared by every admin sub-module.

Kept in its own file so that domain modules can import the routers without
risking an import cycle with the package facade ``backend.routes.admin``.
"""
from fastapi import APIRouter

# ─── The dedicated admin router ─────────────────────────────────────
# Mounted ONLY by ``admin_app.py`` (and by ``app.py`` in legacy
# ``APP_MODE=full`` mode). The main app in ``APP_MODE=main`` does NOT
# mount it — admin endpoints are simply absent from its OpenAPI surface,
# so an attacker cannot probe them via the public port.
admin_router = APIRouter()

# ─────────────────────────────────────────────────────────────────────
#  internal_router — process-to-process control endpoints
# ─────────────────────────────────────────────────────────────────────
# Mounted on EVERY process (main, admin, full) regardless of APP_MODE,
# because they're called by sibling processes over the loopback
# interface. Auth is by source-IP : every endpoint here MUST refuse
# non-127.0.0.1 / non-::1 callers as its first action — there is no
# user session check, no API key, no nothing else.
internal_router = APIRouter()
