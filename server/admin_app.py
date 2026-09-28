# SPDX-License-Identifier: MIT
"""
admin_app.py — entry point for the SEPARATED admin process.

Why a separate process?
=======================

Two related goals:

1. **Reduced HTTP attack surface** on the user-facing port. The main
   ``app.py`` runs as the unprivileged ``elpis`` user and serves chat,
   sandbox, terminal, and editor traffic. Without this split, the same
   process also exposed every ``/api/admin/*`` endpoint — meaning any
   bug in the chat-side codepath could be combined with an admin
   credential leak to escalate to user/password resets, server restarts,
   ``config.json`` writes, etc. Now those endpoints simply do not exist
   on the user-facing port.

2. **Same unprivileged user**. No admin operation needs root: a restart
   is a SIGHUP to our own gunicorn master, the Docker actions only need
   the docker group. Do not start this process as ``root`` — a flaw in an
   admin endpoint would then compromise the whole host.

How it works
============

This file is intentionally tiny. All the heavy lifting lives in
``app.py:create_app``, which dispatches on the ``APP_MODE`` env var. We
just lock that var to ``"admin"`` here and run the same factory.

In ``APP_MODE=admin`` create_app:

* mounts ``backend.routes.admin_router`` (the 31 ``/api/admin/*`` routes
  physically extracted from ``backend.routes._legacy``),
* mounts a small allow-list of non-admin endpoints the admin UI needs
  (``/api/me-lite``, ``/api/system-events``, ``/api/public-config``,
  ``/api/users/change-password``, …),
* serves ``static/admin.html`` at ``/`` and ``/admin``.

Everything else (chat, editor, sandbox, pipelines, terminal, agentic
graph) is **physically not registered** — there is no ``Route`` object
for them in this app, so requests to those paths return a clean ``404``
without any side effect.

Cookies and sessions
====================

Both processes read the same ``APP_SESSION_SECRET`` from the env (set by
the start script before fork). Cookies are scoped to the host (default
behaviour — port is not part of the cookie scope), so logging in via
``:8001`` is automatically valid on ``:8002`` and vice versa. The admin
HTML's "Quitter" button just navigates back to ``/`` of the main port.

Launch
======

Recommended via the helper script::

    ./elpis start

or manually::

    APP_MODE=admin APP_SERVICE=admin gunicorn -c gunicorn_admin_conf.py admin_app:app
"""
from __future__ import annotations

import os

# Pin the mode BEFORE importing app.py — create_app() reads APP_MODE at
# module-import time. ``APP_DEFER_CREATE=1`` tells app.py NOT to instantiate
# its own ``app`` at the bottom of the module — we'll call create_app()
# ourselves below. Without this guard the import would build a full FastAPI
# instance we'd immediately discard (wasted work + duplicated startup
# log lines + transient DB connection).
os.environ["APP_MODE"] = "admin"
os.environ.setdefault("APP_SERVICE", "admin")
os.environ["APP_DEFER_CREATE"] = "1"

from server.app import create_app  # noqa: E402

app = create_app()
