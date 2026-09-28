# SPDX-License-Identifier: MIT
"""
backend/routes/admin/executors.py — Endpoints admin.

L'admin règle :
  1. Limites cgroups par container user (RAM, CPU, pids, timeout)
  2. force_user_docker (oui/non)
  3. idle_kill_hours + profils réseau (l'imposition PAR UTILISATEUR d'un
     profil vit dans ``routes/admin/users.py`` — clé de settings
     ``forced_network_profile_id``)
  4. Avancé : exec_user (UID:GID des exec), runtime (OCI alternatif),
     extra_run_args (flags docker run passthrough) — champs
     déjà consommés par SandboxAdminConfig ; ils sont validés ici et, si un
     client ne les envoie pas, la valeur en place dans config.json est
     CONSERVÉE (avant 2026-07-19, chaque sauvegarde admin les effaçait).

L'IMAGE EST FIGÉE par l'app : ``elpis/sandbox:1.6.0`` est buildée par
le développeur et chargée automatiquement par l'app au premier usage.
L'admin n'a rien à faire pour la gérer.

Endpoints
---------
  GET    /api/admin/executors                          → config + healthcheck
  POST   /api/admin/executors                          → set config (limites + flags)
  GET    /api/admin/executors/healthcheck              → daemon + image + archive
  GET    /api/admin/sandbox/containers                 → liste elpis-sb-*
  POST   /api/admin/sandbox/containers/{user_id}/stop  → stop ce container
  DELETE /api/admin/sandbox/containers/{user_id}       → destroy
  POST   /api/admin/sandbox/gc                         → trigger GC idle
"""
from __future__ import annotations

import asyncio
import json
import logging
import shutil

from fastapi import HTTPException, Request

from shared_infra.security.audit import audit_event
from shared_infra.config import read_config_json, write_config_json
from shared_infra.routes._legacy import _require_admin
from shared_infra.routes.admin._state import admin_router

from shared_infra.sandbox.executors import (
    find_image_archive, gc_idle_containers,
    get_image_load_state, get_user_sandbox, load_admin_config,
    reset_user_sandbox_cache,
)

logger = logging.getLogger("uvicorn.error")

# Image utilisée quand ``config.json`` n'en nomme aucune. Ce n'est PAS une
# valeur figée : ``config.json`` › ``executors.image`` fait foi, et doit
# survivre aux enregistrements de l'onglet Sandbox (cf. _configured_image).
# Reste alignée sur SandboxAdminConfig.image (_user_sandbox.py).
DEFAULT_IMAGE = "elpis/sandbox:1.6.0"


def _configured_image(block: dict | None) -> str:
    """Image effective : celle de ``config.json``, sinon le défaut.

    L'UI n'expose pas de champ « image » — c'est un réglage de déploiement,
    posé à la main dans ``config.json`` (instance équipée d'une image
    sandbox autre que celle livrée par défaut). L'admin doit pouvoir régler
    mémoire, réseau ou profils SANS l'écraser au passage : avant, chaque
    POST réinscrivait le défaut en dur et faisait silencieusement repasser
    l'instance sur l'image standard au prochain conteneur créé.
    """
    return str((block or {}).get("image") or "").strip() or DEFAULT_IMAGE


def _docker_bin() -> str:
    return shutil.which("docker") or "/usr/bin/docker"


@admin_router.get("/api/admin/executors")
def admin_executors_get(request: Request):
    _require_admin(request)
    cfg = read_config_json() or {}
    block = cfg.get("executors") or {}
    from shared_infra.sandbox.executors._user_sandbox import _default_profiles

    profiles = block.get("network_profiles") or []
    if not profiles:
        profiles = [p.to_dict() for p in _default_profiles()]

    return {
        "config": {
            "limits": block.get("limits") or {
                "memory_mb": 2048, "cpu_quota_pct": 100,
                "pids_max": 512, "timeout_s": 600,
            },
            "force_user_docker": bool(block.get("force_user_docker", False)),
            "idle_kill_hours": int(block.get("idle_kill_hours", 24)),
            "network_profiles": profiles,
            "exec_user": str(block.get("exec_user") or "10001:10001"),
            "runtime": str(block.get("runtime") or ""),
            "extra_run_args": [str(x) for x in (block.get("extra_run_args") or []) if str(x).strip()],
        },
        "image": _configured_image(block),
    }


@admin_router.post("/api/admin/executors")
async def admin_executors_post(request: Request):
    """Met à jour la config admin.

    L'image n'est pas modifiable DEPUIS L'UI, mais celle que ``config.json``
    déclare est préservée telle quelle (elle n'est pas dans le POST).
    """
    _require_admin(request)
    body = await request.json()
    new = body.get("executors") if isinstance(body, dict) else None
    if not isinstance(new, dict):
        raise HTTPException(400, "Body invalide : besoin de {executors: {...}}")

    # Profils réseau : validation
    raw_profiles = new.get("network_profiles") or []
    sanitized_profiles = []
    warnings: list = []
    seen_ids = set()
    import ipaddress
    import re as _re
    _DOM_RE = _re.compile(
        r"^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?"
        r"(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$", _re.IGNORECASE)
    _LINK_LOCAL = ipaddress.ip_network("169.254.0.0/16")
    for p in raw_profiles:
        if not isinstance(p, dict):
            continue
        pid = (p.get("id") or "").strip()[:32]
        pname = (p.get("name") or "").strip()[:60]
        if not pid or not pname:
            continue
        if not _re.match(r"^[a-z0-9_-]+$", pid):
            raise HTTPException(400, f"id de profil invalide : {pid!r} (lettres minuscules, chiffres, _ ou -)")
        if pid in seen_ids:
            raise HTTPException(400, f"id de profil dupliqué : {pid!r}")
        seen_ids.add(pid)

        pmode = p.get("mode", "none")
        if pmode not in ("none", "bridge", "allowlist_ip"):
            raise HTTPException(400, f"mode invalide pour profil {pid!r}")
        # ``isolated`` est le repli FAIL-CLOSED de tout le code (résolveur de
        # profil, ``_profile_has_no_egress``, profil d'un user supprimé…). Lui
        # donner un mode ouvert transformerait chaque repli en accès réseau :
        # on le ré-ancre sur "none" côté serveur, l'UI grise déjà ses boutons.
        if pid == "isolated" and pmode != "none":
            warnings.append("Le profil 'isolated' est le repli de sécurité : "
                            "son mode est forcé à « Tout bloquer ».")
            pmode = "none"

        pips = [str(x).strip() for x in (p.get("ips") or []) if str(x).strip()]
        pdomains = [str(x).strip().lower().rstrip(".")
                    for x in (p.get("domains") or []) if str(x).strip()]
        pdns = [str(x).strip() for x in (p.get("dns") or []) if str(x).strip()]
        raw_ports = [x for x in (p.get("ports") or []) if str(x).strip()]
        pports: list = []
        if pmode == "allowlist_ip":
            if not pips and not pdomains:
                raise HTTPException(
                    400, f"Profil {pid!r} : allowlist_ip sans IP ni domaine")
            for ip in pips:
                try:
                    net = ipaddress.ip_network(ip, strict=False)
                except ValueError:
                    raise HTTPException(
                        400, f"Profil {pid!r} : IP invalide {ip!r} (utilise IP ou CIDR)")
                # Non bloquant : l'admin peut le vouloir, mais il doit le voir.
                if net.prefixlen == 0:
                    warnings.append(
                        f"Profil {pid!r} : {ip} autorise TOUT internet — "
                        "autant utiliser le mode Ouvert (bridge).")
                elif net.version == 4 and net.overlaps(_LINK_LOCAL):
                    warnings.append(
                        f"Profil {pid!r} : {ip} recouvre 169.254.0.0/16 "
                        "(métadonnées cloud, ex. 169.254.169.254).")
            if len(pips) > 64:
                raise HTTPException(400, f"Profil {pid!r} : trop d'IPs (max 64)")
            for dom in pdomains:
                if not _DOM_RE.match(dom):
                    raise HTTPException(
                        400, f"Profil {pid!r} : domaine invalide {dom!r}")
            if len(pdomains) > 32:
                raise HTTPException(400, f"Profil {pid!r} : trop de domaines (max 32)")
            for x in raw_ports:
                try:
                    port = int(x)
                except (TypeError, ValueError):
                    raise HTTPException(400, f"Profil {pid!r} : port invalide {x!r}")
                if not 1 <= port <= 65535:
                    raise HTTPException(400, f"Profil {pid!r} : port hors plage {port}")
                pports.append(port)
            if len(pports) > 32:
                raise HTTPException(400, f"Profil {pid!r} : trop de ports (max 32)")
            for ip in pdns:
                try:
                    ipaddress.ip_address(ip)
                except ValueError:
                    raise HTTPException(
                        400, f"Profil {pid!r} : résolveur DNS invalide {ip!r} (IP attendue)")
            if len(pdns) > 4:
                raise HTTPException(400, f"Profil {pid!r} : trop de résolveurs (max 4)")
        else:
            pips, pdomains, pports, pdns = [], [], [], []  # ignorés hors allowlist

        sanitized_profiles.append({
            "id": pid, "name": pname, "mode": pmode,
            "ips": pips, "domains": pdomains, "ports": pports, "dns": pdns,
            "description": (p.get("description") or "").strip()[:200],
        })

    if len(sanitized_profiles) > 20:
        raise HTTPException(400, "Trop de profils (max 20)")

    # Config en place : les champs avancés absents du POST sont CONSERVÉS
    # (un client partiel ne doit pas les effacer du config.json).
    cfg = read_config_json() or {}
    cur = cfg.get("executors") or {}

    exec_user = str(new.get("exec_user", cur.get("exec_user", "10001:10001")) or "10001:10001").strip()
    if not _re.match(r"^\d{1,7}:\d{1,7}$", exec_user):
        raise HTTPException(400, "exec_user doit être au format UID:GID (ex. 10001:10001 ; 0:0 = root)")

    runtime = str(new.get("runtime", cur.get("runtime", "")) or "").strip()[:64]
    if runtime and not _re.match(r"^[A-Za-z0-9._-]+$", runtime):
        raise HTTPException(400, "runtime invalide (lettres, chiffres, . _ - uniquement)")

    raw_extra = new.get("extra_run_args", cur.get("extra_run_args") or [])
    if not isinstance(raw_extra, list):
        raise HTTPException(400, "extra_run_args doit être une liste de chaînes")
    extra_run_args = []
    for x in raw_extra:
        s = str(x).strip()
        if not s:
            continue
        if len(s) > 200 or "\n" in s or "\r" in s:
            raise HTTPException(400, f"extra_run_args : argument invalide {s[:40]!r}")
        extra_run_args.append(s)
    if len(extra_run_args) > 32:
        raise HTTPException(400, "extra_run_args : trop d'arguments (max 32)")

    sanitized = {
        # `cur` = le bloc executors AVANT écriture : on repart de l'image
        # déjà configurée. Écrire DEFAULT_IMAGE ici écrasait le réglage de
        # déploiement à chaque enregistrement de l'onglet Sandbox.
        "image": _configured_image(cur),
        "limits": {
            "memory_mb": int((new.get("limits") or {}).get("memory_mb", 2048)),
            "cpu_quota_pct": int((new.get("limits") or {}).get("cpu_quota_pct", 100)),
            "pids_max": int((new.get("limits") or {}).get("pids_max", 512)),
            "timeout_s": int((new.get("limits") or {}).get("timeout_s", 600)),
        },
        "force_user_docker": bool(new.get("force_user_docker", False)),
        "idle_kill_hours": int(new.get("idle_kill_hours", 24)),
        "exec_user": exec_user,
        "runtime": runtime,
        "extra_run_args": extra_run_args,
        "network_profiles": sanitized_profiles,
    }

    if sanitized["limits"]["memory_mb"] < 256 or sanitized["limits"]["memory_mb"] > 65536:
        raise HTTPException(400, "memory_mb doit être entre 256 et 65536")
    if sanitized["limits"]["cpu_quota_pct"] < 10 or sanitized["limits"]["cpu_quota_pct"] > 1600:
        raise HTTPException(400, "cpu_quota_pct doit être entre 10 et 1600")
    if sanitized["limits"]["pids_max"] < 16 or sanitized["limits"]["pids_max"] > 8192:
        raise HTTPException(400, "pids_max doit être entre 16 et 8192")
    if sanitized["limits"]["timeout_s"] < 5 or sanitized["limits"]["timeout_s"] > 7200:
        raise HTTPException(400, "timeout_s doit être entre 5 et 7200")

    cfg["executors"] = sanitized
    write_config_json(cfg)
    reset_user_sandbox_cache()

    audit_event(
        user_id=getattr(request.state, "user_id", None),
        username=getattr(request.state, "username", None),
        action="admin.executors.update",
        details={"force_user_docker": sanitized["force_user_docker"]},
    )
    stale = await _find_stale_network_containers(sanitized["network_profiles"])
    return {"ok": True, "config": sanitized,
            "warnings": warnings, "stale_containers": stale}


async def _find_stale_network_containers(profiles: list) -> list:
    """Conteneurs RUNNING dont le label ``elpis.netcfg`` ne correspond plus au
    profil de leur utilisateur (après une sauvegarde admin).

    ``ensure_running`` recréera de toute façon au prochain exec
    (``_reconcile_network``) — la liste sert à l'UI pour PROPOSER une
    recréation immédiate au lieu de laisser des règles périmées tourner
    jusqu'au prochain usage. Best-effort : toute erreur → liste vide.
    """
    try:
        from shared_infra.sandbox.executors._user_sandbox import (
            NetworkProfile, netcfg_hash, resolve_network_profile_id,
        )
        from shared_infra.accounts.users import get_user_settings
        by_id = {p["id"]: NetworkProfile.from_dict(p) for p in profiles}

        from shared_infra.sandbox import naming as _naming
        proc = await asyncio.create_subprocess_exec(
            _docker_bin(), "ps", *_naming.label_filter("user_id"),
            "--format",
            "{{.Names}}\t" + _naming.label_tpl("user_id", ps=True) + "\t"
            + _naming.label_tpl("username", ps=True) + "\t"
            + _naming.label_tpl("netcfg", ps=True),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=15)
        if proc.returncode != 0:
            return []
        lines = out.decode(errors="replace").splitlines()
        stale = []
        for line in lines:
            parts = line.split("\t")
            if len(parts) < 4:
                continue
            cname, uid_s, uname, label = parts[0], parts[1], parts[2], parts[3].strip()
            try:
                uid = int(uid_s)
            except ValueError:
                continue
            settings = get_user_settings(uid) or {}
            prof = by_id.get(resolve_network_profile_id(settings))
            if prof is None:
                prof = by_id.get("isolated")
            if prof is None:
                continue
            expected = netcfg_hash(prof)
            if label == expected:
                continue
            # Label absent : dérive avérée seulement si le profil courant est
            # filtrant (même règle que _netcfg_matches côté sandbox).
            if not label and prof.mode != "allowlist_ip":
                continue
            stale.append({"user_id": uid, "username": uname or None,
                          "container": cname, "profile_id": prof.id})
        return stale
    except Exception:                                       # noqa: BLE001
        return []


@admin_router.get("/api/admin/executors/healthcheck")
async def admin_executors_healthcheck(request: Request):
    """Daemon + image + archive disponible côté disque."""
    _require_admin(request)
    cfg = load_admin_config()

    # Test daemon
    proc = await asyncio.create_subprocess_exec(
        _docker_bin(), "version", "--format", "{{.Server.Version}}",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=10)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.communicate()
        return {
            "daemon_ok": False,
            "error": "Timeout — le daemon Docker ne répond pas",
            "hint": "Vérifie : sudo systemctl status docker",
        }
    if proc.returncode != 0:
        return {
            "daemon_ok": False,
            "error": err.decode("utf-8", errors="replace").strip().split("\n")[0][:300],
            "hint": (
                "Le daemon Docker n'est pas joignable. Vérifie :\n"
                "  • sudo systemctl status docker\n"
                "  • L'utilisateur de l'app a-t-il le droit (groupe docker) ?\n"
                "  • Le socket /var/run/docker.sock existe-t-il ?"
            ),
        }
    server_version = out.decode().strip()

    # Test image (déjà chargée ?)
    proc2 = await asyncio.create_subprocess_exec(
        _docker_bin(), "image", "inspect", cfg.image,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        await asyncio.wait_for(proc2.communicate(), timeout=10)
    except asyncio.TimeoutError:
        proc2.kill()
        await proc2.communicate()
    image_loaded = (proc2.returncode == 0)

    # Si pas chargée, est-ce qu'on a au moins l'archive sur disque ?
    archive_path = None if image_loaded else find_image_archive(cfg.image)

    # État global du chargement (peut être en cours)
    img_state = get_image_load_state().to_dict()

    return {
        "daemon_ok": True,
        "server_version": server_version,
        "image": cfg.image,
        "image_loaded": image_loaded,
        "archive_available": archive_path is not None,
        "archive_path": str(archive_path) if archive_path else None,
        "image_load_state": img_state,
    }


# ─── Monitoring containers user ────────────────────────────────────────────

@admin_router.get("/api/admin/sandbox/containers")
async def admin_sandbox_containers(request: Request):
    """Liste tous les containers user (étiquette elpis.user_id)."""
    _require_admin(request)
    from shared_infra.sandbox import naming as _naming

    proc = await asyncio.create_subprocess_exec(
        _docker_bin(), "ps", "-a", *_naming.label_filter("user_id"),
        "--format",
        '{"id":"{{.ID}}","name":"{{.Names}}","image":"{{.Image}}",'
        '"state":"{{.State}}","status":"{{.Status}}","created":"{{.CreatedAt}}"}',
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=15)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.communicate()
        raise HTTPException(502, "docker ps timeout")

    if proc.returncode != 0:
        raise HTTPException(502, err.decode(errors="replace").strip()[:300])
    lines = out.decode().splitlines()

    containers = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            c = json.loads(line)
        except json.JSONDecodeError:
            continue
        inspect_proc = await asyncio.create_subprocess_exec(
            _docker_bin(), "inspect", "--format",
            _naming.label_tpl("user_id") + "|" + _naming.label_tpl("username"),
            c["name"],
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        io, _ = await inspect_proc.communicate()
        label = io.decode().strip()
        uid_str, _, uname = label.partition("|")
        try:
            c["user_id"] = int(uid_str)
        except ValueError:
            c["user_id"] = None
        c["username"] = uname or None
        containers.append(c)
    return {"containers": containers, "count": len(containers)}


@admin_router.post("/api/admin/sandbox/containers/{user_id}/stop")
async def admin_sandbox_stop(request: Request, user_id: int):
    _require_admin(request)
    from shared_infra.accounts.users import get_username_by_id
    username = get_username_by_id(user_id)
    if not username:
        raise HTTPException(404, f"User {user_id} introuvable")

    # Build the sandbox on the WORK root (P/work) — the dir actually mounted
    # at /work. Using the per-user root P here would poison the process-wide
    # _USER_SANDBOXES cache with sandbox_path=P → a later _create would re-mount
    # the whole P and re-expose skills/.memory (cf. work-subdir isolation).
    from shared_infra.routes._helpers import _get_work_path
    sb = get_user_sandbox(user_id, username, _get_work_path(user_id))
    await sb.stop()
    audit_event(
        user_id=getattr(request.state, "user_id", None),
        username=getattr(request.state, "username", None),
        action="admin.sandbox.stop",
        details={"target_user_id": user_id, "target_username": username},
    )
    return {"ok": True}


@admin_router.delete("/api/admin/sandbox/containers/{user_id}")
async def admin_sandbox_destroy(request: Request, user_id: int):
    _require_admin(request)
    from shared_infra.accounts.users import get_username_by_id
    username = get_username_by_id(user_id)
    if not username:
        raise HTTPException(404, f"User {user_id} introuvable")

    # Build on the WORK root (P/work) — see admin_sandbox_stop for why P poisons
    # the sandbox cache and re-exposes skills/.memory.
    from shared_infra.routes._helpers import _get_work_path
    sb = get_user_sandbox(user_id, username, _get_work_path(user_id))
    await sb.destroy()
    audit_event(
        user_id=getattr(request.state, "user_id", None),
        username=getattr(request.state, "username", None),
        action="admin.sandbox.destroy",
        details={"target_user_id": user_id, "target_username": username},
    )
    return {"ok": True}

@admin_router.post("/api/admin/sandbox/gc")
async def admin_sandbox_gc(request: Request):
    _require_admin(request)
    stopped = await gc_idle_containers()
    audit_event(
        user_id=getattr(request.state, "user_id", None),
        username=getattr(request.state, "username", None),
        action="admin.sandbox.gc",
        details={"stopped": stopped},
    )
    return {"ok": True, "stopped": stopped}


__all__ = []
