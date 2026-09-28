# SPDX-License-Identifier: MIT
"""Le seul endroit qui parle aux services vocaux distants.

Trois dialectes en entrée, deux en sortie, et une règle qui ne bouge pas :
**l'URL vient exclusivement de ``config.json``**, écrite par un administrateur.
Jamais du client. Le serveur applicatif a accès au réseau interne ; accepter une
adresse venue du navigateur serait offrir une SSRF.

Reconnaissance :
  * ``whisper.cpp``   — ``POST /inference``, multipart, ``verbose_json``
  * ``openai``        — ``POST /v1/audio/transcriptions``
  * ``llama-audio``   — ``POST /v1/chat/completions`` avec une partie
                        ``input_audio`` (Voxtral, Qwen-Audio servis par
                        llama-server). Dépannage : ce modèle occupe le GPU du
                        LLM, ce n'est pas la configuration visée.

Synthèse :
  * ``elpis-tts``     — ``POST /tts`` (``deploy/voice/tts``)
  * ``piper-http``    — ``POST /synthesize`` du serveur officiel
                        ``python -m piper.http_server`` (Piper ≥ 1.5), repli
                        sur ``POST /`` (Piper 1.3–1.4, même corps JSON)
  * ``openai``        — ``POST /v1/audio/speech``

Réseau : ``trust_env=False``. Les moteurs vivent sur le LAN ; un ``HTTP_PROXY``
hérité de l'environnement sans ``NO_PROXY`` détournait les appels vers le proxy
d'entreprise, qui répondait 403 ou rien. ``verify`` (par section) permet un
certificat auto-signé.
"""

from __future__ import annotations

import base64
import logging
import re
from typing import Any, Dict, Optional, Tuple

import httpx

from shared_infra.voice.audio import audio_ctx_pour
from shared_infra.voice.errors import (
    VoiceDesactive,
    VoiceError,
    VoiceInjoignable,
    VoiceRefus,
    VoiceTimeout,
)

logger = logging.getLogger("uvicorn.error")

_THINK = re.compile(r"<think>[\s\S]*?</think>", re.I)

# Couture de test : les tests y posent un ``httpx.MockTransport`` pour vérifier
# la FORME exacte de ce qui part sur le réseau (multipart, champs, base64) sans
# lancer de serveur. Reste ``None`` en production — ``httpx`` choisit alors son
# transport normal.
_TRANSPORT = None


def _client(timeout: float, connect: float = 5.0, verify: bool = True) -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=connect),
                             transport=_TRANSPORT, trust_env=False,
                             verify=bool(verify))


# Délai d'un appel de reconnaissance : l'inférence dure à peu près en
# proportion de l'énoncé. 30 s d'audio sur CPU dépassaient les 30 s fixes et
# partaient en 504 pendant que whisper continuait de calculer pour rien. Le
# plafond évite qu'un moteur figé retienne la requête indéfiniment.
_STT_DELAI_FIXE_SEC = 10
_STT_DELAI_PAR_SEC = 3
_STT_DELAI_PLAFOND_SEC = 180


def delai_stt(timeout_sec: int, duree_ms: float) -> int:
    """``max(timeout_sec, 10 + 3 × durée)``, borné à 180 s (sauf réglage plus haut)."""
    proportionnel = _STT_DELAI_FIXE_SEC + _STT_DELAI_PAR_SEC * max(duree_ms, 0.0) / 1000.0
    return int(max(int(timeout_sec), min(proportionnel, _STT_DELAI_PLAFOND_SEC)))


# ---------------------------------------------------------------------------
#  Normalisation d'URL — on accepte une base OU une route complète
# ---------------------------------------------------------------------------
# L'administrateur colle ce qu'il a sous la main : « http://hote:8090 », parfois
# « http://hote:8090/inference ». Les deux doivent marcher, sinon le premier
# essai échoue sans que rien n'explique pourquoi.

def _url(base: str, suffixe: str) -> str:
    base = (base or "").rstrip("/")
    if not base:
        raise VoiceDesactive("Aucune adresse configurée pour le moteur vocal.")
    if base.endswith(suffixe):
        return base
    if suffixe.startswith("/v1/") and base.endswith("/v1"):
        return base + suffixe[3:]
    return base + suffixe


def _entetes(token: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {token}"} if token else {}


def _detail_http(reponse: httpx.Response) -> str:
    """Extrait un message lisible d'une réponse en erreur, quelle que soit sa forme."""
    try:
        corps = reponse.json()
        err = corps.get("error") if isinstance(corps, dict) else None
        if isinstance(err, dict):
            return str(err.get("message") or "")[:200]
        if err:
            return str(err)[:200]
        if isinstance(corps, dict) and corps.get("detail"):
            return str(corps["detail"])[:200]
    except Exception:                                           # noqa: BLE001
        pass
    return (reponse.text or "").strip()[:200]


def _message_http(code: int) -> str:
    """Ce qu'un code HTTP du moteur veut dire, et le geste qui le corrige."""
    if code in (401, 403):
        return "Jeton refusé par le moteur vocal : vérifiez le jeton."
    if code in (404, 405):
        return "Chemin introuvable sur le moteur vocal : vérifiez l'adresse et le format."
    if code == 413:
        return "Envoi trop volumineux pour le moteur vocal (texte ou audio trop long)."
    if code >= 500:
        return f"Le moteur vocal est en erreur (HTTP {code}) : consultez son journal."
    return f"Le moteur vocal a répondu HTTP {code}."


async def _poste(url: str, *, timeout: int, verify: bool = True, **kwargs) -> httpx.Response:
    """POST avec traduction des pannes réseau en erreurs parlantes."""
    try:
        async with _client(timeout, verify=verify) as client:
            reponse = await client.post(url, **kwargs)
    except httpx.TimeoutException as exc:
        raise VoiceTimeout("Le moteur vocal n'a pas répondu à temps.",
                           detail=f"{url} : {exc.__class__.__name__}") from exc
    except httpx.HTTPError as exc:
        raise VoiceInjoignable("Moteur vocal injoignable.",
                               detail=f"{url} : {exc.__class__.__name__}") from exc
    if reponse.status_code != 200:
        raise VoiceRefus(_message_http(reponse.status_code),
                         detail=_detail_http(reponse), code=reponse.status_code)
    return reponse


# ---------------------------------------------------------------------------
#  Reconnaissance
# ---------------------------------------------------------------------------

def _confiance(charge: Dict[str, Any]) -> Tuple[Optional[float], Optional[float]]:
    """``(avg_logprob moyen, no_speech_prob maximal)`` d'un ``verbose_json``.

    La moyenne plutôt que le minimum : un énoncé long fait plusieurs segments,
    et un seul segment hésitant ne doit pas jeter toute la phrase. ``None``
    quand le serveur ne fournit rien — l'appelant fait alors confiance.
    """
    segments = charge.get("segments") or []
    logprobs = [float(s["avg_logprob"]) for s in segments
                if isinstance(s, dict) and isinstance(s.get("avg_logprob"), (int, float))]
    silences = [float(s["no_speech_prob"]) for s in segments
                if isinstance(s, dict) and isinstance(s.get("no_speech_prob"), (int, float))]
    return (sum(logprobs) / len(logprobs) if logprobs else None,
            max(silences) if silences else None)


def _texte_transcrit(charge: Any) -> str:
    if isinstance(charge, dict):
        return str(charge.get("text") or "").strip()
    return str(charge or "").strip()


async def transcribe(wav: bytes, cfg: Dict[str, Any], duree_ms: float) -> Dict[str, Any]:
    """WAV 16 kHz mono en entrée, ``{text, avg_logprob, no_speech_prob}`` en sortie."""
    fmt = cfg["format"]
    timeout = delai_stt(int(cfg["timeout_sec"]), duree_ms)
    entetes = _entetes(cfg.get("token", ""))
    verify = cfg.get("verify", True)

    if fmt == "llama-audio":
        return await _transcribe_llama(wav, cfg, timeout, entetes)

    if fmt == "openai":
        url = _url(cfg["endpoint_url"], "/v1/audio/transcriptions")
        donnees: Dict[str, str] = {"response_format": "verbose_json",
                                   "language": cfg["language"],
                                   "temperature": "0"}
        if cfg.get("model"):
            donnees["model"] = cfg["model"]
        if cfg.get("prompt"):
            donnees["prompt"] = cfg["prompt"]
    else:
        url = _url(cfg["endpoint_url"], "/inference")
        donnees = {
            "temperature": "0.0",
            "temperature_inc": "0.0",
            # Contexte d'encodeur proportionnel à la durée : c'est le levier de
            # latence n°1 sur les phrases courtes. Il voyage PAR REQUÊTE, ce qui
            # permet de partager un whisper-server entre plusieurs appelants.
            "audio_ctx": str(audio_ctx_pour(duree_ms)),
            "beam_size": "1",
            "response_format": "verbose_json",
            "language": cfg["language"],
        }
        if cfg.get("prompt"):
            donnees["prompt"] = cfg["prompt"]

    async def _envoie(champs: Dict[str, str]) -> httpx.Response:
        return await _poste(url, timeout=timeout, verify=verify, headers=entetes,
                            files={"file": ("dictee.wav", wav, "audio/wav")},
                            data=champs)

    try:
        reponse = await _envoie(donnees)
    except VoiceRefus as exc:
        # Certains serveurs « compatibles OpenAI » ne connaissent que ``json``
        # et refusent ``verbose_json`` d'un 400. On retente sans : le texte
        # arrive, mais sans scores — le seuil de confiance ne s'applique alors
        # pas (même contrat que ``llama-audio``).
        if fmt != "openai" or exc.code != 400:
            raise
        logger.info("[voice] verbose_json refusé (HTTP 400) — repli sur json")
        reponse = await _envoie({**donnees, "response_format": "json"})
    try:
        charge = reponse.json()
    except ValueError:
        # Certains serveurs ignorent ``response_format`` et rendent du texte nu.
        return {"text": (reponse.text or "").strip(), "avg_logprob": None, "no_speech_prob": None}

    logprob, silence = _confiance(charge if isinstance(charge, dict) else {})
    return {"text": _texte_transcrit(charge), "avg_logprob": logprob, "no_speech_prob": silence}


async def _transcribe_llama(wav: bytes, cfg: Dict[str, Any], timeout: int,
                            entetes: Dict[str, str]) -> Dict[str, Any]:
    """Voie de dépannage : un GGUF audio servi par ``llama-server``.

    llama-server n'a pas de route de transcription ; l'audio passe par une
    partie ``input_audio`` de ``/v1/chat/completions``. Pas de score de
    confiance en retour — le filtre anti-hallucination reste le seul garde-fou.
    """
    url = _url(cfg["endpoint_url"], "/v1/chat/completions")
    consigne = cfg.get("prompt") or (
        "Transcris exactement ce qui est dit dans cet audio. "
        "Ne réponds rien d'autre que la transcription, sans commentaire ni ponctuation ajoutée."
    )
    corps: Dict[str, Any] = {
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": consigne},
                {"type": "input_audio",
                 "input_audio": {"data": base64.b64encode(wav).decode("ascii"), "format": "wav"}},
            ],
        }],
        "temperature": 0,
        "stream": False,
    }
    if cfg.get("model"):
        corps["model"] = cfg["model"]

    reponse = await _poste(url, timeout=timeout, verify=cfg.get("verify", True),
                           headers=entetes, json=corps)
    try:
        contenu = reponse.json()["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise VoiceRefus("Réponse inattendue du moteur audio.",
                         detail="format chat/completions non reconnu") from exc
    if isinstance(contenu, list):
        contenu = " ".join(p.get("text", "") for p in contenu if isinstance(p, dict))
    contenu = _THINK.sub("", str(contenu)).strip()
    if contenu.startswith("```"):
        contenu = re.sub(r"^```[a-zA-Z]*\n?|\n?```$", "", contenu).strip()
    return {"text": contenu, "avg_logprob": None, "no_speech_prob": None}


# ---------------------------------------------------------------------------
#  Synthèse
# ---------------------------------------------------------------------------

async def synthesize(texte: str, cfg: Dict[str, Any], *, voix: str = "") -> Tuple[bytes, str]:
    """Texte en entrée, ``(octets audio, type MIME)`` en sortie."""
    timeout = int(cfg["timeout_sec"])
    entetes = _entetes(cfg.get("token", ""))
    verify = cfg.get("verify", True)
    nom_voix = (voix or cfg["voice"]).strip()

    if cfg["format"] == "piper-http":
        reponse = await _synthese_piper(texte, cfg, nom_voix, timeout, entetes)
    else:
        if cfg["format"] == "openai":
            url = _url(cfg["endpoint_url"], "/v1/audio/speech")
            corps: Dict[str, Any] = {"input": texte, "voice": nom_voix,
                                     "response_format": "wav", "speed": cfg["speed"]}
            # ``model`` est exigé par OpenAI et la plupart des serveurs
            # compatibles (400/422 sans lui). Vide = non envoyé : le test de la
            # console admin le signale avant qu'on en arrive là.
            if cfg.get("model"):
                corps["model"] = cfg["model"]
        else:
            url = _url(cfg["endpoint_url"], "/tts")
            corps = {"text": texte, "voice": nom_voix, "speed": cfg["speed"]}
        reponse = await _poste(url, timeout=timeout, verify=verify,
                               headers=entetes, json=corps)
    audio = reponse.content
    if not audio:
        raise VoiceRefus("Le moteur de synthèse a rendu un son vide.")
    mime = (reponse.headers.get("content-type") or "audio/wav").split(";")[0].strip()
    if not mime.startswith("audio/"):
        mime = "audio/wav"
    return audio, mime


async def _synthese_piper(texte: str, cfg: Dict[str, Any], nom_voix: str,
                          timeout: int, entetes: Dict[str, str]) -> httpx.Response:
    """``python -m piper.http_server`` : POST JSON, WAV en retour.

    Le chemin a changé avec Piper 1.5 : ``POST /synthesize`` depuis, ``POST /``
    avant (1.3–1.4), où ``/`` ne sert plus qu'une page de démonstration en GET.
    On tente la route actuelle, puis l'ancienne sur 404/405. Même corps pour
    les deux : ``text``, ``voice`` (nom d'un .onnx du dossier de données — une
    voix inconnue retombe sur celle du démarrage, sans erreur) et
    ``length_scale``, l'INVERSE d'une vitesse (1,25 = plus lent).
    """
    base = (cfg["endpoint_url"] or "").rstrip("/")
    if not base:
        raise VoiceDesactive("Aucune adresse configurée pour le moteur vocal.")
    corps: Dict[str, Any] = {"text": texte}
    if nom_voix:
        corps["voice"] = nom_voix
    vitesse = float(cfg.get("speed") or 1.0)
    # À 1,0 on n'envoie rien : la voix garde le ``length_scale`` de sa propre
    # configuration (certaines voix sont réglées à 1,1 par leur auteur).
    if abs(vitesse - 1.0) > 1e-3:
        corps["length_scale"] = round(1.0 / vitesse, 3)
    verify = cfg.get("verify", True)
    if base.endswith("/synthesize"):
        return await _poste(base, timeout=timeout, verify=verify, headers=entetes, json=corps)
    try:
        return await _poste(base + "/synthesize", timeout=timeout, verify=verify,
                            headers=entetes, json=corps)
    except VoiceRefus as exc:
        if exc.code not in (404, 405):
            raise
    return await _poste(base + "/", timeout=timeout, verify=verify, headers=entetes, json=corps)


# ---------------------------------------------------------------------------
#  Sonde — ce que le bouton « Tester » de la console admin appelle
# ---------------------------------------------------------------------------

async def sonde_stt(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Envoie une seconde de silence et regarde si le service répond.

    Le silence est choisi exprès : le but est de valider le contrat HTTP, pas
    la qualité de la reconnaissance. Une transcription vide est un SUCCÈS.
    """
    import io
    import wave

    tampon = io.BytesIO()
    with wave.open(tampon, "wb") as sortie:
        sortie.setnchannels(1)
        sortie.setsampwidth(2)
        sortie.setframerate(16000)
        sortie.writeframes(b"\x00\x00" * 16000)
    resultat = await transcribe(tampon.getvalue(), cfg, 1000.0)
    return {"text": resultat.get("text", ""), "format": cfg["format"]}


async def sonde_tts(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Synthétise trois mots et compte les octets rendus."""
    audio, mime = await synthesize("Essai du moteur vocal.", cfg)
    voix = await voix_disponibles(cfg)
    return {"bytes": len(audio), "mime": mime, "voices": voix}


async def voix_disponibles(cfg: Dict[str, Any]) -> list:
    """Liste des voix installées, ou ``[]`` si le service ne sait pas répondre.

    Jamais bloquant pour l'appelant : c'est un confort d'interface (remplir la
    liste déroulante de la console), pas une condition de bon fonctionnement.
    """
    if cfg["format"] not in ("elpis-tts", "piper-http") or not cfg.get("endpoint_url"):
        return []
    try:
        liste = await liste_modeles("tts", cfg)
    except Exception:                                           # noqa: BLE001
        return []
    return [m["id"] for m in liste["models"] if m.get("id")]


# ---------------------------------------------------------------------------
#  Ce que les serveurs ont chargé — la liste déroulante de la console
# ---------------------------------------------------------------------------
# L'administrateur ne SAISIT plus un nom de modèle ou de voix : on demande au
# serveur ce qu'il a. Un nom tapé à la main était la première cause de
# « ça ne marche pas » (voix inconnue, modèle absent, faute de frappe).

# Routes d'appel qu'un administrateur colle parfois à la place de la base :
# on les retire pour retrouver la racine du service.
_ROUTES_CONNUES = ("/v1/audio/transcriptions", "/v1/audio/speech",
                   "/v1/chat/completions", "/inference", "/synthesize", "/tts")

_DELAI_LISTE_SEC = 5.0


def _racine(base: str) -> str:
    base = (base or "").rstrip("/")
    if not base:
        raise VoiceDesactive("Aucune adresse renseignée.")
    for route in _ROUTES_CONNUES:
        if base.endswith(route):
            return base[: -len(route)].rstrip("/")
    return base


async def _lit(url: str, cfg: Dict[str, Any]) -> httpx.Response:
    """GET court (5 s) avec les mêmes traductions de panne que ``_poste``."""
    try:
        async with _client(_DELAI_LISTE_SEC, connect=3.0,
                           verify=cfg.get("verify", True)) as client:
            reponse = await client.get(url, headers=_entetes(cfg.get("token", "")))
    except httpx.TimeoutException as exc:
        raise VoiceTimeout("Le moteur vocal n'a pas répondu à temps.",
                           detail=f"{url} : {exc.__class__.__name__}") from exc
    except httpx.HTTPError as exc:
        raise VoiceInjoignable("Moteur vocal injoignable.",
                               detail=f"{url} : {exc.__class__.__name__}") from exc
    if reponse.status_code != 200:
        raise VoiceRefus(_message_http(reponse.status_code),
                         detail=_detail_http(reponse), code=reponse.status_code)
    return reponse


def _json(reponse: httpx.Response) -> Any:
    try:
        return reponse.json()
    except ValueError as exc:
        raise VoiceRefus("Réponse inattendue du moteur vocal (JSON attendu).",
                         detail=(reponse.text or "")[:200]) from exc


def _courant(ids: list, configure: str, annonce: Optional[str] = None) -> Optional[str]:
    """L'élément à présélectionner : celui que le serveur annonce comme chargé,
    sinon celui déjà configuré s'il existe là-bas, sinon l'unique élément."""
    if annonce and annonce in ids:
        return annonce
    if configure and configure in ids:
        return configure
    return ids[0] if len(ids) == 1 else None


async def _modeles_openai(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """``GET /v1/models`` (OpenAI, llama-server, speaches…), repli ``/models``."""
    racine = _racine(cfg["endpoint_url"])
    urls = [racine + "/models"] if racine.endswith("/v1") else [racine + "/v1/models", racine + "/models"]
    reponse = None
    for n, url in enumerate(urls):
        try:
            reponse = await _lit(url, cfg)
            break
        except VoiceRefus as exc:
            if exc.code != 404 or n == len(urls) - 1:
                raise
    charge = _json(reponse)
    brut = []
    if isinstance(charge, dict):
        # ``data`` : forme OpenAI. ``models`` : forme Ollama / llama-server.
        brut = charge.get("data") or charge.get("models") or []
    elif isinstance(charge, list):
        brut = charge
    modeles, vus = [], set()
    for m in brut:
        ident = (m.get("id") or m.get("model") or m.get("name")) if isinstance(m, dict) else m
        ident = str(ident or "").strip()
        if ident and ident not in vus:
            vus.add(ident)
            modeles.append({"id": ident, "label": ident})
    ids = [m["id"] for m in modeles]
    return {"models": modeles, "current": _courant(ids, cfg.get("model", "")),
            "source": "GET " + url.removeprefix(racine)}


async def _modeles_whisper(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """whisper-server charge UN modèle (``-m``) et ne publie pas son nom.

    Aucune route ne le dit — ni ``/health`` (``{"status":"ok"}``), ni la page
    ``/`` — et le champ ``model`` n'est de toute façon pas envoyé par ce format.
    On vérifie seulement que le serveur est prêt, et on rend un élément unique.
    """
    racine = _racine(cfg["endpoint_url"])
    source = "GET /health"
    try:
        await _lit(racine + "/health", cfg)
    except VoiceRefus as exc:
        if exc.code == 503:
            raise VoiceRefus("whisper-server charge encore son modèle : réessayez dans un instant.",
                             code=503) from exc
        if exc.code != 404:
            raise
        # Versions antérieures à ``/health`` : la page d'accueil suffit à
        # prouver qu'un serveur répond.
        await _lit(racine + "/", cfg)
        source = "GET /"
    return {
        "models": [{"id": "", "label": "Modèle chargé par le serveur"}],
        "current": "",
        "source": source,
        "detail": "whisper-server ne publie pas le nom de son modèle ; "
                  "le champ Modèle est ignoré par ce format (choisi par -m au démarrage).",
    }


async def _voix_elpis(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """``GET /voices`` de ``tts_service`` (même jeton que la synthèse)."""
    charge = _json(await _lit(_racine(cfg["endpoint_url"]) + "/voices", cfg))
    if not isinstance(charge, dict):
        charge = {}
    modeles = []
    for v in charge.get("installed") or []:
        if not isinstance(v, dict) or not v.get("name"):
            continue
        qualite = str(v.get("quality") or "").strip()
        modeles.append({"id": str(v["name"]),
                        "label": f"{v['name']} ({qualite})" if qualite else str(v["name"])})
    ids = [m["id"] for m in modeles]
    return {"models": modeles,
            "current": _courant(ids, cfg.get("voice", ""), str(charge.get("default") or "")),
            "source": "GET /voices"}


async def _voix_piper(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """``GET /voices`` de piper.http_server : ``{nom: config de la voix}``.

    La voix chargée au démarrage (``-m``) est donnée par ``GET /info``
    (Piper ≥ 1.5) ; absente des versions plus anciennes, on s'en passe.
    """
    racine = _racine(cfg["endpoint_url"])
    charge = _json(await _lit(racine + "/voices", cfg))
    modeles = []
    for nom, conf in (charge.items() if isinstance(charge, dict) else []):
        qualite = ((conf or {}).get("audio") or {}).get("quality") if isinstance(conf, dict) else ""
        modeles.append({"id": str(nom), "label": f"{nom} ({qualite})" if qualite else str(nom)})
    annonce = None
    try:
        info = _json(await _lit(racine + "/info", cfg))
        annonce = str(((info or {}).get("voice") or {}).get("name") or "") or None
    except (VoiceError, AttributeError):
        pass
    ids = [m["id"] for m in modeles]
    return {"models": modeles, "current": _courant(ids, cfg.get("voice", ""), annonce),
            "source": "GET /voices"}


async def liste_modeles(section: str, cfg: Dict[str, Any]) -> Dict[str, Any]:
    """``{models: [{id, label}], current, source, detail?}`` selon le format.

    ``section`` = ``"stt"`` ou ``"tts"`` : un même format (``openai``) n'a pas
    le même sens des deux côtés — modèles d'un côté, modèles aussi de l'autre
    mais la VOIX reste un champ libre (OpenAI n'a pas de route qui les liste).
    """
    fmt = cfg.get("format", "")
    if section == "stt":
        if fmt == "whisper.cpp":
            return await _modeles_whisper(cfg)
        return await _modeles_openai(cfg)          # openai, llama-audio
    if fmt == "elpis-tts":
        return await _voix_elpis(cfg)
    if fmt == "piper-http":
        return await _voix_piper(cfg)
    return await _modeles_openai(cfg)
