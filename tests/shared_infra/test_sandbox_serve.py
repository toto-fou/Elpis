# SPDX-License-Identifier: MIT
"""Tests de ``/api/sandbox/serve/`` et de l'aperçu à jeton ``/api/sandbox/pv/``.

Historique : l'aperçu « Web » montait le document sous
``/api/sandbox/serve/<chemin>`` ; les refs ABSOLUES-RACINE (``/style.css``)
étaient rattrapées par un repli 404 lisant le ``Referer`` (2026-08-01).
Audit 2026-09-22 (H1) : le document a désormais une origine OPAQUE — plus de
cookie ni de chemin de référent pour ses sous-ressources. Identité = jeton du
chemin ; refs absolues-racine réécrites à la source (``preview_rewrite``) vers
le résolveur ``~r``.
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import shared_infra.sandbox.routes_files as sf
from shared_infra.sandbox.preview_token import make_preview_token

TOK = make_preview_token(1)[0]
PV = f"/api/sandbox/pv/{TOK}/"


@pytest.fixture()
def sandbox(tmp_path, monkeypatch):
    """Deux racines de projet : ``demo/`` (sous-dossier) et la racine sandbox."""
    root = tmp_path / "work"
    (root / "demo").mkdir(parents=True)
    (root / "demo" / "index.html").write_text(
        '<html><head><link rel="stylesheet" href="/style.css"></head>'
        '<body><script src="/app.js"></script><a href="//cdn.example/x">x</a>'
        '<img src="rel.png"></body></html>'
    )
    (root / "demo" / "style.css").write_text("body{background:url(/bg.png)}")
    (root / "demo" / "app.js").write_text("window.OK=1")
    # Même nom, mais à la RACINE : sert à prouver que le dossier du document
    # est essayé en premier, la racine seulement en repli.
    (root / "style.css").write_text("body{background:#f00}")
    (root / "racine-only.js").write_text("window.ROOT=1")
    # Cible hors sandbox — ne doit jamais être atteignable.
    (tmp_path / "secret.txt").write_text("TOP SECRET")

    monkeypatch.setattr(sf, "_get_work_path", lambda uid: root)
    return root


@pytest.fixture()
def client(sandbox, monkeypatch):
    state = {"authed": True}

    def _fake_require_user_id(request):
        if not state["authed"]:
            raise HTTPException(401, "Authentification requise")
        return 1

    monkeypatch.setattr(sf, "require_user_id", _fake_require_user_id)

    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    c = TestClient(app)
    c.state = state
    return c


def _r(doc_dir: str, wanted: str) -> str:
    """URL du résolveur des refs absolues-racine."""
    from urllib.parse import quote
    return f"{PV}~r/d{quote(doc_dir, safe='')}/{wanted}"


# ─────────────────────────────────────────────────────────────────────────────
#  Route directe : refs relatives + cache
# ─────────────────────────────────────────────────────────────────────────────
def test_ref_relative_servie_avec_le_bon_type(client):
    r = client.get("/api/sandbox/serve/demo/style.css")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/css")
    assert r.text == "body{background:url(/bg.png)}"   # /serve : servi tel quel


def test_cache_revalide_toujours(client):
    """Sans ``Cache-Control``, le navigateur peut resservir l'ancien .css/.js
    depuis son cache disque : on voyait la page d'aperçu figée après une
    modification. L'ETag reste (→ 304 à 0 octet tant que rien ne change)."""
    r = client.get("/api/sandbox/serve/demo/app.js")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "no-cache, must-revalidate"
    assert "expires" not in r.headers
    assert r.headers.get("etag")


# ── Audit 2026-09-22 (H1) : origine opaque + jeton ─────────────────────────
def test_document_actif_isole(client):
    for url in ("/api/sandbox/serve/demo/index.html", PV + "demo/index.html"):
        r = client.get(url)
        assert r.status_code == 200
        assert r.headers["content-security-policy"].startswith("sandbox allow-scripts")
        assert "allow-same-origin" not in r.headers["content-security-policy"]
        assert r.headers["x-content-type-options"] == "nosniff"


def test_ressource_passive_sans_csp(client):
    r = client.get("/api/sandbox/serve/demo/app.js")
    assert "content-security-policy" not in r.headers
    assert r.headers["x-content-type-options"] == "nosniff"


def test_apercu_sans_session_avec_jeton(client):
    """Le document à origine opaque n'envoie pas le cookie : le jeton suffit."""
    client.state["authed"] = False
    assert client.get(PV + "demo/app.js").status_code == 200
    assert client.get("/api/sandbox/serve/demo/app.js").status_code == 401


# ``ids`` fixes : les jetons dépendent de l'heure, et xdist exige que chaque
# worker collecte les MÊMES identifiants de tests.
@pytest.mark.parametrize("tok", ["x", "1-1-abc", TOK[:-1] + ("0" if TOK[-1] != "0" else "1"),
                                 make_preview_token(1, ttl=-10)[0]],
                         ids=["illisible", "forme", "signature", "expire"])
def test_jeton_invalide_ou_expire(client, tok):
    assert client.get(f"/api/sandbox/pv/{tok}/demo/app.js").status_code == 403


def test_jeton_delivre_par_la_session(client):
    r = client.get("/api/sandbox/preview-token")
    assert r.status_code == 200 and r.json()["token"].startswith("1-")
    assert "no-store" in r.headers["cache-control"]


# ─────────────────────────────────────────────────────────────────────────────
#  Refs absolues-racine : réécriture + résolveur
# ─────────────────────────────────────────────────────────────────────────────
def test_html_reecrit_les_refs_absolues_racine(client):
    html = client.get(PV + "demo/index.html").text
    base = f"{PV}~r/ddemo/"
    assert f'href="{base}style.css"' in html and f'src="{base}app.js"' in html
    assert 'href="//cdn.example/x"' in html          # protocole-relatif intact
    assert 'src="rel.png"' in html                     # relatif intact
    assert "window.fetch" in html and html.index("<script>") > html.index("<head>")


def test_css_reecrit_url(client):
    css = client.get(PV + "demo/style.css").text
    assert f"url({PV}~r/ddemo/bg.png)" in css


def test_resolveur_dossier_du_document_dabord(client):
    r = client.get(_r("demo", "style.css"))
    assert r.status_code == 200 and "url(" in r.text      # demo/style.css, pas la racine


def test_resolveur_remonte_a_la_racine(client):
    r = client.get(_r("demo", "racine-only.js"))
    assert r.status_code == 200 and r.text == "window.ROOT=1"


def test_resolveur_chemin_conteneur(client):
    """Chemins vue-conteneur (``/work/...``) normalisés ici aussi."""
    assert client.get(_r("work/demo", "app.js")).text == "window.OK=1"


@pytest.mark.parametrize("wanted", [
    "../secret.txt", "%2e%2e/secret.txt", "../../secret.txt",
])
def test_resolveur_confine(client, wanted):
    r = client.get(_r("demo", wanted))
    assert r.status_code == 404 and "TOP SECRET" not in r.text


def test_resolveur_forme_invalide(client):
    assert client.get(f"{PV}~r/demo").status_code == 404
    assert client.get(f"{PV}~r/xdemo/app.js").status_code == 404


def test_dossier_nest_pas_servi(client):
    assert client.get(PV + "demo").status_code == 404


def test_cors_sur_le_jeton_seulement(client):
    """Le document opaque lit ses données en cross-origin : CORS ``*`` sur la
    route à jeton (seule capacité), jamais sur la route à session."""
    assert client.get(PV + "demo/app.js").headers.get("access-control-allow-origin") == "*"
    assert client.get(PV + "demo/index.html").headers.get("access-control-allow-origin") == "*"
    assert "access-control-allow-origin" not in client.get("/api/sandbox/serve/demo/app.js").headers
