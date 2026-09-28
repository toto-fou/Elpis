# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_public_config_voice.py — les drapeaux vocaux du front.

Le front n'a pas à relire ``config.json`` ni à deviner qu'une adresse vide veut
dire « coupé ». ``/api/public-config`` tranche, et les drapeaux sont en défaut
OFF STRICT : contrairement aux autres features, une fonction qui ouvre le micro
ou sort du son ne s'allume pas par rétro-compatibilité.

Deux drapeaux et non un : reconnaissance et synthèse vivent sur deux services
distincts, l'un peut être configuré sans l'autre.
"""
from __future__ import annotations

import json
import pathlib

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    import shared_infra.config as cfg_mod

    chemin = tmp_path / "config.json"
    chemin.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(cfg_mod, "CONFIG_JSON_PATH", chemin)
    cfg_mod.invalidate_config_cache()

    def ecrit(bloc):
        chemin.write_text(json.dumps({"voice": bloc} if bloc is not None else {}),
                          encoding="utf-8")
        cfg_mod.invalidate_config_cache()

    import shared_infra.routes.system  # noqa: F401 — enregistre la route
    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app), ecrit


def drapeaux(client):
    c, _ = client
    features = c.get("/api/public-config").json()["features"]
    return features["voice_stt"], features["voice_tts"]


def test_absent_de_la_config_vaut_eteint(client):
    _, ecrit = client
    ecrit(None)
    assert drapeaux(client) == (False, False)


def test_active_sans_adresse_vaut_eteint(client):
    """Le piège exact du bloc ``transcription`` retiré : ``enabled: true`` et
    une adresse qui ne répond plus."""
    _, ecrit = client
    ecrit({"enabled": True, "stt": {"endpoint_url": ""}, "tts": {"endpoint_url": ""}})
    assert drapeaux(client) == (False, False)


def test_adresse_sans_activation_vaut_eteint(client):
    _, ecrit = client
    ecrit({"enabled": False, "stt": {"endpoint_url": "http://s:8090"},
           "tts": {"endpoint_url": "http://t:8091"}})
    assert drapeaux(client) == (False, False)


def test_les_deux_services_sont_independants(client):
    _, ecrit = client
    ecrit({"enabled": True, "stt": {"endpoint_url": "http://s:8090"}, "tts": {}})
    assert drapeaux(client) == (True, False)
    ecrit({"enabled": True, "stt": {}, "tts": {"endpoint_url": "http://t:8091"}})
    assert drapeaux(client) == (False, True)


def test_complet(client):
    _, ecrit = client
    ecrit({"enabled": True, "stt": {"endpoint_url": "http://s:8090"},
           "tts": {"endpoint_url": "http://t:8091"}})
    assert drapeaux(client) == (True, True)


def test_le_cablage_reste_dans_public_config():
    """Régression de câblage, sur le modèle de ``test_settings_agents.py`` :
    un drapeau retiré du payload se verrait ici, pas à l'exécution."""
    source = pathlib.Path("shared_infra/routes/system.py").read_text(encoding="utf-8")
    assert '"voice_stt": _voice_stt,' in source
    assert '"voice_tts": _voice_tts,' in source
