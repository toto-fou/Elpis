# SPDX-License-Identifier: MIT
# backend/deps.py
"""
backend.deps — Cross-cutting FastAPI dependencies.

The single dependency exported here, ``require_user_id``, is the
universal authentication gate for every protected endpoint in the app
(204 call-sites at last count). Because of that reach, ANY check we
want to apply on every authenticated request — session expiry, global
revocation, per-user revocation, idle timeout — has to live INSIDE
this function. Putting it on a deeper helper that only some routes
opt into is what previously caused the "revocation works but users
can keep posting" bug: most routes never went through that helper.

The 4 checks executed below mirror what _session_uid_any in
backend.routes._legacy used to do (and still does, for callers that
import it directly). The two functions delegate to the same private
helper so the behaviour stays in lock-step automatically.

Why these 4 checks belong on the hot path
------------------------------------------
  - config_view() serves a process-wide cache invalidated by the file's
    own (mtime, size), so a settings change on ANY worker is still seen
    here at the next request. Cost is one stat() — ~2 µs.
    (This used to call read_config_json(), justified by "the file is
    < 50 KB". That stopped being true: config.json now weighs ~400 KB,
    96 % of it the ``welcome`` section, and the full reparse cost
    825 µs on EVERY authenticated request.)
  - The DB SELECT is a single primary-key lookup against an indexed
    table; SQLite's page cache makes it sub-microsecond on warm runs.
  - Session cookie reads are O(1) dict lookups.
Total overhead: < 1 ms per authenticated request, well below the
cost of the actual handler. Worth it for instant logout when an
operator clicks "Révoquer".
"""
from fastapi import HTTPException, Request

# Note: we deliberately keep the imports minimal to avoid pulling
# routes/_legacy.py into deps.py (which would create a cycle —
# _legacy.py imports require_user_id transitively via _require_admin
# helpers). db_conn and read_config_json are leaf modules.


# SECURITY FIX #B : whitelist des paths autorisés quand le user a
# ``must_change_pwd=1``. La logique métier veut que le user soit
# bloqué partout sauf sur le formulaire de changement de mot de
# passe ; sans cette gate, le front pouvait bien afficher l'écran,
# mais une requête API directe (curl, extension navigateur, …) avec
# le cookie de session était acceptée par tous les endpoints. On
# autorise aussi /api/me-lite et /api/logout-lite pour que le front
# puisse interroger l'état et offrir un bouton "logout".
_MUST_CHANGE_PWD_ALLOWED_PATHS = frozenset({
    "/api/users/change-password",
    "/api/me-lite",
    "/api/logout-lite",
})


def _session_validity_checks(request: Request, uid: int) -> bool:
    """
    Run the four expiry / revocation gates against the current session.
    Returns True if the session is still valid; False if it must be
    rejected (and the caller should treat it as not-logged-in). On
    rejection we ALSO clear the session so the next request returns a
    fresh 401 quickly — without this, an attacker holding a leaked
    cookie could keep retrying with the same revoked session.

    The four gates, in order of cheapest-first:

      1. Absolute max age — login_ts older than security.session.max_age_sec.
      2. Global revocation — login_ts older than security.session.global_min_ts
         (set by POST /api/admin/security/sessions/revoke-all).
      3. Per-user revocation — login_ts older than users.session_min_ts
         (set by POST /api/admin/security/sessions/revoke-user/{uid}).
      4. Optional idle timeout — only if security.session.idle_timeout_sec
         > 0; bumps a session-stored _last_activity_ts on success.
    """
    import time as _t
    # Lazy imports inside the hot path are fine — Python caches module
    # objects in sys.modules so the second call is just a dict lookup.
    from shared_infra.config import config_view

    try:
        sec = (config_view() or {}).get("security") or {}
        sess_cfg = sec.get("session") or {}
    except Exception:
        sess_cfg = {}
    max_age_sec      = int(sess_cfg.get("max_age_sec",      86400))
    idle_timeout_sec = int(sess_cfg.get("idle_timeout_sec", 0))
    global_min_ts    = float(sess_cfg.get("global_min_ts",  0.0))

    login_ts = request.session.get("_login_ts")

    # SECURITY FIX (élevé) : on rejette toute session sans ``_login_ts``.
    # Avant, les portes (1) max_age, (2) global revoke, (3) per-user
    # revoke étaient toutes conditionnelles sur ``if login_ts`` → une
    # session forgée / pré-feature / corrompue qui n'avait pas ce champ
    # passait silencieusement les trois gates et restait valide
    # indéfiniment. Toute session légitime créée par /api/login-lite a
    # ``_login_ts`` (cf. api_login_lite l.141). Donc rejeter ici n'a
    # aucun impact UX, mais ferme le bypass.
    if not login_ts:
        request.session.clear()
        return False

    # (1) Absolute max age (default 24 h, configurable).
    if _t.time() - login_ts > max_age_sec:
        request.session.clear()
        return False

    # (2) Global "revoke all" epoch.
    if global_min_ts > 0 and login_ts < global_min_ts:
        request.session.clear()
        return False

    # (3) Per-user revocation epoch — costs one indexed SELECT.
    #
    # SECURITY FIX (P1, fail-open) — avant, ce SELECT était dans un
    # ``except Exception: pass`` censé ne couvrir que « colonne absente »
    # (très vieille DB sans ``session_min_ts``). Mais il avalait AUSSI les
    # erreurs transitoires (DB lockée, ``OperationalError`` sous contention
    # WAL multi-worker, I/O). Conséquence : la session d'un user explicitement
    # révoqué par un admin passait la gate et restait valide jusqu'à
    # ``max_age`` (24 h) — l'opérateur croyait avoir coupé un compte compromis.
    #
    # On distingue donc deux cas :
    #   • « no such column » (schéma legacy) → on ignore et on continue ;
    #   • toute AUTRE erreur (transitoire ou non) → fail-CLOSED (return False)
    #     pour ne jamais laisser passer une session sur un contrôle de
    #     révocation qui n'a pas pu s'exécuter.
    import sqlite3 as _sqlite3
    try:
        # AUDIT 2026-09-01 (passe 6, B4) — la ligne ``users`` ENTIÈRE est
        # chargée une fois ici et mise en cache sur ``request.state`` :
        # ``require_user_id`` (must_change_pwd, username) et les routes qui
        # veulent ``settings_json`` la réutilisent au lieu de refaire chacun
        # leur ``SELECT *`` de la même ligne dans la même requête. Fonctionne
        # aussi pour les WebSockets (``_pty`` passe ``ws`` : ``.state`` existe).
        from shared_infra.accounts.users import get_user_by_id as _gub
        row = _gub(int(uid))
        if row is not None:
            # ``.state`` existe sur Request/WebSocket Starlette ; un objet
            # requête minimal (tests) n'en a pas — le cache est facultatif.
            _st = getattr(request, "state", None)
            if _st is not None:
                try:
                    _st._user_row = row
                except Exception:
                    pass
            try:
                user_min_ts = float(row["session_min_ts"] or 0.0)
            except (IndexError, KeyError):
                # Schéma legacy sans ``session_min_ts`` : le contrôle de
                # révocation per-user n'existe pas — même tolérance que
                # l'ancien « no such column ».
                user_min_ts = 0.0
            if user_min_ts > 0 and login_ts < user_min_ts:
                request.session.clear()
                return False
        else:
            # AUDIT 2026-08-02 (C1) — la ligne ``users`` n'existe plus :
            # compte SUPPRIMÉ. L'ancien code laissait ``row is None`` sauter
            # toutes les gates → une session sur un compte fantôme restait
            # valide jusqu'à ``max_age`` (24 h), gardant chat, dépense LLM
            # ET un shell. Le SELECT a réussi (pas une erreur transitoire),
            # l'absence de ligne est définitive → fail-CLOSED.
            request.session.clear()
            return False
    except _sqlite3.OperationalError:
        # DB lockée / contention WAL / I/O → on NE peut PAS confirmer que la
        # session n'est pas révoquée : fail-closed. (Le cas « colonne
        # absente » ne peut plus se produire ici — ``SELECT *`` ne référence
        # aucune colonne, et l'accès est gardé ci-dessus.)
        request.session.clear()
        return False
    except Exception:
        # Toute autre erreur inattendue sur un contrôle de sécurité →
        # fail-closed également.
        request.session.clear()
        return False

    # (3bis) Révocation PAR SESSION — audit 2026-08-01 (E4).
    #
    # Le logout ne pouvait rien révoquer côté serveur (cookie signé, pas de
    # store) : un cookie capturé restait valide jusqu'à ``max_age``. On rejette
    # désormais les ``_sid`` explicitement révoqués. Même politique fail-CLOSED
    # que la gate (3) : si le contrôle ne peut pas s'exécuter, on refuse — un
    # contrôle de révocation qui échoue ne doit jamais laisser passer.
    #
    # Sessions ANTÉRIEURES à cette version : pas de ``_sid``. On les tolère
    # (elles restent couvertes par max_age et par les révocations par-user) ;
    # tout nouveau login en pose un.
    _sid = request.session.get("_sid")
    if _sid:
        try:
            from shared_infra.accounts.users import is_session_revoked
            if is_session_revoked(str(_sid)):
                request.session.clear()
                return False
        except _sqlite3.OperationalError as exc:
            from shared_infra.db._dialect import is_missing_table
            if is_missing_table(exc):
                pass          # migration 0009 pas encore appliquée
            else:
                request.session.clear()
                return False
        except Exception:
            request.session.clear()
            return False

    # (4) Idle timeout (opt-in). Stored in the session cookie itself,
    # so no DB write per request. Bumped AFTER all other checks pass.
    if idle_timeout_sec > 0:
        last_act = request.session.get("_last_activity_ts") or login_ts
        if _t.time() - last_act > idle_timeout_sec:
            request.session.clear()
            return False
        request.session["_last_activity_ts"] = _t.time()

    return True


def stream_session_still_valid(uid: int, login_ts, sid) -> bool:
    """
    Revalidation PÉRIODIQUE d'un flux long (SSE / WebSocket) déjà
    authentifié au handshake — audit 2026-08-02 (S1).

    Avant ce helper, les gates de ``_session_validity_checks`` n'étaient
    exécutées qu'au handshake : une session expirée (max_age) ou révoquée
    par un admin gardait ses flux SSE/WS ouverts indéfiniment (shell
    interactif compris). Les boucles ``listen()`` appellent désormais ce
    helper toutes les ~60 s avec les valeurs capturées au handshake.

    Différences volontaires avec le chemin requête :
      • Pas d'idle-timeout : un flux ouvert EST une activité, et le flux
        ne peut de toute façon pas ré-écrire le cookie de session.
      • Pas de mutation de session (le scope WS/SSE ne repart jamais
        vers le navigateur).
      • Erreur transitoire (DB lockée…) → True (fail-OPEN), contrairement
        au fail-closed du chemin requête : couper tous les flux du worker
        sur un hoquet SQLite déclencherait une tempête de reconnexions
        qui aggrave la contention, alors que le handshake de reconnexion
        et chaque requête HTTP restent fail-closed. La révocation réelle
        est vue au prochain passage réussi (≤ ~60 s).
    """
    import time as _t
    from shared_infra.config import config_view

    if not login_ts:
        return False
    try:
        login_ts = float(login_ts)
    except (TypeError, ValueError):
        return False

    try:
        sec = (config_view() or {}).get("security") or {}
        sess_cfg = sec.get("session") or {}
    except Exception:
        sess_cfg = {}
    max_age_sec   = int(sess_cfg.get("max_age_sec",   86400))
    global_min_ts = float(sess_cfg.get("global_min_ts", 0.0))

    # (1) Max age absolu.
    if _t.time() - login_ts > max_age_sec:
        return False
    # (2) Révocation globale.
    if global_min_ts > 0 and login_ts < global_min_ts:
        return False
    # (3) Révocation per-user.
    try:
        from shared_infra.observability.usage_store import db_conn
        with db_conn() as conn:
            row = conn.execute(
                "SELECT session_min_ts FROM users WHERE id = ?", (int(uid),)
            ).fetchone()
            if row:
                user_min_ts = float(row[0] or 0.0)
                if user_min_ts > 0 and login_ts < user_min_ts:
                    return False
            else:
                # AUDIT 2026-08-02 (C1) — compte supprimé (SELECT réussi, aucune
                # ligne) : couper le flux long. L'absence de ligne est définitive
                # et ne relève pas du fail-open « erreur transitoire ».
                return False
    except Exception:
        pass  # transitoire → fail-open (cf. docstring)
    # (3bis) Révocation par session.
    if sid:
        try:
            from shared_infra.accounts.users import is_session_revoked
            if is_session_revoked(str(sid)):
                return False
        except Exception:
            pass  # transitoire → fail-open (cf. docstring)
    return True


def require_user_id(request: Request) -> int:
    """
    Resolve and validate the authenticated user id stored in the
    session cookie. Raises HTTPException(401) if there is no session
    OR if any of the four revocation/expiry checks fails.

    Used as a FastAPI dependency:
        @router.get("/api/foo")
        def handler(uid: int = Depends(require_user_id)): ...
    """
    # (2026-09-11, P4) HÔTE D'OUTILS : l'identité a été VÉRIFIÉE par
    # ``toolhost/auth.py`` (jeton de service + enveloppe signée) et posée dans
    # ``request.state`` ; il n'y a ni session web ni base des comptes ici.
    _th = getattr(getattr(request, "state", None), "toolhost_identity", None)
    if _th is not None:
        try:
            request.state.user_id = int(_th.user_id)
            request.state.username = str(_th.username)
        except Exception:
            pass
        return int(_th.user_id)
    uid = request.session.get("user_id")
    if not uid:
        raise HTTPException(status_code=401, detail="not logged in")
    try:
        uid_int = int(uid)
    except (TypeError, ValueError):
        request.session.clear()
        raise HTTPException(status_code=401, detail="not logged in")

    if not _session_validity_checks(request, uid_int):
        # _session_validity_checks already cleared the session. Return
        # 401 so the front-end's fetchAuth wrapper kicks the user back
        # to the login screen on the next request.
        raise HTTPException(status_code=401, detail="session revoked or expired")

    # SECURITY FIX #B : si l'user a un mot de passe temporaire à
    # changer (must_change_pwd=1), refuser tout endpoint hors de
    # la whitelist. 403 plutôt que 401 parce que la session EST
    # valide — c'est l'opération qui est interdite jusqu'au reset.
    # Le front intercepte le 403 et bascule sur l'écran de change
    # password (cf. fetchAuth dans app.js).
    # (passe 6, B4) — ligne déjà chargée par ``_session_validity_checks`` :
    # on la réutilise au lieu de refaire un ``SELECT *`` de la même ligne.
    _row = getattr(request.state, "_user_row", None)
    try:
        if _row is None:
            from shared_infra.accounts.users import get_user_by_id as _gub
            _row = _gub(uid_int)
        _must_change = bool(_row["must_change_pwd"]) if _row else False
    except Exception:
        _must_change = False

    # AUDIT 2026-08-23 — l'identité de l'OPÉRATEUR est posée ici, seule porte
    # commune à toutes les routes authentifiées (``_require_admin`` passe par
    # nous). Une vingtaine d'appels à ``audit_event`` lisaient déjà
    # ``request.state.user_id`` / ``.username``… que RIEN ne posait : les deux
    # middlewares applicatifs sont des ASGI purs et ne touchent pas au state.
    # Toutes les actions d'administration étaient donc journalisées à
    # ``user_id: null``, et ces lignes sont invisibles au filtre par opérateur
    # de ``GET /api/admin/observability/audit-recent`` — un journal d'audit qui
    # ne dit pas QUI. La ligne d'utilisateur est déjà chargée juste au-dessus :
    # aucune requête supplémentaire.
    request.state.user_id = uid_int
    try:
        request.state.username = _row["username"] if _row is not None else None
    except Exception:                                           # noqa: BLE001
        request.state.username = None

    if _must_change:
        _path = request.url.path
        if _path not in _MUST_CHANGE_PWD_ALLOWED_PATHS:
            raise HTTPException(
                status_code=403,
                detail="must_change_password",
            )

    return uid_int
