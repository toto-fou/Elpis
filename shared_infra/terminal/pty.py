# SPDX-License-Identifier: MIT
"""
backend.routes._pty — PTY (pseudo-terminal) infrastructure for the per-user
in-app shell.

What lives here
---------------
1. **Process-local PTY map** (``_terminals``): module-level dict keyed by
   ``(uid, sid)`` → state dict ``{master_fd, pid, alive, lock, ...}``.
   Per-process — gunicorn workers each have their own dict, which is why
   the SSE+POST transport has the multi-worker ghost-PTY issue documented
   in ``backend/routes/terminal.py`` and the WebSocket transport exists as
   the workaround.

2. **Multi-session named terminals** (DB table ``terminal_sessions``):
   Source of truth for ownership and listing across workers. The PTY
   itself is worker-local; if a WebSocket reconnects to a different
   worker than the one that first spawned the PTY, we simply spawn a
   fresh PTY there (Option A: "fresh PTY, lose scrollback"). The 30-min
   idle reaper here + the 7-day DB-row retention there keep the
   bookkeeping bounded.

3. **PTY lifecycle** (``_spawn_terminal``, ``_kill_terminal``,
   ``_get_or_create_terminal``, ``_cleanup_idle_terminals``,
   ``shutdown_all_terminals``): forking + setsid + ptmx pair, kill -9
   on cleanup, idle reaper that walks ``_terminals`` and closes PTYs
   inactive >30 min, lifespan-time graceful shutdown.

4. **Session DB CRUD** (``_init_terminal_sessions_table``, ``_new_sid``,
   ``_valid_sid``, ``_count_user_sessions``, ``_insert_session_row``,
   ``_list_session_rows``, ``_get_session_row``, ``_touch_session_row``,
   ``_rename_session_row``, ``_delete_session_row``, ``_kill_local_session``,
   ``_purge_abandoned_session_rows``): plain SQLite row helpers backing
   the multi-session UI.

5. **WebSocket auth + loop** (``_ws_auth_uid``, ``_terminal_ws_loop``):
   shared by both ``/ws/terminal`` and ``/ws/terminal/{sid}`` route
   handlers in ``backend/routes/terminal.py``. Contains the bidirectional
   I/O multiplex, token-bucket rate limit on input frames, and the
   per-user sandbox quota enforcement that kills the PTY when exceeded.

   ⚠ AUDIT 2026-08-08 — cette dernière affirmation était FAUSSE : la boucle
   WS ne contenait aucune sonde de quota, l'enforcement n'existait que sur
   le chemin SSE legacy (``routes/terminal.py``), donc uniquement en repli
   quand le WebSocket est bloqué. Sur le transport NOMINAL, le shell
   n'était donc pas plafonné du tout. La sonde existe désormais vraiment
   ici (``_quota_check``) : périodique, calcul en thread via le compteur
   mis en cache, avertissement à 90 % puis fermeture au dépassement.

Re-export contract
------------------
``backend/routes/_legacy.py`` re-imports everything defined here so
``from backend.routes._legacy import _terminals`` etc. keeps working.
``backend/routes/__init__.py`` adds this module to ``_SUBMODULES`` so the
same names are also reachable via the package façade.
"""
from __future__ import annotations

import asyncio
import fcntl as _fcntl
import logging
import os
import pty as _pty
import re as _re_sid
import secrets
import struct as _struct
import subprocess
import termios as _termios
import threading as _threading
import time
from pathlib import Path
from typing import Dict, List, Optional

from fastapi import HTTPException, WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState

from shared_infra.accounts.users import (
    get_user_settings,
    get_username_by_id,
)
from shared_infra.config import read_config_json
from shared_infra.sandbox.executors import _privdrop

logger = logging.getLogger("uvicorn.error")


def _get_work_path(uid: int):
    """Import PARESSEUX (2026-09-12) : ``shared_infra.routes._helpers`` tire le
    package ``shared_infra.routes`` dont ``_legacy`` importe CE module — un
    import au niveau module bouclait dès que ``pty`` était importé en premier
    (hôte d'outils, test isolé). Résolu à l'appel, jamais à l'import."""
    from shared_infra.routes._helpers import _get_work_path as _gwp
    return _gwp(uid)


_terminals: Dict[tuple, dict] = {}   # (uid, sid) -> {master_fd, pid, alive, lock, sid, ...}
_term_global_lock = _threading.Lock()

# ══════════════════════════════════════════════════════════════════
#  MULTI-SESSION TERMINAL — constants
# ══════════════════════════════════════════════════════════════════
# "Default" session id used by the legacy single-terminal endpoints
# (/api/terminal/{input,resize,stream,kill} and the unsuffixed
# /ws/terminal). Every legacy call site treats the user as having one
# implicit session named "default". Multi-session code uses explicit
# random sids generated server-side; they live in a DB table so they
# survive worker restarts and can be listed across workers.
#
# ⚠ AUDIT 2026-08-01 (M6) — PRÉCISION IMPORTANTE : ce qui survit à un
# redémarrage de worker est la LIGNE (nom, dates), PAS le shell. Un PTY est un
# processus ENFANT du worker : il meurt avec lui, et `_kill_all_terminals()`
# (server/app.py, shutdown du lifespan) s'exécute à CHAQUE recyclage —
# `max_requests = 2000`, pas seulement lors d'un arrêt volontaire. La rétention
# des lignes (`_SESSION_DB_RETENTION_SEC`) étant très supérieure à l'intervalle
# de recyclage, l'utilisateur voit une session listée comme vivante et
# rouvre en réalité un bash NEUF : répertoire courant, variables
# d'environnement et processus en cours (un build, par exemple) sont perdus,
# sans message. Le remède réel est architectural — faire vivre les PTY hors du
# cycle de vie du worker (démon dédié) ; ne pas laisser croire à
# une continuité que cette table ne fournit pas.
DEFAULT_SID = "default"

# Hard cap on *named* sessions per user (excluding the default one).
# A user may therefore end up with at most MAX_SESSIONS_PER_USER + 1
# PTYs alive simultaneously if they also use the legacy flow. In
# practice the new frontend never touches the legacy flow when
# multi-session is available, so the real cap matches VS Code's UX.
MAX_SESSIONS_PER_USER = 4

# AUDIT 2026-06 — cap MÉMOIRE par user sur la map _terminals de CE worker.
# Le cap DB ci-dessus borne les sessions *nommées*, mais les fd PTY vivent
# en mémoire par worker et n'avaient AUCUNE borne locale (le reaper 30 min
# ne protège pas d'une rafale). Au-delà : éviction douce du plus vieux
# ``last_io`` (cohérent avec le reaper), pas de 429.
PTY_MAX_PER_USER = int(os.environ.get("PTY_MAX_PER_USER", str(MAX_SESSIONS_PER_USER + 2)))

# Retention for session DB rows whose owner hasn't reconnected.
# Rows older than this are purged by the per-worker cleanup loop.
# Decoupled from _PTY_IDLE_TIMEOUT_SEC (30 min, lives/die of the PTY
# process) because the DB row can outlive the PTY across worker
# crashes.
_SESSION_DB_RETENTION_SEC = 7 * 24 * 3600  # 7 days

# Session id format: "t_" + 12 url-safe chars (~72 bits entropy).
# The regex is enforced at every input to avoid path-injection in the
# endpoints that take {sid} as a path parameter.
# (AUDIT 2026-08-30 / S6 — le ``import re as _re_sid`` qui était ici doublonnait
# celui de l'en-tête du module, quelques dizaines de lignes plus haut.)
_SID_RE = _re_sid.compile(r"^[A-Za-z0-9_-]{1,64}$")

# ── Zombie reaping: see note ─────────────────────────────────────
# We intentionally DO NOT set ``signal.signal(SIGCHLD, SIG_IGN)``
# process-wide. A previous iteration of this code did, to auto-reap
# exited bash children, but it broke every other subsystem that
# depends on waitpid() to get subprocess exit status:
#   * asyncio.create_subprocess_exec() — hangs or gets ECHILD
#   * subprocess.Popen.wait()          — same
#   * MCP pool clients that spawn local MCP servers — chat stalls
#     in "Réflexion" indefinitely after a tool call because the
#     MCP stdio transport can't reap its own children.
# _kill_terminal below does ONE opportunistic waitpid(WNOHANG); since
# SIGKILL delivery is asynchronous this almost always misses, so the
# pid is queued in ``_pending_reap`` and swept by
# ``_cleanup_idle_terminals`` / ``_get_or_create_terminal`` until the
# zombie is actually collected (audit 2026-08-02, M2 — the previous
# claim of a "<1 ms window" was backwards: the miss was the rule).


# ── umask 0022 du terminal : pourquoi un --rcfile et pas un simple préfixe ──
# Un seul UID écrit dans /work (L4.6) : fichiers 0644, dossiers 0755, comme
# les commandes de ``sb.exec``.
#
# ⚠ Un ``sh -c 'umask 0022; exec /bin/bash'`` NE SUFFIT PAS : le bash lancé ici
# est INTERACTIF (docker exec -it), donc il source ``/etc/bash.bashrc`` — que
# l'image a pu remplir avec un autre umask (``umask 0002`` jusqu'à
# elpis/sandbox 1.7.0, entrypoint compris). Le ``--rcfile`` est lu APRÈS
# ``/etc/bash.bashrc`` (il ne remplace que ``~/.bashrc``) : on y re-pose
# l'umask, qui gagne donc en dernier. On source explicitement ``~/.bashrc``
# (HOME=/work) pour ne rien perdre des personnalisations de l'utilisateur.
# Repli sur un bash nu si /tmp est inaccessible — mieux vaut un terminal au
# mauvais umask que pas de terminal.
_TERM_RCFILE = "/tmp/.elpis-termrc"
_TERM_BOOTSTRAP = (
    "umask 0022; "
    "{ echo '[ -f \"$HOME/.bashrc\" ] && . \"$HOME/.bashrc\"'; "
    "echo 'umask 0022'; } > " + _TERM_RCFILE + " 2>/dev/null "
    "&& exec /bin/bash --rcfile " + _TERM_RCFILE + "; "
    "exec /bin/bash"
)

# UID:GID d'ouverture du terminal. ⚠ Volontairement figé ici, comme avant :
# ``cfg.exec_user`` n'a jamais été honoré par le PTY (défaut connu, hors
# périmètre de ce correctif — cf. UserSandbox.exec qui, lui, le respecte).
_PTY_EXEC_USER = "10001:10001"

# Enveloppe exécutée EN ROOT, juste avant le retrait de net_admin.
# Quand l'exec entre en root, docker crée le pts en ``root:tty`` : tout
# programme qui ROUVRE le terminal par son nom (``tmux``, ``screen``,
# ``script``…) échouerait une fois redescendu sur l'UID cible. On rend donc
# le pts à cet UID — état identique à celui d'un ``docker exec --user`` —
# puis on `exec` la suite (setpriv + le bootstrap), passée en positionnels
# pour n'avoir AUCUN re-quoting à faire.
_PTY_PRIVDROP_WRAP = (
    't=$(tty 2>/dev/null); [ -c "$t" ] && chown "$1:tty" "$t" 2>/dev/null; '
    'shift; exec "$@"'
)


def _probe_privdrop(container_name: str) -> None:
    """Sonde synchrone (une fois par conteneur) de la chaîne root+setpriv.
    Voir ``shared_infra.sandbox.executors._privdrop`` : sans elle, ``sudo iptables -F``
    depuis le terminal effaçait l'allowlist du profil réseau."""
    if _privdrop.cached(container_name, _PTY_EXEC_USER) is not None:
        return
    argv = _privdrop.probe_argv(container_name, _PTY_EXEC_USER)
    if argv is None:
        return
    try:
        pr = subprocess.run(["docker", *argv], capture_output=True, timeout=10)
        ok = (pr.returncode == 0)
    except Exception:
        ok = False
    _privdrop.remember(container_name, _PTY_EXEC_USER, ok)


def _build_pty_docker_cmd(container_name: str) -> list[str]:
    """Construction PURE de l'argv ``docker exec -it`` du terminal (aucune
    I/O), pour que le retrait de net_admin soit unit-testable — même
    intention que ``UserSandbox._build_run_args``.

    La sonde (``_probe_privdrop``) est faite par l'appelant : si elle n'a pas
    tourné, ou si elle a échoué, on rend l'argv historique
    (``--user 10001:10001``, bootstrap direct).
    """
    pty_user, privdrop_prefix = _privdrop.resolve(container_name, _PTY_EXEC_USER)
    if privdrop_prefix:
        # root → chown du pts → setpriv (retrait net_admin) → UID cible →
        # bootstrap. Tout est passé en positionnels : aucun re-quoting.
        shell_tail = ["/bin/sh", "-c", _PTY_PRIVDROP_WRAP, "--",
                      _PTY_EXEC_USER.split(":", 1)[0],
                      *privdrop_prefix,
                      "/bin/sh", "-c", _TERM_BOOTSTRAP]
    else:
        shell_tail = ["/bin/sh", "-c", _TERM_BOOTSTRAP]
    return [
        "docker", "exec", "-it",
        "--user", pty_user,
        "--workdir", "/work",
        "-e", "TERM=xterm-256color",
        "-e", "LANG=C.UTF-8",
        "-e", "LC_ALL=C.UTF-8",
        # safe.directory=* : un repo créé côté HÔTE (git_action init/clone)
        # appartient à l'UID app ≠ 10001 → sans cela, git dans le terminal
        # refuse tout (« dubious ownership »). Même injection que sb.exec.
        "-e", "GIT_CONFIG_COUNT=1",
        "-e", "GIT_CONFIG_KEY_0=safe.directory",
        "-e", "GIT_CONFIG_VALUE_0=*",
        container_name,
        *shell_tail,
    ]


def _spawn_terminal(uid: int, sid: str = DEFAULT_SID) -> dict:
    """Spawn un PTY interactif pour l'utilisateur dans son container Docker.

    ``sid`` identifies the session within ``_terminals``. A single user
    may own multiple PTYs (VS-Code-style multi-terminal) each keyed by
    ``(uid, sid)``.

    Note (depuis le retrait du mode 'folder') : on tente d'abord
    ``docker exec -it`` dans le container Docker du user. Si le container
    n'est pas démarré, on lève ``RuntimeError("container_not_ready")`` —
    le frontend doit alors proposer l'init au user (modal de progression
    qui appelle POST /api/sandbox/me).
    """
    root = str(_get_work_path(uid))
    # ⚠ SOURCE UNIQUE — ``safe_sandbox_name`` : le nom du conteneur est dérivé
    # du username CANONISÉ ([A-Za-z0-9_-], sémantique « delete »), exactement
    # comme ``UserSandbox.container_name`` et comme le dossier monté sur
    # ``/work``. Sans elle, un compte legacy non canonique (les nouveaux sont
    # refusés par ``validate_username``, mais les anciens sont explicitement
    # TOLÉRÉS) faisait chercher un conteneur qui n'existe pas :
    #   « Jean.Dupont » → réel elpis-sb-JeanDupont, cherché elpis-sb-Jean.Dupont
    # → ``docker inspect`` KO → RuntimeError("container_not_ready") DÉFINITIF,
    # terminal inutilisable alors que l'éditeur et les outils MCP marchent (eux
    # passent déjà par la source unique). Le repli suit celui de
    # ``_get_sandbox_path`` (``user_<id>``) pour rester aligné bout en bout.
    from shared_infra.config import safe_sandbox_name
    username = safe_sandbox_name(get_username_by_id(uid) or f"user_{uid}")

    # ─── Vérifier que le container Docker du user est running ──────────
    from shared_infra.sandbox.naming import container_name as _cname
    container_name = _cname(username)
    try:
        check = subprocess.run(
            ["docker", "inspect", "--format", "{{.State.Running}}", container_name],
            capture_output=True, text=True, timeout=5,
        )
        running = (check.returncode == 0 and check.stdout.strip().lower() == "true")
    except (FileNotFoundError, subprocess.TimeoutExpired):
        running = False

    if not running:
        # Container pas prêt → erreur explicite. Le frontend l'intercepte
        # et propose l'init via la modal de progression.
        raise RuntimeError("container_not_ready")

    # ─── Créer le PTY hôte qui pilotera docker exec -it ────────────────
    master_fd, slave_fd = _pty.openpty()
    _fcntl.ioctl(slave_fd, _termios.TIOCSWINSZ,
                 _struct.pack("HHHH", 24, 80, 0, 0))

    # docker exec -it ouvre lui-même un PTY dans le container et le pipe
    # via stdin/stdout. Notre PTY hôte sert juste de canal de transport
    # vers xterm.js. Le sandbox enforcement hôte est inutile : le container
    # EST la sandbox (UID 10001 non-root, volume /work cloisonné, iptables
    # in-container, pas de docker.sock). ⚠ Le modèle est PERMISSIF dedans —
    # ni no-new-privileges, ni --read-only, et sudo NOPASSWD (cf.
    # UserSandbox._build_run_args) : c'est précisément pourquoi le retrait de
    # net_admin ci-dessous est nécessaire.
    _probe_privdrop(container_name)
    docker_cmd = _build_pty_docker_cmd(container_name)

    pid = os.fork()
    if pid == 0:
        # Child
        try:
            os.setsid()
            os.close(master_fd)
            os.dup2(slave_fd, 0)
            os.dup2(slave_fd, 1)
            os.dup2(slave_fd, 2)
            if slave_fd > 2:
                os.close(slave_fd)
            # Env minimal pour docker (lui-même n'a pas besoin de bcp)
            env = {
                "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                "TERM": "xterm-256color",
                "HOME": "/tmp",
            }
            os.execvpe("docker", docker_cmd, env)
        except Exception:
            pass
        os._exit(1)

    # Parent
    os.close(slave_fd)

    # Non-blocking reads
    flags = _fcntl.fcntl(master_fd, _fcntl.F_GETFL)
    _fcntl.fcntl(master_fd, _fcntl.F_SETFL, flags | os.O_NONBLOCK)

    state = {
        "master_fd": master_fd, "pid": pid, "root": root,
        "alive": True, "lock": _threading.Lock(), "last_io": time.time(),
        "stream_epoch": 0,
        "uid": uid, "sid": sid, "tid": None,
        "container_name": container_name,
    }
    return state


def _kill_terminal(state: dict):
    state["alive"] = False
    fd = state.get("master_fd")
    # BUG FIX C6 (suite) : remove_reader AVANT os.close pour fermer
    # complètement la fenêtre de race epoll-recycle. Si la session WS
    # avait enregistré un reader (cf. _ws_pty_loop ligne ~1004), on le
    # déregistre maintenant. Sans ça, l'épisode décrit dans le commentaire
    # de _on_readable restait théoriquement possible : entre os.close()
    # et le check state["alive"]==False du callback, le numéro de fd
    # peut être recyclé par un open() concurrent.
    #
    # Implémentation thread-safe : si la loop tourne dans le thread
    # courant on appelle direct, sinon on schedule via call_soon_threadsafe.
    loop = state.get("_loop")

    def _close_fd():
        try:
            os.close(fd)
        except OSError:
            pass

    def _unreg_and_close():
        # remove_reader PUIS close, exécutés SÉQUENTIELLEMENT dans le thread
        # de la loop (où tourne aussi _on_readable) → plus aucune fenêtre.
        try:
            loop.remove_reader(fd)
        except (OSError, ValueError, RuntimeError):
            pass
        _close_fd()

    if fd is not None and loop is not None:
        # BUG FIX (audit 2026-06, suite de C6) : avant, en cross-thread, le
        # remove_reader était différé via call_soon_threadsafe mais os.close
        # restait IMMÉDIAT → le close précédait le unregister, exactement la
        # fenêtre fd-recyclé qu'on voulait fermer. Désormais le couple
        # (remove_reader + close) est différé ENSEMBLE dans le thread de la
        # loop. On détecte le thread explicitement (get_running_loop) au lieu
        # de compter sur un RuntimeError que remove_reader ne garantit pas.
        try:
            _running = asyncio.get_running_loop()
        except RuntimeError:
            _running = None
        if _running is loop:
            _unreg_and_close()                       # même thread → direct
        else:
            try:
                loop.call_soon_threadsafe(_unreg_and_close)
            except Exception:
                _close_fd()                          # loop fermée → fallback direct
    elif fd is not None:
        _close_fd()
    # AUDIT 2026-08-02 (M2) — SIGKILL est ASYNCHRONE : le waitpid(WNOHANG)
    # immédiat qui suivait rendait (0, 0) quasi systématiquement (l'enfant
    # n'est pas encore démonté au retour de os.kill) → zombie définitif,
    # puisque l'entrée est retirée de ``_terminals`` avant l'appel et
    # qu'aucun autre waitpid ne re-visitait ce pid. Le commentaire
    # « <1 ms window in practice » décrivait l'inverse de la réalité.
    # On tente UN reap immédiat (gratuit), sinon le pid part dans
    # ``_pending_reap``, balayé par ``_cleanup_idle_terminals`` et à chaque
    # spawn — pas de sleep ici, _kill_terminal peut tourner sur la loop.
    try:
        os.kill(state["pid"], 9)
    except Exception:
        pass
    if not _try_reap_pid(state["pid"]):
        _pending_reap.append(state["pid"])


# ── Reap différé des enfants SIGKILLés (audit 2026-08-02, M2) ─────────
_pending_reap: List[int] = []


def _try_reap_pid(pid: int) -> bool:
    """waitpid(WNOHANG) sans lever. True si le pid est reapé (ou ne nous
    appartient plus) ; False s'il faut re-essayer plus tard."""
    try:
        return os.waitpid(pid, os.WNOHANG)[0] != 0
    except ChildProcessError:
        return True   # déjà reapé (ou pas notre enfant)
    except Exception:
        return True   # état irrécupérable : inutile de réessayer en boucle


def _reap_pending() -> int:
    """Balaye ``_pending_reap``. Appelé par le cleanup périodique et à
    chaque spawn. Retourne le nombre de zombies effectivement reapés."""
    if not _pending_reap:
        return 0
    before = len(_pending_reap)
    _pending_reap[:] = [pid for pid in _pending_reap if not _try_reap_pid(pid)]
    return before - len(_pending_reap)


def _get_or_create_terminal(uid: int, sid: str = DEFAULT_SID) -> dict:
    """Return (creating if needed) the PTY state for ``(uid, sid)``.

    Liveness check: if the stored pid has exited, the entry is
    replaced. We rely on the standard default SIGCHLD disposition;
    zombies are reaped best-effort by waitpid(WNOHANG) here and in
    ``_kill_terminal``. See the long comment above ``_spawn_terminal``
    for why we do NOT set SIGCHLD to SIG_IGN.

    Si le container Docker du user n'est pas démarré, ``_spawn_terminal``
    lève ``RuntimeError("container_not_ready")`` qu'on transforme ici en
    ``HTTPException(503, {"error": "container_not_ready", ...})`` que le
    frontend intercepte pour proposer l'init.
    """
    key = (uid, sid)
    with _term_global_lock:
        _reap_pending()   # audit 2026-08-02 (M2) — balayage opportuniste
        if key in _terminals:
            st = _terminals[key]
            try:
                pid_check = os.waitpid(st["pid"], os.WNOHANG)
                if pid_check[0] != 0:
                    _kill_terminal(st)
                    del _terminals[key]
            except ChildProcessError:
                _kill_terminal(st)
                del _terminals[key]

        if key not in _terminals:
            # AUDIT 2026-06 — cap mémoire par user (cf. PTY_MAX_PER_USER) :
            # éviction douce du PTY le plus inactif du même user avant spawn.
            mine = [(k, st) for k, st in _terminals.items() if k[0] == uid]
            if len(mine) >= PTY_MAX_PER_USER:
                victim_key, victim = min(mine, key=lambda kv: kv[1].get("last_io", 0.0))
                logger.info("[pty] cap user atteint (uid=%s, %d PTYs) → éviction %s",
                            uid, len(mine), victim_key[1][:8])
                _kill_terminal(victim)
                _terminals.pop(victim_key, None)
            try:
                _terminals[key] = _spawn_terminal(uid, sid)
            except RuntimeError as e:
                if str(e) == "container_not_ready":
                    from fastapi import HTTPException
                    raise HTTPException(
                        status_code=503,
                        detail={
                            "error": "container_not_ready",
                            "message": "Le container Docker n'est pas démarré. Démarre-le dans tes paramètres ou utilise la modal d'init.",
                        },
                    )
                raise
        return _terminals[key]


_PTY_IDLE_TIMEOUT_SEC = 1800  # 30 minutes

def _cleanup_idle_terminals() -> int:
    """Ferme les terminaux PTY inactifs depuis > 30 min.

    Appelé périodiquement par le cron loop (cf. ``_local_cleanup_loop``
    dans _state.py, tourne sur chaque worker).

    Aussi responsable de la purge des rows DB orphelines
    (``terminal_sessions``) dont plus aucun worker n'a un PTY
    correspondant vivant, et qui dépassent ``_SESSION_DB_RETENTION_SEC``.
    Sans cette purge, un user qui crée puis ferme sans delete verrait
    sa quota de 4 sessions se remplir indéfiniment.
    """
    now = time.time()
    killed = 0
    with _term_global_lock:
        stale = [
            key for key, st in _terminals.items()
            if st.get("last_io", 0) and (now - st["last_io"]) > _PTY_IDLE_TIMEOUT_SEC
        ]
        for key in stale:
            st = _terminals.pop(key, None)
            if st:
                _kill_terminal(st)
                killed += 1
        # AUDIT 2026-08-02 (M2) — reap différé des enfants SIGKILLés dont le
        # waitpid immédiat avait raté (cf. _kill_terminal).
        reaped = _reap_pending()
    if reaped:
        logger.info(f"[PTY] {reaped} zombie(s) reapé(s) en différé.")
    if killed:
        logger.info(f"[PTY] {killed} terminal(aux) inactif(s) fermé(s) (>{_PTY_IDLE_TIMEOUT_SEC // 60}min).")

    # Abandoned DB rows: rows that nobody has reconnected to in
    # _SESSION_DB_RETENTION_SEC seconds. Run per-worker but idempotent
    # (DELETE WHERE with a time filter — duplicate cleanups are no-ops).
    #
    # BUG FIX (P1) — cet appel manquait. ``_purge_abandoned_session_rows``
    # était défini et ré-exporté mais jamais invoqué : les rows
    # ``terminal_sessions`` s'accumulaient indéfiniment et, une fois
    # MAX_SESSIONS_PER_USER atteint, ``_insert_session_row`` renvoyait un
    # HTTP 429 ``limit_reached`` définitif → l'utilisateur ne pouvait
    # plus créer aucun terminal.
    try:
        _purge_abandoned_session_rows(now)
    except Exception as e:
        logger.warning(f"[PTY] purge abandoned session rows: {e}")

    return killed


def _purge_abandoned_session_rows(now: float) -> int:
    """Delete terminal_sessions rows idle > _SESSION_DB_RETENTION_SEC.

    Best-effort: if the table doesn't exist yet (fresh install before
    the first session is created), silently no-op.
    """
    cutoff = int(now - _SESSION_DB_RETENTION_SEC)
    from shared_infra.observability.usage_store import db_conn
    try:
        with db_conn() as conn:
            cur = conn.cursor()
            cur.execute(
                "DELETE FROM terminal_sessions WHERE last_connected_at < ?",
                (cutoff,),
            )
            n = cur.rowcount
            conn.commit()
            if n:
                logger.info(f"[PTY] purged {n} abandoned session row(s) (>7d).")
            return int(n or 0)
    except Exception:
        # Table missing or DB locked — harmless; retry next tick.
        return 0


# ── /api/terminal/{input,resize,stream,kill} — moved to backend.routes.terminal ──
def shutdown_all_terminals():
    """Kill every PTY. Call from lifespan/on_shutdown."""
    with _term_global_lock:
        items = list(_terminals.items())
        count = len(items)
        for _key, st in items:
            _kill_terminal(st)
        _terminals.clear()
    if count:
        logger.info(f"[PTY] Shutdown: {count} terminal(aux) fermé(s).")


def kill_user_terminals(uid: int) -> int:
    """Tue tous les PTY de ``uid`` sur CE worker.

    Audit 2026-08-02 (S1) — c'est le « mécanisme de kill côté admin »
    que le commentaire de ``_ws_auth_uid`` promettait sans qu'il existe :
    appelé via ``apply_session_revocation`` (bus fichier inter-workers)
    quand un admin révoque les sessions d'un utilisateur, pour que son
    shell interactif ne survive pas à la révocation. Retourne le nombre
    de PTY tués.
    """
    killed = 0
    with _term_global_lock:
        keys = [k for k in _terminals if k[0] == uid]
        for key in keys:
            st = _terminals.pop(key, None)
            if st:
                _kill_terminal(st)
                killed += 1
    if killed:
        logger.info("[PTY] révocation uid=%s : %d terminal(aux) tué(s).", uid, killed)
    return killed


# ══════════════════════════════════════════════════════════════════
#  MULTI-SESSION TERMINAL — VS-Code-style named sessions
# ══════════════════════════════════════════════════════════════════
#  Architecture
#  ------------
#  A PTY is a process-local resource (fd + child bash). It cannot be
#  migrated between gunicorn workers. With N>1 workers, a user's
#  named terminals can end up spread across workers:
#
#       user U creates T1 -> POST lands on worker A -> session DB
#                            row inserted, then WS opens on worker X
#                            (round-robin) -> PTY spawned on X
#       user U creates T2 -> same flow, WS may land on worker Y
#
#  Key design choices:
#   * DB row is source of truth for ownership/limit/listing across
#     workers (SQLite table ``terminal_sessions``).
#   * PTY is worker-local; the DB row does NOT track which worker
#     hosts it. If a WS reconnects on a different worker than the one
#     that first spawned the PTY, we simply spawn a fresh PTY for
#     that sid on the new worker (Option A: "fresh PTY, lose
#     scrollback" — validated with the user up front). The orphan
#     PTY on the old worker is reaped by _cleanup_idle_terminals
#     within 30 min.
#   * Limit (MAX_SESSIONS_PER_USER) is enforced at DB insert time
#     with a single transaction (``BEGIN IMMEDIATE``) to avoid races
#     between workers creating a 5th row simultaneously.
#   * Legacy single-terminal endpoints keep working by treating the
#     default session implicitly. Its DB row is also created so the
#     counting is coherent when the user mixes flows.
# ══════════════════════════════════════════════════════════════════

_TERMINAL_TABLE_READY: set = set()


def _init_terminal_sessions_table() -> None:
    """Crée le registre des sessions de terminal s'il manque. Appelé par
    chaque endpoint de session ; le travail n'est fait qu'une fois par
    (process, base) — DDL du schéma de référence."""
    from shared_infra.db import _connection as _dbc
    key = (os.getpid(), str(_dbc.DB_PATH))
    if key in _TERMINAL_TABLE_READY:
        return
    from shared_infra.db._schema import ensure_tables
    from shared_infra.observability.usage_store import db_conn
    with db_conn() as conn:
        ensure_tables(conn, ("terminal_sessions",))
        conn.commit()
    _TERMINAL_TABLE_READY.add(key)


def _new_sid() -> str:
    """Generate a url-safe session id with ~72 bits of entropy."""
    return "t_" + secrets.token_urlsafe(9)


def _valid_sid(sid: str) -> bool:
    return bool(sid) and bool(_SID_RE.match(sid))


def _count_user_sessions(uid: int, tid: Optional[int] = None) -> int:
    from shared_infra.observability.usage_store import db_conn
    with db_conn() as conn:
        cur = conn.cursor()
        if tid is None:
            cur.execute(
                "SELECT COUNT(*) FROM terminal_sessions "
                "WHERE uid = ? AND tid IS NULL",
                (uid,),
            )
        else:
            cur.execute(
                "SELECT COUNT(*) FROM terminal_sessions "
                "WHERE uid = ? AND tid = ?",
                (uid, tid),
            )
        row = cur.fetchone()
        return int(row[0]) if row else 0


def _insert_session_row(uid: int, tid: Optional[int], name: str) -> dict:
    """Atomically insert a session row enforcing the per-user limit.

    Raises HTTPException(429) if the limit is reached. Uses
    ``BEGIN IMMEDIATE`` to serialise concurrent inserts from different
    workers — without it, two workers could each see count=3 and both
    insert, pushing the user to 5.
    """
    _init_terminal_sessions_table()
    sid = _new_sid()
    now = int(time.time())
    from shared_infra.db._dialect import begin_write
    from shared_infra.observability.usage_store import db_conn
    with db_conn() as conn:
        cur = conn.cursor()
        try:
            begin_write(conn)
            if tid is None:
                cur.execute(
                    "SELECT COUNT(*) FROM terminal_sessions "
                    "WHERE uid = ? AND tid IS NULL",
                    (uid,),
                )
            else:
                cur.execute(
                    "SELECT COUNT(*) FROM terminal_sessions "
                    "WHERE uid = ? AND tid = ?",
                    (uid, tid),
                )
            count = int(cur.fetchone()[0])
            if count >= MAX_SESSIONS_PER_USER:
                conn.rollback()
                raise HTTPException(
                    status_code=429,
                    detail={
                        "error": "limit_reached",
                        "max": MAX_SESSIONS_PER_USER,
                        "current": count,
                    },
                )
            cur.execute(
                "INSERT INTO terminal_sessions "
                "(id, uid, tid, name, created_at, last_connected_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (sid, uid, tid, name, now, now),
            )
            conn.commit()
        except HTTPException:
            raise
        except Exception:
            try: conn.rollback()
            except Exception: pass
            raise
    return {
        "id": sid, "uid": uid, "tid": tid, "name": name,
        "created_at": now, "last_connected_at": now,
    }


def _list_session_rows(uid: int, tid: Optional[int] = None) -> List[dict]:
    _init_terminal_sessions_table()
    from shared_infra.observability.usage_store import db_conn
    with db_conn() as conn:
        cur = conn.cursor()
        if tid is None:
            cur.execute(
                "SELECT id, uid, tid, name, created_at, last_connected_at "
                "FROM terminal_sessions "
                "WHERE uid = ? AND tid IS NULL "
                "ORDER BY created_at ASC",
                (uid,),
            )
        else:
            cur.execute(
                "SELECT id, uid, tid, name, created_at, last_connected_at "
                "FROM terminal_sessions "
                "WHERE uid = ? AND tid = ? "
                "ORDER BY created_at ASC",
                (uid, tid),
            )
        return [dict(r) for r in cur.fetchall()]


def _get_session_row(sid: str, uid: int,
                     tid: Optional[int] = None) -> Optional[dict]:
    """Return the row iff it exists and is owned by ``uid`` (+tid)."""
    _init_terminal_sessions_table()
    if not _valid_sid(sid):
        return None
    from shared_infra.observability.usage_store import db_conn
    with db_conn() as conn:
        cur = conn.cursor()
        if tid is None:
            cur.execute(
                "SELECT id, uid, tid, name, created_at, last_connected_at "
                "FROM terminal_sessions "
                "WHERE id = ? AND uid = ? AND tid IS NULL",
                (sid, uid),
            )
        else:
            cur.execute(
                "SELECT id, uid, tid, name, created_at, last_connected_at "
                "FROM terminal_sessions "
                "WHERE id = ? AND uid = ? AND tid = ?",
                (sid, uid, tid),
            )
        row = cur.fetchone()
        return dict(row) if row else None


def _touch_session_row(sid: str) -> None:
    """Update last_connected_at to now. Best-effort, no error propagation."""
    _init_terminal_sessions_table()
    from shared_infra.observability.usage_store import db_conn
    try:
        with db_conn() as conn:
            cur = conn.cursor()
            cur.execute(
                "UPDATE terminal_sessions SET last_connected_at = ? WHERE id = ?",
                (int(time.time()), sid),
            )
            conn.commit()
    except Exception:
        pass


def _rename_session_row(sid: str, uid: int, new_name: str,
                        tid: Optional[int] = None) -> bool:
    _init_terminal_sessions_table()
    if not _valid_sid(sid):
        return False
    new_name = (new_name or "").strip()[:64]
    if not new_name:
        return False
    from shared_infra.observability.usage_store import db_conn
    with db_conn() as conn:
        cur = conn.cursor()
        if tid is None:
            cur.execute(
                "UPDATE terminal_sessions SET name = ? "
                "WHERE id = ? AND uid = ? AND tid IS NULL",
                (new_name, sid, uid),
            )
        else:
            cur.execute(
                "UPDATE terminal_sessions SET name = ? "
                "WHERE id = ? AND uid = ? AND tid = ?",
                (new_name, sid, uid, tid),
            )
        conn.commit()
        return cur.rowcount > 0


def _delete_session_row(sid: str, uid: int,
                        tid: Optional[int] = None) -> bool:
    _init_terminal_sessions_table()
    if not _valid_sid(sid):
        return False
    from shared_infra.observability.usage_store import db_conn
    with db_conn() as conn:
        cur = conn.cursor()
        if tid is None:
            cur.execute(
                "DELETE FROM terminal_sessions "
                "WHERE id = ? AND uid = ? AND tid IS NULL",
                (sid, uid),
            )
        else:
            cur.execute(
                "DELETE FROM terminal_sessions "
                "WHERE id = ? AND uid = ? AND tid = ?",
                (sid, uid, tid),
            )
        conn.commit()
        return cur.rowcount > 0


def _kill_local_session(uid: int, sid: str) -> bool:
    """Kill the PTY for ``(uid, sid)`` if it lives on this worker."""
    with _term_global_lock:
        st = _terminals.pop((uid, sid), None)
    if st:
        _kill_terminal(st)
        return True
    return False


# ── Endpoints ─────────────────────────────────────────────────────

# ── /api/terminal/sessions/* (4 routes) — moved to backend.routes.terminal ──
# ── /ws/terminal/{sid} — moved to backend.routes.terminal ──


# ── Admin diagnostics ─────────────────────────────────────────────

# [admin] /api/admin/terminal/stats → moved to backend/routes/admin.py


# ══════════════════════════════════════════════════════════════════
#  TERMINAL — WebSocket endpoint (preferred transport)
# ══════════════════════════════════════════════════════════════════
#  Why this exists:
#   The SSE-output + POST-input duo above is functionally correct in
#   single-worker mode but BROKEN under gunicorn with N>1 workers:
#   _terminals is a module-level dict (per-process), and gunicorn has
#   no sticky routing for HTTP requests. So SSE lands on worker A and
#   spawns PTY-A, while POSTed keystrokes land on workers A/B/C round-
#   robin -- B and C each spawn their OWN PTY (bash processes nobody
#   reads), so only ~1/N keystrokes reach the PTY whose output the SSE
#   is actually streaming. User-visible symptom: 30-40s "ghost" delay
#   on first connect until the user closes+reopens and lands on the
#   "right" worker by luck.
#
#   A WebSocket is a single long-lived TCP connection to ONE worker;
#   both input and output flow through it, so the PTY is guaranteed
#   to live on that same worker. Also removes the per-keystroke HTTP
#   overhead (handshake + auth + JSON parse), which was the real cost
#   driver the user called "DDoS".
#
#   The old SSE/POST endpoints are KEPT as a transparent fallback so
#   nothing breaks if WS fails (corporate proxies blocking Upgrade,
#   etc.).
# ══════════════════════════════════════════════════════════════════

# Per-user token-bucket rate limit on WS input frames. Safety net
# against a runaway/malicious client flooding the PTY; in normal use
# the client-side 30 ms batching keeps us well under the ceiling.
_WS_INPUT_RATE_CAPACITY = 200      # max frames burst
_WS_INPUT_RATE_REFILL   = 100.0    # frames per second sustained

# Control-message size cap (bytes). Input frames are binary; only
# resize/ping control messages are JSON, and those are tiny.
_WS_MAX_CTRL_BYTES = 1024

# Sonde de quota disque du terminal WS (cf. _quota_check). Période en
# secondes ; le calcul passe par le compteur en cache (TTL 30 s), donc une
# sonde sur deux ne coûte rien. Seuil d'avertissement avant fermeture.
_WS_QUOTA_INTERVAL_S = 20.0
_WS_QUOTA_WARN_PCT = 0.90


def _ws_auth_uid(ws: WebSocket) -> Optional[int]:
    """Extract user id from the WebSocket session cookie.
    Returns None if unauthenticated; caller must close the socket.

    SECURITY FIX #M (P1) — En plus de la présence du cookie, on lance
    ici les MÊMES gates que ``require_user_id`` pour HTTP :
    max_age, global revoke, per-user revoke, idle timeout. Avant ce
    fix, un cookie révoqué côté HTTP (401 à chaque appel) restait
    valide pour ouvrir un nouveau WebSocket — l'admin ne pouvait pas
    réellement déconnecter un user qui avait gardé sa fenêtre
    /ws/terminal ouverte ou qui en relançait une.

    Note : les WS DÉJÀ ouvertes ne sont pas re-vérifiées par ce check
    (il n'est appelé qu'au handshake). Pour les killer en vol, voir
    le mécanisme ``_kill_terminal`` côté admin.
    """
    # (2026-09-11, P4) hôte d'outils : identité vérifiée par toolhost/auth.py
    try:
        _th = (ws.scope.get("state") or {}).get("toolhost_identity")
    except Exception:
        _th = None
    if _th is not None:
        return int(_th.user_id)
    uid = None
    if hasattr(ws, "session"):
        try:
            uid = ws.session.get("user_id")
        except Exception:
            uid = None
    if not uid:
        return None
    try:
        uid_int = int(uid)
    except (ValueError, TypeError):
        return None
    try:
        from shared_infra.security.deps import _session_validity_checks
        if not _session_validity_checks(ws, uid_int):
            return None
    except Exception:
        return None
    return uid_int


async def _terminal_ws_loop(ws: WebSocket, state: dict) -> None:
    """Shared WebSocket <-> PTY pump used by both personal and team endpoints.

    Design notes:
      * stream_epoch: bumped each time a new WS takes over. The old WS's
        reader/loop sees the mismatch and exits cleanly. We only call
        loop.remove_reader when we are still the active epoch, otherwise
        we would unregister the NEW WS's reader and hang it silently
        (same race fix as the SSE path above).
      * Single loop.add_reader: only one consumer at a time. Calling
        add_reader twice on the same fd simply replaces the previous
        callback, which is exactly what we want for reconnects.
      * Rate limit: token bucket per connection, applied only to binary
        input frames (resize is rare and bounded).
      * We never echo locally: the PTY handles echo. The client just
        sends raw keystrokes and writes whatever comes back.
    """
    import asyncio as _aio
    import json as _json

    master_fd = state["master_fd"]
    # AUDIT 2026-08-02 (W5) — un PTY jamais streamé = shell fraîchement
    # spawné (worker recyclé, éviction, premier accès). On l'annonce au
    # client via la frame ``hello`` ci-dessous : après un recyclage de
    # worker, le scrollback xterm restait intact côté client alors que
    # cwd/env/processus avaient disparu — l'utilisateur croyait être dans
    # la même session sans le moindre indice.
    # AUDIT 2026-08-02 (M5) — l'ancien test ``"stream_epoch" not in state`` était
    # TOUJOURS faux : ``_spawn_terminal`` initialise ``"stream_epoch": 0`` dès la
    # création, donc la clé est toujours présente → ``fresh_shell`` jamais vrai →
    # la frame ``hello`` n'annonçait jamais un shell neuf et le séparateur client
    # ne s'affichait jamais (W5 inerte). Un PTY jamais streamé a ``epoch == 0`` :
    # on teste ça AVANT d'incrémenter.
    fresh_shell = state.get("stream_epoch", 0) == 0
    state["stream_epoch"] = state.get("stream_epoch", 0) + 1
    my_epoch = state["stream_epoch"]

    # AUDIT 2026-08-02 (S1) — revalidation périodique de la session pendant
    # la vie du WS (le handshake seul laissait un shell révoqué vivant sans
    # limite). Valeurs capturées maintenant : le scope WS ne revoit jamais
    # le cookie.
    try:
        _sess_login_ts = ws.session.get("_login_ts") if hasattr(ws, "session") else None
        _sess_sid      = ws.session.get("_sid")      if hasattr(ws, "session") else None
    except Exception:
        _sess_login_ts, _sess_sid = None, None
    _sess_uid = state.get("uid")
    _last_sess_check = time.time()

    async def _session_recheck() -> bool:
        """Rend False (et ferme le WS en 4001) si la session est morte.
        Ne touche la DB qu'une fois par minute ; fail-open sur erreur
        transitoire (cf. stream_session_still_valid)."""
        nonlocal _last_sess_check
        if time.time() - _last_sess_check < 60.0:
            return True
        _last_sess_check = time.time()
        try:
            from shared_infra.security.deps import stream_session_still_valid
            ok = await _aio.to_thread(
                stream_session_still_valid, _sess_uid, _sess_login_ts, _sess_sid)
        except Exception:
            return True
        if ok:
            return True
        logger.info(f"[PTY-WS] session expirée/révoquée en vol uid={_sess_uid} — fermeture 4001")
        try:
            await ws.send_json({"type": "session_expired"})
        except Exception:
            pass
        try:
            await ws.close(code=4001, reason="session expired")
        except Exception:
            pass
        # AUDIT 2026-08-02 (M4) — le recheck fermait le WS mais laissait le PTY
        # (``docker exec`` UID 10001, ``/work``) VIVANT jusqu'au reaper
        # d'inactivité (30 min) ; pire, son ``last_io`` est rafraîchi par la
        # sortie (M2), donc un process bavard le maintenait indéfiniment. On tue
        # donc les terminaux du user révoqué.
        try:
            kill_user_terminals(int(_sess_uid))
        except Exception:
            logger.debug("[PTY-WS] kill_user_terminals après révocation échoué",
                         exc_info=True)
        return False

    loop = _aio.get_event_loop()
    # Store the loop on the state dict so _kill_terminal can call
    # loop.remove_reader(fd) BEFORE os.close(fd) — preventing the
    # epoll-recycle race documented in the BUG FIX C6 comment below.
    # We always overwrite (a new WS handler = new loop binding).
    state["_loop"] = loop
    out_queue: _aio.Queue = _aio.Queue(maxsize=128)

    # ── Quota disque (audit 2026-08-08) ──────────────────────────────────
    # La docstring de ce module AFFIRMAIT que cette boucle applique le quota
    # sandbox et tue le PTY au dépassement. C'ÉTAIT FAUX : l'enforcement
    # n'existait que sur le chemin SSE legacy (``routes/terminal.py``), donc
    # uniquement en repli quand le WebSocket est bloqué. Sur le transport
    # NOMINAL, un utilisateur pouvait remplir le disque hôte depuis son shell
    # sans aucun garde-fou (les routes d'écriture de l'éditeur, elles,
    # restaient protégées).
    #
    # Choix de conception, alignés sur le chemin SSE mais un cran plus doux :
    #   * sonde PÉRIODIQUE (temps) et non par volume de sortie — prévisible,
    #     et sans coût pour un shell bavard ;
    #   * le calcul part dans un thread et passe par le compteur mis en cache
    #     (``quota_bytes`` force le recalcul EXACT dès 90 % du quota, donc on
    #     ne rate pas un dépassement) ;
    #   * AVERTISSEMENT à 90 % (une seule fois) avant le kill à 100 % — le
    #     chemin SSE tuait le shell sans préavis, ce qui, en plein build,
    #     ressemble à un plantage.
    _quota_bytes = 0
    try:
        _qs = get_user_settings(state.get("uid")) or {}
        _qc = read_config_json() or {}
        _quota_bytes = int(_qs.get("sandbox_quota_mb",
                           _qc.get("app", {}).get("sandbox_quota_mb", 5120))) * 1024 * 1024
    except Exception:                                           # noqa: BLE001
        _quota_bytes = 5120 * 1024 * 1024
    _last_quota_check = time.time()
    _quota_warned = False

    def _term_notice(text: str) -> None:
        """Écrit une ligne dans le terminal du client. On passe par
        ``out_queue`` (donc par la task writer) plutôt que d'appeler
        ``ws.send_bytes`` ici : deux émetteurs concurrents sur la même
        WebSocket entrelaceraient leurs trames."""
        try:
            out_queue.put_nowait(text.encode("utf-8"))
        except Exception:                                       # noqa: BLE001
            pass

    async def _quota_check() -> bool:
        """False s'il faut fermer la session (quota dépassé). Throttlé."""
        nonlocal _last_quota_check, _quota_warned
        if _quota_bytes <= 0:
            return True
        if time.time() - _last_quota_check < _WS_QUOTA_INTERVAL_S:
            return True
        _last_quota_check = time.time()
        try:
            from shared_infra.routes._helpers import sandbox_usage_bytes
            used = await _aio.to_thread(
                sandbox_usage_bytes, int(state.get("uid") or 0),
                Path(state["root"]), quota_bytes=_quota_bytes)
        except Exception:                                       # noqa: BLE001
            return True          # fail-open : un hoquet FS ne tue pas un shell
        if used > _quota_bytes:
            _term_notice("\r\n\x1b[41;97m ⚠  QUOTA SANDBOX DÉPASSÉ — "
                         "session fermée \x1b[0m\r\n")
            logger.info("[PTY-WS] quota dépassé uid=%s (%.1f Mo > %.1f Mo) — PTY tué",
                        state.get("uid"), used / 1048576, _quota_bytes / 1048576)
            try:
                os.kill(state["pid"], 9)
            except Exception:                                   # noqa: BLE001
                pass
            state["alive"] = False
            return False
        if not _quota_warned and used > _quota_bytes * _WS_QUOTA_WARN_PCT:
            _quota_warned = True
            _term_notice(f"\r\n\x1b[43;30m ⚠  Quota sandbox à "
                         f"{used * 100 // _quota_bytes} % — libérez de l'espace, "
                         f"la session sera fermée au dépassement \x1b[0m\r\n")
        return True

    def _on_readable():
        # BUG FIX C6 — early-return si le terminal a été killé externament.
        # Avant, _on_readable pouvait être déclenché par epoll juste après
        # qu'un _kill_terminal externe ait fermé master_fd. Dans une fenêtre
        # de quelques microsecondes :
        #   1. _kill_terminal fait state["alive"] = False puis os.close(fd)
        #   2. epoll a déjà queue un événement readable sur ce fd
        #   3. _on_readable est dispatché → os.read sur fd fermé → OSError
        # OSError est catché et trigger un EOF sentinel — OK. Mais si entre
        # le close et le os.read un AUTRE thread/coro a fait un open() qui
        # a recyclé le même numéro de fd (cas rare mais possible avec
        # MCP subprocess spawn ou nouveau spawn_terminal), on lit les
        # données du nouveau fd → données échangées entre sessions !
        #
        # Le check state.alive ferme la majorité de la fenêtre. La race
        # résiduelle (entre check et read) reste théoriquement possible
        # mais on est passés de "millisecondes" à "nanosecondes" — niveau
        # acceptable sans réécrire le pattern complet (qui nécessiterait
        # de passer le loop à _kill_terminal).
        if not state.get("alive", False):
            _signal_eof()
            return
        # AUDIT moteur d'événements 2026-09-25 (B6) — CONTRE-PRESSION. Avant,
        # un chunk déjà lu du PTY était JETÉ quand la file était pleine (client
        # lent, ``cat`` d'un gros fichier) : le commentaire promettait un xterm
        # « auto-resynchronisé », mais une séquence ANSI ou un caractère UTF-8
        # coupé en deux corrompt l'affichage pour de bon. Désormais, file
        # pleine ⇒ on cesse de LIRE (remove_reader) : le tampon noyau du PTY se
        # remplit et bloque le programme qui écrit, comme dans un vrai
        # terminal. Le writer rebranche le lecteur une fois la file à moitié
        # vidée. Aucun octet n'est perdu.
        if out_queue.full():
            _pause_reading()
            return
        try:
            chunk = os.read(master_fd, 16384)
            if chunk:
                # AUDIT 2026-08-02 (M2) — last_io n'était bumpé que sur
                # l'ENTRÉE clavier : un ``npm run build`` qui produit de la
                # sortie pendant 40 min sans frappe se faisait faucher par
                # le reaper d'inactivité (30 min) en plein travail.
                state["last_io"] = time.time()
                out_queue.put_nowait(chunk)   # place garantie (full() testé)
            else:
                _signal_eof()
        except BlockingIOError:
            pass
        except OSError:
            # fd fermé ou autre erreur transport → EOF sentinel + remove_reader
            # immédiat pour éviter que epoll continue à dispatcher.
            _signal_eof()
            try: loop.remove_reader(master_fd)
            except (OSError, ValueError): pass

    # Contre-pression (B6) : état partagé lecteur ↔ writer, tout sur la boucle.
    _flow = {"paused": False, "eof": False}

    def _signal_eof() -> None:
        """Fin du shell. Jamais perdue : si la file est pleine, le drapeau
        est lu par le writer une fois la file vidée."""
        _flow["eof"] = True
        try:
            out_queue.put_nowait(b"")
        except _aio.QueueFull:
            pass

    def _pause_reading() -> None:
        if _flow["paused"]:
            return
        _flow["paused"] = True
        try: loop.remove_reader(master_fd)
        except (OSError, ValueError): pass

    def _maybe_resume_reading() -> None:
        if not _flow["paused"] or out_queue.qsize() > out_queue.maxsize // 2:
            return
        _flow["paused"] = False
        # Jamais pour un WS supplanté (il désinscrirait/écraserait le lecteur
        # du nouveau) ni pour un shell mort.
        if state.get("stream_epoch", 0) != my_epoch or not state.get("alive", False):
            return
        try: loop.add_reader(master_fd, _on_readable)
        except (OSError, ValueError): pass

    # AUDIT 2026-08-02 (F8) — ``add_reader``, la frame ``hello`` et la création
    # du ``writer_task`` sont déplacés DANS le ``try`` protecteur plus bas (et
    # non ici, avant lui) : une annulation de la task WS pendant le premier
    # ``await`` après ``add_reader`` (l'envoi de ``hello``) sautait le
    # ``finally``, laissant le reader enregistré sur un PTY vivant (fd fuité).

    # Writer task: pulls from out_queue and ships to the client.
    async def _writer():
        try:
            while True:
                if _flow["eof"] and out_queue.empty():
                    chunk = b""        # EOF signalé pendant que la file était pleine
                else:
                    chunk = await out_queue.get()
                    _maybe_resume_reading()
                if not chunk:
                    # EOF / PTY died
                    try:
                        await ws.send_json({"type": "exit"})
                    except Exception:
                        pass
                    try: await ws.close(code=1000)
                    except Exception: pass
                    return
                if ws.client_state != WebSocketState.CONNECTED:
                    return
                try:
                    await ws.send_bytes(chunk)
                except Exception:
                    return
        except _aio.CancelledError:
            raise

    writer_task = None            # AUDIT 2026-08-02 (F8) — créé dans le try

    # Token bucket for input rate limiting
    _tokens = float(_WS_INPUT_RATE_CAPACITY)
    _last_refill = time.monotonic()

    def _allow_frame() -> bool:
        nonlocal _tokens, _last_refill
        now = time.monotonic()
        elapsed = now - _last_refill
        _last_refill = now
        _tokens = min(
            float(_WS_INPUT_RATE_CAPACITY),
            _tokens + elapsed * _WS_INPUT_RATE_REFILL,
        )
        if _tokens >= 1.0:
            _tokens -= 1.0
            return True
        return False

    try:
        loop.add_reader(master_fd, _on_readable)
        # Frame d'accueil (audit 2026-08-02, W5) : annonce si le shell est neuf.
        # Le client affiche un séparateur dans xterm quand il se RECONNECTE sur
        # un shell neuf (scrollback conservé mais cwd/env/processus perdus).
        try:
            await ws.send_json({"type": "hello", "fresh_shell": bool(fresh_shell)})
        except Exception:
            pass
        writer_task = _aio.create_task(_writer())
        _last_recv = time.monotonic()
        while True:
            if state.get("stream_epoch", 0) != my_epoch:
                # A newer WS connection has taken over.
                break
            if not state.get("alive", False):
                break

            # 5-minute inactivity timeout as a belt-and-suspenders
            # safety net: TCP keepalive should catch dead peers, but
            # some proxies keep half-open sockets up indefinitely. If
            # the client is alive it will at minimum heartbeat every
            # 25s (see _connectWS), so 300s is >> a healthy gap.
            #
            # AUDIT 2026-08-02 — wait_for raccourci (60 s → 5 s) : point
            # d'ancrage pour (a) la revalidation de session (throttlée à
            # 60 s dans _session_recheck) et (b) le recyclage invisible —
            # quand l'évacuation tue le PTY (state.alive=False), la boucle
            # doit le voir en quelques secondes pour fermer le WS et laisser
            # le client rouvrir un shell sur un worker sain, au lieu de
            # retenir le worker mourant bloquée dans ws.receive().
            # La sémantique d'inactivité de 300 s est conservée via _last_recv.
            try:
                msg = await _aio.wait_for(ws.receive(), timeout=5.0)
            except _aio.TimeoutError:
                if time.monotonic() - _last_recv > 300.0:
                    logger.info(f"[PTY-WS] idle timeout uid={state.get('uid')} sid={state.get('sid')}")
                    break
                if not await _session_recheck():
                    break
                # Sonde de quota AUSSI sur le tic d'inactivité : un shell qui
                # remplit le disque (``dd``, build, téléchargement) ne reçoit
                # aucune frappe pendant ce temps — n'ancrer la sonde que sur
                # l'entrée clavier la rendrait inopérante précisément dans le
                # cas qu'elle doit couvrir.
                if not await _quota_check():
                    break
                continue
            _last_recv = time.monotonic()
            if not await _session_recheck():
                break
            if not await _quota_check():
                break
            mtype = msg.get("type")
            if mtype == "websocket.disconnect":
                break
            if mtype != "websocket.receive":
                continue

            # Binary frame = raw keystrokes → PTY stdin
            data_bytes = msg.get("bytes")
            if data_bytes is not None:
                if not _allow_frame():
                    # Silently drop. Dropping is safer than disconnecting
                    # because a brief xterm paste burst shouldn't kill
                    # the session.
                    continue
                try:
                    with state["lock"]:
                        os.write(master_fd, data_bytes)
                        state["last_io"] = time.time()
                except OSError:
                    break
                continue

            # Text frame = JSON control message (resize, ping)
            text = msg.get("text")
            if text is None:
                continue
            if len(text) > _WS_MAX_CTRL_BYTES:
                continue
            try:
                obj = _json.loads(text)
            except Exception:
                continue
            op = obj.get("op") or obj.get("type")
            if op == "resize":
                try:
                    rows = max(1, int(obj.get("rows", 24)))
                    cols = max(1, int(obj.get("cols", 80)))
                    _fcntl.ioctl(master_fd, _termios.TIOCSWINSZ,
                                 _struct.pack("HHHH", rows, cols, 0, 0))
                    try: os.kill(state["pid"], 28)  # SIGWINCH
                    except Exception: pass
                except Exception:
                    pass
            elif op == "ping":
                try:
                    await ws.send_json({"type": "pong"})
                except Exception:
                    break
            # Unknown ops are ignored (forward-compatible).
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.warning(f"[PTY-WS] loop error: {e}")
    finally:
        # AUDIT 2026-08-02 (F8) — writer_task peut être None si l'annulation
        # frappe avant sa création (désormais dans le try) ; on garde.
        if writer_task is not None:
            writer_task.cancel()
            try:
                await writer_task
            except (_aio.CancelledError, Exception):
                # Python 3.8+: asyncio.CancelledError inherits from
                # BaseException, not Exception, so a bare
                # ``except Exception`` DOES NOT catch it. We explicitly
                # include it here; otherwise uvicorn logs an unhandled
                # "Exception in ASGI application" every time a terminal
                # WebSocket closes (the CancelledError propagates from
                # the ``_writer`` coroutine we just cancelled).
                pass
        # Only remove reader if nobody newer has taken over (see note above).
        if state.get("stream_epoch", 0) == my_epoch:
            try: loop.remove_reader(master_fd)
            except Exception: pass
        if ws.client_state == WebSocketState.CONNECTED:
            try: await ws.close()
            except Exception: pass

