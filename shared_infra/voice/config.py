# SPDX-License-Identifier: MIT
"""Configuration du moteur vocal — défauts, bornes, lecture à chaud.

Un seul principe à retenir : ``get_voice_config()`` **relit le disque à chaque
appel**. Ce n'est pas de la prudence excessive, c'est le seul schéma qui marche
ici. Les constantes dérivées de ``_RAW`` à l'import (style ``VISION_*``) ne sont
rafraîchies que dans le worker qui a reçu le POST admin : avec plusieurs workers
gunicorn, l'utilisateur voyait son réglage s'appliquer une requête sur trois.
Même doctrine que ``feature_enabled`` (``shared_infra/config.py``).

Les bornes sont appliquées **ici**, à la lecture, et pas à l'écriture : le POST
admin écrit `config.json` tel quel, sans validation de schéma. Ce module est donc
le point de vérité — un `timeout_sec` à 9999 saisi à la main reste sans effet.

Lecture par ``config_view()`` (vue partagée, en lecture seule) et non par
``read_config_json()`` : ce dernier fait une copie profonde de TOUT
``config.json`` (≈ 400 Ko), et cette fonction tourne à chaque phrase dictée et à
chaque phrase lue, dans la boucle d'événements. Rien ici ne mute la vue : on
construit des dicts neufs, que l'appelant peut modifier à loisir.
"""

from __future__ import annotations

from typing import Any, Dict, Tuple

from shared_infra.config import config_view

# Formats de dialogue reconnus. Ce sont eux qui permettent de changer de moteur
# sans toucher au code : un whisper.cpp, un service compatible OpenAI, ou un
# llama-server chargé d'un GGUF audio (Voxtral, Qwen-Audio).
STT_FORMATS = ("whisper.cpp", "openai", "llama-audio")
# ``piper-http`` : le serveur officiel ``python -m piper.http_server`` de
# Piper 1.x (OHF-Voice/piper1-gpl), pour une installation faite à la main.
TTS_FORMATS = ("elpis-tts", "piper-http", "openai")

VOICE_DEFAULTS: Dict[str, Any] = {
    # Défaut OFF, à l'inverse du reste de la section ``features`` : une
    # fonctionnalité qui ouvre le micro ne s'allume jamais toute seule.
    "enabled": False,
    "stt": {
        "endpoint_url": "",
        "format": "whisper.cpp",
        "model": "",
        "language": "fr",
        "prompt": "",
        "token": "",
        # -1.0 et non -0.6 (la valeur du projet antérieur) : là-bas le seuil sert à
        # FAIRE REDIRE la phrase, ici il JETTE le texte en silence. Un micro
        # un peu loin suffit à passer sous -0.6 en parlant normalement.
        "logprob_min": -1.0,
        "timeout_sec": 30,
        "max_upload_mb": 10,
        "max_utterance_sec": 30,
        # 1 et non 2 : whisper-server traite UNE requête à la fois (verrou
        # global sur le modèle). En laisser partir deux ne fait qu'ajouter
        # l'attente de l'une au délai de l'autre, et la première à dépasser
        # part en 504 pendant que whisper continue de la calculer.
        "max_concurrent": 1,
        # Vérification du certificat TLS. À décocher pour un moteur servi en
        # HTTPS avec un certificat auto-signé sur le LAN.
        "verify": True,
    },
    "tts": {
        "endpoint_url": "",
        "format": "elpis-tts",
        # Exigé par le format ``openai`` (« tts-1 », « kokoro »…), ignoré par
        # les deux autres. Vide = non envoyé.
        "model": "",
        "token": "",
        "voice": "fr_FR-siwis-medium",
        "speed": 1.0,
        "timeout_sec": 30,
        "max_chars": 4000,
        "max_concurrent": 2,
        "verify": True,
    },
}

# (minimum, maximum) par clé numérique. Hors de ces plages, le moteur distant
# renvoie une erreur ou devient inutilisable — autant le borner ici.
_BORNES: Dict[str, Tuple[float, float]] = {
    "logprob_min": (-5.0, 0.0),
    "timeout_sec": (5, 300),
    "max_upload_mb": (1, 50),
    "max_utterance_sec": (3, 120),
    "max_concurrent": (1, 8),
    "speed": (0.5, 2.0),
    # 4000 au plus : c'est le plafond de ``tts_service`` (ELPIS_TTS_MAX_CHARS)
    # et, à 96 près, celui d'OpenAI (4096). Au-delà, le moteur répondait 413.
    # ``pour_la_voix`` tronque à la dernière fin de phrase sous ce plafond.
    "max_chars": (200, 4000),
}


def _texte(valeur: Any, defaut: str) -> str:
    # ``None`` d'abord : ``str(None)`` vaut « None », une chaîne non vide qui
    # passerait pour une adresse valide et ferait croire la fonction configurée.
    if valeur is None:
        return defaut
    try:
        v = str(valeur).strip()
    except Exception:                                           # noqa: BLE001
        return defaut
    return v or defaut


def _booleen(valeur: Any, defaut: bool) -> bool:
    """Booléen tolérant : le formulaire peut écrire ``"false"`` en texte."""
    if valeur is None:
        return defaut
    if isinstance(valeur, bool):
        return valeur
    texte = str(valeur).strip().lower()
    if not texte:
        return defaut
    return texte not in ("false", "0", "non", "no", "off")


def _nombre(cle: str, valeur: Any, defaut: float, entier: bool) -> float | int:
    bas, haut = _BORNES[cle]
    try:
        v = float(valeur)
    except (TypeError, ValueError):
        v = float(defaut)
    v = max(bas, min(haut, v))
    return int(round(v)) if entier else round(v, 3)


def get_voice_config() -> Dict[str, Any]:
    """Configuration vocale coercée (défauts + bornes), fraîche du disque.

    ``enabled`` est strict (``is True``) : une valeur douteuse laisse la
    fonctionnalité éteinte plutôt que de l'allumer par accident.
    """
    brut = (config_view() or {}).get("voice") or {}
    if not isinstance(brut, dict):
        brut = {}

    stt_brut = brut.get("stt") if isinstance(brut.get("stt"), dict) else {}
    tts_brut = brut.get("tts") if isinstance(brut.get("tts"), dict) else {}
    d_stt = VOICE_DEFAULTS["stt"]
    d_tts = VOICE_DEFAULTS["tts"]

    fmt_stt = _texte(stt_brut.get("format"), d_stt["format"]).lower()
    if fmt_stt not in STT_FORMATS:
        fmt_stt = d_stt["format"]
    fmt_tts = _texte(tts_brut.get("format"), d_tts["format"]).lower()
    if fmt_tts not in TTS_FORMATS:
        fmt_tts = d_tts["format"]

    return {
        "enabled": brut.get("enabled") is True,
        "stt": {
            # L'URL ne vient QUE d'ici. Jamais du client : ce serait une SSRF
            # offerte, le serveur applicatif ayant accès au réseau interne.
            "endpoint_url": _texte(stt_brut.get("endpoint_url"), "").rstrip("/"),
            "format": fmt_stt,
            "model": _texte(stt_brut.get("model"), ""),
            "language": _texte(stt_brut.get("language"), d_stt["language"]),
            "prompt": str(stt_brut.get("prompt") or "")[:2000],
            "token": str(stt_brut.get("token") or "").strip(),
            "logprob_min": _nombre("logprob_min", stt_brut.get("logprob_min"), d_stt["logprob_min"], False),
            "timeout_sec": _nombre("timeout_sec", stt_brut.get("timeout_sec"), d_stt["timeout_sec"], True),
            "max_upload_mb": _nombre("max_upload_mb", stt_brut.get("max_upload_mb"), d_stt["max_upload_mb"], True),
            "max_utterance_sec": _nombre("max_utterance_sec", stt_brut.get("max_utterance_sec"), d_stt["max_utterance_sec"], True),
            "max_concurrent": _nombre("max_concurrent", stt_brut.get("max_concurrent"), d_stt["max_concurrent"], True),
            "verify": _booleen(stt_brut.get("verify"), d_stt["verify"]),
        },
        "tts": {
            "endpoint_url": _texte(tts_brut.get("endpoint_url"), "").rstrip("/"),
            "format": fmt_tts,
            "model": _texte(tts_brut.get("model"), ""),
            "token": str(tts_brut.get("token") or "").strip(),
            "voice": _texte(tts_brut.get("voice"), d_tts["voice"]),
            "speed": _nombre("speed", tts_brut.get("speed"), d_tts["speed"], False),
            "timeout_sec": _nombre("timeout_sec", tts_brut.get("timeout_sec"), d_tts["timeout_sec"], True),
            "max_chars": _nombre("max_chars", tts_brut.get("max_chars"), d_tts["max_chars"], True),
            "max_concurrent": _nombre("max_concurrent", tts_brut.get("max_concurrent"), d_tts["max_concurrent"], True),
            "verify": _booleen(tts_brut.get("verify"), d_tts["verify"]),
        },
    }


def voice_flags(cfg: Dict[str, Any] | None = None) -> Tuple[bool, bool]:
    """``(reconnaissance, synthèse)`` — ce que le front a le droit d'afficher.

    Une adresse vide vaut « éteint » : sans elle, le bouton existerait mais
    n'aboutirait nulle part, et c'est exactement le réglage mort que le dépôt
    traque depuis l'audit du 2026-07-29.
    """
    cfg = cfg or get_voice_config()
    if not cfg.get("enabled"):
        return False, False
    return bool(cfg["stt"]["endpoint_url"]), bool(cfg["tts"]["endpoint_url"])
