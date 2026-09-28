# SPDX-License-Identifier: MIT
"""Ce que le serveur sait de l'audio qu'on lui confie, sans jamais le décoder.

Le navigateur envoie du **WAV 16 kHz mono PCM 16 bits**, et rien d'autre. C'est
exactement ce que whisper attend : pas de transcodage ffmpeg dans le chemin
chaud, et l'hôte applicatif — deux à quatre cœurs, partagés avec tout le reste —
ne fait que lire un en-tête de quarante-quatre octets.

D'où une validation stricte : mieux vaut refuser un format inattendu que de le
relayer à whisper, qui rendrait une transcription vide sans dire pourquoi.
"""

from __future__ import annotations

import math
import struct
from typing import NamedTuple, Optional

# Ce que la dictée produit, et la seule chose qu'on accepte.
TAUX_ATTENDU = 16000
CANAUX_ATTENDUS = 1
BITS_ATTENDUS = 16

# En dessous, il n'y a rien à transcrire : whisper hallucine sur le silence
# (c'est même sa production la plus fréquente).
DUREE_MINIMALE_MS = 250.0

# Contexte d'encodeur — carte mesurée sur un projet antérieur. Tout ce qui n'est
# pas un multiple de 256 va de mauvais à catastrophique : 576 fait littéralement
# boucler le décodeur (WER 1318 %). La formule adaptative « naturelle » produit
# des valeurs arbitraires (398 pour cinq secondes) qui tombent dans ces trous.
POSITIONS_PAR_SECONDE = 50
AUDIO_CTX_MIN = 256          # sous 256, l'encodeur invente même sur une phrase courte
AUDIO_CTX_MAX = 1500
AUDIO_CTX_PAS = 256
AUDIO_CTX_MARGE = 1.6        # un contexte trop court coûte la qualité ET la latence


class AudioInvalide(ValueError):
    """Le fichier n'est pas le WAV attendu. Le message est montré à l'admin."""


class EnTeteWav(NamedTuple):
    taux: int
    canaux: int
    bits: int
    octets_donnees: int

    @property
    def duree_ms(self) -> float:
        largeur = max(1, self.bits // 8) * max(1, self.canaux)
        return self.octets_donnees / largeur / max(1, self.taux) * 1000.0


def lit_entete_wav(donnees: bytes) -> EnTeteWav:
    """Lit l'en-tête RIFF/WAVE sans charger l'audio.

    On parcourt les chunks plutôt que de supposer le canonique « fmt puis
    data à l'octet 36 » : certains encodeurs glissent un ``LIST``/``fact``
    entre les deux, et le calcul de durée serait faux d'autant.
    """
    if len(donnees) < 44:
        raise AudioInvalide("Fichier audio trop court pour être un WAV.")
    if donnees[0:4] != b"RIFF" or donnees[8:12] != b"WAVE":
        raise AudioInvalide("Le fichier n'est pas un WAV (en-tête RIFF absent).")

    pos = 12
    fmt: Optional[tuple] = None
    octets_donnees = 0
    fin = len(donnees)
    while pos + 8 <= fin:
        ident = donnees[pos:pos + 4]
        (taille,) = struct.unpack_from("<I", donnees, pos + 4)
        corps = pos + 8
        if ident == b"fmt " and taille >= 16 and corps + 16 <= fin:
            audio_format, canaux, taux, _debit, _bloc, bits = struct.unpack_from("<HHIIHH", donnees, corps)
            fmt = (audio_format, canaux, taux, bits)
        elif ident == b"data":
            # Une taille annoncée plus grande que le fichier arrive sur les flux
            # tronqués : on s'en tient à ce qu'on a vraiment reçu.
            octets_donnees = min(taille, fin - corps)
            break
        pos = corps + taille + (taille & 1)          # les chunks sont alignés sur 2

    if fmt is None:
        raise AudioInvalide("WAV sans bloc de format.")
    audio_format, canaux, taux, bits = fmt
    if audio_format != 1:
        raise AudioInvalide("WAV compressé : seul le PCM non compressé est accepté.")
    return EnTeteWav(taux=int(taux), canaux=int(canaux), bits=int(bits),
                     octets_donnees=int(octets_donnees))


TOLERANCE_DUREE_MS = 250.0


def valide_wav_dictee(donnees: bytes, max_utterance_sec: int) -> EnTeteWav:
    """Vérifie qu'on tient bien un énoncé de dictée exploitable."""
    entete = lit_entete_wav(donnees)
    if entete.canaux != CANAUX_ATTENDUS:
        raise AudioInvalide(f"Audio à {entete.canaux} canaux : il en faut {CANAUX_ATTENDUS}.")
    if entete.bits != BITS_ATTENDUS:
        raise AudioInvalide(f"Audio en {entete.bits} bits : il en faut {BITS_ATTENDUS}.")
    if entete.taux != TAUX_ATTENDU:
        raise AudioInvalide(f"Audio à {entete.taux} Hz : il faut du {TAUX_ATTENDU} Hz.")
    if entete.octets_donnees <= 0:
        raise AudioInvalide("WAV sans données audio.")
    # +250 ms de tolérance : le navigateur coupe à son plafond, mais son
    # pré-roll et l'arrondi du dernier bloc de 128 échantillons le font
    # déborder de quelques dizaines de ms. Refuser pour si peu jetait la phrase
    # entière de celui qui parlait le plus longtemps.
    if entete.duree_ms > max_utterance_sec * 1000.0 + TOLERANCE_DUREE_MS:
        raise AudioInvalide(f"Énoncé de {entete.duree_ms / 1000:.0f} s : le plafond est {max_utterance_sec} s.")
    return entete


def audio_ctx_pour(duree_ms: float) -> int:
    """Contexte d'encodeur juste suffisant, arrondi au multiple de 256 supérieur.

    C'est le levier de latence n°1 sur les phrases courtes : une seconde d'audio
    décodée avec le contexte complet coûte cinq fois le nécessaire. La marge de
    1,6 évite l'autre écueil — un contexte trop juste fait échouer le décodage,
    qui se rejoue alors en repli de température (qualité ET latence perdues).
    """
    besoin = max(duree_ms, 1.0) / 1000.0 * POSITIONS_PAR_SECONDE * AUDIO_CTX_MARGE
    arrondi = math.ceil(besoin / AUDIO_CTX_PAS) * AUDIO_CTX_PAS
    return AUDIO_CTX_MAX if arrondi > AUDIO_CTX_MAX else max(AUDIO_CTX_MIN, arrondi)
