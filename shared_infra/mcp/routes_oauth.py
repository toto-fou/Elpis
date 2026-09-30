# SPDX-License-Identifier: MIT
"""shared_infra/mcp/routes_oauth.py — routes de l'autorisation OAuth 2.1 des
clients MCP (EXT.4) : découverte, enregistrement, consentement, jetons,
révocation ; « Connexions » (applications autorisées) et console (clients).

Découverte (spécification MCP « Authorization » 2025-11-25) :

* ``GET /.well-known/oauth-protected-resource[/api/mcp-bridge[/<famille>]]``
  — métadonnées de ressource protégée (RFC 9728) ;
* ``GET /.well-known/oauth-authorization-server`` — métadonnées du serveur
  d'autorisation (RFC 8414).

Serveur d'autorisation :

* ``POST /oauth/register`` — enregistrement dynamique (RFC 7591), si l'admin
  le permet ;
* ``GET /oauth/authorize`` — contrôle de la demande (client, redirection,
  PKCE S256, ``resource``, portée), connexion Elpis si besoin, puis écran de
  consentement ; ``POST /oauth/authorize`` — décision de l'utilisateur ;
* ``POST /oauth/token`` — code d'autorisation ou rafraîchissement ;
* ``POST /oauth/revoke`` — révocation (RFC 7009).

La demande en attente de consentement n'est gardée nulle part : elle voyage
dans le formulaire, signée (HMAC, clé dérivée du secret de session, 15 min,
liée au compte connecté) — l'app tourne sur plusieurs workers.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import html
import json
import logging
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, quote, urlencode, urlsplit

from fastapi import HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response

from shared_infra.mcp import oauth as O
from shared_infra.routes._state import router

logger = logging.getLogger(__name__)

_CONSENT_AUD = "elpis-oauth-consent"
_CONSENT_TTL_S = 900.0
_BODY_MAX = 64 * 1024
_CORS = {"Access-Control-Allow-Origin": "*",
         "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
         "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version"}
_NO_STORE = {"Cache-Control": "no-store", "Pragma": "no-cache"}
_FAMILY_LABELS = {
    "fs": "Fichiers de votre sandbox (lecture et écriture)",
    "shell": "Terminal de votre sandbox (commandes)",
    "git": "Git dans votre sandbox",
    "desktop": "Contrôle d'écran des machines autorisées",
    "browser": "Navigateur piloté",
    "skill_run": "Scripts de vos skills",
}
# Jamais cochées d'office : elles agissent hors de la sandbox ou sur le web.
_NOT_PRECHECKED = frozenset({"desktop", "browser"})


# ── Outils ───────────────────────────────────────────────────────────────────
def app_url(request: Request) -> str:
    """Origine publique de l'app (frontal https compris), comme les URL MCP
    publiées dans « Connexions »."""
    try:
        from shared_infra.opencode.routes_cli import _app_url
        return _app_url(request).rstrip("/")
    except Exception:                                            # noqa: BLE001
        return str(request.base_url).rstrip("/")


def resource_metadata_url(request: Request, family: str = "") -> str:
    suffix = O.RESOURCE_PATH + (f"/{family}" if family else "")
    return f"{app_url(request)}/.well-known/oauth-protected-resource{suffix}"


def www_authenticate(request: Request, family: str = "", *, error: str = "") -> str:
    """``WWW-Authenticate`` du relais : où découvrir l'autorisation (RFC 9728)
    et quelle portée demander. Sans OAuth actif : ``Bearer`` nu."""
    try:
        if not O.policy()["enabled"]:
            return "Bearer"
    except Exception:                                            # noqa: BLE001
        return "Bearer"
    if not family.isalnum():
        family = ""                  # segment fabriqué : jamais recopié dans l'en-tête
    parts = []
    if error:
        parts.append(f'error="{error}"')
    parts.append(f'resource_metadata="{resource_metadata_url(request, family)}"')
    if family:
        parts.append(f'scope="{O.SCOPE_PREFIX}{family}"')
    return "Bearer " + ", ".join(parts)


def _json(body: Dict[str, Any], status: int = 200, extra: Optional[Dict[str, str]] = None) -> JSONResponse:
    headers = dict(_CORS)
    headers.update(_NO_STORE)
    if extra:
        headers.update(extra)
    return JSONResponse(body, status_code=status, headers=headers)


def _oauth_error(e: O.OAuthError) -> JSONResponse:
    extra = {"WWW-Authenticate": "Basic"} if e.status == 401 else None
    return _json(e.body(), e.status, extra)


def _require_enabled() -> Dict[str, Any]:
    pol = O.policy()
    if not pol["enabled"]:
        raise HTTPException(404, "Autorisation OAuth désactivée.")
    return pol


async def _form(request: Request) -> Dict[str, str]:
    """Corps ``application/x-www-form-urlencoded`` borné (premières valeurs)."""
    raw = await _body(request)
    try:
        parsed = parse_qs(raw.decode("utf-8"), keep_blank_values=True, max_num_fields=50)
    except (UnicodeDecodeError, ValueError):
        raise HTTPException(400, "Formulaire illisible.")
    return {k: v[0] for k, v in parsed.items() if v}


async def _body(request: Request) -> bytes:
    chunks, total = [], 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > _BODY_MAX:
            raise HTTPException(413, "Corps trop volumineux.")
        chunks.append(chunk)
    return b"".join(chunks)


def _consent_key() -> str:
    from shared_infra.config import SESSION_SECRET
    return hashlib.sha256(f"{_CONSENT_AUD}:{SESSION_SECRET}".encode("utf-8")).hexdigest()


def _session_user_id(request: Request) -> Optional[int]:
    """Compte connecté (session Elpis, SSO et 2FA compris), sinon ``None``."""
    from shared_infra.security.deps import require_user_id
    try:
        return int(require_user_id(request))
    except HTTPException:
        return None


def _with_params(uri: str, params: Dict[str, str]) -> str:
    return uri + ("&" if urlsplit(uri).query else "?") + urlencode(params)


# ── Découverte ───────────────────────────────────────────────────────────────
def _prm(request: Request) -> JSONResponse:
    pol = _require_enabled()
    base = app_url(request)
    return _json({
        "resource": O.resource_base(base),
        "authorization_servers": [base],
        "scopes_supported": O.scopes_supported(pol),
        "bearer_methods_supported": ["header"],
        "resource_name": "Elpis — outils MCP",
    })


@router.get("/.well-known/oauth-protected-resource")
async def oauth_prm_root(request: Request):
    return _prm(request)


@router.get("/.well-known/oauth-protected-resource" + O.RESOURCE_PATH)
async def oauth_prm_bridge(request: Request):
    return _prm(request)


@router.get("/.well-known/oauth-protected-resource" + O.RESOURCE_PATH + "/{family}")
async def oauth_prm_family(request: Request, family: str):
    return _prm(request)


@router.get("/.well-known/oauth-authorization-server")
async def oauth_as_metadata(request: Request):
    pol = _require_enabled()
    base = app_url(request)
    meta: Dict[str, Any] = {
        "issuer": base,
        "authorization_endpoint": f"{base}/oauth/authorize",
        "token_endpoint": f"{base}/oauth/token",
        "revocation_endpoint": f"{base}/oauth/revoke",
        "scopes_supported": O.scopes_supported(pol),
        "response_types_supported": ["code"],
        "response_modes_supported": ["query"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "token_endpoint_auth_methods_supported": ["none", "client_secret_basic", "client_secret_post"],
        "revocation_endpoint_auth_methods_supported": ["none", "client_secret_basic", "client_secret_post"],
        "code_challenge_methods_supported": ["S256"],
        "client_id_metadata_document_supported": True,
        "authorization_response_iss_parameter_supported": True,
    }
    if pol["dcr_enabled"]:
        meta["registration_endpoint"] = f"{base}/oauth/register"
    return _json(meta)


@router.options("/.well-known/oauth-protected-resource")
@router.options("/.well-known/oauth-authorization-server")
@router.options("/oauth/register")
@router.options("/oauth/token")
@router.options("/oauth/revoke")
async def oauth_preflight():
    return Response(status_code=204, headers=_CORS)


# ── Enregistrement (RFC 7591) ────────────────────────────────────────────────
@router.post("/oauth/register")
async def oauth_register(request: Request):
    pol = _require_enabled()
    if not pol["dcr_enabled"]:
        return _json({"error": "access_denied",
                      "error_description": "Enregistrement dynamique désactivé par l'administrateur."}, 403)
    try:
        meta = json.loads(await _body(request) or b"{}")
    except ValueError:
        return _json({"error": "invalid_client_metadata", "error_description": "JSON invalide."}, 400)
    try:
        out = await asyncio.to_thread(O.register_client, meta)
    except O.OAuthError as e:
        return _oauth_error(e)
    return _json(out, 201)


# ── Autorisation ─────────────────────────────────────────────────────────────
_PAGE_CSS = """
:root{--bg:#f8fafc;--card:#fff;--fg:#0f172a;--muted:#64748b;--line:#e2e8f0;--accent:#2563eb;--accent-fg:#fff;--warn:#b45309}
@media (prefers-color-scheme:dark){:root{--bg:#0b1120;--card:#111827;--fg:#e2e8f0;--muted:#94a3b8;--line:#1f2937;--accent:#3b82f6;--accent-fg:#fff;--warn:#fbbf24}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;max-width:460px;width:100%;padding:24px}
h1{font-size:16px;margin:0 0 4px}p{margin:0 0 12px}.muted{color:var(--muted);font-size:12px}
.warn{color:var(--warn);font-size:12px}code{font-size:12px;word-break:break-all}
fieldset{border:1px solid var(--line);border-radius:10px;margin:12px 0;padding:8px 12px}
legend{font-size:12px;color:var(--muted);padding:0 4px}label{display:flex;gap:8px;align-items:flex-start;padding:4px 0}
.row{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
button{font:inherit;border-radius:8px;padding:8px 14px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
"""
_PAGE_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    **_NO_STORE,
}


def _page(title: str, body: str, status: int = 200) -> HTMLResponse:
    doc = ("<!doctype html><html lang=\"fr\"><head><meta charset=\"utf-8\">"
           "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
           f"<title>{html.escape(title)}</title><style>{_PAGE_CSS}</style></head>"
           f"<body><main class=\"card\">{body}</main></body></html>")
    return HTMLResponse(doc, status_code=status, headers=_PAGE_HEADERS)


def _error_page(message: str, status: int = 400) -> HTMLResponse:
    return _page("Autorisation impossible",
                 "<h1>Autorisation impossible</h1>"
                 f"<p>{html.escape(message)}</p>"
                 "<p class=\"muted\">Fermez cette page et relancez la connexion depuis l'application.</p>",
                 status)


def _redirect_error(redirect_uri: str, state: str, error: str, description: str,
                    request: Request) -> RedirectResponse:
    params = {"error": error, "error_description": description, "iss": app_url(request)}
    if state:
        params["state"] = state
    return RedirectResponse(_with_params(redirect_uri, params), status_code=302)


def _validate_authorize(request: Request, q: Dict[str, str], pol: Dict[str, Any]):
    """Demande d'autorisation → ``(client, redirect_uri, state, challenge,
    resource, familles)``. Tant que la redirection n'est pas sûre, une erreur
    s'affiche ici (jamais de redirection vers une adresse non vérifiée) ;
    ensuite, elle repart vers le client."""
    try:
        client = O.resolve_client(q.get("client_id", ""))
    except O.OAuthError as e:
        return _error_page(e.description or "Client inconnu.")
    ruri = q.get("redirect_uri", "")
    if not ruri and len(client["redirect_uris"]) == 1:
        ruri = client["redirect_uris"][0]
    if not ruri or not O.redirect_matches(ruri, client["redirect_uris"]):
        return _error_page("Adresse de retour non enregistrée pour ce client.")
    state = q.get("state", "")
    if q.get("response_type") != "code":
        return _redirect_error(ruri, state, "unsupported_response_type", "response_type=code attendu.", request)
    challenge = q.get("code_challenge", "")
    if not challenge or q.get("code_challenge_method") != "S256" or not 43 <= len(challenge) <= 128:
        return _redirect_error(ruri, state, "invalid_request", "PKCE S256 obligatoire.", request)
    try:
        resource, fam = O.check_resource(q.get("resource", ""), app_url(request), pol)
    except O.OAuthError as e:
        return _redirect_error(ruri, state, e.error, e.description, request)
    families = O.families_from_scope(q.get("scope"), pol)
    if fam is not None:
        families = [f for f in families if f == fam]
    if not families:
        return _redirect_error(ruri, state, "invalid_scope", "Aucune famille d'outils permise.", request)
    return client, ruri, state, challenge, resource, families


@router.get("/oauth/authorize")
async def oauth_authorize(request: Request):
    pol = _require_enabled()
    q = {k: v for k, v in request.query_params.items()}
    checked = await asyncio.to_thread(_validate_authorize, request, q, pol)
    if isinstance(checked, Response):
        return checked
    client, ruri, state, challenge, resource, families = checked
    uid = _session_user_id(request)
    if uid is None:
        # Connexion Elpis d'abord (SSO / 2FA compris), puis retour ici.
        nxt = request.url.path + ("?" + request.url.query if request.url.query else "")
        return RedirectResponse("/?oauth_next=" + quote(nxt, safe=""), status_code=302)
    from shared_infra.accounts import identity as _ident
    req = _ident.sign_claims({"uid": uid, "cid": client["client_id"], "ruri": ruri, "st": state,
                              "cc": challenge, "res": resource, "fams": families},
                             _consent_key(), aud=_CONSENT_AUD)
    try:
        from shared_infra.accounts.users import get_user_by_id
        u = get_user_by_id(uid)
        who = str(u["username"] or "") if u else ""
    except Exception:                                             # noqa: BLE001
        who = ""
    host = urlsplit(ruri).netloc
    rows = "".join(
        f"<label><input type=\"checkbox\" name=\"fam\" value=\"{html.escape(f)}\""
        f"{'' if f in _NOT_PRECHECKED else ' checked'}>"
        f"<span>{html.escape(_FAMILY_LABELS.get(f, f))} <span class=\"muted\">({html.escape(f)})</span></span></label>"
        for f in families)
    declared = ("<p class=\"warn\">Nom déclaré par l'application elle-même, non vérifié.</p>"
                if client["kind"] == "dcr" else "")
    body = (
        "<h1>Autoriser l'accès à vos outils</h1>"
        f"<p><strong>{html.escape(client['name'] or client['client_id'])}</strong> demande à utiliser "
        f"vos outils Elpis{(' en tant que <strong>' + html.escape(who) + '</strong>') if who else ''}.</p>"
        f"{declared}"
        f"<p class=\"muted\">Retour vers <code>{html.escape(host)}</code></p>"
        "<form method=\"post\" action=\"/oauth/authorize\">"
        f"<input type=\"hidden\" name=\"req\" value=\"{html.escape(req)}\">"
        f"<fieldset><legend>Familles d'outils</legend>{rows}</fieldset>"
        "<p class=\"muted\">Les appels s'exécutent sous votre compte. Vous pourrez retirer cet accès dans "
        "Paramètres › Connexions.</p>"
        "<div class=\"row\"><button type=\"submit\" name=\"decision\" value=\"deny\">Refuser</button>"
        "<button class=\"primary\" type=\"submit\" name=\"decision\" value=\"allow\">Autoriser</button></div>"
        "</form>")
    return _page("Autoriser l'accès", body)


@router.post("/oauth/authorize")
async def oauth_authorize_decision(request: Request):
    pol = _require_enabled()
    raw = await _body(request)
    try:
        parsed = parse_qs(raw.decode("utf-8"), keep_blank_values=True, max_num_fields=50)
    except (UnicodeDecodeError, ValueError):
        return _error_page("Formulaire illisible.")
    from shared_infra.accounts import identity as _ident
    claims = _ident.verify_claims((parsed.get("req") or [""])[0], _consent_key(), aud=_CONSENT_AUD,
                                  max_skew_s=_CONSENT_TTL_S)
    uid = _session_user_id(request)
    if not claims or uid is None or int(claims.get("uid") or 0) != uid:
        return _error_page("Demande expirée ou session changée : relancez la connexion depuis l'application.")
    ruri, state = str(claims["ruri"]), str(claims.get("st") or "")
    if (parsed.get("decision") or [""])[0] != "allow":
        return _redirect_error(ruri, state, "access_denied", "Accès refusé par l'utilisateur.", request)
    requested = [str(f) for f in claims.get("fams") or []]
    chosen = set(parsed.get("fam") or [])
    families = [f for f in requested if f in chosen and f in pol["families"]]
    if not families:
        return _redirect_error(ruri, state, "access_denied", "Aucune famille autorisée.", request)
    code = await asyncio.to_thread(
        O.issue_code, client_id=str(claims["cid"]), user_id=uid, redirect_uri=ruri,
        code_challenge=str(claims["cc"]), resource=str(claims["res"]), families=families)
    params = {"code": code, "iss": app_url(request)}
    if state:
        params["state"] = state
    return RedirectResponse(_with_params(ruri, params), status_code=302)


# ── Jetons ───────────────────────────────────────────────────────────────────
def _client_credentials(request: Request, form: Dict[str, str]) -> tuple:
    """``(client_id, secret)`` : en-tête Basic (RFC 6749 § 2.3.1) ou corps."""
    auth = request.headers.get("authorization") or ""
    if auth.lower().startswith("basic "):
        try:
            raw = base64.b64decode(auth[6:].strip()).decode("utf-8")
            cid, _, secret = raw.partition(":")
            from urllib.parse import unquote
            return unquote(cid), unquote(secret)
        except (ValueError, UnicodeDecodeError):
            raise O.OAuthError("invalid_client", "En-tête Basic illisible.", status=401)
    return form.get("client_id", ""), form.get("client_secret") or None


@router.post("/oauth/token")
async def oauth_token(request: Request):
    _require_enabled()
    form = await _form(request)
    try:
        cid, secret = _client_credentials(request, form)
        client = await asyncio.to_thread(O.authenticate_client, cid, secret)
        grant = form.get("grant_type", "")
        if grant == "authorization_code":
            out = await asyncio.to_thread(
                O.exchange_code, code=form.get("code", ""), client=client,
                redirect_uri=form.get("redirect_uri", ""), code_verifier=form.get("code_verifier", ""),
                resource=form.get("resource") or None, app_url=app_url(request))
        elif grant == "refresh_token":
            out = await asyncio.to_thread(
                O.refresh, refresh_token=form.get("refresh_token", ""), client=client,
                scope=form.get("scope") or None, resource=form.get("resource") or None,
                app_url=app_url(request))
        else:
            raise O.OAuthError("unsupported_grant_type", "authorization_code ou refresh_token.")
    except O.OAuthError as e:
        return _oauth_error(e)
    return _json(out)


@router.post("/oauth/revoke")
async def oauth_revoke(request: Request):
    _require_enabled()
    form = await _form(request)
    try:
        cid, secret = _client_credentials(request, form)
        if cid:
            await asyncio.to_thread(O.authenticate_client, cid, secret)
    except O.OAuthError as e:
        return _oauth_error(e)
    await asyncio.to_thread(O.revoke_token, form.get("token", ""), cid or None)
    return _json({})


# ── « Connexions » : applications autorisées par le compte ───────────────────
@router.get("/api/oauth/grants")
async def api_oauth_grants(request: Request):
    from shared_infra.security.deps import require_user_id
    uid = int(require_user_id(request))
    items = await asyncio.to_thread(O.list_grants, uid)
    return JSONResponse({"items": items, "enabled": O.policy()["enabled"]},
                        headers={"Cache-Control": "no-store"})


@router.delete("/api/oauth/grants/{grant_id}")
async def api_oauth_grant_revoke(request: Request, grant_id: str):
    from shared_infra.security.deps import require_user_id
    uid = int(require_user_id(request))
    if not await asyncio.to_thread(O.revoke_grant, uid, grant_id):
        raise HTTPException(404, "Autorisation introuvable.")
    return {"ok": True}


__all__ = ["app_url", "resource_metadata_url", "www_authenticate"]
