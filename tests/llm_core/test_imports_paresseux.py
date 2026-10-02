# SPDX-License-Identifier: MIT
"""tests/llm_core/test_imports_paresseux.py — les imports faits à l'appel
désignent toujours un nom qui existe.

Un import placé dans un corps de fonction (pour éviter un cycle ou un coût au
démarrage) n'est résolu qu'à l'exécution. Quand le nom importé change de
module, rien ne le signale à l'import de l'application ; et plusieurs de ces
imports sont entourés d'un ``try`` ou d'un ``swallow`` qui avalent
l'``ImportError`` : un résultat de sous-agent serait alors classé « succès »
(``task_tool._result_is_tool_failure_safe``), ou le budget de contexte du chat
sans outils silencieusement sauté (worker de ``chats``).

Ces tests lisent les cibles dans le code (AST), si bien qu'ils suivent les
déplacements au lieu de figer d'anciens chemins :
- tout ``from <module du projet> import <nom>`` fait dans une fonction du code
  de production se résout ;
- tout accès ``alias.attr`` d'un corps de fonction des modules découpés
  (``MODULES_DU_CHANTIER``), où ``alias`` désigne un module du projet
  (``_pruning.fit_context``, ``_model_info.get_model_context_size``…), vise
  un attribut qui existe : ces appels sont souvent sous ``try`` ou
  ``swallow``, qui avaleraient l'``AttributeError`` d'un renommage ;
- chaque registre de tâches de fond drainé à l'arrêt du serveur
  (``server/app.py``) existe ;
- les points dont l'échec serait avalé gardent leur comportement observable.
"""
from __future__ import annotations

import ast
import importlib
import importlib.util
from collections.abc import Iterable, Iterator
from functools import lru_cache
from pathlib import Path

from tests.llm_core.test_seams_effectifs import MODULES_DU_CHANTIER

RACINE = Path(__file__).resolve().parents[2]
PAQUETS_DU_PROJET = ("llm_core", "chatbot_app", "shared_infra", "server", "toolhost")


@lru_cache(maxsize=None)
def _arbre(chemin: Path) -> ast.Module:
    return ast.parse(chemin.read_text(encoding="utf-8"), filename=str(chemin))


@lru_cache(maxsize=1)
def _imports_paresseux() -> tuple[tuple[str, str, str, str, int], ...]:
    """(module importé, nom, fichier, fonction, ligne) pour chaque
    ``from <module du projet> import <nom>`` d'un corps de fonction."""
    trouves = []
    for paquet in PAQUETS_DU_PROJET:
        for chemin in sorted((RACINE / paquet).rglob("*.py")):
            if "__pycache__" in chemin.parts:
                continue
            for f in ast.walk(_arbre(chemin)):
                if not isinstance(f, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue
                for n in ast.walk(f):
                    if (isinstance(n, ast.ImportFrom) and n.module and not n.level
                            and n.module.split(".", 1)[0] in PAQUETS_DU_PROJET):
                        rel = str(chemin.relative_to(RACINE))
                        trouves.extend((n.module, a.name, rel, f.name, n.lineno) for a in n.names)
    return tuple(trouves)


def _defini_statiquement(module: str, nom: str) -> bool:
    """Le nom est-il lié au premier niveau du fichier du module (définition,
    affectation, import), ou est-ce un sous-module du paquet ?"""
    spec = importlib.util.find_spec(module)
    if spec is None:
        return False
    if spec.submodule_search_locations and importlib.util.find_spec(f"{module}.{nom}") is not None:
        return True
    if not spec.origin or not spec.origin.endswith(".py"):
        return False
    for haut in _arbre(Path(spec.origin)).body:
        for n in ast.walk(haut):
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and n.name == nom:
                return True
            if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store) and n.id == nom:
                return True
            if isinstance(n, ast.alias) and (n.asname or n.name.split(".", 1)[0]) == nom:
                return True
    return False


def _se_resout(module: str, nom: str) -> bool:
    if _defini_statiquement(module, nom):
        return True
    # Noms posés dynamiquement (façade ``llm_core``, paquets qui réexportent
    # par boucle) : seul l'import réel tranche.
    try:
        return hasattr(importlib.import_module(module), nom)
    except ImportError:
        return False


def test_l_analyse_voit_les_imports_paresseux():
    """Garde de la garde : si l'analyse ne voyait plus rien, le test suivant
    passerait à vide."""
    fichiers = {fichier for _, _, fichier, _, _ in _imports_paresseux()}
    assert len(_imports_paresseux()) > 100
    assert "llm_core/tools/task_tool.py" in fichiers
    assert any(f.startswith("chatbot_app/") for f in fichiers)


def test_tout_import_paresseux_du_projet_se_resout():
    introuvables = sorted({
        f"{fichier}:{ligne} ({fonction}) → from {module} import {nom}"
        for module, nom, fichier, fonction, ligne in _imports_paresseux()
        if not _se_resout(module, nom)
    })
    assert not introuvables, (
        "imports faits à l'appel qui échoueraient (nom déplacé ou renommé) :\n  "
        + "\n  ".join(introuvables))


_FONCTIONS = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)


def _hors_fonctions(noeud: ast.AST) -> Iterator[ast.AST]:
    """Les nœuds de ``noeud`` hors des corps de fonctions (portée du module)."""
    for enfant in ast.iter_child_nodes(noeud):
        if isinstance(enfant, _FONCTIONS):
            continue
        yield enfant
        yield from _hors_fonctions(enfant)


def _est_un_module(nom: str) -> bool:
    try:
        return importlib.util.find_spec(nom) is not None
    except (ImportError, ValueError):     # parent qui n'est pas un paquet
        return False


def _alias_de_modules(noeuds: Iterable[ast.AST]) -> dict[str, str]:
    """``alias → module du projet`` pour les imports parmi ``noeuds`` :
    ``import a.b as x`` et ``from a import b [as x]`` quand ``a.b`` est un
    module. (``import a.b`` sans alias lie ``a`` : non suivi.)"""
    alias: dict[str, str] = {}
    for n in noeuds:
        if isinstance(n, ast.Import):
            for a in n.names:
                if a.asname and a.name.split(".", 1)[0] in PAQUETS_DU_PROJET:
                    alias[a.asname] = a.name
        elif (isinstance(n, ast.ImportFrom) and n.module and not n.level
              and n.module.split(".", 1)[0] in PAQUETS_DU_PROJET):
            for a in n.names:
                if _est_un_module(f"{n.module}.{a.name}"):
                    alias[a.asname or a.name] = f"{n.module}.{a.name}"
    return alias


@lru_cache(maxsize=1)
def _acces_par_alias_de_module() -> tuple[tuple[str, str, str, str, int], ...]:
    """(module, attribut, fichier, fonction, ligne) pour chaque lecture
    ``alias.attr`` d'un corps de fonction des modules du chantier, où
    ``alias`` est un module du projet importé au niveau du module ou dans la
    fonction."""
    trouves: dict[tuple[str, str, str, int], str] = {}
    for module in sorted(MODULES_DU_CHANTIER):
        spec = importlib.util.find_spec(module)
        assert spec is not None and spec.origin, module
        chemin = Path(spec.origin)
        rel = str(chemin.relative_to(RACINE))
        arbre = _arbre(chemin)
        globaux = _alias_de_modules(_hors_fonctions(arbre))
        for f in ast.walk(arbre):
            if not isinstance(f, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            alias = {**globaux, **_alias_de_modules(ast.walk(f))}
            for n in ast.walk(f):
                if (isinstance(n, ast.Attribute) and isinstance(n.ctx, ast.Load)
                        and isinstance(n.value, ast.Name) and n.value.id in alias):
                    trouves.setdefault((alias[n.value.id], n.attr, rel, n.lineno), f.name)
    return tuple((m, a, fichier, fonction, ligne)
                 for (m, a, fichier, ligne), fonction in sorted(trouves.items()))


def test_l_analyse_voit_les_acces_par_alias_de_module():
    """Garde de la garde : des accès connus sont vus."""
    vus = {(m, a) for m, a, _, _, _ in _acces_par_alias_de_module()}
    assert {
        ("llm_core.context.pruning", "fit_context"),
        ("llm_core._model_info", "get_model_context_size"),
        ("shared_infra.observability.usage_ctx", "record_turn_usage"),
        ("llm_core._mcp_pool", "mcp_pool"),
    } <= vus


def test_tout_acces_par_alias_de_module_du_chantier_existe():
    introuvables = sorted({
        f"{fichier}:{ligne} ({fonction}) → {module}.{attribut}"
        for module, attribut, fichier, fonction, ligne in _acces_par_alias_de_module()
        if not _se_resout(module, attribut)
    })
    assert not introuvables, (
        "attributs de module lus à l'appel qui n'existent pas (nom déplacé ou "
        "renommé) :\n  " + "\n  ".join(introuvables))


def test_registres_de_taches_draines_a_l_arret_existent():
    """``server/app.py`` draine à l'arrêt les registres ``_BG_TASKS`` qu'il
    désigne par chaîne (module, attribut), sous un ``try`` : un chemin faux
    ne serait jamais drainé, sans erreur."""
    couples = []
    for n in ast.walk(_arbre(RACINE / "server" / "app.py")):
        if (isinstance(n, ast.Tuple) and len(n.elts) == 2
                and all(isinstance(e, ast.Constant) and isinstance(e.value, str) for e in n.elts)
                and n.elts[1].value == "_BG_TASKS"):
            couples.append((n.elts[0].value, n.elts[1].value))
    assert len(couples) >= 2, couples
    for module, attribut in couples:
        registre = getattr(importlib.import_module(module), attribut, None)
        assert isinstance(registre, set), f"{module}.{attribut} introuvable ou pas un ensemble"


def test_echec_de_sous_agent_toujours_classe_comme_echec():
    from llm_core.tools.task_tool import _result_is_tool_failure_safe

    assert _result_is_tool_failure_safe('{"error": "timeout"}') is True
    assert _result_is_tool_failure_safe('{"ok": true}') is False
    # Commande exécutée, code de sortie non nul : l'outil a fait son travail.
    assert _result_is_tool_failure_safe('{"ok": false, "returncode": 1, "stdout": ""}') is False


def test_nettoyage_json_du_parseur_d_appels():
    from llm_core import _tool_parsing

    assert _tool_parsing._clean_json_text('```json\n{"a": 1}\n```') == '{"a": 1}'
    assert _tool_parsing._clean_json_text('<tool_call>{"name": "x"}</tool_call>') == '{"name": "x"}'
