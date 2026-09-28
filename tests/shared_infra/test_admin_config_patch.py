# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_admin_config_patch.py — PATCH /api/admin/config.

Refonte de la console admin (2026-09-27) : chaque écran n'envoie plus que ses
champs modifiés, avec la valeur qu'il avait LUE sur disque (``from``). Le POST
historique renvoyait config.json ENTIER : une copie chargée à l'ouverture
d'un écran réécrivait ce qu'un autre écran avait posé entre-temps — un jeton de
collecte révoqué revenait, le rapport quotidien automatique se réactivait.

Invariants posés ici :
  - seul le champ envoyé change sur disque ;
  - une valeur modifiée ailleurs depuis le chargement → 409, RIEN n'est écrit,
    et la réponse nomme le champ avec sa valeur actuelle ;
  - ``force`` écrase en connaissance de cause ;
  - une zone possédée par un autre endpoint (``_OWNED_PATHS``) est REFUSÉE en
    400 avec un message — le POST l'ignorait en silence ;
  - administrateurs seulement (un modérateur a ``is_admin == 2``) ;
  - écriture atomique, copie ``.bak`` de l'état précédent.
"""
from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

_ON_DISK = {
    "app_info": {"name": "Elpis", "version": "1.0.0"},
    "rag": {"service_url": "http://127.0.0.1:8000", "service_timeout": 60},
    "metrics": {"scrape_token": "jeton-actuel"},
    "maintenance": {"daily_digest_enabled": False},
    "security": {
        "https": {"enabled": True},
        "session": {"https_only": True, "max_age_sec": 86400, "global_min_ts": 12.5},
    },
}


@pytest.fixture()
def client(monkeypatch, tmp_path):
    import shared_infra.routes.admin.config as adm

    p = tmp_path / "config.json"
    p.write_text(json.dumps(_ON_DISK, indent=2), encoding="utf-8")
    monkeypatch.setattr(adm, "DEFAULT_CONFIG_PATH", p, raising=False)
    monkeypatch.setattr(adm, "require_user_id", lambda request: "1", raising=False)
    role = {"is_admin": 1}
    monkeypatch.setattr(adm, "get_user_by_id",
                        lambda uid: {"id": 1, "is_admin": role["is_admin"]}, raising=False)
    app = FastAPI()
    app.include_router(adm.admin_router)
    c = TestClient(app, raise_server_exceptions=False)
    c._path = p
    c._role = role
    return c


def _patch(client, changes, **extra):
    return client.patch("/api/admin/config", json={"changes": changes, **extra})


def _disk(client) -> dict:
    return json.loads(client._path.read_text(encoding="utf-8"))


def test_seul_le_champ_envoye_change(client):
    r = _patch(client, [{"path": "rag.service_timeout", "from": 60, "to": 90}])
    assert r.status_code == 200 and r.json()["applied"] == 1
    after = _disk(client)
    assert after["rag"]["service_timeout"] == 90
    # Tout le reste est intact, octet pour octet.
    expected = json.loads(json.dumps(_ON_DISK))
    expected["rag"]["service_timeout"] = 90
    assert after == expected


def test_une_valeur_ecrite_ailleurs_n_est_pas_ecrasee(client):
    """Le cas qui a motivé l'endpoint : l'écran a chargé le jeton, un autre
    écran l'a révoqué depuis — l'enregistrement du premier ne doit rien
    rétablir. Ici l'écran ne touche même pas au jeton : rien à craindre."""
    d = _disk(client)
    d["metrics"]["scrape_token"] = None          # révoqué entre-temps
    client._path.write_text(json.dumps(d), encoding="utf-8")
    assert _patch(client, [{"path": "app_info.name", "from": "Elpis", "to": "Elpis LAN"}]).status_code == 200
    after = _disk(client)
    assert after["metrics"]["scrape_token"] is None
    assert after["app_info"]["name"] == "Elpis LAN"


def test_conflit_409_rien_n_est_ecrit(client):
    d = _disk(client)
    d["rag"]["service_timeout"] = 45             # changé ailleurs après chargement
    client._path.write_text(json.dumps(d), encoding="utf-8")
    before = client._path.read_text(encoding="utf-8")
    r = _patch(client, [{"path": "rag.service_timeout", "from": 60, "to": 90},
                        {"path": "app_info.version", "from": "1.0.0", "to": "1.1.0"}])
    assert r.status_code == 409
    body = r.json()
    assert body["conflicts"] == [{"path": "rag.service_timeout", "current": 45, "absent": False}]
    # Tout ou rien : le champ sans conflit n'est pas écrit non plus.
    assert client._path.read_text(encoding="utf-8") == before


def test_cle_apparue_depuis_le_chargement_est_un_conflit(client):
    d = _disk(client)
    d["rag"]["service_token"] = "posé-ailleurs"
    client._path.write_text(json.dumps(d), encoding="utf-8")
    r = _patch(client, [{"path": "rag.service_token", "from_absent": True, "to": "le-mien"}])
    assert r.status_code == 409
    assert r.json()["conflicts"][0]["current"] == "posé-ailleurs"


def test_force_ecrase_en_connaissance_de_cause(client):
    d = _disk(client)
    d["rag"]["service_timeout"] = 45
    client._path.write_text(json.dumps(d), encoding="utf-8")
    r = _patch(client, [{"path": "rag.service_timeout", "from": 60, "to": 90}], force=True)
    assert r.status_code == 200
    assert _disk(client)["rag"]["service_timeout"] == 90


def test_entier_et_flottant_egaux(client):
    """Une valeur relue 60 et renvoyée 60.0 n'est pas un conflit."""
    assert _patch(client, [{"path": "rag.service_timeout", "from": 60.0, "to": 30}]).status_code == 200


def test_objets_manquants_crees(client):
    r = _patch(client, [{"path": "image.max_n", "from_absent": True, "to": 4}])
    assert r.status_code == 200
    assert _disk(client)["image"] == {"max_n": 4}


@pytest.mark.parametrize("path", [
    "security.session.https_only",   # la zone elle-même
    "security.https.enabled",        # dedans
    "security.session",              # le parent l'écraserait
    "database.backend",
])
def test_zone_possedee_refusee_avec_message(client, path):
    before = client._path.read_text(encoding="utf-8")
    r = _patch(client, [{"path": path, "to": False}])
    assert r.status_code == 400
    assert "Réglé par un autre écran" in r.json()["detail"]
    assert client._path.read_text(encoding="utf-8") == before


def test_voisin_d_une_zone_possedee_accepte(client):
    """Seules les zones listées sont gelées : la durée de session, voisine de
    https_only, reste modifiable."""
    r = _patch(client, [{"path": "security.session.max_age_sec", "from": 86400, "to": 3600}])
    assert r.status_code == 200
    s = _disk(client)["security"]["session"]
    assert s["max_age_sec"] == 3600 and s["https_only"] is True and s["global_min_ts"] == 12.5


@pytest.mark.parametrize("bad", ["", "a..b", "../etc", "a.b c", "x" * 10 + ".y" * 9, 42])
def test_chemin_invalide(client, bad):
    assert _patch(client, [{"path": bad, "to": 1}]).status_code == 400


def test_moderateur_refuse(client):
    client._role["is_admin"] = 2
    assert _patch(client, [{"path": "rag.service_timeout", "to": 1}]).status_code == 403


def test_ecriture_atomique_avec_copie_bak(client):
    assert _patch(client, [{"path": "app_info.name", "to": "X"}]).status_code == 200
    bak = client._path.with_suffix(".json.bak")
    assert bak.exists()
    assert json.loads(bak.read_text(encoding="utf-8"))["app_info"]["name"] == "Elpis"
    # Aucun temporaire laissé derrière.
    assert not [p for p in client._path.parent.iterdir() if p.name.endswith(".tmp")]


def test_suppression_d_une_cle(client):
    assert _patch(client, [{"path": "rag.service_url", "delete": True}]).status_code == 200
    assert "service_url" not in _disk(client)["rag"]
