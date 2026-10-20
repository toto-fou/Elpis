# SPDX-License-Identifier: MIT
# rag_app/extracteur/blocs.py — collecte des blocs (plafond de caractères) et tableaux Markdown par paquets.
from __future__ import annotations

import re
from collections.abc import Callable, Iterable
from typing import Any

_ESPACES = re.compile(r"[ \t  ]+")
_PAQUET_LIGNES = 40
_PAQUET_CAR = 3500
_CELLULE_MAX = 2000


class LimiteAtteinte(Exception):
    """Le plafond max_chars est atteint : l'analyse s'arrête, le résultat reste valide."""


def compacter(texte: str) -> str:
    return _ESPACES.sub(" ", texte.replace("\r", "")).strip()


class Collecteur:
    def __init__(self, max_chars: int, progression: Callable[[int, int], None] | None = None) -> None:
        self.max_chars = max_chars
        self.blocs: list[dict[str, Any]] = []
        self.avertissements: list[dict[str, Any]] = []
        self.total = 0
        self._progression = progression

    def progresser(self, fait: int, total: int) -> None:
        if self._progression is not None:
            self._progression(fait, total)

    def avertir(self, code: str, message: str, **extra: Any) -> None:
        self.avertissements.append({"code": code, "message": message, **extra})

    def ajouter(self, kind: str, texte: str, **extra: Any) -> None:
        if not texte or not texte.strip():
            return
        reste = self.max_chars - self.total
        if len(texte) > reste:
            if reste >= 200:
                self._poser(kind, texte[:reste], extra)
            self.avertir("truncated", f"Texte tronqué à {self.max_chars} caractères.")
            raise LimiteAtteinte()
        self._poser(kind, texte, extra)

    def _poser(self, kind: str, texte: str, extra: dict[str, Any]) -> None:
        bloc: dict[str, Any] = {"kind": kind, "text": texte}
        bloc.update({k: v for k, v in extra.items() if v is not None})
        self.blocs.append(bloc)
        self.total += len(texte)

    def tableau(self, lignes: Iterable[list[str]], **extra: Any) -> None:
        """Première ligne = en-tête, répétée dans chaque paquet de lignes."""
        entete: list[str] | None = None
        paquet: list[list[str]] = []
        taille = 0
        emis = False
        for ligne in lignes:
            if entete is None:
                entete = ligne
                continue
            paquet.append(ligne)
            taille += sum(len(c) for c in ligne) + 3 * len(ligne)
            if len(paquet) >= _PAQUET_LIGNES or taille >= _PAQUET_CAR:
                self.ajouter("table", markdown(entete, paquet), **extra)
                paquet, taille, emis = [], 0, True
        if entete is not None and (paquet or not emis):
            self.ajouter("table", markdown(entete, paquet), **extra)


def cellule(valeur: Any) -> str:
    if valeur is None:
        return ""
    texte = valeur if isinstance(valeur, str) else str(valeur)
    texte = compacter(texte.replace("\n", " "))[:_CELLULE_MAX]
    return texte.replace("|", "\\|")


def markdown(entete: list[str], lignes: list[list[str]]) -> str:
    largeur = max([len(entete)] + [len(r) for r in lignes])

    def ligne(cellules: list[str]) -> str:
        return "| " + " | ".join(cellules + [""] * (largeur - len(cellules))) + " |"

    return "\n".join([ligne(entete), "| " + " | ".join(["---"] * largeur) + " |", *(ligne(r) for r in lignes)])
