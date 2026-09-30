# SPDX-License-Identifier: MIT
"""Retours de la recette du 2026-09-30 : l'accueil retombe sur le logo Elpis
quand la section ``welcome`` de la configuration est partielle (mascottes
coupées) ou absente."""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.mark.parametrize("welcome,image", [
    ({"type": "image", "scene": {"mascottes_on": False}}, "static/elpis-256.png"),   # section partielle
    (None, "static/elpis-256.png"),                                                 # section absente
    ({"type": "icon", "icon": "ph-robot"}, "static/elpis-256.png"),                 # l'icône choisie reste
])
def test_accueil_retombe_sur_le_logo_elpis(monkeypatch, welcome, image):
    import shared_infra.routes.system as S
    cfg = {} if welcome is None else {"welcome": welcome}
    monkeypatch.setattr(S, "config_view", lambda: cfg)
    monkeypatch.setattr(S, "_welcome_image_parts", lambda: None)
    app = FastAPI()
    app.include_router(S.router)
    w = TestClient(app).get("/api/public-config").json()["welcome"]
    assert w["image_b64"] == image
    if welcome and welcome.get("type") == "icon":
        assert w["type"] == "icon" and w["icon"] == "ph-robot"
    else:
        assert w["type"] == "image"
    if welcome is not None:
        assert "image_b64" not in welcome            # le cache de config n'est pas muté
