# SPDX-License-Identifier: MIT
"""office/elpis_office/_docx/errors.py — erreurs du moteur Word.

``InvalidSpec`` porte un message destiné au modèle (quoi corriger) : la
couche d'outils (``elpis_office.word``) le relaie tel quel en refus guidé."""
from __future__ import annotations


class DocxMcpError(Exception):
    """Base des erreurs levées volontairement par le moteur."""


class InvalidSpec(DocxMcpError):
    """Le contenu demandé ne peut pas être construit."""
