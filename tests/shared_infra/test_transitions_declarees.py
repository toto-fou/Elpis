# SPDX-License-Identifier: MIT
"""Toute transition Vue nommée dans le markup doit exister en CSS — et être
neutralisée quand l'utilisateur demande moins d'animations.

Pourquoi ce test existe
=======================
``<Transition name="X">`` est une promesse silencieuse : Vue pose les classes
``X-enter-active`` / ``X-leave-active`` sur l'élément, et si personne ne les a
définies, il ne se passe RIEN. Aucune erreur, aucun avertissement — juste une
apparition sèche là où le code dit qu'il y a un mouvement.

C'est ce qui était arrivé aux toasts : ``<transition-group name="toast">``
était en place dans ``app_chrome.html``, mais les seules mentions de
``.toast-*`` dans les feuilles étaient… la liste de neutralisation
``prefers-reduced-motion``. Le groupe ne faisait rien, et l'entrée reposait sur
un ``animate-[slideUp_0.2s]`` qui, lui, ne compilait plus (cf.
test_tailwind_arbitrary_utilities). L'élément le plus fugace de l'interface
apparaissait et disparaissait d'un coup.

Le second volet est une règle du projet, consignée dans ``style.css`` : les
classes de transition NOMMÉES ne portent ni préfixe ``transition-`` ni préfixe
``animate-``, elles échappent donc aux sélecteurs génériques du bloc
``prefers-reduced-motion``. Chacune doit y être citée explicitement, sans quoi
modales et menus continuent d'animer malgré la demande de l'OS (WCAG 2.3.3).
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

RACINE = Path(__file__).resolve().parents[2] / "frontend"

# `<Transition name="x">`, `<transition name='x'>`, `<transition-group name="x">`
BALISE = re.compile(
    r"""<(transition(?:-group)?)\b[^>]*?\bname\s*=\s*["']([A-Za-z0-9_-]+)["']""",
    re.IGNORECASE,
)


def _feuilles() -> str:
    """CSS applicatif : la feuille principale, les skins, et le <style> inline
    d'index.html (fade et tool-detail y sont définies)."""
    morceaux = []
    for p in [RACINE / "css" / "style.css", *sorted((RACINE / "css" / "skins").glob("*.css"))]:
        if p.is_file():
            morceaux.append(p.read_text(encoding="utf-8"))
    for page in ("index.html", "admin.html"):
        f = RACINE / page
        if f.is_file():
            morceaux.extend(re.findall(r"<style[^>]*>(.*?)</style>", f.read_text(encoding="utf-8"), re.S))
    return "\n".join(morceaux)


def _sources_markup() -> list[Path]:
    out = [p for p in RACINE.rglob("*.html") if "vendor" not in p.parts]
    return sorted(out)


def _transitions_utilisees() -> dict[str, dict]:
    """{nom -> {'groupe': bool, 'fichiers': [...]}}"""
    trouve: dict[str, dict] = {}
    for f in _sources_markup():
        for balise, nom in BALISE.findall(f.read_text(encoding="utf-8", errors="ignore")):
            e = trouve.setdefault(nom, {"groupe": False, "fichiers": []})
            e["groupe"] = e["groupe"] or balise.lower().endswith("-group")
            e["fichiers"].append(str(f.relative_to(RACINE)))
    return trouve


@pytest.fixture(scope="module")
def css() -> str:
    return _feuilles()


@pytest.fixture(scope="module")
def transitions() -> dict[str, dict]:
    return _transitions_utilisees()


def test_le_markup_declare_bien_des_transitions(transitions):
    """Garde-fou du test lui-même."""
    assert len(transitions) >= 5, f"seulement {len(transitions)} transitions trouvées"


def test_chaque_transition_a_ses_classes_css(transitions, css):
    """`X-enter-active` et `X-leave-active` doivent exister : sans elles, Vue
    pose des classes vides et l'animation promise n'existe pas."""
    manquantes = []
    for nom, info in sorted(transitions.items()):
        for phase in ("enter-active", "leave-active"):
            classe = f".{nom}-{phase}"
            # Une simple présence textuelle ne suffit pas : la liste de
            # neutralisation reduced-motion cite ces mêmes classes. On exige
            # donc une occurrence HORS de ce bloc.
            hors_reduced = _hors_bloc_reduced_motion(css)
            if classe not in hors_reduced:
                manquantes.append(f"{classe}  (employée dans {info['fichiers'][0]})")
    assert not manquantes, (
        "transitions déclarées dans le markup mais SANS règle CSS — Vue posera "
        "des classes vides et rien n'animera :\n  " + "\n  ".join(manquantes))


def test_les_groupes_ont_leur_classe_move(transitions, css):
    """`<transition-group>` réordonne une liste : sans `X-move`, les éléments
    restants SAUTENT à leur nouvelle place quand l'un d'eux part."""
    hors_reduced = _hors_bloc_reduced_motion(css)
    manquantes = [f".{nom}-move" for nom, info in sorted(transitions.items())
                  if info["groupe"] and f".{nom}-move" not in hors_reduced]
    assert not manquantes, f"transition-group sans classe de déplacement : {manquantes}"


def test_chaque_transition_est_neutralisee_en_reduced_motion(transitions, css):
    """Les classes nommées n'ont ni préfixe `transition-` ni `animate-` : les
    sélecteurs génériques du bloc reduced-motion ne les atteignent pas."""
    bloc = _bloc_reduced_motion(css)
    assert bloc, "bloc @media (prefers-reduced-motion: reduce) introuvable"
    oubliees = [nom for nom in sorted(transitions)
                if f".{nom}-enter-active" not in bloc and f".{nom}-leave-active" not in bloc]
    assert not oubliees, (
        "transitions qui continueront d'animer malgré la préférence système "
        f"(WCAG 2.3.3) : {oubliees}")


# ── Découpage du CSS ────────────────────────────────────────────────────────

def _blocs_media_reduced(css: str) -> list[tuple[int, int]]:
    """Étendues des blocs `@media (prefers-reduced-motion: reduce)`, accolades
    comptées (le contenu en imbrique)."""
    etendues = []
    for m in re.finditer(r"@media[^{]*prefers-reduced-motion[^{]*\{", css):
        i, prof = m.end(), 1
        while i < len(css) and prof:
            if css[i] == "{":
                prof += 1
            elif css[i] == "}":
                prof -= 1
            i += 1
        etendues.append((m.start(), i))
    return etendues


def _bloc_reduced_motion(css: str) -> str:
    return "\n".join(css[a:b] for a, b in _blocs_media_reduced(css))


def _hors_bloc_reduced_motion(css: str) -> str:
    reste, pos = [], 0
    for a, b in _blocs_media_reduced(css):
        reste.append(css[pos:a])
        pos = b
    reste.append(css[pos:])
    return "\n".join(reste)
