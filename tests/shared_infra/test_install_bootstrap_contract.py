# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_install_bootstrap_contract.py — l'amorçage d'install
reste EN CLAIR, de bout en bout.

Contrat transverse (Caddy ↔ routes ↔ front) : une machine cible n'a AUCUN moyen
de valider le certificat LAN auto-signé avant d'avoir téléchargé quoi que ce
soit. Tant que la commande d'installation partait en https, elle devait donc
neutraliser la vérification elle-même — préambule PowerShell d'environ 400
caractères (TLS 1.2 forcé + callback C# compilé via Add-Type) dont l'échec
(« The underlying connection was closed ») dépendait de la version de .NET.

D'où la règle vérifiée ici :
  1. Caddy sert les routes d'amorçage (scripts, artefacts, plugin) en http
     sur :80, et TOUT le reste continue de rediriger en https (302) ;
  2. les chemins courts affichés par le front existent côté serveur ;
  3. le front ne fabrique plus AUCUN contournement TLS dans la commande.

Casser l'un des trois fait revenir des commandes longues et instables.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

REPO = Path(__file__).resolve().parents[2]
CADDYFILE = REPO / "deploy" / "caddy" / "Caddyfile.template"
APP_JS = REPO / "frontend" / "js" / "app.js"
ADMIN_JS = REPO / "frontend" / "js" / "app-admin.js"

# Chemins que la commande copiée par l'utilisateur atteint AVANT toute CA.
SHORT_PATHS = ["/opencode", "/opencode.ps1", "/agent", "/agent.ps1"]
# Ce que ces scripts téléchargent ensuite, depuis la même origine en clair.
PAYLOAD_PATHS = [
    "/api/cli/*",
    "/api/code/plugin.ts",
    "/api/desktop/install.sh",
    "/api/desktop/install.ps1",
    "/api/desktop/agent-bundle",
]


def _site_80() -> str:
    text = CADDYFILE.read_text(encoding="utf-8")
    m = re.search(r"^:80 \{$(.*?)^\}$", text, re.S | re.M)
    assert m, "bloc :80 introuvable dans le Caddyfile"
    return m.group(1)


def test_caddy_serves_bootstrap_paths_in_clear():
    site = _site_80()
    m = re.search(r"^\t@bootstrap path (.+)$", site, re.M)
    assert m, "matcher @bootstrap absent du site :80"
    declared = m.group(1).split()
    for p in SHORT_PATHS + PAYLOAD_PATHS:
        assert p in declared, f"{p} doit rester joignable en http (amorçage)"
    assert "reverse_proxy 127.0.0.1:8001" in site


def test_caddy_still_redirects_everything_else_to_https():
    site = _site_80()
    # le catch-all (handle SANS matcher) reste le DERNIER : sinon il avalerait
    # les routes d'amorçage et on repartirait en https.
    assert "redir https://{host}{uri} 302" in site
    assert site.index("handle @bootstrap") < site.index("\thandle {")
    assert "/ca.crt" in site                     # CA toujours servie en clair


def test_caddy_bootstrap_exposes_no_authenticated_route():
    # SÉCURITÉ : ne laisser passer en clair QUE du public sans secret.
    declared = re.search(r"^\t@bootstrap path (.+)$", _site_80(), re.M).group(1).split()
    for p in declared:
        assert p in SHORT_PATHS or p in PAYLOAD_PATHS or p == "/api/code/plugin.js", p


@pytest.fixture()
def client():
    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_short_paths_exist_server_side(client):
    for p in SHORT_PATHS:
        assert client.get(p).status_code == 200, p


def test_frontend_commands_carry_no_tls_workaround():
    for f in (APP_JS, ADMIN_JS):
        src = f.read_text(encoding="utf-8")
        # Ces marqueurs ne doivent plus apparaître QUE dans des commentaires
        # d'historique — jamais dans une commande construite.
        code = "\n".join(l for l in src.splitlines()
                         if not l.lstrip().startswith(("//", "*", "/*")))
        for marker in ("ElpisTrustAll", "SkipCertificateCheck",
                       "SecurityProtocol", "curl -fsSLk"):
            assert marker not in code, f"{f.name} : contournement TLS résiduel ({marker})"


def test_frontend_uses_the_short_clear_commands():
    app_js = APP_JS.read_text(encoding="utf-8")
    assert "iex(irm ${server}/opencode.ps1)" in app_js
    assert "curl -fsSL ${server}/opencode |" in app_js
    # base d'amorçage forcée en http quand la page est en https
    assert "http://${window.location.hostname}" in app_js

    admin_js = ADMIN_JS.read_text(encoding="utf-8")
    assert "'/agent | bash'" in admin_js
    assert "'/agent.ps1)'" in admin_js
    assert "'http://' + new URL(b).hostname" in admin_js
