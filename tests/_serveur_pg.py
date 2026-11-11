# SPDX-License-Identifier: MIT
"""tests/_serveur_pg.py — serveur PostgreSQL de test d'ELPIS_TEST_PG : URL postgres:// (suites TS) ou hôte:port:base:utilisateur:mot_de_passe."""
from __future__ import annotations

from urllib.parse import unquote, urlsplit


def serveur_pg(valeur: str) -> tuple[str, str, str, str, str]:
    """(hôte, port, base, utilisateur, mot de passe) de l'une ou l'autre forme."""
    if "://" in valeur:
        u = urlsplit(valeur)
        return (u.hostname or "", str(u.port or 5432), unquote(u.path.lstrip("/")),
                unquote(u.username or ""), unquote(u.password or ""))
    hote, port, base, utilisateur, mot_de_passe = valeur.split(":", 4)
    return hote, port, base, utilisateur, mot_de_passe
