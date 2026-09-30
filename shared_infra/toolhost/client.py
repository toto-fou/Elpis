# SPDX-License-Identifier: MIT
"""shared_infra/toolhost/client.py — rappels de l'hôte d'outils vers l'app.

L'hôte n'ouvre jamais la base de l'app. Ce qu'il ne sait pas, il le DEMANDE
(``/api/internal/*``, jeton de service en Bearer), avec un cache court :

* ``introspect_token(pcr_…|ept_…)`` → compte lié à un jeton personnel (opencode, outils) ;
* ``identity_for_username(name)`` → ``{user_id, username, network_profile_id, is_admin}`` ;
* ``git_credential(user_id, remote_url)`` / ``connector_hosts(user_id)``.

Actif seulement si ``TOOLHOST_APP_URL`` est posé (``toolhost/config.py``) ;
sinon toutes les fonctions rendent ``None``/``[]`` et les appelants gardent
leur chemin local (base de l'app, mode co-localisé). Synchrone (appelé depuis
les threads des outils) ; jamais d'exception vers l'appelant.
"""
from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any, Dict, List, Optional

logger = logging.getLogger("uvicorn.error")

_TTL_S = 15.0
_NEG_TTL_S = 5.0
_TIMEOUT_S = 4.0
_lock = threading.Lock()
_cache: Dict[str, tuple] = {}


def app_url() -> str:
    return (os.environ.get("TOOLHOST_APP_URL") or "").strip().rstrip("/")


def service_token() -> str:
    tok = (os.environ.get("LOCAL_MCP_TOKEN") or "").strip()
    if tok:
        return tok
    try:
        from shared_infra import config as cfg
        return str(getattr(cfg, "LOCAL_MCP_TOKEN", "") or "").strip()
    except Exception:
        return ""


def enabled() -> bool:
    return bool(app_url()) and bool(service_token())


def _cached(key: str):
    with _lock:
        ent = _cache.get(key)
    if ent and ent[1] > time.monotonic():
        return True, ent[0]
    return False, None


def _store(key: str, value: Any) -> Any:
    with _lock:
        _cache[key] = (value, time.monotonic() + (_TTL_S if value else _NEG_TTL_S))
        if len(_cache) > 1024:
            now = time.monotonic()
            for k in [k for k, v in _cache.items() if v[1] <= now][:256]:
                _cache.pop(k, None)
    return value


def _request(method: str, path: str, *, params: Optional[Dict[str, Any]] = None,
             json_body: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    if not enabled():
        return None
    try:
        import httpx
        r = httpx.request(method, app_url() + path, params=params, json=json_body,
                          headers={"Authorization": f"Bearer {service_token()}"},
                          timeout=_TIMEOUT_S)
        if r.status_code != 200:
            logger.warning("[toolhost.client] %s %s → %s", method, path, r.status_code)
            return None
        data = r.json()
        return data if isinstance(data, dict) and data.get("ok") else None
    except Exception as e:                                        # noqa: BLE001
        logger.warning("[toolhost.client] %s %s injoignable : %r", method, path, e)
        return None


def introspect_token(token: str) -> Optional[Dict[str, Any]]:
    """``{user_id, username, kind, families}`` ou ``None``."""
    if not token:
        return None
    hit, val = _cached("tok:" + token)
    if hit:
        return val
    d = _request("POST", "/api/internal/tokens/introspect", json_body={"token": token})
    return _store("tok:" + token, {"user_id": int(d["user_id"]), "username": str(d["username"]),
                                    "kind": str(d.get("kind") or ""),
                                    "families": [str(f) for f in d.get("families") or []]}
                  if d else None)


def identity_for_username(username: str) -> Optional[Dict[str, Any]]:
    if not username:
        return None
    hit, val = _cached("id:" + username)
    if hit:
        return val
    d = _request("GET", "/api/internal/identity", params={"username": username})
    return _store("id:" + username, {"user_id": int(d["user_id"]), "username": str(d["username"]),
                                      "network_profile_id": str(d.get("network_profile_id") or ""),
                                      "is_admin": bool(d.get("is_admin"))} if d else None)


def git_credential(user_id: int, remote_url: str) -> Optional[Dict[str, Any]]:
    """``{username, token, host}`` — SECRET : jamais journalisé, jamais mis
    en cache au-delà du TTL court."""
    if not user_id or not remote_url:
        return None
    key = f"git:{int(user_id)}:{remote_url}"
    hit, val = _cached(key)
    if hit:
        return val
    d = _request("GET", "/api/internal/git/credential",
                 params={"user_id": int(user_id), "remote_url": remote_url})
    return _store(key, dict(d.get("credential") or {}) if d and d.get("credential") else None)


def connector_hosts(user_id: int) -> List[str]:
    if not user_id:
        return []
    key = f"hosts:{int(user_id)}"
    hit, val = _cached(key)
    if hit:
        return list(val or [])
    d = _request("GET", "/api/internal/git/connector-hosts", params={"user_id": int(user_id)})
    return list(_store(key, list(d.get("hosts") or []) if d else None) or [])


def clear_cache() -> None:
    with _lock:
        _cache.clear()
