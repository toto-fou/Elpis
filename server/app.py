# SPDX-License-Identifier: MIT
# app.py
try:
    import uvloop
    uvloop.install()
except ImportError:
    pass

import atexit
import logging
import os  # utilisé par _kill_mcp_subprocesses_sync (os.getpid) au top-level
            # pour que l'atexit handler ne lève pas NameError (sinon cleanup
            # MCP orphelins au shutdown jamais effectué → fuite RAM/process).
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.sessions import SessionMiddleware

from shared_infra.config import (
    SESSION_SECRET, read_config_json, session_cookie_attrs,
)
from shared_infra.db import init_db
from shared_infra.routes import (
    admin_router,
    register_chatbot_routes,
)
from shared_infra.observability.routes_usage import (
    router,
)
from shared_infra.routes.admin import internal_router
from shared_infra.observability.access_logging import (
    RequestLoggingMiddleware,
    configure as configure_access_logging,
    log_event,
)
from shared_infra.security.csrf import CsrfGuardMiddleware

logger = logging.getLogger("uvicorn.error")

# ─────────────────────────────────────────────────────────────────────────────
#  APP_MODE — selects which subset of routes to mount.
#
#  ``main``  : everything EXCEPT /api/admin/* and /admin (the user-facing
#              process; smaller HTTP attack surface). Default if unset.
#  ``admin`` : ONLY auth, system-events, /api/admin/* and the admin static
#              page, in its own process (same unprivileged user: no admin
#              action needs root).
#  ``full``  : both — single-process behaviour for dev, only when asked for
#              explicitly.
#
#  The split is enforced AT MOUNT TIME — when APP_MODE=main, ``admin_router``
#  is simply never registered, so its endpoints are absent from the FastAPI
#  app's route table and from /docs. There is no runtime authorization
#  short-circuit (no risk of bypass).
# ─────────────────────────────────────────────────────────────────────────────
def _resolve_app_mode(raw: str | None) -> str:
    """``APP_MODE`` absent ou invalide ⇒ ``main``. Avant : ``full``, qui
    montait en silence la console d'admin sur le port public dès qu'un
    lancement oubliait la variable."""
    mode = (raw or "").strip().lower()
    if not mode:
        return "main"
    if mode not in ("main", "admin", "full"):
        logger.warning("[startup] APP_MODE='%s' invalide — repli sur 'main'", raw)
        return "main"
    return mode


APP_MODE = _resolve_app_mode(os.environ.get("APP_MODE"))

# ─────────────────────────────────────────────────────────────────────────────
#  APP_PROFILE — historiquement le levier qui sélectionnait l'applicatif servi
#  (chatbot vs agentic). L'agentic a été retiré (remplacé par Flowise, service
#  externe) : seul le profil ``chatbot`` subsiste. La variable est conservée pour
#  compat avec ``chatbot_app.asgi`` / les scripts de démarrage, mais toute valeur
#  est ramenée à ``chatbot``.
# ─────────────────────────────────────────────────────────────────────────────
APP_PROFILE = os.environ.get("APP_PROFILE", "chatbot").lower()
if APP_PROFILE != "chatbot":
    logger.warning(
        "[startup] APP_PROFILE='%s' obsolète (agentic retiré) — fallback sur 'chatbot'",
        APP_PROFILE,
    )
    APP_PROFILE = "chatbot"

# Service tag used by access_logging (visible in the unified log file).
APP_SERVICE = os.environ.get("APP_SERVICE", "main" if APP_MODE != "admin" else "admin").lower()
configure_access_logging(APP_SERVICE)


def _kill_all_terminals():
    """Kill all PTY terminal sessions. Safe to call multiple times."""
    try:
        from shared_infra.terminal.routes import _terminals, _kill_terminal
        count = len(_terminals)
        for _uid, state in list(_terminals.items()):
            try:
                _kill_terminal(state)
            except Exception:
                pass
        _terminals.clear()
        if count:
            logger.info(f"[SHUTDOWN] {count} terminal(s) killed")
    except Exception:
        pass


def _kill_mcp_subprocesses_sync():
    """Filet de sécurité atexit pour les subprocess MCP stdio.

    Si le worker meurt sans passer par le lifespan shutdown (crash,
    uvicorn qui skip le shutdown hook, SIGTERM pendant un blocage…),
    les subprocess stdio MCP sont ré-parentés à init et consomment de
    la RAM jusqu'au reboot de la machine.

    On ne peut pas await ``mcp_pool.close_all()`` depuis atexit
    (pas d'event loop), donc on identifie les processus enfants via
    ``psutil`` et on leur envoie SIGTERM en best-effort.

    BUG FIX (élevé) — avant : tous les enfants étaient terminés
    aveuglément, y compris d'éventuels subprocess utilisés par d'autres
    parties du code (HAR/screenshot helpers, hooks de déploiement
    custom, etc.). On filtre maintenant par cmdline pour ne tuer QUE
    les processus qui ressemblent à des serveurs MCP — Python qui
    exécute un script ``*mcp_server*.py`` ou ``local_mcp_server.py``,
    ou le binaire ``MCP_SERVER_CMD`` configuré.
    """
    try:
        import psutil
        me = psutil.Process(os.getpid())
        children = me.children(recursive=True)
        if not children:
            return

        # Découverte du pattern de cmdline MCP attendu — config-driven.
        # On reste tolérant : si la config est inaccessible, on retombe
        # sur le pattern par défaut "mcp_server".
        try:
            from shared_infra.config import MCP_SERVER_CMD as _MCP_CMD
            _mcp_cmd_basename = os.path.basename(str(_MCP_CMD)).strip()
        except Exception:
            _mcp_cmd_basename = "local_mcp_server.py"

        def _looks_like_mcp(proc: "psutil.Process") -> bool:
            try:
                cmdline = " ".join(proc.cmdline()).lower()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                return False
            if not cmdline:
                return False
            # Heuristique : Python qui exécute un script MCP, OU le binaire
            # MCP configuré apparaît dans la cmdline. Couvre stdio MCP servers
            # (par défaut dans ce projet : un script Python).
            if _mcp_cmd_basename and _mcp_cmd_basename.lower() in cmdline:
                return True
            if "mcp" in cmdline and ("python" in cmdline or "node" in cmdline):
                return True
            # Filename pattern fréquent côté serveurs MCP communautaires
            if "mcp_server" in cmdline or "mcp-server" in cmdline:
                return True
            return False

        targets = [p for p in children if _looks_like_mcp(p)]
        if not targets:
            logger.info(
                f"[SHUTDOWN/atexit] {len(children)} enfant(s) trouvé(s), "
                "aucun ne ressemble à un MCP server — skip."
            )
            return

        for p in targets:
            try:
                p.terminate()
            except Exception:
                pass
        # Laisse 2s pour un exit propre, puis SIGKILL les récalcitrants.
        gone, alive = psutil.wait_procs(targets, timeout=2.0)
        for p in alive:
            try:
                p.kill()
            except Exception:
                pass
        logger.info(
            f"[SHUTDOWN/atexit] {len(targets)} subprocess MCP "
            f"terminé(s) ({len(alive)} via SIGKILL) — "
            f"{len(children) - len(targets)} autre(s) enfant(s) "
            "préservé(s)."
        )
    except Exception:
        pass


# Safety net: atexit runs even on SIGTERM/SIGINT if the process
# doesn't get SIGKILL. This catches cases where lifespan doesn't fire.
# Ordre d'enregistrement = ordre INVERSE d'exécution : psutil tuera
# d'abord les PTY bash qui restent après _kill_all_terminals (redondant
# mais safe), puis continuera avec les MCP stdio orphelins.
atexit.register(_kill_all_terminals)
atexit.register(_kill_mcp_subprocesses_sync)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── Startup ──
    # NOTE — plafond du pool de threads d'anyio (40 jetons par défaut, là où
    # s'exécutent les 196 routes déclarées ``def``) : HYPOTHÈSE TESTÉE PUIS
    # ÉCARTÉE, ne pas la re-proposer sans nouvelle mesure.
    #
    # Sous 60 utilisateurs sur les routes disque (tests/load, bac à sable de
    # 500 fichiers, 3 workers), la latence est bien multipliée par 18 à 300
    # selon les routes. Mais le pool n'y est pour rien : les workers ne
    # montaient qu'à ~34 threads, soit EN DESSOUS du plafond, et le porter à
    # 120 ne change rien (22,7 → 22,5 req/s ; témoin p99 1015 → 925 ms, dans
    # le bruit). Le CPU, lui, plafonne à 66 % de la machine — pas saturé non
    # plus.
    #
    # Ce qui sature est ailleurs : chaque worker est UN interpréteur, donc un
    # seul GIL. Vingt parcours d'arborescence simultanés dans le même worker
    # se sérialisent sur du travail Python (os.walk + sérialisation JSON), et
    # aucun réglage de pool n'y changera rien. Les leviers réels sont : rendre
    # ces routes moins coûteuses, ou ajouter des workers.
    #
    # Détection non-bloquante des capacités llama-server pour résoudre le
    # mode "auto" vers "optimized" ou "classic". 3s de timeout max : si
    # llama n'est pas prêt, on retombe sur "classic" silencieusement.
    # Le probe peut être re-déclenché à tout moment via l'endpoint
    # POST /api/admin/llm-capabilities/probe.
    # AUDIT 2026-08-02 (E13) — via _register_bg_task : le create_task nu ne
    # gardait AUCUNE référence forte (tâche potentiellement GC avant son
    # premier await) et son exception éventuelle n'était jamais consultée —
    # la détection de capacités (grammaire tool-calling, vision) sautait
    # alors en silence, dégradant le premier chat sans diagnostic.
    try:
        from llm_core import detect_llama_capabilities
        from shared_infra.observability.events_bus import _register_bg_task
        import asyncio as _asyncio
        _register_bg_task(_asyncio.create_task(detect_llama_capabilities(timeout_s=3.0)))
    except Exception as e:
        logger.warning(f"[STARTUP] detect_llama_capabilities schedule failed: {e}")

    # Cross-process metric / control-event tailer.
    # IMPORTANT: this MUST be wired through the lifespan context manager,
    # NOT via @app.on_event("startup"). When a FastAPI app is constructed
    # with ``lifespan=...``, Starlette ≥ 0.27 silently ignores every
    # ``@app.on_event("startup"|"shutdown")`` decorator — no warning is
    # emitted, the handlers just never fire. We learnt that the hard way
    # in v3.7-v3.9 when the metric_broadcast tailer never started on any
    # worker (no log line, no events delivered, restart popups missing
    # on the user side, dashboard KPIs never auto-refreshed).
    #
    # The tailer reads /tmp/elpis_metric_events.jsonl and re-broadcasts
    # each line on this worker's local system_events SSE bus. Same file
    # is shared by every Elpis process (main + admin), so a metric or
    # restart event published anywhere reaches every connected client
    # within ~100 ms.
    try:
        from shared_infra.observability.metrics import broadcast as metric_broadcast
        from shared_infra.routes._legacy import system_events
        metric_broadcast.start_metric_tailer(system_events)
    except Exception as e:
        logger.warning(f"[STARTUP] metric_broadcast tailer schedule failed: {e}")

    # Annulations de chat cross-worker. Même mécanique (spool /tmp + flock),
    # mais canal SÉPARÉ du bus system_events : celui-ci diffuse à tout
    # utilisateur authentifié, or une annulation porte le user_id et le chat_id
    # de son émetteur. Sans ce tailer, un Stop reçu par un worker qui n'exécute
    # rien restait sans effet — la génération continuait sur son worker et
    # persistait le tour malgré l'« annulé » affiché côté UI.
    # Le MÊME canal porte les annulations de SOUS-AGENTS (outil ``task``,
    # ``kind="child"``), aiguillées vers ``task_tool`` : un enfant n'est pas un
    # chat, la demande ne doit surtout pas tuer le tour parent. Sans elle, le ✕
    # d'un agent n'agissait que dans le worker ayant reçu le POST.
    try:
        from shared_infra.runtime.cancel_bus import start_cancel_tailer
        from shared_infra.routes._state import apply_remote_cancellation
        from llm_core.tools.task_tool import apply_child_cancel

        def _apply_child(username: str, child_id: str, _ts: float) -> None:
            apply_child_cancel(username, child_id)

        start_cancel_tailer(apply_remote_cancellation, _apply_child)
    except Exception as e:
        logger.warning(f"[STARTUP] cancel_bus tailer schedule failed: {e}")

    # « Redémarrage nécessaire » (console admin, lot 6) : empreinte des
    # réglages lus au démarrage par le process PRINCIPAL — celui que le bouton
    # Redémarrer relance. La console la compare au fichier courant.
    if APP_MODE != "admin":
        try:
            from shared_infra.ops.restart_pending import record as _record_boot
            _record_boot(APP_MODE)
        except Exception as e:
            logger.warning(f"[STARTUP] empreinte de démarrage non écrite: {e}")

    # Pre-spawn the local MCP server in the background so the first chat
    # after a cold start doesn't pay the subprocess + handshake +
    # list_tools cost (~300-800 ms typically). The tailer above must
    # already be wired before we yield, but the MCP pre-warm runs
    # concurrently as a fire-and-forget — it MUST NOT block lifespan
    # startup, otherwise uvicorn delays accepting traffic.
    #
    # Skipped in admin-only mode (``APP_MODE=admin``): the admin process
    # *does* now occasionally invoke the local MCP (the Outils MCP tab
    # goes through the pool on demand — routes ``/api/mcp/*``), but
    # warming it at boot would waste RAM on a process that idles 99 %
    # of the time. The first admin tab open pays ~500 ms — acceptable.
    if APP_MODE != "admin":
        try:
            from shared_infra.mcp.panel import prewarm_mcp_pool
            from shared_infra.observability.events_bus import _register_bg_task
            import asyncio as _asyncio
            # AUDIT 2026-08-02 (E13) — réf forte + log d'exception via le
            # registre bg-tasks (cf. detect_llama_capabilities ci-dessus).
            _register_bg_task(_asyncio.create_task(prewarm_mcp_pool()))
        except Exception as e:
            logger.warning(f"[STARTUP] prewarm_mcp_pool schedule failed: {e}")

    # Démarre le scheduler cron + le cleanup PTY par-worker dès le boot,
    # sur CHAQUE worker. Avant, ``start_cron_scheduler()`` n'était
    # déclenché qu'au PREMIER hit HTTP /api/system-events ; un worker
    # recyclé (gunicorn max_requests=2000) qui ne servait ensuite que des
    # WebSockets /ws/terminal ne lançait jamais son ``_local_cleanup_loop``
    # → ses PTY (bash + master_fd) n'étaient jamais reapés (fuite fd/RAM
    # sur plusieurs jours). ``start_cron_scheduler`` est idempotent : le
    # hit /api/system-events legacy reste un no-op inoffensif.
    try:
        from shared_infra.observability.events_bus import start_cron_scheduler
        start_cron_scheduler()
    except Exception as e:
        logger.warning(f"[STARTUP] start_cron_scheduler failed: {e}")

    # Scheduler des routines planifiées (tâches récurrentes). Démarré sur chaque
    # worker DU CHATBOT, mais seul le LEADER (élu via cron_lock, re-sondé à
    # chaque tick) évalue/lance les runs → pas de double-fire, failover auto au
    # recyclage. PAS en mode admin : le process admin participerait à l'élection
    # de leader et exécuterait les runs LLM des utilisateurs chez lui (1 worker,
    # pas de prewarm MCP) — les workers main suffisent.
    if APP_MODE != "admin":
        try:
            from shared_infra.scheduling.routines_scheduler import start_routines_scheduler
            start_routines_scheduler()
        except Exception as e:
            logger.warning(f"[STARTUP] start_routines_scheduler failed: {e}")
        # Entretien périodique (uptime longue durée) : passe quotidienne sur le
        # worker leader (cron_lock) — purge des télémétries + checkpoint WAL +
        # digest. Indispensable car ces purges n'étaient jadis faites qu'au boot
        # (jamais ré-exécutées sur un serveur qui ne reboote pas pendant des mois).
        try:
            from shared_infra.ops.maintenance import start_maintenance_scheduler
            start_maintenance_scheduler()
        except Exception as e:
            logger.warning(f"[STARTUP] start_maintenance_scheduler failed: {e}")
        # Sauvegarde distante automatique (2026-09-21) : « toutes les N
        # heures/jours », leader-only (cron_lock), réglée dans l'admin.
        try:
            from shared_infra.ops.backup_scheduler import start_backup_scheduler
            start_backup_scheduler()
        except Exception as e:
            logger.warning(f"[STARTUP] start_backup_scheduler failed: {e}")

    # Sampler de métriques per-process : persiste RSS/fd/threads/WAL + compteurs
    # applicatifs (tasks chat, PTY, clients SSE, bg-tasks, routines) dans
    # metric_events, sur CHAQUE worker. Permet de diagnostiquer une fuite lente
    # (le « pourquoi on redémarre chaque semaine ») via la tendance 7j du
    # dashboard, au lieu de redémarrer à l'aveugle. Idempotent par worker.
    try:
        from shared_infra.observability.metrics.process_sampler import start_process_sampler
        start_process_sampler()
    except Exception as e:
        logger.warning(f"[STARTUP] start_process_sampler failed: {e}")

    # AUDIT 2026-08-02 (W8, révisé « recyclage invisible ») — quand CE worker
    # entame son shutdown (``AppStatus.should_exit`` : posé par sse-starlette
    # sur SIGTERM et par notre patch de ``Server.shutdown`` sur le chemin
    # max_requests), on ÉVACUE les flux infinis au lieu d'afficher une
    # bannière : un recyclage de worker doit être INVISIBLE (les autres
    # workers servent — SO_REUSEPORT). Les clients reçoivent une fin de flux
    # propre précédée de ``worker_recycling`` et se rebranchent en ~1 s sur
    # un worker sain, sans le moindre signe à l'écran. La bannière
    # « redémarrage » reste réservée au VRAI restart complet, publié
    # explicitement sur le bus fichier par les endpoints admin (lifecycle).
    # Les générations LLM en cours, elles, ne sont PAS coupées : le drain
    # uvicorn (timeout_graceful_shutdown=300 s) les laisse se terminer
    # normalement — la socket d'écoute étant fermée, ce drain est invisible.
    try:
        from shared_infra.observability.events_bus import (
            _register_bg_task, pipeline_events, system_events,
        )

        async def _evacuate_streams_on_shutdown():
            try:
                from sse_starlette.sse import AppStatus
            except Exception:
                return
            import asyncio as _aio
            # Drapeau posé par le gestionnaire de signal, sans événement associé.
            while not AppStatus.should_exit:  # noqa: ASYNC110
                await _aio.sleep(0.25)
            # 1. SSE système : fin propre + hint de reconnexion silencieuse.
            try:
                n_sys = system_events.disconnect_user(
                    None, message={"type": "worker_recycling"})
            except Exception:
                n_sys = 0
            # 2. SSE pipeline (per-user) : même hint, puis sentinelle — la page
            #    Code se rebranche et resynchronise son état (2026-09-25, B8).
            try:
                n_pipe = pipeline_events.disconnect_all(
                    message={"type": "worker_recycling"})
            except Exception:
                n_pipe = 0
            # 3. Terminaux : le PTY est un enfant du worker, il meurt avec
            #    lui quoi qu'il arrive. Le tuer MAINTENANT ferme le WS → le
            #    client rouvre immédiatement un shell (neuf, avec le
            #    séparateur W5) sur un worker sain, au lieu d'un terminal
            #    figé jusqu'à la mort du worker.
            try:
                from shared_infra.terminal.pty import shutdown_all_terminals
                shutdown_all_terminals()
            except Exception:
                pass
            if n_sys or n_pipe:
                logger.info(
                    "[SHUTDOWN] évacuation : %d flux système, %d flux pipeline "
                    "renvoyés vers les workers sains", n_sys, n_pipe)

        import asyncio as _asyncio
        _register_bg_task(_asyncio.create_task(_evacuate_streams_on_shutdown()))
    except Exception as e:
        logger.warning(f"[STARTUP] stream evacuation watcher schedule failed: {e}")

    yield
    # ── Shutdown ──
    logger.info("[SHUTDOWN] Cleaning up…")
    # Cancel les background loops (model poller, cleanup, cron). Sans ça,
    # uvicorn attend graceful_timeout en vain puis SIGKILL le worker —
    # auquel cas mcp_pool.close_all() ci-dessous n'a jamais tourné et
    # les subprocess MCP sont orphelinés.
    try:
        from shared_infra.routes._legacy import shutdown_bg_tasks
        n = await shutdown_bg_tasks()
        if n:
            logger.info(f"[SHUTDOWN] {n} background task(s) cancel(ées)")
    except Exception as e:
        logger.warning(f"[SHUTDOWN] shutdown_bg_tasks: {e}")
    # AUDIT 2026-08-02 (W4) — libérer le verrou leader IMMÉDIATEMENT après
    # l'arrêt des schedulers (ils sont annulés juste au-dessus, donc plus
    # aucune re-acquisition possible), et AVANT les drains qui peuvent
    # prendre plusieurs secondes. Avant, c'était la DERNIÈRE étape du
    # shutdown : pendant tout le drain, les workers survivants ne pouvaient
    # pas prendre le leadership et aucune routine ne partait.
    try:
        from shared_infra.scheduling.cron_lock import release_cron_lock
        release_cron_lock()
    except Exception:
        pass
    # AUDIT 2026-08-02 (m14) — drainer AUSSI les registres bg-tasks locaux
    # de routes/tools.py et chatbot_app/routes/chats.py : seuls ceux de
    # _events_bus étaient annulés, les autres étaient abandonnés en vol.
    for _mod_path, _attr in (("shared_infra.routes.tools", "_BG_TASKS"),
                             ("chatbot_app.routes.chats", "_BG_TASKS")):
        try:
            import importlib as _importlib
            _mod = _importlib.import_module(_mod_path)
            _tasks = [t for t in getattr(_mod, _attr, set()) if not t.done()]
            for _t in _tasks:
                _t.cancel()
            if _tasks:
                import asyncio as _aio
                await _aio.gather(*_tasks, return_exceptions=True)
                logger.info(f"[SHUTDOWN] {len(_tasks)} task(s) {_mod_path} cancel(ées)")
        except Exception as e:
            logger.warning(f"[SHUTDOWN] drain {_mod_path}: {e}")
    # Drain des runs de routine AVANT la fermeture du pool MCP / client LLM :
    # annulés proprement, ils prennent le chemin CancelledError (journal
    # « annulé », pas de notification). Sans ce drain, shutdown_mcp_pool()
    # fermait le client httpx sous leurs pieds → exception ≠ CancelledError →
    # fausse notif « Routine en échec » à chaque restart / recycle de worker.
    try:
        from shared_infra.scheduling.routines_scheduler import drain_running_runs
        n = await drain_running_runs()
        if n:
            logger.info(f"[SHUTDOWN] {n} run(s) de routine annulé(s)")
    except Exception as e:
        logger.warning(f"[SHUTDOWN] drain_running_runs: {e}")
    # (release_cron_lock déplacé en tête de shutdown — audit 2026-08-02, W4.)
    # Ferme le pool MCP ET le client httpx partagé vers llama-server.
    # Sans ça, à chaque recycle de worker (gunicorn ``max_requests=2000``) :
    #   - les subprocess stdio MCP sont ré-parentés à init (RAM qui ne
    #     redescend jamais jusqu'au reboot),
    #   - le connection pool httpx (LLAMA_MAX_CONCURRENCY keepalive TCP
    #     sockets) est laissé ouvert côté llama-server.
    # ``shutdown_mcp_pool`` enchaîne mcp_pool.close_all() + close_llm_client().
    # Historiquement défini mais jamais câblé à l'app — corrigé ici.
    try:
        from shared_infra.mcp.panel import shutdown_mcp_pool
        await shutdown_mcp_pool()
    except Exception as e:
        logger.warning(f"[SHUTDOWN] shutdown_mcp_pool: {e}")
    _kill_all_terminals()
    # AUDIT 2026-08-01 (M1) — arrêter l'abonnement ``docker events``.
    # ``stop_events()`` existait mais n'avait AUCUN appelant : le thread est
    # ``daemon``, donc tué sans exécuter son ``finally`` à la sortie de
    # l'interpréteur — et le ``subprocess.Popen(docker events)`` qu'il
    # supervise, étant un processus SÉPARÉ, survivait réparenté à init. Avec
    # ``max_requests=2000``, chaque recyclage de worker en laissait un de plus,
    # avec son stream vers l'API Docker, jusqu'au reboot de la machine.
    try:
        from shared_infra.sandbox.executors._readiness import get_readiness_cache
        get_readiness_cache().stop_events()
        logger.info("[SHUTDOWN] docker events subscriber arrêté")
    except Exception as e:
        logger.warning(f"[SHUTDOWN] stop_events: {e}")
    logger.info("[SHUTDOWN] Done")


def create_app() -> FastAPI:
    title_suffix = {
        "main":  "",
        "admin": " (Admin)",
        "full":  "",
    }.get(APP_MODE, "")
    app = FastAPI(title=f"Elpis CHATBOT{title_suffix}", lifespan=lifespan)

    # ── CORS ──
    _cfg = read_config_json() or {}
    _cors_origins = _cfg.get("app", {}).get("cors_origins", [])
    if _cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=_cors_origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )
        logger.info(
            "[startup] CORS activé pour %d origine(s) : %s",
            len(_cors_origins), ", ".join(_cors_origins),
        )
    else:
        # BUG FIX (mineur) : avant, si ``cors_origins`` était vide ou
        # absent du config.json, AUCUN middleware CORS n'était ajouté
        # mais sans le moindre log → l'opérateur ne savait pas si CORS
        # était "off par décision" ou "off par oubli de config". Ce log
        # explicite lève l'ambiguïté à chaque boot.
        logger.info(
            "[startup] CORS désactivé (app.cors_origins absent ou vide dans "
            "config.json). Les requêtes cross-origin seront bloquées par "
            "le navigateur."
        )

    # ── SessionMiddleware ────────────────────────────────────────────────
    # Cookie attributes are read from config.json:security.session at boot
    # so operators can adjust same-site / https-only / cookie name without
    # patching this file. Defaults match the historical hard-coded values.
    #
    # NOTE: changes to these attributes only take effect after a gunicorn
    # restart, because Starlette's SessionMiddleware caches them per-app.
    # The admin UI's "Reboot" button handles that. The sub-second runtime
    # checks (max_age, global revocation, per-user revocation) are
    # re-read on every request — those don't need a restart.
    # M7 — source UNIQUE des attributs de cookie (partagée avec le logout de
    # routes/auth.py) : les deux dérivations parallèles pouvaient diverger et
    # rendre la suppression du cookie inopérante sur Chrome/Safari.
    # ── Relais vers un hôte d'outils DISTANT (2026-09-11, P4) ────────────
    # Ajouté AVANT SessionMiddleware (et la garde CSRF) : Starlette empile les
    # middlewares en ordre inverse d'ajout, celui-ci est donc INTÉRIEUR — il
    # voit la session vérifiée et n'agit que si ``mcp.json › sandboxHosts``
    # désigne un hôte hors loopback (sinon transparent).
    from shared_infra.sandbox.relay import SandboxRelayASGI
    app.add_middleware(SandboxRelayASGI)

    _cookie_attrs = session_cookie_attrs()
    _cookie_name = _cookie_attrs["cookie_name"]
    _same_site = _cookie_attrs["same_site"]
    _https_only = _cookie_attrs["https_only"]

    app.add_middleware(
        SessionMiddleware,
        secret_key=SESSION_SECRET,
        session_cookie=_cookie_name,
        same_site=_same_site,
        https_only=_https_only,
        # AUDIT 2026-08-02 (S6) — sans max_age explicite, Starlette posait
        # son défaut de 14 JOURS glissants (Set-Cookie réémis à chaque
        # requête) : cookie persistant qui survivait à la fermeture du
        # navigateur et restait signé-valide 14 j, alors que la gate
        # ``_login_ts`` de deps.py expire à security.session.max_age_sec
        # (24 h par défaut). Aligné sur la même source de config.
        max_age=_cookie_attrs["max_age"],
    )

    # ── Défense CSRF globale (audit 2026-08-01, E9) ──────────────────────
    # Le cookie de session est en SameSite=lax par défaut, ce qui n'arrête PAS
    # le same-site cross-origin (autre port, sous-domaine frère). La garde
    # `_reject_cross_site` existait mais n'était câblée que sur
    # change-password : 1 route mutante sur ~33. On l'applique ici à toutes.
    # Placé AVANT SessionMiddleware dans l'ordre d'ajout ⇒ s'exécute APRÈS lui
    # côté requête, mais la garde ne lit que les en-têtes et le cookie brut :
    # elle ne dépend pas de la session décodée.
    app.add_middleware(
        CsrfGuardMiddleware,
        cookie_name=_cookie_name,
        # Les webhooks entrants (Gitea → routines) arrivent SANS cookie, donc
        # passent déjà — mais un navigateur qui rejouerait l'URL avec un
        # cookie traînant ne doit pas non plus être bloqué : l'auth de ces
        # endpoints est le HMAC. L'aperçu de sandbox n'est plus exempté
        # (audit 2026-09-22, M8) : l'iframe passe par /api/sandbox/pvs/<jeton>/
        # (origine opaque, sans cookie, donc hors de cette garde) et la route
        # à session exige désormais une origine same-site pour un POST.
        exempt_prefixes=("/api/webhooks/",),
    )

    # En-têtes de sécurité par défaut (nosniff, Referrer-Policy,
    # frame-ancestors) — audit 2026-09-22, M4. Ajouté en dernier parmi les
    # gardes = le plus EXTÉRIEUR : couvre aussi les 403 CSRF et les erreurs.
    from shared_infra.security.headers import SecurityHeadersASGI

    # ── Unified observability ──
    # Logs every finished HTTP request (filtered) to user_db/logs/app.log.jsonl
    # AND broadcasts admin-relevant events to the live Logs tab via system_events.
    # Added AFTER SessionMiddleware so it can read request.session for user_id.
    app.add_middleware(RequestLoggingMiddleware)
    app.add_middleware(SecurityHeadersASGI)
    # Bascule de base en cours (page admin « Base de données ») : 503 sur les
    # écritures des process de l'ancienne génération.
    from shared_infra.ops.db_switch import MaintenanceASGI
    app.add_middleware(MaintenanceASGI)

    # Force UTF-8 charset on JS/CSS so byte-level encoding is unambiguous
    # in every browser, regardless of the OS-provided mimetypes database.
    # Without this, some distributions serve .js as "application/javascript"
    # without charset, and browsers may fall back to Latin-1 decoding, which
    # corrupts any non-ASCII char (e.g. a box-drawing "=" in a comment
    # becomes three illegal chars and crashes the parser at runtime).
    import mimetypes
    mimetypes.add_type("application/javascript; charset=utf-8", ".js")
    mimetypes.add_type("text/css; charset=utf-8", ".css")
    mimetypes.add_type("text/html; charset=utf-8", ".html")

    # ── Cache busting agressif pour les assets versionnés ─────────────────
    # StaticFiles par défaut envoie ETag + Last-Modified mais PAS de
    # Cache-Control strict — les navigateurs peuvent du coup re-utiliser
    # le cache disque pendant une session, même quand le fichier a
    # changé sur le serveur. Ça casse les déploiements à chaud (l'utilisateur
    # voit l'ancien JS / CSS sans s'en rendre compte).
    #
    # On wrappe StaticFiles avec une sous-classe qui force :
    #   - Cache-Control: no-cache, must-revalidate
    #   - les browsers doivent revalider à chaque requête (304 si pas de change)
    # Combiné avec le BUILD_ID dans les URLs (?v=...), la revalidation
    # est instantanée (304 Not Modified, 0 byte) tant que rien n'a changé,
    # mais immédiatement effective dès le redeploy.

    class _CacheBustingStaticFiles(StaticFiles):
        async def get_response(self, path, scope):
            response = await super().get_response(path, scope)
            try:
                # On ne touche QUE aux assets versionnés (JS/CSS/HTML).
                # Les images, fonts, etc. peuvent garder le cache long.
                if path.endswith((".js", ".css", ".html", ".mjs")):
                    # ── Vendor versionné par empreinte → immuable ─────────
                    # Un bundle tiers dont l'URL porte une empreinte de
                    # CONTENU (cf. routes/system.vendor_fingerprint) ne peut
                    # pas changer sous cette URL : le servir en ``immutable``
                    # supprime la revalidation à chaque visite, sans risque de
                    # version périmée — un fichier modifié obtient une AUTRE
                    # URL. Les assets applicatifs, eux, gardent le no-cache :
                    # leur ?v= est le BUILD_ID, et le choix assumé est qu'un
                    # redéploiement soit visible tout de suite.
                    #
                    # La garde porte sur la PRÉSENCE du paramètre : une
                    # requête vendor sans version (chargeur AMD de monaco,
                    # appel direct) retombe sur la politique prudente.
                    _qs = scope.get("query_string", b"") or b""
                    if path.startswith("vendor/") and b"v=" in _qs:
                        response.headers["Cache-Control"] = \
                            "public, max-age=31536000, immutable"
                    else:
                        response.headers["Cache-Control"] = "no-cache, must-revalidate"
                    # Retire les Expires éventuels (ils pourraient battre Cache-Control)
                    response.headers.pop("Expires", None)
            except Exception:
                pass
            return response

    # Frontend assets live in ``frontend/`` on disk but are served under the
    # stable ``/static`` URL prefix (kept for cache-busting, bookmarks and the
    # many relative ``static/...`` refs in the HTML — the URL is a runtime
    # contract, the directory name is just repo hygiene).
    app.mount("/static", _CacheBustingStaticFiles(directory="frontend"), name="static")

    # (Le repli 404 « refs absolues-racine d'une page en aperçu », qui lisait
    # le ``Referer``, est retiré le 2026-09-22 : sous origine opaque le
    # navigateur n'envoie plus le chemin du référent. Ces refs sont réécrites
    # à la source, cf. ``shared_infra/sandbox/preview_rewrite.py``.)

    # AUDIT 2026-08-02 (E12) — un corps JSON malformé sur l'un des ~64 sites
    # ``await request.json()`` sans garde (login inclus) produisait un 500
    # opaque « Internal Server Error » au lieu d'un 400. Un handler global
    # couvre tous les sites d'un coup : request.json() lève JSONDecodeError,
    # attrapé ici → 400 explicite. (P3.5 de AUDIT_BUGS.md, généralisé.)
    import json as _json_mod
    from fastapi.responses import JSONResponse as _JSONResponse

    @app.exception_handler(_json_mod.JSONDecodeError)
    async def _malformed_json_body(request, exc):
        return _JSONResponse(
            status_code=400,
            content={"detail": "Corps JSON invalide : " + str(exc)[:200]},
        )

    # AUDIT 2026-08-30 (S3) — même raisonnement que le handler ci-dessus, pour
    # deux familles d'entrée LIMITE qui produisaient un 500 opaque :
    #
    #   • ``OverflowError`` — un paramètre de chemin typé ``int`` n'a pas de
    #     borne haute en Python. Au-delà de 2**63 le driver SQLite refuse la
    #     conversion. 49 routes ont un tel paramètre (``/api/routines/{id}``,
    #     ``/api/prompts/{id}``, ``/api/admin/users/{id}``…) ; les borner une à
    #     une serait 49 occasions d'en oublier une, et la 50e arriverait.
    #   • ``OSError`` — tout chemin construit depuis l'entrée utilisateur :
    #     ENAMETOOLONG au-delà de 255 caractères par segment, ELOOP sur une
    #     boucle de liens symboliques. Les sites CONNUS sont corrigés
    #     localement (avatars, sandbox/serve, skills) avec le code qui convient
    #     à chacun — ce filet couvre ceux qu'on n'a pas encore vus.
    #
    # 400 et non 500 : l'entrée est invalide, le serveur va bien. Le détail
    # part dans les journaux, pas dans la réponse — un message d'``OSError``
    # porte le chemin absolu, donc l'arborescence du serveur.
    @app.exception_handler(OverflowError)
    async def _out_of_range_param(request, exc):
        logger.warning("[400] paramètre hors bornes sur %s : %r",
                       request.url.path, exc)
        return _JSONResponse(
            status_code=400, content={"detail": "Paramètre hors bornes."})

    # ``OSError`` est une famille très large : ENOSPC (disque plein), EACCES
    # (droits), ECONNRESET… sont des pannes SERVEUR, qui doivent rester des
    # 500 — les rendre en 400 dirait à l'utilisateur « votre requête est
    # invalide » pour un incident d'infrastructure, et masquerait l'alerte.
    # On ne requalifie donc que les errno qui décrivent une ENTRÉE que le
    # système de fichiers refuse de nommer ; tout le reste est re-levé et
    # suit son chemin normal vers le 500.
    import errno as _errno
    _BAD_INPUT_ERRNOS = {
        _errno.ENAMETOOLONG,   # segment > 255 octets
        _errno.ELOOP,          # boucle de liens symboliques
        _errno.EINVAL,         # octet interdit dans le nom (NUL…)
        _errno.EILSEQ,         # séquence d'octets invalide pour le FS
    }

    @app.exception_handler(OSError)
    async def _unusable_path(request, exc):
        if getattr(exc, "errno", None) not in _BAD_INPUT_ERRNOS:
            raise exc
        logger.warning("[400] chemin inutilisable sur %s : %r",
                       request.url.path, exc)
        return _JSONResponse(
            status_code=400, content={"detail": "Chemin ou nom de fichier invalide."})

    # Log le BUILD_ID au démarrage pour qu'on puisse vérifier que le
    # serveur sert bien la nouvelle version (côté navigateur, on peut
    # regarder l'URL d'un asset pour comparer).
    try:
        from shared_infra.config import BUILD_ID as _bid
        logger.info(f"[STARTUP] BUILD_ID={_bid} — assets statiques servis avec ce tag")
    except Exception:
        pass

    # ── DB ──
    init_db()

    # ── AX memory (persistent UI accessibility tree) ──
    try:
        from shared_infra.memory.ax import init_db as _init_ax_db
        _init_ax_db()
    except Exception as _e:
        logger.warning(f"[ax] init failed: {_e}")


    # ── Routes ──
    # The "main" router holds EVERY non-admin endpoint. It is mounted in
    # both ``main`` and ``full`` modes; the ``admin`` mode mounts only a
    # tiny subset of it explicitly via ``_mount_admin_required_subset``
    # below (auth + SSE + system-events).
    if APP_MODE in ("main", "full"):
        # Enregistrement des routes du chatbot sur le ``router`` partagé AVANT de
        # le monter (include_router copie l'état courant des routes). L'infra
        # commune est déjà enregistrée à l'import de shared_infra.routes.
        register_chatbot_routes()
        log_event("system", "INFO",
                  f"routes registered (APP_PROFILE={APP_PROFILE})")
        app.include_router(router)
    elif APP_MODE == "admin":
        # In admin mode, we still need auth/session/system-events to drive
        # the admin UI. Rather than mount the full router (which would
        # bring back the chat surface we wanted to remove), we mount only
        # the small, audited submodules that the admin UI strictly needs.
        _mount_admin_required_subset(app)

    # (2026-09-25) Plus de pont access_logging → system_events ici : chaque
    # worker suit le journal JSONL commun pour ses clients staff
    # (events_bus._staff_log_tail_loop), ce qui couvre tous les workers, le
    # service admin, et les lignes écrites depuis un thread.

    # ── Admin endpoints ──
    # Mounted in ``admin`` and ``full`` modes; absent from ``main``.
    # When absent, the FastAPI router has zero knowledge of /api/admin/*
    # → requests get a clean 404 with no clue that admin endpoints exist
    # somewhere else, no behaviour leak, no info disclosure.
    if APP_MODE in ("admin", "full"):
        app.include_router(admin_router)
        log_event("system", "INFO",
                  f"admin_router mounted (APP_MODE={APP_MODE}, "
                  f"{len(admin_router.routes)} endpoints)")
    else:
        log_event("system", "INFO",
                  "admin_router NOT mounted (APP_MODE=main, smaller surface)")

    # ── Internal control endpoints (loopback only) ──
    # Mounted on EVERY process regardless of APP_MODE, because they're
    # called process-to-process over 127.0.0.1. The handlers themselves
    # enforce the loopback restriction by checking ``request.client.host``.
    # In the split topology this is what lets the admin process tell
    # main to restart itself (admin clicks "Restart" in the dashboard
    # → POST main:8001/api/admin/internal/restart-self).
    app.include_router(internal_router)
    log_event("system", "INFO",
              f"internal_router mounted on all modes "
              f"({len(internal_router.routes)} endpoints, loopback-only)")

    # ── Admin static page ──
    # In admin mode the process serves an admin-only HTML at "/" and "/admin"
    # so a browser pointed at the admin port lands on a usable page.
    # In main mode we expose a small redirect at "/admin" that points to the
    # configured admin URL (env var ADMIN_PUBLIC_URL) — easier UX than a 404.
    if APP_MODE == "admin":
        from fastapi.responses import HTMLResponse, RedirectResponse
        from fastapi import Request as _Request

        @app.get("/", response_class=HTMLResponse)
        @app.get("/admin", response_class=HTMLResponse)
        @app.get("/admin/", response_class=HTMLResponse)
        def _admin_index(request: _Request):
            from shared_infra.routes.system import render_page
            try:
                content = render_page("admin.html")
            except FileNotFoundError:
                return HTMLResponse(
                    "<h1>admin.html missing</h1>"
                    "<p>Run <code>./elpis start</code> from the project root.</p>",
                    status_code=500,
                )
            return HTMLResponse(content=content, headers={
                "Cache-Control": "no-cache, no-store, must-revalidate",
            })
    elif APP_MODE == "main":
        # Soft handoff: clicking the Admin button in the main UI redirects
        # here, and we forward to the admin process. If ADMIN_PUBLIC_URL is
        # not set, render a small explanatory page instead of a hard 404.
        #
        # Remote-client gotcha: the env var commonly contains "localhost"
        # because that's what the start script defaults to. Returning that
        # literal in a 302 sends the *user's browser* to the *user's own*
        # machine on click — broken from anywhere except the VM itself.
        # We delegate to the same `_resolve_public_url` helper that the
        # /api/public-config endpoint uses (same rewriting + synthesis
        # logic, single source of truth — see backend/routes/_legacy.py).
        from fastapi import Request as _AdminRequest
        from fastapi.responses import HTMLResponse, RedirectResponse

        @app.get("/admin", include_in_schema=False)
        @app.get("/admin/", include_in_schema=False)
        def _admin_redirect(request: _AdminRequest):
            env_target = os.environ.get("ADMIN_PUBLIC_URL", "").strip()
            try:
                # Lazy import to avoid pulling in the full legacy module
                # at app-startup if it isn't needed (notably in test
                # harnesses that import app.py without booting routes).
                from shared_infra.routes.system import _resolve_public_url
                target = _resolve_public_url(env_target, request, "admin", APP_MODE)
            except Exception:
                # Defensive fallback: if the helper changes shape later,
                # we still serve at least the raw env var rather than
                # hard-failing the redirect.
                target = env_target
            if target:
                return RedirectResponse(target, status_code=302)
            return HTMLResponse(
                "<!doctype html><meta charset=utf-8>"
                "<title>Admin separated</title>"
                "<style>body{font-family:system-ui;max-width:560px;margin:8em auto;padding:2em;"
                "background:#f8fafc;color:#1e293b;border-radius:12px}</style>"
                "<h2>Console d'administration</h2>"
                "<p>L'application d'administration s'exécute désormais dans un "
                "processus séparé pour réduire la surface d'attaque côté usager.</p>"
                "<p>Configurez la variable d'environnement <code>ADMIN_PUBLIC_URL</code> "
                "(ex&nbsp;: <code>http://votre-host:8002/admin</code>) pour activer la "
                "redirection automatique.</p>",
                status_code=200,
            )

    # ── AX Memory admin/user routes ──
    try:
        from shared_infra.memory.routes_ax import router as _ax_router
        app.include_router(_ax_router)
        logger.info("[AX] routes_ax router mounted")
    except Exception as _e:
        logger.warning(f"[AX] failed to mount routes_ax: {_e}")

    # ── elpis-code CLI download endpoints (opt-in) ──
    # Only useful on the main app — skip on the admin process to keep
    # its surface minimal.
    import os as _os_dl
    if APP_MODE != "admin" and _os_dl.environ.get("ENABLE_CLI") == "1":
        try:
            from code.server.cli_download import router as _cli_dl_router
            app.include_router(_cli_dl_router)
            logger.info("[CLI] elpis-code download router monté")
        except Exception as _e:
            logger.warning(f"[CLI] échec du montage cli_download : {_e}")


    # ── Optional : CLI agentique elpis-code ──
    import os as _os
    if APP_MODE != "admin" and _os.environ.get("ENABLE_CLI") == "1":
        try:
            from code.server.cli_router import router as _cli_router
            app.include_router(_cli_router)
            logger.info("[CLI] elpis-code router monté")
        except Exception as _e:
            logger.warning(f"[CLI] échec du montage : {_e}")

    # NOTE: the cross-process metric/event tailer is started from the
    # lifespan handler at the top of this file — NOT from a
    # @app.on_event("startup") decorator. See the comment in lifespan()
    # for why.

    return app


def _mount_admin_required_subset(app: FastAPI) -> None:
    """
    In APP_MODE=admin, mount ONLY the tiny set of non-admin endpoints the
    admin UI strictly needs, plus the / and /static plumbing already
    handled by the StaticFiles mount above.

    Specifically:
      * auth.py            — /api/{me,login,logout}-lite
      * /api/system-events — live SSE stream the Logs tab subscribes to
      * /api/health        — used by the front for restart-detection polling
      * /api/users/change-password — for forced password change on first login
      * /api/users/lite             — staff need user lookups
      * /api/public-config          — branding/welcome the login screen renders
      * /api/settings/avatar (GET)  — to render avatars in the admin UI
      * /api/settings               — skin / dark mode of the console (PUT
                                      limited to appearance keys in this mode)
      * /avatars/{filename}         — same
      * /api/skins, /api/skins/*   — skins activés, feuille et images d'un skin importé

    Implementation
    --------------
    Rather than rebuilding tiny ad-hoc routers, we mount the SHARED ``router``
    (the one ``backend.routes`` builds) but install a per-route "include in
    admin?" filter. The filter walks the routes list AFTER ``include_router``
    and prunes everything whose path is not in the allow-list.
    """
    # We need a sub-router we can prune; copy the existing router's routes
    # into a fresh APIRouter so we don't mutate the package-level shared
    # ``router`` (which other modules may iterate).
    from fastapi import APIRouter

    ALLOW_PATHS = {
        "/api/me-lite", "/api/login-lite", "/api/logout-lite",
        "/api/system-events", "/api/health",
        "/api/users/change-password", "/api/users/lite",
        "/api/public-config",
        "/api/settings/avatar", "/api/settings",
        # Skins : la console suit le skin du compte (liste, feuille et images
        # d'un skin importé).
        "/api/skins",
    }
    ALLOW_PATH_PREFIXES = ("/avatars/", "/api/skins/")

    pruned = APIRouter()
    kept = 0
    pruned_count = 0
    for r in router.routes:
        path = getattr(r, "path", None)
        if path in ALLOW_PATHS or any(path.startswith(p) for p in ALLOW_PATH_PREFIXES):
            pruned.routes.append(r)
            kept += 1
        else:
            pruned_count += 1
    app.include_router(pruned)
    log_event("system", "INFO",
              f"admin mode: kept {kept} non-admin endpoints, "
              f"pruned {pruned_count}")


app = create_app() if os.environ.get("APP_DEFER_CREATE") != "1" else None
