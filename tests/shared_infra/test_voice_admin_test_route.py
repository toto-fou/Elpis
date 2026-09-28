# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_voice_admin_test_route.py — le bouton « Tester ».

Doctrine du dépôt : **un test raté n'est pas une requête ratée**. L'endpoint rend
toujours HTTP 200 — le test a parfaitement réussi à établir que l'adresse ne
répond pas. L'interface lit ``ok``.

Il doit aussi accepter des surcharges d'URL, pour tester AVANT d'enregistrer,
et n'écrire jamais la configuration.
"""
from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from shared_infra.voice.errors import VoiceInjoignable


@pytest.fixture()
def bac(tmp_path, monkeypatch):
    import shared_infra.config as cfg_mod
    import shared_infra.routes.admin.integrations as integrations
    import shared_infra.voice.client as moteur

    chemin = tmp_path / "config.json"
    chemin.write_text(json.dumps({"voice": {
        "enabled": True,
        "stt": {"endpoint_url": "http://enregistre-stt:8090"},
        "tts": {"endpoint_url": "http://enregistre-tts:8091"},
    }}), encoding="utf-8")
    monkeypatch.setattr(cfg_mod, "CONFIG_JSON_PATH", chemin)
    cfg_mod.invalidate_config_cache()
    monkeypatch.setattr(integrations, "_require_admin", lambda request: 1)

    vus = {"stt": [], "tts": []}

    async def sonde_stt(cfg):
        vus["stt"].append(cfg)
        return {"text": "", "format": cfg["format"]}

    async def sonde_tts(cfg):
        vus["tts"].append(cfg)
        return {"bytes": 1234, "mime": "audio/wav", "voices": ["fr_FR-siwis-medium"]}

    monkeypatch.setattr(moteur, "sonde_stt", sonde_stt)
    monkeypatch.setattr(moteur, "sonde_tts", sonde_tts)

    from shared_infra.routes.admin._state import admin_router
    app = FastAPI()
    app.include_router(admin_router)
    return TestClient(app), vus, chemin


def test_les_deux_services_repondent(bac):
    c, _, _ = bac
    j = c.post("/api/admin/voice/test", json={}).json()
    assert j["ok"] is True
    assert j["stt"]["ok"] is True and j["tts"]["ok"] is True
    assert j["tts"]["voices"] == ["fr_FR-siwis-medium"]


def test_utilise_la_config_enregistree_sans_surcharge(bac):
    c, vus, _ = bac
    c.post("/api/admin/voice/test", json={})
    assert vus["stt"][0]["endpoint_url"] == "http://enregistre-stt:8090"
    assert vus["tts"][0]["endpoint_url"] == "http://enregistre-tts:8091"


def test_surcharge_pour_tester_avant_d_enregistrer(bac):
    c, vus, chemin = bac
    avant = chemin.read_text(encoding="utf-8")
    c.post("/api/admin/voice/test", json={
        "stt": {"endpoint_url": "http://essai:9000/", "format": "openai"},
        "tts": {"endpoint_url": "http://essai:9001", "voice": "fr_FR-tom-medium"},
    })
    assert vus["stt"][0]["endpoint_url"] == "http://essai:9000"   # barre finale retirée
    assert vus["stt"][0]["format"] == "openai"
    assert vus["tts"][0]["voice"] == "fr_FR-tom-medium"
    assert chemin.read_text(encoding="utf-8") == avant, "le test a écrit la config"


def test_echec_reste_un_200(bac, monkeypatch):
    import shared_infra.voice.client as moteur
    c, _, _ = bac

    async def tombe(cfg):
        raise VoiceInjoignable("Moteur vocal injoignable.", detail="connexion refusée")

    monkeypatch.setattr(moteur, "sonde_stt", tombe)
    r = c.post("/api/admin/voice/test", json={})
    assert r.status_code == 200
    j = r.json()
    assert j["ok"] is False
    assert j["stt"]["ok"] is False and "injoignable" in j["stt"]["error"]
    # L'autre service est sondé quand même : l'opérateur voit les deux états.
    assert j["tts"]["ok"] is True


def test_adresse_vide_dit_pourquoi(bac):
    c, _, _ = bac
    j = c.post("/api/admin/voice/test", json={"stt": {"endpoint_url": ""}}).json()
    assert j["stt"]["ok"] is False
    assert "adresse" in j["stt"]["error"].lower()


def test_erreur_inattendue_reste_un_200(bac, monkeypatch):
    import shared_infra.voice.client as moteur
    c, _, _ = bac

    async def explose(cfg):
        raise RuntimeError("boum")

    monkeypatch.setattr(moteur, "sonde_tts", explose)
    r = c.post("/api/admin/voice/test", json={})
    assert r.status_code == 200
    assert r.json()["tts"]["ok"] is False


def test_timeout_du_test_plafonne(bac):
    """Un test ne doit jamais faire patienter l'opérateur une demi-minute."""
    c, vus, _ = bac
    c.post("/api/admin/voice/test", json={"stt": {"timeout_sec": 300}})
    assert vus["stt"][0]["timeout_sec"] <= 30


# ── Bloc d'état (audit 2026-09-23, D2) ─────────────────────────────────────
# Un test vert ne disait rien de l'interrupteur, de l'enregistrement ni des
# cases de chaque utilisateur : « le test passe mais rien ne marche ».

def test_etat_enregistre_et_avertissements(bac, monkeypatch):
    import shared_infra.config as cfg_mod
    monkeypatch.setattr(cfg_mod, "https_enabled", lambda: True)
    c, _, _ = bac
    j = c.post("/api/admin/voice/test", json={
        "stt": {"endpoint_url": "http://enregistre-stt:8090", "format": "whisper.cpp",
                "model": "", "language": "fr", "prompt": "", "token": ""},
        "tts": {"endpoint_url": "http://enregistre-tts:8091", "format": "elpis-tts",
                "voice": "", "token": ""},
    }).json()
    assert j["enabled"] is True
    assert j["saved_matches_form"] is True and j["unsaved"] == []
    assert j["flags"] == {"stt": True, "tts": True}
    assert j["https"] is True
    assert any("Dictée / Réponse vocale" in w for w in j["warnings"])
    assert not any("HTTPS" in w for w in j["warnings"])
    assert not any("non enregistrée" in w for w in j["warnings"])


def test_formulaire_non_enregistre_signale(bac, monkeypatch):
    import shared_infra.config as cfg_mod
    monkeypatch.setattr(cfg_mod, "https_enabled", lambda: False)
    c, _, _ = bac
    j = c.post("/api/admin/voice/test", json={
        "stt": {"endpoint_url": "http://nouveau:8090"}}).json()
    assert j["saved_matches_form"] is False
    assert j["unsaved"] == ["stt.endpoint_url"]
    assert any("non enregistrée" in w for w in j["warnings"])
    assert any("rechargez la page" in w.lower() for w in j["warnings"])
    assert any("HTTPS" in w for w in j["warnings"])


def test_moteur_desactive_signale(bac, monkeypatch):
    import shared_infra.config as cfg_mod
    c, _, chemin = bac
    chemin.write_text(json.dumps({"voice": {
        "enabled": False, "stt": {"endpoint_url": "http://s:8090"}}}), encoding="utf-8")
    cfg_mod.invalidate_config_cache()
    j = c.post("/api/admin/voice/test", json={}).json()
    assert j["stt"]["ok"] is True                      # le service répond…
    assert j["enabled"] is False
    assert j["flags"] == {"stt": False, "tts": False}  # …mais rien n'est actif
    assert any("désactivé" in w for w in j["warnings"])


def test_openai_sans_modele_refuse_avant_sonde(bac):
    c, vus, _ = bac
    j = c.post("/api/admin/voice/test", json={
        "tts": {"endpoint_url": "http://o:8000", "format": "openai", "model": ""}}).json()
    assert j["tts"]["ok"] is False and "modèle" in j["tts"]["error"]
    assert vus["tts"] == []


def test_verify_surchargeable(bac):
    c, vus, _ = bac
    c.post("/api/admin/voice/test", json={"stt": {"verify": False}})
    assert vus["stt"][0]["verify"] is False
    assert vus["tts"][0]["verify"] is True


# ── Liste des modèles / voix chargés ───────────────────────────────────────

def test_liste_des_modeles(bac, monkeypatch):
    import shared_infra.voice.client as moteur
    c, _, _ = bac
    vus = []

    async def liste(section, cfg):
        vus.append((section, cfg))
        return {"models": [{"id": "v1", "label": "v1"}], "current": "v1", "source": "GET /voices"}

    monkeypatch.setattr(moteur, "liste_modeles", liste)
    j = c.post("/api/admin/voice/models", json={
        "section": "tts", "endpoint_url": "http://form:5000/", "format": "piper-http",
        "token": "t", "verify": False}).json()
    assert j == {"ok": True, "models": [{"id": "v1", "label": "v1"}],
                 "current": "v1", "source": "GET /voices"}
    section, cfg = vus[0]
    assert section == "tts" and cfg["endpoint_url"] == "http://form:5000"
    assert cfg["format"] == "piper-http" and cfg["token"] == "t" and cfg["verify"] is False


def test_liste_des_modeles_config_enregistree_par_defaut(bac, monkeypatch):
    import shared_infra.voice.client as moteur
    c, _, _ = bac
    vus = []

    async def liste(section, cfg):
        vus.append(cfg)
        return {"models": [], "current": None, "source": "GET /health"}

    monkeypatch.setattr(moteur, "liste_modeles", liste)
    c.post("/api/admin/voice/models", json={"section": "stt"})
    assert vus[0]["endpoint_url"] == "http://enregistre-stt:8090"


def test_liste_des_modeles_echec_reste_un_200(bac, monkeypatch):
    import shared_infra.voice.client as moteur
    c, _, _ = bac

    async def tombe(section, cfg):
        raise VoiceInjoignable("Moteur vocal injoignable.", detail="refus")

    monkeypatch.setattr(moteur, "liste_modeles", tombe)
    r = c.post("/api/admin/voice/models", json={"section": "stt"})
    assert r.status_code == 200
    assert r.json() == {"ok": False, "models": [], "current": None, "source": "",
                        "error": "Moteur vocal injoignable.", "detail": "refus"}


def test_liste_des_modeles_section_inconnue(bac):
    c, _, _ = bac
    j = c.post("/api/admin/voice/models", json={"section": "video"}).json()
    assert j["ok"] is False and j["models"] == []
