# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_features_flag.py — feature flags globaux (toggle admin).

Couvre ``shared_infra.config.feature_enabled`` : défaut activé (rétro-compat d'une
config sans section ``features``) et désactivation explicite via config.json.
"""
from __future__ import annotations

import json


def test_feature_enabled_defaults_and_toggle(tmp_path, monkeypatch):
    import shared_infra.config as cfg
    p = tmp_path / "config.json"
    monkeypatch.setattr(cfg, "CONFIG_JSON_PATH", p)

    # Section absente → défaut True (rétro-compat : un ancien config.json = tout actif)
    p.write_text("{}", encoding="utf-8")
    assert cfg.feature_enabled("opencode") is True

    # Désactivation explicite → False ; les autres flags restent activés
    p.write_text(json.dumps({"features": {"opencode": False}}), encoding="utf-8")
    assert cfg.feature_enabled("opencode") is False
    assert cfg.feature_enabled("other") is True

    # Paramètre ``default`` respecté pour un flag absent
    assert cfg.feature_enabled("unknown", default=False) is False
    assert cfg.feature_enabled("unknown", default=True) is True

    # Lecture qui explose → repli sur ``default`` (jamais d'exception propagée).
    # On injecte sur ``config_view`` : c'est par là que passent tous les
    # lecteurs seuls depuis la mise en cache de config.json (``read_config_json``
    # ne sert plus qu'aux cycles lire-modifier-écrire, qui ont besoin d'une
    # copie mutable).
    def _boom():
        raise RuntimeError("disk")
    monkeypatch.setattr(cfg, "config_view", _boom)
    assert cfg.feature_enabled("opencode", default=True) is True
