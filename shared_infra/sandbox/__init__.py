# SPDX-License-Identifier: MIT
"""
shared_infra.sandbox — shared, single-source-of-truth primitives for the
per-user sandbox that BOTH the MCP tools (llm_core/tools) and the HTTP
routes (shared_infra/routes) build on.

Today this package holds:

  * ``paths``   — ``resolve_under()`` / ``ResolvedPath``: the ONE host-side
    path normalizer + containment check, replacing the 6-8 drifting copies
    of "strip ``/work`` then check it doesn't escape the sandbox root".
  * ``git_ops`` — git of a sandbox, run by its in-container agent; network
    operations through the authenticating relay (``git_relay``), for both
    ``llm_core.tools.git_tools`` and the editor's Git routes.

IMPORTANT — on the HOST these are defense-in-depth + UX, NOT the security
boundary. The real isolation boundary for untrusted/model-driven work is the
per-user Docker container (``shared_infra.sandbox.executors``). ``resolve_under`` is
the belt; the container is the parachute. See ``docs`` / the architecture
notes for the migration that moves the remaining host-direct tool paths
behind the container.
"""
from __future__ import annotations

from shared_infra.sandbox.paths import (
    CONTAINER_ROOT,
    WORK_SUBDIR,
    ResolvedPath,
    SandboxPathError,
    ensure_work_subdir,
    resolve_under,
    strip_work_prefix,
    to_container,
)
from shared_infra.sandbox.policy import Backend, all_ops, backend_for, use_agent

__all__ = [
    "CONTAINER_ROOT",
    "WORK_SUBDIR",
    "ResolvedPath",
    "SandboxPathError",
    "ensure_work_subdir",
    "resolve_under",
    "strip_work_prefix",
    "to_container",
    "Backend",
    "backend_for",
    "use_agent",
    "all_ops",
]
