# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_voice_route.py — contrat HTTP de ``/api/voice/*``.

Ce qui est vérifié ici, ce sont les GARDES : deux drapeaux d'instance, deux
réglages par utilisateur, un format d'audio strict et des plafonds. Le dialogue
avec les services distants est couvert par ``test_voice_client.py``.

Auth : ``require_user_id`` est monkeypatché SUR LE MODULE DE ROUTE (il y est
importé par nom), comme dans ``test_notifications_route.py``.
"""
from __future__ import annotations

import io
import json
import wave

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


def fait_wav(secondes=1.0, taux=16000, canaux=1) -> bytes:
    tampon = io.BytesIO()
    with wave.open(tampon, "wb") as sortie:
        sortie.setnchannels(canaux)
        sortie.setsampwidth(2)
        sortie.setframerate(taux)
        sortie.writeframes(b"\x00" * int(taux * secondes) * canaux * 2)
    return tampon.getvalue()


CONFIG_COMPLETE = {
    "enabled": True,
    "stt": {"endpoint_url": "http://stt:8090", "language": "fr"},
    "tts": {"endpoint_url": "http://tts:8091", "voice": "fr_FR-siwis-medium"},
}


@pytest.fixture()
def bac(tmp_path, monkeypatch):
    """Rend ``(client, ecrit_config, reglages, appels)``.

    ``appels`` collecte ce qui serait parti vers les services distants.
    """
    import shared_infra.config as cfg_mod
    import shared_infra.voice.client as moteur
    import shared_infra.voice.routes as routes_voix

    chemin = tmp_path / "config.json"
    chemin.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(cfg_mod, "CONFIG_JSON_PATH", chemin)
    cfg_mod.invalidate_config_cache()

    def ecrit_config(bloc):
        chemin.write_text(json.dumps({"voice": bloc}), encoding="utf-8")
        cfg_mod.invalidate_config_cache()

    reglages = {"voice_input_enabled": True, "voice_reply_enabled": True}
    monkeypatch.setattr(routes_voix, "require_user_id", lambda request: 1)
    monkeypatch.setattr(routes_voix, "get_user_settings", lambda uid: dict(reglages))

    appels = {"stt": [], "tts": []}

    async def faux_transcribe(wav, cfg, duree_ms):
        appels["stt"].append({"octets": len(wav), "duree_ms": duree_ms})
        return {"text": "Bonjour.", "avg_logprob": -0.2, "no_speech_prob": 0.01}

    async def faux_synthesize(texte, cfg, voix=""):
        appels["tts"].append({"texte": texte, "voix": voix or cfg["voice"]})
        return b"RIFF" + b"\x00" * 64, "audio/wav"

    monkeypatch.setattr(moteur, "transcribe", faux_transcribe)
    monkeypatch.setattr(moteur, "synthesize", faux_synthesize)

    # Le cache de synthèse est module-level : sans purge, un test hériterait du
    # clip d'un autre et l'appel distant n'aurait jamais lieu.
    routes_voix._cache_tts.clear()
    routes_voix._jauges.clear()
    routes_voix._debits.clear()

    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app), ecrit_config, reglages, appels


def envoie(client, donnees=None):
    return client.post("/api/voice/transcribe",
                       files={"file": ("dictee.wav", donnees or fait_wav(), "audio/wav")})


# ── /api/voice/status ──────────────────────────────────────────────────────

class TestStatus:
    def test_eteint_par_defaut(self, bac):
        c, _, _, _ = bac
        j = c.get("/api/voice/status").json()
        assert j["stt"] is False and j["tts"] is False
        assert j["dictation"] is False and j["reply"] is False

    def test_publie_les_plafonds(self, bac):
        c, ecrit, _, _ = bac
        ecrit({**CONFIG_COMPLETE, "stt": {**CONFIG_COMPLETE["stt"], "max_utterance_sec": 42}})
        j = c.get("/api/voice/status").json()
        assert j["stt"] is True and j["tts"] is True
        assert j["max_utterance_sec"] == 42
        assert j["sample_rate"] == 16000
        assert j["language"] == "fr"

    def test_croise_instance_et_reglage_utilisateur(self, bac):
        c, ecrit, reglages, _ = bac
        ecrit(CONFIG_COMPLETE)
        reglages["voice_reply_enabled"] = False
        j = c.get("/api/voice/status").json()
        assert j["dictation"] is True and j["reply"] is False


# ── /api/voice/transcribe ──────────────────────────────────────────────────

class TestTranscribe:
    def test_refuse_quand_l_instance_n_a_pas_d_adresse(self, bac):
        c, ecrit, _, appels = bac
        ecrit({"enabled": True, "stt": {}, "tts": {}})
        r = envoie(c)
        assert r.status_code == 403
        assert appels["stt"] == []

    def test_refuse_quand_l_utilisateur_a_coupe_la_dictee(self, bac):
        c, ecrit, reglages, appels = bac
        ecrit(CONFIG_COMPLETE)
        reglages["voice_input_enabled"] = False
        r = envoie(c)
        assert r.status_code == 403
        assert "paramètres" in r.json()["detail"]
        assert appels["stt"] == []

    def test_chemin_nominal(self, bac):
        c, ecrit, _, appels = bac
        ecrit(CONFIG_COMPLETE)
        r = envoie(c, fait_wav(2.0))
        assert r.status_code == 200
        assert r.json()["text"] == "Bonjour."
        assert round(appels["stt"][0]["duree_ms"]) == 2000

    @pytest.mark.parametrize("kwargs", [{"taux": 48000}, {"canaux": 2}])
    def test_refuse_un_format_inattendu(self, bac, kwargs):
        c, ecrit, _, appels = bac
        ecrit(CONFIG_COMPLETE)
        assert envoie(c, fait_wav(1.0, **kwargs)).status_code == 415
        assert appels["stt"] == []

    def test_refuse_ce_qui_n_est_pas_un_wav(self, bac):
        c, ecrit, _, _ = bac
        ecrit(CONFIG_COMPLETE)
        r = c.post("/api/voice/transcribe",
                   files={"file": ("v.webm", b"\x1aE\xdf\xa3" + b"\x00" * 200, "audio/webm")})
        assert r.status_code == 415

    def test_refuse_au_dela_du_plafond_de_taille(self, bac):
        c, ecrit, _, _ = bac
        ecrit({**CONFIG_COMPLETE,
               "stt": {**CONFIG_COMPLETE["stt"], "max_upload_mb": 1}})
        r = envoie(c, fait_wav(40.0))            # 40 s à 16 kHz/16 bits = 1,28 Mo
        assert r.status_code == 413

    def test_enonce_trop_court_jamais_envoye(self, bac):
        """Sur du silence whisper n'écrit pas « rien », il invente."""
        c, ecrit, _, appels = bac
        ecrit(CONFIG_COMPLETE)
        r = envoie(c, fait_wav(0.1))
        assert r.status_code == 200
        assert r.json()["text"] == "" and r.json()["rejected"] == "trop court"
        assert appels["stt"] == []

    def test_hallucination_filtree(self, bac, monkeypatch):
        import shared_infra.voice.client as moteur
        c, ecrit, _, _ = bac
        ecrit(CONFIG_COMPLETE)

        async def halluciné(wav, cfg, duree_ms):
            return {"text": "Sous-titres réalisés par la communauté d'Amara.org",
                    "avg_logprob": -0.1, "no_speech_prob": 0.0}

        monkeypatch.setattr(moteur, "transcribe", halluciné)
        j = envoie(c).json()
        assert j["text"] == "" and j["rejected"] == "bruit"

    def test_confiance_insuffisante_rejetee(self, bac, monkeypatch):
        """Des mots produits sans y croire coûtent plus cher à corriger
        qu'à redire."""
        import shared_infra.voice.client as moteur
        c, ecrit, _, _ = bac
        ecrit({**CONFIG_COMPLETE,
               "stt": {**CONFIG_COMPLETE["stt"], "logprob_min": -0.5}})

        async def hesitant(wav, cfg, duree_ms):
            return {"text": "peut-être quelque chose", "avg_logprob": -1.4,
                    "no_speech_prob": 0.2}

        monkeypatch.setattr(moteur, "transcribe", hesitant)
        j = envoie(c).json()
        assert j["rejected"] == "confiance insuffisante"
        # La durée accompagne le rejet : sans elle, le client ne peut pas
        # distinguer un souffle d'une vraie phrase restée incomprise.
        assert j["duration_ms"] > 0

    def test_panne_du_service_traduite(self, bac, monkeypatch):
        import shared_infra.voice.client as moteur
        from shared_infra.voice.errors import VoiceInjoignable
        c, ecrit, _, _ = bac
        ecrit(CONFIG_COMPLETE)

        async def tombe(wav, cfg, duree_ms):
            raise VoiceInjoignable("Moteur vocal injoignable.", detail="http://stt:8090")

        monkeypatch.setattr(moteur, "transcribe", tombe)
        r = envoie(c)
        assert r.status_code == 502
        # Le détail nomme une machine du réseau interne : il reste au journal.
        assert "stt:8090" not in r.text


# ── /api/voice/speak ───────────────────────────────────────────────────────

class TestSpeak:
    def test_refuse_sans_adresse(self, bac):
        c, ecrit, _, _ = bac
        ecrit({"enabled": True, "stt": CONFIG_COMPLETE["stt"], "tts": {}})
        assert c.post("/api/voice/speak", json={"text": "Bonjour."}).status_code == 403

    def test_rend_un_wav(self, bac):
        c, ecrit, _, appels = bac
        ecrit(CONFIG_COMPLETE)
        r = c.post("/api/voice/speak", json={"text": "Bonjour **tout** le monde."})
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("audio/wav")
        assert r.headers["cache-control"] == "no-store"
        # Nettoyage appliqué CÔTÉ SERVEUR : le gras ne part pas à la synthèse.
        assert appels["tts"][0]["texte"] == "Bonjour tout le monde."

    def test_bouton_lire_ne_depend_pas_du_reglage_de_lecture_auto(self, bac):
        """Décocher « Réponse vocale » ne doit pas désactiver le bouton
        « lire » — personne ne s'y attend."""
        c, ecrit, reglages, _ = bac
        ecrit(CONFIG_COMPLETE)
        reglages["voice_reply_enabled"] = False
        assert c.post("/api/voice/speak", json={"text": "Bonjour."}).status_code == 200

    def test_lecture_automatique_exige_le_reglage(self, bac):
        c, ecrit, reglages, appels = bac
        ecrit(CONFIG_COMPLETE)
        reglages["voice_reply_enabled"] = False
        r = c.post("/api/voice/speak", json={"text": "Bonjour.", "auto": True})
        assert r.status_code == 403
        assert appels["tts"] == []

    def test_rien_a_lire(self, bac):
        c, ecrit, _, appels = bac
        ecrit(CONFIG_COMPLETE)
        assert c.post("/api/voice/speak", json={"text": "   "}).status_code == 400
        assert c.post("/api/voice/speak", json={"text": "***"}).status_code == 400
        assert appels["tts"] == []

    def test_texte_tronque_au_plafond(self, bac):
        c, ecrit, _, appels = bac
        ecrit({**CONFIG_COMPLETE,
               "tts": {**CONFIG_COMPLETE["tts"], "max_chars": 200}})
        c.post("/api/voice/speak", json={"text": "Phrase courte. " * 200})
        assert len(appels["tts"][0]["texte"]) <= 200

    def test_la_voix_ne_vient_jamais_du_client(self, bac):
        c, ecrit, _, appels = bac
        ecrit(CONFIG_COMPLETE)
        c.post("/api/voice/speak", json={"text": "Bonjour.", "voice": "../../etc/passwd"})
        assert appels["tts"][0]["voix"] == "fr_FR-siwis-medium"

    def test_relecture_servie_par_le_cache(self, bac):
        """Réécouter le même message est le geste le plus courant après la
        première écoute : il ne doit pas repayer une synthèse."""
        c, ecrit, _, appels = bac
        ecrit(CONFIG_COMPLETE)
        for _ in range(3):
            assert c.post("/api/voice/speak", json={"text": "Bonjour."}).status_code == 200
        assert len(appels["tts"]) == 1

    def test_payload_invalide(self, bac):
        c, ecrit, _, _ = bac
        ecrit(CONFIG_COMPLETE)
        r = c.post("/api/voice/speak", content=b"[1,2,3]",
                   headers={"Content-Type": "application/json"})
        assert r.status_code == 400


# ── Audit 2026-09-23 ───────────────────────────────────────────────────────

class TestFormulesCourtesEnRoute:
    def test_merci_franc_conserve(self, bac, monkeypatch):
        """Les scores du moteur arrivent jusqu'au filtre : un « Merci. »
        prononcé nettement n'est plus jeté en silence."""
        import shared_infra.voice.client as moteur
        c, ecrit, _, _ = bac
        ecrit(CONFIG_COMPLETE)

        async def merci(wav, cfg, duree_ms):
            return {"text": "Merci.", "avg_logprob": -0.15, "no_speech_prob": 0.02}

        monkeypatch.setattr(moteur, "transcribe", merci)
        assert envoie(c).json()["text"] == "Merci."

    def test_merci_sur_du_silence_jete(self, bac, monkeypatch):
        import shared_infra.voice.client as moteur
        c, ecrit, _, _ = bac
        ecrit(CONFIG_COMPLETE)

        async def merci(wav, cfg, duree_ms):
            return {"text": "Merci.", "avg_logprob": -0.3, "no_speech_prob": 0.9}

        monkeypatch.setattr(moteur, "transcribe", merci)
        assert envoie(c).json()["rejected"] == "bruit"


class TestDebit:
    def test_limite_par_utilisateur(self, bac, monkeypatch):
        import shared_infra.voice.routes as routes_voix
        c, ecrit, _, appels = bac
        ecrit(CONFIG_COMPLETE)
        monkeypatch.setitem(routes_voix._DEBIT_MAX, "speak", 3)
        codes = [c.post("/api/voice/speak", json={"text": f"Phrase {i}."}).status_code
                 for i in range(4)]
        assert codes == [200, 200, 200, 429]
        assert len(appels["tts"]) == 3

    def test_limite_dictee(self, bac, monkeypatch):
        import shared_infra.voice.routes as routes_voix
        c, ecrit, _, appels = bac
        ecrit(CONFIG_COMPLETE)
        monkeypatch.setitem(routes_voix._DEBIT_MAX, "transcribe", 2)
        codes = [envoie(c).status_code for _ in range(3)]
        assert codes == [200, 200, 429]
        assert len(appels["stt"]) == 2

    def test_fenetre_glissante(self, monkeypatch):
        from fastapi import HTTPException

        import shared_infra.voice.routes as routes_voix
        routes_voix._debits.clear()
        horloge = [1000.0]
        monkeypatch.setattr(routes_voix.time, "monotonic", lambda: horloge[0])
        monkeypatch.setitem(routes_voix._DEBIT_MAX, "speak", 2)
        routes_voix._controle_debit("speak", 7)
        routes_voix._controle_debit("speak", 7)
        with pytest.raises(HTTPException) as exc:
            routes_voix._controle_debit("speak", 7)
        assert exc.value.status_code == 429
        routes_voix._controle_debit("speak", 8)          # un autre utilisateur passe
        horloge[0] += 61
        routes_voix._controle_debit("speak", 7)          # la fenêtre a glissé
        routes_voix._debits.clear()


class TestJauge:
    async def test_changer_le_plafond_ne_perd_pas_les_detenteurs(self):
        """L'ancien code recréait le sémaphore : les requêtes en cours
        relâchaient l'ancien, et le nouveau laissait partir un plafond complet
        en plus d'elles."""
        import asyncio

        from shared_infra.voice.routes import _Jauge

        j = _Jauge(2)
        await j.prendre(2, 0.1)
        await j.prendre(2, 0.1)
        # Plafond abaissé à 1 avec deux détenteurs : personne ne passe…
        with pytest.raises(asyncio.TimeoutError):
            await j.prendre(1, 0.05)
        j.rendre()                                   # rembourse la dette
        with pytest.raises(asyncio.TimeoutError):
            await j.prendre(1, 0.05)
        j.rendre()                                   # …jusqu'au dernier
        await j.prendre(1, 0.1)
        with pytest.raises(asyncio.TimeoutError):
            await j.prendre(1, 0.05)
        # Plafond remonté : un créneau de plus, tout de suite.
        await j.prendre(2, 0.1)

    async def test_baisse_avec_jetons_libres(self):
        import asyncio

        from shared_infra.voice.routes import _Jauge

        j = _Jauge(3)
        await j.prendre(1, 0.1)
        with pytest.raises(asyncio.TimeoutError):
            await j.prendre(1, 0.05)
        j.rendre()
        await j.prendre(1, 0.1)

    def test_occupe_rend_503(self, bac, monkeypatch):
        import shared_infra.voice.routes as routes_voix
        c, ecrit, _, appels = bac
        ecrit(CONFIG_COMPLETE)
        monkeypatch.setattr(routes_voix, "_ATTENTE_CRENEAU_MAX_SEC", 0.05)

        class Pleine:
            capacite = 1

            async def prendre(self, capacite, attente):
                import asyncio
                raise asyncio.TimeoutError

            def rendre(self):
                raise AssertionError("rendu sans avoir été pris")

        routes_voix._jauges["stt"] = Pleine()
        r = envoie(c)
        assert r.status_code == 503
        assert "occupé" in r.json()["detail"]
        assert appels["stt"] == []


class TestCacheParMoteur:
    def test_changer_de_moteur_ne_sert_pas_l_ancien_clip(self, bac):
        c, ecrit, _, appels = bac
        ecrit(CONFIG_COMPLETE)
        c.post("/api/voice/speak", json={"text": "Bonjour."})
        ecrit({**CONFIG_COMPLETE, "tts": {**CONFIG_COMPLETE["tts"],
                                          "endpoint_url": "http://autre:5000",
                                          "format": "piper-http"}})
        c.post("/api/voice/speak", json={"text": "Bonjour."})
        assert len(appels["tts"]) == 2
