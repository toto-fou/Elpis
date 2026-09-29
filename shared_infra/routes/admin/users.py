# SPDX-License-Identifier: MIT
"""
Admin user-management endpoints (CRUD + role + reset-password + sandbox-quota).

Auto-extracted from the former monolithic ``backend/routes/admin.py``.
The endpoint bodies are byte-for-byte identical to the originals.
"""
from __future__ import annotations

import asyncio
import logging

from fastapi import HTTPException, Request

from shared_infra.config import (
    read_config_json,
)
from shared_infra.accounts.groups import (
    get_all_users_with_groups,
)
from shared_infra.accounts.users import (
    get_user,
    create_user,
    get_username_by_id,
    get_user_by_id,
    reset_user_password,
    bump_session_min_ts,
    get_user_settings,
    merge_user_settings,
    delete_user_full,
)
from shared_infra.observability.usage_store import (
    db_conn,
)
from shared_infra.security.audit import audit_event
from shared_infra.security.deps import require_user_id
from shared_infra.accounts.passwd import run_password_op

# Helpers shared with _legacy. Single source of truth.
from shared_infra.routes._legacy import (
    _require_admin, _get_sandbox_path, _get_work_path,
    # AUDIT 2026-08-30 (S2) — manquait : la seule référence, plus bas, levait
    # donc un NameError à CHAQUE utilisateur, avalé par un ``except Exception``
    # qui rendait 0. La jauge d'espace sandbox de la liste admin affichait
    # « 0 Mo » pour tout le monde depuis que la mesure est passée au compteur
    # en cache.
    sandbox_usage_bytes,
    validate_password,
)

# Routers — owned by ``_state``. We import them so endpoint decorators
# below register on the SAME singleton router instances mounted by
# ``app.py`` / ``admin_app.py``.
from shared_infra.routes.admin._state import admin_router

logger = logging.getLogger("uvicorn.error")


@admin_router.delete("/api/admin/users/{target_id}")
def api_admin_delete_user(target_id: int, request: Request):
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    if not me or me["is_admin"] != 1: raise HTTPException(403, "Admin required")
    if uid == target_id: raise HTTPException(400, "Vous ne pouvez pas vous supprimer vous-même.")

    # Check if sandbox should also be deleted
    delete_sandbox = request.query_params.get("delete_sandbox", "false").lower() == "true"

    # BUG FIX #C : on résout le chemin sandbox AVANT de supprimer le
    # user en base. ``_get_sandbox_path`` dérive le path depuis
    # ``get_username_by_id``, qui retourne ``None`` une fois le user
    # supprimé → fallback ``user_<id>`` qui ne correspond PAS au
    # répertoire réel (créé sous le vrai username). Avant ce fix, la
    # sandbox restait orpheline sur disque malgré ``delete_sandbox=true``.
    sb_path_to_remove = None
    if delete_sandbox:
        try:
            sb_path_to_remove = _get_sandbox_path(target_id)
        except Exception:
            sb_path_to_remove = None

    # AUDIT 2026-08-02 (C1) — publier la révocation AVANT le DELETE : coupe les
    # flux SSE/WS déjà ouverts (shell interactif compris) de ce compte sur tous
    # les workers. Après le DELETE, la ligne ``users`` disparaît et plus aucune
    # gate per-user ne peut se déclencher — mais ``_session_validity_checks``
    # rejette désormais (fail-closed) toute session dont le user_id n'a plus de
    # ligne, donc les requêtes HTTP du fantôme sont coupées au prochain passage.
    try:
        import time as _t
        from shared_infra.observability.metrics.broadcast import publish_event
        publish_event({"type": "session_revoked", "uid": int(target_id),
                       "ts": _t.time()})
    except Exception:
        logger.exception("[admin] publication session_revoked (delete) échouée")

    _gone_name = get_username_by_id(target_id)
    success = delete_user_full(target_id)
    if not success: raise HTTPException(404, "Utilisateur introuvable")
    # Un nom réattribué plus tard ne doit pas hériter des machines du compte
    # supprimé (listes ``allowed_users`` des cibles desktop).
    if _gone_name:
        try:
            _set_desktop_membership(_gone_name, set())
        except Exception:
            logger.exception("[admin] nettoyage des accès desktop (delete) échoué")

    sandbox_deleted = False
    sandbox_error = None
    if delete_sandbox and sb_path_to_remove is not None:
        import shutil, os, stat as _stat
        # PASSE 15 (B4) — Retry-with-chmod sur PermissionError. Avant,
        # un sandbox contenant un dossier owned par UID 10001 avec
        # mode 0700 faisait échouer shutil.rmtree silencieusement
        # (except Exception: pass), la sandbox restait sur disque,
        # et sandbox_deleted=False était noyé dans une réponse ok=True.
        # Maintenant : on tente, on retry avec chmod 0777, et on
        # surface l'erreur résiduelle dans la réponse pour que l'admin
        # voie ce qu'il s'est passé.
        def _onerror(func, p, exc_info):
            try:
                # SÉCURITÉ : ``os.chmod`` déréférence les symlinks. Un lien
                # posé dans la sandbox verrait sa cible (hors sandbox) élargie
                # en 0777. rmtree supprime les liens par ``unlink`` — élargir
                # les droits n'aide jamais pour un lien.
                if not os.path.islink(p):
                    os.chmod(p, _stat.S_IRWXU | _stat.S_IRWXG | _stat.S_IRWXO)
                func(p)
            except Exception:
                raise exc_info[1]
        try:
            if sb_path_to_remove.exists():
                shutil.rmtree(sb_path_to_remove, onerror=_onerror)
                sandbox_deleted = True
        except Exception as e:
            sandbox_error = str(e)

    response = {"ok": True, "sandbox_deleted": sandbox_deleted}
    if sandbox_error:
        response["sandbox_error"] = sandbox_error
    return response


@admin_router.post("/api/admin/users/new")
async def api_admin_create_user(request: Request):
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    if not me or me["is_admin"] != 1: raise HTTPException(403, "Admin required")
    
    data = await request.json()
    username = data.get("username", "").strip()
    password = data.get("password", "").strip()
    role = data.get("role", "user")
    is_admin = {"admin": 1, "moderator": 2, "user": 0}.get(role, 0)
    
    if not username or not password: raise HTTPException(400, "Données invalides")
    if get_user(username): raise HTTPException(400, "L'utilisateur existe déjà")
    # Charset canonique (injectivité dossier sandbox/mémoire) — validate_username
    # (dans create_user) lève ValueError ; on la remonte en 400 explicite.
    from shared_infra.accounts.users import validate_username
    try:
        validate_username(username)
    except ValueError as _ve:
        raise HTTPException(400, str(_ve))
    # BUG FIX (élevé) : applique la même politique de mot de passe que le
    # self-service. Avant, l'admin pouvait créer un user avec password "a"
    # — incohérent avec ``security.password.*`` (longueur min, chiffre,
    # spécial). validate_password lit la config et raise HTTPException 400
    # avec un message clair si la politique est violée.
    validate_password(password)

    # PBKDF2 150 k itérations = 87 ms hors de la boucle (cf. passwd_async).
    await run_password_op(create_user, username, password,
                          is_admin=is_admin, must_change_pwd=1)
    return {"ok": True}


@admin_router.post("/api/admin/users/{target_id}/role")
async def api_admin_change_role(request: Request, target_id: int):
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    if not me or me["is_admin"] != 1: raise HTTPException(403, "Admin required")
    
    data = await request.json()
    role = data.get("role", "user")
    is_admin_val = {"admin": 1, "moderator": 2, "user": 0}.get(role, 0)
    
    target = get_user_by_id(target_id)
    if not target: raise HTTPException(404, "Utilisateur non trouvé")
    if target_id == uid and is_admin_val != 1:
        raise HTTPException(400, "Impossible de retirer vos propres droits admin")
    
    # BUG FIX (medium) : migration vers db_conn() — voir backend/db/users.py
    # pour le rationnel (fuite de connexion possible si le db() lève entre
    # les deux statements).
    with db_conn() as conn:
        conn.execute("UPDATE users SET is_admin=? WHERE id=?", (is_admin_val, target_id))
        conn.commit()
    return {"ok": True, "role": role}


# NOTE — GET /api/admin/users retiré (réalignement admin 2026-06) :
# doublon sans appelant de /api/admin/users-with-groups, seule liste
# utilisée par l'onglet Utilisateurs.


@admin_router.post("/api/admin/reset-password")
async def api_admin_reset_password(request: Request):
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    if not me or me["is_admin"] != 1: raise HTTPException(403, "Admin required")
    
    data = await request.json()
    target_id = data.get("target_id")
    new_pass = data.get("new_password")
    if not target_id or not new_pass: raise HTTPException(400, "Missing data")
    # BUG FIX (élevé) : applique la politique de mot de passe ici aussi
    # (cf. api_admin_create_user). Sans ça, un admin pouvait reset un
    # password vers une valeur faible alors que l'utilisateur cible se
    # serait vu refuser ce même password en self-service.
    validate_password(new_pass)

    await run_password_op(reset_user_password, int(target_id), new_pass)

    # SECURITY — un reset admin (offboarding / réponse à compromission) doit
    # invalider les sessions existantes de l'utilisateur cible : une session
    # active ne doit PAS survivre au reset. Même mécanisme que
    # /api/admin/security/sessions/revoke-user (session_min_ts).
    bump_session_min_ts(int(target_id))

    # BUG FIX (medium) : migration vers db_conn() (cf. change_role).
    with db_conn() as conn:
        cur = conn.cursor()
        cur.execute("UPDATE users SET must_change_pwd=1 WHERE id=?", (int(target_id),))
        conn.commit()
        
    return {"ok": True}


@admin_router.get("/api/admin/users-with-groups")
def api_users_with_groups(request: Request):
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    if not me or me["is_admin"] != 1: raise HTTPException(403, "Admin required")
    _cfg = read_config_json() or {}
    _global_quota = int(_cfg.get("app", {}).get("sandbox_quota_mb", 5120))
    from shared_infra.sandbox.executors import load_admin_config, resolve_network_profile_id
    sb_cfg = load_admin_config()
    profiles = [p.to_dict() for p in (sb_cfg.network_profiles or [])]
    users = get_all_users_with_groups()
    for u in users:
        # (passe 6, B5) — settings ramenés par la requête jointe (clé privée
        # ``_settings``, poppée : ne doit PAS partir au navigateur) au lieu
        # d'un ``get_user_settings`` (SELECT *) par compte.
        s = u.pop("_settings", None) or {}
        u["sandbox_quota_mb"] = s.get("sandbox_quota_mb", _global_quota)
        # Réseau : profil EFFECTIF + l'imposition admin qui l'a produit (vide
        # = l'utilisateur choisit lui-même dans ses paramètres).
        u["network_profile_id"] = resolve_network_profile_id(s)
        u["forced_network_profile_id"] = str(s.get("forced_network_profile_id") or "")
        # AUDIT 2026-08-08 — deux défauts corrigés ici :
        #
        #  1. RACINE. On mesurait ``_get_sandbox_path`` (= ``P``), qui contient
        #     EN PLUS ``skills/``, ``memory/`` et ``.ocr/`` — alors que le quota
        #     affiché juste à côté (``sandbox_quota_mb``) est appliqué sur
        #     ``P/work``. L'admin comparait donc un chiffre à un plafond qui ne
        #     porte pas sur le même périmètre et pouvait voir « au-dessus du
        #     quota » un utilisateur qui ne l'était pas. On mesure désormais la
        #     MÊME racine que l'enforcement.
        #
        #  2. COÛT. C'était un ``du -sb`` SYNCHRONE par utilisateur dans cette
        #     boucle : la route était en O(N utilisateurs × taille sandbox).
        #     Mesuré à 127 ms pour 18 sandboxes quasi vides ; ~15 s extrapolées
        #     pour 50 utilisateurs ayant chacun un ``node_modules``. On passe
        #     par le compteur mis en cache — et comme il est maintenant clé sur
        #     la MÊME racine que la jauge de l'utilisateur, les entrées sont
        #     déjà chaudes pour tout utilisateur actif.
        try:
            u["sandbox_used_mb"] = round(
                sandbox_usage_bytes(u["id"], _get_work_path(u["id"])) / (1024 * 1024), 2)
        except OSError:
            # AUDIT 2026-08-30 (S2) — ex-``except Exception``. Le seul échec
            # ATTENDU ici est l'I/O (sandbox absente, montage indisponible) ;
            # tout attraper masquait un défaut de programmation — et l'a fait,
            # pendant toute la durée de vie de cet appel.
            u["sandbox_used_mb"] = 0
    # Serveurs d'inférence + droit de gérer les modèles (lot B4, 2026-09-16) :
    # réglage propre ET effectif (hérité des groupes / défaut), une lecture.
    from shared_infra.llm import engine_access as _ea
    _ea.describe_users(users)
    return {"users": users, "network_profiles": profiles,
            "desktop_targets": _desktop_targets_view()}


# ── Machines desktop pilotables (audit 2026-09-22, M2) ───────────────────────
# Réglage PAR COMPTE, stocké PAR MACHINE (``desktop.targets[].allowed_users``)
# — cf. shared_infra/desktop/access.py. Seules les machines en accès ``list``
# sont concernées ; celles en ``all`` restent ouvertes à tous.
def _desktop_targets_view() -> list:
    from shared_infra import config as _cfg
    try:
        _cfg.reload_desktop_config_from_disk()
    except Exception:
        pass
    return [{"name": t["name"], "os": t.get("os", "linux"), "access": t.get("access", "all"),
             "allowed_users": list(t.get("allowed_users") or [])}
            for t in _cfg.get_desktop_targets(reload=False)]


def _set_desktop_membership(username: str, names: set) -> list:
    """Place ``username`` dans ``allowed_users`` des machines ``names`` (en
    accès ``list``) et l'en retire ailleurs. Rend les machines modifiées."""
    import copy
    from shared_infra import config as _cfg
    cfg = copy.deepcopy(read_config_json() or {})
    targets = ((cfg.get("desktop") or {}).get("targets"))
    if not isinstance(targets, list):
        return []
    changed = []
    for t in targets:
        if not isinstance(t, dict) or str(t.get("access") or "all") != "list":
            continue
        cur = {str(u) for u in (t.get("allowed_users") or []) if str(u).strip()}
        want = (cur | {username}) if t.get("name") in names else (cur - {username})
        if want != cur:
            t["allowed_users"] = sorted(want)
            changed.append(t.get("name"))
    if changed:
        _cfg.write_config_json(cfg)
        _cfg.reload_desktop_config_from_disk(force=True)
    return changed


@admin_router.put("/api/admin/users/{target_id}/desktop-targets")
async def api_admin_set_user_desktop_targets(target_id: int, request: Request):
    """Corps : ``{"targets": ["vm-01", …]}`` — machines (en accès ``list``)
    que ce compte peut piloter ; les autres machines restreintes lui sont
    retirées. Les administrateurs pilotent tout, quel que soit ce réglage."""
    _require_admin(request)
    target = get_user_by_id(target_id)
    if not target:
        raise HTTPException(404, "Utilisateur introuvable")
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(400, "Corps JSON attendu")
    names = data.get("targets") if isinstance(data, dict) else None
    if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
        raise HTTPException(400, "targets : liste de noms de machines")
    known = {t["name"] for t in _desktop_targets_view()}
    unknown = [n for n in names if n not in known]
    if unknown:
        raise HTTPException(400, f"Machine inconnue : {unknown[0]}")
    changed = await asyncio.to_thread(_set_desktop_membership, target["username"], set(names))
    audit_event(
        user_id=getattr(request.state, "user_id", None),
        username=getattr(request.state, "username", None),
        action="admin.user.desktop_targets",
        details={"target_user_id": target_id, "target_username": target["username"],
                 "targets": sorted(names), "changed": changed},
    )
    return {"ok": True, "changed": changed, "desktop_targets": _desktop_targets_view()}


# ── Accès aux serveurs d'inférence (lot B4, 2026-09-16) ───────────────────────
# Cf. shared_infra/llm/engine_access.py pour la résolution. Corps du PUT :
# ``{"engine_keys": null | ["builtin", "conn:3", "*"], "can_manage_models":
# null | true | false}`` ; une clé ABSENTE du corps garde sa valeur actuelle.
async def _read_llm_access_body(request: Request, current: dict) -> dict:
    from shared_infra.llm import engine_access as _ea
    try:
        data = await request.json()
    except Exception:                                            # noqa: BLE001
        raise HTTPException(400, "Corps JSON attendu")
    if not isinstance(data, dict):
        raise HTTPException(400, "Corps JSON attendu")
    keys = current.get("engine_keys")
    manage = current.get("can_manage_models")
    if "engine_keys" in data:
        try:
            keys = _ea.normalize_engine_keys(data.get("engine_keys"), check_exists=True)
        except ValueError as e:
            raise HTTPException(400, str(e))
    if "can_manage_models" in data:
        manage = data.get("can_manage_models")
        if manage is not None and not isinstance(manage, bool):
            raise HTTPException(400, "can_manage_models doit être null, true ou false")
    return {"engine_keys": keys, "can_manage_models": manage}


def _user_llm_access_view(target_id: int) -> dict:
    from shared_infra.llm import engine_access as _ea
    from shared_infra.accounts.groups import get_user_groups
    target = get_user_by_id(target_id)
    own = _ea.get_policy("user", target_id)
    groups = [_ea.get_policy("group", int(g["id"])) for g in get_user_groups(target_id)]
    res = _ea.resolve_access(own, groups, is_admin=bool(target and target["is_admin"] == 1))
    eff = res["engine_keys"]
    return {"engine_keys": own["engine_keys"],
            "can_manage_models": own["can_manage_models"],
            "effective_engine_keys": None if eff is None else sorted(eff),
            "engine_source": res["engine_source"],
            "effective_can_manage_models": res["can_manage_models"],
            "manage_source": res["manage_source"]}


@admin_router.get("/api/admin/llm/engine-options")
def api_admin_llm_engine_options(request: Request):
    """Serveurs proposables dans une liste d'accès : intégré + partagés."""
    _require_admin(request)
    from shared_infra.llm import engine_access as _ea
    return {"engines": _ea.list_engine_options()}


@admin_router.get("/api/admin/users/{target_id}/llm-access")
def api_admin_get_user_llm_access(target_id: int, request: Request):
    _require_admin(request)
    if not get_user_by_id(target_id):
        raise HTTPException(404, "Utilisateur introuvable")
    return _user_llm_access_view(target_id)


@admin_router.put("/api/admin/users/{target_id}/llm-access")
async def api_admin_set_user_llm_access(target_id: int, request: Request):
    _require_admin(request)
    target = get_user_by_id(target_id)
    if not target:
        raise HTTPException(404, "Utilisateur introuvable")
    from shared_infra.llm import engine_access as _ea
    new = await _read_llm_access_body(request, _ea.get_policy("user", target_id))
    await asyncio.to_thread(_ea.set_policy, "user", target_id,
                            engine_keys=new["engine_keys"],
                            can_manage_models=new["can_manage_models"])
    audit_event(
        user_id=getattr(request.state, "user_id", None),
        username=getattr(request.state, "username", None),
        action="admin.user.llm_access",
        details={"target_user_id": target_id, "target_username": target["username"],
                 "engine_keys": new["engine_keys"],
                 "can_manage_models": new["can_manage_models"]},
    )
    return {"ok": True, **_user_llm_access_view(target_id)}


@admin_router.post("/api/admin/users/{target_id}/sandbox-quota")
async def api_admin_set_sandbox_quota(target_id: int, request: Request):
    """Set a per-user sandbox quota (Mo). Pass quota_mb=-1 to reset to global default."""
    _require_admin(request)
    data = await request.json()
    quota_mb = data.get("quota_mb")
    if quota_mb is None:
        raise HTTPException(400, "quota_mb required")
    try:
        quota_mb = int(quota_mb)
    except (TypeError, ValueError):
        # AUDIT 2026-08-02 (E12) — ``int("5 Go")`` levait un 500 opaque au
        # lieu du 400 que la validation ci-dessous était censée produire.
        raise HTTPException(400, "quota_mb doit être un entier (Mo)")
    if quota_mb != -1 and quota_mb < 0:
        raise HTTPException(400, "quota_mb must be >= 0 or -1 to reset")
    # AUDIT 2026-08-02 (E5) — écriture ATOMIQUE (l'ancien RMW perdait sous un
    # ``PUT /api/settings`` concurrent du user lui-même).
    def _set_quota(s):
        if quota_mb == -1:
            s.pop("sandbox_quota_mb", None)
        else:
            s["sandbox_quota_mb"] = quota_mb
    await asyncio.to_thread(merge_user_settings, target_id, _set_quota)   # (passe 5, B5)
    return {"ok": True, "quota_mb": quota_mb}


@admin_router.post("/api/admin/users/{target_id}/network-profile")
async def api_admin_set_network_profile(target_id: int, request: Request):
    """Impose (ou libère) le profil réseau sandbox d'un utilisateur.

    Body : ``{"profile_id": "<id>"}`` pour imposer, ``{"profile_id": null}``
    (ou ``""``) pour rendre le choix à l'utilisateur.

    L'imposition est écrite dans ``forced_network_profile_id`` : elle prime
    sur ``network_profile_id`` partout (cf. ``resolve_network_profile_id``) et
    ``POST /api/sandbox/me`` refuse tout autre profil — le grisage du
    sélecteur côté navigateur n'est que la partie visible.

    On aligne aussi ``network_profile_id`` sur la valeur imposée : à la levée
    de l'imposition, l'utilisateur repart du profil qu'il avait subi plutôt
    que d'un ancien choix silencieusement réactivé.
    """
    _require_admin(request)
    data = await request.json()
    raw = data.get("profile_id") if isinstance(data, dict) else None
    profile_id = str(raw or "").strip()

    from shared_infra.sandbox.executors import (
        load_admin_config, resolve_network_profile_id, reset_user_sandbox_cache,
    )
    cfg = load_admin_config()
    known = [p.id for p in (cfg.network_profiles or [])]
    if profile_id and profile_id not in known:
        raise HTTPException(400, f"Profil réseau {profile_id!r} introuvable. Disponibles : {known}")

    target_username = get_username_by_id(target_id)
    if not target_username:
        raise HTTPException(404, f"User {target_id} introuvable")

    before = resolve_network_profile_id(get_user_settings(target_id) or {})

    # Écriture ATOMIQUE (même raison que le quota : un PUT /api/settings
    # concurrent de l'utilisateur ne doit pas écraser la décision admin).
    def _set_profile(s):
        if profile_id:
            s["forced_network_profile_id"] = profile_id
            s["network_profile_id"] = profile_id
        else:
            s.pop("forced_network_profile_id", None)
    await asyncio.to_thread(merge_user_settings, target_id, _set_profile)   # (passe 5, B5)

    after = resolve_network_profile_id(get_user_settings(target_id) or {})

    # Le conteneur en marche tourne encore sous les anciennes règles iptables.
    # ``_reconcile_config`` le recréerait au prochain exec (label elpis.netcfg
    # périmé) ; on n'attend pas : une restriction imposée doit mordre tout de
    # suite. Best-effort — un échec laisse la recréation paresseuse faire.
    recreated = False
    if after != before:
        try:
            from shared_infra.sandbox.executors import get_user_sandbox
            from shared_infra.routes._helpers import _get_work_path
            sb = get_user_sandbox(target_id, target_username,
                                  _get_work_path(target_id),
                                  network_profile_id=before)
            await sb.destroy()
            reset_user_sandbox_cache()
            recreated = True
        except Exception as e:                                  # noqa: BLE001
            logger.warning("[admin] destruction container user_id=%s après "
                           "changement de profil réseau : %s", target_id, e)

    audit_event(
        user_id=getattr(request.state, "user_id", None),
        username=getattr(request.state, "username", None),
        action="admin.user.network_profile",
        details={"target_user_id": target_id, "target_username": target_username,
                 "forced": profile_id or None, "effective": after,
                 "container_destroyed": recreated},
    )
    return {"ok": True, "forced_network_profile_id": profile_id,
            "network_profile_id": after, "container_destroyed": recreated}
