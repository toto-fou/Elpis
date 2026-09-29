# SPDX-License-Identifier: MIT
"""shared_infra/accounts/identity.py — enveloppe d'identité (2026-09-11, P4).

L'hôte d'outils (``toolhost/``) n'ouvre JAMAIS la base de l'app : il reçoit
l'identité de l'utilisateur DE L'APP, par deux canaux :

* le ``_meta`` d'un appel d'outil MCP (``username``, ``user_id``, ``chat_id``,
  ``network_profile_id``) — posé par ``_chat_with_tools._build_call_meta`` ;
* l'en-tête HTTP/WS ``X-Elpis-Identity`` posé par le RELAIS de l'app
  (``shared_infra/sandbox/relay.py``) : JSON base64 signé HMAC avec le jeton
  de service, horodaté (rejeu borné).

Côté hôte, l'identité courante vit dans un ``ContextVar`` (posé par le
middleware d'auth HTTP et par le middleware FastMCP ``IdentityCapture``) et
dans un petit REGISTRE mémoire (dernières identités vues) pour les chemins
qui ne tournent pas dans le contexte de la requête (threads de pool, GC).
Les résolveurs historiques (``_get_sandbox_path`` → ``get_username_by_id``,
``get_user`` des familles d'outils, profil réseau) consultent ce module
D'ABORD, la base ENSUITE — inchangés en mode local (registre vide → base).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import threading
import time
from contextvars import ContextVar, Token
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional

IDENTITY_HEADER = "x-elpis-identity"
MAX_SKEW_S = 60.0


@dataclass
class Identity:
    user_id: int
    username: str
    roles: List[str] = field(default_factory=list)
    network_profile_id: str = ""
    chat_id: str = ""
    is_admin: bool = False   # admin PLEIN (is_admin == 1), jamais le modérateur

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> Optional["Identity"]:
        try:
            uid = int(d.get("user_id"))
            username = str(d.get("username") or "").strip()
        except (TypeError, ValueError):
            return None
        if uid <= 0 or not username:
            return None
        roles = d.get("roles") if isinstance(d.get("roles"), list) else []
        return cls(user_id=uid, username=username,
                   roles=[str(r) for r in roles],
                   network_profile_id=str(d.get("network_profile_id") or ""),
                   chat_id=str(d.get("chat_id") or ""),
                   # Audit 2026-09-22, M1 : ``== 1`` (True == 1 aussi) —
                   # un modérateur (2) n'est pas admin.
                   is_admin=(d.get("is_admin") == 1))

    # Vue « ligne users » minimale pour les appelants qui lisaient ``sqlite3.Row``
    def as_row(self) -> Dict[str, Any]:
        return {"id": self.user_id, "username": self.username,
                "is_admin": 1 if self.is_admin else 0}


# ── Contexte courant + registre ─────────────────────────────────────────────
_current: ContextVar[Optional[Identity]] = ContextVar("elpis_identity", default=None)
_lock = threading.Lock()
_by_id: Dict[int, Identity] = {}
_by_name: Dict[str, Identity] = {}
_REGISTRY_MAX = 2048


def set_current(identity: Optional[Identity]) -> Token:
    """Pose l'identité pour le contexte courant (et l'enregistre)."""
    if identity is not None:
        remember(identity)
    return _current.set(identity)


def reset_current(token: Token) -> None:
    _current.reset(token)


def current() -> Optional[Identity]:
    return _current.get()


def remember(identity: Identity) -> None:
    with _lock:
        _by_id[identity.user_id] = identity
        _by_name[identity.username] = identity
        if len(_by_id) > _REGISTRY_MAX:
            for k in list(_by_id)[: _REGISTRY_MAX // 4]:
                ident = _by_id.pop(k, None)
                if ident is not None:
                    _by_name.pop(ident.username, None)


def forget_all() -> None:
    with _lock:
        _by_id.clear()
        _by_name.clear()


def resolve_username(user_id: Any) -> Optional[str]:
    """Username d'un id : contexte courant, puis registre. ``None`` = inconnu
    (l'appelant retombe sur la base)."""
    try:
        uid = int(user_id)
    except (TypeError, ValueError):
        return None
    cur = _current.get()
    if cur is not None and cur.user_id == uid:
        return cur.username
    with _lock:
        ident = _by_id.get(uid)
    return ident.username if ident else None


def resolve_user(username: str) -> Optional[Identity]:
    """Identité d'un username : contexte courant, puis registre."""
    name = str(username or "").strip()
    if not name:
        return None
    cur = _current.get()
    if cur is not None and cur.username == name:
        return cur
    with _lock:
        return _by_name.get(name)


def resolve_network_profile_id(user_id: Any) -> Optional[str]:
    try:
        uid = int(user_id)
    except (TypeError, ValueError):
        return None
    cur = _current.get()
    ident = cur if (cur is not None and cur.user_id == uid) else None
    if ident is None:
        with _lock:
            ident = _by_id.get(uid)
    if ident is None:
        return None
    return ident.network_profile_id or None


# ── Enveloppe signée (en-tête HTTP/WS) ──────────────────────────────────────
def _b64e(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")


def _b64d(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def sign(identity: Identity, key: str, *, now: Optional[float] = None) -> str:
    """``<payload b64>.<hmac-sha256 b64>`` — payload = identité + ``ts``."""
    if not key:
        raise ValueError("jeton de service absent : impossible de signer l'identité")
    body = dict(identity.to_dict())
    body["ts"] = float(now if now is not None else time.time())
    raw = json.dumps(body, separators=(",", ":"), sort_keys=True).encode("utf-8")
    mac = hmac.new(key.encode("utf-8"), raw, hashlib.sha256).digest()
    return f"{_b64e(raw)}.{_b64e(mac)}"


def verify(header: str, key: str, *, now: Optional[float] = None,
           max_skew_s: float = MAX_SKEW_S) -> Optional[Identity]:
    """Identité de l'en-tête si la signature et l'horodatage sont valides,
    sinon ``None`` (jamais d'exception : un en-tête forgé est un 401)."""
    if not header or not key or "." not in header:
        return None
    try:
        p, m = header.split(".", 1)
        raw = _b64d(p)
        mac = _b64d(m)
    except Exception:
        return None
    expect = hmac.new(key.encode("utf-8"), raw, hashlib.sha256).digest()
    if not hmac.compare_digest(mac, expect):
        return None
    try:
        body = json.loads(raw.decode("utf-8"))
    except Exception:
        return None
    if not isinstance(body, dict):
        return None
    try:
        ts = float(body.get("ts"))
    except (TypeError, ValueError):
        return None
    t = float(now if now is not None else time.time())
    if abs(t - ts) > max_skew_s:
        return None
    return Identity.from_dict(body)


def from_meta(meta: Any) -> Optional[Identity]:
    """Identité portée par le ``_meta`` d'un appel MCP (``username`` requis,
    ``user_id`` facultatif — 0 si absent : l'hôte le résout par rappel)."""
    if meta is None:
        return None
    get = meta.get if isinstance(meta, dict) else (lambda k: getattr(meta, k, None))
    username = str(get("username") or "").strip()
    if not username:
        return None
    try:
        uid = int(get("user_id") or 0)
    except (TypeError, ValueError):
        uid = 0
    ident = Identity(user_id=uid, username=username,
                     network_profile_id=str(get("network_profile_id") or ""),
                     chat_id=str(get("chat_id") or ""))
    return ident
