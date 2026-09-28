# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_live_config_value.py

Les réglages admin étaient appliqués en mutant une constante module-level
(``config.LLM_SCHEDULING_MODE``) EN PLUS d'écrire ``config.json``. Avec
``workers = cpu - 1`` (gunicorn), seule la mémoire du worker ayant reçu le POST
changeait : le comportement alternait d'une requête à l'autre, et le GET
renvoyait tantôt l'ancienne valeur tantôt la nouvelle.

La source de vérité doit être le FICHIER — partagé par tous les workers.
Régression du finding E6 de l'audit 2026-08-01.
"""
from __future__ import annotations

import json

import pytest


@pytest.fixture()
def cfg_file(tmp_path, monkeypatch):
    import shared_infra.config as cfg

    path = tmp_path / "config.json"
    path.write_text(json.dumps({"llm": {"scheduling_mode": "classic"}}),
                    encoding="utf-8")
    monkeypatch.setattr(cfg, "CONFIG_JSON_PATH", path)
    return path, cfg


def test_lit_la_valeur_sur_disque(cfg_file):
    path, cfg = cfg_file
    assert cfg.live_config_value("llm.scheduling_mode") == "classic"


def test_voit_une_ecriture_faite_par_un_autre_worker(cfg_file):
    """Le scénario multi-worker : un AUTRE process écrit config.json ; ce
    process-ci doit voir la nouvelle valeur sans avoir muté sa constante."""
    path, cfg = cfg_file
    path.write_text(json.dumps({"llm": {"scheduling_mode": "optimized"}}),
                    encoding="utf-8")
    assert cfg.live_config_value("llm.scheduling_mode") == "optimized", (
        "la valeur reste celle de l'import : les autres workers n'appliquent "
        "jamais le réglage admin"
    )


def test_defaut_si_cle_absente(cfg_file):
    path, cfg = cfg_file
    path.write_text(json.dumps({"llm": {}}), encoding="utf-8")
    assert cfg.live_config_value("llm.scheduling_mode", "auto") == "auto"
    assert cfg.live_config_value("rien.du.tout", 42) == 42


def test_chemin_traversant_un_non_dict(cfg_file):
    path, cfg = cfg_file
    path.write_text(json.dumps({"llm": "pas-un-dict"}), encoding="utf-8")
    assert cfg.live_config_value("llm.scheduling_mode", "auto") == "auto"


def test_fichier_illisible_retourne_le_defaut(cfg_file):
    path, cfg = cfg_file
    path.write_text("{ceci n'est pas du JSON", encoding="utf-8")
    assert cfg.live_config_value("llm.scheduling_mode", "auto") == "auto"
