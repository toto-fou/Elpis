# SPDX-License-Identifier: MIT
"""Endpoints du moteur vocal — ``/api/voice/*``.

Trois routes, une doctrine : le navigateur envoie de l'audio ou du texte, jamais
une adresse. Tout ce qui désigne une machine vient de ``config.json``.

    GET  /api/voice/status      ce que le front a le droit d'afficher, et ses plafonds
    POST /api/voice/transcribe  un énoncé WAV 16 kHz mono -> du texte
    POST /api/voice/speak       du texte -> un WAV

Le découpage en phrases n'est PAS ici : il vit dans le navigateur, parce qu'il
doit travailler sur un flux en cours de génération. Le serveur, lui, nettoie le
markdown de chaque morceau qu'on lui confie — garantie d'exécution pour tout
appelant, présent ou futur.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from collections import deque
from typing import Any, Deque, Dict, Optional, Tuple

from fastapi import File, HTTPException, Request, Response, UploadFile

from shared_infra.accounts.users import get_user_settings
from shared_infra.files.uploads import read_upload_bounded
from shared_infra.routes._state import router
from shared_infra.security.deps import require_user_id
from shared_infra.voice import client as moteur
from shared_infra.voice.audio import DUREE_MINIMALE_MS, AudioInvalide, valide_wav_dictee
from shared_infra.voice.config import get_voice_config, voice_flags
from shared_infra.voice.errors import VoiceError
from shared_infra.voice.filtre import est_bruit
from shared_infra.voice.text import est_prononcable, pour_la_voix

logger = logging.getLogger("uvicorn.error")


# ---------------------------------------------------------------------------
#  Garde de concurrence
# ---------------------------------------------------------------------------
# Plafond PAR WORKER : avec plusieurs workers gunicorn, le plafond réel est
# multiplié d'autant. C'est assumé — un compteur partagé coûterait un aller-
# retour de verrou sur chaque phrase dictée, pour protéger une machine qui a
# déjà sa propre file d'attente.

# Attente maximale d'un créneau libre. Au-delà, 503 « occupé » plutôt qu'une
# file sans fond : le navigateur abandonne de toute façon, et une requête qui
# attend encore alors que l'utilisateur est passé à autre chose occupe un
# créneau pour rien quand elle finit par partir.
_ATTENTE_CRENEAU_MAX_SEC = 15


class _Jauge:
    """Sémaphore dont le plafond se change SANS perdre ses détenteurs.

    L'ancienne version recréait le sémaphore à chaque changement de plafond :
    les requêtes en cours relâchaient alors l'ANCIEN objet, et le nouveau
    laissait partir un plafond complet en plus d'elles. Ici l'objet reste le
    même ; monter le plafond libère des jetons, le baisser crée une « dette »
    que les prochains ``rendre()`` remboursent au lieu de libérer.
    """

    def __init__(self, capacite: int) -> None:
        self.capacite = capacite
        self._sem = asyncio.Semaphore(capacite)
        self._dette = 0

    async def _ajuste(self, capacite: int) -> None:
        ecart = capacite - self.capacite
        self.capacite = capacite
        if ecart > 0:
            rembourse = min(ecart, self._dette)
            self._dette -= rembourse
            for _ in range(ecart - rembourse):
                self._sem.release()
        elif ecart < 0:
            self._dette += -ecart
            # Jetons libres tout de suite : on les retire sans attendre.
            while self._dette and not self._sem.locked():
                await self._sem.acquire()
                self._dette -= 1

    async def prendre(self, capacite: int, attente_sec: float) -> None:
        """Prend un créneau ; ``asyncio.TimeoutError`` si l'attente expire."""
        if capacite != self.capacite:
            await self._ajuste(capacite)
        await asyncio.wait_for(self._sem.acquire(), attente_sec)

    def rendre(self) -> None:
        if self._dette:
            self._dette -= 1
        else:
            self._sem.release()


_jauges: Dict[str, _Jauge] = {}


def _jauge(nom: str, capacite: int) -> _Jauge:
    jauge = _jauges.get(nom)
    if jauge is None:
        jauge = _jauges[nom] = _Jauge(capacite)
    return jauge


async def _sous_plafond(nom: str, capacite: int, attente_sec: float, message: str, appel):
    """Exécute ``appel()`` dans un créneau, ou 503 si aucun ne se libère à temps."""
    jauge = _jauge(nom, capacite)
    try:
        await jauge.prendre(capacite, min(float(attente_sec), _ATTENTE_CRENEAU_MAX_SEC))
    except asyncio.TimeoutError as exc:
        logger.info("[voice] %s : aucun créneau libre (plafond %d)", nom, capacite)
        raise HTTPException(503, message) from exc
    try:
        return await appel()
    finally:
        jauge.rendre()


# ---------------------------------------------------------------------------
#  Limite de débit par utilisateur
# ---------------------------------------------------------------------------
# Fenêtre glissante d'une minute, EN MÉMOIRE ET PAR WORKER : avec N workers, un
# utilisateur peut aller jusqu'à N fois ces chiffres. C'est acceptable — le but
# est d'arrêter une boucle (front bogué, script) qui saturerait le moteur de
# tous, pas de facturer à l'unité. Les chiffres laissent de la marge à un usage
# réel : une dictée continue fait au plus une dizaine d'énoncés par minute, une
# lecture à voix haute une phrase toutes les deux ou trois secondes.
_FENETRE_SEC = 60.0
_DEBIT_MAX = {"transcribe": 60, "speak": 120}
_debits: Dict[Tuple[str, int], Deque[float]] = {}


def _controle_debit(route: str, uid: int) -> None:
    maintenant = time.monotonic()
    file = _debits.setdefault((route, uid), deque())
    while file and maintenant - file[0] > _FENETRE_SEC:
        file.popleft()
    if len(file) >= _DEBIT_MAX[route]:
        raise HTTPException(429, "Trop de requêtes vocales en une minute : patientez un instant.")
    file.append(maintenant)
    # Purge des utilisateurs inactifs, pour que le dict ne grossisse pas sans fin.
    if len(_debits) > 1024:
        for cle in [c for c, f in _debits.items() if not f or maintenant - f[-1] > _FENETRE_SEC]:
            _debits.pop(cle, None)


# ---------------------------------------------------------------------------
#  Petit cache de synthèse
# ---------------------------------------------------------------------------
# Relire deux fois le même message est le geste le plus courant après la
# première écoute. Huit clips suffisent à le couvrir ; au-delà on paie de la
# mémoire pour des phrases qu'on ne réentendra pas.
_CACHE_MAX_ENTREES = 8
_CACHE_MAX_OCTETS = 16 * 1024 * 1024
_cache_tts: Dict[str, Tuple[bytes, str]] = {}


def _cle_cache(texte: str, tts: Dict[str, Any]) -> str:
    """Tout ce qui change le son : moteur (adresse, format, modèle), voix, débit.

    Sans l'adresse ni le format, un changement de moteur continuait de servir
    les clips de l'ancien jusqu'à éviction.
    """
    parts = (tts.get("endpoint_url", ""), tts.get("format", ""), tts.get("model", ""),
             tts.get("voice", ""), str(float(tts.get("speed") or 1.0)), texte)
    return hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()[:32]


def _cache_lit(cle: str) -> Optional[Tuple[bytes, str]]:
    valeur = _cache_tts.pop(cle, None)
    if valeur is not None:
        _cache_tts[cle] = valeur              # remis en tête : le plus récent survit
    return valeur


def _cache_ecrit(cle: str, audio: bytes, mime: str) -> None:
    if len(audio) > _CACHE_MAX_OCTETS // 2:
        return                                # un clip énorme viderait le cache à lui seul
    _cache_tts[cle] = (audio, mime)
    while len(_cache_tts) > _CACHE_MAX_ENTREES or \
            sum(len(a) for a, _ in _cache_tts.values()) > _CACHE_MAX_OCTETS:
        _cache_tts.pop(next(iter(_cache_tts)))


# ---------------------------------------------------------------------------
#  Gardes communes
# ---------------------------------------------------------------------------

async def _reglages(uid: int) -> Dict[str, Any]:
    try:
        return await asyncio.to_thread(get_user_settings, uid) or {}
    except Exception:                                           # noqa: BLE001
        logger.warning("[voice] réglages illisibles pour uid=%s", uid)
        return {}


def _erreur(exc: VoiceError) -> HTTPException:
    """Traduit une panne du moteur en réponse HTTP, en journalisant le détail.

    Le détail (URL, classe d'exception) reste dans le journal : il nomme une
    machine du réseau interne et n'a rien à faire dans un toast utilisateur.
    """
    if exc.detail:
        logger.warning("[voice] %s — %s", exc.message, exc.detail)
    return HTTPException(exc.statut, exc.message)


# ---------------------------------------------------------------------------
#  Routes
# ---------------------------------------------------------------------------

@router.get("/api/voice/status")
async def api_voice_status(request: Request) -> Dict[str, Any]:
    """Ce que le front doit savoir pour cadencer son interface.

    Les plafonds viennent d'ici plutôt que d'être recopiés dans le JavaScript :
    une valeur changée en console admin s'applique au rechargement de la page,
    sans redéploiement.
    """
    uid = require_user_id(request)
    cfg = get_voice_config()
    stt_on, tts_on = voice_flags(cfg)
    reglages = await _reglages(uid)
    return {
        "stt": stt_on,
        "tts": tts_on,
        "dictation": stt_on and bool(reglages.get("voice_input_enabled")),
        "reply": tts_on and bool(reglages.get("voice_reply_enabled")),
        "language": cfg["stt"]["language"],
        "sample_rate": 16000,
        "max_utterance_sec": cfg["stt"]["max_utterance_sec"],
        "max_upload_mb": cfg["stt"]["max_upload_mb"],
        "max_chars": cfg["tts"]["max_chars"],
        "voice": cfg["tts"]["voice"],
    }


@router.post("/api/voice/transcribe")
async def api_voice_transcribe(request: Request, file: UploadFile = File(...)) -> Dict[str, Any]:
    """Un énoncé de dictée en WAV 16 kHz mono, transcrit.

    Rend toujours ``{"text": ...}``. Un texte VIDE n'est pas une erreur : c'est
    le cas normal quand l'énoncé ne contenait que du souffle. Le champ
    ``rejected`` dit pourquoi, pour le diagnostic, et le front l'ignore.
    """
    uid = require_user_id(request)
    cfg = get_voice_config()
    stt_on, _ = voice_flags(cfg)
    if not stt_on:
        raise HTTPException(403, "La dictée est désactivée sur cette instance.")
    reglages = await _reglages(uid)
    if not reglages.get("voice_input_enabled"):
        raise HTTPException(403, "La dictée est désactivée dans vos paramètres.")
    _controle_debit("transcribe", uid)

    stt = cfg["stt"]
    wav = await read_upload_bounded(file, int(stt["max_upload_mb"]) * 1024 * 1024)
    try:
        entete = valide_wav_dictee(wav, int(stt["max_utterance_sec"]))
    except AudioInvalide as exc:
        raise HTTPException(415, str(exc)) from exc

    # Trop court pour porter de la parole. On ne l'envoie pas : sur du silence,
    # whisper n'écrit pas « rien », il invente.
    if entete.duree_ms < DUREE_MINIMALE_MS:
        return {"text": "", "rejected": "trop court"}

    try:
        resultat = await _sous_plafond(
            "stt", int(stt["max_concurrent"]), float(stt["timeout_sec"]),
            "Moteur de dictée occupé : réessayez dans un instant.",
            lambda: moteur.transcribe(wav, stt, entete.duree_ms))
    except VoiceError as exc:
        raise _erreur(exc) from exc

    texte = (resultat.get("text") or "").strip()
    logprob = resultat.get("avg_logprob")

    def _rejet(raison: str) -> Dict[str, Any]:
        # Un rejet répond 200 avec un texte VIDE : sans cette trace, un énoncé
        # écarté est stricement invisible — côté utilisateur « il ne se passe
        # rien », côté journal une requête réussie de plus. On note la raison et
        # les chiffres qui permettent de trancher (filtre trop strict ? seuil de
        # confiance mal réglé ? micro trop loin ?), JAMAIS le texte lui-même :
        # ce sont les paroles de l'utilisateur.
        logger.info("[voice] énoncé écarté (%s) — %.0f ms, %d mot(s), logprob=%s",
                    raison, entete.duree_ms, len(texte.split()),
                    "n/a" if logprob is None else f"{logprob:.2f}")
        return {"text": "", "rejected": raison, "duration_ms": round(entete.duree_ms)}

    if not texte or est_bruit(texte, logprob, resultat.get("no_speech_prob")):
        return _rejet("bruit")

    if logprob is not None and logprob < float(stt["logprob_min"]):
        # Le modèle a produit des mots, mais sans y croire.
        return _rejet("confiance insuffisante")

    return {"text": texte, "duration_ms": round(entete.duree_ms)}


@router.post("/api/voice/speak")
async def api_voice_speak(request: Request) -> Response:
    """Un morceau de réponse, rendu en audio.

    ``auto: true`` signale une lecture automatique : elle exige le réglage
    « Réponse vocale » de l'utilisateur. Sans ce drapeau, c'est un clic sur
    « lire », qui ne dépend que de la disponibilité du service — sinon décocher
    la lecture automatique désactiverait aussi le bouton, ce que personne
    n'attend.
    """
    uid = require_user_id(request)
    cfg = get_voice_config()
    _, tts_on = voice_flags(cfg)
    if not tts_on:
        raise HTTPException(403, "La synthèse vocale est désactivée sur cette instance.")

    try:
        corps = await request.json()
    except Exception:                                           # noqa: BLE001
        corps = {}
    if not isinstance(corps, dict):
        raise HTTPException(400, "Le payload doit être un objet JSON.")

    if corps.get("auto") is True:
        reglages = await _reglages(uid)
        if not reglages.get("voice_reply_enabled"):
            raise HTTPException(403, "La réponse vocale est désactivée dans vos paramètres.")

    _controle_debit("speak", uid)

    tts = cfg["tts"]
    texte = pour_la_voix(str(corps.get("text") or ""), int(tts["max_chars"]))
    if not est_prononcable(texte):
        raise HTTPException(400, "Rien à lire dans ce texte.")

    # La voix vient de la configuration, pas du client : aucun réglage par
    # utilisateur ne l'expose, et l'accepter ouvrirait une entrée non validée
    # vers le service distant.
    cle = _cle_cache(texte, tts)
    en_cache = _cache_lit(cle)
    if en_cache is not None:
        audio, mime = en_cache
    else:
        try:
            audio, mime = await _sous_plafond(
                "tts", int(tts["max_concurrent"]), float(tts["timeout_sec"]),
                "Moteur de synthèse occupé : réessayez dans un instant.",
                lambda: moteur.synthesize(texte, tts))
        except VoiceError as exc:
            raise _erreur(exc) from exc
        _cache_ecrit(cle, audio, mime)

    return Response(
        content=audio,
        media_type=mime,
        headers={
            "Cache-Control": "no-store",
            "X-Elpis-Voice": tts["voice"],
            "X-Elpis-Chars": str(len(texte)),
        },
    )
