# SPDX-License-Identifier: MIT
"""
backend.routes.admin — Admin-only endpoints, isolated for separate deployment.

History
-------
These endpoints used to live in ``backend.routes._legacy``. They were first
extracted into a single ``backend/routes/admin.py`` (1715 lines), then
split into this sub-package by domain so that:

* The MAIN application process (``app.py``, run as the unprivileged
  ``elpis`` user) can refuse to register them at all → smaller HTTP
  surface, no admin endpoints reachable from the chat-facing port.
* The ADMIN application process (``admin_app.py``, same unprivileged
  user — no admin operation needs root) registers ONLY this router plus
  authentication and the SSE log stream.

Layout
------
  ``_state.py`` : owns ``admin_router`` and ``internal_router``.
  ``logs.py``   : 1 endpoint  — /api/admin/logs/recent
  ``llm.py``    : 3 endpoints — capabilities probe + scheduling-mode
  ``config.py`` : 4 endpoints — config-file + compression-config
  ``metrics.py``: 5 endpoints — stats + prometheus + export-metrics
  ``users.py``  : 7 endpoints — CRUD + role + reset-password + sandbox-quota
  ``groups.py`` : 6 endpoints — CRUD + members + memberships
  ``security.py``: 4 endpoints — sessions revocation
  ``lifecycle.py``: 6 endpoints — restart, backup, restore, cache invalidation
  ``system.py`` : 1 endpoint  — /api/admin/terminal/stats
  ``integrations.py``: 1 endpoint — /api/admin/rag-service/test

Mounting
--------
``admin_router`` is its own ``APIRouter`` — it is NOT shared with the
rest of the package. The main app explicitly does *not* mount it unless
``APP_MODE == 'full'`` (legacy/dev convenience).

Public import contract (must stay stable)
-----------------------------------------
- ``app.py``: ``from backend.routes.admin import internal_router``
- ``backend.routes.__init__``: ``backend.routes.admin.admin_router``
"""
# Routers FIRST — domain modules import them at top level.
from shared_infra.routes.admin._state import admin_router, internal_router  # noqa: F401

# Domain modules — importing them registers their decorators on the routers.
from shared_infra.routes.admin import logs       # noqa: F401
from shared_infra.routes.admin import llm        # noqa: F401
from shared_infra.routes.admin import config     # noqa: F401
from shared_infra.routes.admin import metrics    # noqa: F401
from shared_infra.routes.admin import users      # noqa: F401
from shared_infra.routes.admin import groups     # noqa: F401
from shared_infra.routes.admin import security   # noqa: F401
from shared_infra.routes.admin import lifecycle  # noqa: F401
from shared_infra.routes.admin import system     # noqa: F401
from shared_infra.routes.admin import integrations  # noqa: F401
from shared_infra.routes.admin import image  # noqa: F401  — /api/admin/image/* (moteur d'images)
from shared_infra.routes.admin import llm_connectors  # noqa: F401  — /api/admin/llm/connectors/*
from shared_infra.routes.admin import system_prompts  # noqa: F401  — /api/admin/system-prompts/*
from shared_infra.routes.admin import executors  # noqa: F401  — /api/admin/executors/* + sandbox monitoring
from shared_infra.routes.admin import observability  # noqa: F401  — /api/admin/observability/* (Phase 1 task #5)
from shared_infra.routes.admin import runs  # noqa: F401  — /api/admin/runs* (L5.7)
from shared_infra.routes.admin import oauth  # noqa: F401  — /api/admin/oauth/* (EXT.4)
from shared_infra.routes.admin import llm_traffic  # noqa: F401  — /api/admin/llm-traffic/* (viewer debug échanges llama.cpp)
from shared_infra.routes.admin import toolhosts  # noqa: F401  — /api/admin/toolhosts/* (hôtes d'outils, placement, migration — P5)
from shared_infra.routes.admin import database  # noqa: F401  — /api/admin/database/* (moteur de base, bascule)
from shared_infra.routes.admin import overview  # noqa: F401  — /api/admin/overview (Vue d'ensemble) + /api/admin/restart-status
from shared_infra.routes.admin import skins  # noqa: F401  — /api/admin/skins/* (console › Apparence)
# Note : /api/sandbox/me/* n'est PAS un endpoint admin, il est dans
# backend/routes/user_sandbox.py et utilise le router user partagé.
