# SPDX-License-Identifier: MIT
"""Tests GET/PUT /api/settings pour le SEUIL de compaction
(``compression_threshold_pct``, 2026-08-21).

« Contexte max avant compaction » choisi par le compte, en DEUX unités au
choix : ``compression_threshold_pct`` (% de la fenêtre — même unité que la
jauge live du composeur) ou ``compression_threshold_tokens`` (le budget que
l'utilisateur a en tête). 0 des deux côtés = auto : on compacte quand la
fenêtre est pleine (plafond technique), soit le comportement historique.

Deux pièges couverts ici :
- **0 est une VALEUR** (auto), pas un « non renseigné ». Une coercition qui le
  confondrait avec « absent » rendrait le retour à l'auto impossible depuis
  l'interface. Bornes : 0, sinon [30, 100] pour le %, [2048, 4M] pour les
  tokens ;
- les deux unités sont **EXCLUSIVES** : poser l'une efface l'autre. Sans ça un
  compte passé de « 70 % » à « 80k » garderait un 70 % fantôme, qui
  ressortirait au moment où il remet le seuil en tokens à zéro.

Même recette que test_settings_compression.py : router partagé réel monté sur
une app nue, auth et store settings_json remplacés par des fakes en mémoire.
"""
from __future__ import annotations

from contextvars import ContextVar

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

_CUR_UID: "ContextVar[str | None]" = ContextVar("_CUR_UID", default=None)


@pytest.fixture()
def store():
    return {}


@pytest.fixture()
def client(monkeypatch, store):
    import shared_infra.accounts.routes_settings as routes_settings

    def _fake_require_user_id(request):
        uid = _CUR_UID.get()
        if not uid:
            raise HTTPException(401, "Authentification requise")
        return uid

    monkeypatch.setattr(routes_settings, "require_user_id", _fake_require_user_id)
    monkeypatch.setattr(routes_settings, "get_user_settings",
                        lambda uid: dict(store.get(uid) or {}))
    monkeypatch.setattr(routes_settings, "update_user_settings",
                        lambda uid, s: store.__setitem__(uid, dict(s)))

    def _fake_merge_user_settings(uid, mutate, _st=store):
        s = dict(_st.get(uid) or {})
        mutate(s)
        _st[uid] = dict(s)
        return dict(s)

    monkeypatch.setattr(routes_settings, "merge_user_settings", _fake_merge_user_settings)
    monkeypatch.setattr(routes_settings, "get_username_by_id", lambda uid: str(uid))
    monkeypatch.setattr(routes_settings, "read_config_json", lambda: {})

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


def _user(uid="alice"):
    return {"x-test-user": uid}


def test_get_default_est_auto(client):
    """Défaut 0 = auto : l'arrivée du réglage ne change le comportement
    d'aucun compte existant."""
    r = client.get("/api/settings", headers=_user())
    assert r.status_code == 200
    assert r.json()["compression_threshold_pct"] == 0


@pytest.mark.parametrize("envoye,attendu", [
    (70, 70),        # valeur nominale
    ("70", 70),      # le curseur peut sérialiser en chaîne
    (30, 30),        # borne basse exacte
    (100, 100),      # borne haute = plafond technique
    (0, 0),          # retour EXPLICITE à l'auto — ne doit pas être avalé
    (12, 30),        # sous la borne → plancher
    (400, 100),      # au-dessus → plafond
    (-5, 0),         # négatif → auto
    ("abc", 0),      # illisible → auto, jamais un 400
    (None, 0),
])
def test_put_borne_le_pourcentage(client, store, envoye, attendu):
    r = client.put("/api/settings", headers=_user(),
                   json={"compression_threshold_pct": envoye})
    assert r.status_code == 200
    assert store["alice"]["compression_threshold_pct"] == attendu


def test_retour_a_auto_possible_apres_un_reglage(client, store):
    """Régression directe du piège « 0 == absent » : une fois 70 posé, il faut
    pouvoir revenir à l'auto."""
    client.put("/api/settings", headers=_user(),
               json={"compression_threshold_pct": 70})
    assert store["alice"]["compression_threshold_pct"] == 70
    client.put("/api/settings", headers=_user(),
               json={"compression_threshold_pct": 0})
    assert store["alice"]["compression_threshold_pct"] == 0


def test_put_partial_merge_non_destructif(client, store):
    client.put("/api/settings", headers=_user(),
               json={"compression_enabled": True, "chat_width": 80})
    client.put("/api/settings", headers=_user(),
               json={"compression_threshold_pct": 60})
    s = store["alice"]
    assert s["compression_threshold_pct"] == 60
    assert s["compression_enabled"] is True
    assert s["chat_width"] == 80


def test_seuil_par_utilisateur_independant(client, store):
    client.put("/api/settings", headers=_user("alice"),
               json={"compression_threshold_pct": 50})
    client.put("/api/settings", headers=_user("bob"),
               json={"hide_thinking": True})
    assert store["alice"]["compression_threshold_pct"] == 50
    assert client.get("/api/settings", headers=_user("bob")
                      ).json()["compression_threshold_pct"] == 0


def test_get_reflete_la_valeur_enregistree(client, store):
    store["alice"] = {"compression_threshold_pct": 80}
    assert client.get("/api/settings", headers=_user()
                      ).json()["compression_threshold_pct"] == 80


def test_cle_hors_whitelist_ignoree(client, store):
    """Le PUT ne recopie que les clés autorisées — un client bricolé ne peut
    pas poser un réglage arbitraire à côté."""
    client.put("/api/settings", headers=_user(),
               json={"compression_threshold_pct": 60,
                     "compaction_threshold_pct": 10})
    assert "compaction_threshold_pct" not in store["alice"]
    assert store["alice"]["compression_threshold_pct"] == 60


# ── Deuxième unité : le seuil en TOKENS ────────────────────────────────────

def test_get_default_tokens_est_auto(client):
    assert client.get("/api/settings", headers=_user()
                      ).json()["compression_threshold_tokens"] == 0


@pytest.mark.parametrize("envoye,attendu", [
    (80000, 80000),   # valeur nominale (« 80K »)
    ("80000", 80000),
    (20000, 20000),
    (2048, 2048),     # borne basse exacte
    (0, 0),           # retour explicite à l'auto
    (500, 2048),      # sous la borne → plancher
    (9000000, 4000000),  # au-dessus → plafond
    (-5, 0),
    ("abc", 0),
])
def test_put_borne_le_seuil_en_tokens(client, store, envoye, attendu):
    r = client.put("/api/settings", headers=_user(),
                   json={"compression_threshold_tokens": envoye})
    assert r.status_code == 200
    assert store["alice"]["compression_threshold_tokens"] == attendu


def test_les_deux_unites_sont_exclusives(client, store):
    """Le piège du double réglage : passer de « 70 % » à « 80k » doit EFFACER
    le pourcentage. Sinon un 70 % fantôme survit et ressort dès que le seuil
    en tokens repasse à 0 — « auto » rendrait alors un réglage oublié."""
    client.put("/api/settings", headers=_user(),
               json={"compression_threshold_pct": 70})
    assert store["alice"]["compression_threshold_pct"] == 70

    client.put("/api/settings", headers=_user(),
               json={"compression_threshold_tokens": 80000})
    assert store["alice"]["compression_threshold_tokens"] == 80000
    assert store["alice"]["compression_threshold_pct"] == 0

    # …et dans l'autre sens.
    client.put("/api/settings", headers=_user(),
               json={"compression_threshold_pct": 60})
    assert store["alice"]["compression_threshold_pct"] == 60
    assert store["alice"]["compression_threshold_tokens"] == 0


def test_retour_a_auto_efface_les_deux(client, store):
    """L'interface envoie le COUPLE : les deux à 0 = auto franc."""
    client.put("/api/settings", headers=_user(),
               json={"compression_threshold_tokens": 80000})
    client.put("/api/settings", headers=_user(),
               json={"compression_threshold_pct": 0,
                     "compression_threshold_tokens": 0})
    assert store["alice"]["compression_threshold_pct"] == 0
    assert store["alice"]["compression_threshold_tokens"] == 0


def test_couple_envoye_ensemble_les_tokens_gagnent(client, store):
    """Un client qui envoie les deux non nuls (settings bricolé) : les tokens
    priment et le % est effacé — même règle que la résolution côté chat."""
    client.put("/api/settings", headers=_user(),
               json={"compression_threshold_pct": 90,
                     "compression_threshold_tokens": 50000})
    assert store["alice"]["compression_threshold_tokens"] == 50000
    assert store["alice"]["compression_threshold_pct"] == 0
