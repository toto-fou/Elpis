# SPDX-License-Identifier: MIT
"""
Admin lifecycle endpoints — restart, backup, restore, cache invalidation.

Auto-extracted from the former monolithic ``backend/routes/admin.py``.
The endpoint bodies are byte-for-byte identical to the originals.
"""
from __future__ import annotations

import asyncio
import logging
import os
import sqlite3
import sys
import tempfile
import zipfile
from pathlib import Path

import httpx
from fastapi import File, Form, HTTPException, Request, UploadFile
from fastapi.responses import (
    FileResponse,
    JSONResponse,
)
from starlette.background import BackgroundTask

from shared_infra.accounts.users import (
    get_user_by_id,
    get_username_by_id,
)
from shared_infra.config import (
    PROJECT_ROOT,
)
from shared_infra.routes._helpers import _DB_ANNEXES, _HOST_ONLY, _RUNTIME_DIRS

# Helpers shared with _legacy. Single source of truth.
from shared_infra.routes._legacy import (
    _make_backup_zip,
    system_events,
)

# Routers — owned by ``_state``. We import them so endpoint decorators
# below register on the SAME singleton router instances mounted by
# ``app.py`` / ``admin_app.py``.
from shared_infra.routes.admin._state import admin_router, internal_router
from shared_infra.sandbox.agent_client import AGENT_RUN_DIR, RELAY_DIR, AgentError
from shared_infra.sandbox.paths import WORK_SUBDIR, write_beneath
from shared_infra.security.deps import require_user_id

logger = logging.getLogger("uvicorn.error")


def active_generations() -> int:
    """Générations en cours, TOUS workers confondus (best-effort, 0 si inconnu).

    S'appuie sur le verrou de présence partagé posé par ``register_chat_task``
    — le registre en mémoire ne voit que le worker courant."""
    try:
        from shared_infra.runtime import chat_locks
        return chat_locks.count_held("gen")
    except Exception:                                       # noqa: BLE001
        return 0


def _graceful_drain_seconds() -> int:
    """Plafond du drain applicatif : combien de temps un ancien worker peut
    rester en vie pour FINIR ses runs (cf. ``uvicorn_worker.DRAIN_MAX_S``)."""
    try:
        from server.uvicorn_worker import DRAIN_MAX_S
        return int(DRAIN_MAX_S)
    except Exception:                                       # noqa: BLE001
        return 12 * 3600


async def _graceful_reload_after(delay: float = 5.0) -> None:
    """Reload gracieux de CE process après ``delay`` secondes.

    SIGHUP au master gunicorn (détecté via /proc/{ppid}/cmdline) — le
    master ré-exécute son fichier de conf, re-binde si l'adresse a
    changé, et recycle les workers sans jamais sortir du ``wait`` du
    script parent (voir docstring de restart-self pour le rationale
    SIGHUP-vs-SIGTERM). Hors gunicorn : fallback ``os.execv`` (même PID,
    image fraîche), dernier recours SIGTERM.
    """
    # AUDIT long-run 2026-08-21, révisé 2026-08-22 (A1/A3) — dire ce qui se
    # passe pour les runs en vol. Ils ne sont plus INTERROMPUS : l'ancien
    # worker ferme sa socket d'écoute (les nouvelles requêtes partent sur les
    # workers neufs) puis reste en vie, heartbeat maintenu, jusqu'à ce que ses
    # runs se terminent NORMALEMENT — plafond ``uvicorn_worker.DRAIN_MAX_S``
    # (12 h par défaut, APP_DRAIN_MAX_S). Le compte reste journalisé et exposé
    # par ``active_generations()`` : l'opérateur doit savoir qu'un ancien
    # worker va survivre au reload (et garder sa RAM) le temps de finir.
    _n_active = active_generations()
    if _n_active:
        logger.warning(
            "[reload] %d génération(s) en cours : l'ancien worker reste en vie "
            "pour les finir (plafond %d s) ; les nouvelles requêtes sont "
            "servies par les workers rechargés.",
            _n_active, _graceful_drain_seconds())
    await asyncio.sleep(delay)
    import signal as _sig
    ppid = os.getppid()
    parent_is_gunicorn = False
    if ppid > 1:
        try:
            with open(f"/proc/{ppid}/cmdline", "rb") as f:  # noqa: ASYNC230 (procfs, en mémoire)
                cmdline = f.read().replace(b"\x00", b" ").decode(
                    "utf-8", errors="ignore"
                ).lower()
            parent_is_gunicorn = "gunicorn" in cmdline
        except OSError:
            parent_is_gunicorn = False

    if parent_is_gunicorn:
        try:
            os.kill(ppid, _sig.SIGHUP)
            logger.info(
                "[reload] sent SIGHUP to gunicorn master pid=%d "
                "(graceful worker reload)", ppid,
            )
            return
        except OSError as exc:
            logger.warning(
                "[reload] SIGHUP to %d failed: %r — fallback to execv",
                ppid, exc,
            )

    # Not under gunicorn (uvicorn standalone, plain python, …) :
    # replace the current process image. Same PID, fresh code,
    # parent (bash / shell) sees nothing exit.
    try:
        os.execv(sys.executable, [sys.executable] + sys.argv)
    except Exception as exc:
        logger.warning(
            "[reload] execv fallback failed: %r — last resort SIGTERM", exc,
        )
        os.kill(os.getpid(), _sig.SIGTERM)


# AUDIT 2026-08-02 (E5) — référence forte sur la tâche de reload : sans elle,
# la task pouvait être GC avant son premier await → l'admin recevait le 200
# « reload planifié », les binds restaient sur l'ANCIEN mode (HTTP alors que
# HTTPS venait d'être « activé ») et l'exception éventuelle n'était jamais
# consultée. Une seule tâche à la fois : slot module-level suffisant.
_reload_task: "asyncio.Task | None" = None


def schedule_self_reload(delay: float = 5.0) -> None:
    """Planifie ``_graceful_reload_after`` en tâche de fond.

    Importé par le toggle HTTPS (``admin/security.py``) pour recharger le
    process admin après bascule des binds — même mécanique que les
    endpoints restart ci-dessous.
    """
    global _reload_task

    # Le process principal va relire config.json : son empreinte « lu au
    # démarrage » est périmée, le premier worker neuf la réécrira. (Le process
    # admin, rechargé par la bascule HTTPS en mode séparé, n'y touche pas.)
    if os.environ.get("APP_MODE", "main").lower() != "admin":
        from shared_infra.ops.restart_pending import invalidate as _invalidate_boot
        _invalidate_boot()

    def _log_reload_failure(t: "asyncio.Task") -> None:
        if t.cancelled():
            return
        exc = t.exception()
        if exc is not None:
            logger.error("[reload] la tâche de reload a échoué — les binds "
                         "n'ont PAS changé", exc_info=exc)

    _reload_task = asyncio.create_task(_graceful_reload_after(delay))
    _reload_task.add_done_callback(_log_reload_failure)
    logger.info(
        "[reload] scheduled graceful reload in %.0fs, pid=%d ppid=%d",
        delay, os.getpid(), os.getppid(),
    )


@admin_router.post("/api/admin/restart")
async def api_admin_restart(request: Request):
    """
    Triggered when the operator clicks "Restart" in the admin dashboard.

    Goal : restart the USER-FACING app (the chatbot / agentic process)
    AND make every currently-connected user see the maintenance popup
    immediately, regardless of which process their SSE channel happens
    to be attached to.

    Topology
    --------
    Elpis runs in two layouts :

      • APP_MODE=full        — single gunicorn, admin and main share the
        process. Restart kills it; all clients see the popup via the
        local system_events broadcast.

      • APP_MODE=admin/main  — split topology. The admin dashboard runs
        on the *admin* process (port 8002) and emits this request, but
        the popups must reach users connected to the *main* process
        (port 8001). The two processes don't share an in-memory bus by
        default — they bridge through the file-based metric_broadcast
        channel introduced in v3.7.

    What this endpoint does
    -----------------------
      1. (2026-09-25) Rien n'est publié : chaque worker remplacé évacue
         lui-même ses flux SSE avec ``worker_recycling`` en s'arrêtant.
      2. Trigger the actual process restart of the user-facing app :
         - In ``full`` mode : self-restart (admin and main are the same
           process, so killing it restarts both).
         - In ``admin`` mode : HTTP-call MAIN's loopback
           ``/api/admin/internal/restart-self`` endpoint. MAIN restarts
           itself; admin keeps running so the operator can see the
           dashboard come back up after a few seconds.

    The 5-second sleep before the actual exec gives clients enough time
    to render the popup and start their reconnect-polling loop before
    the socket is severed.
    """
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    if not me or me["is_admin"] != 1:
        raise HTTPException(403, "Admin required")

    # ── (1) Pas d'annonce ─────────────────────────────────────────────
    # AUDIT moteur d'événements 2026-09-25 (B11) — ce bouton publiait
    # ``worker_recycling`` sur le bus fichier : TOUS les clients de TOUS les
    # workers se reconnectaient en même temps 750 ms plus tard, y compris sur
    # des workers anciens pas encore recyclés, qui les expulsaient de nouveau
    # à leur tour (troupeau inutile). Le reload est gracieux : chaque worker
    # qui s'arrête évacue LUI-MÊME ses flux avec ``worker_recycling``
    # (server/app.py, ``_evacuate_streams_on_shutdown``), au bon moment et
    # pour ses seuls clients. La bannière ``restart`` reste réservée à
    # /broadcast-restart (arrêt réel).


    # ── (2) Trigger the actual restart of the USER-FACING app ────────
    app_mode = os.environ.get("APP_MODE", "full").lower()

    if app_mode == "full":
        # Single process — admin and main are the same gunicorn. The
        # file-based broadcast from step (1) reaches all our own SSE
        # clients. To restart, we use the same SIGHUP-vs-execv logic
        # as the loopback restart-self endpoint to avoid the
        # bash-trap collateral kill (see that endpoint's docstring).
        schedule_self_reload()
        # ``active_generations`` / ``drain_max_s`` : de quoi dire à l'opérateur
        # « N run(s) en cours — l'ancien worker restera en vie jusqu'à N s pour
        # les finir ». Champs ADDITIFS (aucun client existant ne les lit).
        return {"ok": True, "target": "self", "mode": app_mode,
                "active_generations": active_generations(),
                "drain_max_s": _graceful_drain_seconds()}

    # Split mode — we are the admin process. Tell main to restart.
    main_url = (os.environ.get("MAIN_INTERNAL_URL")
                or os.environ.get("MAIN_PUBLIC_URL")
                or "http://127.0.0.1:8001").rstrip("/")
    try:
        # Short timeout — the endpoint just schedules the restart and
        # returns immediately, so 5 s is plenty.
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(f"{main_url}/api/admin/internal/restart-self")
        if resp.status_code != 200:
            logger.warning(
                "[admin/restart] main returned %d for restart-self: %s",
                resp.status_code, resp.text[:200],
            )
            return {"ok": False, "target": "main", "main_status": resp.status_code}
        # Remonter ce que MAIN a répondu (nombre de runs qui vont finir sur
        # l'ancien worker + plafond de drain) — la console peut l'afficher.
        _body = {}
        try:
            _body = resp.json() or {}
        except Exception:                                   # noqa: BLE001
            _body = {}
        return {"ok": True, "target": "main", "main_url": main_url,
                "active_generations": _body.get("active_generations"),
                "drain_max_s": _body.get("drain_max_s")}
    except httpx.HTTPError as exc:
        logger.warning("[admin/restart] HTTP call to main failed: %r", exc)
        # The popup was still broadcasted via the file bus, so users
        # are warned even though the actual restart trigger failed.
        # The operator can intervene manually if needed.
        return {"ok": False, "target": "main", "error": str(exc)}


@internal_router.post("/api/admin/internal/restart-self")
async def api_admin_internal_restart_self(request: Request):
    """
    Loopback-only endpoint that restarts THIS process. Called by the
    admin process (in split mode) to ask main to restart itself.

    Security
    --------
    Auth is by source IP : only requests from 127.0.0.1 / ::1 are
    accepted. There is no user session / API key check — the loopback
    restriction IS the security boundary.

    Mechanism — why SIGHUP, not SIGTERM
    -----------------------------------
    We deliberately send **SIGHUP to the gunicorn master**, NOT SIGTERM.
    Reason : in dev launchers like ``./elpis start``, the bash
    parent runs ``wait`` for all background services and traps EXIT
    to kill ALL of them. Sending SIGTERM to the gunicorn master would :
      1. Kill master gunicorn → ``wait`` returns
      2. Bash starts to exit → EXIT trap fires
      3. Trap kills ADMIN process too !
    Net effect : admin dies in collateral, main doesn't actually
    respawn (no parent to relaunch it) → exactly the bug reported.

    SIGHUP, by contrast, tells gunicorn to do a graceful reload :
      • Master re-reads its config
      • Master spawns NEW workers with fresh code (preload_app=False
        means workers re-import all modules at fork)
      • Master sends SIGTERM to OLD workers (grace period 30 s)
      • Master itself stays alive throughout
    Bash sees nothing exit → no trap → no collateral.

    For the unusual case where the worker's parent is NOT gunicorn
    (e.g. ``uvicorn app:app`` directly, or pytest fixtures), we
    detect it by reading /proc/{ppid}/cmdline and fall back to
    os.execv on the current process image — that swaps in a fresh
    Python interpreter at the same PID, so the parent doesn't notice
    either.

    Behaviour
    ---------
    Returns 200 immediately. The actual reload happens 5 seconds later
    in a background task — same delay as the existing /restart endpoint,
    to give SSE listeners time to render the popup before the worker
    transition starts.
    """
    # Machine locale SANS proxy (audit 2026-09-22) : derrière Caddy, tout le
    # LAN arrivait de 127.0.0.1.
    from shared_infra.security.local_request import is_direct_local
    client_host = request.client.host if request.client else None
    if not is_direct_local(request):
        logger.warning(
            "[restart-self] rejected from %s (loopback only)", client_host,
        )
        raise HTTPException(403, "Endpoint restricted to loopback")

    schedule_self_reload()
    # ``active_generations`` : ce que le recyclage va interrompre. Champ
    # ADDITIF (aucun client existant ne le lit) — il donne à l'admin de quoi
    # afficher « N génération(s) en cours seront interrompues » au lieu de
    # laisser l'opérateur découvrir après coup des runs coupés.
    return {"ok": True, "scheduled_in_sec": 5, "pid": os.getpid(),
            "method": "sighup", "active_generations": active_generations(),
            "drain_max_s": _graceful_drain_seconds()}


@admin_router.post("/api/admin/cache/invalidate")
async def api_admin_invalidate_cache(request: Request):
    """
    Vide tous les caches liés aux modèles côté Python en une seule passe.

    Utile quand llama-server a été redémarré (ou un modèle chargé/déchargé
    manuellement) sans passer par l'API /models/load de l'app : les caches
    Python (n_ctx, props sampling, vision capability) gardent alors les
    valeurs de l'ancien modèle et les requêtes utilisent des params obsolètes.

    Accessible uniquement aux admins.

    Retour :
        {
          "ok": true,
          "cleared": {
            "context_size_was_cached": true,
            "llm_params_entries_cleared": 2,
            "vision_entries_cleared": 3
          }
        }
    """
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    if not me or me["is_admin"] != 1:
        raise HTTPException(403, "Admin required")

    try:
        from llm_core import invalidate_all_model_caches
        summary = invalidate_all_model_caches()
    except Exception as e:
        raise HTTPException(500, f"Erreur invalidation cache : {e}")

    username = get_username_by_id(uid) or f"user_{uid}"
    await system_events.broadcast({
        "type":    "log",
        "message": f"[CACHE] Invalidation globale demandée par {username}",
        "level":   "INFO",
    })

    return {"ok": True, "cleared": summary}


@admin_router.get("/api/admin/backup")
def api_admin_backup(request: Request, scope: str = "full"):
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    if not me or me["is_admin"] != 1: raise HTTPException(403, "Admin required")
    if scope not in ("full", "db", "sandboxes", "mcp"):
        raise HTTPException(400, "scope invalide")
    tmp_path, filename = _make_backup_zip(scope)
    from shared_infra.routes._helpers import backup_incomplete
    entetes = {"X-Backup-Incomplete": "1"} if backup_incomplete(filename) else None
    return FileResponse(tmp_path, media_type="application/zip", filename=filename,
                        headers=entetes, background=BackgroundTask(os.remove, tmp_path))


def _dest_under(base: Path, rel: str) -> Path:
    """Destination d'une entrée de zip, PROUVÉE sous ``base``.

    Les noms viennent du zip (fichier uploadé, ou rapatrié d'une cible de
    sauvegarde distante) : ``user_db/../../.bashrc`` ou un chemin absolu
    écrivaient n'importe où avec les droits de l'app (zip-slip)."""
    racine = base.resolve()
    dest = (racine / rel).resolve()
    if dest == racine or not dest.is_relative_to(racine):
        raise ValueError("chemin hors du dossier cible")
    return dest


def _restore_db_from(source: Path, db_path: Path) -> None:
    """Remplace le CONTENU de la base vivante par celui de ``source``.

    Plus d'écriture octet par octet sur ``app.db`` : les workers y tiennent
    des connexions (pool par thread) et un ``-wal`` en cours, et écraser le
    fichier sous eux le corrompait. L'API de sauvegarde de SQLite copie page à
    page en passant par son verrouillage ; les autres connexions voient la
    base restaurée à leur transaction suivante, et elle reste en WAL."""
    src = sqlite3.connect(str(source))
    try:
        verdict = src.execute("PRAGMA integrity_check").fetchone()
        if not verdict or verdict[0] != "ok":
            raise ValueError("base de la sauvegarde corrompue : "
                             f"{verdict[0] if verdict else '?'}")
        dst = sqlite3.connect(str(db_path), timeout=30)
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()


def _restaurer_work(zf: zipfile.ZipFile, user_id: int, lot: list, restored: list,
                    errors: list) -> None:
    """Fichiers ``(entrée, chemin sous /work)`` du /work d'un compte, écrits
    par l'agent de sa sandbox (démarrée au besoin), jamais par l'hôte. Appelé
    hors boucle d'événements (thread de la restauration)."""
    from shared_infra.sandbox.exec_bridge import agent_for

    async def ecrire() -> None:
        agent = agent_for(user_id)
        for i, (entry, rel) in enumerate(lot):
            try:
                await agent.write(rel, zf.read(entry), parents=True)
                restored.append(entry)
            except AgentError as e:
                if e.status:                              # refus sur ce fichier
                    errors.append(f"{entry}: {e.code}")
                    continue
                errors.extend(f"{n}: {e.code}" for n, _r in lot[i:])   # agent injoignable
                return
    asyncio.run(ecrire())


def _restore_from_zip(zip_path: Path, scope: str, *, db_path: Path,
                      user_db_dir: Path, sandbox_dir: Path,
                      mcp_dir: Path) -> tuple:
    """Extrait une sauvegarde admin : ``(restaurés, erreurs, base_remplacée)``.

    Fonction de module, dépendances en paramètres : testable sans la route
    (même méthode que ``_cloturer_run``)."""
    restored: list = []
    errors: list = []
    db_replaced = False
    fichiers_base = {db_path.name + s for s in ("",) + _DB_ANNEXES}

    def _ecrire(entry: str, base: Path, rel: str, data: bytes,
                prive: bool = False, beneath: bool = False) -> None:
        try:
            if beneath:
                # Arbre écrit par les conteneurs : sans suivre de lien, dossiers
                # intermédiaires compris (2026-09-29).
                base.mkdir(parents=True, exist_ok=True)
                write_beneath(base, rel, data)
            else:
                dest = _dest_under(base, rel)
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(data)
                if prive:
                    os.chmod(dest, 0o600)
            restored.append(entry)
        except (OSError, ValueError) as e:
            errors.append(f"{entry}: {e}")

    with zipfile.ZipFile(str(zip_path), "r") as zf:
        names = [n for n in zf.namelist() if not n.endswith("/")]

        if scope in ("full", "db"):
            # La base vient de ``db/<nom>``, jamais de sa copie brute dans
            # ``user_db/`` : les anciennes sauvegardes emportaient les deux,
            # ``-wal`` compris, capturés à des instants différents.
            sources = [n for n in names if n.startswith("db/")
                       and "/" not in n[3:] and not n.endswith(_DB_ANNEXES)]
            from shared_infra.db._connection import DB_BACKEND as _backend
            if sources and _backend != "sqlite":
                # Base active sur un serveur : écrire app.db ne restaurerait
                # rien (fichier inactif). Chemin sûr : revenir à SQLite,
                # restaurer, puis re-migrer — ou « python -m shared_infra.db
                # transfer » vers une base neuve.
                errors.append(f"{sources[0]}: base active sur {_backend} — restauration de la "
                              "base refusée (revenir à SQLite, restaurer, puis migrer)")
            elif sources:
                entry = f"db/{db_path.name}"
                if entry not in sources:
                    entry = sources[0]
                with tempfile.TemporaryDirectory() as tmpdir:
                    extrait = Path(tmpdir) / "restore.db"
                    extrait.write_bytes(zf.read(entry))
                    try:
                        _restore_db_from(extrait, db_path)
                        restored.append(entry)
                        db_replaced = True
                    except (sqlite3.Error, ValueError) as e:
                        errors.append(f"{entry}: {e}")
            for entry in names:
                if not entry.startswith("user_db/"):
                    continue
                rel = entry[len("user_db/"):]
                if rel in fichiers_base or rel in _HOST_ONLY or rel.split("/", 1)[0] in _RUNTIME_DIRS:
                    continue
                # Secrets compris (clé de chiffrement, secret de session) :
                # jamais lisibles hors du compte de l'app.
                _ecrire(entry, user_db_dir, rel, zf.read(entry), prive=True)
            # Images générées sauvegardées à part (base hors de ``user_db/``) :
            # rendues à côté de la base.
            images = db_path.parent / "generated_images"
            for entry in names:
                if entry.startswith("generated_images/"):
                    _ecrire(entry, images, entry[len("generated_images/"):],
                            zf.read(entry), prive=True)

        if scope in ("full", "sandboxes"):
            # Le /work de chaque compte (``sandboxes/<compte>/work/…``) est écrit
            # par l'agent de sa sandbox (L4.5) ; le reste appartient à l'hôte.
            # Comptes lus APRÈS la base : ceux de la sauvegarde en « full ».
            from shared_infra.routes._helpers import _comptes_des_sandboxes
            comptes = _comptes_des_sandboxes()
            travaux: dict = {}
            for entry in names:
                if not entry.startswith("sandboxes/"):
                    continue
                rel = entry[len("sandboxes/"):]
                # Nom canonique d'abord : « alice/./work/x » ou « alice//work/x »
                # partaient sinon à l'hôte, droit dans /work (relecture finale).
                parts = [c for c in rel.split("/") if c not in ("", ".")]
                if ".." in parts or not parts:
                    errors.append(f"{entry}: nom non canonique, ignoré")
                    continue
                rel = "/".join(parts)
                if len(parts) > 2 and parts[1] == WORK_SUBDIR:
                    if parts[0] in comptes:
                        travaux.setdefault(comptes[parts[0]], []).append((entry, "/".join(parts[2:])))
                    else:
                        errors.append(f"{entry}: compte inconnu, /work non restauré")
                elif not (len(parts) > 1 and parts[1] == AGENT_RUN_DIR
                          or parts[0] in (RELAY_DIR, ".dl_spool")):
                    # Ni socket d'agent ou du relais Git, ni ancien spool :
                    # propres à l'hôte qui les a produits (sauvegardes antérieures).
                    _ecrire(entry, sandbox_dir, rel, zf.read(entry), beneath=True)
            for uid, lot in travaux.items():
                _restaurer_work(zf, uid, lot, restored, errors)

        if scope in ("full", "mcp"):
            for entry in names:
                if entry.startswith("mcp_custom_servers/"):
                    _ecrire(entry, mcp_dir, entry[len("mcp_custom_servers/"):],
                            zf.read(entry))

        if scope == "full":
            from shared_infra.config import SKINS_DIR as _SKINS_DIR, USER_SKILLS_DIR as _USER_SKILLS_DIR
            for prefix, base in (("user_skins/", Path(_SKINS_DIR)),
                                 ("user_skills/", Path(_USER_SKILLS_DIR))):
                for entry in names:
                    if entry.startswith(prefix):
                        _ecrire(entry, base, entry[len(prefix):], zf.read(entry))

    return restored, errors, db_replaced


@admin_router.post("/api/admin/restore")
async def api_admin_restore(request: Request, file: UploadFile = File(...), scope: str = Form("full")):
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    if not me or me["is_admin"] != 1: raise HTTPException(403, "Admin required")
    if scope not in ("full", "db", "sandboxes", "mcp"):
        raise HTTPException(400, "scope invalide")
    from shared_infra.config import DB_PATH as _DB_PATH, MCP_SERVERS_DIR as _MCP_DIR, SANDBOX_DIR as _SB_DIR
    from shared_infra.files.uploads import save_upload_bounded

    # Plafond large pour un backup admin (500 Mo). Override via env si besoin.
    _max_restore = int(os.environ.get("APP_MAX_RESTORE_MB", "500")) * 1024 * 1024

    # Fichier temp sur disque + copie streamée avec plafond → jamais
    # tout le zip en RAM. Avant : ``await file.read()`` chargeait l'ENTIER
    # zip (potentiellement plusieurs Go pour un full backup) avant même
    # de valider sa taille, OOM garanti.
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")  # noqa: SIM115 (fermé aussitôt, seul le nom sert)
    tmp.close()
    tmp_path = Path(tmp.name)
    try:
        written = await save_upload_bounded(file, tmp_path, _max_restore)
        if written == 0:
            raise HTTPException(400, "Fichier vide")
    except HTTPException:
        try: tmp_path.unlink(missing_ok=True)
        except Exception: pass
        raise

    try:
        # Extraction déportée en thread : un restore de plusieurs centaines de
        # fichiers figeait l'event loop pendant 10-30 secondes.
        restored, errors, _ = await asyncio.to_thread(
            _restore_from_zip, tmp_path, scope,
            db_path=Path(_DB_PATH), user_db_dir=PROJECT_ROOT / "user_db",
            sandbox_dir=Path(_SB_DIR), mcp_dir=Path(_MCP_DIR))
    except zipfile.BadZipFile:
        raise HTTPException(400, "Fichier ZIP invalide")
    finally:
        try: tmp_path.unlink(missing_ok=True)
        except Exception: pass

    return {
        "ok": True,
        "scope": scope,
        "restored": len(restored),
        "errors": errors,
        # Caches en mémoire (clé de chiffrement, réglages…) et migrations d'une
        # sauvegarde plus ancienne : seul un redémarrage recharge tout.
        "restart_required": any(r.startswith(("db/", "user_db/")) for r in restored),
    }


# ── Sauvegarde distante (SFTP par clé / dossier monté / rsync) ───────────────
def _admin_or_403(request: Request) -> None:
    uid = require_user_id(request)
    me = get_user_by_id(uid)
    if not me or me["is_admin"] != 1:
        raise HTTPException(403, "Admin required")


@admin_router.get("/api/admin/backup/remote")
def api_admin_backup_remote_get(request: Request):
    """Config d'envoi distant (sans secret — key_path est un chemin)."""
    _admin_or_403(request)
    from shared_infra.ops import backup_remote
    cfg = backup_remote.get_remote_config()
    return JSONResponse(cfg, headers={"Cache-Control": "no-cache"})


@admin_router.post("/api/admin/backup/remote")
async def api_admin_backup_remote_save(request: Request):
    """Enregistre la config (host/connector/path…). Ne touche jamais à la clé."""
    _admin_or_403(request)
    from shared_infra.ops import backup_remote
    body = await request.json()
    ok, err = backup_remote.validate_remote_config(backup_remote.normalize_remote_config(body))
    if not ok and (body or {}).get("enabled"):
        raise HTTPException(400, err)
    saved = backup_remote.save_remote_config(body)
    return JSONResponse({"ok": True, "config": saved})


@admin_router.post("/api/admin/backup/remote/key")
async def api_admin_backup_remote_key(request: Request):
    """Téléverse la clé privée SSH (stockée 0600 hors config.json)."""
    _admin_or_403(request)
    from shared_infra.ops import backup_remote
    body = await request.json()
    key = (body or {}).get("key") or ""
    if not isinstance(key, str) or "PRIVATE KEY" not in key:
        raise HTTPException(400, "Clé privée invalide (format PEM/OpenSSH attendu)")
    path = backup_remote.store_ssh_key(key)
    fp = await backup_remote.key_fingerprint(path)
    return JSONResponse({"ok": True, "fingerprint": fp})


@admin_router.post("/api/admin/backup/remote/password")
async def api_admin_backup_remote_password(request: Request):
    """Mot de passe SSH du connecteur rsync (stocké 0600 hors config.json,
    jamais relu par l'API). Vide = retrait."""
    _admin_or_403(request)
    from shared_infra.ops import backup_remote
    body = await request.json()
    pwd = (body or {}).get("password")
    if not isinstance(pwd, str) or len(pwd) > 1024:
        raise HTTPException(400, "Mot de passe invalide")
    try:
        present = backup_remote.store_rsync_password(pwd)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return JSONResponse({"ok": True, "password_present": present})


@admin_router.post("/api/admin/backup/remote/test")
async def api_admin_backup_remote_test(request: Request):
    """Teste la connexion / l'inscriptibilité de la destination."""
    _admin_or_403(request)
    from shared_infra.ops import backup_remote
    res = await backup_remote.run_test()
    return JSONResponse(res)


@admin_router.post("/api/admin/backup/remote/send")
async def api_admin_backup_remote_send(request: Request):
    """Construit une sauvegarde et l'envoie à la destination configurée."""
    _admin_or_403(request)
    from shared_infra.ops import backup_remote
    try:
        body = await request.json()
    except Exception:
        body = {}
    res = await backup_remote.run_send((body or {}).get("scope"))
    return JSONResponse(res)
