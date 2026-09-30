# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_mcp_bridge.py — relais ``/api/mcp-bridge`` (2026-09-04).

RÉGRESSION COUVERTE. Un opencode installé sur une autre machine recevait des URL
MCP en ``http://127.0.0.1:8765/mcp/<famille>`` : chez lui, ``127.0.0.1`` n'est
pas le serveur. Les trois entrées ``elpis-*`` s'affichaient dans son TUI et
aucune ne répondait — en LAN comme derrière le frontal HTTPS. Le service est
désormais relayé sous l'origine de l'app (même hôte, même port, même TLS).

Ce que ce fichier verrouille :
  • le relais exige un jeton elpis-remote VALIDE et le retransmet TEL QUEL
    (c'est lui qui porte ``client_kind=opencode`` côté service, donc le masquage
    de ``fs``/``shell``) — le jeton de SERVICE n'est jamais substitué ;
  • il refuse de relayer vers un service SANS authentification (sinon les
    familles ``fs``/``shell`` cesseraient d'être masquées) ;
  • les en-têtes de session MCP font l'aller-retour (sans eux, chaque requête
    ouvrirait une session neuve) ;
  • aucune route du relais ne RECOUVRE le panneau d'outils (``/api/mcp/*``).
"""
from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture()
def bridge(monkeypatch):
    """(client, journal des requêtes amont, état de l'amont). Amont simulé par
    un ``MockTransport`` : on observe EXACTEMENT ce que le relais envoie."""
    import shared_infra.config as cfg
    import shared_infra.mcp.bridge as mp
    import shared_infra.opencode.routes_code as code

    monkeypatch.setattr(cfg, "LOCAL_MCP_URL", "http://127.0.0.1:8765/mcp")
    monkeypatch.setattr(cfg, "LOCAL_MCP_TOKEN", "service-secret")
    monkeypatch.setattr(code, "_resolve_token", lambda t: 3 if t == "pcr_ok" else None)

    vues: list[httpx.Request] = []

    def _ok(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": {}},
                              headers={"Mcp-Session-Id": "sess-42"})

    # Réponse de l'amont, remplaçable par un test (``amont.reponse = …``) sans
    # re-patcher httpx — un second patch envelopperait le premier.
    etat = {"reponse": _ok}

    def _handler(request: httpx.Request) -> httpx.Response:
        vues.append(request)
        return etat["reponse"](request)

    _real_client = httpx.AsyncClient

    def _patched(*a, **kw):
        kw["transport"] = httpx.MockTransport(_handler)
        return _real_client(*a, **kw)

    monkeypatch.setattr(httpx, "AsyncClient", _patched)

    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app), vues, etat


# ── Authentification ─────────────────────────────────────────────────────────

def test_anonyme_refuse_avec_defi_bearer(bridge):
    client, vues, _ = bridge
    r = client.post("/api/mcp-bridge/git", json={})
    assert r.status_code == 401
    assert r.headers.get("www-authenticate") == "Bearer"
    assert not vues, "rien ne doit partir vers le service sans jeton"


def test_jeton_inconnu_refuse(bridge):
    client, vues, _ = bridge
    r = client.post("/api/mcp-bridge/git", json={},
                    headers={"Authorization": "Bearer pcr_faux"})
    assert r.status_code == 401
    assert not vues


def test_cookie_de_session_ne_suffit_pas(bridge):
    """Ce chemin est réservé aux clients MCP porteurs d'un jeton : accepter le
    cookie en ferait une surface CSRF (un site tiers pourrait piloter les
    outils de l'utilisateur connecté depuis son navigateur)."""
    client, vues, _ = bridge
    r = client.post("/api/mcp-bridge/git", json={}, cookies={"session": "peu-importe"})
    assert r.status_code == 401
    assert not vues


@pytest.mark.parametrize("entete", [
    {"Authorization": "Bearer pcr_ok"},
    {"x-elpis-token": "pcr_ok"},
])
def test_jeton_valide_passe(bridge, entete):
    client, vues, _ = bridge
    r = client.post("/api/mcp-bridge/git", json={"jsonrpc": "2.0"}, headers=entete)
    assert r.status_code == 200
    assert len(vues) == 1


# ── Ce qui part vers le service ──────────────────────────────────────────────

def test_le_jeton_du_client_est_retransmis_tel_quel(bridge):
    """C'est CE jeton qui porte ``client_kind=opencode`` côté service, donc le
    masquage de ``fs``/``shell``. Substituer celui de l'app (client de confiance,
    ``trusted_meta``) donnerait au poste distant les droits de l'app."""
    client, vues, _ = bridge
    client.post("/api/mcp-bridge/git", json={}, headers={"Authorization": "Bearer pcr_ok"})
    assert vues[0].headers["authorization"] == "Bearer pcr_ok"
    assert "service-secret" not in str(vues[0].headers)


def test_la_famille_devient_un_segment_du_chemin_amont(bridge):
    client, vues, _ = bridge
    h = {"Authorization": "Bearer pcr_ok"}
    client.post("/api/mcp-bridge/browser", json={}, headers=h)
    assert str(vues[-1].url) == "http://127.0.0.1:8765/mcp/browser"
    client.post("/api/mcp-bridge", json={}, headers=h)          # endpoint « tout »
    assert str(vues[-1].url) == "http://127.0.0.1:8765/mcp"


@pytest.mark.parametrize("mauvais", ["a b", "git%2F..%2Ffs", "..", "git/fs"])
def test_famille_forgee_refusee_sans_appel_amont(bridge, mauvais):
    """Un segment fabriqué ne doit jamais s'échapper de ``…/mcp/``.

    NB : ``git/../fs`` et ``.`` n'apparaissent pas ici — le client HTTP les
    normalise AVANT l'envoi (respectivement en ``/api/mcp-bridge/fs`` et en
    l'endpoint « toutes familles »), donc le serveur ne voit qu'une cible
    légitime, elle-même toujours authentifiée et restreinte par famille. Ce qui
    compte est ce qui arrive RÉELLEMENT au routeur : un segment non
    alphanumérique, ou plusieurs segments."""
    client, vues, _ = bridge
    r = client.post(f"/api/mcp-bridge/{mauvais}", json={},
                    headers={"Authorization": "Bearer pcr_ok"})
    assert r.status_code == 404, mauvais
    assert not vues, mauvais


def test_la_cible_reste_sous_le_service_mcp(bridge):
    """Quoi qu'il arrive au routeur, l'URL construite reste sous ``LOCAL_MCP_URL``
    — la cible ne vient jamais du client (pas de SSRF)."""
    client, vues, _ = bridge
    for fam in ("git", "browser", "desktop"):
        client.post(f"/api/mcp-bridge/{fam}", json={},
                    headers={"Authorization": "Bearer pcr_ok"})
    assert all(str(v.url).startswith("http://127.0.0.1:8765/mcp/") for v in vues)


def test_entetes_de_session_mcp_font_l_aller_retour(bridge):
    """Sans ``Mcp-Session-Id``, chaque requête ouvrirait une session neuve et le
    client bouclerait sur « session not found »."""
    client, vues, _ = bridge
    r = client.post("/api/mcp-bridge/git", json={},
                    headers={"Authorization": "Bearer pcr_ok",
                             "Mcp-Session-Id": "sess-42",
                             "Last-Event-ID": "17",
                             "MCP-Protocol-Version": "2025-06-18"})
    envoye = vues[0].headers
    assert envoye["mcp-session-id"] == "sess-42"
    assert envoye["last-event-id"] == "17"
    assert envoye["mcp-protocol-version"] == "2025-06-18"
    assert r.headers.get("mcp-session-id") == "sess-42"      # réponse → client


def test_cookie_jamais_transmis_au_service(bridge):
    client, vues, _ = bridge
    client.post("/api/mcp-bridge/git", json={},
                headers={"Authorization": "Bearer pcr_ok"},
                cookies={"session": "secret-navigateur"})
    assert "cookie" not in {k.lower() for k in vues[0].headers}


def test_le_flux_n_est_pas_tamponne(bridge):
    """Un intermédiaire qui tamponne fige le flux d'événements SSE du MCP."""
    client, _vues, _ = bridge
    r = client.post("/api/mcp-bridge/git", json={},
                    headers={"Authorization": "Bearer pcr_ok"})
    assert r.headers.get("x-accel-buffering") == "no"
    assert r.headers.get("cache-control") == "no-store"


# ── Invariants de configuration ──────────────────────────────────────────────

def test_pas_de_relais_sans_service_partage(bridge, monkeypatch):
    client, vues, _ = bridge
    import shared_infra.config as cfg
    monkeypatch.setattr(cfg, "LOCAL_MCP_URL", "")
    r = client.post("/api/mcp-bridge/git", json={}, headers={"Authorization": "Bearer pcr_ok"})
    assert r.status_code == 404
    assert not vues


def test_pas_de_relais_vers_un_service_sans_authentification(bridge, monkeypatch):
    """INVARIANT DE SÉCURITÉ. Sans jeton de service, le MCP démarre sans
    vérificateur : aucune requête ne porte alors ``client_kind=opencode``, donc
    les familles ``fs``/``shell`` ne sont plus masquées. Relayer offrirait le
    terminal et le système de fichiers du serveur à tout client externe — y
    compris via un ``opencode.json`` écrit à la main."""
    client, vues, _ = bridge
    import shared_infra.config as cfg
    monkeypatch.setattr(cfg, "LOCAL_MCP_TOKEN", "")
    r = client.post("/api/mcp-bridge/git", json={}, headers={"Authorization": "Bearer pcr_ok"})
    assert r.status_code == 404
    assert not vues


def test_service_injoignable_rend_un_502_explicite(bridge):
    client, _vues, amont = bridge

    def _ko(request):
        raise httpx.ConnectError("connection refused", request=request)

    amont["reponse"] = _ko
    r = client.post("/api/mcp-bridge/git", json={}, headers={"Authorization": "Bearer pcr_ok"})
    assert r.status_code == 502
    assert "MCP" in r.json()["detail"]


# ── Anti-recouvrement de routes ──────────────────────────────────────────────

def test_le_relais_ne_recouvre_pas_le_panneau_d_outils():
    """``/api/mcp/{family}`` aurait capturé ``/api/mcp/categories``,
    ``/api/mcp/test`` et ``/api/mcp/upload`` — le panneau d'outils du chat aurait
    cessé de se peupler, SANS erreur, au gré de l'ordre des imports. Le préfixe
    du relais doit rester disjoint de la surface existante."""
    import shared_infra.routes  # noqa: F401 — enregistre tout
    from shared_infra.mcp.bridge import MCP_PROXY_PREFIX
    from shared_infra.routes._state import router

    chemins = {getattr(r, "path", "") for r in router.routes}
    relais = {p for p in chemins if p.startswith(MCP_PROXY_PREFIX)}
    assert relais == {MCP_PROXY_PREFIX, MCP_PROXY_PREFIX + "/{family}"}
    # Aucune autre route ne vit sous ce préfixe…
    for p in chemins - relais:
        assert not p.startswith(MCP_PROXY_PREFIX + "/"), p
    # …et le relais ne s'installe pas au-dessus d'un préfixe déjà peuplé.
    voisins = {p for p in chemins if p.startswith("/api/mcp/")}
    assert voisins, "le panneau d'outils doit toujours exposer /api/mcp/*"
    assert not any(p.startswith(MCP_PROXY_PREFIX + "/") for p in voisins)


# ── Compat opencode : flux SSE (GET) après redémarrage du service ────────────
# Le transport StreamableHTTP du SDK MCP (opencode) TOLÈRE un GET 405 mais LÈVE
# « Failed to open SSE stream » sur tout autre non-2xx (400/404). Au redémarrage
# du service, le flux de fond se rouvre avec l'ancien Mcp-Session-Id → 404 →
# déconnexion sans reprise. Le relais renvoie donc 405 sur un GET dont la session
# manque/est périmée ; le SDK l'ignore et ré-initialise au POST suivant.

def test_get_flux_session_perimee_devient_405(bridge):
    client, vues, etat = bridge
    etat["reponse"] = lambda req: httpx.Response(404, json={"error": "session inconnue"})
    r = client.get("/api/mcp-bridge/browser", headers={"Authorization": "Bearer pcr_ok"})
    assert r.status_code == 405
    assert r.headers.get("allow") == "POST"
    assert len(vues) == 1 and vues[0].method == "GET"    # l'amont a bien été consulté


def test_get_flux_sans_session_400_devient_405(bridge):
    client, vues, etat = bridge
    etat["reponse"] = lambda req: httpx.Response(400, json={"error": "session manquante"})
    r = client.get("/api/mcp-bridge/browser", headers={"Authorization": "Bearer pcr_ok"})
    assert r.status_code == 405


def test_get_flux_valide_200_passe_tel_quel(bridge):
    client, vues, etat = bridge
    etat["reponse"] = lambda req: httpx.Response(
        200, headers={"content-type": "text/event-stream"}, text="data: {}\n\n")
    r = client.get("/api/mcp-bridge/browser", headers={"Authorization": "Bearer pcr_ok"})
    assert r.status_code == 200


def test_post_session_perimee_reste_404(bridge):
    """SEUL le GET (flux) est remappé. Un POST 404 doit RESTER 404 : c'est lui
    qui déclenche ``_recoverSession`` / la ré-initialisation côté SDK."""
    client, vues, etat = bridge
    etat["reponse"] = lambda req: httpx.Response(404, json={"error": "session inconnue"})
    r = client.post("/api/mcp-bridge/browser",
                    json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                    headers={"Authorization": "Bearer pcr_ok"})
    assert r.status_code == 404
