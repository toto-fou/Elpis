# SPDX-License-Identifier: MIT
"""llm_core/tools/_espace.py — le ``/work`` d'un compte, par l'agent de sa
sandbox (L4.2, 2026-09-29).

Les outils ne touchent plus au dossier de la sandbox sur l'hôte : ils
demandent à l'agent du conteneur (``shared_infra.sandbox.agent_client``). Ils
sont synchrones (threads de FastMCP) : chaque appel passe par la boucle
persistante du pont, comme l'exécution de commandes. ``racine`` (``P/work``
sur l'hôte) ne sert qu'aux noms et aux chemins affichés, jamais à ouvrir.
Les refus de l'agent remontent en ``AgentError``.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Iterable, List

from shared_infra.sandbox.agent_client import AgentError, AgentListing, AgentRead

from ._exec_bridge import _run_async, sandbox_for


class Espace:
    def __init__(self, username: str, racine: Path) -> None:
        self.racine = racine
        self._agent = sandbox_for(username, racine).agent

    def stat(self, rel: str, *, hash: bool = False, hash_max: int = 64 << 20) -> Dict[str, Any]:
        """Une entrée ; son refus (lien hors de /work, droits…) en ``AgentError``."""
        e = self.stats([rel], hash=hash, hash_max=hash_max)[0]
        if e.get("kind") == "error":
            raise AgentError(str(e.get("error") or "io_error"), str(e.get("message") or ""))
        return e

    def stats(self, rels: Iterable[str], *, hash: bool = False,
              hash_max: int = 64 << 20) -> List[Dict[str, Any]]:
        return _run_async(self._agent.stat(rels, hash=hash, hash_max=hash_max))

    def lire(self, rel: str, **kw: Any) -> AgentRead:
        return _run_async(self._agent.read(rel, **kw))

    def ecrire(self, rel: str, data: bytes, **kw: Any) -> Dict[str, Any]:
        return _run_async(self._agent.write(rel, data, **kw))

    def lister(self, rel: str = "", **kw: Any) -> AgentListing:
        return _run_async(self._agent.list(rel, **kw))

    def fsop(self, op: str, **kw: Any) -> Dict[str, Any]:
        return _run_async(self._agent.fsop(op, **kw))


__all__ = ["AgentError", "Espace"]
