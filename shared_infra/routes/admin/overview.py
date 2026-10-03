# SPDX-License-Identifier: MIT
"""
shared_infra/routes/admin/overview.py — Vue d'ensemble de la console (lot 6)
===========================================================================

``GET /api/admin/overview`` : la page d'arrivée de la console. En un appel,
ce qui demande l'attention (« À traiter »), l'état de chaque service, les
chiffres des dernières 24 h et la liste d'installation — au lieu de six écrans
à parcourir.

* **Appels en processus**, jamais de requête HTTP vers soi-même : les sondes
  réutilisent les fonctions des écrans concernés (santé llama, test de
  connecteur, ping RAG, config voix, Docker, base).
* **Sondes légères et bornées** : une connexion TCP quand un « test » ferait
  un vrai travail (voix, compression), ``PROBE_TIMEOUT`` chacune, en
  parallèle ; une sonde qui échoue rend « Inconnu », jamais une 500.
* **Cache partagé de ``CACHE_TTL`` s**, sous verrou : dix onglets ouverts ne
  font pas dix tournées de sondes. Seul un administrateur peut forcer une
  nouvelle tournée (``?refresh=1``) — les sondes sortantes sont réservées aux
  admins depuis l'audit H6 ; les modérateurs lisent le résultat en cache.
* **Lecture** : admin et modérateurs (``is_admin`` 1 ou 2). La réponse ne
  porte ni clé ni secret.
"""
from __future__ import annotations

import asyncio
import logging
import shutil
import time
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

from fastapi import HTTPException, Request

from shared_infra.accounts.users import get_user_by_id
from shared_infra.routes.admin._state import admin_router
from shared_infra.security.deps import require_user_id

logger = logging.getLogger(__name__)

CACHE_TTL = 15.0          # s — fraîcheur de la tournée partagée
PROBE_TIMEOUT = 3.0       # s — plafond de chaque sonde
TCP_TIMEOUT = 1.5         # s — « le port répond-il ? » (hôte du LAN éteint = pas de refus)
BACKUP_STALE_DAYS = 7     # au-delà, « aucune sauvegarde depuis N jours »
MAX_CONNECTORS = 8        # connecteurs partagés sondés par tournée

_cache: Dict[str, Any] = {"at": 0.0, "data": None}
_lock: Optional[asyncio.Lock] = None


def _role(request: Request) -> int:
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    if not me or me["is_admin"] not in (1, 2):
        raise HTTPException(403, "Staff required")
    return int(me["is_admin"])


# ─── Petits outils ───────────────────────────────────────────────────────────

def _svc(sid: str, label: str, target: str, state: str, detail: str = "",
         page: str = "") -> Dict[str, Any]:
    """Une ligne de l'inventaire. ``state`` : ok · down · warn · off · unknown."""
    return {"id": sid, "label": label, "target": target, "state": state,
            "detail": detail, "page": page}


def _short(url: str) -> str:
    """``http://10.0.0.5:8081/v1/chat/completions`` → ``10.0.0.5:8081``."""
    if not url:
        return ""
    try:
        u = urlparse(url if "://" in url else "http://" + url)
        host = u.hostname or ""
        return f"{host}:{u.port}" if u.port else host
    except ValueError:
        return url[:60]


def _tcp(url: str, timeout: float = TCP_TIMEOUT) -> bool:
    """Le port répond-il ? (connexion TCP seule, sans requête HTTP)."""
    from llm_core._mcp_wrappers import _shared_service_reachable
    return _shared_service_reachable(url if "://" in url else "http://" + url, timeout=timeout)


async def _guard(coro, fallback: Dict[str, Any], timeout: float = PROBE_TIMEOUT + 1.0) -> Any:
    """Une sonde qui dépasse son délai ou lève rend ``fallback`` (Inconnu)."""
    try:
        return await asyncio.wait_for(coro, timeout=timeout)
    except Exception as exc:                                  # noqa: BLE001
        logger.info("[overview] sonde %s : %r", fallback.get("id"), exc)
        out = dict(fallback)
        out.setdefault("state", "unknown")
        out["detail"] = out.get("detail") or "Sonde sans réponse"
        return out


# ─── Sondes ──────────────────────────────────────────────────────────────────

async def _probe_llm() -> Dict[str, Any]:
    import llm_core
    from shared_infra import config as _cfg
    target = _short(getattr(_cfg, "LLAMA_URL", ""))
    h = await llm_core.get_llm_health()
    if not h.get("server_reachable"):
        return _svc("llm", "Moteur local", target, "down", "Injoignable", "inference")
    n = len(h.get("models_loaded") or [])
    return _svc("llm", "Moteur local", target, "ok",
                f"{n} modèle{'s' if n > 1 else ''} chargé{'s' if n > 1 else ''}" if n
                else "Aucun modèle chargé", "inference")


async def _probe_connectors() -> List[Dict[str, Any]]:
    from llm_core.providers.discovery import test_connector
    from shared_infra.llm import connectors as _lc
    rows = [r for r in await asyncio.to_thread(_lc.list_shared_connectors)
            if r.get("enabled", True)][:MAX_CONNECTORS]

    async def one(r: Dict[str, Any]) -> Dict[str, Any]:
        label = r.get("label") or r.get("provider_type") or "Connecteur"
        base = _svc(f"conn-{r['id']}", label, _short(r.get("base_url") or ""),
                    "unknown", "", "inference")
        secret = await asyncio.to_thread(_lc.get_shared_secret, r["id"])
        res = await test_connector(secret or r, timeout=PROBE_TIMEOUT)
        if res.get("ok"):
            n = res.get("models_count") or 0
            base.update(state="ok", detail=f"{n} modèle{'s' if n > 1 else ''}")
        else:
            base.update(state="down", detail=str(res.get("hint") or res.get("error") or "Injoignable")[:80])
        return base

    return list(await asyncio.gather(*[
        _guard(one(r), _svc(f"conn-{r['id']}", r.get("label") or "Connecteur",
                            _short(r.get("base_url") or ""), "unknown", "", "inference"))
        for r in rows]))


async def _probe_compression() -> Dict[str, Any]:
    from shared_infra import config as _cfg
    await asyncio.to_thread(_cfg.reload_compression_config_from_disk, False)
    if not _cfg.COMPRESSION_ENABLED:
        return _svc("compression", "Compression", "", "off", "", "compression")
    url = _cfg.COMPRESSION_ENDPOINT_URL or ""
    if not url:
        # Pas d'adresse dédiée : c'est le moteur local qui compresse (son état
        # est recopié à l'assemblage, sans alerte en double).
        return _svc("compression", "Compression", "", "same", "", "compression")
    ok = await asyncio.to_thread(_tcp, url)
    return _svc("compression", "Compression", _short(url), "ok" if ok else "down",
                "Joignable" if ok else "Injoignable", "compression")


async def _probe_rag() -> Dict[str, Any]:
    from llm_core import _rag_client as rc
    if not rc.is_configured():
        return _svc("rag", "RAG", "", "off", "Non configuré", "rag")
    url = rc.get_service_url()
    try:
        await asyncio.to_thread(rc.ping, None, None, PROBE_TIMEOUT)
    except rc.RagServiceError as exc:
        msg = str(exc)
        detail = "Accès refusé" if ("401" in msg or "403" in msg) else "Injoignable"
        return dict(_svc("rag", "RAG", _short(url), "down", detail, "rag"), hint=msg[:160])
    return _svc("rag", "RAG", _short(url), "ok", "Joignable", "rag")


async def _probe_vision() -> Dict[str, Any]:
    from shared_infra import config as _cfg
    await asyncio.to_thread(_cfg.reload_desktop_config_from_disk, False)
    url = (_cfg.VISION_ENDPOINT_URL or "").strip()
    if not url:
        return _svc("vision", "Vision", "", "off", "Non configurée", "vision")
    ok = await asyncio.to_thread(_tcp, url)
    return _svc("vision", "Vision", _short(url), "ok" if ok else "down",
                "Joignable" if ok else "Injoignable", "vision")


async def _probe_voice() -> Dict[str, Any]:
    from shared_infra.voice.config import get_voice_config, voice_flags
    cfg = get_voice_config()
    stt_on, tts_on = voice_flags(cfg)
    if not (stt_on or tts_on):
        return _svc("voice", "Voix", "", "off", "", "voice")
    # Connexion TCP seulement : le « Tester » de l'écran Voix fait une vraie
    # transcription et une vraie synthèse — trop cher pour une page d'accueil.
    parts, states, targets = [], [], []
    sections = [(key, name) for key, on, name in (("stt", stt_on, "Transcription"),
                                                  ("tts", tts_on, "Synthèse")) if on]
    oks = await asyncio.gather(*[asyncio.to_thread(_tcp, cfg[key]["endpoint_url"])
                                 for key, _n in sections])
    for (key, name), ok in zip(sections, oks):
        states.append(ok)
        targets.append(_short(cfg[key]["endpoint_url"]))
        parts.append(f"{name} {'joignable' if ok else 'injoignable'}")
    state = "ok" if all(states) else ("down" if not any(states) else "warn")
    return _svc("voice", "Voix", " · ".join(dict.fromkeys(targets)), state,
                " · ".join(parts), "voice")


async def _probe_images() -> Dict[str, Any]:
    from shared_infra.image.config import get_image_config, image_ready
    cfg = get_image_config()
    if not image_ready(cfg):
        return _svc("images", "Images", "", "off", "", "images")
    # Connexion TCP seulement, comme la voix : « Tester » interroge le moteur.
    ok = await asyncio.to_thread(_tcp, cfg["url"])
    return _svc("images", "Images", _short(cfg["url"]), "ok" if ok else "down",
                "Joignable" if ok else "Injoignable", "images")


async def _probe_mcp() -> Dict[str, Any]:
    def work():
        from llm_core import _mcp_categories as mc
        from shared_infra.mcp import manifest as mf
        n = len(mc.all_tool_names())
        m = mf.load()
        return n, len(getattr(m, "errors", None) or [])
    n, errors = await asyncio.to_thread(work)
    if errors:
        return _svc("mcp", "Outils MCP", "", "warn",
                    f"{errors} erreur{'s' if errors > 1 else ''} de configuration", "mcp")
    if not n:
        # Registre vide = aucun worker n'a encore ouvert les outils, pas « zéro outil ».
        return _svc("mcp", "Outils MCP", "", "unknown", "Pas encore chargés", "mcp")
    return _svc("mcp", "Outils MCP", "", "ok", f"{n} outils", "mcp")


async def _probe_sandbox() -> Dict[str, Any]:
    from shared_infra.sandbox.executors import load_admin_config
    from shared_infra.sandbox.executors._user_sandbox import _DockerCLI
    cfg = await asyncio.to_thread(load_admin_config)
    if not shutil.which("docker"):
        state = "down" if getattr(cfg, "force_user_docker", False) else "off"
        return _svc("sandbox", "Sandbox", "", state, "Docker absent", "sandbox-limits")
    cli = _DockerCLI()
    rc, out, _err = await cli.call("version", "--format", "{{.Server.Version}}",
                                   timeout=int(PROBE_TIMEOUT))
    if rc != 0:
        return _svc("sandbox", "Sandbox", "Docker", "down", "Démon injoignable", "sandbox-limits")
    version = out.decode("utf-8", "replace").strip()
    from shared_infra.sandbox import naming as _naming
    from shared_infra.sandbox.executors import _image_loader
    image_ok, (rc_ps, ps_out, _e2) = await asyncio.gather(
        _image_loader._is_image_loaded(cfg.image),
        cli.call("ps", *_naming.label_filter("user_id"), "--format", "{{.Names}}",
                 timeout=int(PROBE_TIMEOUT)))
    running = None
    if rc_ps == 0:
        running = len({ln.strip() for ln in ps_out.decode("utf-8", "replace").splitlines()
                       if ln.strip()})
    rc_img = 0 if image_ok else 1
    if rc_img != 0:
        return _svc("sandbox", "Sandbox", f"Docker {version}", "warn",
                    f"Image {cfg.image} absente", "sandbox-containers")
    if running is None:
        detail = "Joignable"
    elif running == 0:
        detail = "Aucun container actif"
    else:
        detail = f"{running} container{'s' if running > 1 else ''} actif{'s' if running > 1 else ''}"
    return _svc("sandbox", "Sandbox", f"Docker {version}", "ok", detail, "sandbox-containers")


async def _probe_database() -> Dict[str, Any]:
    from shared_infra.db._connection import db_info
    try:
        info = await asyncio.to_thread(db_info)
    except Exception as exc:                                  # noqa: BLE001
        return _svc("database", "Base", "", "down", str(exc)[:80] or "Injoignable", "data")
    size = info.get("size_bytes")
    label = {"sqlite": "SQLite", "postgresql": "PostgreSQL", "postgres": "PostgreSQL",
             "mysql": "MySQL", "mariadb": "MariaDB"}.get(str(info.get("backend")).lower(),
                                                         str(info.get("backend") or "Base"))
    detail = _fmt_bytes(size) if isinstance(size, (int, float)) and size > 0 else "Joignable"
    return _svc("database", "Base", label, "ok", detail, "data")


def _fmt_bytes(n: float) -> str:
    for unit in ("o", "Ko", "Mo", "Go", "To"):
        if n < 1024 or unit == "To":
            return f"{n:.0f} {unit}" if unit in ("o", "Ko") else f"{n:.1f} {unit}".replace(".", ",")
        n /= 1024.0
    return f"{n:.0f} o"


# ─── Chiffres, sauvegardes, installation ─────────────────────────────────────

def _kpis_24h() -> Dict[str, Any]:
    from shared_infra.observability.usage_store import db_conn, usage_totals
    since = time.time() - 86400
    t = usage_totals(since)
    tools = {"calls": 0, "failed": 0}
    try:
        with db_conn() as conn:
            row = conn.execute(
                "SELECT COUNT(*), SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) "
                "FROM tool_call_metrics WHERE ts > ?", (since,)).fetchone()
        tools = {"calls": int(row[0] or 0), "failed": int(row[1] or 0)}
    except Exception:                                         # noqa: BLE001
        logger.info("[overview] tool_call_metrics illisible", exc_info=True)
    return {"users": int(t.get("users") or 0), "turns": int(t.get("turns") or 0),
            "tokens": int(t.get("total_tokens") or 0), "failures": int(t.get("failures") or 0),
            "tool_calls": tools["calls"], "tool_failures": tools["failed"]}


def _last_backup() -> Dict[str, Any]:
    """Dernière archive produite (téléchargement ou envoi distant réussi)."""
    from shared_infra.observability.usage_store import db_conn
    local = 0.0
    try:
        with db_conn() as conn:
            row = conn.execute("SELECT MAX(created_at) FROM metric_events "
                               "WHERE event_type='backup_created'").fetchone()
        local = float(row[0]) if row and row[0] else 0.0
    except Exception:                                         # noqa: BLE001
        logger.info("[overview] metric_events illisible", exc_info=True)
    remote: Dict[str, Any] = {}
    try:
        from shared_infra.ops.backup_remote import get_remote_config
        remote = get_remote_config() or {}
    except Exception:                                         # noqa: BLE001
        logger.info("[overview] config de sauvegarde distante illisible", exc_info=True)
    last_send = remote.get("last_send") or {}
    remote_ok = float(last_send.get("ok_at") or 0) or 0.0
    return {"at": max(local, remote_ok) or None,
            "remote_enabled": bool(remote.get("enabled")),
            "remote_failed": last_send.get("ok") is False,
            "remote_error": (last_send.get("error") or "")[:120] if last_send.get("ok") is False else ""}


def _security_facts() -> Dict[str, Any]:
    from shared_infra import config as _cfg
    from shared_infra.observability.usage_store import db_conn
    view = _cfg.config_view() or {}
    pol = ((view.get("security") or {}).get("password_policy") or {})
    policy_empty = not (int(pol.get("min_length") or 0) > 0 or any(
        pol.get(k) for k in ("require_uppercase", "require_lowercase",
                             "require_numbers", "require_special")))
    must_change = 0
    try:
        with db_conn() as conn:
            row = conn.execute("SELECT COUNT(*) FROM users "
                               "WHERE is_admin=1 AND must_change_pwd=1").fetchone()
        must_change = int(row[0] or 0)
    except Exception:                                         # noqa: BLE001
        logger.info("[overview] table users illisible", exc_info=True)
    name = str(((view.get("app_info") or {}).get("name")) or "").strip()
    return {"https": bool(_cfg.https_enabled()), "policy_empty": policy_empty,
            "admin_must_change": must_change, "instance_named": bool(name)}


# ─── Assemblage ──────────────────────────────────────────────────────────────

async def _collect() -> Dict[str, Any]:
    from shared_infra.ops import restart_pending as rp

    unknown = lambda sid, label, page: _svc(sid, label, "", "unknown", "", page)  # noqa: E731
    probes = await asyncio.gather(
        _guard(_probe_llm(), unknown("llm", "Moteur local", "inference")),
        _guard(_probe_connectors(), unknown("connectors", "Connecteurs", "inference"),
               timeout=2 * PROBE_TIMEOUT + 2.0),
        _guard(_probe_compression(), unknown("compression", "Compression", "compression")),
        _guard(_probe_rag(), unknown("rag", "RAG", "rag")),
        _guard(_probe_vision(), unknown("vision", "Vision", "vision")),
        _guard(_probe_voice(), unknown("voice", "Voix", "voice")),
        _guard(_probe_images(), unknown("images", "Images", "images")),
        _guard(_probe_mcp(), unknown("mcp", "Outils MCP", "mcp")),
        _guard(_probe_sandbox(), unknown("sandbox", "Sandbox", "sandbox-limits"),
               timeout=2 * PROBE_TIMEOUT + 1.0),
        _guard(_probe_database(), unknown("database", "Base", "data")),
    )
    services: List[Dict[str, Any]] = []
    for p in probes:
        services.extend(p if isinstance(p, list) else [p])
    llm = next((s for s in services if s["id"] == "llm"), None)
    for s in services:
        # Compression sans adresse propre : son état EST celui du moteur local.
        if s["state"] == "same":
            s["state"] = llm["state"] if llm else "unknown"
            s["detail"] = "Via le moteur local"
            s["inherited"] = True

    kpis, backup, sec, restart = await asyncio.gather(
        asyncio.to_thread(_kpis_24h), asyncio.to_thread(_last_backup),
        asyncio.to_thread(_security_facts), asyncio.to_thread(rp.pending))

    now = time.time()
    alerts: List[Dict[str, Any]] = []
    if restart:
        alerts.append({"id": "restart", "level": "warn", "title": "Redémarrage nécessaire",
                       "detail": f"{len(restart)} réglage{'s' if len(restart) > 1 else ''} en attente",
                       "paths": restart, "action": "restart"})
    for s in services:
        if s.get("inherited"):
            continue
        if s["state"] == "down":
            alerts.append({"id": "svc-" + s["id"], "level": "danger",
                           "title": f"{s['label']} injoignable",
                           "detail": s["target"] or s["detail"], "page": s["page"], "action": "page"})
        elif s["state"] == "warn":
            # Joignable mais incomplet : image sandbox absente, erreurs du
            # manifeste MCP, voix à moitié joignable…
            alerts.append({"id": "svc-" + s["id"], "level": "warn",
                           "title": f"{s['label']} : {s['detail'] or 'à vérifier'}",
                           "detail": s["target"], "page": s["page"], "action": "page"})
    if sec["admin_must_change"]:
        alerts.append({"id": "admin-pwd", "level": "danger", "title": "Mot de passe administrateur provisoire",
                       "detail": "À changer à la prochaine connexion", "page": "accounts", "action": "page"})
    age_days = (now - backup["at"]) / 86400 if backup["at"] else None
    if age_days is None or age_days > BACKUP_STALE_DAYS:
        alerts.append({"id": "backup", "level": "warn",
                       "title": ("Aucune sauvegarde depuis " + f"{int(age_days)} jours") if age_days
                                else "Aucune sauvegarde enregistrée",
                       "detail": "", "page": "data", "action": "backup"})
    if backup["remote_failed"]:
        alerts.append({"id": "backup-remote", "level": "warn", "title": "Dernier envoi distant en échec",
                       "detail": backup["remote_error"], "page": "data", "action": "page"})
    calls, failed = kpis["tool_calls"], kpis["tool_failures"]
    if failed >= 5 and calls and failed / calls >= 0.10:
        alerts.append({"id": "tools", "level": "warn",
                       "title": f"Appels d’outils : {round(100 * failed / calls)} % en échec",
                       "detail": f"{failed} sur {calls} en 24 h", "page": "tool-calls", "action": "page"})
    if not sec["https"]:
        alerts.append({"id": "https", "level": "warn", "title": "HTTPS désactivé",
                       "detail": "Mots de passe et cookies circulent en clair", "page": "https", "action": "page"})
    if sec["policy_empty"]:
        alerts.append({"id": "pwd-policy", "level": "warn", "title": "Aucune règle de mot de passe",
                       "detail": "", "page": "sessions", "action": "page"})

    engine_ok = any(s["state"] == "ok" for s in services
                    if s["id"] == "llm" or s["id"].startswith("conn-"))
    setup = [
        {"id": "name", "label": "Nommer l’instance", "done": sec["instance_named"], "page": "instance"},
        {"id": "engine", "label": "Un moteur joignable", "done": engine_ok, "page": "inference"},
        {"id": "admin-pwd", "label": "Mot de passe administrateur définitif",
         "done": not sec["admin_must_change"], "page": "accounts"},
        {"id": "https", "label": "Accès HTTPS", "done": sec["https"], "page": "https"},
        {"id": "backup", "label": "Sauvegarde distante", "done": backup["remote_enabled"], "page": "data"},
    ]
    return {"generated_at": now, "alerts": alerts, "services": services, "kpis": kpis,
            "backup": {"at": backup["at"], "remote_enabled": backup["remote_enabled"]},
            "setup": setup, "restart": {"pending": restart}}


@admin_router.get("/api/admin/overview")
async def api_admin_overview(request: Request, refresh: int = 0):
    global _lock
    role = await asyncio.to_thread(_role, request)
    if _lock is None:
        _lock = asyncio.Lock()
    force = bool(refresh) and role == 1
    fresh = _cache["data"] is not None and (time.time() - _cache["at"]) < CACHE_TTL
    if not fresh or force:
        async with _lock:
            # Un autre appel a peut-être rempli le cache pendant l'attente.
            fresh = _cache["data"] is not None and (time.time() - _cache["at"]) < CACHE_TTL
            if not fresh or force:
                _cache["data"] = await _collect()
                _cache["at"] = time.time()
    data = dict(_cache["data"])
    data["role"] = "admin" if role == 1 else "moderator"
    if role != 1:
        # Un modérateur voit l'état, pas les gestes ni l'inventaire des adresses.
        data["alerts"] = [dict(a, action="") for a in data["alerts"]]
    return data


@admin_router.get("/api/admin/restart-status")
async def api_admin_restart_status(request: Request):
    """Chemins qui n'agissent qu'au redémarrage, et ceux qui l'attendent —
    la barre d'enregistrement marque les premiers et annonce les seconds."""
    from shared_infra.ops import restart_pending as rp
    role = await asyncio.to_thread(_role, request)
    if role != 1:
        raise HTTPException(403, "Admin required")
    paths, pending = await asyncio.gather(asyncio.to_thread(rp.restart_paths),
                                          asyncio.to_thread(rp.pending))
    return {"paths": paths, "pending": pending}
