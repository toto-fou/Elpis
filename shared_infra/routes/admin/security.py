# SPDX-License-Identifier: MIT
"""
Admin security endpoints — session revocation, mode HTTPS, écoute
(``security.listen``).

Auto-extracted from the former monolithic ``backend/routes/admin.py``.
The endpoint bodies are byte-for-byte identical to the originals.
"""
from __future__ import annotations

import logging
import os
import socket
import time
from typing import Dict

import httpx
from fastapi import HTTPException, Request

from shared_infra.config import (
    read_config_json,
    write_config_json,
)

# Helpers shared with _legacy. Single source of truth.
from shared_infra.routes._legacy import (
    _require_admin,
)

# Routers — owned by ``_state``. We import them so endpoint decorators
# below register on the SAME singleton router instances mounted by
# ``app.py`` / ``admin_app.py``.
from shared_infra.routes.admin._state import admin_router
from shared_infra.security.audit import audit_event

logger = logging.getLogger("uvicorn.error")


@admin_router.get("/api/admin/security/sessions")
def admin_security_sessions_overview(request: Request):
    """
    Return a small JSON overview for the Cookies & sessions panel:
      - current effective session settings (max_age, cookie attrs, etc.)
      - global revocation epoch (0 if never used)
      - count of users with a per-user revocation set
      - list of (user_id, username, session_min_ts) for revoked users
    """
    _require_admin(request)
    cfg = read_config_json() or {}
    sec = cfg.get("security") or {}
    sess = sec.get("session") or {}

    # Per-user revocations — a SELECT that should return at most a few rows.
    revoked_users = []
    try:
        from shared_infra.observability.usage_store import db_conn
        with db_conn() as conn:
            cur = conn.execute(
                "SELECT id, username, session_min_ts FROM users "
                "WHERE session_min_ts IS NOT NULL AND session_min_ts > 0 "
                "ORDER BY session_min_ts DESC LIMIT 200"
            )
            for row in cur.fetchall():
                revoked_users.append({
                    "user_id":        int(row[0]),
                    "username":       str(row[1]),
                    "session_min_ts": float(row[2] or 0.0),
                })
    except Exception as exc:
        # Table missing column = pre-migration DB. Surface a helpful error.
        logger.warning("admin_security_sessions_overview: %r", exc)

    return {
        "session_cfg": {
            "max_age_sec":      int(sess.get("max_age_sec",      86400)),
            "idle_timeout_sec": int(sess.get("idle_timeout_sec", 0)),
            "cookie_name":      str(sess.get("cookie_name") or "mcpwebui_session"),
            "same_site":        str(sess.get("same_site") or "lax"),
            "https_only":       bool(sess.get("https_only", False)),
            "global_min_ts":    float(sess.get("global_min_ts", 0.0)),
        },
        "revoked_user_count": len(revoked_users),
        "revoked_users":      revoked_users,
    }


@admin_router.post("/api/admin/security/sessions/revoke-all")
def admin_security_revoke_all_sessions(request: Request):
    """
    Bump security.session.global_min_ts to now in config.json. After the
    write, every session whose _login_ts is older is rejected on its
    next authenticated request.

    Side effects:
      - Logs the operator's uid (request.session.user_id) to the audit log.
      - Returns the new global_min_ts so the UI can show "Last revoked at …".

    Idempotent: calling twice in a row just bumps the epoch twice.
    """
    _require_admin(request)
    cfg = read_config_json() or {}
    cfg.setdefault("security", {})
    cfg["security"].setdefault("session", {})
    new_ts = time.time()
    cfg["security"]["session"]["global_min_ts"] = new_ts
    write_config_json(cfg)
    operator = request.session.get("user_id")
    logger.warning(
        "[security] global session revocation issued by uid=%s, new global_min_ts=%s",
        operator, new_ts,
    )
    audit_event(user_id=operator, username=getattr(request.state, "username", None),
                action="admin.security.sessions.revoke_all",
                details={"global_min_ts": new_ts})
    # AUDIT 2026-08-02 (S1) — le timestamp ne coupe que les requêtes HTTP
    # futures : les flux DÉJÀ ouverts (SSE, shell WebSocket) restaient
    # vivants sans limite. On publie l'event sur le bus fichier : chaque
    # worker ferme ses flux et tue ses PTY (cf. apply_session_revocation).
    _publish_session_revoked(uid=None)
    return {"ok": True, "global_min_ts": new_ts}


def _publish_session_revoked(uid) -> None:
    """Diffuse la révocation à tous les workers (best-effort)."""
    try:
        from shared_infra.observability.metrics.broadcast import publish_event
        publish_event({"type": "session_revoked", "uid": uid, "ts": time.time()})
    except Exception:
        logger.exception("[security] publication session_revoked échouée")


@admin_router.post("/api/admin/security/sessions/revoke-user/{user_id}")
def admin_security_revoke_user_sessions(user_id: int, request: Request):
    """
    Force-logout a single user by writing time.time() into
    users.session_min_ts. The next time _session_uid_any runs for a
    cookie tied to this uid, the check kicks them out.
    """
    _require_admin(request)
    operator = request.session.get("user_id")
    new_ts = time.time()
    try:
        from shared_infra.accounts.users import bump_session_min_ts, get_user_by_id
        u = get_user_by_id(user_id)
        if not u:
            raise HTTPException(404, "Utilisateur introuvable")
        # bump_session_min_ts COMMIT (db_conn() ne commit pas implicitement —
        # l'ancien UPDATE inline via db_conn() était annulé au close() de la
        # connexion → révocation silencieusement sans effet, faux ok:true).
        bump_session_min_ts(user_id, new_ts)
        logger.warning(
            "[security] per-user session revocation: uid=%s revoked by uid=%s",
            user_id, operator,
        )
        audit_event(user_id=operator, username=getattr(request.state, "username", None),
                    action="admin.security.sessions.revoke_user",
                    details={"target_user_id": int(user_id), "session_min_ts": new_ts})
        # AUDIT 2026-08-02 (S1) — coupe aussi les flux SSE/WS déjà ouverts
        # de cet utilisateur, sur tous les workers.
        _publish_session_revoked(uid=int(user_id))
        # AUDIT 2026-08-02 (E2) — ``get_user_by_id`` renvoie un ``sqlite3.Row``
        # qui n'a PAS de ``.get()`` (cf. routes/ax.py). L'ancien ``u.get(...)``
        # levait ``AttributeError`` → le ``except Exception`` plus bas renvoyait
        # 500 « Échec de la révocation » ALORS QUE bump_session_min_ts ET
        # _publish_session_revoked avaient déjà réussi. Indexation ``Row``.
        return {"ok": True, "user_id": user_id, "session_min_ts": new_ts,
                "username": u["username"]}
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("revoke-user failed: %r", exc)
        raise HTTPException(500, "Échec de la révocation")


# ─────────────────────────────────────────────────────────────────────
#  Mode HTTPS (reverse proxy Caddy) — voir deploy/caddy/README.md
#
#  Le toggle ne pilote JAMAIS Caddy (systemd indépendant, config
#  statique) : il bascule les binds gunicorn 0.0.0.0 ↔ 127.0.0.1 (relus
#  par les confs gunicorn au SIGHUP), aligne le flag cookie
#  ``session.https_only`` et déclenche le reload orchestré des deux
#  process. Garde anti-lockout : refus d'activer si Caddy n'écoute pas.
# ─────────────────────────────────────────────────────────────────────

def _caddy_listening(port: int, host: str = "127.0.0.1") -> bool:
    """True si quelque chose écoute sur ``host:port`` (sonde TCP 1,5 s).

    Module-level pour être monkeypatchable en test. Court-circuit dev
    (VM sans Caddy) : env ``APP_HTTPS_CHECK_SKIP=1``.
    """
    if os.environ.get("APP_HTTPS_CHECK_SKIP") == "1":
        return True
    try:
        with socket.create_connection((host, int(port)), timeout=1.5):
            return True
    except OSError:
        return False


def _bind_host(cfg: dict) -> str:
    """Hôte d'écoute que les confs gunicorn retiendront pour ``cfg`` (même
    règle, même code : ``server/_bind_host.py``)."""
    try:
        from server._bind_host import host_for
        return host_for(cfg)
    except Exception:                                        # noqa: BLE001
        return "127.0.0.1"


def _listen_mode(cfg: dict) -> str:
    """« local » ou « lan » effectif hors HTTPS (clé absente = « lan »,
    compatibilité des installations d'avant le réglage)."""
    sec = cfg.get("security") or {}
    return "lan" if _bind_host({"security": {"listen": sec.get("listen")}}) == "0.0.0.0" else "local"


def _https_cfg_ports(cfg: dict) -> Dict[str, int]:
    """Ports du frontal Caddy depuis une config déjà lue (défauts alignés
    sur deploy/caddy/Caddyfile.template)."""
    https = ((cfg.get("security") or {}).get("https") or {})
    try:
        return {
            "main":  int(https.get("main_port",  443)),
            "admin": int(https.get("admin_port", 8443)),
            "rag":   int(https.get("rag_port",   8444)),
        }
    except Exception:
        return {"main": 443, "admin": 8443, "rag": 8444}


def _public_host(request: Request) -> str:
    """Hostname (sans port) que le client utilise pour nous joindre —
    X-Forwarded-Host (proxy) prioritaire sur Host, même précédence que
    ``system._request_public_host``."""
    from shared_infra.routes.system import _request_public_host, _split_host_port
    host, _port = _split_host_port(_request_public_host(request))
    return host or "127.0.0.1"


def _https_urls(host: str, enabled: bool, ports: Dict[str, int]) -> Dict[str, str]:
    """URLs d'accès après bascule — renvoyées au frontend pour rediriger
    l'opérateur (le port 443 est implicite, les autres explicites)."""
    if enabled:
        main = f"https://{host}/" if ports["main"] == 443 else f"https://{host}:{ports['main']}/"
        return {"main": main, "admin": f"https://{host}:{ports['admin']}/admin"}
    # Accès direct historique — paire de ports dev/prod 8001/8002
    # (mêmes constantes que la synthèse de system.py et ./elpis start).
    return {"main": f"http://{host}:8001/", "admin": f"http://{host}:8002/admin"}


def _client_local(request: Request) -> bool:
    from shared_infra.security.local_request import is_direct_local
    try:
        return is_direct_local(request)
    except Exception:                                        # noqa: BLE001
        return False


async def _restart_app(message: str) -> bool:
    """Popup maintenance puis reload de main et de ce process (les confs
    gunicorn relisent le bind). Renvoie False si main n'a pas accusé."""
    # ── Popup maintenance cross-process (même canal que /restart) ─────
    try:
        from shared_infra.observability.metrics import broadcast as metric_broadcast
        metric_broadcast.publish_event({
            "type":    "restart",
            "message": message,
            "started_at": time.time(),
        })
    except Exception as exc:
        logger.warning("[security/https] file broadcast failed: %r", exc)

    # ── Reloads ───────────────────────────────────────────────────────
    # Split mode : demander à main de se recharger (loopback — toujours
    # joignable : 0.0.0.0 inclut 127.0.0.1, et en mode HTTPS le bind EST
    # 127.0.0.1), puis se recharger soi-même. Full mode : un seul process.
    from shared_infra.routes.admin.lifecycle import schedule_self_reload
    app_mode = os.environ.get("APP_MODE", "full").lower()
    main_restart_ok = True
    if app_mode != "full":
        main_url = (os.environ.get("MAIN_INTERNAL_URL")
                    or "http://127.0.0.1:8001").rstrip("/")
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.post(f"{main_url}/api/admin/internal/restart-self")
            main_restart_ok = (resp.status_code == 200)
            if not main_restart_ok:
                logger.warning(
                    "[security/https] main restart-self returned %d: %s",
                    resp.status_code, resp.text[:200],
                )
        except httpx.HTTPError as exc:
            main_restart_ok = False
            logger.warning("[security/https] restart-self call failed: %r", exc)
    schedule_self_reload()
    return main_restart_ok


@admin_router.get("/api/admin/security/https")
def admin_security_https_status(request: Request):
    """État du mode HTTPS pour le panneau admin : setting actuel, sondes
    TCP des trois ports Caddy, schéma effectivement vu par cette requête."""
    _require_admin(request)
    cfg = read_config_json() or {}
    ports = _https_cfg_ports(cfg)
    enabled = bool(((cfg.get("security") or {}).get("https") or {}).get("enabled", False))
    scheme = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip().lower()
    if scheme not in ("http", "https"):
        scheme = (request.url.scheme or "http").lower()
    return {
        "enabled": enabled,
        "ports":   ports,
        "caddy": {
            "main":  _caddy_listening(ports["main"]),
            "admin": _caddy_listening(ports["admin"]),
            "rag":   _caddy_listening(ports["rag"]),
        },
        "current_scheme": scheme,
        "urls": _https_urls(_public_host(request), enabled, ports),
        # Écoute hors HTTPS (security.listen) + requête venue de la machine
        # elle-même : seule condition pour passer en « local » sans se couper.
        "listen": _listen_mode(cfg),
        "client_local": _client_local(request),
    }


@admin_router.post("/api/admin/security/https")
async def admin_security_https_toggle(request: Request):
    """Active/désactive le mode HTTPS puis redémarre l'app (main + admin).

    Séquence : garde anti-lockout (Caddy doit écouter avant d'activer) →
    écriture config (``https.enabled`` + alignement ``session.https_only``)
    → popup maintenance cross-process → reload de main (loopback, split
    mode) puis de ce process. Répond AVANT la coupure (reload différé 5 s).
    """
    _require_admin(request)
    try:
        body = await request.json()
    except Exception:
        body = {}
    enabled = bool((body or {}).get("enabled"))

    cfg = read_config_json() or {}
    ports = _https_cfg_ports(cfg)

    # ── Garde anti-lockout ────────────────────────────────────────────
    # Activer le HTTPS rabat les binds sur 127.0.0.1 : si Caddy n'écoute
    # pas, l'app deviendrait injoignable à distance. Aucune écriture
    # config tant que la sonde échoue. (La garde ne protège qu'au moment
    # du toggle — break-glass documenté dans deploy/caddy/README.md.)
    if enabled:
        # AUDIT 2026-09-01 (passe 5, B14) — sondes TCP sync (2 × 1,5 s sur
        # port filtré) : hors de la boucle du process admin.
        import asyncio as _aio
        down = await _aio.to_thread(
            lambda: [p for p in (ports["main"], ports["admin"]) if not _caddy_listening(p)])
        if down:
            raise HTTPException(
                409,
                "Caddy n'écoute pas sur le(s) port(s) "
                + ", ".join(f":{p}" for p in down)
                + " — installez/démarrez le reverse proxy (deploy/caddy/"
                  "install_caddy.sh) avant d'activer le HTTPS.",
            )

    # ── Écriture config ───────────────────────────────────────────────
    sec = cfg.setdefault("security", {})
    https = sec.setdefault("https", {})
    https["enabled"] = enabled
    https.setdefault("main_port",  443)
    https.setdefault("admin_port", 8443)
    https.setdefault("rag_port",   8444)
    sess = sec.setdefault("session", {})
    sess["https_only"] = enabled
    # ``same_site=none`` force https_only=True au boot (app.py) : en
    # retour HTTP il faut rétrograder, sinon le cookie resterait Secure
    # et plus personne ne pourrait se connecter en clair.
    if not enabled and str(sess.get("same_site") or "").lower() == "none":
        sess["same_site"] = "lax"
    write_config_json(cfg)

    operator = request.session.get("user_id")
    logger.warning(
        "[security] HTTPS mode %s by uid=%s (binds %s, cookie https_only=%s)",
        "ENABLED" if enabled else "DISABLED", operator, _bind_host(cfg), enabled,
    )

    main_restart_ok = await _restart_app(
        "Le serveur redémarre pour changer de mode d'accès "
        f"({'HTTPS' if enabled else 'HTTP direct'}). Reconnexion automatique...")

    return {
        "ok": main_restart_ok,
        "enabled": enabled,
        "urls": _https_urls(_public_host(request), enabled, ports),
        "main_restarted": main_restart_ok,
    }


@admin_router.post("/api/admin/security/listen")
async def admin_security_listen(request: Request):
    """Écoute hors HTTPS : « local » (127.0.0.1) ou « lan » (0.0.0.0), puis
    redémarrage. Sans objet en HTTPS (loopback, Caddy frontal). Garde
    anti-verrouillage : « local » seulement depuis la machine elle-même."""
    _require_admin(request)
    try:
        body = await request.json()
    except Exception:
        body = {}
    listen = str((body or {}).get("listen") or "").strip().lower()
    if listen not in ("local", "lan"):
        raise HTTPException(400, "listen : « local » ou « lan »")
    cfg = read_config_json() or {}
    sec = cfg.setdefault("security", {})
    if bool((sec.get("https") or {}).get("enabled", False)):
        raise HTTPException(409, "HTTPS actif : l'application écoute déjà en local derrière Caddy.")
    if listen == "local" and not _client_local(request):
        raise HTTPException(
            409, "Passer en écoute locale depuis le réseau vous couperait l'accès : "
                 "faites-le depuis le serveur (http://127.0.0.1:8002/admin) ou "
                 "./elpis configure --listen local.")
    sec["listen"] = listen
    write_config_json(cfg)
    logger.warning("[security] listen=%s by uid=%s (binds %s)",
                   listen, request.session.get("user_id"), _bind_host(cfg))
    ok = await _restart_app("Le serveur redémarre pour changer d'écoute "
                            f"({'réseau local' if listen == 'lan' else 'ce serveur seulement'}). "
                            "Reconnexion automatique...")
    return {"ok": ok, "listen": listen, "main_restarted": ok}


@admin_router.post("/api/admin/security/sessions/clear-user-revocation/{user_id}")
def admin_security_clear_user_revocation(user_id: int, request: Request):
    """
    Reset users.session_min_ts to 0 for a specific user — undoes a
    previous revoke-user. Useful when an operator force-logged a user
    by mistake and wants to let an OLDER session resume (rare).
    """
    _require_admin(request)
    try:
        # clear_session_min_ts COMMIT (idem revoke-user : l'UPDATE inline via
        # db_conn() était annulé au close() → reset sans effet).
        from shared_infra.accounts.users import clear_session_min_ts
        clear_session_min_ts(user_id)
        return {"ok": True, "user_id": user_id}
    except Exception as exc:
        logger.exception("clear-user-revocation failed: %r", exc)
        raise HTTPException(500, "Échec du reset")
