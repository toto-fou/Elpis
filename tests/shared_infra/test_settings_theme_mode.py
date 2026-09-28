# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_settings_theme_mode.py — le mode « Système » existe VRAIMENT.

Refonte de la console admin (2026-09-27) : le mode sombre devient un choix à
trois positions, Système · Clair · Sombre, dans Paramètres › Apparence ET dans
le menu « Compte et apparence » de la console. « Système » est porté par une
clé à part, ``dark_mode_auto`` (``dark_mode`` garde son sens de choix
explicite, il est simplement ignoré tant que le mode suit le système).

Une clé absente de ``_USER_SETTINGS_ALLOWED`` serait filtrée EN SILENCE au
PUT : le menu cocherait « Système », le toast dirait « enregistré », et le
rechargement suivant repartirait sur Clair. Même garde que les réglages
vocaux (tests/shared_infra/test_settings_voice.py).
"""
from __future__ import annotations

import inspect
import pathlib

from shared_infra.accounts import routes_settings


def test_la_cle_est_allowlistee():
    assert "dark_mode_auto" in routes_settings._USER_SETTINGS_ALLOWED


def test_le_defaut_est_servi_par_le_get():
    source = inspect.getsource(routes_settings.api_get_settings)
    assert '"dark_mode_auto": False' in source


def test_la_valeur_est_coercee_en_booleen():
    """Un « true » de formulaire stocké en chaîne rendrait vrai aussi « false »."""
    source = inspect.getsource(routes_settings.api_put_settings)
    assert 'data["dark_mode_auto"] = bool(data["dark_mode_auto"])' in source


def test_le_front_miroite_le_defaut_et_suit_le_systeme():
    js = pathlib.Path("frontend/js/app-settings.js").read_text(encoding="utf-8")
    assert "data.dark_mode_auto === undefined) data.dark_mode_auto = false" in js
    # Le mode effectif lit la préférence de l'OS quand « Système » est choisi.
    assert "prefers-color-scheme: dark" in js
    assert "s.dark_mode_auto ? _prefersDark.value : !!s.dark_mode" in js
