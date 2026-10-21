# SPDX-License-Identifier: MIT
"""office/elpis_office/_docx — moteur de rendu Word.

Repris du serveur MCP docx-mcp (MIT, même auteur) et allégé pour Elpis : sans
registre de documents, sans serveur HTTP, sans Jinja ni matplotlib. Les
ressources (images, modèles) passent par ``elpis_office.paquet.charger`` : la
sandbox de l'appelant, jamais le disque de l'hôte ni le réseau."""
