# SPDX-License-Identifier: MIT
"""tests/_sources.py — code des sujets découpés, pour les tests structurels.

Quelques invariants du harnais ne s'observent pas en comportement (« un seul
appel X », « jamais de Y », « tel appel prend un slot ») : on les vérifie sur
le code. Ce code change de fichier quand un module est découpé — la boucle
agentique part de ``llm_core/_chat_with_tools.py`` vers ``llm_core/engine/``,
le flux de chat de ``chatbot_app/routes/chats.py`` vers ``chat_*.py`` et
``chatbot_app/turn/``. Un test qui lit UN fichier ou UNE fonction devient
silencieux le jour où le code déménage : une assertion d'absence passe alors à
vide. Ces helpers rendent la réunion des fichiers d'un même sujet.

Commentaires et docstrings sont retirés : un test ne dépend jamais d'un texte
explicatif, réécrit librement. Les chaînes ordinaires (messages, types
d'événements, clés de dictionnaire) sont gardées. ``brut=True`` rend le texte
intégral ; aucun test ne l'utilise aujourd'hui, il sert au diagnostic.
"""
from __future__ import annotations

import ast
import io
import tokenize
from pathlib import Path
from typing import Dict, List, Tuple

RACINE = Path(__file__).resolve().parents[1]


def fichiers_boucle() -> List[Path]:
    """Orchestrateur, sous-routines ``llm_core/engine/*`` et parsing texte."""
    fichiers = [RACINE / "llm_core" / "_chat_with_tools.py"]
    fichiers += sorted((RACINE / "llm_core" / "engine").glob("*.py"))
    fichiers.append(RACINE / "llm_core" / "_tool_parsing.py")
    return [f for f in fichiers if f.is_file()]


def fichiers_flux_chat() -> List[Path]:
    """Route du tour, routes de contrôle et de compression, ``chatbot_app/turn``."""
    routes = RACINE / "chatbot_app" / "routes"
    fichiers = [routes / "chats.py"]
    fichiers += sorted(routes.glob("chat_*.py"))
    fichiers += sorted((RACINE / "chatbot_app" / "turn").glob("*.py"))
    return [f for f in fichiers if f.is_file()]


def _plages_docstrings(arbre: ast.AST, lignes: List[str]) -> List[Tuple[int, int, int, int]]:
    """(ligne, colonne, ligne de fin, colonne de fin) de chaque docstring, en
    caractères (``ast`` compte les colonnes en octets UTF-8)."""
    def car(ligne: int, octets: int) -> int:
        return len(lignes[ligne - 1].encode("utf-8")[:octets].decode("utf-8", "ignore"))

    plages = []
    for noeud in ast.walk(arbre):
        if not isinstance(noeud, (ast.Module, ast.ClassDef,
                                  ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        corps = noeud.body
        if (corps and isinstance(corps[0], ast.Expr)
                and isinstance(corps[0].value, ast.Constant)
                and isinstance(corps[0].value.value, str)):
            v = corps[0].value
            fin = v.end_lineno or v.lineno
            plages.append((v.lineno, car(v.lineno, v.col_offset),
                           fin, car(fin, v.end_col_offset or 0)))
    return plages


def code_seul(texte: str) -> str:
    """``texte`` sans commentaires ni docstrings, lignes et indentation
    conservées (une docstring retirée laisse ses lignes vides)."""
    # Découpe sur « \n » seul, comme tokenize/ast : ``splitlines`` couperait
    # aussi sur des séparateurs Unicode présents dans des chaînes.
    lignes = io.StringIO(texte).readlines()
    plages = _plages_docstrings(ast.parse(texte), lignes)
    for jeton in tokenize.generate_tokens(io.StringIO(texte).readline):
        if jeton.type == tokenize.COMMENT:
            (l0, c0), (l1, c1) = jeton.start, jeton.end
            plages.append((l0, c0, l1, c1))
    # Du bas vers le haut : retirer une plage ne décale pas les précédentes.
    for l0, c0, l1, c1 in sorted(plages, reverse=True):
        if l0 == l1:
            ligne = lignes[l0 - 1]
            lignes[l0 - 1] = ligne[:c0] + ligne[c1:]
        else:
            debut, fin = lignes[l0 - 1], lignes[l1 - 1]
            lignes[l0 - 1] = debut[:c0] + "\n"
            for i in range(l0, l1 - 1):
                lignes[i] = "\n"
            lignes[l1 - 1] = fin[c1:]
    return "".join(ligne.rstrip() + "\n" if ligne.endswith("\n") else ligne.rstrip()
                   for ligne in lignes)


def _lire(fichiers: List[Path], brut: bool) -> str:
    textes = [f.read_text(encoding="utf-8") for f in fichiers]
    if not brut:
        textes = [code_seul(t) for t in textes]
    return "\n\n".join(textes)


def source_boucle(brut: bool = False) -> str:
    """Code de la boucle agentique, tous fichiers confondus."""
    return _lire(fichiers_boucle(), brut)


def source_flux_chat(brut: bool = False) -> str:
    """Code du flux de chat (route du tour et ses modules), tous fichiers confondus."""
    return _lire(fichiers_flux_chat(), brut)


_SUJETS = {"boucle": fichiers_boucle, "flux_chat": fichiers_flux_chat}


def source_fonction(nom: str, sujet: str = "boucle") -> str:
    """Code (sans commentaires ni docstrings) de LA fonction ``nom`` du sujet,
    où qu'elle vive (fichier, classe ou fonction englobante). Échoue si le
    nom est absent ou ambigu : un test ne doit pas viser la mauvaise."""
    trouvees: Dict[str, str] = {}
    for f in _SUJETS[sujet]():
        texte = f.read_text(encoding="utf-8")
        code = io.StringIO(code_seul(texte)).readlines()
        for noeud in ast.walk(ast.parse(texte)):
            if (isinstance(noeud, (ast.FunctionDef, ast.AsyncFunctionDef))
                    and noeud.name == nom):
                debut = min([d.lineno for d in noeud.decorator_list] + [noeud.lineno])
                cle = f"{f.relative_to(RACINE)}:{noeud.lineno}"
                trouvees[cle] = "".join(code[debut - 1:noeud.end_lineno])
    assert len(trouvees) == 1, f"fonction {nom!r} ({sujet}) : {sorted(trouvees) or 'absente'}"
    return next(iter(trouvees.values()))


def compter_appels(nom: str, sujet: str = "boucle") -> int:
    """Nombre d'appels à ``nom`` (fonction ``nom(...)`` ou attribut
    ``x.nom(...)``) dans le sujet : un compte d'appels, insensible à la mise
    en forme et aux commentaires."""
    total = 0
    for f in _SUJETS[sujet]():
        for noeud in ast.walk(ast.parse(f.read_text(encoding="utf-8"))):
            if isinstance(noeud, ast.Call):
                fn = noeud.func
                if (isinstance(fn, ast.Name) and fn.id == nom) or (
                        isinstance(fn, ast.Attribute) and fn.attr == nom):
                    total += 1
    return total
