# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_public_url_https.py — synthèse d'URLs publiques en mode HTTPS.

Quand ``security.https.enabled`` est actif (frontal Caddy 443/8443), les URLs
main↔admin synthétisées par ``shared_infra.routes.system`` doivent :
  - pointer vers les ports du frontal (443 implicite pour main, admin_port
    explicite) quel que soit le port entrant ;
  - PRIMER sur les env ``MAIN_PUBLIC_URL``/``ADMIN_PUBLIC_URL`` héritées des
    scripts de lancement (http://localhost:800x → binds devenus loopback) ;
  - laisser les heuristiques historiques 8001↔8002 intactes quand le mode est
    coupé.
"""
from __future__ import annotations

import json

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient


@pytest.fixture()
def probe(tmp_path, monkeypatch):
    """Client + config tmp ; renvoie (client, set_https) où set_https écrit la
    section security.https voulue dans le config.json monkeypatché."""
    import shared_infra.config as cfg
    import shared_infra.routes.system as sysmod

    p = tmp_path / "config.json"
    p.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(cfg, "CONFIG_JSON_PATH", p)

    app = FastAPI()

    @app.get("/probe")
    def _probe(request: Request, kind: str = "admin", env_url: str = "",
               app_mode: str = "admin"):
        return {
            "synth":    sysmod._synthesize_public_url(request, kind),
            "resolved": sysmod._resolve_public_url(env_url, request, kind, app_mode),
        }

    def set_https(section):
        p.write_text(json.dumps({"security": {"https": section}}), encoding="utf-8")

    return TestClient(app), set_https


def test_https_synthesis_is_port_agnostic(probe):
    client, set_https = probe
    set_https({"enabled": True})

    # Peu importe le port entrant (ici l'ancien port direct 8002) : les URLs
    # ciblent le frontal Caddy.
    r = client.get("/probe", params={"kind": "main"},
                   headers={"Host": "10.168.1.50:8002"}).json()
    assert r["synth"] == "https://10.168.1.50/"

    r = client.get("/probe", params={"kind": "admin"},
                   headers={"Host": "10.168.1.50"}).json()
    assert r["synth"] == "https://10.168.1.50:8443/admin"


def test_https_synthesis_honors_custom_ports(probe):
    client, set_https = probe
    set_https({"enabled": True, "main_port": 9443, "admin_port": 9444})

    r = client.get("/probe", params={"kind": "main"},
                   headers={"Host": "elpis.lan"}).json()
    assert r["synth"] == "https://elpis.lan:9443/"
    r = client.get("/probe", params={"kind": "admin"},
                   headers={"Host": "elpis.lan"}).json()
    assert r["synth"] == "https://elpis.lan:9444/admin"


def test_https_resolution_bypasses_stale_env_urls(probe):
    """ADMIN_PUBLIC_URL=http://localhost:8002/admin (défaut ./elpis start)
    donnerait, réécrite, http://IP:8002/admin — port devenu loopback ET mauvais
    schéma. En mode HTTPS la synthèse prime sur l'env."""
    client, set_https = probe
    set_https({"enabled": True})

    r = client.get("/probe", params={
        "kind": "admin", "env_url": "http://localhost:8002/admin",
        "app_mode": "main",
    }, headers={"Host": "10.168.1.50", "X-Forwarded-Proto": "https"}).json()
    assert r["resolved"] == "https://10.168.1.50:8443/admin"

    r = client.get("/probe", params={
        "kind": "main", "env_url": "http://localhost:8001/",
        "app_mode": "admin",
    }, headers={"Host": "10.168.1.50:8443", "X-Forwarded-Proto": "https"}).json()
    assert r["resolved"] == "https://10.168.1.50/"


def test_http_mode_keeps_legacy_pair_heuristics(probe):
    """Toggle coupé → comportement historique intact (paire 8001↔8002)."""
    client, set_https = probe
    set_https({"enabled": False})

    r = client.get("/probe", params={"kind": "admin"},
                   headers={"Host": "10.168.1.50:8001"}).json()
    assert r["synth"] == "http://10.168.1.50:8002/admin"

    r = client.get("/probe", params={"kind": "main"},
                   headers={"Host": "10.168.1.50:8002"}).json()
    assert r["synth"] == "http://10.168.1.50:8001/"

    # Et l'env URL réécrite reste prioritaire sur la synthèse.
    r = client.get("/probe", params={
        "kind": "admin", "env_url": "http://localhost:8002/admin",
        "app_mode": "main",
    }, headers={"Host": "10.168.1.50:8001"}).json()
    assert r["resolved"] == "http://10.168.1.50:8002/admin"
