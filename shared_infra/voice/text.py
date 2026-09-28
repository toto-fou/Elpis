# SPDX-License-Identifier: MIT
"""Transformer une réponse markdown en texte qu'une voix peut lire.

Une synthèse vocale lit bêtement ce qu'on lui donne : les astérisques du gras,
les accents graves du code, les barres verticales d'un tableau et l'URL complète
d'un lien. Le modèle produit du markdown quoi qu'on lui demande — ce module est
donc la garantie d'exécution, appliquée **côté serveur** pour que tout appelant
en profite, y compris un futur client qui ne serait pas le navigateur.

Porté d'un projet antérieur de l'auteur, avec une différence assumée : les
blocs de code y sont retirés en silence, ici ils sont **annoncés**. Dans un chat,
sauter un bloc sans le dire laisse croire que la réponse a été tronquée.
"""

from __future__ import annotations

import re
from typing import Tuple

# Un bloc de code ne se lit pas. On le remplace par une annonce plutôt que par
# du vide : l'auditeur sait qu'il doit regarder l'écran.
ANNONCE_CODE = "Bloc de code."
ANNONCE_TABLEAU = "Tableau."

_REMPLACEMENTS: Tuple[Tuple[re.Pattern, str], ...] = (
    # Raisonnement : jamais prononcé, même si le réglage l'affiche à l'écran.
    (re.compile(r"<think>[\s\S]*?</think>", re.I), " "),
    (re.compile(r"```[\s\S]*?```"), f" {ANNONCE_CODE} "),
    # Fence ouverte et jamais refermée (réponse coupée en plein bloc).
    (re.compile(r"```[\s\S]*$"), f" {ANNONCE_CODE} "),
    (re.compile(r"~~~[\s\S]*?~~~"), f" {ANNONCE_CODE} "),
    (re.compile(r"`([^`]*)`"), r"\1"),                       # code en ligne
    (re.compile(r"!\[[^\]]*\]\([^)]*\)"), " "),              # images
    (re.compile(r"\[([^\]]*)\]\([^)]*\)"), r"\1"),           # liens : le libellé seul
    # Balises HTML résiduelles — de VRAIES balises seulement (un nom qui
    # commence par une lettre) : l'ancien ``<[^>]{1,200}>`` avalait tout ce
    # qui séparait « x < 3 et y > 5 ».
    (re.compile(r"</?[A-Za-z][\w:-]*(?:\s[^<>\n]{0,200})?/?>"), " "),
    (re.compile(r"^\s{0,3}#{1,6}\s*", re.M), ""),            # titres
    (re.compile(r"^\s{0,3}>\s?", re.M), ""),                 # citations
    (re.compile(r"^\s{0,3}[-*+]\s+", re.M), ""),             # puces
    (re.compile(r"^\s{0,3}\d{1,3}[.)]\s+", re.M), ""),       # listes numérotées
    (re.compile(r"^\s*\|[-:\s|]+\|\s*$", re.M), " "),        # séparateur de tableau
    (re.compile(r"^\s*\|.*\|\s*$", re.M), f" {ANNONCE_TABLEAU} "),
    (re.compile(r"~~([^~]+)~~"), r"\1"),                     # barré
    (re.compile(r"\*\*([^*]+)\*\*"), r"\1"),                 # gras
    (re.compile(r"(?<!\w)[*_]([^*_\n]+)[*_](?!\w)"), r"\1"),  # italique
    (re.compile(r"^\s*[-*_]{3,}\s*$", re.M), " "),           # filets horizontaux
    (re.compile(r"\[\^[^\]]*\]"), " "),                      # appels de note
    # Émojis et pictogrammes : la voix les lit par leur nom Unicode (« visage
    # souriant »), ou bute dessus. Plages pictographiques, drapeaux, symboles
    # divers, plus le sélecteur de variante et le liant qui les composent.
    (re.compile("[\U0001F000-\U0001FAFF\u2600-\u27BF\u2300-\u23FF"
                "\u2B00-\u2BFF\uFE0F\u200D\u20E3]"), " "),
)

# Ce qui se prononce mieux écrit autrement. Volontairement court : une table de
# substitutions qui grossit finit par trahir le texte d'origine.
_PRONONCIATION: Tuple[Tuple[re.Pattern, str], ...] = (
    (re.compile(r"(\d)\s*°C"), r"\1 degrés"),
    (re.compile(r"(\d)\s*%"), r"\1 pour cent"),
    (re.compile(r"(?<=\d)\s*€"), " euros"),
    (re.compile(r"(?<=\d)\s*\$"), " dollars"),
    (re.compile(r"(?<=\s)&(?=\s)"), " et "),
    # Les flèches seulement : « --help » ou « a -- b » ne sont pas des flèches.
    (re.compile(r"\s*(?:-->|->|=>)\s*"), " vers "),
    (re.compile(r"[•▪●▸→←]"), " "),
    # Une URL nue se lit caractère par caractère pendant vingt secondes.
    (re.compile(r"(?<![\w@])(?:https?://|www\.)\S+"), " lien "),
)

# Les répétitions d'annonce sont fréquentes : trois blocs de code d'affilée dans
# une réponse technique donneraient « Bloc de code. Bloc de code. Bloc de code. »
# Chaque annonce se dédoublonne SÉPARÉMENT : un tableau suivi d'un bloc de code
# doit rester « Tableau. Bloc de code. », pas être fondu en une seule annonce.
_ANNONCES_REPETEES = tuple(
    re.compile(rf"{re.escape(a)}(?:\s+{re.escape(a)})+")
    for a in (ANNONCE_CODE, ANNONCE_TABLEAU)
)

_ESPACES = re.compile(r"\s+")
# Seulement la virgule et le point : en français, deux-points, point-virgule et
# points d'exclamation prennent une espace avant, et la retirer abîmerait le
# texte sans rien changer à ce qui s'entend.
_PONCTUATION_ORPHELINE = re.compile(r"\s+([,.])")


def pour_la_voix(texte: str, max_chars: int = 0) -> str:
    """Markdown en entrée, texte prononçable en sortie.

    ``max_chars`` > 0 tronque à la dernière fin de phrase sous le plafond —
    couper au milieu d'un mot s'entend immédiatement.
    """
    if not texte:
        return ""
    sortie = str(texte)
    for motif, remplacement in _REMPLACEMENTS:
        sortie = motif.sub(remplacement, sortie)
    for motif, remplacement in _PRONONCIATION:
        sortie = motif.sub(remplacement, sortie)
    for annonce, motif in zip((ANNONCE_CODE, ANNONCE_TABLEAU), _ANNONCES_REPETEES):
        sortie = motif.sub(annonce, sortie)
    sortie = _ESPACES.sub(" ", sortie)
    sortie = _PONCTUATION_ORPHELINE.sub(r"\1", sortie).strip()

    if max_chars and len(sortie) > max_chars:
        tronque = sortie[:max_chars]
        coupe = max(tronque.rfind(". "), tronque.rfind("! "), tronque.rfind("? "))
        sortie = (tronque[:coupe + 1] if coupe > max_chars // 3 else tronque).strip()
    return sortie


def est_prononcable(texte: str) -> bool:
    """Reste-t-il quelque chose à dire après nettoyage ?

    Une réponse qui n'était qu'un bloc de code se réduit à son annonce ; une
    réponse vide ou purement décorative ne doit pas déclencher d'appel réseau.
    """
    nu = (texte or "").strip()
    if len(nu) < 2:
        return False
    return any(c.isalnum() for c in nu)
