# SPDX-License-Identifier: MIT
"""llm_core._tool_traits — ce qu'un outil fait, décidé en UN seul endroit
(2026-09-29).

Quatre décisions du harnais en dépendent ; chacune lisait jusqu'ici sa propre
source (politique du serveur, annotations MCP, préfixes de noms) avec ses
propres replis :

- ``serial``      : exécuté en série dans un lot d'appels (état partagé :
  sandbox, dépôt, écran, sous-agent) — ``engine/tool_exec`` ;
- ``replay_safe`` : rejouable après une reconnexion, sans doublon —
  ``_mcp_pool`` ;
- ``read_only``   : admis en mode lecture seule (« /plan ») ;
- ``mutates``     : ses cibles (``path``…) sont notées comme artefacts dans le
  résumé de compression. Suit la déclaration de l'outil (ex-préfixes seuls) :
  un outil annoté en lecture seule n'y figure plus, même à préfixe sériel.

Sources : la politique (``meta.policy``) et les annotations MCP déclarées par
le serveur — ``llm_core/tools/_toolkit.py`` pour les outils locaux. Non
déclaré (serveur externe, registre vide ou illisible) : replis prudents par
nom — jamais en lecture seule (fail-fermé), sériel et mutant selon
``LLAMA_TOOL_SERIAL_PREFIXES``, pas rejouable s'il est sériel, s'il porte l'un
de ces préfixes, ou s'il pilote un shell, un écran ou un navigateur.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from llm_core._constants import LLAMA_TOOL_SERIAL_PREFIXES

# Parallélisables, mais un rejeu relancerait l'action (commande, clic…).
_REPLAY_UNSAFE_PREFIXES = ("execute_shell", "shell_", "run_", "desktop_", "pw_", "browser_")


@dataclass(frozen=True)
class ToolTraits:
    serial: bool
    replay_safe: bool
    read_only: bool
    mutates: bool


def tool_traits(name: str, tool: Any = None) -> ToolTraits:
    """Traits de l'outil ``name``. ``tool`` : l'objet issu de ``list_tools()``
    quand on l'a sous la main (ses annotations font foi) ; sinon celles du
    registre ingéré à la connexion du pool."""
    from llm_core import _mcp_categories as cats
    name = (name or "").strip()
    try:
        pol = cats.tool_policy(name)
        ann = cats._extract_annotations(tool) if tool is not None else cats.tool_info(name)
    except Exception:                                    # noqa: BLE001 — registre illisible
        pol, ann = {}, {}
    ro = ann.get("read_only")
    prefixed = name.startswith(LLAMA_TOOL_SERIAL_PREFIXES)
    serial = bool(pol["serial"]) if "serial" in pol else prefixed
    if "replay_safe" in pol:
        replay_safe = bool(pol["replay_safe"])
    else:
        replay_safe = (bool(name) and not serial and not prefixed
                       and not name.startswith(_REPLAY_UNSAFE_PREFIXES))
    return ToolTraits(
        serial=serial,
        replay_safe=replay_safe,
        read_only=bool(ro),
        mutates=(not ro) if ro is not None
        else name.lower().startswith(LLAMA_TOOL_SERIAL_PREFIXES),
    )


__all__ = ["ToolTraits", "tool_traits"]
