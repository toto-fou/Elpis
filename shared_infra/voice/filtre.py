# SPDX-License-Identifier: MIT
"""Rejeter ce que whisper a inventé.

Privé de signal exploitable — un silence, un souffle de ventilateur —, whisper
n'écrit pas « rien » : il écrit quelque chose. Toujours la même chose, d'ailleurs,
ce qui rend le phénomène filtrable. Sans ce module, la dictée insère
« Sous-titres réalisés par la communauté d'Amara.org » à chaque pause un peu
longue.

Porté d'un projet antérieur de l'auteur, où la liste a été constituée à
l'usage.
"""

from __future__ import annotations

import re
import unicodedata

# Comparaison sans accents et sans casse : la même hallucination revient
# écrite de plusieurs façons selon le modèle.
#
# Ces formules-là ne se disent jamais en dictant : ce sont des génériques de
# vidéo appris par whisper. Jetées TOUJOURS, quels que soient les scores.
_HALLUCINATIONS = frozenset(
    s.casefold()
    for s in (
        "merci d'avoir regarde cette video.", "merci d'avoir regarde cette video !",
        "merci d'avoir regarde cette video",
        "sous-titres realises par la communaute d'amara.org",
        "sous-titres realises para la communaute d'amara.org",
        "sous-titrage societe radio-canada", "sous-titrage mfp.",
        "* * *", "...", ". . .", "[musique]",
        "[applaudissements]", "(musique)", "you", "thank you.", "thanks for watching!",
        "amara.org", "abonnez-vous !",
    )
)

# Celles-ci, en revanche, se disent pour de vrai : « Merci. », « Au revoir. »
# en fin de dictée. Whisper les invente AUSSI sur du silence — c'est même sa
# production la plus fréquente —, mais alors avec un score qui le trahit. On ne
# les jette donc que si le signal est douteux. Comparées sur les mots seuls
# (sans ponctuation) : « Merci ! » et « Merci. » sont la même formule.
_FORMULES_COURTES = frozenset((
    "merci", "merci beaucoup", "merci a tous", "au revoir", "a bientot",
    "a tres vite", "c est parti", "bonne journee", "bonne soiree",
))

# Seuils du « signal douteux ». ``no_speech_prob`` : probabilité, estimée par
# whisper lui-même, que le segment ne contienne pas de parole. ``avg_logprob`` :
# confiance moyenne du décodage ; une vraie formule courte, articulée près du
# micro, se situe vers -0,1 à -0,4, l'hallucination sur un souffle en dessous
# de -0,5. Sans AUCUN score (``llama-audio``, repli ``json``), on ne sait rien :
# on jette, comme avant — une formule perdue coûte moins qu'un « Merci. » inséré
# à chaque pause.
_SILENCE_DOUTEUX = 0.5
_LOGPROB_DOUTEUX = -0.5

# Whisper décrit les sons non verbaux entre astérisques, crochets ou
# parenthèses : « *Bruit de la vache* », « (soupir) », « [musique] ». Sur du
# souffle de fond, c'est sa production la plus fréquente. La forme se reconnaît
# structurellement, ce qui vaut mieux qu'une liste noire toujours en retard.
_ENVELOPPES = (("*", "*"), ("[", "]"), ("(", ")"), ("<", ">"))

_MOTS = re.compile(r"\w+", re.UNICODE)

# Au-delà de ce nombre de mots, une transcription dont le vocabulaire se répète
# à ce point n'est pas une phrase : c'est une boucle de décodage. Mesure :
# « La voix de la voix de la voix de la voix » donne un rapport de 0,25.
_MOTS_MINIMUM_POUR_JUGER = 6
_DIVERSITE_MINIMALE = 0.34


def _sans_accents(texte: str) -> str:
    decompose = unicodedata.normalize("NFKD", texte)
    return "".join(c for c in decompose if not unicodedata.combining(c))


def _est_enveloppe(texte: str) -> bool:
    return any(
        texte.startswith(ouvrant) and texte.endswith(fermant) and len(texte) > 1
        for ouvrant, fermant in _ENVELOPPES
    )


def _boucle(texte: str) -> bool:
    """La transcription tourne-t-elle en rond ?

    Le décodeur privé de signal se met à répéter le même fragment. La répétition
    est bien plus fiable à détecter que le contenu lui-même, et elle ne
    ressemble à aucune phrase réellement prononcée.
    """
    mots = _MOTS.findall(texte.casefold())
    if len(mots) < _MOTS_MINIMUM_POUR_JUGER:
        return False
    return len(set(mots)) / len(mots) <= _DIVERSITE_MINIMALE


def _forme(texte: str) -> str:
    """Les mots seuls, sans accents, casse ni ponctuation."""
    return " ".join(_MOTS.findall(_sans_accents(texte).casefold().replace("_", " ")))


def _signal_douteux(avg_logprob: float | None, no_speech_prob: float | None) -> bool:
    if avg_logprob is None and no_speech_prob is None:
        return True
    if no_speech_prob is not None and no_speech_prob >= _SILENCE_DOUTEUX:
        return True
    return avg_logprob is not None and avg_logprob < _LOGPROB_DOUTEUX


def est_bruit(texte: str, avg_logprob: float | None = None,
              no_speech_prob: float | None = None) -> bool:
    """Transcription vide, purement ponctuelle, descriptive ou hallucinée.

    Les scores (ceux de ``client.transcribe``) ne servent qu'aux formules
    courtes plausibles : « Merci. » n'est jeté que si whisper doutait.
    """
    nu = (texte or "").strip()
    if len(nu) < 2:
        return True
    if not any(c.isalnum() for c in nu):
        return True
    if _est_enveloppe(nu):
        return True
    if _sans_accents(nu).casefold() in _HALLUCINATIONS:
        return True
    if _forme(nu) in _FORMULES_COURTES:
        return _signal_douteux(avg_logprob, no_speech_prob)
    return _boucle(nu)
