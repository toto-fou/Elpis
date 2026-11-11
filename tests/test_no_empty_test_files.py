# SPDX-License-Identifier: MIT
"""tests/test_no_empty_test_files.py — garde anti-régression « filet désarmé ».

Le rollback du 2026-07-11 avait laissé ~180 fichiers de tests à 0 octet dans le
worktree : la suite « passait » en n'exécutant rien. Cette garde échoue si un
fichier de test (``test_*.py``) ou un harnais front (``*.mjs``) est vide —
un fichier vide ici n'est jamais intentionnel (les ``__init__.py``/conftest
vides restent permis).
"""
from __future__ import annotations

from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent


def test_aucun_fichier_de_test_vide():
    empty = [
        str(p.relative_to(TESTS_DIR))
        for pattern in ("test_*.py", "*.mjs")
        for p in TESTS_DIR.rglob(pattern)
        if p.is_file() and p.stat().st_size == 0
    ]
    assert not empty, (
        "Fichiers de test à 0 octet (filet désarmé — restaurer depuis git) : "
        + ", ".join(sorted(empty))
    )
