# SPDX-License-Identifier: MIT
"""Les échecs du moteur vocal, traduits en quelque chose d'actionnable.

Un message d'erreur vocal finit dans un toast, sous les yeux d'un utilisateur
qui n'administre pas la machine. Il doit dire ce qui se passe **et** ce qu'il
faut faire, sans jargon réseau. Le code HTTP, lui, sert au front à décider s'il
faut réessayer.
"""

from __future__ import annotations


class VoiceError(Exception):
    """Base de tous les échecs vocaux. ``statut`` = code HTTP à renvoyer."""

    statut = 502

    def __init__(self, message: str, *, detail: str = "", code: int = 0) -> None:
        super().__init__(message)
        self.message = message
        self.detail = detail
        # Code HTTP rendu par le moteur DISTANT (0 = pas de réponse). Sert aux
        # replis — un 400 sur ``verbose_json``, un 404 sur une route d'une autre
        # version — sans avoir à relire le message.
        self.code = code


class VoiceDesactive(VoiceError):
    """La fonction est éteinte, ou aucune adresse n'est configurée."""

    statut = 403


class VoiceInjoignable(VoiceError):
    """Le service ne répond pas : arrêté, mauvaise adresse, ou pare-feu."""

    statut = 502


class VoiceTimeout(VoiceError):
    """Le service a mis trop longtemps. Souvent un modèle trop gros pour la machine."""

    statut = 504


class VoiceRefus(VoiceError):
    """Le service a répondu, mais par une erreur (HTTP 4xx/5xx, corps inattendu)."""

    statut = 502


class VoiceOccupe(VoiceError):
    """Tous les créneaux vers le moteur sont pris et l'attente a expiré."""

    statut = 503
