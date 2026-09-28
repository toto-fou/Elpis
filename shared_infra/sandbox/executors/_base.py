# SPDX-License-Identifier: MIT
"""
agentic/executors/_base.py — Types communs pour l'exécution dans la sandbox user.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Optional


@dataclass(frozen=True)
class ResourceLimits:
    """Limites de ressources Docker (cgroups) ou rlimits (host)."""
    memory_mb:     int = 2048
    cpu_quota_pct: int = 100
    pids_max:      int = 512
    nofile_max:    int = 1024
    fsize_max_mb:  int = 200
    timeout_s:     int = 600


@dataclass
class ExecSpec:
    """Spec d'une exécution dans la sandbox user."""
    cmd:         list[str]
    workdir:     str = "/work"             # dans le container
    env:         dict[str, str] = field(default_factory=dict)
    stdin_bytes: Optional[bytes] = None
    timeout_s:   Optional[int] = None       # override du timeout admin


@dataclass
class ExecResult:
    returncode:   int
    stdout:       bytes
    stderr:       bytes
    duration_s:   float
    timed_out:    bool = False
    executor_tag: str = ""
    container_id: Optional[str] = None


class ExecError(RuntimeError):
    """Erreur d'infra (daemon down, image absente, etc.).
    Distincte d'un return code != 0 qui n'est PAS une erreur.

    Peut transporter les logs du container si l'erreur vient d'un crash
    d'init (entrypoint qui plante, etc.). L'API les inclut alors dans la
    réponse pour que l'UI puisse les afficher à l'user."""

    def __init__(self, msg: str, container_logs: Optional[str] = None):
        super().__init__(msg)
        self.container_logs = container_logs


async def kill_process_group(proc: asyncio.subprocess.Process) -> None:
    if proc.returncode is not None:
        return
    try:
        proc.kill()
    except ProcessLookupError:
        return
    try:
        await asyncio.wait_for(proc.wait(), timeout=2.0)
    except asyncio.TimeoutError:
        pass


__all__ = [
    "ResourceLimits", "ExecSpec", "ExecResult", "ExecError",
    "kill_process_group",
]
