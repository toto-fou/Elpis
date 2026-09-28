# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_voice_filtre.py — rejeter ce que whisper a inventé.

Privé de signal, whisper n'écrit pas « rien » : il écrit toujours la même chose.
Sans ce filtre, la dictée insère « Sous-titres réalisés par la communauté
d'Amara.org » à chaque pause un peu longue.
"""
from __future__ import annotations

import pytest

from shared_infra.voice.filtre import est_bruit


@pytest.mark.parametrize("texte", [
    "",
    " ",
    "a",
    "...",
    ". . .",
    "!!!",
    "[Musique]",
    "(soupir)",
    "*Bruit de fond*",
    "<silence>",
    "Merci",
    "merci beaucoup.",
    "Sous-titres réalisés par la communauté d'Amara.org",
    "SOUS-TITRAGE SOCIÉTÉ RADIO-CANADA",
    "Thanks for watching!",
    "Abonnez-vous !",
])
def test_bruit_rejete(texte):
    assert est_bruit(texte) is True


@pytest.mark.parametrize("texte", [
    "Bonjour, ceci est un test de dictée.",
    "Ouvre le fichier de configuration.",
    "Merci de relire le paragraphe trois avant demain.",
    "OK",
    "42 euros",
])
def test_parole_conservee(texte):
    assert est_bruit(texte) is False


class TestBoucleDeDecodeur:
    def test_repetition_detectee(self):
        """« La voix de la voix de la voix » : diversité lexicale 0,25."""
        assert est_bruit("La voix de la voix de la voix de la voix") is True

    def test_phrase_courte_jamais_jugee_sur_la_diversite(self):
        """Sous six mots, le rapport n'a aucune valeur statistique — et
        « oui oui oui » reste une réponse humaine plausible."""
        assert est_bruit("oui oui oui") is False

    def test_phrase_longue_et_variee_conservee(self):
        assert est_bruit(
            "Je voudrais que tu ouvres le rapport annuel et que tu me résumes "
            "les trois premiers chapitres sans commentaire."
        ) is False


def test_insensible_aux_accents_et_a_la_casse():
    """La même hallucination revient écrite de plusieurs façons selon le modèle."""
    assert est_bruit("SOUS-TITRES REALISES PAR LA COMMUNAUTE D'AMARA.ORG") is True
    assert est_bruit("Sous-titres réalisés par la communauté d'Amara.org") is True


class TestFormulesCourtes:
    """« Merci. », « Au revoir. » se disent pour de vrai : on ne les jette que
    si whisper doutait. Les génériques de vidéo, eux, partent toujours."""

    @pytest.mark.parametrize("texte", ["Merci.", "Merci beaucoup.", "Au revoir.",
                                       "À bientôt !", "Merci !", "à très vite"])
    def test_conservees_quand_le_signal_est_franc(self, texte):
        assert est_bruit(texte, avg_logprob=-0.2, no_speech_prob=0.05) is False

    @pytest.mark.parametrize("scores", [
        {"avg_logprob": -0.8, "no_speech_prob": 0.05},    # décodage hésitant
        {"avg_logprob": -0.2, "no_speech_prob": 0.8},     # probablement du silence
        {"avg_logprob": None, "no_speech_prob": None},    # aucun score : on ne sait rien
    ])
    def test_jetees_quand_le_signal_est_douteux(self, scores):
        assert est_bruit("Merci.", **scores) is True

    @pytest.mark.parametrize("texte", [
        "Sous-titres réalisés par la communauté d'Amara.org",
        "Merci d'avoir regardé cette vidéo.",
        "Thanks for watching!",
    ])
    def test_generiques_toujours_jetes(self, texte):
        assert est_bruit(texte, avg_logprob=-0.1, no_speech_prob=0.0) is True
