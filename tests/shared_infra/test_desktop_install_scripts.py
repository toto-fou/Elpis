# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_desktop_install_scripts.py — installeurs desktop-agent.

Couvre le rendu des one-liners (/api/desktop/install.sh|ps1) : URL LAN bakée,
gestion de l'app derrière le frontal HTTPS Caddy (cert LAN auto-signé), et la
contrainte ASCII du script PowerShell (PS 5.1 lit les fichiers sans BOM en
ANSI — un accent mal décodé casse le parsing).
"""
from __future__ import annotations

import shutil
import subprocess

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture()
def desktop_client():
    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_install_sh_https_ca_pinning_then_insecure_fallback(desktop_client):
    sh = desktop_client.get("/api/desktop/install.sh",
                            headers={"host": "10.0.0.5:8443"}).text
    assert 'BASE="http://10.0.0.5:8443"' in sh          # URL LAN réellement contactée
    # probe direct → CA locale (Caddy :80) épinglée → repli -k explicite
    assert "/ca.crt" in sh and "--cacert" in sh and 'CURL_TLS="-k"' in sh
    assert "/api/desktop/agent-bundle" in sh


def test_install_sh_is_valid_bash(desktop_client, tmp_path):
    sh = desktop_client.get("/api/desktop/install.sh").text
    p = tmp_path / "install.sh"
    p.write_text(sh, encoding="utf-8")
    subprocess.run(["bash", "-n", str(p)], check=True, capture_output=True)


def test_install_ps1_ascii_and_tls(desktop_client):
    ps1 = desktop_client.get("/api/desktop/install.ps1",
                             headers={"host": "10.0.0.5:8443"}).text
    # contrainte historique : 100 % ASCII (PS 5.1 sans BOM = ANSI)
    bad = sorted({c for c in ps1 if ord(c) > 127})
    assert not bad, f"caractères non-ASCII dans install.ps1 : {bad!r}"
    # bypass cert PS7/PS5.1 + TLS 1.2 forcé AVANT le probe (PS 5.1 : .NET
    # Framework peut démarrer sans TLS 1.2 alors que Caddy exige ≥ 1.2 —
    # « The underlying connection was closed » sinon)
    assert "SkipCertificateCheck" in ps1
    assert "SecurityProtocol" in ps1 and "3072" in ps1
    # PS 5.1 : bypass cert par callback C# COMPILÉ (Add-Type) — un scriptblock
    # { $true } peut être invoqué hors runspace et avorter le handshake ; on
    # vérifie aussi que le C# rend des accolades SIMPLES (f-string doublées)
    assert "ElpisTrustAll" in ps1 and "Add-Type" in ps1
    assert "= { $true }" not in ps1
    assert "public class ElpisTrustAll{public static void Go()" in ps1
    assert "delegate{return true;};}}" in ps1
    assert "$Base = 'http://10.0.0.5:8443'" in ps1


# ── Amorçage EN CLAIR : alias courts servis aussi en http par Caddy :80 ──────
# La VM cible ne connaît pas la CA locale au moment du one-liner : passer par
# http supprime tout contournement TLS de la COMMANDE (préambule PowerShell de
# ~400 caractères, cassant selon la version de .NET).

def test_short_aliases_serve_the_installers(desktop_client):
    for short, long in (("/agent", "/api/desktop/install.sh"),
                        ("/agent.ps1", "/api/desktop/install.ps1")):
        a = desktop_client.get(short)
        b = desktop_client.get(long)
        assert a.status_code == 200
        assert a.text == b.text


def test_short_aliases_bake_the_contacted_host(desktop_client):
    sh = desktop_client.get("/agent", headers={"host": "10.0.0.5"}).text
    assert 'BASE="http://10.0.0.5"' in sh
    ps1 = desktop_client.get("/agent.ps1", headers={"host": "10.0.0.5"}).text
    assert "$Base = 'http://10.0.0.5'" in ps1
    assert not [c for c in ps1 if ord(c) > 127]      # contrainte ASCII maintenue


def test_short_alias_sh_is_valid_bash(desktop_client, tmp_path):
    p = tmp_path / "agent.sh"
    p.write_text(desktop_client.get("/agent").text, encoding="utf-8")
    subprocess.run(["bash", "-n", str(p)], check=True, capture_output=True)
