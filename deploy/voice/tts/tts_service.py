# SPDX-License-Identifier: MIT
"""Service de synthèse vocale Elpis — Piper (ONNX, CPU) derrière HTTP.

Piper n'a pas de serveur : c'est une bibliothèque Python. Ce fichier l'enveloppe
dans le strict nécessaire pour qu'Elpis puisse lui demander un WAV.

Ce qui vient d'un projet antérieur :

* la voix est chargée **une fois** et gardée chaude — le premier appel à ONNX
  Runtime coûte ~300 ms d'allocation d'arènes, on le paie au démarrage ;
* ``normalize_audio=False`` — Piper normalise chaque appel indépendamment ; comme
  on l'appelle une fois par phrase, la normalisation ferait varier le volume
  d'une phrase à l'autre ;
* la hauteur (*pitch*) n'existe pas chez Piper : on annonce un autre taux
  d'échantillonnage et on compense la durée par ``length_scale``, pour que seule
  la hauteur bouge ;
* les bornes de réglages — au-delà, Piper produit du bruit ou rien.

Ce qui est propre à ce service : plusieurs voix chargées à la demande, jeton
d'accès optionnel, plafonds, et rien qui touche à une carte son.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import time
import wave
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
from fastapi import FastAPI, Header, HTTPException, Response
from pydantic import BaseModel

logging.basicConfig(level=os.environ.get("ELPIS_TTS_LOG", "info").upper())
logger = logging.getLogger("elpis-tts")

# --------------------------------------------------------------------------
# Configuration — tout par variable d'environnement (voir elpis-tts.service)
# --------------------------------------------------------------------------

VOICES_DIR = Path(os.environ.get("ELPIS_TTS_VOICES_DIR", "/opt/elpis-voice/voices"))
VOICE_DEFAUT = os.environ.get("ELPIS_TTS_VOICE", "fr_FR-siwis-medium")
TOKEN = os.environ.get("ELPIS_TTS_TOKEN", "").strip()
MAX_CHARS = int(os.environ.get("ELPIS_TTS_MAX_CHARS", "4000"))
MAX_CONCURRENT = max(1, int(os.environ.get("ELPIS_TTS_MAX_CONCURRENT", "2")))
MAX_VOICES_EN_MEMOIRE = max(1, int(os.environ.get("ELPIS_TTS_MAX_VOICES", "2")))
# Threads ONNX par synthèse. Par défaut ONNX Runtime prend TOUS les cœurs pour
# chaque session : deux synthèses en parallèle (MAX_CONCURRENT) se disputaient
# alors la machine entière et allaient chacune moins vite que seule. La moitié
# des cœurs par synthèse, avec 2 synthèses simultanées, remplit la machine
# sans la surcharger. 0 = laisser ONNX Runtime décider.
THREADS = int(os.environ.get("ELPIS_TTS_THREADS", str(max(1, (os.cpu_count() or 2) // 2))))

# Au-delà de ces bornes, Piper produit du bruit ou rien (relevé sur un projet antérieur).
BORNES = {
    "speed": (0.5, 2.0),
    "pitch": (0.7, 1.4),
    "noise_scale": (0.0, 1.5),
    "noise_w": (0.0, 2.0),
}

# Catalogue des voix françaises de rhasspy/piper-voices, vérifié le 2026-09.
CATALOGUE: List[Dict[str, Any]] = [
    {"name": "fr_FR-siwis-medium",  "dataset": "siwis",    "quality": "medium", "sample_rate": 22050, "size_mb": 63, "speakers": [], "genre": "femme"},
    {"name": "fr_FR-siwis-low",     "dataset": "siwis",    "quality": "low",    "sample_rate": 16000, "size_mb": 28, "speakers": [], "genre": "femme"},
    {"name": "fr_FR-upmc-medium",   "dataset": "upmc",     "quality": "medium", "sample_rate": 22050, "size_mb": 77, "speakers": ["jessica", "pierre"], "genre": "femme et homme"},
    {"name": "fr_FR-tom-medium",    "dataset": "tom",      "quality": "medium", "sample_rate": 44100, "size_mb": 64, "speakers": [], "genre": "homme"},
    {"name": "fr_FR-gilles-low",    "dataset": "gilles",   "quality": "low",    "sample_rate": 16000, "size_mb": 63, "speakers": [], "genre": "homme"},
    {"name": "fr_FR-mls-medium",    "dataset": "mls",      "quality": "medium", "sample_rate": 22050, "size_mb": 77, "speakers": ["125 locuteurs"], "genre": "variés"},
    {"name": "fr_FR-mls_1840-low",  "dataset": "mls_1840", "quality": "low",    "sample_rate": 16000, "size_mb": 63, "speakers": [], "genre": "homme"},
]


def borne(cle: str, valeur: Any) -> float:
    bas, haut = BORNES[cle]
    try:
        v = float(valeur)
    except (TypeError, ValueError):
        v = bas if cle in ("noise_scale", "noise_w") else 1.0
    return max(bas, min(haut, v))


# --------------------------------------------------------------------------
# Les voix du disque
# --------------------------------------------------------------------------

def chemin_voix(nom: str) -> Optional[Path]:
    """Le .onnx d'une voix, s'il est complet (le modèle ET sa config)."""
    nom = (nom or "").strip()
    # Pas de traversée de chemin : on n'accepte qu'un nom de voix.
    if not nom or "/" in nom or "\\" in nom or nom.startswith("."):
        return None
    onnx = VOICES_DIR / f"{nom}.onnx"
    if onnx.is_file() and Path(f"{onnx}.json").is_file():
        return onnx
    return None


def lit_meta(onnx: Path) -> Dict[str, Any]:
    try:
        brut = json.loads(Path(f"{onnx}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"sample_rate": 22050, "quality": "", "speakers": []}
    carte = brut.get("speaker_id_map") or {}
    return {
        "sample_rate": int((brut.get("audio") or {}).get("sample_rate", 22050)),
        "quality": (brut.get("audio") or {}).get("quality", ""),
        "speakers": [n for n, _ in sorted(carte.items(), key=lambda kv: kv[1])],
    }


def installees() -> List[Dict[str, Any]]:
    if not VOICES_DIR.is_dir():
        return []
    sortie = []
    for onnx in sorted(VOICES_DIR.glob("*.onnx")):
        if not Path(f"{onnx}.json").is_file():
            continue          # téléchargement incomplet : la voix n'existe pas
        meta = lit_meta(onnx)
        sortie.append({
            "name": onnx.name.removesuffix(".onnx"),
            "sample_rate": meta["sample_rate"],
            "quality": meta["quality"],
            "speakers": meta["speakers"],
            "size_mb": round(onnx.stat().st_size / (1024 * 1024), 1),
        })
    return sortie


# --------------------------------------------------------------------------
# Le moteur
# --------------------------------------------------------------------------

class Moteur:
    """Voix Piper chargées à la demande, gardées chaudes, plafonnées en nombre.

    Le chargement est bloquant et coûte quelques centaines de millisecondes :
    il se fait dans un thread, sous verrou, et jamais deux fois pour la même
    voix. ``MAX_VOICES_EN_MEMOIRE`` évite qu'un client qui passe en revue le
    catalogue ne fasse gonfler le service indéfiniment.
    """

    def __init__(self) -> None:
        self._voix: Dict[str, Any] = {}          # nom -> (PiperVoice, taux, locuteurs)
        self._ordre: List[str] = []              # du plus ancien au plus récent
        self._verrou = asyncio.Lock()

    async def charge(self, nom: str):
        if nom in self._voix:
            return self._voix[nom]
        async with self._verrou:
            if nom in self._voix:                # quelqu'un d'autre l'a chargée pendant l'attente
                return self._voix[nom]
            onnx = chemin_voix(nom)
            if onnx is None:
                raise HTTPException(404, f"Voix absente du disque : {nom}")
            triplet = await asyncio.to_thread(self._charge_bloquant, onnx)
            self._voix[nom] = triplet
            self._ordre.append(nom)
            while len(self._ordre) > MAX_VOICES_EN_MEMOIRE:
                vieux = self._ordre.pop(0)
                self._voix.pop(vieux, None)
                logger.info("voix déchargée : %s", vieux)
            return triplet

    @staticmethod
    def _charge_bloquant(onnx: Path):
        try:
            from piper import PiperVoice
        except ImportError as exc:               # pragma: no cover — dépend de l'installation
            raise HTTPException(503, "piper-tts n'est pas installé dans ce venv.") from exc
        debut = time.monotonic()
        try:
            voice = PiperVoice.load(str(onnx), config_path=f"{onnx}.json")
            if THREADS > 0:
                # ``PiperVoice.load`` crée sa session avec des options par
                # défaut, sans paramètre pour les threads. ``session`` est un
                # simple champ de la dataclass : on le remplace par une session
                # bornée. Coût : un second chargement du modèle, une fois.
                import onnxruntime

                options = onnxruntime.SessionOptions()
                options.intra_op_num_threads = THREADS
                options.inter_op_num_threads = 1
                voice.session = onnxruntime.InferenceSession(
                    str(onnx), sess_options=options, providers=["CPUExecutionProvider"])
        except Exception as exc:
            raise HTTPException(500, f"Voix illisible ({onnx.name}) : {exc}") from exc
        taux = int(voice.config.sample_rate)
        locuteurs = {str(k): int(v) for k, v in (getattr(voice.config, "speaker_id_map", None) or {}).items()}
        logger.info("voix chargée : %s (%d Hz, %d ms)", onnx.name, taux, (time.monotonic() - debut) * 1000)
        return voice, taux, locuteurs

    @staticmethod
    def _config_synthese(locuteurs: Dict[str, int], speaker: str,
                         speed: float, pitch: float,
                         noise_scale: float, noise_w: float):
        from piper import SynthesisConfig

        sid: Optional[int] = None
        speaker = (speaker or "").strip()
        if speaker and locuteurs:
            if speaker in locuteurs:
                sid = locuteurs[speaker]
            elif speaker.isdigit() and int(speaker) in locuteurs.values():
                sid = int(speaker)
        return SynthesisConfig(
            speaker_id=sid,
            # Plus aigu = joué plus vite : on allonge d'autant la synthèse pour
            # que le débit ne bouge pas, seule la hauteur change.
            length_scale=pitch / speed,
            noise_scale=noise_scale,
            noise_w_scale=noise_w,
            normalize_audio=False,
            volume=1.0,
        )

    async def synthetise(self, texte: str, nom: str, speed: float, pitch: float,
                         noise_scale: float, noise_w: float, speaker: str) -> tuple[bytes, int]:
        voice, taux_voix, locuteurs = await self.charge(nom)
        syn = self._config_synthese(locuteurs, speaker, speed, pitch, noise_scale, noise_w)
        taux_lecture = int(round(taux_voix * pitch))

        def produit() -> np.ndarray:
            morceaux = [
                np.asarray(c.audio_float_array, dtype=np.float32).reshape(-1)
                for c in voice.synthesize(texte, syn_config=syn)
            ]
            if not morceaux:
                return np.zeros(0, dtype=np.float32)
            return np.concatenate(morceaux)

        pcm = await asyncio.to_thread(produit)
        return wav_bytes(pcm, taux_lecture), taux_lecture


def wav_bytes(pcm: np.ndarray, taux: int) -> bytes:
    """Float32 [-1, 1] -> WAV PCM 16 bits mono. Écrêtage avant conversion :
    sans lui, un dépassement repasse par zéro et s'entend comme un craquement."""
    tampon = io.BytesIO()
    plat = np.clip(np.asarray(pcm, dtype=np.float32).reshape(-1), -1.0, 1.0)
    entiers = (plat * 32767.0).astype("<i2")
    with wave.open(tampon, "wb") as sortie:
        sortie.setnchannels(1)
        sortie.setsampwidth(2)
        sortie.setframerate(taux)
        sortie.writeframes(entiers.tobytes())
    return tampon.getvalue()


MOTEUR = Moteur()
SEMAPHORE = asyncio.Semaphore(MAX_CONCURRENT)


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

class DemandeTts(BaseModel):
    text: str
    voice: Optional[str] = None
    speed: Optional[float] = None
    pitch: Optional[float] = None
    noise_scale: Optional[float] = None
    noise_w: Optional[float] = None
    speaker: Optional[str] = None


class DemandeOpenAi(BaseModel):
    input: str
    model: Optional[str] = None
    voice: Optional[str] = None
    speed: Optional[float] = None
    response_format: Optional[str] = None


def verifie_jeton(entete: Optional[str]) -> None:
    """Jeton optionnel. Absent de la configuration = service ouvert sur le LAN,
    ce qui est un choix assumé ; renseigné, il est exigé."""
    if not TOKEN:
        return
    attendu = f"Bearer {TOKEN}"
    if (entete or "") != attendu:
        raise HTTPException(401, "Jeton manquant ou invalide.")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await _prechauffe()
    yield


app = FastAPI(title="Elpis — synthèse vocale", docs_url=None, redoc_url=None, lifespan=lifespan)


async def _prechauffe() -> None:
    """Première synthèse à vide : ONNX Runtime alloue ses arènes et spécialise
    ses noyaux au premier appel. ~300 ms payés ici plutôt qu'à la première
    réponse lue à l'utilisateur."""
    if chemin_voix(VOICE_DEFAUT) is None:
        logger.warning("voix par défaut absente : %s (dossier %s)", VOICE_DEFAUT, VOICES_DIR)
        return
    try:
        await MOTEUR.synthetise("Bonjour.", VOICE_DEFAUT, 1.0, 1.0, 0.667, 0.8, "")
        logger.info("préchauffage terminé (%s)", VOICE_DEFAUT)
    except Exception as exc:                     # pragma: no cover — dépend du disque
        logger.warning("préchauffage impossible : %s", exc)


@app.get("/health")
async def health() -> Dict[str, Any]:
    onnx = chemin_voix(VOICE_DEFAUT)
    meta = lit_meta(onnx) if onnx else {}
    return {
        "ok": onnx is not None,
        "service": "elpis-tts",
        "voice": VOICE_DEFAUT,
        "sample_rate": meta.get("sample_rate"),
        "voices_dir": str(VOICES_DIR),
        "installed": len(installees()),
        "loaded": list(MOTEUR._voix.keys()),
        "max_chars": MAX_CHARS,
        "threads": THREADS,
    }


@app.get("/voices")
async def voices(authorization: Optional[str] = Header(None)) -> Dict[str, Any]:
    verifie_jeton(authorization)
    presentes = {v["name"] for v in installees()}
    return {
        "default": VOICE_DEFAUT,
        "installed": installees(),
        "catalogue": [dict(v, installed=v["name"] in presentes) for v in CATALOGUE],
    }


async def _synthese(texte: str, voix: Optional[str], speed: Any, pitch: Any,
                    noise_scale: Any, noise_w: Any, speaker: Any) -> Response:
    texte = (texte or "").strip()
    if not texte:
        raise HTTPException(400, "Texte vide.")
    if len(texte) > MAX_CHARS:
        raise HTTPException(413, f"Texte trop long ({len(texte)} > {MAX_CHARS} caractères).")

    nom = (voix or VOICE_DEFAUT).strip() or VOICE_DEFAUT
    debut = time.monotonic()
    async with SEMAPHORE:
        wav, taux = await MOTEUR.synthetise(
            texte, nom,
            borne("speed", speed if speed is not None else 1.0),
            borne("pitch", pitch if pitch is not None else 1.0),
            borne("noise_scale", noise_scale if noise_scale is not None else 0.667),
            borne("noise_w", noise_w if noise_w is not None else 0.8),
            str(speaker or ""),
        )
    duree_ms = (time.monotonic() - debut) * 1000
    audio_ms = max(1.0, (len(wav) - 44) / 2.0 / taux * 1000.0)
    logger.info("synthèse : %d car. -> %.0f ms d'audio en %.0f ms (x%.1f temps réel)",
                len(texte), audio_ms, duree_ms, audio_ms / max(duree_ms, 1.0))
    return Response(
        content=wav,
        media_type="audio/wav",
        headers={
            "X-Elpis-Voice": nom,
            "X-Elpis-Sample-Rate": str(taux),
            "X-Elpis-Synth-Ms": str(int(duree_ms)),
            "Cache-Control": "no-store",
        },
    )


@app.post("/tts")
async def tts(demande: DemandeTts, authorization: Optional[str] = Header(None)) -> Response:
    verifie_jeton(authorization)
    return await _synthese(demande.text, demande.voice, demande.speed, demande.pitch,
                           demande.noise_scale, demande.noise_w, demande.speaker)


@app.post("/v1/audio/speech")
async def openai_speech(demande: DemandeOpenAi, authorization: Optional[str] = Header(None)) -> Response:
    """Alias compatible OpenAI — permet de substituer un autre moteur (Kokoro
    FastAPI, par exemple) sans rien changer côté Elpis."""
    verifie_jeton(authorization)
    if demande.response_format and demande.response_format not in ("wav", "pcm"):
        raise HTTPException(400, "Seul le format wav est rendu par ce service.")
    return await _synthese(demande.input, demande.voice, demande.speed, 1.0, None, None, "")


if __name__ == "__main__":                       # pragma: no cover
    import uvicorn

    uvicorn.run(app,
                host=os.environ.get("ELPIS_TTS_HOST", "127.0.0.1"),
                port=int(os.environ.get("ELPIS_TTS_PORT", "8091")),
                log_level=os.environ.get("ELPIS_TTS_LOG", "info"))
