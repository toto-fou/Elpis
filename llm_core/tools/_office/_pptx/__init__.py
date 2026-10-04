# SPDX-License-Identifier: MIT
"""llm_core/tools/_office/_pptx — moteur de rendu PowerPoint.

Repris du serveur MCP pptx-mcp (MIT, même auteur) et allégé pour Elpis : sans
registre de présentations, sans serveur HTTP, sans matplotlib. Les
ressources (images, modèles) passent par ``_office.paquet.charger`` : la
sandbox de l'appelant, jamais le disque de l'hôte ni le réseau."""
