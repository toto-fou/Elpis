# SPDX-License-Identifier: MIT
"""
llm_core.memory — Mémoire unifiée façon Hermes (Markdown auto-curé + FTS5).

Moteur PUR utilisé par le chatbot (chatbot_app) : il n'est jamais importé ici.
La persistance FTS vit dans ``shared_infra.memory.store`` (atteinte par
import local).

API publique :
  - ``MemoryManager`` / ``build_default_manager(...)`` — orchestrateur + fabrique.
  - ``MemoryProvider`` — ABC pour providers pluggables.
  - ``MarkdownStore`` / ``store_for`` — primitives bas niveau (outil ``memory``).
"""
from __future__ import annotations

from llm_core.memory._manager import MemoryManager, build_default_manager
from llm_core.memory._provider import MemoryProvider
from llm_core.memory._builtin_provider import MarkdownMemoryProvider
from llm_core.memory._markdown_store import (
    MarkdownStore, StoreOpResult, StoreBusyError, parse_entries,
    compute_entry_id, entry_ids, normalize_for_match, sanitize_entry_text,
)
from llm_core.memory._scope import (
    store_for, resolve_paths, safe_username,
    DEFAULT_MEMORY_LIMIT, DEFAULT_USER_LIMIT,
)

__all__ = [
    "MemoryManager", "build_default_manager", "MemoryProvider",
    "MarkdownMemoryProvider", "MarkdownStore", "StoreOpResult", "StoreBusyError",
    "parse_entries", "compute_entry_id", "entry_ids", "normalize_for_match",
    "sanitize_entry_text",
    "store_for", "resolve_paths", "safe_username",
    "DEFAULT_MEMORY_LIMIT", "DEFAULT_USER_LIMIT",
]
