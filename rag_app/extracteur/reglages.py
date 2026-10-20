# SPDX-License-Identifier: MIT
# rag_app/extracteur/reglages.py — réglages de l'extracteur lus dans l'environnement à chaque appel.
from __future__ import annotations

import os
from dataclasses import dataclass


def _nombre(nom: str, defaut: float, minimum: float = 0.0) -> float:
    try:
        valeur = float(os.environ.get(nom, "") or defaut)
    except ValueError:
        return defaut
    return valeur if valeur > minimum else defaut


@dataclass(frozen=True)
class Reglages:
    delai_extraction_s: float
    delai_rendu_s: float
    delai_conversion_s: float
    memoire_enfant_mo: int
    taille_max_octets: int
    texte_max_car: int
    zip_max_mo: int
    concurrence: int
    cache_max_mo: int
    pixels_max: int


def reglages() -> Reglages:
    return Reglages(
        delai_extraction_s=_nombre("RAG_EXTRACT_TIMEOUT_S", 300.0),
        delai_rendu_s=_nombre("RAG_RENDER_TIMEOUT_S", 60.0),
        delai_conversion_s=_nombre("RAG_SOFFICE_TIMEOUT_S", 180.0),
        memoire_enfant_mo=int(_nombre("RAG_EXTRACT_MEM_MB", 3072, 63)),
        taille_max_octets=int(_nombre("RAG_EXTRACT_MAX_BYTES", 200 * 1024 * 1024)),
        texte_max_car=int(_nombre("RAG_EXTRACT_MAX_CHARS", 20_000_000)),
        zip_max_mo=int(_nombre("RAG_EXTRACT_ZIP_MAX_MB", 1024)),
        concurrence=int(_nombre("RAG_EXTRACT_CONCURRENCY", 2)),
        cache_max_mo=int(_nombre("RAG_CACHE_MAX_MB", 2048)),
        pixels_max=int(_nombre("RAG_RENDER_MAX_PIXELS", 60_000_000)),
    )
