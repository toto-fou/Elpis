# SPDX-License-Identifier: MIT
"""Connecteur OpenCode Zen — passerelle du projet opencode, modèles gratuits.

Ce que ces tests verrouillent :

* le preset existe, est ajoutable par un UTILISATEUR, et sa ``base_url`` est
  imposée (anti-SSRF, comme tout preset cloud) ;
* les modèles GRATUITS remontent en tête de liste et sont signalés à part ;
* ⚠ VÉRIFIÉ le 2026-09-12 avec une clé réelle : l'offre gratuite d'OpenCode Zen
  est RÉSERVÉE au client opencode (400 « OpenCode's free tier can only be used
  in OpenCode »). Depuis l'application, seul le MESSAGE D'ERREUR doit le dire —
  et il doit nommer le geste : mettre une clé qui ouvre ce modèle ;
* la fenêtre de contexte n'est jamais « inconnue » pour ce fournisseur — sinon
  compaction, élagage et budget dur restent INACTIFS et la panne n'apparaît
  qu'en plein tour, sous forme d'un 400 du fournisseur.
"""
from __future__ import annotations

import importlib

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from llm_core.providers import discovery as D

# ── 1. Preset ────────────────────────────────────────────────────────────────

def test_preset_opencode_expose_et_verrouille():
    from shared_infra.llm import connectors as lc
    p = lc.PROVIDER_PRESETS["opencode"]
    assert p["wire"] == "openai"
    assert p["base_url"] == "https://opencode.ai/zen/v1"
    assert p["admin_only"] is False and p["user_base_locked"] is True
    assert "opencode" in lc.cloud_provider_types() and "opencode" in lc.PROVIDER_TYPES


# ── 2. Modèles gratuits : tri + signalement ──────────────────────────────────

_ZEN = ["claude-opus-5", "nemotron-3-ultra-free", "gpt-5-codex",
        "minimax-m2.5-free", "glm-4.7"]


def test_les_modeles_gratuits_remontent_en_tete():
    out = D._decorate({"provider_type": "opencode"}, list(_ZEN))
    assert out["free"] == ["nemotron-3-ultra-free", "minimax-m2.5-free"]
    assert out["models"][:2] == ["nemotron-3-ultra-free", "minimax-m2.5-free"]
    # Le reste garde l'ordre du fournisseur — on ne réordonne que le gratuit.
    assert out["models"][2:] == ["claude-opus-5", "gpt-5-codex", "glm-4.7"]


def test_aucun_autre_fournisseur_n_est_reordonne():
    for pt in ("openai", "anthropic", "groq", ""):
        out = D._decorate({"provider_type": pt}, list(_ZEN))
        assert out["models"] == _ZEN and out["free"] == []


@pytest.mark.asyncio
async def test_fetch_models_porte_la_liste_gratuite(monkeypatch):
    class _Resp:
        status_code = 200

        @staticmethod
        def json():
            return {"data": [{"id": m} for m in _ZEN]}

    class _Client:
        async def get(self, *a, **k):
            return _Resp()

    monkeypatch.setattr(D, "_get_llm_client", lambda base=None: _Client())
    res = await D.fetch_models({"provider_type": "opencode", "wire": "openai",
                                "base_url": "https://opencode.ai/zen/v1", "api_key": "k"})
    assert res["ok"] and res["free"] == ["nemotron-3-ultra-free", "minimax-m2.5-free"]
    assert res["models"][0] == "nemotron-3-ultra-free"


@pytest.mark.asyncio
async def test_repli_manuel_garde_le_tri(monkeypatch):
    """Fournisseur injoignable + liste saisie à la main : le tri s'applique
    quand même, sinon le repli perdrait l'information de gratuité."""
    class _Client:
        async def get(self, *a, **k):
            raise RuntimeError("réseau")

    monkeypatch.setattr(D, "_get_llm_client", lambda base=None: _Client())
    res = await D.fetch_models({"provider_type": "opencode", "wire": "openai",
                                "base_url": "https://opencode.ai/zen/v1",
                                "models_json": "glm-4.7\nminimax-m2.5-free"})
    assert res["fallback"] == "manual"
    assert res["models"] == ["minimax-m2.5-free", "glm-4.7"]
    assert res["free"] == ["minimax-m2.5-free"]


# ── 3. Fenêtre de contexte : jamais inconnue ─────────────────────────────────

@pytest.mark.asyncio
async def test_fenetre_de_contexte_jamais_inconnue(monkeypatch):
    from llm_core import _ctx_window as W
    from llm_core._target import LlmTarget
    W.invalidate_cache()
    monkeypatch.delenv("LLM_REMOTE_N_CTX", raising=False)
    t = LlmTarget(wire="openai", provider_type="opencode",
                  base_url="https://opencode.ai/zen/v1", api_key="k",
                  model="nemotron-3-ultra-free", connector_id=None, is_default=False)
    # Aucune famille connue ne matche « nemotron » : sans défaut de
    # fournisseur, la fenêtre serait 0 et la compaction resterait morte.
    assert await W.resolve_context_window("nemotron-3-ultra-free", t) == 131_072
    W.invalidate_cache()
    # Un modèle d'une famille connue garde sa fenêtre (jamais surestimée).
    t2 = LlmTarget(wire="openai", provider_type="opencode", base_url="", api_key="k",
                   model="kimi-k2.5-free", connector_id=None, is_default=False)
    assert await W.resolve_context_window("kimi-k2.5-free", t2) == 131_072
    W.invalidate_cache()
    # Un fournisseur sans défaut déclaré reste « inconnu » — pas de valeur
    # inventée pour tout le monde.
    t3 = LlmTarget(wire="openai", provider_type="generic", base_url="", api_key="k",
                   model="modele-maison", connector_id=None, is_default=False)
    assert await W.resolve_context_window("modele-maison", t3) == 0
    W.invalidate_cache()


# ── 4. Route utilisateur : création verrouillée sur la base officielle ───────

@pytest.fixture()
def uclient(tmp_path, monkeypatch):
    import shared_infra.security.encryption as enc
    monkeypatch.setenv("APP_ENCRYPTION_KEY", "unit-test-master-key")
    enc._resolved = False
    enc._cipher = None
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    from shared_infra.db._connection import db_conn
    with db_conn() as conn:
        conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT)")
        conn.execute("INSERT INTO users(id, username) VALUES (1, 'alice')")
        importlib.import_module("shared_infra.db._migrations.0007_llm_connectors").migrate(conn)
        conn.commit()
    # ⚠ ordre d'import : ``shared_infra.routes`` est le chef d'orchestre ;
    # importer ``routes_connectors`` en premier crée un cycle avec le module
    # admin qui lui emprunte ses helpers.
    import shared_infra.llm.routes_connectors as routes
    import shared_infra.routes  # noqa: F401
    monkeypatch.setattr(routes, "require_user_id", lambda request: 1)
    monkeypatch.setattr(routes, "audit_event", lambda **k: None)
    monkeypatch.setattr(routes, "read_config_json", lambda: {})
    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_un_utilisateur_ajoute_le_connecteur_opencode(uclient):
    r = uclient.post("/api/llm/connectors", json={
        "provider_type": "opencode", "api_key": "oc_secret",
        "base_url": "http://169.254.169.254/v1", "label": "Zen"})
    assert r.status_code == 200
    listed = uclient.get("/api/llm/connectors").json()
    conn = listed["connectors"][0]
    assert conn["base_url"] == "https://opencode.ai/zen/v1"      # verrouillée
    assert conn["wire"] == "openai" and conn["has_key"] is True
    assert "api_key" not in conn
    assert "opencode" in listed["allowed_provider_types"]
    assert listed["presets"]["opencode"]["label"] == "OpenCode Zen"


# ── 5. Le refus du fournisseur arrive LISIBLE à l'utilisateur ───────────────

def test_le_refus_de_l_offre_gratuite_nomme_la_cle_a_mettre():
    """Réponse RÉELLE d'OpenCode Zen appelé hors de son client (2026-09-12).
    Avant, elle arrivait en « la génération a échoué pour une raison
    inattendue » — la seule information utile de tout l'échange était jetée."""
    import httpx

    from llm_core._llm_retry import KIND_FORBIDDEN, llm_error_kind, llm_error_user_message
    req = httpx.Request("POST", "https://opencode.ai/zen/v1/chat/completions")
    body = ('{"type":"error","error":{"type":"MissingSessionID","message":'
            '"Error from provider (Console): OpenCode\'s free tier can only be '
            'used in OpenCode"}}')
    e = httpx.HTTPStatusError("boom", request=req,
                              response=httpx.Response(400, request=req, text=body))
    assert llm_error_kind(e) == KIND_FORBIDDEN
    msg = llm_error_user_message(e)
    assert "free tier can only be used in OpenCode" in msg
    assert "clé" in msg.lower()                 # le geste : changer de clé
    # Le conseil ne doit PAS envoyer chercher une cause qui n'existe pas.
    assert "outils" not in msg and "compactez" not in msg.lower()
