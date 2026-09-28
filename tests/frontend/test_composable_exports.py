# SPDX-License-Identifier: MIT
"""tests/frontend/test_composable_exports.py — deux modules ne peuvent pas exporter le même nom.

``app.js`` met à plat les exports de TOUS les composables dans un seul objet :

    return { ...routinesMenuMod, ...workflowMenuMod, ...studioMenuMod, … }

Un nom présent dans deux modules est donc ÉCRASÉ par le dernier spreadé — en
silence, sans erreur JS, et c'est la page du module spreadé en PREMIER qui casse.

C'est arrivé en vrai le 2026-09-08 : la page Workflow exportait ``viewed``,
``loadRuns`` et six autres noms génériques déjà pris par les routines. Résultat :
la page Routines rendait le formulaire de création à la place de la fiche, parce
que son ``viewed`` valait désormais le ``viewed`` (null) des workflows. Aucune
exception, aucun message — juste la mauvaise branche d'un ``v-if``.

Ce test transforme cette classe de bug en échec de test.
"""
from __future__ import annotations

import re
from collections import defaultdict
from pathlib import Path

import pytest

RACINE = Path(__file__).resolve().parents[2]
JS = RACINE / "frontend" / "js"

# Modules mis à plat ensemble dans le ``return`` de setup() (app.js).
# Ajouter un composable ici EN MÊME TEMPS que son spread dans app.js.
COMPOSABLES = [
    "app-chat.js", "app-settings.js", "app-editor.js", "app-auth.js",
    "chat/_routines_menu.js", "chat/_skills_menu.js",
    "chat/_studio_menu.js", "chat/_code_menu.js", "chat/_studio_automation.js",
    "chat/_mascotte.js",
]

# Collisions PRÉEXISTANTES, tolérées et JUSTIFIÉES une par une. Elles ne sont
# pas nocives aujourd'hui — mais seulement par accident d'ordre de spread, ce qui
# est exactement la fragilité que ce test existe pour empêcher de croître.
#
#   resetOnLogout   app-chat.js + app-editor.js — jamais lu à plat : app.js y
#                   accède nommément (``chatMod.resetOnLogout`` /
#                   ``editorMod.resetOnLogout``) via ctx. Aucun template ne
#                   l'appelle.
#   selectSlash     app-chat.js + chat/_code_menu.js — un seul template l'appelle
#                   (chat.html), et ``...chatMod`` est spreadé APRÈS
#                   ``...codeMenuMod`` : c'est bien celui du chat qui gagne.
#                   Inverser l'ordre des spreads casserait le menu « / » du chat.
#
# N'ajoutez RIEN ici sans la même démonstration : renommez plutôt.
COLLISIONS_TOLEREES = {"resetOnLogout", "selectSlash"}

_COMMENT = re.compile(r"//[^\n]*")
_KEY = re.compile(r"(?:^|[\s,{])([A-Za-z_$][\w$]*)\s*(?:,|:|\})")


def _exported(path: Path) -> set:
    """Clés du DERNIER ``return { … };`` du fichier — la surface publique du
    composable. Approximation volontairement simple : elle n'a pas à comprendre
    le JS, seulement à repérer les noms mis à plat."""
    src = path.read_text(encoding="utf-8")
    i = src.rfind("\n    return {")
    if i < 0:
        return set()
    j = src.find("\n    };", i)
    if j < 0:
        return set()
    return {m.group(1) for m in _KEY.finditer(_COMMENT.sub("", src[i:j]))}


def _present():
    return [(n, JS / n) for n in COMPOSABLES if (JS / n).exists()]


def test_les_composables_scannes_existent():
    """Un composable renommé ou supprimé rendrait ce test muet."""
    manquants = [n for n in COMPOSABLES if not (JS / n).exists()]
    assert not manquants, f"composables introuvables : {manquants}"


def test_chaque_composable_expose_une_surface_lisible():
    for nom, p in _present():
        assert _exported(p), f"{nom} : aucun export détecté (le return a-t-il changé de forme ?)"


def test_aucun_nom_exporte_en_double():
    par_nom = defaultdict(list)
    for nom, p in _present():
        for k in _exported(p):
            par_nom[k].append(nom)
    doublons = {k: v for k, v in par_nom.items()
                if len(v) > 1 and k not in COLLISIONS_TOLEREES}
    assert not doublons, (
        "Noms exportés par PLUSIEURS composables — le dernier spreadé dans "
        "app.js écrase les autres en silence :\n" +
        "\n".join(f"  {k} : {', '.join(v)}" for k, v in sorted(doublons.items())))


def test_les_collisions_tolerees_existent_encore():
    """Une exception qui ne correspond plus à rien doit disparaître de la liste,
    sinon elle couvrira un jour une VRAIE collision portant le même nom."""
    par_nom = defaultdict(list)
    for nom, p in _present():
        for k in _exported(p):
            par_nom[k].append(nom)
    mortes = [k for k in COLLISIONS_TOLEREES if len(par_nom.get(k, [])) <= 1]
    assert not mortes, f"exceptions devenues inutiles, à retirer : {mortes}"
