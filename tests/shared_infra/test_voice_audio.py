# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_voice_audio.py — validation WAV et contexte d'encodeur.

Le navigateur promet du WAV 16 kHz mono PCM 16 bits. On le vérifie plutôt que
de le croire : un format inattendu relayé à whisper rend une transcription vide,
sans jamais dire pourquoi.

``audio_ctx_pour`` doit rendre un multiple de 256 — la carte mesurée sur le
projet antérieur montre que 576 fait littéralement boucler le décodeur.
"""
from __future__ import annotations

import io
import struct
import wave

import pytest

from shared_infra.voice.audio import (
    AUDIO_CTX_MAX,
    AUDIO_CTX_MIN,
    AudioInvalide,
    audio_ctx_pour,
    lit_entete_wav,
    valide_wav_dictee,
)


def fait_wav(secondes=1.0, taux=16000, canaux=1, largeur=2, extra_chunk=False) -> bytes:
    tampon = io.BytesIO()
    with wave.open(tampon, "wb") as sortie:
        sortie.setnchannels(canaux)
        sortie.setsampwidth(largeur)
        sortie.setframerate(taux)
        sortie.writeframes(b"\x00" * int(taux * secondes) * canaux * largeur)
    donnees = tampon.getvalue()
    if not extra_chunk:
        return donnees
    # Un chunk LIST glissé entre « fmt » et « data » : parfaitement légal, et
    # fatal à tout code qui suppose « data commence à l'octet 36 ».
    liste = b"LIST" + struct.pack("<I", 4) + b"INFO"
    coupe = donnees.index(b"data")
    corps = donnees[:coupe] + liste + donnees[coupe:]
    return corps[:4] + struct.pack("<I", len(corps) - 8) + corps[8:]


class TestEnTete:
    def test_lit_un_wav_canonique(self):
        e = lit_entete_wav(fait_wav(2.0))
        assert (e.taux, e.canaux, e.bits) == (16000, 1, 16)
        assert round(e.duree_ms) == 2000

    def test_supporte_un_chunk_intercale(self):
        """La durée serait fausse si on lisait « data » à un décalage fixe."""
        e = lit_entete_wav(fait_wav(1.0, extra_chunk=True))
        assert round(e.duree_ms) == 1000

    def test_refuse_ce_qui_n_est_pas_un_wav(self):
        with pytest.raises(AudioInvalide):
            lit_entete_wav(b"\x1aE\xdf\xa3" + b"\x00" * 100)      # en-tête WebM
        with pytest.raises(AudioInvalide):
            lit_entete_wav(b"court")


class TestValidation:
    def test_accepte_le_format_de_la_dictee(self):
        assert valide_wav_dictee(fait_wav(1.0), 30).taux == 16000

    @pytest.mark.parametrize("kwargs, attendu", [
        ({"taux": 48000}, "48000 Hz"),
        ({"canaux": 2}, "2 canaux"),
        ({"largeur": 1}, "8 bits"),
    ])
    def test_refuse_les_autres(self, kwargs, attendu):
        with pytest.raises(AudioInvalide) as exc:
            valide_wav_dictee(fait_wav(1.0, **kwargs), 30)
        assert attendu in str(exc.value)

    def test_refuse_au_dela_du_plafond_de_duree(self):
        with pytest.raises(AudioInvalide) as exc:
            valide_wav_dictee(fait_wav(12.0), 10)
        assert "plafond" in str(exc.value)

    def test_refuse_un_wav_sans_donnees(self):
        with pytest.raises(AudioInvalide):
            valide_wav_dictee(fait_wav(0.0), 30)


class TestContexteEncodeur:
    @pytest.mark.parametrize("ms", [1, 100, 500, 2000, 5000, 15600, 30000, 999999])
    def test_toujours_un_multiple_de_256_ou_le_plafond(self, ms):
        v = audio_ctx_pour(ms)
        assert v == AUDIO_CTX_MAX or v % 256 == 0
        assert AUDIO_CTX_MIN <= v <= AUDIO_CTX_MAX

    def test_croit_avec_la_duree(self):
        assert audio_ctx_pour(500) <= audio_ctx_pour(5000) <= audio_ctx_pour(20000)

    def test_valeurs_de_reference(self):
        """Mesures d'un projet antérieur : cinq secondes demandent 512 positions."""
        assert audio_ctx_pour(500) == AUDIO_CTX_MIN
        assert audio_ctx_pour(5000) == 512
        assert audio_ctx_pour(30000) == AUDIO_CTX_MAX


def test_tolerance_de_250_ms_sur_la_duree():
    """Le pré-roll et l'arrondi du dernier bloc font déborder le navigateur de
    quelques dizaines de ms : la phrase ne doit pas être jetée pour si peu."""
    assert valide_wav_dictee(fait_wav(secondes=3.2), 3).duree_ms > 3000
    with pytest.raises(AudioInvalide):
        valide_wav_dictee(fait_wav(secondes=3.3), 3)
