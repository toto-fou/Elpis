# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_csrf_guard.py

Le cookie de session est en ``SameSite=lax`` par défaut, ce qui n'arrête PAS le
*same-site cross-origin* : un autre port de la même machine
(``localhost:3000`` → ``:8000``) ou un sous-domaine frère envoie le cookie, avec
``Sec-Fetch-Site: same-site``. La garde ``_reject_cross_site`` existait mais
n'était câblée que sur ``change-password`` — 1 route mutante sur ~33 — laissant
``POST /api/admin/users/new`` (création d'admin), ``/api/admin/executors``
(``exec_user`` accepte ``0:0``) et ``/api/admin/security/https`` exposés.

Le middleware doit rejeter le cross-site MUTANT porteur d'un cookie de session,
sans casser : les lectures, les appels same-origin de la SPA, ni les clients
non-navigateur (qui ne posent ni Origin ni Sec-Fetch-Site).
Régression du finding E9 de l'audit 2026-08-01.
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from shared_infra.security.csrf import CsrfGuardMiddleware

COOKIE = "mcpwebui_session"


@pytest.fixture()
def client():
    app = FastAPI()
    app.add_middleware(CsrfGuardMiddleware, cookie_name=COOKIE,
                       exempt_prefixes=("/api/sandbox/preview/",))

    @app.post("/api/admin/users/new")
    def _create_admin():
        return {"created": True}

    @app.get("/api/admin/users")
    def _list_users():
        return {"users": []}

    @app.post("/api/sandbox/preview/8080/form")
    def _preview():
        return {"ok": True}

    return TestClient(app)


def test_cross_site_mutant_avec_cookie_est_refuse(client):
    r = client.post("/api/admin/users/new",
                    headers={"sec-fetch-site": "cross-site"},
                    cookies={COOKIE: "forged"})
    assert r.status_code == 403


def test_same_site_autre_port_est_refuse(client):
    """Le cas que SameSite=lax laisse passer : origine same-SITE mais pas
    same-ORIGIN (autre port de la même machine)."""
    r = client.post("/api/admin/users/new",
                    headers={"sec-fetch-site": "same-site",
                             "origin": "http://localhost:3000"},
                    cookies={COOKIE: "victim-session"})
    assert r.status_code == 403, (
        "un autre port de la même machine peut créer un administrateur"
    )


def test_origin_divergent_sans_fetch_metadata_est_refuse(client):
    """Repli pour les navigateurs sans Fetch-Metadata."""
    r = client.post("/api/admin/users/new",
                    headers={"origin": "http://evil.example"},
                    cookies={COOKIE: "victim-session"})
    assert r.status_code == 403


def test_same_origin_passe(client):
    r = client.post("/api/admin/users/new",
                    headers={"sec-fetch-site": "same-origin"},
                    cookies={COOKIE: "legit"})
    assert r.status_code == 200


def test_lecture_cross_site_non_bloquee(client):
    """Seules les méthodes à effet de bord sont concernées."""
    r = client.get("/api/admin/users",
                   headers={"sec-fetch-site": "cross-site"},
                   cookies={COOKIE: "x"})
    assert r.status_code == 200


def test_client_non_navigateur_tolere(client):
    """CLI / plugin : ni Origin ni Sec-Fetch-Site. Non exploitable via le
    navigateur de la victime, donc hors modèle de menace CSRF."""
    r = client.post("/api/admin/users/new", cookies={COOKIE: "cli"})
    assert r.status_code == 200


def test_sans_cookie_de_session_rien_a_rejouer(client):
    """Sans autorité ambiante, pas de CSRF possible."""
    r = client.post("/api/admin/users/new",
                    headers={"sec-fetch-site": "cross-site"})
    assert r.status_code == 200


def test_prefixe_exempte_preview(client):
    """L'aperçu proxifie des pages servies par le conteneur de l'utilisateur :
    leurs formulaires POSTent avec une origine étrangère, légitimement."""
    r = client.post("/api/sandbox/preview/8080/form",
                    headers={"sec-fetch-site": "cross-site"},
                    cookies={COOKIE: "legit"})
    assert r.status_code == 200
