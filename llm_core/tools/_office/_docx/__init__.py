# SPDX-License-Identifier: MIT
"""llm_core/tools/_office/_docx — moteur de rendu Word.

Repris du serveur MCP docx-mcp (MIT, même auteur) et allégé pour Elpis : sans
registre de documents, sans serveur HTTP, sans Jinja ni matplotlib. Les
ressources (images, modèles) passent par ``_office.paquet.charger`` : la
sandbox de l'appelant, jamais le disque de l'hôte ni le réseau."""
