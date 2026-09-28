# SPDX-License-Identifier: MIT
"""Tests du proxy « aperçu localhost » de la sandbox (2026-07-25).

``GET|POST /api/sandbox/preview/{port}/{path}`` (routes/user_sandbox.py) :
relaie vers ``http://<ip-conteneur>:<port>/<path>`` — même recette que les
tests settings (router partagé réel + fakes), transport httpx mocké via
``_PREVIEW_TRANSPORT`` (httpx.MockTransport).
"""
from __future__ import annotations

from contextvars import ContextVar

import httpx
import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

import shared_infra.sandbox.routes_lifecycle as routes_sb

_CUR_UID: "ContextVar[str | None]" = ContextVar("_CUR_UID", default=None)


class _FakeSandbox:
    container_name = "elpis-sb-alice"

    def __init__(self, ip):
        self._ip = ip

    async def container_ip(self):
        return self._ip


@pytest.fixture()
def upstream_calls():
    return []


@pytest.fixture()
def client(monkeypatch, upstream_calls):
    def _fake_require_user_id(request):
        uid = _CUR_UID.get()
        if not uid:
            raise HTTPException(401, "Authentification requise")
        return int(uid)

    monkeypatch.setattr(routes_sb, "require_user_id", _fake_require_user_id)
    monkeypatch.setattr(routes_sb, "get_username_by_id", lambda uid: "alice")
    monkeypatch.setattr(routes_sb, "_user_sandbox_for",
                        lambda uid, username: _FakeSandbox("172.17.0.2"))

    def _handler(request: httpx.Request) -> httpx.Response:
        upstream_calls.append(request)
        path = request.url.path
        if path == "/refuse":
            raise httpx.ConnectError("connection refused", request=request)
        if path == "/redir-abs":
            return httpx.Response(302, headers={
                "Location": "http://172.17.0.2:8080/cible"})
        if path == "/redir-path":
            return httpx.Response(302, headers={"Location": "/login"})
        if path == "/hostile":
            # Serveur de la sandbox qui tente d'agir sur l'ORIGINE de l'app.
            return httpx.Response(200, headers=[
                ("Content-Type", "text/html"),
                ("Set-Cookie", "mcpwebui_session=ATTAQUANT; Path=/"),
                ("Set-Cookie", "autre=1"),
                ("Clear-Site-Data", '"cookies"'),
                ("Strict-Transport-Security", "max-age=0"),
                ("Access-Control-Allow-Origin", "*"),
                ("Content-Security-Policy", "default-src *"),
                ("X-Truc", "conserve"),
            ], text="<h1>page</h1>")
        if path == "/form" and request.method == "POST":
            return httpx.Response(200, text="posted:" +
                                  request.content.decode("utf-8"))
        return httpx.Response(200, headers={"Content-Type": "text/html"},
                              text="<h1>serveur sandbox</h1>")

    monkeypatch.setattr(routes_sb, "_PREVIEW_TRANSPORT",
                        httpx.MockTransport(_handler))

    from shared_infra.routes._state import router
    app = FastAPI()

    @app.middleware("http")
    async def _inject_auth(request: Request, call_next):
        tok = _CUR_UID.set(request.headers.get("x-test-user") or None)
        try:
            return await call_next(request)
        finally:
            _CUR_UID.reset(tok)

    app.include_router(router)
    return TestClient(app)


def _user(uid="1"):
    return {"x-test-user": uid}


def test_proxy_get_relaie_et_protege(client, upstream_calls):
    r = client.get("/api/sandbox/preview/8080/index.html?x=1",
                   headers={**_user(), "Cookie": "mcpwebui_session=SECRET",
                            "Accept": "text/html"})
    assert r.status_code == 200
    assert "serveur sandbox" in r.text
    # Cible upstream exacte (IP conteneur + port + chemin + query).
    req = upstream_calls[0]
    assert str(req.url) == "http://172.17.0.2:8080/index.html?x=1"
    # Le cookie de session ne fuit JAMAIS vers le serveur de la sandbox.
    assert "cookie" not in {k.lower() for k in req.headers}
    assert req.headers.get("accept") == "text/html"
    # Origine opaque : le document proxifié n'accède pas à la session.
    assert r.headers["content-security-policy"].startswith("sandbox")
    assert r.headers["cache-control"] == "no-store"
    assert r.headers["content-type"].startswith("text/html")


def test_set_cookie_de_la_sandbox_nest_jamais_relaye(client):
    """Le contenu du conteneur est NON FIABLE : ses en-têtes de réponse qui
    agissent au niveau réseau ne doivent pas atteindre le navigateur.

    ``CSP: sandbox`` ne rend opaque que l'origine du DOCUMENT ; ``Set-Cookie``,
    lui, est traité sur l'URL de la réponse — donc sur l'origine RÉELLE de
    l'app. Un serveur lancé dans la sandbox pouvait ainsi écraser le cookie de
    session de l'utilisateur (déconnexion, voire fixation de session) via un
    simple <img> proxifié.
    """
    r = client.get("/api/sandbox/preview/8080/hostile", headers=_user())

    assert r.status_code == 200
    lower = {k.lower() for k in r.headers.keys()}
    for banni in ("set-cookie", "clear-site-data", "strict-transport-security",
                  "access-control-allow-origin"):
        assert banni not in lower, f"{banni} relayé depuis la sandbox"
    assert not r.cookies, f"cookie posé par la sandbox : {dict(r.cookies)}"
    # La CSP est la NÔTRE, pas celle (permissive) de la sandbox.
    assert r.headers["content-security-policy"].startswith("sandbox")
    # Les en-têtes applicatifs inoffensifs continuent de passer.
    assert r.headers["x-truc"] == "conserve"


def test_proxy_post_transmet_le_corps(client, upstream_calls):
    r = client.post("/api/sandbox/preview/8080/form", headers=_user(),
                    content=b"a=1")
    assert r.status_code == 200 and r.text == "posted:a=1"


def test_redirections_reecrites_sous_le_prefixe(client):
    r = client.get("/api/sandbox/preview/8080/redir-abs", headers=_user(),
                   follow_redirects=False)
    assert r.status_code == 302
    assert r.headers["location"] == "/api/sandbox/preview/8080/cible"
    r = client.get("/api/sandbox/preview/8080/redir-path", headers=_user(),
                   follow_redirects=False)
    assert r.headers["location"] == "/api/sandbox/preview/8080/login"


def test_aucun_serveur_502_page_francaise(client):
    r = client.get("/api/sandbox/preview/8080/refuse", headers=_user())
    assert r.status_code == 502
    assert "Aucun serveur" in r.text and "8080" in r.text


def test_sans_ip_409_message_profil(client, monkeypatch):
    monkeypatch.setattr(routes_sb, "_user_sandbox_for",
                        lambda uid, username: _FakeSandbox(None))
    r = client.get("/api/sandbox/preview/8080/", headers=_user())
    assert r.status_code == 409
    assert "Isolé" in r.text


def test_port_hors_bornes_400(client):
    assert client.get("/api/sandbox/preview/0/x", headers=_user()).status_code == 400
    assert client.get("/api/sandbox/preview/70000/x", headers=_user()).status_code == 400


def test_auth_requise_401(client):
    assert client.get("/api/sandbox/preview/8080/").status_code == 401


# ─── (2026-09-20) IP mémorisée par utilisateur, client httpx jamais fuité ──

class _Signal:
    """Flux ``docker events`` simulé : un signal par conteneur."""
    def __init__(self):
        self.stamp = (True, 1.0)

    def state_stamp(self, name):
        return self.stamp


@pytest.fixture(autouse=True)
def _cache_ip_propre(monkeypatch):
    import shared_infra.sandbox.executors._readiness as rd
    sig = _Signal()
    monkeypatch.setattr(rd, "get_readiness_cache", lambda: sig)
    routes_sb._PREVIEW_IP_CACHE.clear()
    yield sig
    routes_sb._PREVIEW_IP_CACHE.clear()


class _CountingSandbox(_FakeSandbox):
    calls = 0

    async def container_ip(self):
        _CountingSandbox.calls += 1
        return self._ip


def test_l_ip_du_conteneur_n_est_demandee_qu_une_fois_par_page(client, monkeypatch):
    _CountingSandbox.calls = 0
    monkeypatch.setattr(routes_sb, "_user_sandbox_for", lambda uid, u: _CountingSandbox("172.17.0.2"))
    for p in ("/index.html", "/app.js", "/style.css", "/logo.png"):
        assert client.get("/api/sandbox/preview/8080" + p, headers=_user()).status_code == 200
    assert _CountingSandbox.calls == 1
    # Un autre utilisateur a sa propre entrée.
    assert client.get("/api/sandbox/preview/8080/", headers=_user("2")).status_code == 200
    assert _CountingSandbox.calls == 2


def test_un_amont_muet_fait_oublier_l_ip(client, monkeypatch):
    _CountingSandbox.calls = 0
    monkeypatch.setattr(routes_sb, "_user_sandbox_for", lambda uid, u: _CountingSandbox("172.17.0.2"))
    assert client.get("/api/sandbox/preview/8080/", headers=_user()).status_code == 200
    assert client.get("/api/sandbox/preview/8080/refuse", headers=_user()).status_code == 502
    assert client.get("/api/sandbox/preview/8080/", headers=_user()).status_code == 200
    assert _CountingSandbox.calls == 2, "l'IP est redemandée après un 502"


def test_le_client_est_ferme_si_la_requete_ne_se_construit_pas(client, monkeypatch):
    fermes = []

    class _Client(httpx.AsyncClient):
        def build_request(self, *a, **k):
            raise httpx.InvalidURL("chemin invalide")

        async def aclose(self):
            fermes.append(1)
            await super().aclose()
    monkeypatch.setattr(httpx, "AsyncClient", _Client)
    # Le TestClient relève l'exception serveur telle quelle (ou la rend en 500
    # selon sa configuration) : ce qui compte, c'est la fermeture du client.
    try:
        r = client.get("/api/sandbox/preview/8080/bizarre", headers=_user())
        assert r.status_code == 500
    except httpx.InvalidURL:
        pass
    assert fermes == [1], "le client httpx a été fermé"


def test_un_evenement_du_conteneur_fait_oublier_l_ip(client, monkeypatch, _cache_ip_propre):
    """(2026-09-21) Redémarrage dans la fenêtre de 5 s : l'IP a pu passer à un
    autre compte — le signal ``docker events`` a changé, l'entrée est jetée."""
    _CountingSandbox.calls = 0
    monkeypatch.setattr(routes_sb, "_user_sandbox_for", lambda uid, u: _CountingSandbox("172.17.0.2"))
    assert client.get("/api/sandbox/preview/8080/", headers=_user()).status_code == 200
    _cache_ip_propre.stamp = (True, 2.0)          # die + start
    assert client.get("/api/sandbox/preview/8080/", headers=_user()).status_code == 200
    assert _CountingSandbox.calls == 2


def test_sans_flux_d_evenements_pas_de_cache(client, monkeypatch, _cache_ip_propre):
    _CountingSandbox.calls = 0
    monkeypatch.setattr(routes_sb, "_user_sandbox_for", lambda uid, u: _CountingSandbox("172.17.0.2"))
    _cache_ip_propre.stamp = None                  # flux docker events indisponible
    for _ in range(3):
        assert client.get("/api/sandbox/preview/8080/", headers=_user()).status_code == 200
    assert _CountingSandbox.calls == 3


# ── Audit 2026-09-22 (H1) : proxy à jeton pour l'iframe (origine opaque) ────

def test_proxy_a_jeton_sans_cookie(client, upstream_calls):
    from shared_infra.sandbox.preview_token import make_preview_token
    tok = make_preview_token(1)[0]
    r = client.get(f"/api/sandbox/pvs/{tok}/8080/index.html")      # aucune session
    assert r.status_code == 200 and "serveur sandbox" in r.text
    assert r.headers["content-security-policy"].startswith("sandbox")
    assert r.headers["access-control-allow-origin"] == "*"
    assert str(upstream_calls[0].url) == "http://172.17.0.2:8080/index.html"
    r = client.get(f"/api/sandbox/pvs/{tok}/8080/redir-path", follow_redirects=False)
    assert r.headers["location"] == f"/api/sandbox/pvs/{tok}/8080/login"


def test_proxy_a_jeton_invalide_403(client):
    assert client.get("/api/sandbox/pvs/1-1-zz/8080/index.html").status_code == 403


def test_proxy_a_jeton_preflight(client):
    from shared_infra.sandbox.preview_token import make_preview_token
    tok = make_preview_token(1)[0]
    r = client.options(f"/api/sandbox/pvs/{tok}/8080/api",
                       headers={"Access-Control-Request-Method": "POST",
                                "Access-Control-Request-Headers": "content-type"})
    assert r.status_code == 204 and r.headers["access-control-allow-origin"] == "*"
