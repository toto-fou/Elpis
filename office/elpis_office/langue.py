# SPDX-License-Identifier: MIT
"""office/elpis_office/langue.py — langue d'un document : donnée ou détectée dans son texte, libellés qu'il génère."""
from __future__ import annotations

import re
from typing import Any, Dict, Iterable, Optional

from ._chart.normalise import fold

LANGUES = ("fr-FR", "en-US", "de-DE", "es-ES", "it-IT")
_MOTS: Dict[str, frozenset] = {
    "fr-FR": frozenset("le la les des du de et est une un pour dans avec sur au aux que qui pas ce cette ces "
                       "sont nous vous par plus leur été être mais comme ou".split()),
    "en-US": frozenset("the and of to in is are for with on that this by as be it an from at or was were "
                       "will can has have not which their".split()),
    "de-DE": frozenset("der die das und ist nicht mit für auf ein eine den dem zu von sich des im auch wird "
                       "sind oder bei nach".split()),
    "es-ES": frozenset("el los las del y es una para con por que en se como más pero sus al está son fue "
                       "ser".split()),
    "it-IT": frozenset("il gli della dei delle e è una per con che non sono nel alla del come più anche "
                       "questo essere".split()),
}
_NOMS = {"fr": "fr-FR", "francais": "fr-FR", "french": "fr-FR", "en": "en-US", "anglais": "en-US",
         "english": "en-US", "de": "de-DE", "allemand": "de-DE", "german": "de-DE", "deutsch": "de-DE",
         "es": "es-ES", "espagnol": "es-ES", "spanish": "es-ES", "espanol": "es-ES", "it": "it-IT",
         "italien": "it-IT", "italian": "it-IT", "italiano": "it-IT"}
_LIBELLES: Dict[str, Dict[str, str]] = {
    "fr": {"toc": "Sommaire", "table": "Tableau", "figure": "Figure", "listing": "Code",
           "page": "Page {PAGE} / {NUMPAGES}", "agenda": "Sommaire", "closing": "Merci",
           "indicator": "Indicateur", "value": "Valeur", "change": "Évolution"},
    "en": {"toc": "Contents", "table": "Table", "figure": "Figure", "listing": "Listing",
           "page": "Page {PAGE} of {NUMPAGES}", "agenda": "Agenda", "closing": "Thank you",
           "indicator": "Indicator", "value": "Value", "change": "Change"},
    "de": {"toc": "Inhalt", "table": "Tabelle", "figure": "Abbildung", "listing": "Listing",
           "page": "Seite {PAGE} von {NUMPAGES}", "agenda": "Agenda", "closing": "Vielen Dank",
           "indicator": "Kennzahl", "value": "Wert", "change": "Veränderung"},
    "es": {"toc": "Índice", "table": "Tabla", "figure": "Figura", "listing": "Código",
           "page": "Página {PAGE} de {NUMPAGES}", "agenda": "Agenda", "closing": "Gracias",
           "indicator": "Indicador", "value": "Valor", "change": "Variación"},
    "it": {"toc": "Sommario", "table": "Tabella", "figure": "Figura", "listing": "Codice",
           "page": "Pagina {PAGE} di {NUMPAGES}", "agenda": "Agenda", "closing": "Grazie",
           "indicator": "Indicatore", "value": "Valore", "change": "Variazione"},
}
_MOT = re.compile(r"[^\W\d_]+", re.UNICODE)


def normaliser(valeur: Any) -> Optional[str]:
    """« fr », « French », « fr_fr », « FR-fr » → « fr-FR » ; None si non reconnue."""
    brut = str(valeur or "").strip().replace("_", "-")
    if re.fullmatch(r"[A-Za-z]{2}-[A-Za-z]{2}", brut):
        return f"{brut[:2].lower()}-{brut[3:].upper()}"
    return _NOMS.get(fold(brut))


def detecter(textes: Iterable[str]) -> str:
    """Langue la plus probable d'après les mots outils ; sans indice, français si des accents, sinon anglais."""
    textes = list(textes)
    mots = [m.lower() for t in textes for m in _MOT.findall(t or "")]
    scores = {lang: sum(1 for m in mots if m in liste) for lang, liste in _MOTS.items()}
    meilleure = max(LANGUES, key=lambda lang: scores[lang])
    if scores[meilleure]:
        return meilleure
    return "fr-FR" if any(c in "éèêàçùôûîœ" for t in textes for c in (t or "").lower()) else "en-US"


def libelles(lang: Optional[str]) -> Dict[str, str]:
    return _LIBELLES.get((lang or "en")[:2].lower(), _LIBELLES["en"])


def textes_de(valeur: Any) -> Iterable[str]:
    """Toutes les chaînes d'une valeur JSON (diapositives, blocs), pour la détection."""
    if isinstance(valeur, str):
        yield valeur
    elif isinstance(valeur, dict):
        for v in valeur.values():
            yield from textes_de(v)
    elif isinstance(valeur, (list, tuple)):
        for v in valeur:
            yield from textes_de(v)


def choisir(valeur: Any, textes: Iterable[str], notes: Any) -> str:
    """Langue donnée (« fr », « French »…), sinon détectée dans le texte du document."""
    lang = normaliser(valeur)
    if lang:
        return lang
    lang = detecter(textes)
    if valeur:
        notes.fix(f"lang '{valeur}' not understood: {lang}, detected from the text")
    return lang
