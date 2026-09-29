# SPDX-License-Identifier: MIT
"""
shared_infra/sandbox/policy.py — the OP_BACKEND policy table.

This is the migration LEVER and the audit ARTIFACT for moving tool/route
side-effects from the host-direct path into the user's container. It is a one-screen, reviewable map of which logical
operation runs on which backend, with a per-operation environment override
so a single row can be flipped (or rolled back) without a code change.

It ships DEFAULTED TO STATUS QUO — every operation is ``HOST`` — so wiring
this table into the tools/routes is a provable no-op until an operator (or a
later migration step) explicitly flips a row once the agent backend is live
and benchmarked. That is the whole point: separate the *wiring* commit from
the *behavior* commit, and keep a panic button per operation.

Override an operation with:  ``SANDBOX_GATEWAY_<OP>=agent|host``
where ``<OP>`` is the operation name upper-cased with ``.`` → ``_``, e.g.
``SANDBOX_GATEWAY_FS_WRITE=agent``.
"""
from __future__ import annotations

import logging
import os
from enum import Enum
from typing import Dict

logger = logging.getLogger("uvicorn.error")
# Évite le spam : on ne prévient qu'une fois par clé d'env mal renseignée.
_warned_bad_env: set = set()


class Backend(str, Enum):
    HOST = "host"     # host-direct (Python os/shutil/subprocess) — today
    AGENT = "agent"   # inside the user's container (docker exec)


# Logical operation -> default backend. Keys are the vocabulary the tools and
# routes ask about; values default to today's behavior (HOST). Note that
# ``exec.shell`` already crosses into the container via the exec bridge today
# — AGENT means the operation runs inside the container under the user's
# network profile.
_DEFAULTS: Dict[str, Backend] = {
    "fs.read":      Backend.HOST,
    "fs.write":     Backend.HOST,
    "fs.list":      Backend.HOST,
    "fs.grep":      Backend.HOST,
    "fs.stat":      Backend.HOST,
    "exec.shell":   Backend.HOST,
    "snapshot":     Backend.HOST,
}


def _env_key(op: str) -> str:
    return "SANDBOX_GATEWAY_" + op.upper().replace(".", "_")


def backend_for(op: str) -> Backend:
    """Resolve the backend for ``op``. Env override wins; else the default;
    else HOST for any unknown operation (fail safe to today's behavior)."""
    raw = os.environ.get(_env_key(op))
    if raw:
        v = raw.strip().lower()
        if v == Backend.AGENT.value:
            return Backend.AGENT
        if v == Backend.HOST.value:
            return Backend.HOST
        # Valeur non reconnue : on NE bascule PAS silencieusement sur HOST.
        # Une faute de frappe (« agnet », « disable »…) pouvait sinon affaiblir
        # l'isolation sans aucun signal. On prévient l'opérateur (une fois) que
        # son override est ignoré, puis on retombe sur le défaut.
        _ek = _env_key(op)
        if _ek not in _warned_bad_env:
            _warned_bad_env.add(_ek)
            logger.warning(
                "[sandbox.policy] %s=%r non reconnu (attendu 'agent' ou 'host') — "
                "override IGNORÉ, fallback sur le défaut %s. Corrigez la variable d'env.",
                _ek, raw, _DEFAULTS.get(op, Backend.HOST).value,
            )
    return _DEFAULTS.get(op, Backend.HOST)


def use_agent(op: str) -> bool:
    return backend_for(op) is Backend.AGENT


def all_ops() -> Dict[str, Backend]:
    """The full table (defaults, env overrides applied) — for an admin/audit
    view and for ``docs/sandbox-gateway.md``."""
    return {op: backend_for(op) for op in _DEFAULTS}


__all__ = ["Backend", "backend_for", "use_agent", "all_ops"]
