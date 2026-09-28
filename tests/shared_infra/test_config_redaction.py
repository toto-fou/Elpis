# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_config_redaction.py — les secrets ne sortent pas par /api/config.

``_redact_secrets`` vide une liste EXPLICITE de chemins avant que la config
d'instance ne parte vers un client. Sa première version ne savait traverser
qu'un seul niveau (``section.clé``) : les jetons des services vocaux, qui
vivent un cran plus bas (``voice.stt.token``), seraient partis en clair.

Deux propriétés à tenir ensemble : le secret disparaît de la COPIE, et la
source reste intacte — ces dicts viennent de ``read_config_json``, dont la vue
est mise en cache pour tout le process ; les muter contaminerait chaque lecteur.
"""
from __future__ import annotations

import pytest

from shared_infra.routes.config import _SECRET_PATHS, _redact_secrets


def _pose(chemin: str, valeur):
    """Construit le dict imbriqué que désigne un chemin pointé."""
    *parents, cle = chemin.split(".")
    racine: dict = {}
    noeud = racine
    for p in parents:
        noeud[p] = {}
        noeud = noeud[p]
    noeud[cle] = valeur
    return racine


def _lit(cfg: dict, chemin: str):
    noeud = cfg
    for p in chemin.split("."):
        noeud = noeud[p]
    return noeud


@pytest.mark.parametrize("chemin", _SECRET_PATHS)
def test_chaque_secret_declare_est_vide(chemin):
    cfg = _pose(chemin, "SECRET")
    assert _lit(_redact_secrets(cfg), chemin) == ""


@pytest.mark.parametrize("chemin", _SECRET_PATHS)
def test_la_source_n_est_jamais_mutee(chemin):
    """La vue de config est PARTAGÉE par tout le process."""
    cfg = _pose(chemin, "SECRET")
    _redact_secrets(cfg)
    assert _lit(cfg, chemin) == "SECRET"


def test_les_jetons_vocaux_sont_couverts():
    """Régression : ils sont imbriqués d'un niveau de plus que les autres."""
    assert "voice.stt.token" in _SECRET_PATHS
    assert "voice.tts.token" in _SECRET_PATHS
    cfg = {"voice": {"stt": {"token": "A", "endpoint_url": "http://h:8090"},
                     "tts": {"token": "B", "voice": "fr_FR-siwis-medium"}}}
    out = _redact_secrets(cfg)
    assert out["voice"]["stt"]["token"] == ""
    assert out["voice"]["tts"]["token"] == ""
    # Le reste de la branche survit : l'admin doit revoir ses adresses.
    assert out["voice"]["stt"]["endpoint_url"] == "http://h:8090"
    assert out["voice"]["tts"]["voice"] == "fr_FR-siwis-medium"


def test_la_cle_est_videe_jamais_supprimee():
    """Le front distingue « champ absent » de « champ non renseigné » : une clé
    qui disparaît ferait remonter le défaut du code au lieu de la valeur."""
    out = _redact_secrets({"rag": {"service_token": "x"}})
    assert "service_token" in out["rag"]


def test_chemin_absent_ou_mal_typé_ne_casse_rien():
    assert _redact_secrets({}) == {}
    assert _redact_secrets({"voice": "oui"})["voice"] == "oui"
    assert _redact_secrets({"voice": {"stt": None}})["voice"]["stt"] is None
    assert _redact_secrets("pas un dict") == "pas un dict"


def test_les_branches_non_touchees_sont_partagees():
    """Copie profonde des seules branches touchées — le reste est partagé, et
    c'est voulu : recopier 400 Ko à chaque lecture serait absurde."""
    autre = {"gros": list(range(10))}
    cfg = {"rag": {"service_token": "x"}, "autre": autre}
    assert _redact_secrets(cfg)["autre"] is autre


def test_secrets_2026_09_22_masques_en_gardant_le_type():
    """Audit 2026-09-22 (M6) : jetons MCP locaux et clé de chiffrement."""
    out = _redact_secrets({"app": {"encryption_key": "K"},
                           "mcp": {"local_token": "T", "local_client_tokens": {"tok": "alice"}}})
    assert out["app"]["encryption_key"] == ""
    assert out["mcp"]["local_token"] == "" and out["mcp"]["local_client_tokens"] == {}
