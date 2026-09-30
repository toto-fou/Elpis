# SPDX-License-Identifier: MIT
"""shared_infra/mcp/oauth.py — autorisation OAuth 2.1 des clients MCP (EXT.4).

Elpis est son propre serveur d'autorisation (spécification MCP
« Authorization », révision 2025-11-25) : un client MCP ne reçoit que l'URL du
relais ``<origine>/api/mcp-bridge[/<famille>]``, découvre l'autorisation
(RFC 9728 puis RFC 8414), s'enregistre (RFC 7591, ou document de métadonnées
client « CIMD »), envoie l'utilisateur sur l'écran de consentement d'Elpis
(code d'autorisation + PKCE S256), puis échange le code contre des jetons.

Ce module porte le STOCKAGE et les règles ; les routes HTTP vivent dans
``routes_oauth.py``.

* Ressource protégée UNIQUE : ``<origine>/api/mcp-bridge`` (RFC 8707). Un
  jeton vaut pour toutes les familles qu'il porte ; demandé pour une famille
  (``…/api/mcp-bridge/<famille>``), il est borné à elle.
* Portées : ``tools`` (toutes les familles permises) et ``tools:<famille>``,
  toujours bornées par la politique des jetons d'outils
  (``mcp.tokens.tools_enabled`` / ``tools_families``).
* Jetons OPAQUES, empreinte SHA-256 seule : accès ``eoa_`` (1 h par défaut),
  rafraîchissement ``eor_`` (30 jours, bornés par ``mcp.tokens.max_days``) avec
  rotation ; un rafraîchissement rejoué révoque toute l'autorisation.
* Codes d'autorisation : usage unique, 2 minutes ; un code rejoué révoque les
  jetons qu'il avait produits.
* Clients : enregistrement dynamique (activé par défaut, désactivable),
  redirections limitées à la boucle locale (``http://127.0.0.1|localhost|[::1]``,
  tout port) et à ``https://`` ; documents CIMD récupérés en ``https`` sous la
  garde SSRF commune ; clients ajoutés à la main par l'admin.

Politique (``mcp.oauth.*``, relue à chaud) : ``enabled`` (vrai), ``dcr_enabled``
(vrai), ``access_ttl_s`` (3600), ``refresh_days`` (30).
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import secrets
import time
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import urlsplit

from shared_infra.db import _connection as _dbc
from shared_infra.db._connection import db_conn, db_tx

logger = logging.getLogger(__name__)

ACCESS_PREFIX = "eoa_"
REFRESH_PREFIX = "eor_"
RESOURCE_PATH = "/api/mcp-bridge"
SCOPE_ALL = "tools"
SCOPE_PREFIX = "tools:"
CODE_TTL_S = 120.0
_TOUCH_EVERY_S = 300.0
_MAX_CLIENTS = 1000
_DCR_STALE_S = 7 * 86400.0          # client dynamique jamais utilisé : oublié
_CIMD_REFRESH_S = 86400.0
_CIMD_MAX_BYTES = 64 * 1024
_NAME_MAX = 100
_REDIRECTS_MAX = 10
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "[::1]", "::1"})

DEFAULT_ACCESS_TTL_S = 3600
DEFAULT_REFRESH_DAYS = 30


class OAuthError(Exception):
    """Erreur OAuth normalisée (``error`` RFC 6749 + description courte)."""

    def __init__(self, error: str, description: str = "", status: int = 400):
        super().__init__(description or error)
        self.error = error
        self.description = description
        self.status = status

    def body(self) -> Dict[str, str]:
        out = {"error": self.error}
        if self.description:
            out["error_description"] = self.description
        return out


# ── Politique ────────────────────────────────────────────────────────────────
def _cfg(path: str, default: Any) -> Any:
    try:
        from shared_infra.config import live_config_value
        v = live_config_value(path, default)
        return default if v is None else v
    except Exception:                                             # noqa: BLE001
        return default


def _truthy(v: Any) -> bool:
    return v is not False and str(v).strip().lower() not in ("false", "0", "off", "no", "")


def _as_int(v: Any, default: int, lo: int, hi: int) -> int:
    try:
        n = int(v)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


def policy() -> Dict[str, Any]:
    """Politique OAuth + familles permises (politique des jetons d'outils)."""
    from shared_infra.accounts import tokens as _tokens
    tp = _tokens.policy()
    refresh_days = _as_int(_cfg("mcp.oauth.refresh_days", DEFAULT_REFRESH_DAYS),
                           DEFAULT_REFRESH_DAYS, 1, 3650)
    if tp["max_days"]:
        refresh_days = min(refresh_days, int(tp["max_days"]))
    return {
        "enabled": _truthy(_cfg("mcp.oauth.enabled", True)) and bool(tp["tools_enabled"]),
        "dcr_enabled": _truthy(_cfg("mcp.oauth.dcr_enabled", True)),
        "access_ttl_s": _as_int(_cfg("mcp.oauth.access_ttl_s", DEFAULT_ACCESS_TTL_S),
                                DEFAULT_ACCESS_TTL_S, 300, 86400),
        "refresh_days": refresh_days,
        "families": list(tp["tools_families"]),
    }


def scopes_supported(pol: Optional[Dict[str, Any]] = None) -> List[str]:
    pol = pol or policy()
    return [SCOPE_ALL] + [SCOPE_PREFIX + f for f in pol["families"]]


def families_from_scope(scope: Optional[str], pol: Optional[Dict[str, Any]] = None) -> List[str]:
    """Portée demandée → familles permises (ordre de la politique). Portée
    absente ou ``tools`` = toutes les familles permises ; une portée inconnue
    est ignorée."""
    pol = pol or policy()
    allowed = list(pol["families"])
    items = [s for s in str(scope or "").split() if s]
    if not items or SCOPE_ALL in items:
        return allowed
    wanted = {s[len(SCOPE_PREFIX):] for s in items if s.startswith(SCOPE_PREFIX)}
    return [f for f in allowed if f in wanted]


def scope_of(families: Iterable[str]) -> str:
    return " ".join(SCOPE_PREFIX + f for f in families)


# ── Stockage ─────────────────────────────────────────────────────────────────
_ready: set = set()


def _prepare() -> None:
    """Tables posées une fois par process et par base (sur PostgreSQL et
    MariaDB, la migration 0023 est tamponnée sans être rejouée)."""
    key = (os.getpid(), str(getattr(_dbc, "DB_PATH", "")))
    if key in _ready:
        return
    from shared_infra.db._schema import ensure_tables
    with db_tx() as c:
        ensure_tables(c, ("oauth_clients", "oauth_codes", "oauth_tokens"))
    _ready.add(key)


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _families_csv(families: Iterable[str]) -> str:
    return ",".join(f for f in families if f)


def _families_list(csv: Any) -> List[str]:
    return [f for f in str(csv or "").split(",") if f]


# ── Ressource (RFC 8707) ─────────────────────────────────────────────────────
def resource_base(app_url: str) -> str:
    """URL canonique de la ressource protégée pour une origine d'app."""
    p = urlsplit(app_url.rstrip("/"))
    return f"{p.scheme.lower()}://{p.netloc.lower()}{RESOURCE_PATH}"


def resource_family(resource: str) -> Optional[str]:
    """Famille d'une ressource ``…/api/mcp-bridge/<famille>``, sinon ``None``."""
    try:
        path = urlsplit(str(resource or "")).path.rstrip("/")
    except ValueError:
        return None
    if path.startswith(RESOURCE_PATH + "/"):
        return path[len(RESOURCE_PATH) + 1:] or None
    return None


def check_resource(resource: str, app_url: str, pol: Optional[Dict[str, Any]] = None
                   ) -> Tuple[str, Optional[str]]:
    """``resource`` demandé → ``(ressource canonique, famille ou None)``.

    Accepte la ressource de base et ses enfants ``…/<famille>`` (famille
    permise) ; sinon ``OAuthError('invalid_target')``."""
    pol = pol or policy()
    base = resource_base(app_url)
    r = str(resource or "").strip()
    if not r:
        raise OAuthError("invalid_target", "Paramètre resource requis.")
    try:
        p = urlsplit(r)
    except ValueError:
        raise OAuthError("invalid_target", "Ressource mal formée.")
    if p.fragment:
        raise OAuthError("invalid_target", "Ressource mal formée.")
    canon = f"{p.scheme.lower()}://{p.netloc.lower()}{p.path.rstrip('/')}"
    if canon == base:
        return base, None
    if canon.startswith(base + "/"):
        fam = canon[len(base) + 1:]
        if fam in pol["families"]:
            return canon, fam
    raise OAuthError("invalid_target", "Ressource inconnue de ce serveur.")


# ── Clients ──────────────────────────────────────────────────────────────────
def _redirect_ok(uri: str) -> bool:
    """Redirection permise : boucle locale en http (tout port) ou https."""
    try:
        p = urlsplit(str(uri or ""))
    except ValueError:
        return False
    if p.fragment or not p.netloc or p.username or p.password:
        return False
    host = (p.hostname or "").lower()
    if p.scheme == "https":
        return bool(host)
    if p.scheme == "http":
        return host in _LOOPBACK_HOSTS
    return False


def _is_loopback(uri: str) -> bool:
    try:
        p = urlsplit(uri)
    except ValueError:
        return False
    return p.scheme == "http" and (p.hostname or "").lower() in _LOOPBACK_HOSTS


def redirect_matches(requested: str, registered: Iterable[str]) -> bool:
    """Correspondance EXACTE, sauf le port d'une redirection en boucle locale
    (RFC 8252 § 7.3 : l'application choisit son port au lancement)."""
    for reg in registered:
        if requested == reg:
            return True
        if _is_loopback(requested) and _is_loopback(reg):
            a, b = urlsplit(requested), urlsplit(reg)
            if ((a.hostname or "").lower() == (b.hostname or "").lower()
                    and a.path == b.path and a.query == b.query):
                return True
    return False


def _client_row(r: Any) -> Dict[str, Any]:
    try:
        redirects = json.loads(r[5] or "[]")
    except ValueError:
        redirects = []
    try:
        meta = json.loads(r[6] or "{}")
    except ValueError:
        meta = {}
    return {"client_id": str(r[0]), "kind": str(r[1]), "name": str(r[2] or ""),
            "has_secret": bool(r[3]), "secret_hash": str(r[3] or ""), "auth_method": str(r[4] or "none"),
            "redirect_uris": [str(u) for u in redirects if isinstance(u, str)],
            "metadata": meta if isinstance(meta, dict) else {},
            "created_at": float(r[7] or 0), "fetched_at": r[8], "last_used_at": r[9]}


_CLIENT_COLS = ("client_id, kind, name, secret_hash, auth_method, redirect_uris, metadata, "
                "created_at, fetched_at, last_used_at")


def get_client(client_id: str) -> Optional[Dict[str, Any]]:
    _prepare()
    with db_conn() as c:
        r = c.execute(f"SELECT {_CLIENT_COLS} FROM oauth_clients WHERE client_id=?",
                      (str(client_id or ""),)).fetchone()
    return _client_row(r) if r else None


def _validate_metadata(meta: Dict[str, Any]) -> Dict[str, Any]:
    """Métadonnées de client (RFC 7591) → champs retenus, ou ``OAuthError``."""
    if not isinstance(meta, dict):
        raise OAuthError("invalid_client_metadata", "Objet JSON attendu.")
    redirects = meta.get("redirect_uris")
    if not isinstance(redirects, list) or not redirects or len(redirects) > _REDIRECTS_MAX:
        raise OAuthError("invalid_redirect_uri", "redirect_uris : 1 à 10 adresses.")
    redirects = [str(u) for u in redirects]
    if not all(_redirect_ok(u) for u in redirects):
        raise OAuthError("invalid_redirect_uri",
                         "Redirections permises : http://127.0.0.1, http://localhost ou https://.")
    grants = meta.get("grant_types") or ["authorization_code", "refresh_token"]
    if not isinstance(grants, list) or not set(grants) <= {"authorization_code", "refresh_token"} \
            or "authorization_code" not in grants:
        raise OAuthError("invalid_client_metadata", "grant_types : authorization_code (+ refresh_token).")
    responses = meta.get("response_types") or ["code"]
    if responses != ["code"]:
        raise OAuthError("invalid_client_metadata", "response_types : code seul.")
    method = str(meta.get("token_endpoint_auth_method") or "client_secret_basic")
    if method not in ("none", "client_secret_basic", "client_secret_post"):
        raise OAuthError("invalid_client_metadata", "token_endpoint_auth_method non pris en charge.")
    name = str(meta.get("client_name") or "").strip()[:_NAME_MAX]
    return {"redirect_uris": redirects, "grant_types": grants, "auth_method": method,
            "client_name": name}


def register_client(meta: Dict[str, Any], *, kind: str = "dcr") -> Dict[str, Any]:
    """Enregistrement d'un client (RFC 7591) → réponse d'enregistrement
    (``client_secret`` en clair UNE fois si la méthode l'exige)."""
    v = _validate_metadata(meta)
    _prepare()
    now = time.time()
    client_id = "elpis-" + secrets.token_urlsafe(18)
    secret = ""
    if v["auth_method"] != "none":
        secret = "ecs_" + secrets.token_urlsafe(32)
    stored = {"grant_types": v["grant_types"], "client_uri": str(meta.get("client_uri") or "")[:300]}
    with db_tx() as c:
        if kind == "dcr":
            # Ménage : clients dynamiques jamais utilisés depuis une semaine.
            c.execute("DELETE FROM oauth_clients WHERE kind='dcr' AND last_used_at IS NULL "
                      "AND created_at<?", (now - _DCR_STALE_S,))
            n = c.execute("SELECT COUNT(*) FROM oauth_clients").fetchone()
            if n and int(n[0]) >= _MAX_CLIENTS:
                raise OAuthError("invalid_client_metadata",
                                 "Trop de clients enregistrés ; demandez à l'administrateur.")
        c.execute(
            "INSERT INTO oauth_clients(client_id, kind, name, secret_hash, auth_method, "
            "redirect_uris, metadata, created_at) VALUES(?,?,?,?,?,?,?,?)",
            (client_id, kind, v["client_name"] or "Client MCP", digest(secret) if secret else "",
             v["auth_method"], json.dumps(v["redirect_uris"]), json.dumps(stored), now))
    out: Dict[str, Any] = {
        "client_id": client_id, "client_id_issued_at": int(now),
        "client_name": v["client_name"] or "Client MCP", "redirect_uris": v["redirect_uris"],
        "grant_types": v["grant_types"], "response_types": ["code"],
        "token_endpoint_auth_method": v["auth_method"],
    }
    if secret:
        out["client_secret"] = secret
        out["client_secret_expires_at"] = 0
    return out


def delete_client(client_id: str) -> bool:
    """Suppression d'un client et de tout ce qu'il a obtenu (console)."""
    _prepare()
    with db_tx() as c:
        c.execute("DELETE FROM oauth_tokens WHERE client_id=?", (str(client_id),))
        c.execute("DELETE FROM oauth_codes WHERE client_id=?", (str(client_id),))
        cur = c.execute("DELETE FROM oauth_clients WHERE client_id=?", (str(client_id),))
        return bool(cur.rowcount)


def list_clients() -> List[Dict[str, Any]]:
    """Clients connus (console) : sans empreinte de secret, avec le nombre
    d'autorisations actives."""
    _prepare()
    now = time.time()
    with db_conn() as c:
        rows = c.execute(f"SELECT {_CLIENT_COLS} FROM oauth_clients ORDER BY created_at DESC").fetchall()
        actives = dict(c.execute(
            "SELECT client_id, COUNT(DISTINCT grant_id) FROM oauth_tokens WHERE kind='refresh' "
            "AND revoked_at IS NULL AND expires_at>? GROUP BY client_id", (now,)).fetchall())
    out = []
    for r in rows:
        d = _client_row(r)
        d.pop("secret_hash", None)
        d["grants"] = int(actives.get(d["client_id"], 0))
        out.append(d)
    return out


def is_cimd_client_id(client_id: str) -> bool:
    """Identifiant de client = URL https à chemin non vide (document CIMD)."""
    try:
        p = urlsplit(str(client_id or ""))
    except ValueError:
        return False
    return p.scheme == "https" and bool(p.netloc) and p.path not in ("", "/")


def fetch_cimd(client_id: str) -> Dict[str, Any]:
    """Client décrit par un document de métadonnées (CIMD) : récupéré en
    https sous la garde SSRF commune (jamais une adresse non routable),
    borné, puis mis en cache 24 h dans ``oauth_clients``."""
    existing = get_client(client_id)
    if existing and existing["kind"] == "cimd" and existing["fetched_at"] \
            and time.time() - float(existing["fetched_at"]) < _CIMD_REFRESH_S:
        return existing
    from shared_infra.git.ssrf import block_remote_url_reason
    reason = block_remote_url_reason(client_id, allow_schemes=("https",))
    if reason:
        raise OAuthError("invalid_client", "Document de client injoignable depuis ce serveur.")
    import httpx
    try:
        with httpx.Client(timeout=httpx.Timeout(5.0), follow_redirects=False) as h:
            with h.stream("GET", client_id, headers={"Accept": "application/json"}) as r:
                if r.status_code != 200:
                    raise OAuthError("invalid_client", "Document de client introuvable.")
                raw = b""
                for chunk in r.iter_bytes():
                    raw += chunk
                    if len(raw) > _CIMD_MAX_BYTES:
                        raise OAuthError("invalid_client", "Document de client trop volumineux.")
    except httpx.HTTPError:
        raise OAuthError("invalid_client", "Document de client injoignable depuis ce serveur.")
    try:
        doc = json.loads(raw)
    except ValueError:
        raise OAuthError("invalid_client", "Document de client illisible.")
    if not isinstance(doc, dict) or str(doc.get("client_id") or "") != client_id:
        raise OAuthError("invalid_client", "Document de client incohérent.")
    v = _validate_metadata({**doc, "token_endpoint_auth_method":
                            doc.get("token_endpoint_auth_method") or "none"})
    if v["auth_method"] != "none":
        raise OAuthError("invalid_client", "Un client CIMD est public (méthode none).")
    _prepare()
    now = time.time()
    with db_tx() as c:
        if existing:
            c.execute("UPDATE oauth_clients SET name=?, redirect_uris=?, fetched_at=? WHERE client_id=?",
                      (v["client_name"] or client_id, json.dumps(v["redirect_uris"]), now, client_id))
        else:
            c.execute(
                "INSERT INTO oauth_clients(client_id, kind, name, secret_hash, auth_method, "
                "redirect_uris, metadata, created_at, fetched_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (client_id, "cimd", v["client_name"] or client_id, "", "none",
                 json.dumps(v["redirect_uris"]), "{}", now, now))
    got = get_client(client_id)
    assert got is not None
    return got


def resolve_client(client_id: str) -> Dict[str, Any]:
    """Client d'une demande d'autorisation (enregistré, ou CIMD récupéré)."""
    cid = str(client_id or "").strip()
    if not cid or len(cid) > 255:
        raise OAuthError("invalid_client", "Client inconnu.")
    c = get_client(cid)
    if c and c["kind"] != "cimd":
        return c
    if is_cimd_client_id(cid):
        return fetch_cimd(cid)
    raise OAuthError("invalid_client", "Client inconnu.")


def authenticate_client(client_id: str, secret: Optional[str]) -> Dict[str, Any]:
    """Client au point de jeton : secret vérifié s'il en a un ; un client
    public (``none``) n'en présente pas."""
    c = get_client(client_id)
    if not c:
        raise OAuthError("invalid_client", "Client inconnu.", status=401)
    if c["has_secret"]:
        if not secret or not secrets.compare_digest(digest(secret), c["secret_hash"]):
            raise OAuthError("invalid_client", "Authentification du client refusée.", status=401)
    return c


# ── Codes d'autorisation ─────────────────────────────────────────────────────
def pkce_ok(verifier: str, challenge: str) -> bool:
    v = str(verifier or "")
    if not 43 <= len(v) <= 128:
        return False
    calc = base64.urlsafe_b64encode(hashlib.sha256(v.encode("ascii", "ignore")).digest()).decode().rstrip("=")
    return bool(challenge) and secrets.compare_digest(calc, str(challenge))


def issue_code(*, client_id: str, user_id: int, redirect_uri: str, code_challenge: str,
               resource: str, families: List[str]) -> str:
    _prepare()
    code = "eoc_" + secrets.token_urlsafe(32)
    now = time.time()
    with db_tx() as c:
        c.execute("DELETE FROM oauth_codes WHERE expires_at<?", (now - 3600,))
        c.execute(
            "INSERT INTO oauth_codes(code_hash, client_id, user_id, grant_id, redirect_uri, "
            "code_challenge, resource, families, created_at, expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (digest(code), client_id, int(user_id), secrets.token_hex(16), redirect_uri,
             code_challenge, resource, _families_csv(families), now, now + CODE_TTL_S))
    return code


def _issue_pair(c: Any, *, grant_id: str, user_id: int, client_id: str, families: List[str],
                resource: str, pol: Dict[str, Any], refresh_deadline: Optional[float] = None
                ) -> Dict[str, Any]:
    now = time.time()
    access = ACCESS_PREFIX + secrets.token_urlsafe(32)
    refresh = REFRESH_PREFIX + secrets.token_urlsafe(32)
    ttl = int(pol["access_ttl_s"])
    deadline = refresh_deadline or (now + pol["refresh_days"] * 86400.0)
    for kind, tok, exp in (("access", access, now + ttl), ("refresh", refresh, deadline)):
        c.execute(
            "INSERT INTO oauth_tokens(grant_id, user_id, client_id, kind, token_hash, families, "
            "resource, created_at, expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
            (grant_id, int(user_id), client_id, kind, digest(tok), _families_csv(families),
             resource, now, exp))
    c.execute("UPDATE oauth_clients SET last_used_at=? WHERE client_id=?", (now, client_id))
    return {"access_token": access, "token_type": "Bearer", "expires_in": ttl,
            "refresh_token": refresh, "scope": scope_of(families)}


def _revoke_grant(c: Any, grant_id: str) -> None:
    c.execute("UPDATE oauth_tokens SET revoked_at=? WHERE grant_id=? AND revoked_at IS NULL",
              (time.time(), grant_id))


def exchange_code(*, code: str, client: Dict[str, Any], redirect_uri: str, code_verifier: str,
                  resource: Optional[str], app_url: str) -> Dict[str, Any]:
    """Code d'autorisation → jetons (usage unique, PKCE vérifié)."""
    pol = policy()
    if not pol["enabled"]:
        raise OAuthError("invalid_grant", "Autorisation désactivée par l'administrateur.")
    _prepare()
    now = time.time()
    h = digest(str(code or ""))
    # Les écritures (code consommé, révocation sur rejeu) doivent SURVIVRE au
    # refus : l'erreur est levée après la transaction, jamais dedans.
    err: Optional[OAuthError] = None
    out: Dict[str, Any] = {}
    with db_tx() as c:
        r = c.execute(
            "SELECT client_id, user_id, grant_id, redirect_uri, code_challenge, resource, families, "
            "expires_at, used_at FROM oauth_codes WHERE code_hash=?", (h,)).fetchone()
        if not r:
            err = OAuthError("invalid_grant", "Code inconnu.")
        else:
            cid, uid, grant_id, ruri, challenge, res, fams, exp, used = r
            if used is not None:
                # Code rejoué : les jetons qu'il a produits sont révoqués.
                _revoke_grant(c, grant_id)
                err = OAuthError("invalid_grant", "Code déjà utilisé.")
            else:
                c.execute("UPDATE oauth_codes SET used_at=? WHERE code_hash=?", (now, h))
                families = [f for f in _families_list(fams) if f in pol["families"]]
                target = None
                if resource:
                    try:
                        canon, _fam = check_resource(resource, app_url, pol)
                        if canon != res:
                            target = OAuthError("invalid_target", "Ressource différente de celle de la demande.")
                    except OAuthError as e:
                        target = e
                if cid != client["client_id"]:
                    err = OAuthError("invalid_grant", "Code émis pour un autre client.")
                elif float(exp) < now:
                    err = OAuthError("invalid_grant", "Code expiré.")
                elif str(redirect_uri or "") != ruri:
                    err = OAuthError("invalid_grant", "redirect_uri différente de celle de la demande.")
                elif not pkce_ok(code_verifier, challenge):
                    err = OAuthError("invalid_grant", "Vérification PKCE refusée.")
                elif target is not None:
                    err = target
                elif not c.execute("SELECT 1 FROM users WHERE id=?", (int(uid),)).fetchone():
                    err = OAuthError("invalid_grant", "Compte supprimé.")
                elif not families:
                    err = OAuthError("invalid_scope", "Aucune famille encore autorisée.")
                else:
                    out = _issue_pair(c, grant_id=grant_id, user_id=int(uid), client_id=cid,
                                      families=families, resource=res, pol=pol)
    if err is not None:
        raise err
    return out


def refresh(*, refresh_token: str, client: Dict[str, Any], scope: Optional[str],
            resource: Optional[str], app_url: str) -> Dict[str, Any]:
    """Rafraîchissement avec rotation ; un jeton de rafraîchissement rejoué
    révoque toute l'autorisation."""
    pol = policy()
    if not pol["enabled"]:
        raise OAuthError("invalid_grant", "Autorisation désactivée par l'administrateur.")
    tok = str(refresh_token or "")
    if not tok.startswith(REFRESH_PREFIX):
        raise OAuthError("invalid_grant", "Jeton de rafraîchissement inconnu.")
    _prepare()
    now = time.time()
    # Comme pour le code : la révocation sur rejeu doit survivre au refus.
    err: Optional[OAuthError] = None
    out: Dict[str, Any] = {}
    with db_tx() as c:
        r = c.execute(
            "SELECT id, grant_id, user_id, client_id, families, resource, expires_at, used_at, revoked_at "
            "FROM oauth_tokens WHERE token_hash=? AND kind='refresh'", (digest(tok),)).fetchone()
        if not r:
            err = OAuthError("invalid_grant", "Jeton de rafraîchissement inconnu.")
        else:
            tid, grant_id, uid, cid, fams, res, exp, used, revoked = r
            granted = [f for f in _families_list(fams) if f in pol["families"]]
            if scope:
                narrowed = families_from_scope(scope, pol)
                if set(narrowed) <= set(granted):
                    granted = narrowed
                else:
                    granted = []
                    err = OAuthError("invalid_scope", "Portée plus large que l'autorisation.")
            target = None
            if resource:
                try:
                    canon, _fam = check_resource(resource, app_url, pol)
                    if canon != res:
                        target = OAuthError("invalid_target", "Ressource différente de celle de l'autorisation.")
                except OAuthError as e:
                    target = e
            if cid != client["client_id"]:
                err = OAuthError("invalid_grant", "Jeton émis pour un autre client.")
            elif used is not None or revoked is not None:
                _revoke_grant(c, grant_id)
                err = OAuthError("invalid_grant", "Jeton de rafraîchissement déjà utilisé ou révoqué.")
            elif float(exp) < now:
                err = OAuthError("invalid_grant", "Jeton de rafraîchissement expiré.")
            elif target is not None:
                err = target
            elif not c.execute("SELECT 1 FROM users WHERE id=?", (int(uid),)).fetchone():
                err = OAuthError("invalid_grant", "Compte supprimé.")
            elif err is None and not granted:
                err = OAuthError("invalid_scope", "Aucune famille encore autorisée.")
            elif err is None:
                c.execute("UPDATE oauth_tokens SET used_at=? WHERE id=?", (now, int(tid)))
                # L'ancien jeton d'accès du même lot n'a plus lieu d'être.
                c.execute("UPDATE oauth_tokens SET revoked_at=? WHERE grant_id=? AND kind='access' "
                          "AND revoked_at IS NULL", (now, grant_id))
                out = _issue_pair(c, grant_id=grant_id, user_id=int(uid), client_id=cid,
                                  families=granted, resource=res, pol=pol, refresh_deadline=float(exp))
    if err is not None:
        raise err
    return out


def revoke_token(token: str, client_id: Optional[str] = None) -> None:
    """RFC 7009 : jeton de rafraîchissement → toute l'autorisation ; jeton
    d'accès → lui seul. Jeton inconnu : rien (la réponse reste 200)."""
    tok = str(token or "")
    if not tok.startswith((ACCESS_PREFIX, REFRESH_PREFIX)):
        return
    _prepare()
    with db_tx() as c:
        r = c.execute("SELECT id, grant_id, kind, client_id FROM oauth_tokens WHERE token_hash=?",
                      (digest(tok),)).fetchone()
        if not r or (client_id and str(r[3]) != str(client_id)):
            return
        if r[2] == "refresh":
            _revoke_grant(c, r[1])
        else:
            c.execute("UPDATE oauth_tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL",
                      (time.time(), int(r[0])))


# ── Vérification (relais) ────────────────────────────────────────────────────
_touched: Dict[int, float] = {}


def verify_access_token(token: str) -> Optional[Dict[str, Any]]:
    """Jeton d'accès valide → client du relais ``{user_id, username, kind:
    "oauth", families, client_id, grant_id, resource}``, sinon ``None``."""
    tok = str(token or "").strip()
    if not tok.startswith(ACCESS_PREFIX) or len(tok) < 20:
        return None
    pol = policy()
    if not pol["enabled"]:
        return None
    try:
        _prepare()
        with db_conn() as c:
            r = c.execute(
                "SELECT t.id, t.grant_id, t.user_id, t.client_id, t.families, t.resource, t.expires_at, "
                "t.revoked_at, t.last_used_at, u.username FROM oauth_tokens t "
                "JOIN users u ON u.id = t.user_id WHERE t.token_hash=? AND t.kind='access'",
                (digest(tok),)).fetchone()
    except Exception:                                             # noqa: BLE001
        logger.warning("[oauth] vérification impossible", exc_info=True)
        return None
    if not r or r[7] is not None or float(r[6]) <= time.time() or not r[9]:
        return None
    families = [f for f in _families_list(r[4]) if f in pol["families"]]
    res = str(r[5] or "")
    fam = resource_family(res)
    if fam is not None:
        # Ressource demandée pour une seule famille : bornée à elle.
        families = [f for f in families if f == fam]
    if not families:
        return None
    _touch(int(r[0]), r[8])
    return {"user_id": int(r[2]), "username": str(r[9]), "kind": "oauth", "families": families,
            "client_id": str(r[3]), "grant_id": str(r[1]), "resource": res}


def _touch(token_id: int, known: Any) -> None:
    now = time.time()
    last = max(float(known or 0), _touched.get(token_id, 0.0))
    if now - last < _TOUCH_EVERY_S:
        return
    _touched[token_id] = now
    try:
        with db_tx() as c:
            c.execute("UPDATE oauth_tokens SET last_used_at=? WHERE id=?", (now, token_id))
    except Exception:                                             # noqa: BLE001
        logger.debug("[oauth] last_used_at non mis à jour", exc_info=True)


# ── Autorisations d'un compte (« Connexions ») ───────────────────────────────
def list_grants(user_id: int) -> List[Dict[str, Any]]:
    """Applications autorisées par un compte : une ligne par autorisation
    encore valable (jeton de rafraîchissement non révoqué et non expiré)."""
    _prepare()
    now = time.time()
    with db_conn() as c:
        rows = c.execute(
            "SELECT t.grant_id, t.client_id, t.families, MIN(t.created_at), MAX(t.expires_at), "
            "MAX(COALESCE(t.last_used_at, 0)), cl.name FROM oauth_tokens t "
            "LEFT JOIN oauth_clients cl ON cl.client_id = t.client_id "
            "WHERE t.user_id=? AND t.kind='refresh' AND t.revoked_at IS NULL AND t.used_at IS NULL "
            "AND t.expires_at>? GROUP BY t.grant_id, t.client_id, t.families, cl.name "
            "ORDER BY MIN(t.created_at) DESC", (int(user_id), now)).fetchall()
        firsts = dict(c.execute(
            "SELECT grant_id, MIN(created_at) FROM oauth_tokens WHERE user_id=? GROUP BY grant_id",
            (int(user_id),)).fetchall())
        used = dict(c.execute(
            "SELECT grant_id, MAX(last_used_at) FROM oauth_tokens WHERE user_id=? AND kind='access' "
            "GROUP BY grant_id", (int(user_id),)).fetchall())
    return [{"grant_id": str(r[0]), "client_id": str(r[1]), "client_name": str(r[6] or r[1]),
             "families": _families_list(r[2]), "created_at": float(firsts.get(r[0]) or r[3] or 0),
             "expires_at": float(r[4] or 0), "last_used_at": used.get(r[0])} for r in rows]


def revoke_grant(user_id: int, grant_id: str) -> bool:
    _prepare()
    with db_tx() as c:
        cur = c.execute("UPDATE oauth_tokens SET revoked_at=? WHERE grant_id=? AND user_id=? "
                        "AND revoked_at IS NULL", (time.time(), str(grant_id), int(user_id)))
        return bool(cur.rowcount)


def delete_for_user(user_id: int, conn: Any = None) -> None:
    """Purge d'un compte supprimé (dans la transaction de l'appelant si
    ``conn`` est fourni)."""
    sqls = ("DELETE FROM oauth_tokens WHERE user_id=?", "DELETE FROM oauth_codes WHERE user_id=?")
    if conn is not None:
        for sql in sqls:
            conn.execute(sql, (int(user_id),))
        return
    _prepare()
    with db_tx() as c:
        for sql in sqls:
            c.execute(sql, (int(user_id),))


__all__ = ["ACCESS_PREFIX", "OAuthError", "REFRESH_PREFIX", "RESOURCE_PATH", "authenticate_client",
           "check_resource", "delete_client", "delete_for_user", "exchange_code", "families_from_scope",
           "fetch_cimd", "issue_code", "list_clients", "list_grants", "policy", "redirect_matches",
           "refresh", "register_client", "resolve_client", "resource_base", "revoke_grant",
           "revoke_token", "scope_of", "scopes_supported", "verify_access_token"]
