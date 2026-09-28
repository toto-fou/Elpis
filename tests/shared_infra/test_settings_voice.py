# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_settings_voice.py — les trois réglages vocaux existent VRAIMENT.

Une clé absente de ``_USER_SETTINGS_ALLOWED`` est filtrée **en silence** au PUT :
l'interface coche la case, le toast dit « enregistré », et rien n'est écrit. Un
défaut absent de ``api_get_settings`` laisse, lui, la valeur affichée dépendre de
qui du GET ou du PUT a peuplé la ligne en premier.

Ce test transforme ces deux oublis en échec.
"""
from __future__ import annotations

import inspect
import re

import pytest

from shared_infra.accounts import routes_settings

CLES = ("voice_input_enabled", "voice_reply_enabled", "voice_reply_tools_enabled")


@pytest.mark.parametrize("cle", CLES)
def test_la_cle_est_allowlistee(cle):
    assert cle in routes_settings._USER_SETTINGS_ALLOWED, (
        f"« {cle} » serait filtrée en silence au PUT /api/settings"
    )


@pytest.mark.parametrize("cle", CLES)
def test_le_defaut_est_servi_par_le_get(cle):
    source = inspect.getsource(routes_settings.api_get_settings)
    assert f'"{cle}": False' in source, (
        f"« {cle} » n'a pas de défaut : la valeur affichée dépendrait de "
        f"l'ordre GET/PUT"
    )


@pytest.mark.parametrize("cle", CLES)
def test_la_valeur_est_coercee_en_booleen(cle):
    """Sans coercition, un « on » de formulaire serait stocké comme chaîne et
    tout `if settings[...]` deviendrait vrai, y compris pour « false »."""
    source = inspect.getsource(routes_settings.api_put_settings)
    bloc = re.search(r"for _cle_voix in \(([^)]*)\)", source, re.S)
    assert bloc and f'"{cle}"' in bloc.group(1), f"« {cle} » n'est pas coercée"


def test_le_front_miroite_les_memes_defauts():
    """Les défauts client doivent être identiques : c'est écrit noir sur blanc
    dans ``loadSettingsData`` (« defaults match the backend »)."""
    import pathlib
    js = pathlib.Path("frontend/js/app-settings.js").read_text(encoding="utf-8")
    for cle in CLES:
        assert f"data.{cle} === undefined) data.{cle} = false" in js, (
            f"« {cle} » n'a pas son défaut miroir côté front"
        )
