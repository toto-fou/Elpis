# SPDX-License-Identifier: MIT
"""
backend/routes/user_sandbox.py — Endpoints user pour la sandbox.

Workflow lifecycle
------------------
1. User clique "Conteneur Docker" dans ses préférences
   → POST /api/sandbox/me {"mode": "docker"}
2. Si l'image n'est pas chargée sur le daemon, on lance ``docker load``
   en arrière-plan et on retourne immédiatement avec ``image_status: loading``.
3. Le widget poll ``GET /api/sandbox/me`` toutes les 1-2s.
4. Quand ``image_status: loaded``, le container est créé automatiquement.
5. Quand ``container.running: true``, l'UI passe en "prêt".
"""
from __future__ import annotations

import asyncio
import time
import logging
from pathlib import Path
from typing import Any, Dict

from fastapi import HTTPException, Request

from shared_infra.security.audit import audit_event
from shared_infra.config import SANDBOX_DIR
# ``update_user_settings`` : point d'injection de test (cf. routes/settings.py).
from shared_infra.accounts.users import (
    get_user_settings,
    get_username_by_id,
    merge_user_settings,
)
from shared_infra.security.deps import require_user_id
from shared_infra.routes._state import router

from shared_infra.sandbox.executors import (
    ImageLoadStatus, ensure_image_loaded, get_image_load_state, get_user_sandbox, load_admin_config,
    resolve_network_profile_id,
)

logger = logging.getLogger("uvicorn.error")


def _user_sandbox_dir(username: str) -> Path:
    """Racine de TRAVAIL (``P/work``) montée sur ``/work`` pour ce user.

    ``P = <SANDBOX_DIR>/<safe_user>`` n'est PLUS montée telle quelle : seul
    ``P/work`` l'est (``skills``/``.memory`` restent à ``P``, hors conteneur).
    Sanitization via ``safe_sandbox_name`` (source unique) — l'ancien filtre
    inline divergeait sur les noms unicode → racine ``work`` différente des
    outils fs/shell. La migration une-fois est déclenchée par
    ``ensure_work_subdir``.
    """
    from shared_infra.config import safe_sandbox_name
    from shared_infra.sandbox import ensure_work_subdir
    return ensure_work_subdir((Path(SANDBOX_DIR) / safe_sandbox_name(username)).resolve())


def _user_sandbox_for(user_id: int, username: str):
    """Helper : UserSandbox configuré avec le profil EFFECTIF de l'user
    (imposition admin > choix user — cf. ``resolve_network_profile_id``)."""
    settings = get_user_settings(user_id) or {}
    return get_user_sandbox(
        user_id, username, _user_sandbox_dir(username),
        network_profile_id=resolve_network_profile_id(settings),
    )


async def _force_cleanup_user_containers(user_id: int) -> int:
    """Nettoyage forcé des containers ARRÊTÉS étiquetés
    elpis.user_id=<user_id> (état dégradé après un crash au démarrage).
    Retourne le nombre de containers supprimés.

    Passe sandbox 2026-09-26 — ne supprime JAMAIS un container en marche :
    avant, tout échec de ``ensure_running`` (dont un simple dépassement de
    délai pendant une première création lente) faisait ``rm -fv`` sur TOUS
    les containers du compte — y compris celui qu'un autre onglet venait de
    démarrer et utilisait, volumes compris."""
    from shared_infra.sandbox import naming as _naming
    proc = await asyncio.create_subprocess_exec(
        "docker", "ps", "-a", *_naming.label_filter("user_id", user_id),
        "--filter", "status=exited", "--filter", "status=dead",
        "--filter", "status=created",
        "--format", "{{.ID}}",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
    container_ids = [cid for cid in out.decode().strip().split("\n") if cid]
    if not container_ids:
        return 0
    logger.info("[sandbox] cleanup forcé user_id=%d : %d container(s) à détruire",
                user_id, len(container_ids))
    rm_proc = await asyncio.create_subprocess_exec(
        "docker", "rm", "-fv", *container_ids,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    await asyncio.wait_for(rm_proc.communicate(), timeout=15)
    # Oubli du cache de CE compte seulement (cf. reset_user_sandbox_cache).
    from shared_infra.sandbox.executors import reset_user_sandbox_cache
    reset_user_sandbox_cache(user_id)
    return len(container_ids)


def _image_status_dict() -> Dict[str, Any]:
    """Retourne l'état actuel du chargement d'image (sans blocage)."""
    state = get_image_load_state()
    return state.to_dict()


# Passe sandbox 2026-09-26 — ``GET /me`` est SONDÉ par chaque onglet ouvert
# (panneau sandbox, éditeur) : chaque appel lançait ``docker version`` et
# ``docker stats --no-stream`` (ce dernier attend deux échantillons : 1 à 2 s
# de réponse), et faisait ses lectures SQLite sur la boucle. Caches courts
# par process : l'état du démon et les statistiques n'ont pas besoin d'une
# fraîcheur à la seconde.
_DAEMON_OK_TTL_S = 30.0
_DAEMON_KO_TTL_S = 5.0
_STATS_TTL_S = 8.0
_daemon_cache: Dict[str, Any] = {}
_stats_cache: Dict[int, tuple] = {}


async def _daemon_reachable_cached(sb) -> tuple:
    now = time.monotonic()
    hit = _daemon_cache.get("v")
    if hit and now < hit[0]:
        return hit[1], hit[2]
    try:
        ok, info = await sb.daemon_reachable()
    except Exception as e:                                      # noqa: BLE001
        ok, info = False, str(e)
    _daemon_cache["v"] = (now + (_DAEMON_OK_TTL_S if ok else _DAEMON_KO_TTL_S), ok, info)
    return ok, info


async def _stats_cached(user_id: int, sb):
    now = time.monotonic()
    hit = _stats_cache.get(user_id)
    if hit and now < hit[0]:
        return hit[1]
    val = await sb.stats()
    _stats_cache[user_id] = (now + _STATS_TTL_S, val)
    return val


def _me_context(user_id: int):
    """Lectures synchrones de GET /me (SQLite, config) — en thread."""
    username = get_username_by_id(user_id) or f"user_{user_id}"
    settings = get_user_settings(user_id) or {}
    cfg = load_admin_config()
    sb = _user_sandbox_for(user_id, username)
    return username, settings, cfg, sb


@router.get("/api/sandbox/me")
async def sandbox_me_get(request: Request) -> Dict[str, Any]:
    """Mode actuel + statut container + statut image."""
    user_id = require_user_id(request)
    username, settings, cfg, sb = await asyncio.to_thread(_me_context, user_id)
    # Le mode est toujours 'docker' désormais (mode 'folder' retiré). Si la
    # DB contient encore 'folder' (legacy), on l'expose comme docker côté API.
    user_mode = "docker"
    # Profil EFFECTIF : l'imposition admin (``forced_network_profile_id``)
    # prime sur le choix de l'utilisateur, et le sélecteur est verrouillé.
    forced_profile_id = str(settings.get("forced_network_profile_id") or "").strip()
    user_profile_id = resolve_network_profile_id(settings)
    effective_mode = "docker"

    # Liste des profils dispos pour l'user (= tous les profils admin)
    available_profiles = [p.to_dict() for p in (cfg.network_profiles or [])]
    # Vérifier que le profil choisi existe encore (sinon fallback sur isolated)
    if not any(p["id"] == user_profile_id for p in available_profiles):
        user_profile_id = "isolated" if any(p["id"] == "isolated" for p in available_profiles) else (
            available_profiles[0]["id"] if available_profiles else "isolated"
        )
        # Le profil imposé a été supprimé côté admin : l'imposition tombe avec
        # lui, sinon l'utilisateur reste bloqué sur un choix inexistant.
        forced_profile_id = ""

    out: Dict[str, Any] = {
        "user_mode": user_mode,
        "effective_mode": effective_mode,
        "force_admin": cfg.force_user_docker,
        "image": cfg.image,
        "limits": {
            "memory_mb": cfg.memory_mb,
            "cpu_quota_pct": cfg.cpu_quota_pct,
            "pids_max": cfg.pids_max,
            "timeout_s": cfg.timeout_s,
        },
        "idle_kill_hours": cfg.idle_kill_hours,
        "image_status": _image_status_dict(),
        "network_profile_id": user_profile_id,
        "network_profiles": available_profiles,
        # Imposé par l'admin → l'UI grise le sélecteur et le POST refuse.
        "network_profile_locked": bool(forced_profile_id),
    }

    if effective_mode == "docker":
        daemon_ok, daemon_info = await _daemon_reachable_cached(sb)
        out["daemon_ok"] = daemon_ok
        out["daemon_info"] = daemon_info

        if not daemon_ok:
            out["container"] = {"error": "daemon injoignable"}
            return out

        # Si l'image charge encore, on n'essaie pas de créer le container
        # (mais on retourne le state pour que le polling continue)
        img_state = get_image_load_state()
        # (2026-09-20) L'état est PAR WORKER : celui qui n'a pas reçu le POST
        # de démarrage restait « non vérifié » et ne créait jamais le
        # conteneur — le sondage tombait sur lui une fois sur N. Un GET
        # déclenche donc le chargement (non bloquant, idempotent).
        if img_state.status == ImageLoadStatus.NOT_CHECKED:
            try:
                img_state = await ensure_image_loaded(cfg.image, blocking=False)
            except Exception as e:
                logger.warning("[sandbox] chargement d'image depuis GET /me : %s", e)
        if img_state.status == ImageLoadStatus.LOADING:
            out["container"] = {
                "exists": False, "running": False,
                "container_name": sb.container_name,
                "pending": "image_loading",
            }
            return out

        # Si l'image est chargée mais le container n'existe pas, on le crée
        # automatiquement (ensure_running gère création + démarrage)
        if img_state.status == ImageLoadStatus.LOADED:
            try:
                # ensure_running peut prendre 1-2s la 1ère fois, c'est rapide
                # comparé au docker load donc on bloque ici sans souci
                st = await asyncio.wait_for(sb.ensure_running(), timeout=30)
                out["container"] = {
                    "exists": st.exists,
                    "running": st.running,
                    "container_id": st.container_id[:12] if st.container_id else None,
                    "container_name": st.container_name,
                    "image": st.image,
                    "started_at": st.started_at,
                }
                if st.running:
                    out["stats"] = await _stats_cached(user_id, sb)
            except asyncio.TimeoutError:
                out["container"] = {
                    "exists": False, "running": False,
                    "container_name": sb.container_name,
                    "pending": "container_starting",
                }
            except Exception as e:
                out["container"] = {"error": str(e)}
        else:
            # Image pas chargée : on retourne juste le state
            try:
                st = await sb.status()
                out["container"] = {
                    "exists": st.exists,
                    "running": st.running,
                    "container_name": st.container_name,
                }
            except Exception:
                out["container"] = {"running": False}
    else:
        out["container"] = None

    return out


@router.post("/api/sandbox/me")
async def sandbox_me_post(request: Request) -> Dict[str, Any]:
    """Change le mode sandbox.
    Body: {"mode": "folder" | "docker", "network_profile_id": "..." (optionnel)}
    """
    user_id = require_user_id(request)
    _forget_preview_ip(user_id)
    body = await request.json()
    mode = (body or {}).get("mode")
    profile_id = (body or {}).get("network_profile_id")

    # ── Le mode 'folder' a été retiré de l'UI. On accepte folder/docker
    # en entrée pour rétrocompat des clients (anciennes versions de l'UI),
    # mais on force toujours docker côté serveur. Le 'folder' n'est plus
    # un mode d'exécution — c'est juste le bind mount des fichiers.
    if mode is None:
        mode = "docker"
    if mode not in ("folder", "docker"):
        raise HTTPException(400, f"mode doit être 'docker' (reçu {mode!r})")
    if mode == "folder":
        logger.info("[sandbox] mode 'folder' demandé par client legacy → forcé à 'docker'")
        mode = "docker"

    cfg = load_admin_config()

    # État actuel pour calculer les transitions
    settings_old = get_user_settings(user_id) or {}
    old_mode = settings_old.get("sandbox_mode", "docker")
    old_profile = resolve_network_profile_id(settings_old)
    forced_profile = str(settings_old.get("forced_network_profile_id") or "").strip()
    # L'imposition ne vaut que tant que le profil existe encore côté admin.
    if forced_profile and not any(p.id == forced_profile for p in (cfg.network_profiles or [])):
        forced_profile = ""

    # Validation du profile_id (on est toujours en docker maintenant)
    if profile_id is None:
        profile_id = old_profile
    # Profil imposé par l'admin : le serveur est l'autorité. Un client qui
    # envoie autre chose (UI périmée, appel direct) est refusé — sinon
    # l'imposition ne serait qu'un grisage cosmétique côté navigateur.
    if forced_profile and profile_id != forced_profile:
        raise HTTPException(
            403, "Votre profil réseau est imposé par l'administrateur "
                 f"({forced_profile!r}) et ne peut pas être changé ici."
        )
    if not any(p.id == profile_id for p in (cfg.network_profiles or [])):
        raise HTTPException(
            400, f"Profil réseau {profile_id!r} introuvable. "
            f"Disponibles : {[p.id for p in cfg.network_profiles or []]}"
        )

    # ─── LOG TRANSITION ───────────────────────────────────────────
    transitions = []
    if old_mode != mode:
        transitions.append(f"mode: {old_mode} → {mode}")
    if old_profile != profile_id:
        transitions.append(f"profil: {old_profile} → {profile_id}")
    if transitions:
        logger.info("[sandbox] user_id=%d (%s) — %s",
                    user_id, get_username_by_id(user_id) or "?", ", ".join(transitions))
    else:
        logger.info("[sandbox] user_id=%d : aucun changement (mode=%s profil=%s)",
                    user_id, mode, profile_id)

    # Sauver les settings — AUDIT 2026-08-02 (E5) : écriture ATOMIQUE. L'ancien
    # RMW (``dict(settings_old)`` lu hors transaction puis ``update``) perdait
    # sous un ``PUT /api/settings`` concurrent (l'autre écrivain réécrivait le
    # dict entier depuis SON ``current`` périmé). ``merge_user_settings`` relit
    # sous ``BEGIN IMMEDIATE`` et n'écrit QUE ces deux clés.
    def _set_sandbox(s):
        s["sandbox_mode"] = mode
        if profile_id:
            s["network_profile_id"] = profile_id
    await asyncio.to_thread(merge_user_settings, user_id, _set_sandbox)   # (passe 5, B5)

    username = get_username_by_id(user_id) or f"user_{user_id}"
    audit_event(
        user_id=user_id, username=username,
        action="user.sandbox.mode",
        details={"mode": mode, "network_profile_id": profile_id},
    )

    bootstrap: Dict[str, Any] = {}
    # Le mode est toujours 'docker' désormais — on enchaîne le bootstrap.
    if True:
        # Si changement de profil ET container existant → détruire (sera recréé)
        profile_changed = (old_mode == "docker" and old_profile != profile_id)
        if profile_changed:
            logger.info("[sandbox] profil changé : destruction du container existant pour recréation")
            try:
                sb_old = _user_sandbox_for(user_id, username)
                # Force le profil ancien sur l'instance pour cleanup correct des iptables
                sb_old.network_profile_id = old_profile
                await sb_old.destroy()
                logger.info("[sandbox] container détruit : elpis-sb-%s (raison: changement profil %s → %s)",
                            username, old_profile, profile_id)
            except Exception as e:
                logger.warning("[sandbox] échec destruction ancien container : %s", e)
            from shared_infra.sandbox.executors import reset_user_sandbox_cache
            reset_user_sandbox_cache(user_id)

        # Charger l'image et démarrer
        img_state = await ensure_image_loaded(cfg.image, blocking=False)
        bootstrap["image_status"] = img_state.to_dict()

        if img_state.status == ImageLoadStatus.LOADED:
            try:
                sb = _user_sandbox_for(user_id, username)
                logger.info("[sandbox] démarrage container avec profil=%s (mode=%s)",
                            profile_id, sb.network_profile.mode)
                st = await asyncio.wait_for(sb.ensure_running(), timeout=60)
                bootstrap["container"] = {
                    "running": st.running,
                    "container_name": st.container_name,
                    "profile_id": profile_id,
                }
            except Exception as e:
                bootstrap["container"] = {"error": str(e)}
                logger.warning("[sandbox] bootstrap échec user_id=%d: %s", user_id, e)

                # 1) Si l'exception transporte les logs (ExecError de _create
                #    quand entrypoint crash), on les utilise directement.
                container_logs = getattr(e, "container_logs", None)

                # 2) Sinon, fallback : tenter docker logs (peut fail si le
                #    container a été supprimé entre-temps).
                if not container_logs:
                    try:
                        # Nom canonisé via la source unique — un username
                        # legacy non canonique ciblait sinon un conteneur
                        # inexistant et les logs du crash étaient perdus.
                        from shared_infra.config import safe_sandbox_name
                        from shared_infra.sandbox.naming import container_name as _cname
                        container_name = _cname(safe_sandbox_name(username))
                        log_proc = await asyncio.create_subprocess_exec(
                            "docker", "logs", "--tail", "30", container_name,
                            stdout=asyncio.subprocess.PIPE,
                            stderr=asyncio.subprocess.PIPE,
                        )
                        out, err = await asyncio.wait_for(log_proc.communicate(), timeout=5)
                        log_text = (out + err).decode("utf-8", errors="replace").strip()
                        # Filtre les "No such container" qui sont du bruit
                        if log_text and "No such container" not in log_text:
                            container_logs = log_text[-2000:]
                    except Exception as log_e:
                        logger.warning("[sandbox] impossible de récupérer logs : %s", log_e)

                if container_logs:
                    bootstrap["container"]["logs"] = container_logs
                    logger.warning(
                        "[sandbox] container logs (last) :\n%s",
                        container_logs[-1000:],
                    )

                # Cleanup forcé : on ne laisse PAS de container zombie après
                # un crash. La prochaine tentative repartira sur du clean.
                # Jamais sur un simple DÉPASSEMENT DE DÉLAI : la création
                # (chargement, ``docker run``, ``chmod -R``) peut être encore
                # en cours et réussir — le poll suivant la verra.
                try:
                    n = 0
                    if not isinstance(e, asyncio.TimeoutError):
                        n = await _force_cleanup_user_containers(user_id)
                    if n:
                        logger.info("[sandbox] %d container(s) zombie(s) nettoyé(s)", n)
                except Exception as cleanup_e:
                    logger.warning("[sandbox] cleanup zombie échec : %s", cleanup_e)

    return {"ok": True, "mode": mode, "network_profile_id": profile_id, "bootstrap": bootstrap}


@router.post("/api/sandbox/me/restart")
async def sandbox_me_restart(request: Request) -> Dict[str, Any]:
    """Redémarre le container (utile si état corrompu, OOM, etc.).
    Tolérant : si le container existe (ou si l'user a un profile_id),
    on tente le restart même si le mode est "folder" en DB
    (l'UI et la DB peuvent être désynchros temporairement)."""
    user_id = require_user_id(request)
    _forget_preview_ip(user_id)
    username = get_username_by_id(user_id) or f"user_{user_id}"

    cfg = load_admin_config()
    mode = "docker"  # mode 'folder' retiré, toujours docker maintenant

    # On vérifie d'abord si un container existe pour ce user
    sb = _user_sandbox_for(user_id, username)
    status = await sb.status()

    if not status.exists:
        raise HTTPException(
            400,
            "Pas de container à redémarrer. "
            "Démarre-le d'abord dans tes paramètres."
        )

    # Si mode=folder mais container existe, on log + restart quand même
    if mode != "docker" and status.exists:
        logger.warning(
            "[sandbox] restart demandé en mode=folder mais container %s existe — restart quand même",
            sb.container_name,
        )

    # S'assurer que l'image est chargée
    img_state = await ensure_image_loaded(cfg.image, blocking=True)
    if img_state.status != ImageLoadStatus.LOADED:
        raise HTTPException(503, f"Image indisponible : {img_state.error or img_state.progress_msg}")

    logger.info("[sandbox] restart demandé : %s (profil=%s)",
                sb.container_name, sb.network_profile_id or "isolated")
    try:
        st = await sb.restart()
        logger.info("[sandbox] restart OK : %s running=%s", st.container_name, st.running)
    except Exception as e:
        logger.error("[sandbox] restart échec : %s", e)
        raise HTTPException(502, f"Échec restart : {e}")

    audit_event(
        user_id=user_id, username=username,
        action="user.sandbox.restart",
        details={"container": st.container_name},
    )
    return {
        "ok": True,
        "container": {
            "running": st.running,
            "container_name": st.container_name,
            "container_id": st.container_id[:12] if st.container_id else None,
        },
    }


@router.delete("/api/sandbox/me")
async def sandbox_me_destroy(request: Request) -> Dict[str, Any]:
    """Détruit le container (libère RAM). Le folder n'est PAS touché."""
    user_id = require_user_id(request)
    _forget_preview_ip(user_id)
    username = get_username_by_id(user_id) or f"user_{user_id}"

    sb = _user_sandbox_for(user_id, username)
    try:
        await sb.destroy()
    except Exception as e:
        raise HTTPException(502, f"Échec destroy : {e}")

    audit_event(
        user_id=user_id, username=username,
        action="user.sandbox.destroy",
        details={"container": sb.container_name},
    )
    return {"ok": True}


# (2026-09-20) L'aperçu proxifie CHAQUE asset d'une page : avant, chacun
# refaisait un ``get_user_settings`` SQLite synchrone SUR la boucle puis un
# ``docker container inspect``. Les réglages passent en thread et l'IP du
# conteneur est mémorisée quelques secondes par utilisateur (oubliée dès
# qu'un amont ne répond plus : le conteneur a pu redémarrer).
#
# (2026-09-21) L'entrée n'est servie que si le conteneur n'a connu AUCUN
# événement depuis (signal ``docker events`` inchangé) : un redémarrage dans
# la fenêtre pouvait sinon laisser l'IP à un autre compte, et l'aperçu
# proxifiait son conteneur. Flux d'événements indisponible → pas de cache.
_PREVIEW_IP_TTL_S = 5.0
_PREVIEW_IP_MAX = 1024
_PREVIEW_IP_CACHE: Dict[int, tuple] = {}     # user_id → (ip, expire_at, conteneur, signal)


def _forget_preview_ip(user_id: int) -> None:
    _PREVIEW_IP_CACHE.pop(user_id, None)


async def _preview_container_ip(user_id: int, username: str):
    from shared_infra.sandbox.executors._readiness import get_readiness_cache
    rc = get_readiness_cache()
    now = time.monotonic()
    hit = _PREVIEW_IP_CACHE.get(user_id)
    if hit and hit[1] > now:
        stamp = rc.state_stamp(hit[2])
        if stamp is not None and stamp == hit[3] and stamp[0]:
            return hit[0]
    _PREVIEW_IP_CACHE.pop(user_id, None)
    sb = await asyncio.to_thread(_user_sandbox_for, user_id, username)
    ip = await sb.container_ip()
    stamp = rc.state_stamp(sb.container_name)
    if ip and stamp is not None and stamp[0]:
        if len(_PREVIEW_IP_CACHE) >= _PREVIEW_IP_MAX:
            for k in [k for k, v in _PREVIEW_IP_CACHE.items() if v[1] <= now]:
                _PREVIEW_IP_CACHE.pop(k, None)
            if len(_PREVIEW_IP_CACHE) >= _PREVIEW_IP_MAX:
                _PREVIEW_IP_CACHE.clear()
        _PREVIEW_IP_CACHE[user_id] = (ip, now + _PREVIEW_IP_TTL_S, sb.container_name, stamp)
    return ip


# ═══════════════════════════════════════════════════════════════════
#  APERÇU LOCALHOST — proxy vers un serveur qui tourne DANS la sandbox
# ═══════════════════════════════════════════════════════════════════
# L'onglet Web de l'éditeur peut viser « le vrai état » d'un serveur lancé
# par l'assistant dans le conteneur (ex. `python -m http.server 8080` en
# background). Le navigateur ne peut PAS joindre l'IP du conteneur
# (172.17.x.x = mixed content sous HTTPS + hors de portée du poste client) :
# ce proxy same-origin est donc obligatoire, pas optionnel.
#
# Sécurité :
# - auth session (require_user_id) + conteneur DU user uniquement ;
# - les en-têtes Cookie/Authorization ne sont JAMAIS transmis au serveur
#   de la sandbox (le contenu du conteneur est non-fiable) ;
# - `Content-Security-Policy: sandbox` sur la réponse → le document proxifié
#   s'exécute en ORIGINE OPAQUE : pas d'accès au cookie de session ni aux
#   API de l'app malgré l'URL same-origin ;
# - les en-têtes de réponse qui agissent au niveau RÉSEAU (donc sur l'origine
#   réelle de l'app, que le CSP sandbox ne couvre PAS) sont filtrés en sortie —
#   cf. `_PREVIEW_DROP_RESP_HEADERS`. Sans ce filtre, un `Set-Cookie` émis par
#   le serveur de la sandbox écrasait le cookie de session de l'utilisateur.
#
# Limites v1 assumées : pas de WebSocket (HMR de dev-servers) ; les pages qui
# référencent des chemins ABSOLUS (/static/…) cassent — les chemins relatifs
# et les redirections (Location réécrite) fonctionnent.

_PREVIEW_HOP_BY_HOP = frozenset({
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "content-length",
})
# En-têtes de RÉPONSE jamais relayés : ils agissent au niveau réseau, sur
# l'ORIGINE RÉELLE de l'app, hors de portée du `CSP: sandbox` posé plus bas
# (celui-ci ne rend opaque que l'origine du DOCUMENT). Le contenu du conteneur
# étant non fiable, un serveur de la sandbox pouvait sinon répondre
# ``Set-Cookie: session=…; Path=/`` et écraser le cookie de session de
# l'utilisateur sur l'app elle-même (fixation de session), ou vider son
# stockage via ``Clear-Site-Data``, sur un simple <img> proxifié.
_PREVIEW_DROP_RESP_HEADERS = frozenset({
    "set-cookie", "set-cookie2", "clear-site-data",
    "strict-transport-security", "public-key-pins",
    "content-security-policy", "content-security-policy-report-only",
    "report-to", "reporting-endpoints",
    "access-control-allow-origin", "access-control-allow-credentials",
    "service-worker-allowed",
})
_PREVIEW_FWD_REQ_HEADERS = ("accept", "accept-language", "content-type",
                            "range", "if-none-match", "if-modified-since")
_PREVIEW_BODY_MAX = 10 * 1024 * 1024   # 10 Mo — l'aperçu n'est pas un canal d'upload
# Transport httpx injectable par les tests (httpx.MockTransport).
_PREVIEW_TRANSPORT = None


def _preview_error_html(status: int, title: str, detail: str):
    from fastapi.responses import HTMLResponse
    body = (
        "<!doctype html><meta charset='utf-8'>"
        "<body style=\"margin:0;display:flex;align-items:center;justify-content:center;"
        "min-height:100vh;background:#f8fafc;color:#334155;"
        "font:14px/1.6 system-ui,sans-serif\">"
        "<div style='max-width:420px;padding:24px;text-align:center'>"
        f"<div style='font-weight:600;margin-bottom:6px'>{title}</div>"
        f"<div style='font-size:12.5px;color:#64748b'>{detail}</div>"
        "</div></body>"
    )
    return HTMLResponse(body, status_code=status,
                        headers={"Cache-Control": "no-store"})


@router.api_route("/api/sandbox/preview/{port}/{path:path}",
                  methods=["GET", "HEAD", "POST"])
async def sandbox_preview_proxy(request: Request, port: int, path: str = ""):
    """Proxy d'aperçu, identité par la session (ouverture directe)."""
    return await _preview_proxy(request, require_user_id(request), port, path,
                                f"/api/sandbox/preview/{port}")


@router.api_route("/api/sandbox/pvs/{token}/{port}/{path:path}",
                  methods=["GET", "HEAD", "POST", "OPTIONS"])
async def sandbox_preview_proxy_token(request: Request, token: str, port: int, path: str = ""):
    """Proxy d'aperçu de l'iframe : le document proxifié a une origine opaque
    et n'envoie pas le cookie à ses sous-ressources — l'identité voyage dans
    le jeton du chemin (cf. ``preview_token``, audit 2026-09-22 H1)."""
    from shared_infra.sandbox.preview_token import check_preview_token
    uid = check_preview_token(token)
    if uid is None:
        raise HTTPException(403, "Aperçu expiré : rechargez-le")
    # Le document proxifié est à origine opaque : ses appels à SON serveur
    # (relatifs) sont cross-origin — préflight et CORS répondus ici, le jeton
    # du chemin étant la seule capacité (jamais de cookie relayé).
    if request.method == "OPTIONS":
        from fastapi.responses import Response
        return Response(status_code=204, headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, POST",
            "Access-Control-Allow-Headers": request.headers.get(
                "access-control-request-headers", "content-type")[:500],
            "Access-Control-Max-Age": "600"})
    resp = await _preview_proxy(request, uid, port, path, f"/api/sandbox/pvs/{token}/{port}")
    resp.headers["Access-Control-Allow-Origin"] = "*"
    return resp


async def _preview_proxy(request: Request, user_id: int, port: int, path: str, prefix: str):
    import httpx
    from fastapi.responses import StreamingResponse

    if not (1 <= port <= 65535):
        raise HTTPException(400, "Port invalide")
    username = get_username_by_id(user_id) or f"user_{user_id}"

    ip = await _preview_container_ip(user_id, username)
    if not ip:
        return _preview_error_html(
            409, "Sandbox injoignable",
            "Le conteneur n'est pas démarré, ou son profil réseau est "
            "« Isolé » (aucune adresse IP). Choisissez un profil réseau "
            "connecté dans Paramètres → Sandbox, puis relancez le serveur.")

    upstream_base = f"http://{ip}:{port}"
    url = f"{upstream_base}/{path}"
    if request.url.query:
        url += f"?{request.url.query}"

    # En-têtes transmis : liste blanche courte — jamais Cookie/Authorization.
    fwd_headers = {
        k: v for k, v in (
            (h, request.headers.get(h)) for h in _PREVIEW_FWD_REQ_HEADERS
        ) if v
    }
    body = b""
    if request.method == "POST":
        body = await request.body()
        if len(body) > _PREVIEW_BODY_MAX:
            raise HTTPException(413, "Corps de requête trop volumineux")

    # AUDIT moteur d'événements 2026-09-25 (B11) — pas de délai de LECTURE
    # sur le corps : le ``Timeout(30.0)`` s'appliquait à chaque lecture de
    # ``aiter_raw`` et coupait tout flux silencieux 30 s (SSE d'un serveur de
    # dev, HMR webpack) → reconnexion en boucle côté page. On borne à 30 s
    # l'ARRIVÉE DES EN-TÊTES (wait_for ci-dessous) ; ensuite le flux vit tant
    # que le navigateur reste là (la déconnexion annule le générateur).
    client = httpx.AsyncClient(
        transport=_PREVIEW_TRANSPORT,
        timeout=httpx.Timeout(30.0, connect=3.0, read=None),
        follow_redirects=False,
    )
    try:
        upstream = await asyncio.wait_for(client.send(
            client.build_request(request.method, url,
                                 headers=fwd_headers, content=body),
            stream=True,
        ), timeout=30.0)
    except (httpx.RequestError, asyncio.TimeoutError):
        await client.aclose()
        # Le conteneur a pu redémarrer avec une autre adresse : on oublie
        # l'IP mémorisée pour que l'essai suivant la redemande à Docker.
        _PREVIEW_IP_CACHE.pop(user_id, None)
        return _preview_error_html(
            502, f"Aucun serveur sur le port {port}",
            "Rien ne répond à cette adresse dans la sandbox. Démarrez un "
            "serveur (ex. python3 -m http.server) sur ce port, ou vérifiez "
            "le numéro.")
    except Exception:
        # (2026-09-20) ``build_request`` peut lever hors ``RequestError``
        # (``httpx.InvalidURL`` sur un chemin exotique) : le client fuyait.
        await client.aclose()
        raise

    resp_headers: Dict[str, str] = {}
    for k, v in upstream.headers.items():
        if k.lower() in _PREVIEW_HOP_BY_HOP:
            continue
        if k.lower() in _PREVIEW_DROP_RESP_HEADERS:
            continue
        if k.lower() == "location":
            # Redirections : ramène l'absolu upstream et l'absolu-chemin
            # sous le préfixe du proxy, sinon le navigateur sort de l'aperçu.
            if v.startswith(upstream_base):
                v = prefix + v[len(upstream_base):]
            elif v.startswith("/"):
                v = f"{prefix}{v}"
        resp_headers[k] = v
    # Origine opaque pour tout document proxifié (cf. bloc de tête).
    resp_headers["Content-Security-Policy"] = "sandbox allow-scripts allow-forms"
    resp_headers["X-Content-Type-Options"] = "nosniff"
    resp_headers["Cache-Control"] = "no-store"
    resp_headers["X-Robots-Tag"] = "noindex"
    if "text/event-stream" in (upstream.headers.get("content-type") or ""):
        # Sans ceci, un nginx/Caddy devant l'app peut tamponner le flux.
        resp_headers["X-Accel-Buffering"] = "no"

    async def _relay():
        try:
            if upstream.is_stream_consumed:
                # Transport en mémoire (httpx.MockTransport des tests) : le
                # contenu est déjà chargé, aiter_raw lèverait StreamConsumed.
                yield upstream.content
            else:
                async for chunk in upstream.aiter_raw():
                    yield chunk
        except (httpx.HTTPError, OSError) as exc:
            # AUDIT 2026-08-02 (E3) — le seul garde (except RequestError du
            # handler) couvre l'ÉTABLISSEMENT de la connexion, pas le stream.
            # Un serveur user qui meurt en plein transfert (Ctrl-C, OOM,
            # docker stop du GC) levait ici → l'exception traversait
            # BaseHTTPMiddleware en erreur ASGI opaque. On ne peut plus
            # changer le statut (headers partis) : on termine proprement le
            # flux (troncature visible côté navigateur) et on LOGGE la cause.
            logger.info("[sandbox-preview] flux amont interrompu (port %s) : %r",
                        port, exc)
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(_relay(), status_code=upstream.status_code,
                             headers=resp_headers)


__all__ = []
