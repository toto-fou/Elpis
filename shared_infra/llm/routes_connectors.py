# SPDX-License-Identifier: MIT
"""
shared_infra.llm.routes_connectors — API des Connecteurs LLM.

Deux familles d'endpoints :

UTILISATEUR (``require_user_id``, owner-scoped) — connecteurs cloud perso :
  GET    /api/llm/connectors              → mes connecteurs + partagés + presets
  POST   /api/llm/connectors              → créer (clé API dans le body)
  PUT    /api/llm/connectors/{cid}        → modifier (clé optionnelle = inchangée)
  DELETE /api/llm/connectors/{cid}        → supprimer
  POST   /api/llm/connectors/{cid}/test   → tester la connexion
  GET    /api/llm/connectors/{cid}/models → lister les modèles du connecteur

ADMIN (``_require_admin``) — connecteurs partagés/locaux + allowlist :
  GET    /api/admin/llm/connectors            → connecteurs partagés
  POST   /api/admin/llm/connectors            → créer un partagé (base_url libre)
  PUT    /api/admin/llm/connectors/{cid}      → modifier
  DELETE /api/admin/llm/connectors/{cid}      → supprimer
  POST   /api/admin/llm/connectors/{cid}/test → tester
  GET/PUT /api/admin/llm/allowed-providers    → types ajoutables par les users

SÉCURITÉ : la clé API est **write-only** (jamais renvoyée). Pour un connecteur
UTILISATEUR, la ``base_url`` est imposée par le preset officiel (anti-SSRF :
pas de fetch vers une URL arbitraire). Seul l'admin saisit une base_url libre
(backends locaux de confiance).
"""
from __future__ import annotations

from fastapi import HTTPException, Request

from shared_infra.security.audit import audit_event
from shared_infra.config import read_config_json
from shared_infra.llm import connectors as _lc
from shared_infra.security.deps import require_user_id
from shared_infra.routes._state import router

_MAX = 300


def _clean(s, n=_MAX) -> str:
    return ("" if s is None else str(s)).strip()[:n]


# ── Allowlist (config.json › llm.allowed_provider_types) ──────────────────────
def _allowed_provider_types() -> list:
    # Source unique : ``connectors.allowed_provider_types`` (lue aussi par la
    # résolution de cible, cf. A8) ; la config est celle lue par CE module.
    return _lc.allowed_provider_types(read_config_json() or {})


def _presets_public() -> dict:
    """Presets exposés au frontend (sans secret)."""
    return {p: {k: v[k] for k in ("wire", "base_url", "label", "admin_only", "user_base_locked")}
            for p, v in _lc.PROVIDER_PRESETS.items()}


# ═════════════════════════════ UTILISATEUR ═══════════════════════════════════
@router.get("/api/llm/connectors")
def api_list_llm_connectors(request: Request):
    uid = require_user_id(request)
    # AUDIT 2026-09-16 (lot B4) — les connecteurs PARTAGÉS sont filtrés par la
    # politique d'accès de l'utilisateur (et de ses groupes) ; le sélecteur
    # apprend aussi s'il a droit au serveur intégré et à la gestion des modèles.
    # Le contrôle réel est refait côté serveur à chaque usage (route de chat,
    # routes de modèles) : cette liste n'est qu'un affichage.
    from shared_infra.llm import engine_access as _ea
    # A8 — un connecteur PERSO dont le fournisseur a été retiré de l'allowlist
    # ne sert plus (la résolution de cible le refuse) : il reste listé pour
    # être modifié ou supprimé, mais porte ``provider_allowed: false`` pour que
    # le sélecteur ne le propose pas.
    _ok_types = set(_allowed_provider_types())
    _own = _lc.list_user_connectors(uid)
    for _c in _own:
        _c["provider_allowed"] = (_c.get("provider_type") in _ok_types)
    return {
        "connectors": _own,
        "shared": _ea.filter_shared_connectors(uid, _lc.list_shared_connectors()),
        "presets": _presets_public(),
        "allowed_provider_types": _allowed_provider_types(),
        "builtin_allowed": _ea.can_use_engine(uid, _ea.BUILTIN_KEY),
        "can_manage_models": _ea.can_manage_models(uid),
    }


def _resolve_create_fields(data: dict, *, admin: bool) -> dict:
    """Valide + normalise les champs de création/maj selon la portée."""
    ptype = _clean(data.get("provider_type"))
    if ptype not in _lc.PROVIDER_PRESETS:
        raise HTTPException(400, f"provider_type invalide ({list(_lc.PROVIDER_PRESETS)})")
    preset = _lc.PROVIDER_PRESETS[ptype]
    if not admin:
        if ptype not in _allowed_provider_types():
            raise HTTPException(403, "Ce fournisseur n'est pas autorisé pour les utilisateurs")
        if preset.get("admin_only"):
            raise HTTPException(403, "Connecteur réservé à l'administrateur")
    wire = preset["wire"]
    # base_url : verrouillée par preset pour un USER ; libre pour l'admin.
    if not admin and preset.get("user_base_locked"):
        base_url = preset["base_url"]
    else:
        base_url = _clean(data.get("base_url"), 500) or preset.get("base_url", "")
    if not base_url:
        raise HTTPException(400, "base_url requise (ex. http://llm.example.lan:8000/v1)")
    out = {
        "provider_type": ptype, "wire": wire, "base_url": base_url,
        "label": _clean(data.get("label")) or preset.get("label", ""),
        "default_model": _clean(data.get("default_model")),
        "models_json": _clean(data.get("models_json"), 4000),
    }
    if admin:
        out.update(_limit_fields(data))
    return out


def _limit_fields(data: dict) -> dict:
    """Réglages de capacité d'un serveur (migration 0019) — ADMIN seulement :
    ils dimensionnent l'ordonnancement que subissent tous les utilisateurs de
    ce serveur. Vide / 0 = découverte automatique. Seules les clés PRÉSENTES
    dans la requête sont renvoyées (une mise à jour partielle n'efface rien)."""
    out = {}
    for k, hi in (("context_window", 10_000_000), ("max_models", 64),
                  ("max_concurrency", 256)):
        if k not in data:
            continue
        raw = data.get(k)
        if raw in (None, ""):
            out[k] = None
            continue
        try:
            v = int(raw)
        except (TypeError, ValueError):
            raise HTTPException(400, f"{k} doit être un entier")
        if v < 0 or v > hi:
            raise HTTPException(400, f"{k} hors bornes (0-{hi})")
        out[k] = v or None
    return out


def _forget_engine(cid: int) -> None:
    """Oublie tout ce qui est mémorisé sur le serveur d'un connecteur modifié
    ou supprimé (AUDIT 2026-09-16) : ordonnanceur dédié (réglages de capacité),
    capacités sondées, inventaire des modèles. Best-effort, par worker — les
    autres suivent au TTL de chaque cache (5 s, 10 s, 3 s)."""
    try:
        from llm_core._scheduling._engines import forget
        forget(f"conn:{int(cid)}")
    except Exception:
        pass
    try:
        from llm_core.providers import llama_caps, llama_models
        llama_caps.invalidate()
        llama_models.invalidate_statuses()
    except Exception:
        pass


def _invalidate_ctx_window_cache() -> None:
    """AUDIT 2026-08-31 (passe 3) — ``_ctx_window.invalidate_cache()`` n'avait
    AUCUN appelant : corriger ``context_window``/``meta`` d'un connecteur
    restait sans effet avant redémarrage (résultat négatif ET positif
    mémoïsés) — compaction et élagage restaient morts jusqu'au 400 « context
    length exceeded » du fournisseur. Appelée sur create/update/delete de
    connecteur (user ET admin). Best-effort, par worker — les autres workers
    se rattrapent par le TTL du négatif."""
    try:
        from llm_core._ctx_window import invalidate_cache
        invalidate_cache()
    except Exception:
        pass


@router.post("/api/llm/connectors")
async def api_create_llm_connector(request: Request):
    uid = require_user_id(request)
    data = await request.json()
    fields = _resolve_create_fields(data, admin=False)
    api_key = (data.get("api_key") or "").strip()
    if not api_key:
        raise HTTPException(400, "Clé API requise pour un connecteur cloud")
    try:
        cid = _lc.create_connector(scope="user", owner_user_id=uid, api_key=api_key, **fields)
    except Exception as e:
        raise HTTPException(503, f"Stockage du connecteur impossible : {str(e)[:160]}")
    audit_event(user_id=uid, username=getattr(request.state, "username", None),
                action="llm.connector.create",
                details={"connector_id": cid, "provider_type": fields["provider_type"], "scope": "user"})
    _invalidate_ctx_window_cache()
    return {"ok": True, "id": cid}


@router.put("/api/llm/connectors/{cid}")
async def api_update_llm_connector(request: Request, cid: int):
    uid = require_user_id(request)
    data = await request.json()
    fields = {}
    for k in ("label", "default_model", "models_json"):
        if k in data:
            fields[k] = _clean(data.get(k), 4000 if k == "models_json" else _MAX)
    if "enabled" in data:
        fields["enabled"] = bool(data.get("enabled"))
    if (data.get("api_key") or "").strip():
        fields["api_key"] = data["api_key"].strip()
    try:
        ok = _lc.update_user_connector(uid, cid, **fields)
    except Exception as e:
        raise HTTPException(503, f"Mise à jour impossible : {str(e)[:160]}")
    if not ok:
        raise HTTPException(404, "Connecteur introuvable ou rien à modifier")
    audit_event(user_id=uid, username=getattr(request.state, "username", None),
                action="llm.connector.update", details={"connector_id": cid})
    _invalidate_ctx_window_cache()
    return {"ok": True}


@router.delete("/api/llm/connectors/{cid}")
def api_delete_llm_connector(request: Request, cid: int):
    uid = require_user_id(request)
    if not _lc.delete_user_connector(uid, cid):
        raise HTTPException(404, "Connecteur introuvable")
    from llm_core._scheduling._engines import forget_connector
    forget_connector(cid)
    audit_event(user_id=uid, username=getattr(request.state, "username", None),
                action="llm.connector.delete", details={"connector_id": cid})
    _invalidate_ctx_window_cache()
    return {"ok": True}


@router.post("/api/llm/connectors/{cid}/test")
async def api_test_llm_connector(request: Request, cid: int):
    uid = require_user_id(request)
    row = _lc.get_user_secret(uid, cid)
    if not row:
        raise HTTPException(404, "Connecteur introuvable")
    from llm_core.providers.discovery import test_connector
    res = await test_connector(row)
    audit_event(user_id=uid, username=getattr(request.state, "username", None),
                action="llm.connector.test",
                details={"connector_id": cid, "ok": bool(res.get("ok")), "status": res.get("status")})
    return res


@router.get("/api/llm/connectors/{cid}/models")
async def api_llm_connector_models(request: Request, cid: int):
    """Modèles d'un connecteur visible (perso OU partagé) par ce user.

    AUDIT 2026-09-16 — (a) un connecteur DÉSACTIVÉ ou refusé par la politique
    d'accès n'est plus sondé ; (b) pour un connecteur llama.cpp en mode
    ROUTEUR, la réponse porte l'état de chaque modèle (``statuses`` :
    loaded / unloaded / loading) et ``can_manage`` — le sélecteur offre alors
    les mêmes gestes que pour le serveur intégré (charger, décharger) ;
    (c) ``ok`` distingue « serveur injoignable » de « aucun modèle » : le
    sélecteur ne met plus en cache un échec (coupure d'une seconde ⇒ liste
    vide collée jusqu'au rechargement de la page)."""
    uid = require_user_id(request)
    row = _lc.get_secret_for_user(uid, cid)
    if not row or not row.get("enabled", True):
        raise HTTPException(404, "Connecteur introuvable")
    from shared_infra.llm import engine_access as _ea
    if not _ea.can_use_engine(uid, _ea.connector_key(cid)):
        raise HTTPException(403, "Serveur non autorisé")
    from llm_core.providers.discovery import fetch_models
    out = {"connector_id": cid, "default_model": row.get("default_model") or "",
           "provider_type": row.get("provider_type") or "", "router": False,
           "statuses": {}, "can_manage": False}
    if (row.get("provider_type") or "") == "llamacpp":
        from llm_core.engines import resolve_engine_for_user
        from llm_core.providers.llama_caps import engine_caps
        from llm_core.providers.llama_models import model_statuses
        eng = resolve_engine_for_user(uid, _ea.connector_key(cid))
        if eng is not None:
            _fresh = request.query_params.get("fresh") in ("1", "true")
            caps = await engine_caps(engine=eng, force=_fresh)
            if caps.known and caps.models_api:
                st = await model_statuses(engine=eng, force=_fresh)
                if st:
                    from llm_core.providers.discovery import _decorate
                    out.update({"ok": True, "status": 200, "router": True,
                                "statuses": st,
                                "can_manage": _ea.can_manage_models(uid),
                                **_decorate(row, list(st.keys()))})
                    return out
    res = await fetch_models(row)
    out.update(res)
    return out

# Les endpoints ADMIN (connecteurs partagés + allowlist) vivent dans
# ``shared_infra/routes/admin/llm_connectors.py`` (enregistrés sur
# ``admin_router``, servis par l'app admin). Ils réutilisent les helpers
# ci-dessus (``_resolve_create_fields``, ``_allowed_provider_types``, …).
