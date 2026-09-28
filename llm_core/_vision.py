# SPDX-License-Identifier: MIT
"""
backend.services._vision — Vision — Per-user screenshot tracking and downsampling.

Helpers that track the most recent Playwright screenshot associated with
a user so it can be transparently re-injected on the next vision-capable
LLM turn. Handles image downscaling to respect the model's max pixel
budget.
"""
from __future__ import annotations

import base64
import io
import logging
from typing import Optional

import httpx

from shared_infra.config import LLAMA_URL
# Module-level mutable state (caches + constants) lives in _constants
# (single source of truth shared across services).
from llm_core._constants import (
    _VISION_CAPABILITY_CACHE,   # dict — mutated here
    _VISION_MODEL_PATTERNS,     # tuple of regex patterns (const)
    _VISION_MAX_WIDTH,          # int (const)
    _VISION_JPEG_QUALITY,       # int (const)
    _LAST_SCREENSHOT,           # dict — mutated here
)

logger = logging.getLogger("uvicorn.error")


def _entry_has_vision(entry: dict) -> bool:
    """Détection de la capacité vision depuis UNE entrée de ``/v1/models``
    (llama.cpp expose plusieurs formes possibles selon la version)."""
    return bool(
        entry.get("multimodal") is True
        or "vision" in (entry.get("capabilities") or [])
        or "image" in (entry.get("modalities") or [])
        or (entry.get("meta") or {}).get("has_mmproj")
    )


def _entry_has_capability_meta(entry: dict) -> bool:
    """L'entrée ``/v1/models`` porte-t-elle des métadonnées de capacité
    (présentes seulement pour un modèle CHARGÉ) ?"""
    return bool(
        "multimodal" in entry or "capabilities" in entry or "modalities" in entry
        or (isinstance(entry.get("meta"), dict) and entry.get("meta"))
    )


def vision_flag_from_entry(entry: dict) -> bool:
    """Capacité vision d'un modèle depuis son entrée ``/v1/models`` DÉJÀ
    téléchargée — AUCUN réseau.

    AUDIT 2026-09-01 (passe 6, B8) — ``_refresh_model_cache`` appelait
    ``_model_supports_vision`` par modèle : un ``AsyncClient`` NEUF + un
    re-download de la liste ``/v1/models`` COMPLÈTE par modèle non caché,
    alors que l'appelant venait de la télécharger. Même détection +
    même repli pattern-match ; le cache est RAFRAÎCHI à chaque passage (un
    modèle remplacé sous le même id ne garde plus un flag périmé à vie —
    l'ancien cache n'avait aucune invalidation)."""
    model_name = str(entry.get("id") or "")
    if not model_name:
        return False
    has_vision = _entry_has_vision(entry)
    if not has_vision:
        lname = model_name.lower()
        has_vision = any(p in lname for p in _VISION_MODEL_PATTERNS)
    prev = _VISION_CAPABILITY_CACHE.get(model_name)
    # (passe 7, R6) — jamais de RÉTROGRADATION True→False sur une entrée qui
    # ne porte AUCUNE métadonnée de capacité (modèle déchargé : llama.cpp
    # n'expose ``meta``/``capabilities`` que pour un modèle chargé) : le flag
    # établi depuis les métadonnées réelles survit au déchargement. Une entrée
    # QUI porte des métadonnées reste autoritaire (modèle remplacé sous le
    # même id).
    if prev is True and not has_vision and not _entry_has_capability_meta(entry):
        has_vision = True
    _VISION_CAPABILITY_CACHE[model_name] = has_vision
    if has_vision and prev is not True:
        logger.info("[vision] Modèle %s détecté comme vision-capable", model_name)
    return has_vision


async def _model_supports_vision(model_name: str) -> bool:
    """Retourne True si le modèle supporte la vision multimodale.

    Stratégie :
    1. Vérifie le cache interne
    2. Query ``/v1/models`` du SERVEUR DE LA CIBLE pour la capability officielle
    3. Fallback : pattern-match sur le nom du modèle

    AUDIT 2026-09-16 — la sonde visait ``LLAMA_URL`` en dur : un modèle servi
    par un connecteur était jugé sur l'entrée HOMONYME du serveur intégré. On
    interroge désormais le serveur de la cible courante (avec son en-tête
    d'auth), et le cache est indexé par (serveur, modèle).
    """
    if not model_name:
        return False
    try:
        from llm_core.engines import current_engine
        _eng = current_engine()
    except Exception:                                           # noqa: BLE001
        _eng = None
    _ck = _eng.cache_key(model_name) if _eng is not None else model_name
    if _ck in _VISION_CAPABILITY_CACHE:
        return _VISION_CAPABILITY_CACHE[_ck]

    has_vision = False
    # Query /v1/models pour voir si le modèle expose multimodal
    try:
        if _eng is None or _eng.is_builtin:
            base = LLAMA_URL.rstrip("/")
            # LLAMA_URL pointe vers /v1/chat/completions, on remonte
            if base.endswith("/chat/completions"):
                base = base[: -len("/chat/completions")]
            base_v1 = base if base.endswith("/v1") else base + "/v1"
            _hdrs = None
        else:
            base_v1 = _eng.base_root + "/v1"
            _hdrs = _eng.header_dict() or None
        async with httpx.AsyncClient(timeout=3.0) as c:
            r = await c.get(f"{base_v1}/models", headers=_hdrs)
            if r.status_code == 200:
                data = r.json()
                for m in data.get("data", []):
                    if m.get("id") == model_name:
                        has_vision = _entry_has_vision(m)
                        break
    except Exception as e:
        logger.debug("[vision] /v1/models query failed: %s", e)

    # Fallback : pattern-match sur le nom (plus permissif)
    if not has_vision:
        lname = model_name.lower()
        has_vision = any(p in lname for p in _VISION_MODEL_PATTERNS)

    _VISION_CAPABILITY_CACHE[_ck] = has_vision
    if has_vision:
        logger.info("[vision] Modèle %s détecté comme vision-capable", model_name)
    return has_vision


def _downscale_screenshot(png_bytes: bytes) -> Optional[bytes]:
    """Downscale une screenshot PNG à _VISION_MAX_WIDTH de large + conversion JPEG.
    Renvoie les bytes JPEG compressés, ou None si Pillow indisponible/erreur."""
    try:
        from PIL import Image
    except ImportError:
        logger.warning("[vision] Pillow non installé, screenshot non downscalée")
        return png_bytes  # on envoie tel quel, le modèle décidera
    try:
        img = Image.open(io.BytesIO(png_bytes))
        # Conversion RGB (au cas où PNG avec alpha) pour JPEG
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        # Downscale si plus large que cible (préserve ratio)
        if img.width > _VISION_MAX_WIDTH:
            ratio = _VISION_MAX_WIDTH / img.width
            new_h = int(img.height * ratio)
            img = img.resize((_VISION_MAX_WIDTH, new_h), Image.LANCZOS)
        out = io.BytesIO()
        img.save(out, format="JPEG", quality=_VISION_JPEG_QUALITY, optimize=True)
        return out.getvalue()
    except Exception as e:
        logger.warning("[vision] Downscale échoué: %s", e)
        return None


def _track_last_screenshot_for_vision(chat_key: str, png_path: str) -> None:
    """Appelé après chaque screenshot pw_* pour la garder accessible au LLM vision.
    chat_key = username + chat_id (ou juste username si pas de chat_id)."""
    try:
        with open(png_path, "rb") as f:
            raw = f.read()
        compressed = _downscale_screenshot(raw)
        if compressed:
            # AUDIT 2026-08-02 (F5) — move-to-end : retirer la clé AVANT de la
            # réassigner. Un dict conserve la position d'INSERTION d'une clé
            # réécrite ; sans ce pop, le cap FIFO ci-dessous pouvait évincer la
            # frame d'un chat ACTIF (réécrite mais restée en tête) au profit
            # d'entrées insérées après mais moins récemment utilisées. Le pop
            # rend l'éviction LRU.
            _LAST_SCREENSHOT.pop(chat_key, None)
            _LAST_SCREENSHOT[chat_key] = compressed
            # AUDIT 2026-08-02 (M1) — cap FIFO de sécurité (même patron que
            # _desktop_session) : la purge nominale vit dans le finally de
            # run_chat_multi_mcp, ce cap borne le pire cas (~32 × 400 Ko
            # ≈ 12 Mo max par worker) quel que soit le chemin.
            _MAX_TRACKED = 32
            while len(_LAST_SCREENSHOT) > _MAX_TRACKED:
                _LAST_SCREENSHOT.pop(next(iter(_LAST_SCREENSHOT)), None)
            logger.debug("[vision] Screenshot trackée pour %s: %d → %d bytes",
                         chat_key, len(raw), len(compressed))
    except Exception as e:
        logger.debug("[vision] Track screenshot échoué: %s", e)


def _get_last_screenshot_b64(chat_key: str) -> Optional[str]:
    """Retourne la dernière screenshot en base64 data URL, prête à injecter dans
    un content multimodal OpenAI-compatible. None si pas de screenshot dispo."""
    img_bytes = _LAST_SCREENSHOT.get(chat_key)
    if not img_bytes:
        return None
    b64 = base64.b64encode(img_bytes).decode("ascii")
    return f"data:image/jpeg;base64,{b64}"


def _clear_last_screenshot_for(chat_key: str) -> None:
    """Libère la mémoire de la dernière screenshot (fin de chat, nouveau chat…)."""
    _LAST_SCREENSHOT.pop(chat_key, None)
