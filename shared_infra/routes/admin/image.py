# SPDX-License-Identifier: MIT
"""Console d'administration du moteur d'images.

    POST /api/admin/image/test    sonde le moteur (valeurs du FORMULAIRE)
    POST /api/admin/image/models  ce que le moteur propose (liste déroulante)
    GET  /api/admin/image/key     ``{has_key}``
    PUT  /api/admin/image/key     enregistre la clé API, chiffrée ; vide = effacer

Même contrat que la voix (``integrations.py``) : test et modèles répondent
toujours HTTP 200 avec ``ok`` — un test raté n'est pas une requête ratée — et
les champs du formulaire priment sur la configuration enregistrée, pour tester
AVANT d'enregistrer. Le reste du bloc ``image`` s'enregistre champ par champ
(``PATCH /api/admin/config``) ; ``image.api_key_enc`` y est une zone possédée.

La clé n'est jamais renvoyée. Elle est scellée avec l'origine du moteur
(``config.seal_api_key``) : elle ne part que vers cette origine, en test comme
en génération ; une autre adresse n'emporte que la clé saisie dans le
formulaire (sinon aucune). ``has_key`` dit si une clé est utilisable pour
l'adresse enregistrée, ``stale`` qu'il en existe une pour une autre adresse.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Dict, List

from fastapi import HTTPException, Request

from shared_infra.image.config import (
    PROVIDERS,
    api_key,
    engine_origin,
    get_image_config,
    image_ready,
    key_state,
    seal_api_key,
    write_api_key,
)
from shared_infra.routes._helpers import _require_admin
from shared_infra.routes.admin._state import admin_router

logger = logging.getLogger("uvicorn.error")

_KEY_MAX = 4096
_CA_MAX = 64 * 1024


async def _body(request: Request) -> Dict[str, Any]:
    try:
        data = await request.json()
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _norm_url(url: Any) -> str:
    return str(url or "").strip().rstrip("/")


def _merged(data: Dict[str, Any]) -> Dict[str, Any]:
    """Configuration enregistrée + surcharges du formulaire."""
    cfg = dict(get_image_config())
    provider = str(data.get("provider") or "").strip().lower()
    if provider in PROVIDERS:
        cfg["provider"] = provider
    if data.get("url") is not None:
        cfg["url"] = _norm_url(data["url"])
    if data.get("model") is not None:
        cfg["model"] = str(data["model"]).strip()
    if data.get("verify") is not None:
        cfg["verify"] = data["verify"] is not False and \
            str(data["verify"]).strip().lower() not in ("false", "0")
    if data.get("ca_pem") is not None:
        cfg["ca_pem"] = str(data["ca_pem"]).strip()[:_CA_MAX]
    # Clé saisie, sinon la clé enregistrée SI elle est scellée pour l'origine
    # de l'adresse testée (``api_key`` le vérifie).
    typed = str(data.get("api_key") or "").strip()
    cfg["api_key"] = typed or api_key(cfg)
    # Un test ne fait jamais patienter l'opérateur plus de 30 s.
    cfg["timeout_sec"] = min(int(cfg.get("timeout_sec") or 30), 30)
    return cfg


@admin_router.post("/api/admin/image/test")
async def api_admin_image_test(request: Request) -> Dict[str, Any]:
    """``{ok, provider, model, mode, limits, defaults, latency_ms, has_key,
    enabled, ready, warnings, error?}``"""
    _require_admin(request)
    data = await _body(request)
    from llm_core.imagegen.base import ImageError
    from llm_core.imagegen.service import forget_capabilities, get_provider

    saved = get_image_config()
    cfg = _merged(data)
    out: Dict[str, Any] = {"ok": False, "provider": cfg["provider"], **key_state(saved),
                           "enabled": saved["enabled"], "ready": image_ready(saved)}
    if not cfg["url"]:
        out["error"] = "Aucune adresse renseignée."
        return out
    forget_capabilities()
    t0 = time.monotonic()
    try:
        caps = await get_provider(cfg).capabilities()
    except ImageError as exc:
        if exc.detail:
            logger.info("[admin/image/test] %s — %s", exc.message, exc.detail)
        out["error"] = exc.message
        return out
    except Exception:                                           # noqa: BLE001
        logger.exception("[admin/image/test] erreur inattendue")
        out["error"] = "Erreur interne (voir le journal)."
        return out
    warnings: List[str] = []
    out.update(ok=True, latency_ms=int((time.monotonic() - t0) * 1000),
               model=caps.get("model") or cfg["model"], mode=caps.get("mode") or "",
               limits=caps.get("limits") or {}, defaults=caps.get("defaults") or {})
    if cfg["provider"] == "sdcpp" and caps.get("mode") and caps["mode"] != "img_gen":
        out["ok"] = False
        out["error"] = (f"Ce sd-server est en mode « {caps['mode']} » : "
                        "lancez-le avec un modèle d'images.")
    if cfg["provider"] == "openai":
        if not cfg["model"]:
            warnings.append("Choisissez un modèle.")
        elif caps.get("models") and cfg["model"] not in caps["models"]:
            warnings.append(f"Modèle « {cfg['model']} » absent de la liste du service.")
    if not saved["enabled"]:
        warnings.append("Génération désactivée.")
    if (cfg["url"], cfg["provider"], cfg["model"]) != (saved["url"], saved["provider"],
                                                       saved["model"]):
        warnings.append("Configuration non enregistrée : le test porte sur le formulaire.")
    out["warnings"] = warnings
    return out


@admin_router.post("/api/admin/image/models")
async def api_admin_image_models(request: Request) -> Dict[str, Any]:
    _require_admin(request)
    data = await _body(request)
    from llm_core.imagegen.base import ImageError
    from llm_core.imagegen.service import get_provider

    cfg = _merged(data)
    if not cfg["url"]:
        return {"ok": False, "models": [], "error": "Aucune adresse renseignée."}
    try:
        models = await get_provider(cfg).list_models()
    except ImageError as exc:
        if exc.detail:
            logger.info("[admin/image/models] %s — %s", exc.message, exc.detail)
        return {"ok": False, "models": [], "error": exc.message}
    except Exception:                                           # noqa: BLE001
        logger.exception("[admin/image/models] erreur inattendue")
        return {"ok": False, "models": [], "error": "Erreur interne (voir le journal)."}
    return {"ok": True, "models": models}


@admin_router.get("/api/admin/image/key")
async def api_admin_image_key_state(request: Request) -> Dict[str, Any]:
    _require_admin(request)
    return key_state(get_image_config())


@admin_router.put("/api/admin/image/key")
async def api_admin_image_key(request: Request) -> Dict[str, Any]:
    """Body ``{api_key: str, url?: str}`` ; ``""`` efface la clé. La clé est
    scellée pour l'origine de ``url`` (l'adresse du formulaire), sinon de
    l'adresse enregistrée. Rend ``{ok, has_key, stale}``."""
    _require_admin(request)
    data = await _body(request)
    key = str(data.get("api_key") or "").strip()
    if len(key) > _KEY_MAX:
        raise HTTPException(400, "Clé trop longue.")
    url = _norm_url(data.get("url")) if data.get("url") is not None \
        else get_image_config()["url"]
    if key and not engine_origin(url):
        raise HTTPException(400, "Renseignez d'abord l'adresse du moteur.")
    from shared_infra.security.encryption import EncryptionUnavailable, encrypt
    try:
        enc = encrypt(seal_api_key(key, url)) if key else ""
    except EncryptionUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc
    await asyncio.to_thread(write_api_key, enc)
    from llm_core.imagegen.service import forget_capabilities
    forget_capabilities()
    return {"ok": True, **key_state(get_image_config())}
