# SPDX-License-Identifier: MIT
"""Middlewares en ASGI pur — comportement identique, flux non dégradé.

``RequestLoggingMiddleware`` et ``CsrfGuardMiddleware`` étaient des
``BaseHTTPMiddleware``. Ce fichier verrouille ce qui ne doit PAS changer
(filtrage, statuts, IP, 403 cross-site) et ce qui change bel et bien : une
exception dans un générateur de ``StreamingResponse`` n'est plus travestie.
"""
import json

import pytest
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from starlette.middleware.sessions import SessionMiddleware
from starlette.testclient import TestClient

from shared_infra.observability import access_logging as al
from shared_infra.security.csrf import CsrfGuardMiddleware


@pytest.fixture
def events(monkeypatch, tmp_path):
    """Capte les événements écrits, sans toucher au vrai fichier de log."""
    captured = []
    monkeypatch.setattr(al, "write_event",
                        lambda lvl, cat, msg, **kw: captured.append(
                            {"level": lvl, "category": cat, "message": msg, **kw}))
    return captured


def _app(*, with_csrf=False, with_logging=True):
    app = FastAPI()

    @app.get("/api/ping")
    def ping():
        return {"ok": True}

    @app.post("/api/mutate")
    def mutate():
        return {"ok": True}

    @app.post("/api/webhooks/gitea")
    def hook():
        return {"ok": True}

    @app.get("/api/health")
    def health():
        return {"ok": True}

    @app.get("/api/boom")
    def boom():
        raise RuntimeError("erreur métier")

    @app.get("/api/stream-boom")
    def stream_boom():
        def gen():
            yield b'{"n":1}\n'
            raise RuntimeError("le générateur explose")
        return StreamingResponse(gen(), media_type="application/x-ndjson")

    @app.get("/api/stream-ok")
    def stream_ok():
        def gen():
            for i in range(3):
                yield b'{"n":%d}\n' % i
        return StreamingResponse(gen(), media_type="application/x-ndjson")

    # MÊME ORDRE D'AJOUT que server/app.py — il compte. ``add_middleware``
    # insère en tête, et la pile est construite sur la liste inversée : le
    # DERNIER ajouté est le plus EXTERNE. La journalisation doit donc être
    # ajoutée en dernier pour voir les 403 posés par la garde CSRF, et la
    # session en premier pour être en dessous des deux.
    app.add_middleware(SessionMiddleware, secret_key="x" * 32,
                       session_cookie="sess")
    if with_csrf:
        app.add_middleware(CsrfGuardMiddleware, cookie_name="sess",
                           exempt_prefixes=("/api/webhooks/",))
    if with_logging:
        app.add_middleware(al.RequestLoggingMiddleware)
    return app


# ── Journalisation : ce qui ne doit pas bouger ──────────────────────────────

def test_une_ligne_par_requete_avec_le_bon_statut(events):
    with TestClient(_app()) as c:
        assert c.get("/api/ping").status_code == 200
    assert len(events) == 1
    assert events[0]["extras"]["status"] == 200
    assert events[0]["extras"]["path"] == "/api/ping"
    assert events[0]["extras"]["method"] == "GET"
    assert events[0]["level"] == "INFO"


def test_les_chemins_bruyants_restent_filtres(events):
    with TestClient(_app()) as c:
        c.get("/api/health")
    assert events == []


def test_le_niveau_suit_le_statut(events):
    with TestClient(_app()) as c:
        c.get("/api/inexistant")
    assert events[0]["extras"]["status"] == 404
    assert events[0]["level"] in ("WARNING", "DEBUG")


def test_une_exception_est_journalisee_en_500_et_reste_propagee(events):
    with TestClient(_app(), raise_server_exceptions=False) as c:
        assert c.get("/api/boom").status_code == 500
    assert events[0]["extras"]["status"] == 500
    assert events[0]["level"] == "ERROR"


def test_la_duree_est_mesuree(events):
    with TestClient(_app()) as c:
        c.get("/api/ping")
    assert events[0]["extras"]["duration_ms"] >= 0


def test_l_ip_est_resolue(events):
    with TestClient(_app()) as c:
        c.get("/api/ping")
    assert events[0]["extras"]["ip"]


# ── Streaming : le vrai gain de la bascule ──────────────────────────────────

def test_un_flux_normal_arrive_entier(events):
    with TestClient(_app()) as c:
        r = c.get("/api/stream-ok")
        assert r.status_code == 200
        assert r.text.count("\n") == 3


def test_une_exception_dans_le_generateur_remonte_telle_quelle(events):
    """L'erreur réelle doit remonter, pas un message de plomberie.

    Le code porte trois rustines (``chats.py``, ``_helpers.py``,
    ``user_sandbox.py``) contre un travestissement historique en « Response
    content shorter than Content-Length ». Vérification faite sur la version de
    Starlette embarquée : ``BaseHTTPMiddleware`` ne masque PLUS rien, le
    travers a été corrigé en amont. Ce test verrouille donc l'état correct
    plutôt que de prétendre le rétablir — et il garde les rustines honnêtes le
    jour où quelqu'un se demandera si elles servent encore.
    """
    with TestClient(_app()) as c:
        with pytest.raises(RuntimeError, match="le générateur explose"):
            c.get("/api/stream-boom")


# ── CSRF : comportement inchangé ────────────────────────────────────────────

def test_une_requete_non_mutante_passe_toujours():
    with TestClient(_app(with_csrf=True)) as c:
        c.cookies.set("sess", "peu-importe")
        assert c.get("/api/ping",
                     headers={"sec-fetch-site": "cross-site"}).status_code == 200


def test_sans_cookie_de_session_rien_a_rejouer():
    with TestClient(_app(with_csrf=True)) as c:
        r = c.post("/api/mutate", headers={"sec-fetch-site": "cross-site"})
        assert r.status_code == 200


def test_mutante_cross_site_avec_cookie_est_refusee():
    with TestClient(_app(with_csrf=True)) as c:
        c.cookies.set("sess", "un-cookie")
        r = c.post("/api/mutate", headers={"sec-fetch-site": "cross-site"})
        assert r.status_code == 403
        assert r.json() == {"detail": "Requête cross-site refusée."}


def test_same_origin_passe():
    with TestClient(_app(with_csrf=True)) as c:
        c.cookies.set("sess", "un-cookie")
        r = c.post("/api/mutate", headers={"sec-fetch-site": "same-origin"})
        assert r.status_code == 200


def test_les_prefixes_exemptes_passent():
    with TestClient(_app(with_csrf=True)) as c:
        c.cookies.set("sess", "un-cookie")
        r = c.post("/api/webhooks/gitea", headers={"sec-fetch-site": "cross-site"})
        assert r.status_code == 200


def test_le_repli_sur_origin_fonctionne_sans_fetch_metadata():
    with TestClient(_app(with_csrf=True), base_url="http://test.local") as c:
        c.cookies.set("sess", "un-cookie")
        assert c.post("/api/mutate",
                      headers={"origin": "http://mechant.example"}).status_code == 403
        assert c.post("/api/mutate",
                      headers={"origin": "http://test.local"}).status_code == 200


def test_un_client_sans_entete_d_origine_est_tolere():
    """CLI, plugin : ils ne passent pas par le navigateur de la victime."""
    with TestClient(_app(with_csrf=True)) as c:
        c.cookies.set("sess", "un-cookie")
        assert c.post("/api/mutate").status_code == 200


# ── Les deux ensemble, dans l'ordre de production ───────────────────────────

def test_un_403_csrf_est_bien_journalise(events):
    with TestClient(_app(with_csrf=True)) as c:
        c.cookies.set("sess", "un-cookie")
        c.post("/api/mutate", headers={"sec-fetch-site": "cross-site"})
    assert events[-1]["extras"]["status"] == 403
    assert events[-1]["level"] == "WARNING"
