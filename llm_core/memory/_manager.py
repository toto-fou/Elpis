# SPDX-License-Identifier: MIT
"""
llm_core.memory._manager — Orchestrateur de providers (façon Hermes).

Le ``MemoryManager`` enregistre des providers (un seul externe à la fois),
agrège leurs blocs system prompt, route les hooks d'écriture (sync_turn,
on_memory_write), et alimente l'index de recherche d'historique FTS5.
Le manager ne référence jamais ``chatbot_app``.

NOTE — il n'y a volontairement PAS de rappel par pertinence (prefetch top-k)
par tour : le snapshot Markdown borné (≤ ~1100 tokens) injecté ENTIER est
byte-stable → le préfixe KV (n_cache_reuse) survit d'un tour à l'autre. Un
top-k par tour ferait varier la tête du system prompt à chaque message =
invalidation quasi systématique du cache, pour économiser < 900 tokens.

L'accès DB (FTS) se fait par import LOCAL dans la méthode pour éviter tout
cycle d'import au chargement du module (pattern hérité de l'ancien
``long_memory.py``).
"""
from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from llm_core.memory._provider import MemoryProvider

log = logging.getLogger("uvicorn.error")


class MemoryManager:
    def __init__(self, *, username: "str | None", scope_key: "str | None" = "user",
                 app: str = "chat", session_id: str = "") -> None:
        self.username = username
        self.scope_key = scope_key or "user"
        self.app = app  # 'chat' | 'agentic'
        self.session_id = session_id
        self._providers: List[MemoryProvider] = []
        self._user_id: Optional[int] = None
        self._user_id_resolved = False

    # ── Enregistrement ─────────────────────────────────────────────────────────
    def register(self, provider: MemoryProvider) -> "MemoryManager":
        if provider.is_external and any(p.is_external for p in self._providers):
            raise ValueError("Only one external memory provider is allowed at a time")
        self._providers.append(provider)
        return self

    @property
    def providers(self) -> List[MemoryProvider]:
        return list(self._providers)

    # ── Cycle de vie ────────────────────────────────────────────────────────────
    def initialize(self, session_id: str = "") -> "MemoryManager":
        if session_id:
            self.session_id = session_id
        for p in self._providers:
            try:
                if p.is_available():
                    p.initialize(self.session_id)
            except Exception as e:  # best-effort, jamais bloquant
                log.warning("[memory] initialize(%s) failed: %s", p.name, e)
        return self

    def shutdown(self) -> None:
        for p in self._providers:
            try:
                p.shutdown()
            except Exception:
                pass

    # ── Contexte ─────────────────────────────────────────────────────────────────
    def system_prompt_block(self) -> str:
        blocks: List[str] = []
        for p in self._providers:
            try:
                b = (p.system_prompt_block() or "").strip()
                if b:
                    blocks.append(b)
            except Exception as e:
                log.warning("[memory] system_prompt_block(%s) failed: %s", p.name, e)
        return "\n\n".join(blocks)

    # ── Écriture ───────────────────────────────────────────────────────────────
    def _resolve_user_id(self) -> Optional[int]:
        if self._user_id_resolved:
            return self._user_id
        self._user_id_resolved = True
        try:
            from shared_infra.accounts.users import get_user
            row = get_user(self.username) if self.username else None
            self._user_id = int(row["id"]) if row else None
        except Exception:
            self._user_id = None
        return self._user_id

    def _index_message(self, role: str, content: str) -> None:
        content = (content or "").strip()
        if not content:
            return
        uid = self._resolve_user_id()
        if uid is None:
            return
        try:
            from shared_infra.memory.store import session_index_message
            session_index_message(
                user_id=uid, app=self.app, session_id=self.session_id,
                scope_key=("" if self.scope_key == "user" else self.scope_key),
                role=role, content=content, ts=time.time(),
            )
        except Exception as e:
            log.debug("[memory] session index failed: %s", e)

    def sync_turn(self, user_content: str, assistant_content: str) -> None:
        # 1) Index FTS (recherche d'historique) — alimenté par les deux apps.
        self._index_message("user", user_content)
        self._index_message("assistant", assistant_content)
        # 2) Hook providers (best-effort).
        for p in self._providers:
            try:
                p.sync_turn(user_content, assistant_content, session_id=self.session_id)
            except Exception as e:
                log.warning("[memory] sync_turn(%s) failed: %s", p.name, e)

    def on_memory_write(self, action: str, target: str, content: str) -> None:
        for p in self._providers:
            try:
                p.on_memory_write(action, target, content)
            except Exception:
                pass

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        for p in self._providers:
            try:
                p.on_session_end(messages)
            except Exception:
                pass


def build_default_manager(username: "str | None", scope_key: "str | None" = "user", *,
                          app: str = "chat", session_id: str = "",
                          sandbox_dir: "str | Path | None" = None) -> MemoryManager:
    """Fabrique un manager câblé avec le provider builtin (Markdown auto-curé).

    ``sandbox_dir`` et les limites sont lus depuis la config si non fournis
    (import local pour garder le moteur testable sans la config).
    """
    from llm_core.memory import _scope
    from llm_core.memory._builtin_provider import MarkdownMemoryProvider

    mem_limit = _scope.DEFAULT_MEMORY_LIMIT
    user_limit = _scope.DEFAULT_USER_LIMIT
    if sandbox_dir is None:
        try:
            from shared_infra import config as _cfg
            sandbox_dir = str(getattr(_cfg, "MEMORY_DIR", _cfg.SANDBOX_DIR))
            mem_limit = getattr(_cfg, "MEMORY_MD_CHAR_LIMIT", mem_limit)
            user_limit = getattr(_cfg, "USER_MD_CHAR_LIMIT", user_limit)
        except Exception:
            sandbox_dir = "user_sandboxes"

    mgr = MemoryManager(username=username, scope_key=scope_key, app=app, session_id=session_id)
    mgr.register(MarkdownMemoryProvider(
        username, scope_key, sandbox_dir,
        memory_limit=mem_limit, user_limit=user_limit,
    ))
    return mgr
