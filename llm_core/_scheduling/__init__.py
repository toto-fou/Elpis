# SPDX-License-Identifier: MIT
"""
backend.services._scheduling — LLM scheduling primitives.

Sub-modules:
  - ``_concurrency`` : two-level FIFO manager + ``LLM_SEMAPHORE`` singleton
  - ``_locks``       : per-model exclusivity (local + Redis-distributed) +
                        ``MODEL_EXCLUSIVITY`` singleton
  - ``_guard``       : ``llm_scheduling_guard`` context manager + ``_emit``
                        + ``OnEvent`` type alias

Every name is re-exported here for convenience and for the package façade
``backend.services`` (its auto-export loop walks each registered submodule).
"""
from llm_core._scheduling._concurrency import (
    LLMConcurrencyManager,
    _LLMAcquisition,
    LLM_SEMAPHORE,
    LLAMA_MAX_MODELS,
)
from llm_core._scheduling._locks import (
    ModelExclusivityLock,
    DistributedModelExclusivityLock,
    MODEL_EXCLUSIVITY,
    _LUA_ACQUIRE,
    _LUA_RELEASE,
    _LUA_DEREGISTER_HIGH,
    _LUA_PROMOTE_HIGH,
)
from llm_core._scheduling._guard import (
    llm_scheduling_guard,
    LLMQueueAborted,
    _emit,
    OnEvent,
)

__all__ = [
    "LLMConcurrencyManager", "_LLMAcquisition", "LLM_SEMAPHORE", "LLAMA_MAX_MODELS",
    "ModelExclusivityLock", "DistributedModelExclusivityLock", "MODEL_EXCLUSIVITY",
    "_LUA_ACQUIRE", "_LUA_RELEASE", "_LUA_DEREGISTER_HIGH", "_LUA_PROMOTE_HIGH",
    "llm_scheduling_guard", "LLMQueueAborted", "_emit", "OnEvent",
]
