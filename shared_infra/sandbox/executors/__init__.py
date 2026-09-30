# SPDX-License-Identifier: MIT
"""
agentic/executors — Sandbox d'exécution (docker user / folder host legacy).

Architecture
------------
* L'admin configure UNE SEULE FOIS où est le daemon Docker (local ou remote
  via TLS) et l'image à utiliser.
* Chaque utilisateur a un container persistant isolé. Le tool MCP
  ``execute_shell`` passe TOUJOURS par docker — voir
  ``tools/_exec_bridge.py``.

Sécurité côté docker
--------------------
Options de lancement : ``UserSandbox._build_run_args`` (capacités réduites
à ``CAPABILITIES``, réseau coupé par défaut, limites mémoire/cpu/pids). Pas
de shell_policy : l'isolation kernel suffit.

Public API
----------
::

    from shared_infra.sandbox.executors import (
        get_user_sandbox,             # UserSandbox du user
        run_in_user_sandbox,          # helper one-shot
        ExecError, ExecResult,
    )
"""
from __future__ import annotations

from shared_infra.sandbox.executors._base import (
    ExecError,
    ExecResult,
    ExecSpec,
    ResourceLimits,
    kill_process_group,
)
from shared_infra.sandbox.executors._image_loader import (
    ImageLoadState,
    ImageLoadStatus,
    ensure_image_loaded,
    find_image_archive,
    get_state as get_image_load_state,
    reset_state as reset_image_load_state,
)
from shared_infra.sandbox.executors._user_sandbox import (
    DEFAULT_IMAGE,
    NetworkProfile,
    SandboxAdminConfig,
    SandboxStatus,
    UserSandbox,
    configured_image,
    gc_idle_containers,
    get_user_sandbox,
    load_admin_config,
    reset_user_sandbox_cache,
    resolve_network_profile_id,
    running_container_stats,
    user_network_profile_id,
)

__all__ = [
    "ResourceLimits", "ExecSpec", "ExecResult", "ExecError",
    "SandboxAdminConfig", "SandboxStatus", "UserSandbox",
    "DEFAULT_IMAGE", "configured_image",
    "load_admin_config", "get_user_sandbox", "reset_user_sandbox_cache",
    "gc_idle_containers", "running_container_stats",
    "NetworkProfile", "resolve_network_profile_id", "user_network_profile_id",
    # Image loader
    "ImageLoadStatus", "ImageLoadState",
    "ensure_image_loaded", "find_image_archive",
    "get_image_load_state", "reset_image_load_state",
]
