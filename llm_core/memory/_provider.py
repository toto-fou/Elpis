# SPDX-License-Identifier: MIT
"""
llm_core.memory._provider — Abstraction ``MemoryProvider`` (façon Hermes).

Un provider encapsule une stratégie de mémoire long-terme. Le builtin
(``MarkdownMemoryProvider``) est le défaut ; des providers externes pourraient
s'ajouter plus tard (un seul externe actif à la fois, cf. ``MemoryManager``).

Tous les hooks de cycle de vie ont une implémentation par défaut no-op, de sorte
qu'un provider minimal n'a qu'à surcharger ``system_prompt_block`` et/ou les
opérations qui l'intéressent. Les hooks NE DOIVENT PAS lever : la mémoire est
best-effort, jamais bloquante pour la conversation.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Dict, List


class MemoryProvider(ABC):
    """Interface pluggable pour une stratégie de mémoire."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Identifiant court (e.g. 'builtin')."""

    @property
    def is_external(self) -> bool:
        """True pour un backend tiers (limité à un seul actif)."""
        return False

    def is_available(self) -> bool:
        """Vrai si configuré et prêt (sans appel réseau)."""
        return True

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        """Initialise pour une session (lecture du snapshot, etc.)."""

    # ── Contexte / rappel ──────────────────────────────────────────────────────
    def system_prompt_block(self) -> str:
        """Bloc statique injecté en snapshot au début de session. "" = rien."""
        return ""

    # ── Écriture ───────────────────────────────────────────────────────────────
    def sync_turn(self, user_content: str, assistant_content: str, *,
                  session_id: str = "") -> None:
        """Persiste un tour complété. Doit être non bloquant."""

    def on_memory_write(self, action: str, target: str, content: str) -> None:
        """Notifié quand l'outil ``memory`` écrit (mirroring/observabilité)."""

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        """Fin de session : extraction/résumé éventuel."""

    def shutdown(self) -> None:
        """Flush + fermeture propre."""

    # ── Outils spécifiques au provider ─────────────────────────────────────────
    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        """Schémas d'outils (format function-calling) ou []."""
        return []

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs: Any) -> str:
        """Exécute un tool-call routé ; renvoie une string JSON."""
        return ""
