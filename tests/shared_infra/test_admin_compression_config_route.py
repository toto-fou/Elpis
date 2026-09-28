# SPDX-License-Identifier: MIT
"""POST /api/admin/compression-config — régression « 500 après écriture »
(2026-07-29).

Le bloc de retour du POST référençait encore cinq attributs retirés par le
harnais v4/M3 (``COMPRESSION_TRIGGER_AFTER``, ``_EVERY``, ``_PCT_OF_CTX``,
``_COOLDOWN_ITERS``, ``_MIN_GROWTH_TOKENS``). Chaque enregistrement levait donc
une AttributeError → HTTP 500, **après** avoir écrit config.json et mis à jour
les globals : l'admin lisait « Enregistrement échoué » alors que sa config
ÉTAIT enregistrée. Aucun test ne couvrait ce POST.

Invariant posé ici : le POST répond 200 et renvoie EXACTEMENT la même forme que
le GET (les deux doivent rester alignés — c'est la désynchronisation qui a
causé le bug).
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient


@pytest.fixture()
def client(monkeypatch, tmp_path):
    import shared_infra.routes.admin.config as adm

    # Auth : le handler appelle require_user_id + get_user_by_id (staff).
    monkeypatch.setattr(adm, "require_user_id", lambda request: "1", raising=False)
    monkeypatch.setattr(adm, "get_user_by_id",
                        lambda uid: {"id": 1, "is_admin": 1}, raising=False)
    # Neutralise la persistance disque : le test porte sur le CONTRAT HTTP.
    written = {}
    monkeypatch.setattr(adm, "write_config_json",
                        lambda d: written.update({"cfg": d}), raising=False)
    monkeypatch.setattr(adm, "read_config_json", lambda: {}, raising=False)

    app = FastAPI()
    app.include_router(adm.admin_router)
    c = TestClient(app, raise_server_exceptions=False)
    c._written = written
    return c


_LIVE_KEYS = {
    "enabled", "keep_recent_turns", "keep_bridge_turns", "external_model",
    "endpoint_url", "endpoint_model", "endpoint_timeout_sec", "max_per_chat",
    "buffer_tokens", "partial_target_ratio", "threshold_pct",
    "threshold_tokens",
}

# Retirées par le harnais v4/M3 : plus aucun lecteur, ne doivent JAMAIS
# réapparaître dans une réponse (elles laisseraient croire à des leviers).
_DEAD_KEYS = {"trigger_after_turns", "compress_every", "pct_of_ctx",
              "cooldown_iters", "min_growth_tokens"}


def test_post_ne_renvoie_plus_500(client):
    r = client.post("/api/admin/compression-config", json={"keep_recent_turns": 8})
    assert r.status_code == 200, r.text


def test_post_et_get_ont_la_meme_forme(client):
    g = client.get("/api/admin/compression-config")
    p = client.post("/api/admin/compression-config", json={})
    assert g.status_code == 200 and p.status_code == 200
    assert set(p.json()) == set(g.json())


def test_aucune_cle_morte_exposee(client):
    for r in (client.get("/api/admin/compression-config"),
              client.post("/api/admin/compression-config", json={})):
        assert not (_DEAD_KEYS & set(r.json())), "réglage inerte ré-exposé"
        assert set(r.json()) == _LIVE_KEYS


def test_valeur_enregistree_est_bien_relue(client):
    r = client.post("/api/admin/compression-config", json={"keep_recent_turns": 9})
    assert r.status_code == 200
    assert r.json()["keep_recent_turns"] == 9


def test_toggle_maitre_persiste(client):
    assert client.post("/api/admin/compression-config",
                       json={"enabled": False}).json()["enabled"] is False
    assert client.post("/api/admin/compression-config",
                       json={"enabled": True}).json()["enabled"] is True


# ── Défaut d'instance du seuil de compaction (2026-08-21) ──────────────────
# ``llm.compaction.threshold_pct`` : « contexte max avant compaction » servi
# aux comptes qui n'ont pas réglé le leur. 0 = auto (plafond technique).


def test_threshold_pct_absent_du_body_ne_touche_a_rien(client):
    """Clé absente ⇒ valeur courante conservée. C'est le piège de ce réglage :
    0 est une VALEUR (auto), pas un « non renseigné » — un ``_bounded(...)``
    naïf sur une clé absente aurait remis 0 à chaque POST partiel."""
    from shared_infra import config as _cfg
    _cfg.COMPACTION_THRESHOLD_PCT = 70
    r = client.post("/api/admin/compression-config", json={"keep_recent_turns": 8})
    assert r.status_code == 200
    assert r.json()["threshold_pct"] == 70
    _cfg.COMPACTION_THRESHOLD_PCT = 0


@pytest.mark.parametrize("envoye,attendu", [
    (70, 70),          # valeur nominale
    (0, 0),            # retour explicite à l'auto
    (12, 30),          # sous la borne basse → plancher
    (400, 100),        # au-dessus → plafond (= le plafond technique)
    ("abc", 0),        # illisible → auto, jamais un 400
])
def test_threshold_pct_borne_et_persiste(client, envoye, attendu):
    from shared_infra import config as _cfg
    _cfg.COMPACTION_THRESHOLD_PCT = 0
    r = client.post("/api/admin/compression-config", json={"threshold_pct": envoye})
    assert r.status_code == 200
    assert r.json()["threshold_pct"] == attendu
    # …et il part bien dans la section ``llm.compaction`` de config.json,
    # aux côtés de buffer_tokens (pas dans ``llm.compression``).
    cfg = client._written.get("cfg") or {}
    assert cfg["llm"]["compaction"]["threshold_pct"] == attendu
    _cfg.COMPACTION_THRESHOLD_PCT = 0


@pytest.mark.parametrize("envoye,attendu", [
    (80000, 80000),      # « 80K », la valeur type
    (0, 0),              # retour explicite à l'auto
    (500, 2048),         # sous la borne → plancher
    (9_000_000, 4_000_000),  # au-dessus → plafond
    ("abc", 0),
])
def test_threshold_tokens_borne_et_persiste(client, envoye, attendu):
    """Défaut d'instance dans la SECONDE unité. Même contrat que le % : clé
    absente = inchangée, 0 explicite = auto."""
    from shared_infra import config as _cfg
    _cfg.COMPACTION_THRESHOLD_TOKENS = 0
    r = client.post("/api/admin/compression-config",
                    json={"threshold_tokens": envoye})
    assert r.status_code == 200
    assert r.json()["threshold_tokens"] == attendu
    cfg = client._written.get("cfg") or {}
    assert cfg["llm"]["compaction"]["threshold_tokens"] == attendu
    _cfg.COMPACTION_THRESHOLD_TOKENS = 0


def test_threshold_tokens_absent_du_body_ne_touche_a_rien(client):
    from shared_infra import config as _cfg
    _cfg.COMPACTION_THRESHOLD_TOKENS = 80000
    r = client.post("/api/admin/compression-config", json={"keep_recent_turns": 8})
    assert r.status_code == 200
    assert r.json()["threshold_tokens"] == 80000
    _cfg.COMPACTION_THRESHOLD_TOKENS = 0
