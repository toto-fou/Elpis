# SPDX-License-Identifier: MIT
"""tests/frontend/test_js_units.py — pont pytest → tests unitaires JS.

Pourquoi ce fichier existe
==========================
``pytest.ini`` déclare ``python_files = test_*.py``. Les tests unitaires JS
de ``tests/frontend/`` (``test_ansi.js``, ``test_tool_segments.js``,
``models-connector-unit.mjs``, …) ne sont donc collectés par AUCUN lanceur :
ils ne tournent que si quelqu'un se souvient de taper ``node tests/frontend/x``
à la main. Il n'y a ni CI, ni Makefile, ni script qui les appelle — vérifié.

Le 2026-09-17, les neuf existants étaient verts. Par chance, pas par
surveillance : rien n'aurait signalé le contraire. Un test que personne ne
lance n'est pas un filet, c'est un fichier.

Ce module les rend visibles de ``pytest`` : un cas paramétré PAR FICHIER — le
rapport nomme le coupable, pas « les tests JS » — le code de sortie node fait
foi, et stdout+stderr remontent intégralement dans le message d'échec (un
``assert`` JS qui casse doit être lisible sans avoir à relancer quoi que ce
soit à la main).

Conventions de nommage (constatées, puis conservées telles quelles) :

    test_<sujet>.js     cas SYNCHRONES, CommonJS
    <sujet>-unit.mjs    cas ASYNCHRONES, ESM (top-level await)

Le glob est NON récursif, pour deux raisons : ``tests/frontend/lib/`` est le
socle partagé, pas un test ; et les 55 harnais Playwright
``*-server.mjs`` / ``*-verify.mjs`` ne matchent ni l'un ni l'autre motif — ils
gardent leur propre cycle de vie (serveur mock + Chromium), qui n'a rien à
faire dans une suite unitaire.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

ICI = Path(__file__).resolve().parent
RACINE = ICI.parents[1]
NODE = shutil.which("node")

# Large : ces tests durent < 1 s en pratique. Le délai n'est pas un budget de
# performance, c'est un garde contre un process qui ne rend jamais la main.
DELAI_S = 120

# Marqueurs d'assertion cherchés par la garde statique : couvre le harnais
# partagé (``t(``/``ta(``), les sept fichiers historiques (``assert.``) et
# ``models-connector-unit.mjs`` (qui vérifie via un ``check(...)`` local).
MARQUEURS = ("assert.", "assert(", "check(", "t(", "ta(")

# Plancher de découverte : le nombre de fichiers présents à l'écriture de ce
# pont. Voir ``test_le_pont_voit_bien_des_tests_js``.
PLANCHER = 9


def _fichiers() -> list[Path]:
    """Tests unitaires JS, triés par nom pour un rapport stable."""
    return sorted(
        list(ICI.glob("test_*.js")) + list(ICI.glob("*-unit.mjs")),
        key=lambda p: p.name,
    )


FICHIERS = _fichiers()


def _txt(flux) -> str:
    """``TimeoutExpired`` peut porter des bytes même sous ``text=True``."""
    if flux is None:
        return "(vide)"
    if isinstance(flux, bytes):
        flux = flux.decode("utf-8", "replace")
    return flux.strip() or "(vide)"


def test_le_pont_voit_bien_des_tests_js():
    """Un renommage de convention rendrait ce module MUET.

    Il passerait au vert en n'exécutant rien — exactement le mode de panne
    que ``tests/test_no_empty_test_files.py`` existe pour empêcher (séquelle
    du rollback du 2026-07-11, qui avait vidé ~180 fichiers sans que la suite
    rougisse). D'où un plancher explicite, plus deux témoins nommés : un de
    chaque convention.
    """
    noms = [p.name for p in FICHIERS]
    assert len(FICHIERS) >= PLANCHER, (
        f"seulement {len(FICHIERS)} tests unitaires JS découverts dans {ICI} "
        f"(plancher : {PLANCHER}). Les motifs 'test_*.js' et '*-unit.mjs' "
        f"sont-ils toujours la convention ? Trouvés : {noms}"
    )
    assert "test_ansi.js" in noms, f"témoin CommonJS absent : {noms}"
    assert "models-connector-unit.mjs" in noms, f"témoin ESM absent : {noms}"


def test_le_socle_partage_n_est_pas_pris_pour_un_test():
    """``lib/`` contient le harnais, pas des cas.

    Si un fichier du socle finissait par matcher le glob, il serait lancé
    comme un test et sortirait 0 sans rien vérifier — un faux vert de plus
    dans le rapport.
    """
    lib = ICI / "lib"
    assert lib.is_dir(), f"socle partagé introuvable : {lib}"
    intrus = [p.name for p in FICHIERS if p.parent != ICI]
    assert not intrus, f"le glob a débordé hors de {ICI} : {intrus}"
    for p in lib.iterdir():
        assert not p.name.startswith("test_"), (
            f"{p.name} est dans lib/ mais porte un nom de test — il serait "
            "lancé comme un cas et passerait au vert sans rien vérifier"
        )
        assert not p.name.endswith("-unit.mjs"), f"idem pour {p.name}"


@pytest.mark.parametrize("fichier", FICHIERS, ids=lambda p: p.name)
def test_chaque_unite_js_contient_des_assertions(fichier: Path):
    """Garde statique, sœur de ``test_no_empty_test_files.py``.

    Un fichier vidé de ses assertions mais resté non vide sortirait 0 et
    passerait pour un succès. On vérifie donc la PRÉSENCE de vérifications,
    sans relancer node — le cas paramétré ci-dessous s'en charge une fois.
    """
    src = fichier.read_text(encoding="utf-8")
    assert any(m in src for m in MARQUEURS), (
        f"{fichier.name} : aucune assertion détectée "
        f"(marqueurs cherchés : {', '.join(MARQUEURS)})"
    )


@pytest.mark.skipif(NODE is None, reason="node absent de la machine")
@pytest.mark.parametrize("fichier", FICHIERS, ids=lambda p: p.name)
def test_unite_js(fichier: Path):
    """Un cas pytest par fichier JS. Le code de sortie de node fait foi."""
    try:
        r = subprocess.run(
            [NODE, str(fichier)],
            cwd=str(RACINE),
            capture_output=True,
            text=True,
            timeout=DELAI_S,
            env={**os.environ, "NO_COLOR": "1"},
        )
    except subprocess.TimeoutExpired as exc:
        pytest.fail(
            f"{fichier.name} — DÉLAI DÉPASSÉ ({DELAI_S} s).\n"
            "Cause n°1 : le fichier ne se termine pas par le fin() du harnais "
            "partagé. Plusieurs modules du front posent un setInterval ou un "
            "addEventListener au chargement ; sans process.exit() explicite, node "
            "reste vivant APRÈS le dernier assert, et un test qui a RÉUSSI est "
            "rapporté en timeout.\n"
            f"--- stdout partiel ---\n{_txt(exc.stdout)}\n"
            f"--- stderr partiel ---\n{_txt(exc.stderr)}"
        )

    if r.returncode != 0:
        pytest.fail(
            f"{fichier.name} — code de sortie {r.returncode}\n"
            f"rejouer : node {fichier.relative_to(RACINE)}\n"
            f"--- stdout ---\n{r.stdout.strip() or '(vide)'}\n"
            f"--- stderr ---\n{r.stderr.strip() or '(vide)'}"
        )

    assert r.stdout.strip(), (
        f"{fichier.name} : sortie 0 mais stdout VIDE. Le fichier a-t-il "
        "vraiment exécuté quelque chose ?"
    )
