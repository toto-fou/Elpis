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
from typing import Any, Dict, Iterable, List, Optional

from shared_infra.sandbox.agent_client import AgentError, AgentListing, AgentRead

from ._exec_bridge import _run_async, sandbox_for
from ._toolkit import _fold_confusable, twin_message


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

    def grep(self, rels: Iterable[str], needle: str, **kw: Any):
        return _run_async(self._agent.grep(rels, needle, **kw))

    def releve_debut(self, skip: Iterable[str], **kw: Any) -> Dict[str, Any]:
        """Relevé avant une commande (cf. ``_work_changes``)."""
        return _run_async(self._agent.changes_begin(skip, **kw))

    def releve_fin(self, ident: str, **kw: Any):
        return _run_async(self._agent.changes_end(ident, **kw))

    def fsop(self, op: str, **kw: Any) -> Dict[str, Any]:
        return _run_async(self._agent.fsop(op, **kw))

    def jumeau_unicode(self, rel: str, max_scan: int = 500) -> Optional[str]:
        """Avertissement si créer ``rel`` introduit un nom qui ne diffère d'un
        voisin que par les accents ou la casse (cf. ``_toolkit.twin_message``).
        Seul le premier composant absent est comparé à son dossier ; jamais
        bloquant (erreur → ``None``)."""
        parties = [c for c in rel.split("/") if c]
        try:
            entrees = self.stats(["/".join(parties[:i + 1]) for i in range(len(parties))])
            i = next((k for k, e in enumerate(entrees) if e.get("kind") == "missing"), None)
            if i is None:
                return None
            parent = "/".join(parties[:i])
            plie = _fold_confusable(parties[i])
            voisins = self.lister(parent, max_entries=max_scan).entries
        except AgentError:
            return None
        return twin_message([(nom, parties[i]) for nom in (v["path"].rsplit("/", 1)[-1] for v in voisins)
                             if nom != parties[i] and _fold_confusable(nom) == plie])


__all__ = ["AgentError", "Espace"]
