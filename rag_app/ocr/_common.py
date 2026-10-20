# SPDX-License-Identifier: MIT
# rag_app/ocr/_common.py — erreur du client OCR, dans un module à part pour ne pas dépendre de l'ordre d'import du paquet.
from __future__ import annotations


class OcrError(Exception):
    """Échec de la lecture d'une page par le modèle de vision (message lisible, sans détail interne)."""
