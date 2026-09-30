# SPDX-License-Identifier: MIT
"""Logo d'accueil servi comme une image, plus recopié dans du JSON.

L'admin téléverse un logo, stocké en data-URI base64 dans ``config.json``. Sur
l'instance observée cette seule valeur pèse 388 Ko — 96 % du fichier de
configuration — et ``/api/public-config`` la renvoyait telle quelle À CHAQUE
démarrage de l'application, pour une image affichée en 144 px. Une réponse JSON
n'étant pas mise en cache, ces 388 Ko repartaient à chaque ouverture de page.

Le FORMAT DE STOCKAGE est inchangé : aucune migration, téléversement admin
intact. Seule la réponse publique change, et le front n'a rien à savoir — il
fait ``<img :src="welcomeConfig.image_b64">`` et sa valeur par défaut est déjà
un chemin.
"""
import base64
import json

import pytest

from shared_infra import config as cfg
from shared_infra.routes import system as S

# 1×1 PNG transparent
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk"
    "YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")


@pytest.fixture
def conf(tmp_path, monkeypatch):
    p = tmp_path / "config.json"

    def ecrire(welcome):
        p.write_text(json.dumps({"welcome": welcome}), encoding="utf-8")
        cfg.invalidate_config_cache()

    monkeypatch.setattr(cfg, "CONFIG_JSON_PATH", p)
    ecrire({"type": "image",
            "image_b64": "data:image/png;base64," + base64.b64encode(PNG).decode()})
    yield ecrire
    cfg.invalidate_config_cache()


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("APP_SESSION_SECRET", "x" * 48)
    from starlette.testclient import TestClient

    from server.app import create_app
    with TestClient(create_app()) as c:
        yield c


# ── Décodage ────────────────────────────────────────────────────────────────

def test_le_data_uri_est_decode(conf):
    mime, data, fp = S._welcome_image_parts()
    assert mime == "image/png"
    assert data == PNG
    assert len(fp) == 16


def test_un_chemin_n_est_pas_traite_comme_une_image(conf):
    """La valeur par défaut est ``static/elpis-256.png`` : à laisser passer tel quel."""
    conf({"type": "image", "image_b64": "static/elpis-256.png"})
    assert S._welcome_image_parts() is None


def test_absence_de_logo(conf):
    conf({"type": "icon", "icon": "ph-sparkle"})
    assert S._welcome_image_parts() is None


def test_un_base64_corrompu_ne_leve_pas(conf):
    conf({"type": "image", "image_b64": "data:image/png;base64,%%%pas-du-base64%%%"})
    parts = S._welcome_image_parts()
    assert parts is None or isinstance(parts[1], bytes)


def test_l_empreinte_suit_le_contenu(conf):
    avant = S._welcome_image_parts()[2]
    conf({"type": "image",
          "image_b64": "data:image/png;base64," + base64.b64encode(PNG + b"\x00").decode()})
    assert S._welcome_image_parts()[2] != avant


# ── Réponse publique ────────────────────────────────────────────────────────

def test_public_config_ne_transporte_plus_l_image(conf, client):
    r = client.get("/api/public-config")
    assert r.status_code == 200
    src = r.json()["welcome"]["image_b64"]
    assert src.startswith("/api/welcome-image?v=")
    assert "base64" not in r.text
    assert len(r.content) < 20_000, "la réponse ne doit plus porter l'image"


def test_l_image_est_servie_et_cachable(conf, client):
    src = client.get("/api/public-config").json()["welcome"]["image_b64"]
    r = client.get(src)
    assert r.status_code == 200
    assert r.content == PNG
    assert r.headers["content-type"].startswith("image/png")
    # L'URL porte l'empreinte du contenu : l'immuabilité est sûre.
    assert "immutable" in r.headers["cache-control"]
    assert r.headers.get("etag")


def test_sans_logo_l_endpoint_repond_404(conf, client):
    conf({"type": "icon", "icon": "ph-sparkle"})
    assert client.get("/api/welcome-image").status_code == 404


def test_un_chemin_configure_est_rendu_tel_quel(conf, client):
    """Rétro-compatibilité : une config qui pointe déjà un fichier ne bouge pas."""
    conf({"type": "image", "image_b64": "static/elpis-256.png"})
    src = client.get("/api/public-config").json()["welcome"]["image_b64"]
    assert src == "static/elpis-256.png"


def test_le_cache_de_config_n_est_pas_contamine(conf, client):
    """``get_public_config`` lit la vue PARTAGÉE : elle ne doit pas être mutée."""
    client.get("/api/public-config")
    brut = cfg.config_view()["welcome"]["image_b64"]
    assert brut.startswith("data:image/png;base64,"), \
        "la valeur stockée doit rester le data-URI d'origine"
