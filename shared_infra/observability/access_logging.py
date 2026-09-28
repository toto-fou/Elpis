# SPDX-License-Identifier: MIT
"""
backend.access_logging — Unified observability for both ``main`` and ``admin`` apps.

What this module gives you
==========================

1. **A single rotating JSON-Lines file** at ``user_db/logs/app.log.jsonl``
   that BOTH processes append to. Each line is one event with a stable
   schema:

   ::

       {
         "ts":       1714200000.123,
         "service":  "main"          # or "admin"
         "level":    "INFO",
         "category": "http",         # http | auth | admin | security | system | app
         "message":  "GET /api/health → 200 (3ms) uid=12 ip=127.0.0.1",
         "logger":   "uvicorn.error",
         "pid":      12345,
         "extras":   {...}           # method, path, status, user_id, ip, duration_ms…
       }

   Because writes use ``open(... 'a')`` (POSIX atomic-append for lines
   under PIPE_BUF, which our JSON lines easily are) two processes can
   share the file safely without a lock.

2. **An HTTP middleware** (:class:`RequestLoggingMiddleware`) that emits
   one ``http`` event per finished request with method/path/status/
   duration/user/ip. Useful paths (``/static``, ``/api/health``,
   ``/api/system-events``) are filtered to avoid drowning the live log
   in noise.

3. **A :class:`logging.Handler`** that mirrors every Python logging
   record into the same file, tagged with the running service name.

4. **A helper** :func:`log_event` for explicit application events
   (``log_event("admin", "INFO", "User 12 deleted", user_id=42)``)
   that bypass the standard ``logging`` ceremony.

5. **A reader** :func:`read_recent_events` used by the admin Logs tab to
   render a unified view of BOTH processes' activity.

Design choices
==============

* No external dependency — purely stdlib so it works under root with no
  ``site-packages``.
* No background thread — the file handler writes synchronously with
  ``os.write`` which is atomic for small lines on Linux. We tolerate
  the small per-request cost (≈0.05 ms) in exchange for no shared
  state between workers.
* Rotation is best-effort and cooperative: the first writer that
  notices the file exceeds ``LOG_MAX_BYTES`` renames it to ``.1`` and
  truncates. Concurrent writers detect the rename via fstat-on-open
  and try once more.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from starlette.requests import Request

# ─────────────────────────────────────────────────────────────────────────────
#  Configuration
# ─────────────────────────────────────────────────────────────────────────────
# We read PROJECT_ROOT lazily because backend.config may import other things
# that themselves import from here (circular protection).
_PROJECT_ROOT: Optional[Path] = None


def _project_root() -> Path:
    """Racine du dépôt, ANCRÉE sur ``config.PROJECT_ROOT``.

    ⚠ Comptait ``Path(__file__).parent.parent``. Le rangement par famille
    (2026-09-04) a fait descendre ce module d'un cran
    (``shared_infra/access_logging.py`` → ``shared_infra/observability/``) et
    la racine est devenue ``shared_infra/`` : les journaux d'accès partaient
    dans ``shared_infra/user_db/logs``, silencieusement. Compter des ``parent``
    lie un chemin à la PROFONDEUR du fichier, ce qu'aucun rangement ne doit
    pouvoir casser."""
    global _PROJECT_ROOT
    if _PROJECT_ROOT is None:
        try:
            from shared_infra.config import PROJECT_ROOT as _PR
            _PROJECT_ROOT = Path(_PR)
        except Exception:                       # config indisponible (boot très tôt)
            _PROJECT_ROOT = Path(__file__).resolve().parents[2]
    return _PROJECT_ROOT


_dir_ready_pid: Optional[int] = None


def _log_dir() -> Path:
    # (passe 6, B11) — le mkdir (2 syscalls) était payé à CHAQUE ligne de log ;
    # une fois par process suffit (le dossier n'est jamais supprimé en vie).
    global _dir_ready_pid
    p = _project_root() / "user_db" / "logs"
    if _dir_ready_pid != os.getpid():
        p.mkdir(parents=True, exist_ok=True)
        _dir_ready_pid = os.getpid()
    return p


def _log_path() -> Path:
    return _log_dir() / "app.log.jsonl"


# Service tag for every line. Set once at process start (see ``configure``).
SERVICE: str = os.environ.get("APP_SERVICE", "main").lower()

# Rotation threshold — 8 MB. With ~300 bytes/event that's ~28k events.
LOG_MAX_BYTES = 8 * 1024 * 1024
KEPT_ROTATIONS = 3  # keep .1 .2 .3, delete older

# Paths the HTTP middleware skips entirely (very chatty, no value).
_HTTP_SKIP_EXACT = {
    "/api/health",
    "/api/system-events",
    "/api/code/stream",
    "/api/code/pull",
    "/api/code/ingest",
    "/favicon.ico",
}
_HTTP_SKIP_PREFIXES = (
    "/static/",
    "/avatars/",
    # Livraisons webhook (Gitea → routines) : un dépôt actif noierait la
    # console Logs admin (chaque livraison serait rebroadcastée en SSE).
    # Le module webhooks logge lui-même les événements significatifs.
    "/api/webhooks/",
)


# When a 404 hits one of these prefixes on a process that intentionally
# does NOT expose them, downgrade the level from WARNING to DEBUG so the
# live Logs console stays uncluttered. The file still records the event
# (as DEBUG, included in the rotation) for forensic completeness — but
# the operator's live view isn't drowned by chat-side fetches that the
# admin page legitimately can't satisfy.
#
# Mode is read on each request from the env (so a hot mode change without
# restart wouldn't fool the filter — but mode changes always require a
# restart, so this is more documentation than runtime correctness).
#
# Each entry is ``(app_mode, path_prefix)`` — only paths matching the
# prefix on a process running in that mode get the downgrade.
_EXPECTED_404_BY_MODE = (
    # Admin process: chat / sandbox / saved / RAG / inbox / etc. live on
    # main and not here. ANY hit on these is a benign cross-process leak
    # from shared frontend code.
    ("admin", "/api/llm/"),
    ("admin", "/api/saved/"),
    ("admin", "/api/sandbox/"),
    ("admin", "/api/chat/"),
    ("admin", "/api/pipelines"),
    ("admin", "/api/inbox/"),
    ("admin", "/api/rag/"),
    ("admin", "/api/mcp/"),
    ("admin", "/api/playwright/"),
    ("admin", "/api/diag/"),
    ("admin", "/api/debug/"),
    ("admin", "/api/tools/"),
    ("admin", "/api/prompts"),
    ("admin", "/api/cli/"),
    ("admin", "/ws/"),
    # Main process: admin endpoints obviously don't live here. Hitting
    # them by mistake is rare (the bouton Admin is a navigation, not a
    # fetch) but a stray client could probe — we don't want to spam.
    ("main", "/api/admin/"),
)

# Categorization rules. Order matters — first match wins.
_CATEGORY_RULES = (
    (("/api/login-lite", "/api/logout-lite", "/api/users/change-password",
      "/api/me-lite"), "auth"),
    (("/api/admin/",), "admin"),
)


def _categorize(path: str) -> str:
    for prefixes, cat in _CATEGORY_RULES:
        for p in prefixes:
            if path == p or path.startswith(p):
                return cat
    return "http"


# ─────────────────────────────────────────────────────────────────────────────
#  Trusted-proxy resolution for X-Forwarded-For
# ─────────────────────────────────────────────────────────────────────────────
# SECURITY FIX (élevé) : on n'accepte X-Forwarded-For QUE si la connexion
# directe vient d'un proxy de confiance — sinon n'importe quel client
# public peut falsifier son IP dans les logs.
#
# Configuration : ``ACCESS_LOG_TRUSTED_PROXIES`` (env), CSV d'IPs ou
# CIDRs. Défaut sûr = loopback (127.0.0.0/8 + ::1) parce que dans 95%
# des déploiements le reverse-proxy tourne sur la même machine. Pour
# un setup à plusieurs machines, lister explicitement (ex.
# "10.0.0.0/8,10.1.2.3").
def _parse_trusted_proxies(spec: str) -> tuple:
    import ipaddress
    nets = []
    for raw in (spec or "").split(","):
        s = raw.strip()
        if not s:
            continue
        try:
            # Accepts both single IPs ("10.0.0.1") and CIDRs ("10.0.0.0/8").
            nets.append(ipaddress.ip_network(s, strict=False))
        except ValueError:
            # Silently skip invalid entries — operator misconfig shouldn't
            # crash the logger. The default loopback whitelist still applies.
            continue
    return tuple(nets)


_TRUSTED_PROXIES = _parse_trusted_proxies(
    os.environ.get("ACCESS_LOG_TRUSTED_PROXIES", "127.0.0.0/8,::1")
)


def _is_trusted_proxy(host: str) -> bool:
    """Return True iff ``host`` (string IP) is in the trusted-proxy whitelist."""
    if not host or not _TRUSTED_PROXIES:
        return False
    try:
        import ipaddress
        ip = ipaddress.ip_address(host)
        return any(ip in net for net in _TRUSTED_PROXIES)
    except ValueError:
        return False


def _resolve_client_ip(request: "Request") -> str:
    """Resolve the real client IP, honouring XFF only via trusted proxies.

    Returns ``"?"`` if no IP can be determined (rare but possible in test
    harnesses where ``request.client`` is None).
    """
    try:
        peer = request.client.host if request.client else None
    except Exception:
        peer = None
    if peer and _is_trusted_proxy(peer):
        # The connection came through a trusted proxy → believe XFF.
        # Take only the FIRST entry (= the original client). Subsequent
        # entries are intermediate proxies and may themselves be
        # untrusted.
        try:
            xff = request.headers.get("x-forwarded-for", "")
            if xff:
                first = xff.split(",")[0].strip()
                if first:
                    return first
        except Exception:
            pass
    # Fallback : direct peer (untamperable). May be a private IP if a
    # proxy IS present but isn't in the whitelist — that's the safe
    # behaviour (visibly the proxy IP, no spoofing possible).
    return peer or "?"


# ─────────────────────────────────────────────────────────────────────────────
#  File writer (rotation-aware, lock-free)
# ─────────────────────────────────────────────────────────────────────────────
_rotate_lock = threading.Lock()  # only used to serialize the rotate path


def _rotate_if_needed() -> None:
    """Cheap: check size, rotate if too big. Called at most once per write."""
    p = _log_path()
    try:
        size = p.stat().st_size
    except FileNotFoundError:
        return
    except OSError:
        return
    if size < LOG_MAX_BYTES:
        return
    # Serialize the rotation path; the lock is process-local but the rotation
    # is an atomic ``rename`` on Linux so cross-process races just lose the
    # newest few bytes — acceptable.
    with _rotate_lock:
        try:
            # Re-check under lock
            if p.stat().st_size < LOG_MAX_BYTES:
                return
            # Drop oldest, shift others
            for i in range(KEPT_ROTATIONS, 0, -1):
                src = p.with_suffix(p.suffix + f".{i}")
                if i == KEPT_ROTATIONS and src.exists():
                    try:
                        src.unlink()
                    except OSError:
                        pass
                    continue
                if src.exists():
                    src.rename(p.with_suffix(p.suffix + f".{i + 1}"))
            p.rename(p.with_suffix(p.suffix + ".1"))
            # (passe 6, B11) — le fd caché pointe maintenant le fichier
            # tourné : on l'abandonne, la prochaine écriture recrée app.log.
            _drop_log_fd()
        except OSError:
            pass


# ─────────────────────────────────────────────────────────────────────────────
#  Diffusion LIVE vers la console staff
#
#  AUDIT moteur d'événements 2026-09-25 (A3/B7) — il n'y a plus de « pont »
#  process-local (``set_live_sink``) : il ne servait que le staff branché sur
#  le worker émetteur, et perdait les lignes écrites depuis un thread. Chaque
#  worker suit désormais CE fichier (``events_bus._staff_log_tail_loop``) et
#  relaie à ses clients staff les lignes qui ne portent pas ``"live": false``.
# ─────────────────────────────────────────────────────────────────────────────


def write_event(
    level: str,
    category: str,
    message: str,
    *,
    logger_name: str = "app",
    extras: Optional[Dict[str, Any]] = None,
    live: bool = True,
) -> None:
    """Append one event line to the shared JSONL log file.

    Safe to call from any thread or process — a single ``write()`` syscall
    on a file opened in append mode is atomic on Linux for byte counts
    under PIPE_BUF (4096), which our records always are.

    ``live=False`` marque la ligne (``"live": false``) : elle reste dans le
    fichier mais la console staff live ne la relaie pas (lignes forensiques
    à fort volume, ex. HTTP 2xx).
    """
    record = {
        "ts": time.time(),
        "service": SERVICE,
        "level": level,
        "category": category,
        "message": message[:2000],  # cap defensively
        "logger": logger_name,
        "pid": os.getpid(),
    }
    if not live:
        record["live"] = False
    if extras:
        # Filter to JSON-safe values to avoid breaking the line.
        safe = {}
        for k, v in extras.items():
            try:
                json.dumps(v)
                safe[k] = v
            except (TypeError, ValueError):
                safe[k] = repr(v)[:200]
        record["extras"] = safe
    line = json.dumps(record, ensure_ascii=False) + "\n"
    encoded = line.encode("utf-8", errors="replace")
    # AUDIT 2026-09-01 (passe 6, B11) — fd O_APPEND mis en cache PAR PROCESS :
    # l'ancien open/write/close par ligne coûtait ~5 syscalls à CHAQUE
    # enregistrement — payés sur la boucle d'événements par chaque
    # ``logger.info`` du harnais et chaque requête HTTP (handler branché sur le
    # logger racine). L'atomicité O_APPEND sous PIPE_BUF ne dépend pas de la
    # fraîcheur du fd. Écriture SOUS verrou (cf. _write_line_locked) : pas de
    # course de réutilisation de numéro de fd entre threads.
    if not _write_line_locked(encoded):
        return  # never raise from logging
    # Rotation check is amortized: only do it after every ~256 writes per pid
    # to avoid the stat() syscall on every event.
    _maybe_rotate()


_write_counter = 0
_write_counter_lock = threading.Lock()

# (passe 6, B11) — fd O_APPEND caché par process. Toute manipulation (ouvrir,
# écrire, fermer) se fait SOUS ``_fd_lock`` : sans lui, un thread pourrait
# écrire sur un numéro de fd fermé/réattribué par un autre (os.write vers un
# fichier arbitraire). Un os.write sous verrou reste très court.
_fd_lock = threading.Lock()
_log_fd: Optional[int] = None
_log_fd_pid: Optional[int] = None


def _open_log_fd_locked() -> bool:
    """(Ré)ouvre le fd caché — appelant DÉJÀ sous ``_fd_lock``."""
    global _log_fd, _log_fd_pid
    if _log_fd is not None:
        try:
            os.close(_log_fd)
        except OSError:
            pass
    try:
        # (passe 7, R10) — le dossier peut disparaître en vie (nettoyage
        # externe, remontage) : sans ce mkdir à la (ré)ouverture, ``open``
        # échouait pour toujours et TOUTES les lignes suivantes du process
        # étaient perdues. Payé seulement ici, jamais par ligne.
        _p = _log_path()
        _p.parent.mkdir(parents=True, exist_ok=True)
        _log_fd = os.open(str(_p),
                          os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
        _log_fd_pid = os.getpid()
        return True
    except OSError:
        _log_fd = None
        _log_fd_pid = None
        return False


def _write_line_locked(encoded: bytes) -> bool:
    """Append d'une ligne sur le fd caché (rouvert au besoin — fork, erreur).
    False = I/O définitivement impossible pour cette ligne."""
    global _log_fd, _log_fd_pid
    with _fd_lock:
        if _log_fd is None or _log_fd_pid != os.getpid():
            if not _open_log_fd_locked():
                return False
        try:
            os.write(_log_fd, encoded)
            return True
        except OSError:
            # fd invalidé (fichier déplacé, disque plein transitoire…) :
            # une seule reprise sur un fd frais.
            if not _open_log_fd_locked():
                return False
            try:
                os.write(_log_fd, encoded)
                return True
            except OSError:
                return False


def _drop_log_fd() -> None:
    """Ferme et oublie le fd caché (après une rotation locale)."""
    global _log_fd, _log_fd_pid
    with _fd_lock:
        if _log_fd is not None:
            try:
                os.close(_log_fd)
            except OSError:
                pass
        _log_fd = None
        _log_fd_pid = None


def _revalidate_log_fd() -> None:
    """Rouvre le fd si le CHEMIN pointe un autre inode (rotation faite par un
    AUTRE worker). Appelé à la cadence amortie de ``_maybe_rotate`` : au pire
    ~255 lignes partent dans le fichier tourné — même classe de tolérance que
    la course de rotation cross-process documentée dans ``_rotate_if_needed``."""
    with _fd_lock:
        if _log_fd is None or _log_fd_pid != os.getpid():
            return
        try:
            if os.fstat(_log_fd).st_ino != os.stat(str(_log_path())).st_ino:
                _open_log_fd_locked()
        except OSError:
            _open_log_fd_locked()


_last_reval_ts = 0.0
_REVAL_EVERY_S = 2.0


def _maybe_rotate() -> None:
    global _write_counter, _last_reval_ts
    with _write_counter_lock:
        _write_counter += 1
        check = (_write_counter % 256 == 0)
        # (passe 7, R10) — borne TEMPORELLE en plus de la cadence par
        # nombre de lignes : un worker peu bavard écrivait jusqu'à 255
        # lignes dans l'inode tourné par un AUTRE worker (invisibles dans la
        # console Logs). Un ``stat`` toutes les 2 s au plus.
        _now = time.monotonic()
        reval = check or (_now - _last_reval_ts) >= _REVAL_EVERY_S
        if reval:
            _last_reval_ts = _now
    if check:
        _rotate_if_needed()
    if reval:
        _revalidate_log_fd()


# ─────────────────────────────────────────────────────────────────────────────
#  Convenience helpers
# ─────────────────────────────────────────────────────────────────────────────
def log_event(
    category: str,
    level: str,
    message: str,
    *,
    live: bool = True,
    **extras: Any,
) -> None:
    """Emit an explicit application-level event.

    ``category`` should be one of: ``auth``, ``admin``, ``security``,
    ``system``, ``app``, ``http``. Free-form values are accepted but
    filtering in the UI is built around the listed set.

    ``live=False`` writes ONLY to the JSONL file and skips the live SSE
    broadcast — useful for high-frequency events (HTTP request log) where
    flooding the SSE queue would crowd out signal.
    """
    write_event(level.upper(), category, message, extras=extras, live=live)


# ─────────────────────────────────────────────────────────────────────────────
#  Python ``logging`` integration
# ─────────────────────────────────────────────────────────────────────────────
class FileEventHandler(logging.Handler):
    """A :mod:`logging` handler that mirrors every record to the JSONL file.

    Bridges the existing ``logger.warning(...)`` / ``logger.info(...)`` calls
    scattered all over the codebase into the unified observability stream
    without touching any of those call sites.
    """

    def emit(self, record: logging.LogRecord) -> None:
        try:
            msg = self.format(record)
        except Exception:
            try:
                msg = record.getMessage()
            except Exception:
                return
        # Avoid recursive logging if Anthropic's libs log inside our handler.
        try:
            # 2026-09-25 — ligne LIVE : la console staff suit ce fichier
            # (cf. events_bus._staff_log_tail_loop) ; c'est désormais le
            # SEUL chemin de diffusion, donc aucun doublon possible.
            write_event(
                level=record.levelname,
                category="system" if record.levelname in ("ERROR", "CRITICAL") else "app",
                message=msg,
                logger_name=record.name,
            )
        except Exception:
            pass


# ─────────────────────────────────────────────────────────────────────────────
#  HTTP middleware
# ─────────────────────────────────────────────────────────────────────────────
class RequestLoggingMiddleware:
    """One JSONL event per finished HTTP request (with smart filtering).

    Pure-ASGI on purpose — NOT a ``BaseHTTPMiddleware``. The latter wraps every
    request in an anyio task group plus a memory-object stream, and the whole
    response body crosses that extra queue chunk by chunk. Measured on this
    stack, for the two layers this app mounts (CSRF + logging):

        plain JSON response      385 µs  →  0.7 µs
        NDJSON, 2000 lines       122 ms  →  0.35 ms

    The streaming figure is the one that matters: ~60 µs of pure plumbing per
    streamed token, on the hottest path of the product.

    All this middleware ever needed was the status code, which pure ASGI hands
    over in the ``http.response.start`` message.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")

        # Skip routine endpoints to avoid drowning the log
        if path in _HTTP_SKIP_EXACT or path.startswith(_HTTP_SKIP_PREFIXES):
            await self.app(scope, receive, send)
            return

        request = Request(scope, receive)
        start = time.perf_counter()
        status: int = 0
        error_text: Optional[str] = None

        async def send_wrapper(message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception as exc:
            # Starlette's own exception handling sits BELOW us and normally
            # already answered 500; if nothing was sent, record it as one.
            status = status or 500
            error_text = repr(exc)[:200]
            raise
        finally:
            dur_ms = int((time.perf_counter() - start) * 1000)
            # Pull user from session if available (added by SessionMiddleware).
            user_id: Optional[int] = None
            try:
                if hasattr(request, "session"):
                    sid = request.session.get("user_id")
                    if sid is not None:
                        user_id = int(sid)
            except Exception:
                user_id = None
            # Client IP — honour X-Forwarded-For ONLY when the immediate
            # peer is in TRUSTED_PROXIES.
            #
            # SECURITY FIX (élevé) : avant on prenait XFF sans vérifier
            # qui l'avait posé → n'importe quel client public pouvait
            # spoofer son IP dans les logs et dans tous les codes de
            # contrôle qui consomment cette valeur. La whitelist
            # ``ACCESS_LOG_TRUSTED_PROXIES`` (CSV d'IPs/CIDRs, défaut
            # = loopback only) garantit que XFF n'est lu que si le
            # connecteur direct est un reverse-proxy de confiance ;
            # sinon on retombe sur ``request.client.host`` qui ne peut
            # pas être falsifié.
            ip = _resolve_client_ip(request)
            category = _categorize(path)
            # Level: 4xx → WARNING, 5xx → ERROR, else INFO
            if status >= 500:
                level = "ERROR"
            elif status >= 400:
                level = "WARNING"
            else:
                level = "INFO"
            # Downgrade expected 404s on the wrong process from WARNING to
            # DEBUG. Without this, every chat-side fetch that leaks to the
            # admin port (loadAvailableModels at SSE reconnect, residual
            # /api/saved/chats from a stale tab, etc.) shows up as a
            # WARNING in the Logs tab — visually screaming "something's
            # broken" when in fact this is the normal cross-port silence.
            if status == 404:
                for mode, prefix in _EXPECTED_404_BY_MODE:
                    if SERVICE == mode and path.startswith(prefix):
                        level = "DEBUG"
                        break
            # Hide query string from message (may contain tokens), but keep
            # path. The full URL is not logged on purpose.
            uid_str = f"uid={user_id}" if user_id is not None else "uid=-"
            msg = (
                f"{request.method} {path} → {status} "
                f"({dur_ms}ms) {uid_str} ip={ip}"
            )
            if error_text:
                msg += f" err={error_text}"
            extras = {
                "method":      request.method,
                "path":        path,
                "status":      status,
                "duration_ms": dur_ms,
                "user_id":     user_id,
                "ip":          ip,
            }
            try:
                # Live SSE broadcast is selective: every error, every admin
                # action, every auth event, but only a sampled view of routine
                # 2xx user traffic — otherwise the live console drowns in
                # GET /api/saved/chats / GET /api/llm/models / etc. and the
                # interesting events get shifted off-screen in seconds.
                #
                # DEBUG events (= expected-404 downgrades from the block
                # above) NEVER go live — they're forensic-only and would
                # defeat the whole point of the downgrade if we still
                # broadcast them.
                live = (
                    level != "DEBUG"
                    and (
                        status >= 400
                        or category in ("admin", "auth", "security")
                        or path.startswith("/api/admin")
                    )
                )
                write_event(level, category, msg,
                            logger_name="http", extras=extras, live=live)
            except Exception:
                pass


# ─────────────────────────────────────────────────────────────────────────────
#  Reader for the admin Logs tab
# ─────────────────────────────────────────────────────────────────────────────
def read_recent_events(
    limit: int = 500,
    *,
    services: Optional[Iterable[str]] = None,
    levels: Optional[Iterable[str]] = None,
    categories: Optional[Iterable[str]] = None,
    since_ts: Optional[float] = None,
) -> List[Dict[str, Any]]:
    """Read the tail of the shared JSONL log, optionally filtered.

    Reads the current segment + ``.1`` rotation if needed to satisfy
    ``limit``. Returns OLDEST-first list of records (so the UI can
    append-render).
    """
    files: List[Path] = [_log_path()]
    rotated = _log_path().with_suffix(_log_path().suffix + ".1")
    if rotated.exists():
        files.append(rotated)

    services_set = {s.lower() for s in services} if services else None
    levels_set = {l.upper() for l in levels} if levels else None
    categories_set = {c.lower() for c in categories} if categories else None

    # Read newest first across files, accumulate up to ``limit`` matches,
    # then reverse for chronological order.
    out: List[Dict[str, Any]] = []
    for f in files:
        try:
            data = f.read_bytes()
        except FileNotFoundError:
            continue
        except OSError:
            continue
        # Iterate lines from the end
        # (cheap enough for our 8 MB cap; if files were larger we'd seek).
        for line in reversed(data.splitlines()):
            if not line:
                continue
            try:
                rec = json.loads(line.decode("utf-8", errors="replace"))
            except Exception:
                continue
            if services_set and rec.get("service", "").lower() not in services_set:
                continue
            if levels_set and rec.get("level", "").upper() not in levels_set:
                continue
            if categories_set and rec.get("category", "").lower() not in categories_set:
                continue
            if since_ts is not None and rec.get("ts", 0) < since_ts:
                continue
            out.append(rec)
            if len(out) >= limit:
                break
        if len(out) >= limit:
            break
    out.reverse()  # oldest-first for the UI
    return out


# ─────────────────────────────────────────────────────────────────────────────
#  Setup helper
# ─────────────────────────────────────────────────────────────────────────────
#: Racines des loggers APPLICATIFS. Tout ce qui n'emprunte pas
#: ``uvicorn.error`` (les modules en ``getLogger(__name__)``, et
#: ``elpis.compressor``) propage jusqu'au logger racine — dont personne ne
#: règle le niveau, qui reste donc à ``WARNING``. Leurs ``logger.info`` étaient
#: écartés AVANT d'atteindre le handler : vérifié sur les journaux, zéro
#: enregistrement INFO du compresseur ou de l'outil sous-agents, jamais, alors
#: que leurs WARNING y sont. C'est ce qui rendait une compaction invisible.
#: Le niveau est posé sur ces racines-là et pas sur le logger racine : les
#: bibliothèques tierces (httpx, asyncio…) restent silencieuses.
_APP_LOGGER_ROOTS = (
    "elpis", "llm_core", "shared_infra", "chatbot_app", "rag_app", "server",
)


def _apply_app_log_level() -> None:
    """Pose le niveau des loggers applicatifs (``APP_LOG_LEVEL``, défaut INFO).

    Idempotent, et sans effet sur le logger racine."""
    level = (os.environ.get("APP_LOG_LEVEL") or "INFO").strip().upper()
    if level not in ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"):
        level = "INFO"
    for name in _APP_LOGGER_ROOTS:
        logging.getLogger(name).setLevel(level)


def configure(service: str) -> None:
    """Wire the ``logging`` handler for the given service tag.

    Called once from each entry point (``app.py``, ``admin_app.py``).
    Idempotent — multiple calls add at most one handler.
    """
    global SERVICE
    SERVICE = (service or "main").lower()

    # Avant le retour anticipé ci-dessous : un second appel doit pouvoir
    # re-poser le niveau (rechargement de configuration) sans re-brancher le
    # handler.
    _apply_app_log_level()

    root = logging.getLogger()
    # Avoid duplicating the handler on reload
    for h in root.handlers:
        if isinstance(h, FileEventHandler):
            return
    handler = FileEventHandler()
    handler.setFormatter(
        logging.Formatter("%(message)s")  # message only — schema is JSON
    )
    root.addHandler(handler)
    # Also attach to uvicorn's loggers explicitly (they don't always
    # propagate to root depending on configuration).
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logging.getLogger(name).addHandler(handler)
    # Mark the start of this process in the unified log.
    write_event(
        "INFO", "system",
        f"Service '{SERVICE}' starting (pid={os.getpid()})",
        logger_name="access_logging",
    )
