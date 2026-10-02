# SPDX-License-Identifier: MIT
"""tests/llm_core/test_seams_effectifs.py — les substitutions des tests visent
le code qui s'exécute vraiment.

Un ``monkeypatch.setattr(module, "nom", faux)`` ne remplace que la variable
``nom`` DE CE MODULE. Si le code qui l'utilisait a déménagé dans un autre
module, la substitution ne touche plus rien : le test passe toujours, mais il
ne vérifie plus ce qu'il croit vérifier. Ces gardes rendent ce cas bruyant
pour les modules découpés (``MODULES_DU_CHANTIER``) :

1. chaque nom substitué sur l'un de ces modules y est LU dans un corps de
   fonction, ou importé depuis lui dans un corps de fonction d'un autre module
   (une lecture au seul niveau du module est faite une fois à l'import : la
   substituer ensuite n'a aucun effet) ;
2. ``raising=False`` y est interdit : il ferait passer en silence une cible
   disparue ;
3. les noms du seam de la boucle (``SEAM_BOUCLE``) ne sont référencés que par
   l'orchestrateur et par leur module de définition : un autre module qui les
   importerait contournerait l'injection, et les substitutions des tests ne
   le couvriraient plus ;
4. la façade ``llm_core`` garde tous ses noms (instantané
   ``facade_llm_core.json``), et chaque fonction ou classe qu'elle expose est
   l'objet défini dans son module propriétaire.

Ajouter un module découpé = une ligne dans ``MODULES_DU_CHANTIER``.

Régénérer l'instantané de la façade (seulement quand un nom doit
légitimement disparaître, diff relu) :
    ELPIS_FACADE_SNAPSHOT_UPDATE=1 venv/bin/pytest -n0 tests/llm_core/test_seams_effectifs.py
"""
from __future__ import annotations

import ast
import importlib
import importlib.util
import inspect
import json
import os
import sys
import types
from collections.abc import Iterator
from functools import lru_cache
from pathlib import Path

import pytest

RACINE = Path(__file__).resolve().parents[2]
DOSSIER_TESTS = RACINE / "tests"
INSTANTANE_FACADE = Path(__file__).with_name("facade_llm_core.json")

# Modules dont le code est découpé : leurs substitutions sont contrôlées.
MODULES_DU_CHANTIER = frozenset({
    "llm_core._chat_with_tools",
    "llm_core._tool_parsing",
    "llm_core.engine.live_text",
    "llm_core.engine.llm_stream",
    "llm_core.engine.llm_turn",
    "llm_core.engine.result_contract",
    "llm_core.engine.tool_catalog",
    "llm_core.engine.resume",
    "llm_core.engine.run",
    "llm_core.engine.run_exit",
    "llm_core.engine.tool_dispatch",
    "chatbot_app.routes.chats",
    "chatbot_app.routes.chat_control",
    "chatbot_app.routes.chat_compression",
    "chatbot_app.turn.admission",
    "chatbot_app.turn.events",
    "chatbot_app.turn.execution",
    "chatbot_app.turn.history",
    "chatbot_app.turn.persistence",
    "chatbot_app.turn.preparation",
    "chatbot_app.turn.tasks",
})

# Seam de la boucle : l'orchestrateur résout ces noms dans ses propres
# globales et les injecte ; les tests les substituent sur l'orchestrateur.
ORCHESTRATEUR = "llm_core._chat_with_tools"
SEAM_BOUCLE = frozenset({
    "_llama_chat_with_tools_stream",
    "_record_tool_call_metric_safe",
})

# Code de production parcouru pour la garde 3.
DOSSIERS_PRODUCTION = ("llm_core", "chatbot_app", "shared_infra", "server", "toolhost")


# ── Outils d'analyse ─────────────────────────────────────────────────────────

def _fichier_du_module(nom: str) -> Path:
    spec = importlib.util.find_spec(nom)
    assert spec is not None and spec.origin, f"module introuvable : {nom}"
    return Path(spec.origin)


@lru_cache(maxsize=None)
def _arbre(chemin: Path) -> ast.Module:
    return ast.parse(chemin.read_text(encoding="utf-8"), filename=str(chemin))


def _nom_pointe(noeud: ast.AST) -> str | None:
    """``a.b.c`` pour une chaîne d'attributs sur un nom, sinon ``None``."""
    morceaux: list[str] = []
    while isinstance(noeud, ast.Attribute):
        morceaux.append(noeud.attr)
        noeud = noeud.value
    if not isinstance(noeud, ast.Name):
        return None
    morceaux.append(noeud.id)
    return ".".join(reversed(morceaux))


def _alias_d_import(noeuds: list[ast.AST]) -> dict[str, str]:
    """Nom local → chemin pointé, pour les imports et les
    ``importlib.import_module("…")`` / ``sys.modules["…"]`` littéraux."""
    alias: dict[str, str] = {}
    for n in noeuds:
        if isinstance(n, ast.Import):
            for a in n.names:
                if a.asname:
                    alias[a.asname] = a.name
                else:
                    racine = a.name.split(".", 1)[0]
                    alias.setdefault(racine, racine)
        elif isinstance(n, ast.ImportFrom) and n.module and not n.level:
            for a in n.names:
                alias[a.asname or a.name] = f"{n.module}.{a.name}"
        elif isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name):
            v = n.value
            if (isinstance(v, ast.Call) and v.args and isinstance(v.args[0], ast.Constant)
                    and isinstance(v.args[0].value, str)
                    and (_nom_pointe(v.func) or "").split(".")[-1] == "import_module"):
                alias[n.targets[0].id] = v.args[0].value
            elif (isinstance(v, ast.Subscript) and _nom_pointe(v.value) == "sys.modules"
                    and isinstance(v.slice, ast.Constant) and isinstance(v.slice.value, str)):
                alias[n.targets[0].id] = v.slice.value
    return alias


def _resoudre(expr: ast.AST, alias: dict[str, str]) -> str | None:
    pointe = _nom_pointe(expr)
    if pointe is None:
        return None
    tete, _, reste = pointe.partition(".")
    if tete not in alias:
        return None
    return alias[tete] + (f".{reste}" if reste else "")


def _portees(arbre: ast.Module) -> Iterator[tuple[ast.AST, dict[str, str]]]:
    """(nœud, alias visibles), de la fonction la plus imbriquée au module :
    une fonction voit les imports du module et les siens (imbriqués compris) ;
    un appel est attribué à la portée la plus profonde qui sait le résoudre."""
    alias_module = _alias_d_import(list(arbre.body))
    profondeurs: list[tuple[int, ast.AST]] = []

    def descendre(noeud: ast.AST, profondeur: int) -> None:
        for enfant in ast.iter_child_nodes(noeud):
            if isinstance(enfant, (ast.FunctionDef, ast.AsyncFunctionDef)):
                profondeurs.append((profondeur + 1, enfant))
                descendre(enfant, profondeur + 1)
            else:
                descendre(enfant, profondeur)

    descendre(arbre, 0)
    for _, fonction in sorted(profondeurs, key=lambda p: -p[0]):
        yield fonction, {**alias_module, **_alias_d_import(list(ast.walk(fonction)))}
    yield arbre, alias_module


def _substitutions(chemin: Path) -> Iterator[tuple[str, str, ast.Call]]:
    """(module, nom, appel) pour chaque substitution d'un attribut de module :
    ``*.setattr(cible, "nom", …)``, ``setattr(cible, "nom", …)``,
    ``patch.object(cible, "nom", …)`` et les formes chaîne
    ``setattr("a.b.nom", …)`` / ``patch("a.b.nom", …)``."""
    vus: set[int] = set()
    for portee, alias in _portees(_arbre(chemin)):
        for appel in ast.walk(portee):
            if not isinstance(appel, ast.Call) or id(appel) in vus or not appel.args:
                continue
            fonction = _nom_pointe(appel.func) or ""
            dernier = fonction.split(".")[-1]
            if dernier not in ("setattr", "object", "patch"):
                continue
            premier = appel.args[0]
            if isinstance(premier, ast.Constant) and isinstance(premier.value, str):
                if dernier == "object" or "." not in premier.value:
                    continue
                module, _, nom = premier.value.rpartition(".")
                vus.add(id(appel))
                yield module, nom, appel
                continue
            if dernier == "patch" or len(appel.args) < 2:
                continue
            deuxieme = appel.args[1]
            if not (isinstance(deuxieme, ast.Constant) and isinstance(deuxieme.value, str)):
                continue
            module = _resoudre(premier, alias)
            if module is not None:
                vus.add(id(appel))
                yield module, deuxieme.value, appel


def _fichiers_de_tests() -> list[Path]:
    return sorted(p for p in DOSSIER_TESTS.rglob("*.py") if "__pycache__" not in p.parts)


def _lectures_a_l_execution(arbre: ast.Module) -> set[str]:
    """Noms lus dans un corps de fonction (lecture directe, ``global``, ou
    ``getattr(x, "nom")`` littéral). Les valeurs par défaut et les décorateurs
    des fonctions de premier niveau sont évalués à l'import : exclus."""
    lus: set[str] = set()

    def corps(f: ast.FunctionDef | ast.AsyncFunctionDef | ast.Lambda) -> list[ast.AST]:
        return [f.body] if isinstance(f, ast.Lambda) else list(f.body)

    fonctions = [n for n in ast.walk(arbre)
                 if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda))]
    for f in fonctions:
        for instruction in corps(f):
            for n in ast.walk(instruction):
                if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load):
                    lus.add(n.id)
                elif isinstance(n, ast.Global):
                    lus.update(n.names)
                elif (isinstance(n, ast.Call) and _nom_pointe(n.func) == "getattr"
                        and len(n.args) >= 2 and isinstance(n.args[1], ast.Constant)
                        and isinstance(n.args[1].value, str)):
                    lus.add(n.args[1].value)
    return lus


def _fichiers_de_production() -> list[Path]:
    return sorted(
        p for dossier in DOSSIERS_PRODUCTION for p in (RACINE / dossier).rglob("*.py")
        if "__pycache__" not in p.parts)


@lru_cache(maxsize=1)
def _imports_paresseux() -> frozenset[tuple[str, str]]:
    """(module, nom) importés DANS un corps de fonction du code de production
    (``from m import nom`` à l'appel) : ces lecteurs voient la substitution
    faite sur ``m``, comme une lecture du module lui-même."""
    couples: set[tuple[str, str]] = set()
    for chemin in _fichiers_de_production():
        for f in ast.walk(_arbre(chemin)):
            if not isinstance(f, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for n in ast.walk(f):
                if isinstance(n, ast.ImportFrom) and n.module and not n.level:
                    couples.update((n.module, a.name) for a in n.names)
    return frozenset(couples)


# ── 1 et 2 : substitutions effectives ────────────────────────────────────────

@lru_cache(maxsize=1)
def _substitutions_du_chantier() -> tuple[tuple[str, str, Path, ast.Call], ...]:
    trouvees = []
    for chemin in _fichiers_de_tests():
        for module, nom, appel in _substitutions(chemin):
            if module in MODULES_DU_CHANTIER:
                trouvees.append((module, nom, chemin, appel))
    return tuple(trouvees)


def test_l_analyse_voit_les_substitutions_connues():
    """Garde de la garde : si l'analyse ne voyait plus rien, les tests
    suivants passeraient à vide."""
    noms = {(m, n) for m, n, _, _ in _substitutions_du_chantier()}
    assert ("llm_core._chat_with_tools", "_llama_chat_with_tools_stream") in noms
    assert ("chatbot_app.turn.execution", "llama_chat_stream_tokens") in noms


@pytest.mark.parametrize("module", sorted(MODULES_DU_CHANTIER))
def test_chaque_nom_substitue_est_lu_par_le_module(module):
    lus = _lectures_a_l_execution(_arbre(_fichier_du_module(module)))
    lus |= {nom for m, nom in _imports_paresseux() if m == module}
    orphelins = sorted({
        f"{chemin.relative_to(RACINE)}:{appel.lineno} → {module}.{nom}"
        for m, nom, chemin, appel in _substitutions_du_chantier()
        if m == module and nom not in lus
    })
    assert not orphelins, (
        "substitutions sans effet (le module ne lit pas ce nom à l'exécution ; "
        "viser le module qui le lit) :\n  " + "\n  ".join(orphelins))


def test_raising_false_interdit_sur_les_modules_du_chantier():
    fautifs = sorted(
        f"{chemin.relative_to(RACINE)}:{appel.lineno} → {module}.{nom}"
        for module, nom, chemin, appel in _substitutions_du_chantier()
        if any(k.arg == "raising" and isinstance(k.value, ast.Constant) and k.value.value is False
               for k in appel.keywords)
    )
    assert not fautifs, "raising=False masquerait une cible disparue :\n  " + "\n  ".join(fautifs)


# ── 3 : seam de la boucle ────────────────────────────────────────────────────

def _references(arbre: ast.Module, noms: frozenset[str]) -> set[str]:
    trouves: set[str] = set()
    for n in ast.walk(arbre):
        if isinstance(n, ast.Name) and n.id in noms:
            trouves.add(n.id)
        elif isinstance(n, ast.Attribute) and n.attr in noms:
            trouves.add(n.attr)
        elif isinstance(n, ast.ImportFrom):
            trouves.update(a.name for a in n.names if a.name in noms)
    return trouves


def test_seam_de_la_boucle_reference_seulement_par_l_orchestrateur():
    orchestrateur = importlib.import_module(ORCHESTRATEUR)
    autorises = {_fichier_du_module(ORCHESTRATEUR).resolve()}
    for nom in SEAM_BOUCLE:
        definition = getattr(orchestrateur, nom).__module__
        autorises.add(_fichier_du_module(definition).resolve())
    fautifs = []
    for chemin in _fichiers_de_production():
        if chemin.resolve() in autorises:
            continue
        trouves = _references(_arbre(chemin), SEAM_BOUCLE)
        if trouves:
            fautifs.append(f"{chemin.relative_to(RACINE)} : {', '.join(sorted(trouves))}")
    assert not fautifs, (
        "ces modules référencent un nom du seam de la boucle au lieu de le "
        "recevoir de l'orchestrateur :\n  " + "\n  ".join(fautifs))


# ── 4 : façade llm_core ──────────────────────────────────────────────────────

def _noms_de_la_facade() -> list[str]:
    """Noms exposés par ``llm_core`` : tout sauf les dunders et les modules
    étrangers à ``llm_core`` importés par ses sous-modules (``json``,
    ``asyncio``…), surface accidentelle dont personne ne doit dépendre."""
    import llm_core
    noms = []
    for nom in dir(llm_core):
        if nom.startswith("__"):
            continue
        objet = getattr(llm_core, nom)
        if isinstance(objet, types.ModuleType) and not objet.__name__.startswith("llm_core"):
            continue
        noms.append(nom)
    return sorted(noms)


def test_instantane_de_la_facade_llm_core():
    noms = _noms_de_la_facade()
    if os.environ.get("ELPIS_FACADE_SNAPSHOT_UPDATE") == "1":
        INSTANTANE_FACADE.write_text(json.dumps(noms, indent=1, ensure_ascii=False) + "\n",
                                     encoding="utf-8")
    attendus = json.loads(INSTANTANE_FACADE.read_text(encoding="utf-8"))
    disparus = sorted(set(attendus) - set(noms))
    assert not disparus, "noms disparus de la façade llm_core :\n  " + "\n  ".join(disparus)


def test_la_facade_expose_les_objets_de_leur_module_proprietaire():
    import llm_core
    ecarts = []
    for nom in _noms_de_la_facade():
        objet = getattr(llm_core, nom)
        if not (inspect.isfunction(objet) or inspect.isclass(objet) or inspect.isbuiltin(objet)):
            continue
        module = getattr(objet, "__module__", None)
        try:
            proprietaire = importlib.import_module(module) if module else None
        except ImportError:
            proprietaire = None
        if proprietaire is None:
            ecarts.append(f"{nom} : module propriétaire {module!r} introuvable")
            continue
        if (getattr(proprietaire, getattr(objet, "__name__", ""), None) is not objet
                and getattr(proprietaire, nom, None) is not objet):
            ecarts.append(f"{nom} : n'est pas l'objet défini dans {module}")
    assert not ecarts, "\n  ".join(["façade incohérente :", *ecarts])


def test_les_modules_du_chantier_existent():
    for nom in MODULES_DU_CHANTIER | {ORCHESTRATEUR}:
        assert nom in sys.modules or importlib.util.find_spec(nom) is not None, nom
