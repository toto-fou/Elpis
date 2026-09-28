# SPDX-License-Identifier: MIT
"""
llm_core.providers.discovery — Découverte de modèles & test de connexion par
connecteur LLM. Partagé par les routes (CRUD ``/test`` et endpoint ``/models``).

Pour un connecteur OpenAI-compatible : ``GET {base}/models`` (Bearer).
Pour un connecteur Anthropic         : ``GET {base}/v1/models`` (x-api-key).

SSRF : le ``base_url`` des connecteurs UTILISATEUR est verrouillé par preset
(API officielle publique) côté route de création → pas de fetch arbitraire. Les
connecteurs PARTAGÉS (base_url libre, ex. vLLM interne) sont créés par l'admin
(de confiance). On n'applique donc pas de filtre IP ici (les backends locaux
sont des IP privées légitimes).
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List

from llm_core._client import _get_llm_client
from llm_core._target import LlmTarget
from llm_core.providers import anthropic as _anthro
from llm_core.providers import openai_compat as _oai

logger = logging.getLogger("uvicorn.error")

# Catalogue Anthropic semé : repli si GET /v1/models échoue (offline/clé invalide)
# ou pour pré-remplir sans appel réseau. Cf. skill claude-api (2026).
ANTHROPIC_CATALOG: List[str] = [
    "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6",
    "claude-sonnet-4-6", "claude-haiku-4-5", "claude-fable-5",
]


# OpenCode Zen (2026-09-12) — la passerelle du projet opencode nomme ses
# modèles GRATUITS avec le suffixe ``-free`` (``nemotron-3-ultra-free``,
# ``minimax-m2.5-free``…). C'est la convention du fournisseur, pas une
# déduction : ``GET /v1/models`` ne porte aucune information de prix. On s'en
# sert pour REMONTER ces modèles en tête de liste et les signaler à l'UI —
# jamais pour interdire les autres.
FREE_MODEL_SUFFIX = "-free"
FREE_MODEL_PROVIDERS = ("opencode",)


def free_models(provider_type: str, model_ids: List[str]) -> List[str]:
    """Sous-ensemble GRATUIT de ``model_ids`` pour ce fournisseur (vide si le
    fournisseur n'a pas d'offre gratuite identifiable)."""
    if (provider_type or "") not in FREE_MODEL_PROVIDERS:
        return []
    return [m for m in model_ids if str(m).endswith(FREE_MODEL_SUFFIX)]


def _order_models(provider_type: str, model_ids: List[str]) -> List[str]:
    """Gratuits d'abord, le reste dans l'ordre du fournisseur."""
    free = set(free_models(provider_type, model_ids))
    if not free:
        return model_ids
    return [m for m in model_ids if m in free] + [m for m in model_ids if m not in free]


def _row_to_target(row: Dict[str, Any]) -> LlmTarget:
    return LlmTarget(
        wire=row.get("wire") or "openai",
        provider_type=row.get("provider_type") or "generic",
        base_url=(row.get("base_url") or "").strip(),
        api_key=row.get("api_key") or "",
        model=row.get("default_model") or "",
        connector_id=row.get("id"),
        is_default=False,
    )


def _models_url_and_headers(row: Dict[str, Any]):
    t = _row_to_target(row)
    if t.wire == "anthropic":
        # ``api_root`` : une base en ``…/v1/messages`` (acceptée par le chat)
        # donnait ``…/v1/messages/v1/models`` → 404 au test de connexion.
        return _anthro.api_root(t) + "/v1/models", _anthro.build_headers(t)
    return _oai.models_url(t), _oai.headers(t)


def _decorate(row: Dict[str, Any], ids: List[str]) -> Dict[str, Any]:
    """``{models, free}`` — liste ordonnée (gratuits en tête) + le sous-ensemble
    gratuit, que l'UI signale d'une pastille."""
    pt = row.get("provider_type") or ""
    return {"models": _order_models(pt, ids), "free": free_models(pt, ids)}


async def fetch_models(row: Dict[str, Any], *, timeout: float = 8.0) -> Dict[str, Any]:
    """Liste les modèles d'un connecteur. Retourne {ok, models:[ids], status, error?}.

    Repli : liste ``models_json`` saisie à la main si fournie ; catalogue
    Anthropic statique si l'appel échoue."""
    manual = [m.strip() for m in (row.get("models_json") or "").replace(",", "\n").splitlines() if m.strip()]
    url, headers = _models_url_and_headers(row)
    base = (row.get("base_url") or "")
    # Jamais le client du llama-server LOCAL pour un fournisseur distant
    # (Anthropic sans base_url) : ses keepalives sont réservés au local.
    if not base and _row_to_target(row).wire == "anthropic":
        base = "https://api.anthropic.com"
    client = _get_llm_client(base or None)
    try:
        r = await client.get(url, headers=headers, timeout=timeout)
        if r.status_code == 200:
            data = r.json()
            items = data.get("data") if isinstance(data, dict) else None
            ids = [m.get("id") for m in (items or []) if isinstance(m, dict) and m.get("id")]
            if not ids and manual:
                ids = manual
            return {"ok": True, "status": 200, **_decorate(row, ids)}
        # Echec HTTP → replis
        if manual:
            return {"ok": True, "status": r.status_code, "fallback": "manual", **_decorate(row, manual)}
        if (row.get("wire") == "anthropic"):
            return {"ok": False, "status": r.status_code, "models": ANTHROPIC_CATALOG,
                    "fallback": "catalog", "error": f"HTTP {r.status_code}"}
        return {"ok": False, "status": r.status_code, "models": [], "error": f"HTTP {r.status_code}"}
    except Exception as e:
        logger.debug("[discovery] fetch_models échec: %s", str(e)[:160])
        if manual:
            return {"ok": True, "status": 0, "fallback": "manual", **_decorate(row, manual)}
        if (row.get("wire") == "anthropic"):
            return {"ok": False, "status": 0, "models": ANTHROPIC_CATALOG,
                    "fallback": "catalog", "error": str(e)[:160]}
        return {"ok": False, "status": 0, "models": [], "error": str(e)[:160]}


async def test_connector(row: Dict[str, Any], *, timeout: float = 8.0) -> Dict[str, Any]:
    """Test de connexion léger : tente de lister les modèles. Renvoie
    {ok, status, models_count, error?, hint?} — JAMAIS la clé."""
    res = await fetch_models(row, timeout=timeout)
    out: Dict[str, Any] = {
        "ok": bool(res.get("ok")) and res.get("status") not in (401, 403),
        "status": res.get("status"),
        "models_count": len(res.get("models") or []),
    }
    if res.get("fallback"):
        out["fallback"] = res["fallback"]
    if not out["ok"]:
        st = res.get("status")
        out["error"] = res.get("error") or "échec"
        if st in (401, 403):
            out["hint"] = "401/403 : clé API refusée. Vérifie la clé du fournisseur."
        elif st in (0, None):
            out["hint"] = "Aucune réponse : base_url injoignable depuis l'app (réseau / port)."
        elif st == 404:
            out["hint"] = "404 : base_url probablement faux (chemin /v1 attendu)."
    return out
