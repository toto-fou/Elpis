# SPDX-License-Identifier: MIT
"""Tests de non-régression de la sandbox (upload chunké, wrapper exec).

Indépendants du conftest agentic (pas d_async, pas de DB) : ils valident les
scripts shell exacts exécutés via docker exec et la logique de découpage.
"""
