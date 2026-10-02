# SPDX-License-Identifier: MIT
"""
llm_core.memory._builtin_provider — Provider builtin : mémoire Markdown auto-curée.

Lit deux magasins (``MEMORY.md`` per-scope + ``USER.md`` per-user) et les rend en
un bloc system prompt unique. Le snapshot est capturé UNE fois (à
``initialize``) puis figé — en pratique PAR TOUR : le chatbot reconstruit le
manager à chaque requête (cf. ``chatbot_app/turn/preparation.py``), donc le
bloc reflète l'état au début du tour et n'est pas re-rendu pendant la boucle
d'outils (intra-tour, le
modèle se fie aux ``entries`` des résultats de l'outil ``memory``). Le rendu
est déterministe (ids stables f(contenus)) : à store inchangé, bloc identique
octet pour octet → prefix-cache préservé entre les tours sans mutation.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from llm_core.memory._provider import MemoryProvider
from llm_core.memory._scope import store_for


class MarkdownMemoryProvider(MemoryProvider):
    def __init__(self, username: "str | None", scope_key: "str | None",
                 sandbox_dir: "str | Path", *,
                 memory_limit: int, user_limit: int) -> None:
        self._username = username
        self._scope_key = scope_key
        self._sandbox_dir = sandbox_dir
        self._memory_limit = memory_limit
        self._user_limit = user_limit
        self._frozen_block: Optional[str] = None

    @property
    def name(self) -> str:
        return "builtin"

    def _store(self, kind: str):
        return store_for(kind, self._username, self._scope_key, self._sandbox_dir,
                         memory_limit=self._memory_limit, user_limit=self._user_limit)

    def _render_now(self) -> str:
        user_block = self._store("user").render_block()
        mem_block = self._store("memory").render_block()
        parts = [p for p in (user_block, mem_block) if p]
        if not parts:
            return ""
        return "# Memory (snapshot)\n\n" + "\n\n".join(parts)

    def initialize(self, session_id: str, **kwargs) -> None:
        # Capture figée du snapshot pour la durée de vie du manager (le
        # chatbot en reconstruit un par requête → figé par tour).
        self._frozen_block = self._render_now()

    def system_prompt_block(self) -> str:
        # Si initialize() n'a pas été appelé, rendre à la volée (toujours sûr).
        if self._frozen_block is None:
            return self._render_now()
        return self._frozen_block
