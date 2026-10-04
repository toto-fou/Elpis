# SPDX-License-Identifier: MIT
"""llm_core/tools/_office/_pptx/errors.py — erreurs du moteur PowerPoint.

``InvalidSpec`` porte un message destiné au modèle (quoi corriger) : la
couche d'outils (``_office.powerpoint``) le relaie tel quel en refus guidé."""
from __future__ import annotations


class PptxMcpError(Exception):
    """Base des erreurs levées volontairement par le moteur."""


class SlideNotFound(PptxMcpError):
    def __init__(self, index: int, total: int) -> None:
        super().__init__(
            f"slide {index + 1} does not exist: the deck has {total} slide(s), numbered from 1. "
            "Read the deck again (pptx_read) for the current outline."
        )
        self.index = index


class InvalidSpec(PptxMcpError):
    """Le contenu demandé ne peut pas être construit."""
