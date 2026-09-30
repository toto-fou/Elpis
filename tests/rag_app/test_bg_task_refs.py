# SPDX-License-Identifier: MIT
"""Tâches de fond de ``rag_app`` — référence forte obligatoire.

``asyncio.create_task`` ne laisse qu'une référence faible à la boucle. Sans
référence forte, le ramasse-miettes peut détruire la tâche avant qu'elle
n'aboutisse. Deux sites y étaient exposés, dont ``/api/restart`` : l'API
répondait « Le serveur redémarre… » alors que le redémarrage pouvait ne jamais
avoir lieu.
"""
import ast
import asyncio
import gc
import pathlib

import pytest

APP = pathlib.Path("rag_app/app.py")


def test_aucun_create_task_nu_ne_subsiste():
    """Toute tâche de fond doit passer par ``_spawn``."""
    tree = ast.parse(APP.read_text(encoding="utf-8"))
    nus = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        f = node.func
        if getattr(f, "attr", None) != "create_task":
            continue
        # Le seul appel légitime est celui encapsulé DANS _spawn.
        nus.append(node.lineno)
    assert len(nus) == 1, (
        f"create_task nu détecté ligne(s) {nus} — passer par _spawn(), "
        "sinon la tâche peut être ramassée en plein vol."
    )


def test_spawn_est_bien_le_seul_encapsulateur():
    tree = ast.parse(APP.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == "_spawn":
            src = ast.unparse(node)
            assert "add_done_callback" in src, \
                "sans done_callback, le registre fuirait à chaque tâche"
            assert "create_task" in src
            return
    pytest.fail("_spawn introuvable dans rag_app/app.py")


@pytest.mark.asyncio
async def test_la_tache_survit_a_un_ramasse_miettes():
    """Le comportement, pas seulement la forme."""
    import importlib
    mod = importlib.import_module("rag_app.app")

    fini = []

    async def lente():
        await asyncio.sleep(0.05)
        fini.append(True)

    mod._spawn(lente())
    gc.collect()                 # le moment où une tâche non référencée meurt
    await asyncio.sleep(0.2)
    assert fini == [True]


@pytest.mark.asyncio
async def test_le_registre_se_vide_a_la_fin():
    """Une tâche terminée ne doit pas rester accrochée au registre."""
    import importlib
    mod = importlib.import_module("rag_app.app")

    async def courte():
        return None

    avant = len(mod._bg_tasks)
    t = mod._spawn(courte())
    await t
    await asyncio.sleep(0)       # laisse tourner le done_callback
    assert len(mod._bg_tasks) == avant
