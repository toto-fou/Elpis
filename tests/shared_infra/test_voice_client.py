# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_voice_client.py — la forme exacte de ce qui part.

Trois dialectes en reconnaissance, deux en synthèse : ce qui compte est que le
corps envoyé soit celui que chaque service attend. Un ``httpx.MockTransport``
capture la requête — pas de serveur, pas de réseau.

Couvre aussi la traduction des pannes : ce qui remonte à l'utilisateur doit
dire quoi faire, et le code HTTP doit distinguer « injoignable » de « trop lent ».
"""
from __future__ import annotations

import base64
import json

import httpx
import pytest

from shared_infra.voice import client as moteur
from shared_infra.voice.errors import (
    VoiceDesactive,
    VoiceInjoignable,
    VoiceRefus,
    VoiceTimeout,
)

WAV = b"RIFF" + b"\x00" * 40 + b"data" + b"\x00" * 100


def branche(monkeypatch, gestionnaire):
    """Installe un transport factice et rend la liste des requêtes vues."""
    vues = []

    def capture(requete: httpx.Request) -> httpx.Response:
        vues.append(requete)
        return gestionnaire(requete)

    monkeypatch.setattr(moteur, "_TRANSPORT", httpx.MockTransport(capture))
    return vues


def cfg_stt(**surcharges):
    base = {"endpoint_url": "http://stt:8090", "format": "whisper.cpp", "model": "",
            "language": "fr", "prompt": "", "token": "", "logprob_min": -0.6,
            "timeout_sec": 10, "max_upload_mb": 10, "max_utterance_sec": 30,
            "max_concurrent": 2}
    base.update(surcharges)
    return base


def cfg_tts(**surcharges):
    base = {"endpoint_url": "http://tts:8091", "format": "elpis-tts", "token": "",
            "voice": "fr_FR-siwis-medium", "speed": 1.0, "timeout_sec": 10,
            "max_chars": 4000, "max_concurrent": 2}
    base.update(surcharges)
    return base


# ── Normalisation d'URL ────────────────────────────────────────────────────

class TestUrl:
    def test_accepte_une_base_ou_une_route_complete(self):
        """L'administrateur colle ce qu'il a sous la main. Les deux marchent,
        sinon le premier essai échoue sans que rien n'explique pourquoi."""
        assert moteur._url("http://h:8090", "/inference") == "http://h:8090/inference"
        assert moteur._url("http://h:8090/inference", "/inference") == "http://h:8090/inference"
        assert moteur._url("http://h:8090/", "/inference") == "http://h:8090/inference"

    def test_ne_double_pas_le_v1(self):
        assert moteur._url("http://h/v1", "/v1/audio/speech") == "http://h/v1/audio/speech"

    def test_adresse_vide_refusee_tot(self):
        with pytest.raises(VoiceDesactive):
            moteur._url("", "/inference")


# ── Reconnaissance ─────────────────────────────────────────────────────────

class TestTranscribeWhisperCpp:
    async def test_forme_du_multipart(self, monkeypatch):
        vues = branche(monkeypatch, lambda r: httpx.Response(
            200, json={"text": " Bonjour ", "segments": [
                {"avg_logprob": -0.2, "no_speech_prob": 0.05}]}))

        res = await moteur.transcribe(WAV, cfg_stt(prompt="Elpis, Qdrant"), 5000.0)

        assert res["text"] == "Bonjour"
        assert res["avg_logprob"] == pytest.approx(-0.2)
        assert res["no_speech_prob"] == pytest.approx(0.05)

        req = vues[0]
        assert str(req.url) == "http://stt:8090/inference"
        corps = req.content.decode("utf-8", "replace")
        assert 'name="file"; filename="dictee.wav"' in corps
        assert 'name="response_format"' in corps and "verbose_json" in corps
        # Contexte proportionnel à la durée : 5 s -> 512 positions.
        assert 'name="audio_ctx"' in corps and "512" in corps
        assert "Elpis, Qdrant" in corps

    async def test_contexte_suit_la_duree(self, monkeypatch):
        vues = branche(monkeypatch, lambda r: httpx.Response(200, json={"text": "x"}))
        await moteur.transcribe(WAV, cfg_stt(), 500.0)
        await moteur.transcribe(WAV, cfg_stt(), 20000.0)
        ctx = [c.content.decode("utf-8", "replace") for c in vues]
        assert '\r\n\r\n256' in ctx[0]
        assert '\r\n\r\n256' not in ctx[1]

    async def test_moyenne_des_segments(self, monkeypatch):
        """Un seul segment hésitant ne doit pas jeter toute la phrase."""
        branche(monkeypatch, lambda r: httpx.Response(200, json={
            "text": "ok", "segments": [
                {"avg_logprob": -0.1, "no_speech_prob": 0.0},
                {"avg_logprob": -0.9, "no_speech_prob": 0.7}]}))
        res = await moteur.transcribe(WAV, cfg_stt(), 3000.0)
        assert res["avg_logprob"] == pytest.approx(-0.5)
        assert res["no_speech_prob"] == pytest.approx(0.7)

    async def test_sans_segments_la_confiance_est_inconnue(self, monkeypatch):
        branche(monkeypatch, lambda r: httpx.Response(200, json={"text": "ok"}))
        res = await moteur.transcribe(WAV, cfg_stt(), 3000.0)
        assert res["avg_logprob"] is None and res["no_speech_prob"] is None

    async def test_serveur_qui_rend_du_texte_nu(self, monkeypatch):
        """Certains serveurs ignorent ``response_format`` — on ne casse pas."""
        branche(monkeypatch, lambda r: httpx.Response(200, text="  Bonjour  ",
                                                      headers={"content-type": "text/plain"}))
        res = await moteur.transcribe(WAV, cfg_stt(), 3000.0)
        assert res["text"] == "Bonjour"


class TestTranscribeOpenAi:
    async def test_route_et_champs(self, monkeypatch):
        vues = branche(monkeypatch, lambda r: httpx.Response(200, json={"text": "salut"}))
        await moteur.transcribe(WAV, cfg_stt(format="openai", model="whisper-1",
                                             token="secret"), 3000.0)
        req = vues[0]
        assert str(req.url) == "http://stt:8090/v1/audio/transcriptions"
        assert req.headers["authorization"] == "Bearer secret"
        corps = req.content.decode("utf-8", "replace")
        assert "whisper-1" in corps and "verbose_json" in corps
        # audio_ctx est propre à whisper.cpp : il n'a rien à faire ici.
        assert 'name="audio_ctx"' not in corps


class TestTranscribeLlamaAudio:
    async def test_audio_en_base64_dans_le_chat(self, monkeypatch):
        vues = branche(monkeypatch, lambda r: httpx.Response(200, json={
            "choices": [{"message": {"content": "<think>hmm</think>Bonjour."}}]}))
        res = await moteur.transcribe(WAV, cfg_stt(format="llama-audio",
                                                   endpoint_url="http://llm:8080"), 3000.0)
        assert res["text"] == "Bonjour."           # le raisonnement est purgé
        corps = json.loads(vues[0].content)
        partie = corps["messages"][0]["content"][1]
        assert partie["type"] == "input_audio"
        assert base64.b64decode(partie["input_audio"]["data"]) == WAV
        assert corps["temperature"] == 0

    async def test_contenu_en_morceaux(self, monkeypatch):
        branche(monkeypatch, lambda r: httpx.Response(200, json={
            "choices": [{"message": {"content": [{"text": "Bon"}, {"text": "jour"}]}}]}))
        res = await moteur.transcribe(WAV, cfg_stt(format="llama-audio"), 3000.0)
        assert res["text"] == "Bon jour"

    async def test_reponse_inattendue(self, monkeypatch):
        branche(monkeypatch, lambda r: httpx.Response(200, json={"rien": 1}))
        with pytest.raises(VoiceRefus):
            await moteur.transcribe(WAV, cfg_stt(format="llama-audio"), 3000.0)


# ── Synthèse ───────────────────────────────────────────────────────────────

class TestSynthesize:
    async def test_elpis_tts(self, monkeypatch):
        vues = branche(monkeypatch, lambda r: httpx.Response(
            200, content=b"RIFFxxxx", headers={"content-type": "audio/wav"}))
        audio, mime = await moteur.synthesize("Bonjour.", cfg_tts(speed=1.2))
        assert audio == b"RIFFxxxx" and mime == "audio/wav"
        req = vues[0]
        assert str(req.url) == "http://tts:8091/tts"
        corps = json.loads(req.content)
        assert corps == {"text": "Bonjour.", "voice": "fr_FR-siwis-medium", "speed": 1.2}

    async def test_openai(self, monkeypatch):
        vues = branche(monkeypatch, lambda r: httpx.Response(200, content=b"RIFF"))
        await moteur.synthesize("Salut.", cfg_tts(format="openai", token="jeton"))
        req = vues[0]
        assert str(req.url) == "http://tts:8091/v1/audio/speech"
        assert req.headers["authorization"] == "Bearer jeton"
        assert json.loads(req.content)["response_format"] == "wav"

    async def test_voix_surchargee_par_l_appelant(self, monkeypatch):
        vues = branche(monkeypatch, lambda r: httpx.Response(200, content=b"RIFF"))
        await moteur.synthesize("Salut.", cfg_tts(), voix="fr_FR-tom-medium")
        assert json.loads(vues[0].content)["voice"] == "fr_FR-tom-medium"

    async def test_son_vide_refuse(self, monkeypatch):
        branche(monkeypatch, lambda r: httpx.Response(200, content=b""))
        with pytest.raises(VoiceRefus):
            await moteur.synthesize("Salut.", cfg_tts())

    async def test_type_mime_non_audio_ramene_a_wav(self, monkeypatch):
        branche(monkeypatch, lambda r: httpx.Response(
            200, content=b"RIFF", headers={"content-type": "application/octet-stream"}))
        _, mime = await moteur.synthesize("Salut.", cfg_tts())
        assert mime == "audio/wav"


# ── Pannes ─────────────────────────────────────────────────────────────────

class TestPannes:
    async def test_injoignable(self, monkeypatch):
        def tombe(requete):
            raise httpx.ConnectError("refus", request=requete)
        branche(monkeypatch, tombe)
        with pytest.raises(VoiceInjoignable) as exc:
            await moteur.transcribe(WAV, cfg_stt(), 3000.0)
        assert exc.value.statut == 502
        assert "injoignable" in exc.value.message.lower()

    async def test_timeout(self, monkeypatch):
        def tarde(requete):
            raise httpx.ReadTimeout("trop long", request=requete)
        branche(monkeypatch, tarde)
        with pytest.raises(VoiceTimeout) as exc:
            await moteur.synthesize("x", cfg_tts())
        assert exc.value.statut == 504

    async def test_erreur_http_porte_le_detail_du_service(self, monkeypatch):
        branche(monkeypatch, lambda r: httpx.Response(
            500, json={"error": {"message": "model not loaded"}}))
        with pytest.raises(VoiceRefus) as exc:
            await moteur.transcribe(WAV, cfg_stt(), 3000.0)
        assert "500" in exc.value.message
        assert "model not loaded" in exc.value.detail


class TestVoixDisponibles:
    async def test_liste_les_voix_installees(self, monkeypatch):
        branche(monkeypatch, lambda r: httpx.Response(200, json={
            "installed": [{"name": "fr_FR-siwis-medium"}, {"name": "fr_FR-tom-medium"}]}))
        assert await moteur.voix_disponibles(cfg_tts()) == [
            "fr_FR-siwis-medium", "fr_FR-tom-medium"]

    async def test_jamais_bloquant(self, monkeypatch):
        """Confort d'interface, pas condition de bon fonctionnement."""
        def tombe(requete):
            raise httpx.ConnectError("refus", request=requete)
        branche(monkeypatch, tombe)
        assert await moteur.voix_disponibles(cfg_tts()) == []
        assert await moteur.voix_disponibles(cfg_tts(format="openai")) == []


class TestSondes:
    async def test_sonde_stt_envoie_une_seconde_de_silence(self, monkeypatch):
        """Une transcription vide est un SUCCÈS : on valide le contrat HTTP,
        pas la qualité de la reconnaissance."""
        vues = branche(monkeypatch, lambda r: httpx.Response(200, json={"text": ""}))
        res = await moteur.sonde_stt(cfg_stt())
        assert res == {"text": "", "format": "whisper.cpp"}
        assert b"RIFF" in vues[0].content and b"WAVE" in vues[0].content

    async def test_sonde_tts_compte_les_octets(self, monkeypatch):
        def gestionnaire(requete):
            if requete.url.path == "/voices":
                return httpx.Response(200, json={"installed": [{"name": "v1"}]})
            return httpx.Response(200, content=b"RIFF" + b"\x00" * 100)
        branche(monkeypatch, gestionnaire)
        res = await moteur.sonde_tts(cfg_tts())
        assert res["bytes"] == 104 and res["voices"] == ["v1"]


# ── Audit 2026-09-23 ───────────────────────────────────────────────────────

class TestPiperHttp:
    """``python -m piper.http_server`` (Piper 1.x) : ``POST /synthesize``
    depuis 1.5, ``POST /`` avant. ``length_scale`` = inverse de la vitesse."""

    async def test_route_actuelle_et_corps(self, monkeypatch):
        vues = branche(monkeypatch, lambda r: httpx.Response(
            200, content=b"RIFFpiper", headers={"content-type": "audio/wav"}))
        audio, _ = await moteur.synthesize("Bonjour.", cfg_tts(
            format="piper-http", endpoint_url="http://piper:5000/", speed=1.25))
        assert audio == b"RIFFpiper"
        assert str(vues[0].url) == "http://piper:5000/synthesize"
        assert json.loads(vues[0].content) == {
            "text": "Bonjour.", "voice": "fr_FR-siwis-medium", "length_scale": 0.8}

    async def test_vitesse_normale_garde_le_reglage_de_la_voix(self, monkeypatch):
        vues = branche(monkeypatch, lambda r: httpx.Response(200, content=b"RIFF"))
        await moteur.synthesize("Salut.", cfg_tts(format="piper-http"))
        assert "length_scale" not in json.loads(vues[0].content)

    @pytest.mark.parametrize("code", [404, 405])
    async def test_repli_sur_la_racine_des_anciennes_versions(self, monkeypatch, code):
        def gestionnaire(requete):
            if requete.url.path == "/synthesize":
                return httpx.Response(code, text="Not Found")
            return httpx.Response(200, content=b"RIFFold")
        vues = branche(monkeypatch, gestionnaire)
        audio, _ = await moteur.synthesize("Salut.", cfg_tts(format="piper-http"))
        assert audio == b"RIFFold"
        assert [r.url.path for r in vues] == ["/synthesize", "/"]

    async def test_adresse_complete_prise_telle_quelle(self, monkeypatch):
        vues = branche(monkeypatch, lambda r: httpx.Response(200, content=b"RIFF"))
        await moteur.synthesize("Salut.", cfg_tts(
            format="piper-http", endpoint_url="http://piper:5000/synthesize"))
        assert [str(r.url) for r in vues] == ["http://piper:5000/synthesize"]

    async def test_erreur_autre_que_404_sans_repli(self, monkeypatch):
        vues = branche(monkeypatch, lambda r: httpx.Response(500, text="boum"))
        with pytest.raises(VoiceRefus):
            await moteur.synthesize("Salut.", cfg_tts(format="piper-http"))
        assert len(vues) == 1


class TestOpenAiModele:
    async def test_modele_envoye(self, monkeypatch):
        vues = branche(monkeypatch, lambda r: httpx.Response(200, content=b"RIFF"))
        await moteur.synthesize("Salut.", cfg_tts(format="openai", model="tts-1"))
        assert json.loads(vues[0].content)["model"] == "tts-1"

    async def test_stt_repli_json_si_verbose_refuse(self, monkeypatch):
        def gestionnaire(requete):
            if b"verbose_json" in requete.content:
                return httpx.Response(400, json={"error": "unsupported response_format"})
            return httpx.Response(200, json={"text": "salut"})
        vues = branche(monkeypatch, gestionnaire)
        res = await moteur.transcribe(WAV, cfg_stt(format="openai"), 3000.0)
        assert res == {"text": "salut", "avg_logprob": None, "no_speech_prob": None}
        assert len(vues) == 2

    async def test_whisper_cpp_sans_repli(self, monkeypatch):
        vues = branche(monkeypatch, lambda r: httpx.Response(400, text="bad"))
        with pytest.raises(VoiceRefus):
            await moteur.transcribe(WAV, cfg_stt(), 3000.0)
        assert len(vues) == 1


class TestMessagesHttp:
    @pytest.mark.parametrize("code,morceau", [
        (401, "Jeton refusé"), (403, "Jeton refusé"),
        (404, "Chemin introuvable"), (405, "Chemin introuvable"),
        (413, "trop volumineux"), (502, "HTTP 502"), (418, "HTTP 418"),
    ])
    async def test_message_actionnable(self, monkeypatch, code, morceau):
        branche(monkeypatch, lambda r: httpx.Response(code, text="x"))
        with pytest.raises(VoiceRefus) as exc:
            await moteur.synthesize("Salut.", cfg_tts())
        assert morceau in exc.value.message
        assert exc.value.code == code


class TestReseau:
    def test_proxy_de_l_environnement_ignore(self):
        client = moteur._client(5.0)
        assert client._trust_env is False

    async def test_verify_transmis(self, monkeypatch):
        vus = []
        vrai = moteur._client

        def espion(timeout, connect=5.0, verify=True):
            vus.append(verify)
            return vrai(timeout, connect, verify)

        monkeypatch.setattr(moteur, "_client", espion)
        branche(monkeypatch, lambda r: httpx.Response(200, content=b"RIFF"))
        await moteur.synthesize("Salut.", cfg_tts(verify=False))
        assert vus == [False]

    def test_delai_proportionnel_a_la_duree(self):
        assert moteur.delai_stt(30, 1000.0) == 30          # court : le réglage
        assert moteur.delai_stt(30, 30000.0) == 100        # 10 + 3 × 30
        assert moteur.delai_stt(30, 120000.0) == 180       # plafonné
        assert moteur.delai_stt(240, 120000.0) == 240      # sauf réglage plus haut

    async def test_transcribe_utilise_le_delai_proportionnel(self, monkeypatch):
        vus = []
        vrai = moteur._client

        def espion(timeout, connect=5.0, verify=True):
            vus.append(timeout)
            return vrai(timeout, connect, verify)

        monkeypatch.setattr(moteur, "_client", espion)
        branche(monkeypatch, lambda r: httpx.Response(200, json={"text": "x"}))
        await moteur.transcribe(WAV, cfg_stt(timeout_sec=10), 20000.0)
        assert vus == [70]


class TestListeModeles:
    async def test_whisper_cpp_un_seul_modele_sans_nom(self, monkeypatch):
        vues = branche(monkeypatch, lambda r: httpx.Response(200, json={"status": "ok"}))
        res = await moteur.liste_modeles("stt", cfg_stt(endpoint_url="http://stt:8090/inference"))
        assert str(vues[0].url) == "http://stt:8090/health"
        assert res["models"] == [{"id": "", "label": "Modèle chargé par le serveur"}]
        assert res["current"] == "" and res["source"] == "GET /health"
        assert "ignoré" in res["detail"]

    async def test_whisper_cpp_encore_en_chargement(self, monkeypatch):
        branche(monkeypatch, lambda r: httpx.Response(503, json={"status": "loading model"}))
        with pytest.raises(VoiceRefus) as exc:
            await moteur.liste_modeles("stt", cfg_stt())
        assert "charge encore" in exc.value.message

    async def test_whisper_cpp_ancien_sans_health(self, monkeypatch):
        def gestionnaire(requete):
            return httpx.Response(404) if requete.url.path == "/health" else httpx.Response(200, text="<html>")
        branche(monkeypatch, gestionnaire)
        res = await moteur.liste_modeles("stt", cfg_stt())
        assert res["source"] == "GET /"

    async def test_openai_v1_models(self, monkeypatch):
        vues = branche(monkeypatch, lambda r: httpx.Response(200, json={
            "object": "list", "data": [{"id": "whisper-1"}, {"id": "tts-1"}]}))
        res = await moteur.liste_modeles("stt", cfg_stt(
            format="openai", endpoint_url="http://o/v1/audio/transcriptions", model="whisper-1",
            token="k"))
        assert str(vues[0].url) == "http://o/v1/models"
        assert vues[0].headers["authorization"] == "Bearer k"
        assert [m["id"] for m in res["models"]] == ["whisper-1", "tts-1"]
        assert res["current"] == "whisper-1" and res["source"] == "GET /v1/models"

    async def test_openai_repli_sur_models(self, monkeypatch):
        def gestionnaire(requete):
            if requete.url.path == "/v1/models":
                return httpx.Response(404)
            return httpx.Response(200, json={"models": [{"name": "kokoro"}]})
        branche(monkeypatch, gestionnaire)
        res = await moteur.liste_modeles("tts", cfg_tts(format="openai"))
        assert res["models"] == [{"id": "kokoro", "label": "kokoro"}]
        assert res["current"] == "kokoro"          # élément unique
        assert res["source"] == "GET /models"

    async def test_llama_audio_passe_par_v1_models(self, monkeypatch):
        vues = branche(monkeypatch, lambda r: httpx.Response(200, json={"data": [{"id": "voxtral"}]}))
        res = await moteur.liste_modeles("stt", cfg_stt(format="llama-audio", endpoint_url="http://llm:8080/v1"))
        assert str(vues[0].url) == "http://llm:8080/v1/models"
        assert res["current"] == "voxtral"

    async def test_elpis_tts_voix_et_defaut_du_serveur(self, monkeypatch):
        vues = branche(monkeypatch, lambda r: httpx.Response(200, json={
            "default": "fr_FR-tom-medium",
            "installed": [{"name": "fr_FR-siwis-medium", "quality": "medium"},
                          {"name": "fr_FR-tom-medium", "quality": "medium"}]}))
        res = await moteur.liste_modeles("tts", cfg_tts(token="t"))
        assert vues[0].url.path == "/voices" and vues[0].headers["authorization"] == "Bearer t"
        assert res["models"][0] == {"id": "fr_FR-siwis-medium", "label": "fr_FR-siwis-medium (medium)"}
        # La voix chargée au démarrage par le serveur l'emporte sur la config.
        assert res["current"] == "fr_FR-tom-medium"

    async def test_piper_http_voices_et_info(self, monkeypatch):
        def gestionnaire(requete):
            if requete.url.path == "/voices":
                return httpx.Response(200, json={
                    "fr_FR-siwis-medium": {"audio": {"quality": "medium"}},
                    "fr_FR-upmc-medium": {"audio": {"quality": "medium"}}})
            if requete.url.path == "/info":
                return httpx.Response(200, json={"voice": {"name": "fr_FR-upmc-medium"}})
            return httpx.Response(404)
        branche(monkeypatch, gestionnaire)
        res = await moteur.liste_modeles("tts", cfg_tts(format="piper-http", endpoint_url="http://p:5000"))
        assert [m["id"] for m in res["models"]] == ["fr_FR-siwis-medium", "fr_FR-upmc-medium"]
        assert res["current"] == "fr_FR-upmc-medium"

    async def test_piper_http_ancien_sans_info(self, monkeypatch):
        def gestionnaire(requete):
            if requete.url.path == "/voices":
                return httpx.Response(200, json={"fr_FR-siwis-medium": {}})
            return httpx.Response(404)
        branche(monkeypatch, gestionnaire)
        res = await moteur.liste_modeles("tts", cfg_tts(format="piper-http"))
        assert res["current"] == "fr_FR-siwis-medium"

    async def test_voix_disponibles_piper(self, monkeypatch):
        branche(monkeypatch, lambda r: httpx.Response(200, json={"v1": {}, "v2": {}})
                if r.url.path == "/voices" else httpx.Response(404))
        assert await moteur.voix_disponibles(cfg_tts(format="piper-http")) == ["v1", "v2"]
