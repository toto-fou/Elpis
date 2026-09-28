# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_restart_pending.py — « Redémarrage nécessaire ».

Console admin, lot 6 (2026-09-27). La plupart des réglages de config.json
sont lus UNE fois, à l'import de ``shared_infra.config`` ; les écrire depuis la
console ne change rien avant un redémarrage. Invariants posés ici :

  - l'inventaire est AUTOMATIQUE (lectures de ``_RAW`` pendant l'import) et
    exclut ce qui est relu à chaud (vision, compression, mémoire, rapport
    quotidien automatique…) ;
  - l'empreinte de démarrage ne contient AUCUNE valeur (config.json porte des
    secrets), seulement des condensés ;
  - un worker recyclé de la même génération ne réécrit pas l'empreinte ; une
    génération nouvelle, ou une empreinte invalidée, la réécrit ;
  - seul un chemin « au démarrage » modifié depuis est annoncé.
"""
from __future__ import annotations

import copy
import json
import os

import pytest

from shared_infra import config as _cfg
from shared_infra.ops import restart_pending as rp


def test_inventaire_automatique_et_sans_rechargement_a_chaud():
    paths = set(rp.restart_paths())
    # Lus à l'import de shared_infra.config :
    for p in ("llama.ip", "llama.port", "llama.max_models", "maintenance.hour",
              "maintenance.metrics_retention_days", "mcp.local_port"):
        assert p in paths, p
    # Lus au démarrage ailleurs (middleware de session) :
    assert "security.session.same_site" in paths
    assert "security.session.cookie_name" in paths
    # Relus à chaud : jamais « redémarrage nécessaire ».
    for p in paths:
        assert not p.startswith(("vision.", "desktop.", "llm.compression.",
                                 "llm.compaction.", "llm.prune.", "memory.")), p
    for p in ("llm.scheduling_mode", "app.max_recent_chats",
              "maintenance.daily_digest_enabled"):
        assert p not in paths
    # L'enregistrement s'arrête avec l'import : une lecture ultérieure de _RAW
    # n'entre plus dans l'inventaire.
    _cfg._deep_get(_cfg._RAW, "zz.lecture_tardive", None)
    assert "zz.lecture_tardive" not in _cfg.BOOT_READ_PATHS


@pytest.fixture()
def boot(monkeypatch):
    raw = {"llama": {"ip": "10.0.0.5", "port": "8080"},
           "maintenance": {"hour": 6, "daily_digest_enabled": True},
           "vision": {"endpoint_url": ""},
           "app": {"session_secret": "SECRET-A-NE-PAS-ECRIRE"}}
    monkeypatch.setattr(_cfg, "_RAW", raw)
    monkeypatch.setattr(rp, "_generation", lambda: "g1")
    rp.invalidate()
    yield raw
    rp.invalidate()


def test_empreinte_sans_valeur_et_detection(boot):
    rp.record("main")
    blob = open(rp._snapshot_path(), encoding="utf-8").read()
    assert "SECRET-A-NE-PAS-ECRIRE" not in blob and "10.0.0.5" not in blob
    assert json.loads(blob)["generation"] == "g1"

    same = copy.deepcopy(boot)
    assert rp.pending(same) == []

    changed = copy.deepcopy(boot)
    changed["llama"]["ip"] = "10.0.0.9"                 # lu au démarrage
    changed["maintenance"]["daily_digest_enabled"] = False  # relu à chaud
    changed["vision"]["endpoint_url"] = "http://x:1"        # relu à chaud
    assert rp.pending(changed) == ["llama.ip"]

    # Un chemin AJOUTÉ au fichier compte aussi (absent au démarrage).
    added = copy.deepcopy(boot)
    added["maintenance"]["metrics_retention_days"] = 30
    assert "maintenance.metrics_retention_days" in rp.pending(added)


def test_generation_recyclage_et_invalidation(boot, monkeypatch):
    rp.record("main")
    first = json.load(open(rp._snapshot_path(), encoding="utf-8"))

    # Worker recyclé (même maître) après une modification : il a relu le
    # fichier, mais ses frères tournent encore sur l'ancienne valeur — on ne
    # touche pas à l'empreinte.
    boot["llama"]["ip"] = "10.0.0.9"
    rp.record("main")
    assert json.load(open(rp._snapshot_path(), encoding="utf-8")) == first

    # Redémarrage demandé : invalidation, puis la génération suivante écrit.
    rp.invalidate()
    assert not os.path.exists(rp._snapshot_path())
    rp.record("main")
    assert rp.pending(copy.deepcopy(boot)) == []

    # Démarrage à froid (maître différent) : réécrit même sans invalidation.
    monkeypatch.setattr(rp, "_generation", lambda: "g2")
    boot["llama"]["port"] = "9090"
    rp.record("main")
    assert json.load(open(rp._snapshot_path(), encoding="utf-8"))["generation"] == "g2"
    assert rp.pending(copy.deepcopy(boot)) == []


def test_sans_empreinte_reference_du_process(boot):
    # Process principal antérieur à cette fonction : pas de fichier → la
    # lecture de démarrage de CE process sert de référence.
    changed = copy.deepcopy(boot)
    changed["llama"]["port"] = "9999"
    assert rp.pending(changed) == ["llama.port"]


def test_empreinte_exclue_des_sauvegardes():
    from shared_infra.routes import _helpers
    assert ".config_boot.json" in _helpers._HOST_ONLY
