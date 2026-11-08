# SPDX-License-Identifier: MIT
"""office/elpis_office/_pptx/errors.py — erreurs du moteur PowerPoint.

``InvalidSpec`` porte un message destiné au modèle (quoi corriger) : la
couche d'outils (``elpis_office.powerpoint``) le relaie tel quel en refus guidé."""
from __future__ import annotations


class PptxMcpError(Exception):
    """Base des erreurs levées volontairement par le moteur."""


class InvalidSpec(PptxMcpError):
    """Le contenu demandé ne peut pas être construit."""
