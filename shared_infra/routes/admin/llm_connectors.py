# SPDX-License-Identifier: MIT
"""
shared_infra.routes.admin.llm_connectors — Connecteurs LLM PARTAGÉS (admin).

Enregistrés sur ``admin_router`` (app admin). L'admin gère les backends
partagés/locaux (llama.cpp, vLLM, ou même un compte cloud d'équipe) visibles
par tous les utilisateurs, et l'allowlist des types de fournisseurs que les
utilisateurs peuvent ajouter eux-mêmes.

Réutilise les helpers du module utilisateur (validation/presets/allowlist) pour
une source unique. La clé API reste write-only.

Endpoints :
  GET    /api/admin/llm/connectors            → connecteurs partagés (sans clé)
  POST   /api/admin/llm/connectors            → créer (base_url libre = local OK)
  PUT    /api/admin/llm/connectors/{cid}      → modifier
  DELETE /api/admin/llm/connectors/{cid}      → supprimer
  POST   /api/admin/llm/connectors/{cid}/test → tester la connexion
  GET    /api/admin/llm/allowed-providers     → types autorisés côté users
  PUT    /api/admin/llm/allowed-providers     → définir l'allowlist
"""
from __future__ import annotations

from fastapi import HTTPException, Request

from shared_infra.security.audit import audit_event
from shared_infra.config import read_config_json, write_config_json
from shared_infra.llm import connectors as _lc
from shared_infra.routes.admin._state import admin_router
from shared_infra.routes._helpers import _require_admin
# Source unique : helpers de validation/presets/allowlist du module user.
# Import du MODULE (et non des noms) : les deux modules se citent l'un l'autre
# via ``routes._state`` — un ``from … import <nom>`` échouait dès que le module
# user était importé le premier (« partially initialized module », visible en
# lançant tests/shared_infra/test_llm_connectors.py seul). Les attributs sont
# résolus à l'APPEL, quand les deux modules sont complets.
from shared_infra.llm import routes_connectors as _ur


@admin_router.get("/api/admin/llm/connectors")
def api_admin_list_llm_connectors(request: Request):
    _require_admin(request)
    return {"connectors": _lc.list_shared_connectors(),
            "presets": _ur._presets_public(),
            "all_provider_types": list(_lc.PROVIDER_PRESETS)}


@admin_router.post("/api/admin/llm/connectors")
async def api_admin_create_llm_connector(request: Request):
    uid = _require_admin(request)
    data = await request.json()
    fields = _ur._resolve_create_fields(data, admin=True)
    api_key = (data.get("api_key") or "").strip()
    try:
        cid = _lc.create_connector(scope="shared", owner_user_id=None, api_key=api_key, **fields)
    except Exception as e:
        raise HTTPException(503, f"Stockage impossible : {str(e)[:160]}")
    audit_event(user_id=uid, username=getattr(request.state, "username", None),
                action="llm.connector.create",
                details={"connector_id": cid, "provider_type": fields["provider_type"], "scope": "shared"})
    _ur._invalidate_ctx_window_cache()
    return {"ok": True, "id": cid}


@admin_router.put("/api/admin/llm/connectors/{cid}")
async def api_admin_update_llm_connector(request: Request, cid: int):
    uid = _require_admin(request)
    data = await request.json()
    fields = {}
    for k in ("label", "base_url", "default_model", "models_json"):
        if k in data:
            fields[k] = _ur._clean(data.get(k), 4000 if k == "models_json" else 500)
    if "enabled" in data:
        fields["enabled"] = bool(data.get("enabled"))
    if (data.get("api_key") or "").strip():
        fields["api_key"] = data["api_key"].strip()
    fields.update(_ur._limit_fields(data))
    try:
        ok = _lc.update_shared_connector(cid, **fields)
    except Exception as e:
        raise HTTPException(503, f"Mise à jour impossible : {str(e)[:160]}")
    if not ok:
        raise HTTPException(404, "Connecteur introuvable ou rien à modifier")
    audit_event(user_id=uid, username=getattr(request.state, "username", None),
                action="llm.connector.update", details={"connector_id": cid, "scope": "shared"})
    _ur._invalidate_ctx_window_cache()
    _ur._forget_engine(cid)
    return {"ok": True}


@admin_router.delete("/api/admin/llm/connectors/{cid}")
def api_admin_delete_llm_connector(request: Request, cid: int):
    uid = _require_admin(request)
    if not _lc.delete_shared_connector(cid):
        raise HTTPException(404, "Connecteur introuvable")
    from llm_core._scheduling._engines import forget_connector
    forget_connector(cid)
    # Listes d'accès par utilisateur / groupe (lot B4) : la clé disparaît avec
    # le connecteur. Une liste vidée reste vide = aucun serveur (jamais « tout »).
    from shared_infra.llm import engine_access as _ea
    _purged = _ea.purge_engine_key(_ea.connector_key(cid))
    audit_event(user_id=uid, username=getattr(request.state, "username", None),
                action="llm.connector.delete",
                details={"connector_id": cid, "scope": "shared", "access_lists_purged": _purged})
    _ur._invalidate_ctx_window_cache()
    _ur._forget_engine(cid)
    return {"ok": True}


@admin_router.post("/api/admin/llm/connectors/{cid}/test")
async def api_admin_test_llm_connector(request: Request, cid: int):
    _require_admin(request)
    row = _lc.get_shared_secret(cid)
    if not row:
        raise HTTPException(404, "Connecteur introuvable")
    from llm_core.providers.discovery import test_connector
    return await test_connector(row)


@admin_router.get("/api/admin/llm/allowed-providers")
def api_admin_get_allowed_providers(request: Request):
    _require_admin(request)
    return {"allowed": _ur._allowed_provider_types(),
            "cloud_provider_types": _lc.cloud_provider_types(),
            "presets": _ur._presets_public()}


@admin_router.put("/api/admin/llm/allowed-providers")
async def api_admin_set_allowed_providers(request: Request):
    uid = _require_admin(request)
    data = await request.json()
    raw = data.get("allowed")
    if not isinstance(raw, list):
        raise HTTPException(400, "'allowed' doit être une liste de provider_type")
    # On n'autorise que des types CLOUD (les locaux restent admin-only).
    cloud = set(_lc.cloud_provider_types())
    allowed = [p for p in raw if p in cloud]
    cfg = read_config_json() or {}
    cfg.setdefault("llm", {})
    cfg["llm"]["allowed_provider_types"] = allowed
    write_config_json(cfg)
    audit_event(user_id=uid, username=getattr(request.state, "username", None),
                action="llm.allowed_providers.set", details={"allowed": allowed})
    return {"ok": True, "allowed": allowed}
