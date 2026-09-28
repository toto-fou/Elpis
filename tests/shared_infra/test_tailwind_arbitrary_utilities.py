# SPDX-License-Identifier: MIT
"""La feuille Tailwind précompilée doit couvrir les utilitaires à valeur
arbitraire écrits dans le markup.

Pourquoi ce test existe
=======================
Le front ne charge plus le compilateur Tailwind dans le navigateur : la feuille
est produite une fois par ``tools/generate_tailwind_css.mjs``, qui extrait les
classes STATIQUEMENT des sources. Une classe que l'extraction rate n'existe
donc nulle part — et, contrairement au CDN qu'elle remplace, plus rien ne la
rattrape à l'exécution. Elle ne casse rien bruyamment : elle ne fait juste
plus rien.

C'est arrivé. Le filtre de l'extracteur n'acceptait que des minuscules, ce qui
écarte précisément la forme des valeurs arbitraires — le souligné y tient lieu
d'espace et la valeur peut contenir majuscules, parenthèses et virgules.
Treize utilitaires étaient concernés, tous silencieux :

    animate-[slideUp_0.2s]        cinq animations d'apparition mortes
    animate-[fadeIn_0.2s]         (toasts, cartes de connexion, menus)
    w-[min(92vw,540px)]           huit règles de mise en page absentes
    min-h-[calc(44dvh-4rem)]
    grid-cols-[max-content_1fr]
    …

La parité de rendu (``tests/frontend/tailwind-verify.mjs``) ne l'avait pas vu :
elle compare les états qu'elle parvient à ouvrir, et un toast ou un menu fermé
n'y figure pas. Ce test-ci ne dépend d'aucun état : il confronte le texte des
sources à celui de la feuille produite.

En cas d'échec : ``node tools/generate_tailwind_css.mjs``.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

RACINE = Path(__file__).resolve().parents[2] / "frontend"
FEUILLE = RACINE / "css" / "style.tailwind.css"

# Attribut ``class`` STATIQUE uniquement. Le lookbehind écarte ``:class`` et
# ``v-bind:class``, dont le contenu est une expression JavaScript et non une
# liste de classes.
ATTR_CLASS = re.compile(r"""(?<![:\w-])class\s*=\s*"([^"]*)\"""")

# Un utilitaire à valeur arbitraire : un préfixe, puis la valeur entre crochets.
EST_ARBITRAIRE = re.compile(r"^[A-Za-z0-9:/_-]+-\[[^\[\]]*\]$")

# Sélecteur de classe dans la feuille : suite de caractères d'identifiant et de
# séquences d'échappement CSS. S'arrête au premier caractère structurel NON
# échappé (``:`` d'une pseudo-classe, ``{``, ``,``…), ce qui isole bien le nom
# de la classe dans ``.hover\:bg-\[…\]:hover``.
# Le lookbehind écarte les nombres décimaux des DÉCLARATIONS (``animation:
# slideUp 0.15s`` sinon relevé comme une classe ``.15s``).
SELECTEUR = re.compile(r"(?<![0-9])\.((?:\\[0-9a-fA-F]{1,6}[ ]?|\\.|[A-Za-z0-9_-])+)")


def _desechapper(ident: str) -> str:
    """Rend un identifiant CSS échappé à sa forme littérale.

    Tailwind écrit ``\\2c `` pour une virgule (échappement hexadécimal, espace
    final compris) et ``\\(`` pour une parenthèse. Sans cette étape,
    ``w-\\[min\\(92vw\\2c 540px\\)\\]`` ne se rapprocherait jamais de
    ``w-[min(92vw,540px)]``.
    """
    def _un(m: re.Match) -> str:
        hexa = m.group(1)
        return chr(int(hexa, 16)) if hexa else m.group(2)
    return re.sub(r"\\(?:([0-9a-fA-F]{1,6})[ ]?|(.))", _un, ident)


def _sources() -> list[Path]:
    out = []
    for p in RACINE.rglob("*"):
        if p.is_file() and p.suffix in (".html", ".js") and "vendor" not in p.parts:
            out.append(p)
    return out


def _utilitaires_arbitraires() -> dict[str, list[str]]:
    """{classe -> fichiers qui l'emploient}, pour les valeurs arbitraires."""
    trouves: dict[str, list[str]] = {}
    for f in _sources():
        texte = f.read_text(encoding="utf-8", errors="ignore")
        for m in ATTR_CLASS.finditer(texte):
            for jeton in m.group(1).split():
                if "[" in jeton and EST_ARBITRAIRE.match(jeton):
                    trouves.setdefault(jeton, []).append(str(f.relative_to(RACINE)))
    return trouves


@pytest.fixture(scope="module")
def classes_compilees() -> set[str]:
    css = FEUILLE.read_text(encoding="utf-8")
    return {_desechapper(m.group(1)) for m in SELECTEUR.finditer(css)}


def test_la_feuille_precompilee_existe():
    assert FEUILLE.is_file(), f"{FEUILLE} manquant — lancer generate_tailwind_css.mjs"
    assert FEUILLE.stat().st_size > 20_000


def test_le_markup_emploie_bien_des_valeurs_arbitraires():
    """Garde-fou du test lui-même : si l'extraction ne trouve plus rien, c'est
    l'extraction qui est cassée, pas le markup qui s'est simplifié."""
    trouves = _utilitaires_arbitraires()
    assert len(trouves) >= 20, f"seulement {len(trouves)} utilitaires arbitraires trouvés"


def test_chaque_utilitaire_arbitraire_est_compile(classes_compilees):
    manquants = {
        cls: fichiers for cls, fichiers in _utilitaires_arbitraires().items()
        if cls not in classes_compilees
    }
    if manquants:
        detail = "\n".join(
            f"  {cls}  ({len(f)} emploi(s), ex. {f[0]})"
            for cls, f in sorted(manquants.items())
        )
        pytest.fail(
            f"{len(manquants)} utilitaire(s) écrit(s) dans le markup mais absent(s) "
            f"de la feuille précompilée — donc SANS EFFET dans le navigateur :\n"
            f"{detail}\n\nRégénérer : node tools/generate_tailwind_css.mjs"
        )


# Le filtre d'extraction d'origine, celui qui laissait passer la régression.
# On ne teste PAS une liste de classes figée : elle deviendrait fausse au
# premier menu réécrit. On teste la FORME que ce filtre rejetait — majuscule,
# souligné, virgule, parenthèse, quote — qui est celle des valeurs arbitraires.
ANCIEN_FILTRE = re.compile(r"^[a-z0-9!:./\[\]#%@-]+$")


def _formes_autrefois_rejetees() -> dict[str, list[str]]:
    return {
        cls: f for cls, f in _utilitaires_arbitraires().items()
        if not ANCIEN_FILTRE.match(cls)
    }


def test_les_formes_autrefois_rejetees_sont_bien_presentes():
    """Garde-fou : si plus aucune classe n'a cette forme, le test suivant ne
    prouve plus rien et il faut le savoir."""
    formes = _formes_autrefois_rejetees()
    assert len(formes) >= 8, (
        f"seulement {len(formes)} utilitaires de la forme concernée — "
        f"le garde-fou anti-régression ne mord plus")


def test_les_formes_autrefois_rejetees_sont_compilees(classes_compilees):
    manquants = sorted(set(_formes_autrefois_rejetees()) - classes_compilees)
    assert not manquants, (
        "le filtre d'extraction a de nouveau écarté des valeurs arbitraires : "
        f"{manquants}")


def test_les_animations_referencees_ont_leurs_keyframes():
    """Une classe ``animate-[nom_durée]`` ne sert à rien si ``@keyframes nom``
    n'est défini nulle part : la règle existe, l'animation reste inerte."""
    feuilles = [FEUILLE, RACINE / "css" / "style.css"]
    tout = "\n".join(f.read_text(encoding="utf-8") for f in feuilles if f.is_file())
    definies = set(re.findall(r"@keyframes\s+([A-Za-z0-9_-]+)", tout))
    referencees = {
        m.group(1) for m in re.finditer(r"animate-\[([A-Za-z][A-Za-z0-9_-]*)_", " ".join(
            _utilitaires_arbitraires().keys()))
    }
    assert referencees, "aucune animation arbitraire trouvée dans le markup"
    assert referencees <= definies, (
        f"animations sans @keyframes : {sorted(referencees - definies)}")
