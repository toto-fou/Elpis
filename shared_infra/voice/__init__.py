# SPDX-License-Identifier: MIT
"""Famille « voix » — reconnaissance et synthèse, toutes deux déportées.

L'hôte applicatif ne calcule rien : il valide ce qui entre, borne ce qui sort et
relaie vers deux services décrits dans ``deploy/voice/``. Voir
``docs/moteur-vocal-design-2026-09-22.md`` pour le dessin d'ensemble.

Surface publique — le reste est un détail d'implémentation :
    get_voice_config()  la configuration coercée, fraîche du disque
    voice_flags()       (reconnaissance disponible, synthèse disponible)
    transcribe()        WAV -> texte
    synthesize()        texte -> WAV
    pour_la_voix()      markdown -> texte prononçable
    est_bruit()         cette transcription est-elle une hallucination ?
    VoiceError          base des échecs, porte le code HTTP à rendre

``routes`` n'est PAS importé ici : les endpoints s'enregistrent au moment de
l'import de leur module, et l'ordre d'enregistrement est décidé en un seul
endroit — ``shared_infra/routes/__init__.py``, le chef d'orchestre.
"""

from shared_infra.voice.client import synthesize, transcribe
from shared_infra.voice.config import VOICE_DEFAULTS, get_voice_config, voice_flags
from shared_infra.voice.errors import (
    VoiceDesactive,
    VoiceError,
    VoiceInjoignable,
    VoiceOccupe,
    VoiceRefus,
    VoiceTimeout,
)
from shared_infra.voice.filtre import est_bruit
from shared_infra.voice.text import est_prononcable, pour_la_voix

__all__ = [
    "VOICE_DEFAULTS",
    "VoiceDesactive",
    "VoiceError",
    "VoiceInjoignable",
    "VoiceOccupe",
    "VoiceRefus",
    "VoiceTimeout",
    "est_bruit",
    "est_prononcable",
    "get_voice_config",
    "pour_la_voix",
    "synthesize",
    "transcribe",
    "voice_flags",
]
