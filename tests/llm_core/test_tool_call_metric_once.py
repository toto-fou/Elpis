# SPDX-License-Identifier: MIT
"""Un appel d'outil = UNE ligne ``tool_call``, écrite à l'exécution.

Le harnais journalisait la métrique DEUX fois : une fois à la préparation du
lot (``_chat_with_tools``, canal natif ET canal legacy) et une fois à
l'exécution (``engine/tool_exec``, enrichie du ``status``). Le KPI « Appels
outils / 24 h » compte les lignes sans filtrer : il affichait donc jusqu'au
double du réel. Mesuré sur la base de dev avant correctif : 14 957 lignes
portant un ``status`` contre 12 371 sans.
"""
import ast
import pathlib

import pytest

HARNESS = pathlib.Path("llm_core/_chat_with_tools.py")
TOOL_EXEC = pathlib.Path("llm_core/engine/tool_exec.py")


def _tool_call_metric_lines(path: pathlib.Path):
    """Lignes appelant ``log_metric("tool_call", …)`` dans le fichier."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    out = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        fn = getattr(node.func, "id", None) or getattr(node.func, "attr", None)
        if fn != "log_metric" or not node.args:
            continue
        first = node.args[0]
        if isinstance(first, ast.Constant) and first.value == "tool_call":
            out.append(node.lineno)
    return out


def test_le_harnais_ne_compte_plus_a_la_preparation():
    """La préparation d'un lot ne doit RIEN compter : rien n'a encore tourné."""
    assert _tool_call_metric_lines(HARNESS) == [], (
        "log_metric('tool_call') est réapparu dans _chat_with_tools : "
        "la métrique appartient à l'exécution (engine/tool_exec), sinon "
        "chaque appel est compté deux fois."
    )


def test_l_execution_reste_le_seul_point_de_comptage():
    assert len(_tool_call_metric_lines(TOOL_EXEC)) == 1


def test_la_ligne_ecrite_porte_bien_le_status():
    """C'est ce qui rend la ligne d'exécution strictement plus riche.

    ``ToolErrorRateProvider`` (metrics/_v17_providers) en dépend : sans
    ``status``, une ligne dilue le taux d'erreur au lieu de l'alimenter.
    """
    src = TOOL_EXEC.read_text(encoding="utf-8")
    tree = ast.parse(src)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        fn = getattr(node.func, "id", None) or getattr(node.func, "attr", None)
        if fn != "log_metric" or not node.args:
            continue
        if isinstance(node.args[0], ast.Constant) and node.args[0].value == "tool_call":
            tags = ast.unparse(node.args[2])
            assert "status" in tags and "tool" in tags
            return
    pytest.fail("log_metric('tool_call') introuvable dans engine/tool_exec")
