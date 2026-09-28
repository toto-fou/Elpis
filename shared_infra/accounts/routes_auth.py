# SPDX-License-Identifier: MIT
"""
backend.routes.auth — Authentication endpoints.

Endpoints
---------
- GET  /api/me-lite      — session introspection (who am I?)
- POST /api/login-lite   — credentials → session cookie
- POST /api/logout-lite  — clears session + deletes the cookie

Login rate-limiting (REMOVED)
-----------------------------
Per-IP × per-username brute-force protection used to live here. It was
removed because Elpis runs in trusted local-team deployments where the
extra friction (5 fat-fingered passwords → 15 min lockout) hurts more
than it helps. The expected threat model is "a teammate mistypes their
password", not "an unauthenticated attacker probing credentials" — for
the latter, a network ACL or a reverse-proxy-level limit is more
appropriate.

If you redeploy this in an environment where brute-force protection
matters, restore the logic by reverting this commit (it had a
``_login_attempts`` dict + ``_rl_check``/``_rl_fail``/``_rl_reset``
helpers with config-driven policy under ``security.login.*``).
"""
from __future__ import annotations

import asyncio
import secrets
import time
import threading as _threading

from fastapi import HTTPException, Request, Response
from fastapi.responses import JSONResponse

from shared_infra.db import (
    log_metric,
)
from shared_infra.accounts.users import (
    create_user,
    get_all_users,
    get_user_by_id,
    revoke_session_sid,
    verify_user,
)
from shared_infra.security.audit import audit_login
from shared_infra.observability.access_logging import _resolve_client_ip
from shared_infra.accounts.passwd import run_password_op
from shared_infra.routes._state import router

import logging
logger = logging.getLogger("uvicorn.error")


# ─────────────────────────────────────────────────────────────────────────────
#  ENDPOINTS
# ─────────────────────────────────────────────────────────────────────────────
@router.get("/api/me-lite")
def api_me_lite(request: Request):
    uid = request.session.get("user_id")
    if not uid: return JSONResponse({"logged_in": False}, headers={"Cache-Control": "no-cache"})

    # Run the same revocation/expiry gates require_user_id uses. Without
    # this, a revoked session would still show as "logged_in: true" until
    # the user happened to hit a protected endpoint.
    #
    # AUDIT 2026-08-02 (S-mineur) — l'ancien commentaire affirmait que « le
    # front fait un poll /api/me-lite à chaque focus » : FAUX, checkAuth()
    # n'est appelé qu'au mount, après login et après changement de mot de
    # passe forcé. La détection en continu repose en réalité sur l'event SSE
    # ``session_expired`` (revalidation périodique des flux, cf. events.py)
    # et sur le traitement du 401 par fetchAuth.
    try:
        from shared_infra.security.deps import _session_validity_checks
        if not _session_validity_checks(request, int(uid)):
            return JSONResponse({"logged_in": False}, headers={"Cache-Control": "no-cache"})
    except Exception:
        # Defensive: if the checks blow up for any reason, treat the
        # session as invalid rather than leaking access.
        return JSONResponse({"logged_in": False}, headers={"Cache-Control": "no-cache"})

    row = get_user_by_id(int(uid))
    if not row: return JSONResponse({"logged_in": False}, headers={"Cache-Control": "no-cache"})
    # Si must_change_pwd est actif, ne pas considérer comme connecté
    try:
        must_change = bool(row["must_change_pwd"])
    except Exception:
        must_change = False
    if must_change:
        return JSONResponse({"logged_in": False, "must_change_password": True, "id": row["id"], "username": row["username"]}, headers={"Cache-Control": "no-cache"})
    return JSONResponse({"logged_in": True, "id": row["id"], "username": row["username"], "is_admin": bool(row["is_admin"]), "role": {0: "user", 1: "admin", 2: "moderator"}.get(row["is_admin"], "user"), "avatar": row["avatar"]}, headers={"Cache-Control": "no-cache"})


# ── Premier admin (audit 2026-09-22, H3) ────────────────────────────────────
# Instance vierge : un login « admin » avec N'IMPORTE QUEL mot de passe créait
# l'admin — course gagnée par le premier venu du LAN. Désormais le mot de
# passe choisi n'est accepté que depuis la machine elle-même (sans proxy) ;
# ailleurs, il faut le mot de passe initial écrit dans
# ``user_db/.bootstrap_admin`` (0600, créé au premier besoin, chemin dans les
# journaux), à changer à la première connexion.
def _bootstrap_file():
    from shared_infra.config import PROJECT_ROOT
    return PROJECT_ROOT / "user_db" / ".bootstrap_admin"


def _bootstrap_secret() -> str:
    import logging
    import os
    f = _bootstrap_file()
    try:
        return f.read_text(encoding="utf-8").strip()
    except OSError:
        pass
    tok = secrets.token_urlsafe(18)
    try:
        f.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(str(f), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(tok + "\n")
        logging.getLogger("uvicorn.error").warning(
            "[bootstrap] Instance sans compte : premier login « admin » avec le mot de "
            "passe initial de %s (ou n'importe quel mot de passe depuis la machine "
            "elle-même).", f)
    except FileExistsError:
        return f.read_text(encoding="utf-8").strip()
    except OSError:
        return ""
    return tok


def _bootstrap_mode(request: Request, password: str):
    """``"local"``, ``"file"`` ou ``None`` (création refusée)."""
    from shared_infra.security.local_request import is_direct_local
    if is_direct_local(request):
        return "local"
    expected = _bootstrap_secret()
    if expected and secrets.compare_digest(password.encode("utf-8"), expected.encode("utf-8")):
        return "file"
    return None


@router.get("/api/auth/check")
def api_auth_check(request: Request):
    """Sonde d'authentification pour le reverse-proxy (nginx ``auth_request``).

    Renvoie ``204`` si la session courante est valide, ``401`` sinon. Sert à
    protéger n'importe quel service proxifié derrière la session de l'app :
    le proxy interroge cet endpoint avant de relayer la requête et n'expose
    le service qu'aux utilisateurs déjà connectés. (Historiquement introduit
    pour le plugin Flowise, retiré depuis ; conservé car générique.)

    Contrairement à ``/api/me-lite`` (toujours 200 + corps JSON), ce endpoint
    encode l'état d'auth dans le STATUT HTTP, ce que ``auth_request`` exige.

    ``require_user_id`` peut lever 401 (non connecté) OU 403 (ex. compte en
    must_change_pwd, chemin non whitelisté). Pour le proxy, les deux signifient
    « pas d'accès » → on normalise tout en 401, le seul code que la directive
    ``error_page`` du proxy a besoin de mapper vers la page de login.
    """
    from fastapi import HTTPException
    from shared_infra.security.deps import require_user_id
    try:
        require_user_id(request)
    except HTTPException as e:
        if e.status_code in (401, 403):
            raise HTTPException(status_code=401, detail="not authenticated")
        raise
    return Response(status_code=204)


# BUG FIX C2 — verrou pour le bootstrap admin.
# Avant, l'init "premier user = admin" faisait :
#     users = get_all_users()
#     if len(users) == 0 and username.lower() == "admin":
#         uid = create_user(...)
# Pas atomique. Deux requêtes parallèles "POST /api/login-lite" sur une
# instance vierge avec même login admin peuvent toutes deux voir
# len(users)==0 et toutes deux appeler create_user → deux comptes admin
# créés (le 2e échoue probablement sur la contrainte UNIQUE username
# dans verify_user/create_user, mais le comportement n'est pas garanti
# selon l'implémentation interne).
#
# Race d'init très rare en pratique (premier user = installateur, peu
# de chance qu'il fasse 2 requêtes parallèles), mais trivial à corriger
# avec un verrou process-wide. On utilise threading.Lock — FastAPI
# envoie chaque requête vers le thread pool, le lock sérialise les
# concurrentes.
_bootstrap_admin_lock = _threading.Lock()


@router.post("/api/login-lite")
async def api_login_lite(request: Request):
    data = await request.json()
    # AUDIT 2026-08-02 (M7) — le handler global n'intercepte que
    # ``JSONDecodeError``. Un corps SYNTAXIQUEMENT valide mais non-objet
    # (``[]``, ``"x"``, ``5``) passe le décodage puis casse sur ``.get()`` →
    # AttributeError → 500 sur une route mutante NON authentifiée. Garde
    # explicite → 400 propre (modèle : settings.py ``isinstance(raw, dict)``).
    if not isinstance(data, dict):
        raise HTTPException(400, "Corps JSON invalide : objet attendu")
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""

    if not username or not password: raise HTTPException(400, "username/password required")

    # Contexte client pour l'audit (IP réelle via proxies de confiance,
    # user-agent). Best-effort : ne doit jamais faire échouer le login.
    try:
        _ip = _resolve_client_ip(request)
    except Exception:
        _ip = None
    try:
        _ua = request.headers.get("user-agent")
    except Exception:
        _ua = None

    # Rate-limit check — REMOVED. See module docstring for rationale
    # (delegated to network ACL / reverse-proxy in trusted-team deploys).
    # Authentication failures are no longer throttled here, mais elles sont
    # désormais TOUTES auditées (trace inviolable via shared_infra.security.audit) pour
    # permettre la détection/investigation d'un credential stuffing.

    # PBKDF2 150 k itérations = 87 ms de CPU. Ce handler est ``async`` : exécuté
    # tel quel, il gèle la boucle du worker — donc TOUS les autres utilisateurs —
    # à chaque tentative de connexion, réussie ou non. Cf. shared_infra/passwd_async.
    uid = await run_password_op(verify_user, username, password)

    if uid is None:
        # Bootstrap admin path : potentiellement appelé par plusieurs
        # requêtes en même temps sur instance vierge → on sérialise.
        # Le lock est très peu contesté (unique pour le 1er user de
        # l'install, jamais utilisé après).
        with _bootstrap_admin_lock:
            # Re-vérifier sous lock : un autre thread peut avoir créé
            # le 1er user entre notre arrivée et l'acquisition du lock.
            users = get_all_users()
            _boot = (len(users) == 0 and username.lower() == "admin")
            _boot_mode = _bootstrap_mode(request, password) if _boot else None
            if _boot and _boot_mode:
                # Reste SYNCHRONE, contrairement au ``verify_user`` ci-dessus :
                # ``await`` sous un ``threading.Lock`` détenu est un interblocage
                # franc. La coroutine A rendrait la main en gardant le verrou ;
                # la coroutine B, sur la même boucle, appellerait ``acquire()``
                # qui bloque le THREAD de la boucle — A ne pourrait donc jamais
                # reprendre pour relâcher. Les 87 ms sont ici payés une seule
                # fois dans la vie de l'installation (création du tout premier
                # compte), sur une instance qui ne sert encore personne.
                # Mot de passe initial (fichier) : à changer dès la connexion.
                uid = create_user(username, password, is_admin=1,
                                  must_change_pwd=1 if _boot_mode == "file" else 0)
                _bootstrap_file().unlink(missing_ok=True)
            else:
                # Soit users ne sont plus vides (quelqu'un nous a doublé
                # → notre password ne match pas le user créé), soit
                # username != "admin" → credentials invalides.
                #
                # Distinguer le motif pour le forensique :
                #  • « bootstrap_denied » : instance ENCORE vierge (len==0) mais le
                #    compte tenté n'est pas « admin » → seul l'admin peut amorcer.
                #  • « bad_password » : instance DÉJÀ initialisée (len>0) → mauvais
                #    identifiants (y compris l'admin qui se trompe de mot de passe :
                #    c'est le cas le plus sensible au forensique, brute-force/stuffing).
                # NB : (len==0 ∧ username==admin) ne parvient jamais ici (branche de
                # création ci-dessus), donc le test porte sur username != "admin".
                _reason = (
                    "bootstrap_locked" if _boot
                    else "bootstrap_denied"
                    if (len(users) == 0 and username.lower() != "admin")
                    else "bad_password"
                )
                audit_login(
                    user_id=None,
                    username=username,
                    ip=_ip,
                    user_agent=_ua,
                    success=False,
                    reason=_reason,
                )
                raise HTTPException(401, "invalid credentials")

    user_row = get_user_by_id(uid)
    is_admin = bool(user_row["is_admin"]) if user_row else False
    try:
        must_change = bool(user_row["must_change_pwd"])
    except Exception:
        must_change = False

    # SECURITY FIX #A (session fixation) : on régénère intégralement
    # la session AVANT de l'associer au compte. Sinon, un attaquant qui
    # a réussi à fixer son cookie chez la victime (via une fuite XSS
    # partielle ou un sous-domaine compromis) verrait son cookie liée
    # au compte de la victime dès qu'elle se connecte.
    #
    # SessionMiddleware (starlette) sérialise le dict ``request.session``
    # signé/chiffré dans le cookie ; ``clear()`` vide le dict, et les
    # écritures suivantes le repeuplent — au prochain Set-Cookie le
    # client reçoit donc un nouveau cookie qui ne partage rien avec
    # l'ancien sauf le nom. ``_last_activity_ts`` est aussi nettoyé,
    # le gate d'idle timeout est recalculé au prochain request.
    request.session.clear()

    request.session["uid"] = int(uid)
    request.session["user"] = int(uid)
    request.session["user_id"] = int(uid)
    request.session["_login_ts"] = time.time()
    # AUDIT 2026-08-01 (E4) — identifiant de CETTE session, pour permettre au
    # logout de la révoquer côté serveur sans toucher aux autres appareils de
    # l'utilisateur (cf. db/users.revoke_session_sid). Régénéré à chaque login,
    # comme le reste de la session (cf. le clear() anti-fixation ci-dessus).
    request.session["_sid"] = secrets.token_urlsafe(18)
    # Historique des fichiers : une connexion ouvre une nouvelle session
    # (l'« original » d'un fichier = son état avant la 1re modification de
    # la session). Jamais bloquant.
    try:
        from shared_infra.sandbox.file_history import start_session as _fh_start
        await asyncio.to_thread(_fh_start, int(uid))
    except Exception:                                               # noqa: BLE001
        pass
    log_metric("user_login", 1, {"user": username})

    # Audit du login réussi (trace inviolable, séparée du compteur métrique).
    # audit_login ne lève jamais — inutile de l'envelopper.
    audit_login(
        user_id=int(uid),
        username=username,
        ip=_ip,
        user_agent=_ua,
        success=True,
    )

    return {"ok": True, "is_admin": is_admin, "must_change_password": must_change}


@router.post("/api/logout-lite")
def api_logout_lite(request: Request):
    # Capturer l'identité AVANT de vider la session, puis auditer le logout.
    # On reste sous le préfixe ``auth.login`` (annoncé par l'endpoint admin
    # observability) ; ``reason="logout"`` distingue l'événement d'un login.
    try:
        _uid = request.session.get("user_id")
        _uid = int(_uid) if _uid is not None else None
    except Exception:
        _uid = None
    try:
        _ip = _resolve_client_ip(request)
    except Exception:
        _ip = None
    try:
        _ua = request.headers.get("user-agent")
    except Exception:
        _ua = None

    # AUDIT 2026-08-01 (E4) — RÉVOQUER la session côté serveur AVANT de vider
    # le dict. Sans ça, `session.clear()` + `delete_cookie` n'agissent que sur
    # le navigateur qui coopère : un cookie déjà capturé restait valide jusqu'à
    # `max_age` (24 h) malgré la déconnexion. La révocation est ciblée sur ce
    # `_sid` : les autres appareils de l'utilisateur restent connectés.
    try:
        _sid = request.session.get("_sid")
        if _sid:
            revoke_session_sid(str(_sid), _uid)
    except Exception:
        logger.warning("[auth] révocation de session au logout échouée",
                       exc_info=True)

    request.session.clear()

    audit_login(
        user_id=_uid,
        username=None,
        ip=_ip,
        user_agent=_ua,
        success=True,
        reason="logout",
    )

    resp = JSONResponse({"ok": True})
    # BUG FIX (élevé) : avant, le nom et les attributs du cookie étaient
    # hardcodés ("mcpwebui_session" + path="/" sans samesite/secure). Or
    # SessionMiddleware lit ces valeurs depuis config.json:security.session.*
    # Conséquences :
    #   - Si l'admin renomme le cookie via la config, l'ancien delete_cookie
    #     sur "mcpwebui_session" ne supprimait rien côté navigateur → cookie
    #     persistant après logout.
    #   - Sur certains navigateurs (Chrome ≥ 99 strict, Safari) la suppression
    #     ne fonctionne QUE si les attributs Set-Cookie correspondent à ceux
    #     de l'original — manquait same_site / secure → suppression ignorée.
    # On lit les MÊMES valeurs que app.py utilise pour SessionMiddleware.
    # M7 — MÊME source que SessionMiddleware (server/app.py) : deux
    # dérivations parallèles pouvaient diverger et faire ignorer la
    # suppression du cookie par Chrome/Safari.
    from shared_infra.config import session_cookie_attrs
    _attrs = session_cookie_attrs()
    _cookie_name = _attrs["cookie_name"]
    _same_site = _attrs["same_site"]
    _https_only = _attrs["https_only"]
    resp.delete_cookie(
        _cookie_name,
        path="/",
        samesite=_same_site,
        secure=_https_only,
    )
    return resp
