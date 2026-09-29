# SPDX-License-Identifier: MIT
"""
Admin LLM endpoints — capabilities probe + scheduling-mode.

Auto-extracted from the former monolithic ``backend/routes/admin.py``.
The endpoint bodies are byte-for-byte identical to the originals.
"""
from __future__ import annotations

import logging

from fastapi import HTTPException, Request
from fastapi.responses import (
    JSONResponse,
)

from shared_infra.accounts.users import (
    get_user_by_id,
)
from shared_infra.config import (
    read_config_json,
    write_config_json,
)

# Helpers shared with _legacy. Single source of truth.
# Routers — owned by ``_state``. We import them so endpoint decorators
# below register on the SAME singleton router instances mounted by
# ``app.py`` / ``admin_app.py``.
from shared_infra.routes.admin._state import admin_router
from shared_infra.security.deps import require_user_id

logger = logging.getLogger("uvicorn.error")


@admin_router.get("/api/admin/llm-capabilities")
def api_admin_llm_capabilities(request: Request):
    """Snapshot des capacités détectées + mode configuré + mode effectif."""
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    if not me or me["is_admin"] not in (1, 2):
        raise HTTPException(403, "Staff required")
    from llm_core import get_llama_capabilities, resolve_scheduling_mode
    from shared_infra import config as _cfg
    caps = get_llama_capabilities()
    # E6 — lire le FICHIER, pas la constante d'import : celle-ci n'est à jour
    # que dans le worker ayant reçu le dernier POST, si bien que ce GET
    # répondait tantôt l'ancienne valeur tantôt la nouvelle selon le worker
    # qui décrochait (UI qui clignote).
    return JSONResponse({
        "capabilities":     caps,
        "configured_mode":  _cfg.live_config_value(       # "auto"/"classic"/"optimized"
            "llm.scheduling_mode", _cfg.LLM_SCHEDULING_MODE),
        "effective_mode":   resolve_scheduling_mode(),    # "classic"/"optimized"
    }, headers={"Cache-Control": "no-cache"})


@admin_router.post("/api/admin/llm-capabilities/probe")
async def api_admin_llm_capabilities_probe(request: Request):
    """Force un nouveau probe (après avoir changé la config llama-server,
    ou si le probe initial au startup a échoué parce que llama n'était
    pas prêt)."""
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    # Audit 2026-09-22, H6 : sonde sortante vers le moteur → admin seul.
    if not me or me["is_admin"] != 1:
        raise HTTPException(403, "Admin required")
    from llm_core import detect_llama_capabilities
    caps = await detect_llama_capabilities(timeout_s=3.0)
    return JSONResponse({"capabilities": caps}, headers={"Cache-Control": "no-cache"})


@admin_router.post("/api/admin/llm-scheduling-mode")
async def api_admin_set_scheduling_mode(request: Request):
    """Change le mode de scheduling LLM. Accepte {"mode": "auto"|"classic"|"optimized"}.

    Met à jour ``backend.config.LLM_SCHEDULING_MODE`` en mémoire (effet
    immédiat sur la prochaine requête) et persiste dans config.json sous
    ``llm.scheduling_mode``.
    """
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    # Audit 2026-09-22, H6 : écriture de config d'instance → admin seul.
    if not me or me["is_admin"] != 1:
        raise HTTPException(403, "Admin required")
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Body JSON requis")
    mode = (body.get("mode") or "").lower().strip()
    if mode not in ("auto", "classic", "optimized"):
        raise HTTPException(400, "mode doit être auto, classic ou optimized")

    # Hot-reload : on réassigne la constante module-level pour que CE worker
    # applique le changement sans attendre le read disque suivant. Les AUTRES
    # workers le voient via ``live_config_value`` (E6) dès que config.json est
    # écrit ci-dessous — c'est le fichier qui fait autorité, pas cette ligne.
    from shared_infra import config as _cfg
    _cfg.LLM_SCHEDULING_MODE = mode

    # ── Persistance dans config.json ─────────────────────────────────────
    # Même fix que pour compression_config : utilise les helpers canoniques
    # de backend.config qui pointent sur le bon fichier (celui que config.py
    # relit au démarrage) et écrivent de manière atomique.
    try:
        cfg_data = read_config_json()
        llm_section = cfg_data.setdefault("llm", {})
        llm_section["scheduling_mode"] = mode
        write_config_json(cfg_data)
    except Exception as e:
        # Non-fatal : la valeur en mémoire est déjà mise à jour.
        logger.warning(f"[admin] persist scheduling_mode échoué : {e}")

    from llm_core import resolve_scheduling_mode
    return JSONResponse({
        "configured_mode": mode,
        "effective_mode":  resolve_scheduling_mode(),
    })
