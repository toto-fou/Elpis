# SPDX-License-Identifier: MIT
"""
shared_infra.sandbox — the per-user sandbox, shared by the MCP tools
(llm_core/tools) and the HTTP routes (shared_infra/routes).

The per-user Docker container is the boundary: every operation on ``/work``
runs inside it, through its agent (``agent_client``, ``git_ops`` for git,
``git_relay`` for network git). ``paths`` only maps the paths the model or
the editor give (``/work/...``) to relative paths, lexically — it never
opens anything under ``/work``.
"""
from __future__ import annotations

from shared_infra.sandbox.paths import (
    CONTAINER_ROOT,
    WORK_SUBDIR,
    SandboxPathError,
    ensure_work_subdir,
    strip_work_prefix,
    to_container,
)

__all__ = [
    "CONTAINER_ROOT",
    "WORK_SUBDIR",
    "SandboxPathError",
    "ensure_work_subdir",
    "strip_work_prefix",
    "to_container",
]
