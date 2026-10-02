# SPDX-License-Identifier: MIT
"""
shared_infra/mcp/openapi.py — façade OpenAPI des outils du service partagé.

Les familles d'outils déjà joignables de l'extérieur par MCP (``/mcp/<famille>``,
relayées par ``/api/mcp-bridge``) deviennent aussi des API HTTP ordinaires,
pour les plateformes et scripts qui ne parlent qu'OpenAPI :

* ``GET  /api/tools/<famille>/openapi.json`` — spec OpenAPI 3.1 générée depuis
  ``tools/list`` de la famille : un ``POST /<outil>`` par outil, corps =
  ``inputSchema``, réponse = ``outputSchema`` ;
* ``POST /api/tools/<famille>/<outil>`` — appel de l'outil, corps = arguments.

Une seule source : la liste VIVANTE des outils du service (le même pool MCP que
le chat). Aucun process de plus, aucune ressource externe (pas de Swagger).

Ce module porte la génération et l'appel ; les routes (authentification par
jeton d'outils ``ept_``, portée, codes HTTP) vivent dans ``routes_openapi.py``.

IDENTITÉ. L'appel part avec le jeton de SERVICE de l'app et l'identité du
PROPRIÉTAIRE du jeton dans le ``_meta`` MCP — exactement comme un appel d'outil
du chat. Le corps de la requête ne contient que les arguments de l'outil : il
ne peut ni choisir le compte, ni la famille, ni le délai.
"""
from __future__ import annotations

import asyncio
import copy
import json
import logging
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# Familles exposables en OpenAPI : celles du service partagé qui ont DÉJÀ un
# point d'accès externe (``/mcp/<famille>``) ; ``browser`` depuis la garde de
# destinations et les sessions par compte du service navigateur. Les familles
# liées à l'APP (chart, memory, skill, todo) ne quittent jamais le processus de
# l'app.
EXPOSABLE_FAMILIES: Tuple[str, ...] = ("fs", "shell", "git", "desktop", "browser", "skill_run")

OPENAPI_PREFIX = "/api/tools"

# Spec d'une famille : régénérée au plus toutes les 60 s (le pool garde, lui,
# sa propre liste d'outils ; ce cache évite de reconstruire la spec à chaque
# appel — la route d'appel en a besoin pour valider les arguments).
_SPEC_TTL_S = 60.0
_tools_cache: Dict[str, Tuple[float, List[Dict[str, Any]]]] = {}


class FamilyUnavailable(Exception):
    """La famille n'a pas d'entrée dans le manifeste ou le service ne répond pas."""


# ── Outils d'une famille ────────────────────────────────────────────────────

def family_cfg(family: str) -> Optional[Dict[str, Any]]:
    """Config de pool de l'entrée INTÉGRÉE qui sert ``family`` sur le service
    partagé (``role: toolhost``), ou ``None``. Une entrée ``role: app``
    (familles liées au compte, servies en mémoire) n'est jamais retenue."""
    from shared_infra.mcp import manifest as _mf
    try:
        entry = _mf.load().entry_for_family(family)
    except Exception:                                            # noqa: BLE001
        logger.warning("[openapi] manifeste illisible", exc_info=True)
        return None
    if entry is None or entry.role != _mf.ROLE_TOOLHOST:
        return None
    return entry.client_cfg(None)


def _tool_dict(tool: Any) -> Dict[str, Any]:
    """Outil MCP (objet du SDK ou dict) → dict simple."""
    if isinstance(tool, dict):
        d = dict(tool)
    elif hasattr(tool, "model_dump"):
        d = tool.model_dump(by_alias=True, exclude_none=True)
    else:
        d = {k: getattr(tool, k) for k in ("name", "title", "description", "inputSchema",
                                           "outputSchema", "annotations", "meta")
             if getattr(tool, k, None) is not None}
    if "_meta" in d and "meta" not in d:
        d["meta"] = d.pop("_meta")
    ann = d.get("annotations")
    if ann is not None and not isinstance(ann, dict):
        d["annotations"] = (ann.model_dump(exclude_none=True) if hasattr(ann, "model_dump")
                            else dict(vars(ann)))
    return d


def _tool_category(tool: Dict[str, Any]) -> Optional[str]:
    from llm_core._mcp_categories import _extract_category
    try:
        cat, _ = _extract_category(tool)
    except Exception:                                            # noqa: BLE001
        return None
    return cat


def _filter_family(family: str, tools: List[Dict[str, Any]], cfg: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Garde les outils de ``family``. Une entrée qui sert plusieurs familles
    (manifeste hérité) liste aussi les autres : on les écarte par catégorie."""
    from shared_infra.mcp.families import FAMILY_CATEGORY
    fams = list(cfg.get("families") or [])
    if fams == [family]:
        return tools
    want = FAMILY_CATEGORY.get(family, family)
    kept = [t for t in tools if _tool_category(t) == want]
    if family == "skill_run":
        # Même catégorie « skill » que la bibliothèque de skills (famille de
        # l'APP, jamais exposée) : seule l'exécution dans la sandbox en fait
        # partie (``skill_tools.register_run``).
        kept = [t for t in kept if str(t.get("name") or "").startswith("skill_run")]
    return kept


async def family_tools(family: str) -> List[Dict[str, Any]]:
    """Outils de ``family`` (dicts), triés par nom — depuis le pool MCP de
    l'app, avec un cache de 60 s. Lève ``FamilyUnavailable``."""
    now = time.monotonic()
    hit = _tools_cache.get(family)
    if hit and now - hit[0] < _SPEC_TTL_S:
        return hit[1]
    cfg = family_cfg(family)
    if cfg is None:
        raise FamilyUnavailable(family)
    from llm_core._mcp_pool import mcp_pool
    from llm_core._mcp_wrappers import _resolve_mcp_client
    try:
        _client, raw = await mcp_pool.get_or_connect(cfg, resolve_client_fn=_resolve_mcp_client)
    except Exception as exc:                                     # noqa: BLE001
        logger.warning("[openapi] service d'outils injoignable pour %s : %r", family, exc)
        raise FamilyUnavailable(family) from exc
    tools = sorted(_filter_family(family, [_tool_dict(t) for t in (raw or [])], cfg),
                   key=lambda t: str(t.get("name") or ""))
    tools = [t for t in tools if t.get("name")]
    _tools_cache[family] = (now, tools)
    return tools


def clear_cache() -> None:
    _tools_cache.clear()


# ── Génération de la spec ───────────────────────────────────────────────────

def _component_name(tool: str, kind: str, name: str) -> str:
    """Nom de composant sans collision entre outils (``[A-Za-z0-9._-]``)."""
    import re
    raw = f"{tool}.{kind}.{name}" if kind else f"{tool}.{name}"
    return re.sub(r"[^A-Za-z0-9._-]", "_", raw)


def _lift_defs(schema: Any, tool: str, kind: str, components: Dict[str, Any]) -> Any:
    """Copie de ``schema`` dont les ``$defs`` partent dans
    ``components/schemas`` (préfixés par l'outil) et dont les ``$ref`` locaux
    sont réécrits en conséquence. Deux outils peuvent déclarer un même nom de
    ``$defs`` avec des contenus différents : le préfixe les sépare."""
    if not isinstance(schema, dict):
        return schema
    schema = copy.deepcopy(schema)
    defs = schema.pop("$defs", None) or schema.pop("definitions", None) or {}
    mapping = {n: _component_name(tool, kind, n) for n in defs}

    def _rewrite(node: Any) -> Any:
        if isinstance(node, dict):
            out = {}
            for k, v in node.items():
                if k == "$ref" and isinstance(v, str):
                    for pre in ("#/$defs/", "#/definitions/"):
                        if v.startswith(pre) and v[len(pre):] in mapping:
                            v = "#/components/schemas/" + mapping[v[len(pre):]]
                    out[k] = v
                else:
                    out[k] = _rewrite(v)
            return out
        if isinstance(node, list):
            return [_rewrite(x) for x in node]
        return node

    for n, d in defs.items():
        components[mapping[n]] = _rewrite(d)
    return _rewrite(schema)


def _unwrap_output(schema: Optional[Dict[str, Any]]) -> Tuple[Optional[Dict[str, Any]], bool]:
    """FastMCP enveloppe un résultat non-objet sous ``{"result": …}`` et le
    signale par ``x-fastmcp-wrap-result`` : la façade rend la valeur elle-même,
    donc le schéma interne. → ``(schéma, enveloppé ?)``."""
    if not isinstance(schema, dict):
        return None, False
    if schema.get("x-fastmcp-wrap-result"):
        inner = (schema.get("properties") or {}).get("result")
        if isinstance(inner, dict):
            inner = dict(inner)
            if "$defs" in schema and "$defs" not in inner:
                inner["$defs"] = schema["$defs"]
            return inner, True
    return schema, False


_TOOL_ERROR_SCHEMA = {
    "type": "object",
    "description": ("Échec de l'outil (argument refusé, fichier absent, délai "
                    "dépassé…) : l'appel HTTP réussit, l'outil non. Le modèle "
                    "appelant doit lire ``error``/``message`` et ``fix``."),
    "properties": {
        "ok": {"const": False},
        "error": {"type": "string"},
        "message": {"type": "string"},
        "fix": {"type": "string"},
    },
    "required": ["ok"],
}

_HTTP_ERROR_SCHEMA = {
    "type": "object",
    "properties": {"detail": {}},
    "required": ["detail"],
}

_ERROR_RESPONSES = {
    "401": "Jeton d'outils absent, invalide, expiré ou révoqué.",
    "404": "Famille ou outil hors de la portée du jeton, ou inconnu.",
    "422": "Arguments non conformes au schéma de l'outil.",
    "429": "Trop d'appels simultanés pour ce compte (ou service saturé) : réessayer.",
    "502": "Le service d'outils ne répond pas.",
}


def build_spec(family: str, tools: List[Dict[str, Any]], *, server_url: str,
               version: str = "1.0.0") -> Dict[str, Any]:
    """Document OpenAPI 3.1 de ``family`` (pur : aucune E/S)."""
    components: Dict[str, Any] = {
        "ToolError": _TOOL_ERROR_SCHEMA,
        "HTTPError": _HTTP_ERROR_SCHEMA,
    }
    paths: Dict[str, Any] = {}
    for t in tools:
        name = str(t["name"])
        in_schema = _lift_defs(t.get("inputSchema") or {"type": "object"}, name, "", components)
        if not isinstance(in_schema, dict):
            in_schema = {"type": "object"}
        in_schema.setdefault("type", "object")
        in_schema.setdefault("properties", {})
        in_comp = _component_name(name, "", "input")
        components[in_comp] = in_schema

        out_raw, _wrapped = _unwrap_output(t.get("outputSchema"))
        if out_raw is not None:
            out_comp = _component_name(name, "out", "output")
            components[out_comp] = _lift_defs(out_raw, name, "out", components)
            ok_schema: Dict[str, Any] = {"anyOf": [
                {"$ref": f"#/components/schemas/{out_comp}"},
                {"$ref": "#/components/schemas/ToolError"},
            ]}
        else:
            ok_schema = {"description": "Résultat de l'outil (JSON ; texte brut sous « text »)."}

        ann = t.get("annotations") or {}
        title = str(t.get("title") or ann.get("title") or name)
        op: Dict[str, Any] = {
            "operationId": name,
            "summary": title,
            "description": str(t.get("description") or title),
            "tags": [family],
            "requestBody": {
                "required": True,
                "content": {"application/json": {
                    "schema": {"$ref": f"#/components/schemas/{in_comp}"}}},
            },
            "responses": {
                "200": {
                    "description": ("Résultat de l'outil. Un échec de l'OUTIL répond aussi 200, "
                                    "avec « ok: false » (voir ToolError)."),
                    "content": {"application/json": {"schema": ok_schema}},
                },
                **{code: {"$ref": f"#/components/responses/E{code}"} for code in _ERROR_RESPONSES},
            },
        }
        hints = {k: ann[k] for k in ("readOnlyHint", "destructiveHint", "idempotentHint",
                                     "openWorldHint") if k in ann}
        if hints:
            op["x-elpis-annotations"] = hints
        paths[f"/{name}"] = {"post": op}

    return {
        "openapi": "3.1.0",
        "jsonSchemaDialect": "https://json-schema.org/draft/2020-12/schema",
        "info": {
            "title": f"Elpis — outils « {family} »",
            "version": version,
            "description": (
                f"Outils de la famille « {family} » d'Elpis, exécutés dans la sandbox du "
                "compte propriétaire du jeton. Authentification : "
                "« Authorization: Bearer ept_… » (jeton d'outils créé dans "
                "Paramètres › Connexions)."),
        },
        "servers": [{"url": server_url}],
        "security": [{"bearer": []}],
        "paths": paths,
        "components": {
            "schemas": components,
            "responses": {
                f"E{code}": {
                    "description": desc,
                    "content": {"application/json": {
                        "schema": {"$ref": "#/components/schemas/HTTPError"}}},
                }
                for code, desc in _ERROR_RESPONSES.items()
            },
            "securitySchemes": {"bearer": {"type": "http", "scheme": "bearer",
                                           "description": "Jeton d'outils Elpis (ept_…)."}},
        },
    }


# ── Appel ───────────────────────────────────────────────────────────────────

def validation_errors(tool: Dict[str, Any], arguments: Any) -> List[Dict[str, str]]:
    """Écarts des arguments au ``inputSchema`` de l'outil (JSON Schema
    2020-12, ``$defs`` locaux compris). Liste vide = conforme."""
    from jsonschema import Draft202012Validator
    schema = tool.get("inputSchema") or {"type": "object"}
    try:
        validator = Draft202012Validator(schema)
        errs = sorted(validator.iter_errors(arguments), key=lambda e: list(e.absolute_path))
    except Exception as exc:                                     # noqa: BLE001
        # Schéma du serveur invalide : on ne bloque pas l'appel (le serveur
        # valide de toute façon ses arguments), on le trace.
        logger.warning("[openapi] schéma d'entrée illisible pour %s : %r", tool.get("name"), exc)
        return []
    return [{"path": "/".join(str(p) for p in e.absolute_path) or "(racine)",
             "message": e.message[:300]} for e in errs[:10]]


def _response_value(res: Any, tool: Dict[str, Any]) -> Any:
    """``CallToolResult`` → corps de la réponse 200."""
    from llm_core.engine.tool_dispatch import pick_tool_payload
    if getattr(res, "isError", False):
        return pick_tool_payload(res)
    sc = getattr(res, "structuredContent", None)
    if isinstance(sc, dict):
        _schema, wrapped = _unwrap_output(tool.get("outputSchema"))
        if wrapped and "result" in sc:
            return sc["result"]
        return sc
    val = pick_tool_payload(res)
    if isinstance(val, (dict, list)):
        return val
    return {"text": val if isinstance(val, str) else json.dumps(val, ensure_ascii=False, default=str)}


def _is_transport(exc: BaseException) -> bool:
    """Panne de TRANSPORT (service injoignable, connexion coupée) — par
    opposition à une erreur levée par l'outil lui-même. Les transports MCP
    enveloppent la cause dans des ``ExceptionGroup`` anyio : on les déplie."""
    import httpx
    stack: List[BaseException] = [exc]
    seen = 0
    while stack and seen < 50:
        e = stack.pop()
        seen += 1
        if isinstance(e, (OSError, httpx.TransportError)):
            return True
        if type(e).__name__ in ("ClosedResourceError", "BrokenResourceError",
                                "EndOfStream", "FamilyUnavailable"):
            return True
        stack.extend(getattr(e, "exceptions", None) or [])
        if e.__cause__ is not None:
            stack.append(e.__cause__)
    return False


class ServiceSaturated(Exception):
    """File d'attente du service d'outils pleine : l'outil n'a PAS tourné."""


async def call_tool(family: str, tool: Dict[str, Any], arguments: Dict[str, Any], *,
                    username: str, user_id: int) -> Any:
    """Appelle ``tool`` au nom du propriétaire du jeton ; rend le corps de la
    réponse 200. Lève ``FamilyUnavailable`` (transport) ou ``ServiceSaturated``.
    Un délai dépassé est un échec d'OUTIL (enveloppe ``ok: false``), comme dans
    le chat : l'outil peut encore s'exécuter côté serveur."""
    cfg = family_cfg(family)
    if cfg is None:
        raise FamilyUnavailable(family)
    from llm_core._mcp_pool import MCPQueueSaturated, mcp_pool
    from llm_core._mcp_wrappers import _resolve_mcp_client
    from llm_core.engine.tool_dispatch import (
        _TOOL_QUEUE_WAIT_S,
        _tool_timeout_json,
        _tool_timeout_s,
    )
    name = str(tool["name"])
    # Identité du PROPRIÉTAIRE du jeton, rien du client. Pas de ``chat_id`` :
    # l'appel n'appartient à aucune conversation.
    meta = {"username": str(username), "user_id": str(int(user_id)),
            "call_id": f"openapi-{uuid.uuid4().hex[:12]}"}
    timeout_s = _tool_timeout_s(name)
    try:
        res = await mcp_pool.call_tool(
            cfg, name, arguments, resolve_client_fn=_resolve_mcp_client, meta=meta,
            exec_timeout_s=timeout_s, queue_timeout_s=_TOOL_QUEUE_WAIT_S)
    except asyncio.TimeoutError:
        return json.loads(_tool_timeout_json(name, timeout_s))
    except MCPQueueSaturated as exc:
        raise ServiceSaturated(str(exc)) from exc
    except asyncio.CancelledError:
        raise
    except Exception as exc:                                     # noqa: BLE001
        if _is_transport(exc):
            logger.warning("[openapi] appel %s/%s en échec de transport : %r", family, name, exc)
            raise FamilyUnavailable(family) from exc
        # Erreur levée côté outil (validation serveur, bogue) : échec d'OUTIL,
        # message déplié comme dans le chat.
        from llm_core.engine.tool_exec import flatten_exception_message
        return {"ok": False, "error": flatten_exception_message(exc)[:2000]}
    return _response_value(res, tool)


__all__ = ["EXPOSABLE_FAMILIES", "OPENAPI_PREFIX", "FamilyUnavailable", "ServiceSaturated",
           "build_spec", "call_tool", "clear_cache", "family_cfg", "family_tools",
           "validation_errors"]
