# SPDX-License-Identifier: MIT
"""``APP_MODE`` absent ou invalide vaut ``main`` : la console d'admin n'est
plus montée sur le port public par oubli de variable (avant : ``full``)."""
import pytest

from server.app import _resolve_app_mode


@pytest.mark.parametrize("brut", [None, "", "   ", "inconnu", "fulll"])
def test_absent_ou_invalide_vaut_main(brut):
    assert _resolve_app_mode(brut) == "main"


@pytest.mark.parametrize("brut, attendu", [
    ("main", "main"), ("admin", "admin"), ("full", "full"),
    ("FULL", "full"), (" Admin ", "admin"),
])
def test_modes_explicites_respectes(brut, attendu):
    assert _resolve_app_mode(brut) == attendu
