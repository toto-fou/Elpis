# SPDX-License-Identifier: MIT
"""
shared_infra.mcp — TOUT ce qui concerne les serveurs MCP, au même endroit.

Avant (2026-09-04), la famille était éparpillée sur trois couches techniques :

    shared_infra/mcp_families.py        la table des familles d'outils
    shared_infra/db/mcp_servers.py      la bibliothèque partagée + les perso
    shared_infra/routes/mcp.py          le panneau d'outils (/api/mcp/*)
    shared_infra/routes/mcp_proxy.py    le relais opencode (/api/mcp-bridge/*)

Quatre dossiers à ouvrir pour suivre un même sujet, et surtout : aucune de ces
places ne disait que les trois autres existaient. C'est ainsi qu'on a pu, la
même semaine, faire vivre une règle de familles dans ``mcp_families`` et une
URL contradictoire dans ``routes/cli`` sans que rien ne les confronte.

Le module fait désormais AUTORITÉ sur la famille :

    families.py   quelles familles d'outils existent, laquelle est exposée à
                  quel client (source unique, partagée avec le serveur MCP)
    servers.py    persistance : bibliothèque partagée (admin) + serveurs perso,
                  résolution des identifiants chiffrés
    panel.py      /api/mcp/* — panneau d'outils du chat, pool, bibliothèque
    bridge.py     /api/mcp-bridge/* — le service MCP partagé sous l'origine de
                  l'app, pour les clients opencode distants

ENREGISTREMENT DES ROUTES. ``panel`` et ``bridge`` posent leurs endpoints sur
le routeur partagé (``shared_infra.routes._state.router``) au moment de leur
import. C'est ``shared_infra.routes.__init__`` qui les importe, au même rang
que les autres modules de routes : l'ORDRE d'enregistrement reste piloté par un
seul fichier, même si le code, lui, vit avec sa famille. Ce module-ci n'importe
donc PAS ses sous-modules de routes — le faire créerait un second chemin
d'enregistrement, dépendant de qui importe quoi en premier.
"""
from __future__ import annotations

# Surface de la famille pour le reste du code. Les modules de ROUTES ne sont
# pas ré-exportés ici (cf. l'encadré ci-dessus) : on n'importe que ce qui est
# consommable par d'autres familles.
from shared_infra.mcp import families as families  # noqa: F401
from shared_infra.mcp import servers as servers    # noqa: F401

__all__ = ["families", "servers"]
