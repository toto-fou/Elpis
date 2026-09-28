# SPDX-License-Identifier: MIT
"""
shared_infra.git.routes — API CRUD des Connecteurs Git (par-user).

Tous les endpoints sont OWNER-SCOPED (``require_user_id``). Le token est
**write-only** : jamais renvoyé par GET/list. Le test de connexion s'exécute
host-side (validateur SSRF unifié) et ne renvoie que ``{ok, login?, error?}``.

Endpoints :
  GET    /api/git/connectors            → liste (sans token)
  POST   /api/git/connectors            → création (token dans le body)
  PUT    /api/git/connectors/{cid}      → mise à jour (token optionnel = inchangé)
  DELETE /api/git/connectors/{cid}      → suppression
  POST   /api/git/connectors/{cid}/test → test de connexion (GET authentifié léger)
"""
from __future__ import annotations

from fastapi import HTTPException, Request

from shared_infra.security.audit import audit_event
from shared_infra.git import connectors as _gc
from shared_infra.security.deps import require_user_id
from shared_infra.routes._state import router

_MAX = 200  # garde-fou de longueur sur les champs texte


def _clean(s, n=_MAX) -> str:
    return ("" if s is None else str(s)).strip()[:n]


@router.get("/api/git/connectors")
def api_list_git_connectors(request: Request):
    uid = require_user_id(request)
    return {"connectors": _gc.list_connectors(uid),
            "provider_types": list(_gc.PROVIDER_TYPES)}


@router.post("/api/git/connectors/parse")
async def api_parse_git_repo_url(request: Request):
    """Aide-saisie : à partir de l'URL du dépôt collée, renvoie host /
    provider détecté / api_base suggéré (schéma-aware : http pour un Gitea local
    en HTTP). Le form pré-remplit les champs avec ça."""
    require_user_id(request)
    data = await request.json()
    url = _clean(data.get("url"), 500)
    if not url:
        return {"ok": False}
    from urllib.parse import urlsplit
    from shared_infra.git.detect import detect_provider, normalize_host, default_provider_type
    from shared_infra.git.providers import get_provider
    info = detect_provider(url)
    host = (info.get("host") or normalize_host(url) or "").lower()
    if not host:
        return {"ok": False}
    scheme = "https"
    try:
        s = (urlsplit(url).scheme or "").lower()
        if s in ("http", "https"):
            scheme = s
    except Exception:
        pass
    detected = default_provider_type(info.get("provider", ""))
    # api_base calculé pour le type courant du form (sinon le type détecté).
    ptype = _clean(data.get("provider_type")) or detected
    api_base = get_provider(ptype).api_base(host, "")
    # self-hosted en HTTP → bascule le schéma de l'api_base (cloud reste https).
    if scheme == "http" and api_base and (f"://{host}" in api_base):
        api_base = api_base.replace("https://", "http://", 1)
    return {"ok": True, "host": host, "detected_provider_type": detected,
            "api_base": api_base, "scheme": scheme}


@router.post("/api/git/connectors")
async def api_create_git_connector(request: Request):
    uid = require_user_id(request)
    data = await request.json()
    from shared_infra.git.detect import normalize_host
    provider_type = _clean(data.get("provider_type"))
    # Tolérant : si l'utilisateur colle l'URL complète du repo (avec creds), on
    # n'en garde que le host[:port] (le reste casserait le matching par host).
    host = normalize_host(_clean(data.get("host"), 400))
    token = (data.get("token") or "").strip()
    if provider_type not in _gc.PROVIDER_TYPES:
        raise HTTPException(400, f"provider_type invalide (un de {list(_gc.PROVIDER_TYPES)})")
    if not host:
        raise HTTPException(400, "host requis (ex. github.com, gitlab.acme.internal)")
    if not token:
        raise HTTPException(400, "token requis")
    cid = _gc.create_connector(
        uid, provider_type, host, token=token,
        api_base=_clean(data.get("api_base"), 400),
        label=_clean(data.get("label")), username=_clean(data.get("username")))
    audit_event(user_id=uid, username=getattr(request.state, "username", None),
                action="git.connector.create",
                details={"connector_id": cid, "provider_type": provider_type, "host": host})
    return {"ok": True, "id": cid}


@router.put("/api/git/connectors/{cid}")
async def api_update_git_connector(request: Request, cid: int):
    uid = require_user_id(request)
    data = await request.json()
    from shared_infra.git.detect import normalize_host
    fields = {}
    for k in ("provider_type", "host", "api_base", "label", "username"):
        if k in data:
            fields[k] = _clean(data.get(k), 400 if k == "api_base" else _MAX)
            if k == "host":
                fields[k] = normalize_host(fields[k])
    if fields.get("provider_type") and fields["provider_type"] not in _gc.PROVIDER_TYPES:
        raise HTTPException(400, "provider_type invalide")
    if "token" in data and (data.get("token") or "").strip():
        fields["token"] = data["token"].strip()       # non-vide = remplace
    if not _gc.update_connector(uid, cid, **fields):
        raise HTTPException(404, "Connecteur introuvable ou rien à modifier")
    audit_event(user_id=uid, username=getattr(request.state, "username", None),
                action="git.connector.update", details={"connector_id": cid})
    return {"ok": True}


@router.delete("/api/git/connectors/{cid}")
def api_delete_git_connector(request: Request, cid: int):
    uid = require_user_id(request)
    if not _gc.delete_connector(uid, cid):
        raise HTTPException(404, "Connecteur introuvable")
    audit_event(user_id=uid, username=getattr(request.state, "username", None),
                action="git.connector.delete", details={"connector_id": cid})
    return {"ok": True}


@router.get("/api/git/connectors/{cid}/repos")
def api_list_connector_repos(request: Request, cid: int):
    """Liste les dépôts accessibles via ce connecteur (pour le clone 1-clic dans
    l'éditeur). Lecture seule, owner-scoped. Le token ne quitte JAMAIS le serveur :
    résolution host-side + validateur SSRF unifié (même règle que ``/test`` —
    seul le host ENREGISTRÉ est allowlisté, ce qui autorise le self-hosted en HTTP
    sans ouvrir la porte à un api_base malveillant)."""
    uid = require_user_id(request)
    row = _gc.get_connector_secret(uid, cid)
    if not row:
        raise HTTPException(404, "Connecteur introuvable")
    from shared_infra.git.providers import get_provider
    from shared_infra.git.ssrf import block_remote_url_reason
    from shared_infra.git._http import http_json

    prov = get_provider(row["provider_type"])
    api_base = prov.api_base(row["host"], row.get("api_base") or "")
    if not api_base:
        return {"ok": False, "error": "no_api", "repos": []}
    reason = block_remote_url_reason(api_base, allow_schemes=("https",),
                                     allow_hosts={row["host"]})
    if reason:
        return {"ok": False, "error": f"blocked: {reason}", "repos": []}
    # SSRF sur les redirections : le client HTTP RE-VALIDE chaque saut avec la
    # MÊME politique (host enregistré seul allowlisté) — cf. _http.http_json.
    import functools as _ft
    _http = _ft.partial(http_json, ssrf_allow_hosts={row["host"]},
                        ssrf_allow_schemes=("https",))
    res = prov.list_repos(_http, api_base=api_base, token=row["token"],
                          username=row.get("username", ""),
                          query=_clean(request.query_params.get("q"), 200))
    res = dict(res)
    res.setdefault("host", row["host"])
    res.setdefault("repos", [])
    audit_event(user_id=uid, username=getattr(request.state, "username", None),
                action="git.connector.list_repos",
                details={"connector_id": cid, "ok": bool(res.get("ok")),
                         "count": len(res.get("repos") or [])})
    return res


@router.post("/api/git/connectors/{cid}/test")
def api_test_git_connector(request: Request, cid: int):
    uid = require_user_id(request)
    row = _gc.get_connector_secret(uid, cid)
    if not row:
        raise HTTPException(404, "Connecteur introuvable")
    from shared_infra.git.providers import get_provider
    from shared_infra.git.ssrf import block_remote_url_reason
    from shared_infra.git._http import http_json

    prov = get_provider(row["provider_type"])
    api_base = prov.api_base(row["host"], row.get("api_base") or "")
    if not api_base:
        return {"ok": False, "error": "no_api"}
    # SSRF host-side : on N'autorise QUE le host ENREGISTRÉ (self-hosted opt-in).
    # On ne met PAS le host de l'api_base dans l'allowlist — sinon un api_base
    # malveillant (169.254.169.254…) contournerait le filtre. Pour les clouds,
    # l'api_base (api.github.com…) est public et passe le check IP normalement.
    reason = block_remote_url_reason(api_base, allow_schemes=("https",),
                                     allow_hosts={row["host"]})
    if reason:
        return {"ok": False, "error": f"blocked: {reason}"}
    import functools as _ft
    _http = _ft.partial(http_json, ssrf_allow_hosts={row["host"]},
                        ssrf_allow_schemes=("https",))
    res = prov.test_connection(_http, api_base=api_base, token=row["token"],
                               username=row.get("username", ""))
    # Diagnostic : on expose le host/api_base réellement utilisés + un indice
    # actionnable (les causes de 401 les plus fréquentes en self-hosted).
    res = dict(res)
    res.setdefault("host", row["host"])
    res.setdefault("api_base", api_base)
    if not res.get("ok"):
        st = res.get("status")
        if st in (401, 403):
            res["hint"] = ("401/403 : identifiants refusés par l'API. Pour GitLab/"
                           "GitHub un Personal Access Token est OBLIGATOIRE (le mot "
                           "de passe ne marche pas pour l'API). Pour Gitea, vérifie "
                           "le login/mot de passe, ou utilise un token si 2FA.")
        elif st in (0, None):
            res["hint"] = (f"Pas de réponse de {api_base} : host/scheme/port erronés "
                           f"(Gitea en HTTP ? api_base doit être http://host:port/api/v1) "
                           f"ou service injoignable depuis l'app.")
        elif st == 404:
            res["hint"] = "404 : api_base probablement faux (vérifie le chemin /api/v1, /api/v4…)."
    audit_event(user_id=uid, username=getattr(request.state, "username", None),
                action="git.connector.test",
                details={"connector_id": cid, "ok": bool(res.get("ok")), "status": res.get("status")})
    return res
