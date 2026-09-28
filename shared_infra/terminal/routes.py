# SPDX-License-Identifier: MIT
"""
backend.routes.terminal — PTY-backed terminal HTTP endpoints.

This module exposes ONLY the HTTP routes. The PTY plumbing (spawn, ioctl,
session-row CRUD, WebSocket loop, cleanup tasks) stays in ``_legacy.py``
because it is interwoven with module-level state — ``_terminals``,
``_term_global_lock``, ``DEFAULT_SID``, ``MAX_SESSIONS_PER_USER``,
``_PTY_IDLE_TIMEOUT_SEC``, ``_kill_terminal``, ``shutdown_all_terminals``
— that is also consumed by ``backend/routes/admin.py`` and by ``app.py``
shutdown hooks. Splitting it would mean updating four modules at once;
better to do that as a separate, focused refactor.

Endpoints
---------
Default-session passthrough (legacy single-PTY UI)
- POST /api/terminal/input            — write keystrokes to the PTY
- POST /api/terminal/resize           — TIOCSWINSZ + SIGWINCH
- GET  /api/terminal/stream           — SSE: PTY stdout (base64 chunks),
                                         keepalive every 15 s, also enforces
                                         the per-user sandbox quota (kills
                                         the PTY if quota is exceeded)
- POST /api/terminal/kill             — kill the legacy default session

Multi-session terminal (VS-Code-style named sessions)
- POST   /api/terminal/sessions        — create a new named session
- GET    /api/terminal/sessions        — list mine
- PATCH  /api/terminal/sessions/{sid}  — rename
- DELETE /api/terminal/sessions/{sid}  — delete (best-effort PTY kill)
"""
from __future__ import annotations

import asyncio
import os
import re
import time
from pathlib import Path

from fastapi import HTTPException, Request, WebSocket
from fastapi.responses import StreamingResponse

from shared_infra.config import read_config_json
from shared_infra.security.deps import require_user_id
from shared_infra.accounts.users import get_user_settings
from shared_infra.routes._state import router

# All the heavy lifting still lives in ``_legacy``. Importing through the
# module reference (rather than ``from backend.routes._legacy import ...``)
# means we always observe the *current* value of mutables like ``_terminals``,
# even after another module mutates them.
from shared_infra.routes._helpers import logger, sandbox_usage_bytes
from shared_infra.terminal.pty import DEFAULT_SID, MAX_SESSIONS_PER_USER, _delete_session_row, _fcntl, _get_or_create_terminal, _get_session_row, _insert_session_row, _kill_local_session, _kill_terminal, _list_session_rows, _rename_session_row, _struct, _term_global_lock, _terminal_ws_loop, _terminals, _termios, _touch_session_row, _valid_sid, _ws_auth_uid


# ─────────────────────────────────────────────────────────────────────────────
#  DEFAULT SESSION  (legacy single-PTY UI)
# ─────────────────────────────────────────────────────────────────────────────
@router.post("/api/terminal/input")
async def api_terminal_input(request: Request):
    """Send keystrokes to the PTY."""
    uid = require_user_id(request)
    data = await request.json()
    text = data.get("data", "")
    if not text:
        return {"ok": True}
    # AUDIT 2026-08-31 (passe 2) — _get_or_create_terminal peut SPAWNER :
    # verrou de process + ``docker inspect`` (5 s max) + sonde ``docker exec``
    # (10 s max) + ``os.fork``. Exécuté sur la boucle, il gelait TOUS les flux
    # du worker le temps d'un aller-retour dockerd. En threadpool — la
    # fonction est thread-safe (c'est déjà un threading.Lock) et le fork/exec
    # depuis un thread ouvrier est sans état partagé. Idem sur les 4 autres
    # points d'entrée (resize, stream, ws ×2).
    state = await asyncio.to_thread(_get_or_create_terminal, uid)
    try:
        with state["lock"]:
            os.write(state["master_fd"], text.encode("utf-8", errors="replace"))
            state["last_io"] = time.time()
    except OSError:
        return {"ok": False, "error": "terminal closed"}
    return {"ok": True}


@router.post("/api/terminal/resize")
async def api_terminal_resize(request: Request):
    uid = require_user_id(request)
    data = await request.json()
    # BUG FIX (mineur) : avant, ``int(data.get("rows", 24))`` plantait avec
    # ValueError → HTTP 500 si le client envoyait ``rows: "abc"`` ou
    # ``rows: null``. On valide explicitement pour renvoyer un 400 propre
    # (les clients legitimes utilisent toujours des entiers, mais une
    # extension navigateur fantaisiste ou un test manuel peut casser).
    try:
        rows = max(1, int(data.get("rows", 24)))
        cols = max(1, int(data.get("cols", 80)))
    except (TypeError, ValueError):
        raise HTTPException(400, "rows/cols doivent être des entiers positifs")
    state = await asyncio.to_thread(_get_or_create_terminal, uid)
    try:
        # ``_fcntl``, ``_termios``, ``_struct`` are aliases imported in
        # ``_legacy`` — re-use them through the module reference so we
        # don't re-import the same C extension twice.
        _fcntl.ioctl(
            state["master_fd"], _termios.TIOCSWINSZ,
            _struct.pack("HHHH", rows, cols, 0, 0),
        )
        os.kill(state["pid"], 28)  # SIGWINCH
    except Exception:
        pass
    return {"ok": True}


@router.get("/api/terminal/stream")
async def api_terminal_stream(request: Request):
    """SSE endpoint: streams PTY output via async I/O."""
    uid = require_user_id(request)
    state = await asyncio.to_thread(_get_or_create_terminal, uid)
    master_fd = state["master_fd"]

    state["stream_epoch"] = state.get("stream_epoch", 0) + 1
    my_epoch = state["stream_epoch"]

    # AUDIT 2026-08-02 (S1) — matière à revalidation périodique du flux
    # (cf. _terminal_ws_loop). Capturé au handshake : le générateur ne
    # revoit jamais le cookie.
    _sess_login_ts = request.session.get("_login_ts")
    _sess_sid = request.session.get("_sid")

    import base64 as _b64

    async def _generate():
        loop = asyncio.get_event_loop()
        queue: asyncio.Queue = asyncio.Queue(maxsize=64)

        # Contre-pression (audit moteur d'événements 2026-09-25, B6) — même
        # mécanique que ``_terminal_ws_loop`` : file pleine ⇒ on cesse de lire
        # le PTY au lieu de JETER un chunk déjà lu (xterm corrompu), et la fin
        # du shell ne peut plus se perdre dans une file saturée.
        _flow = {"paused": False, "eof": False}

        def _signal_eof():
            _flow["eof"] = True
            try:
                queue.put_nowait(b'')
            except asyncio.QueueFull:
                pass

        def _maybe_resume():
            if not _flow["paused"] or queue.qsize() > queue.maxsize // 2:
                return
            _flow["paused"] = False
            if state.get("stream_epoch", 0) != my_epoch or not state.get("alive", False):
                return
            try:
                loop.add_reader(master_fd, _on_readable)
            except (OSError, ValueError):
                pass

        def _on_readable():
            # BUG FIX C6 — early-return si state.alive=False (cleanup externe).
            # Voir _terminal_ws_loop pour le détail. Même fenêtre de race.
            if not state.get("alive", False):
                _signal_eof()
                return
            if queue.full():
                if not _flow["paused"]:
                    _flow["paused"] = True
                    try:
                        loop.remove_reader(master_fd)
                    except (OSError, ValueError):
                        pass
                return
            try:
                chunk = os.read(master_fd, 16384)
                if chunk:
                    queue.put_nowait(chunk)   # place garantie (full() testé)
                else:
                    _signal_eof()
            except BlockingIOError:
                pass
            except OSError:
                _signal_eof()
                # Remove reader immédiat
                try:
                    loop.remove_reader(master_fd)
                except (OSError, ValueError):
                    pass

        # AUDIT 2026-08-02 (E4) — ces lectures (SQLite + config) étaient
        # APRÈS add_reader et HORS du try/finally : un « database is
        # locked » sous contention WAL tuait le générateur sans exécuter
        # remove_reader → le callback continuait de lire le PTY vers une
        # queue que personne ne draine (sortie du shell jetée en silence).
        # On les fait AVANT add_reader, et best-effort : un échec de
        # lecture du quota ne doit pas priver l'utilisateur du terminal.
        try:
            _qs = get_user_settings(uid)
            _qc = read_config_json() or {}
            _quota_bytes = int(_qs.get("sandbox_quota_mb",
                               _qc.get("app", {}).get("sandbox_quota_mb", 5120))) * 1024 * 1024
        except Exception:
            _quota_bytes = 5120 * 1024 * 1024
        _qt = 0

        loop.add_reader(master_fd, _on_readable)

        _last_sess_check = time.time()

        try:
            while state["alive"]:
                if state.get("stream_epoch", 0) != my_epoch:
                    break
                if await request.is_disconnected():
                    break
                # Recyclage invisible (audit 2026-08-02) — worker en cours
                # d'arrêt : fin de flux propre ; le client (repli SSE legacy)
                # reconnecte en ~1,5 s et retrouve un shell sur un worker
                # sain (le PTY meurt avec ce worker de toute façon).
                try:
                    from sse_starlette.sse import AppStatus
                    if AppStatus.should_exit:
                        yield "data: [EOF]\n\n"
                        break
                except ImportError:
                    pass
                # AUDIT 2026-08-02 (S1) — revalidation périodique : une
                # session expirée/révoquée fermait ses requêtes HTTP mais
                # gardait ce flux (et le shell) vivants indéfiniment. Le
                # marqueur est intercepté par le client (cf. _connectSSEFor)
                # qui purge et affiche l'écran de connexion.
                if time.time() - _last_sess_check >= 60.0:
                    _last_sess_check = time.time()
                    try:
                        from shared_infra.security.deps import stream_session_still_valid
                        _still = await asyncio.to_thread(
                            stream_session_still_valid, uid, _sess_login_ts, _sess_sid)
                    except Exception:
                        _still = True
                    if not _still:
                        yield "data: [SESSION_EXPIRED]\n\n"
                        break
                if _flow["eof"] and queue.empty():
                    chunk = b''
                else:
                    try:
                        chunk = await asyncio.wait_for(queue.get(), timeout=15.0)
                    except asyncio.TimeoutError:
                        yield ": keepalive\n\n"
                        continue
                    _maybe_resume()
                if not chunk:
                    yield "data: [EOF]\n\n"
                    break
                state["last_io"] = time.time()
                yield f"data: {_b64.b64encode(chunk).decode('ascii')}\n\n"
                _qt += 1
                if _qt >= 33:
                    _qt = 0
                    try:
                        # AUDIT PERF 2026-08-08 — deux défauts ici :
                        #  1. ``_sandbox_size_bytes`` lançait un ``du -sb``
                        #     SYNCHRONE, donc DIRECTEMENT sur la boucle
                        #     d'événements : 36 ms sur une petite sandbox,
                        #     314 ms sur un projet avec node_modules — et
                        #     pendant ce temps le worker ENTIER est figé pour
                        #     TOUS les utilisateurs, pas seulement celui qui
                        #     tape. Toutes les 33 trames de sortie, donc en
                        #     permanence pendant un build.
                        #  2. aucun cache : chaque échéance repayait le
                        #     parcours complet de l'arbre.
                        # → calcul déporté dans un thread + compteur mis en
                        #   cache (``quota_bytes`` force le recalcul EXACT dès
                        #   90 % du quota, donc l'enforcement reste fiable).
                        _used = await asyncio.to_thread(
                            sandbox_usage_bytes, uid, Path(state["root"]),
                            quota_bytes=_quota_bytes)
                        if _used > _quota_bytes:
                            _warn = ("\r\n\033[41;97m ⚠  QUOTA DÉPASSÉ \033[0m\r\n").encode()
                            yield f"data: {_b64.b64encode(_warn).decode('ascii')}\n\n"
                            try:
                                os.kill(state["pid"], 9)
                            except Exception:
                                pass
                            state["alive"] = False
                            yield "data: [EOF]\n\n"
                            break
                    except Exception:
                        pass
        finally:
            # Only unregister the reader if we are still the active stream.
            # Otherwise a newer stream has already replaced our reader with
            # its own; calling remove_reader here would unregister *its*
            # reader and cause the new stream to hang silently.
            if state.get("stream_epoch", 0) == my_epoch:
                try:
                    loop.remove_reader(master_fd)
                except Exception:
                    pass

    return StreamingResponse(
        _generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/api/terminal/kill")
def api_terminal_kill(request: Request):
    """Kill the legacy default session only.

    Named sessions (multi-session UI) are killed via
    DELETE /api/terminal/sessions/{sid} which also removes the DB row.
    """
    uid = require_user_id(request)
    with _term_global_lock:
        st = _terminals.pop((uid, DEFAULT_SID), None)
        if st:
            _kill_terminal(st)
    return {"ok": True}


# ─────────────────────────────────────────────────────────────────────────────
#  MULTI-SESSION TERMINAL  (VS-Code-style named sessions)
# ─────────────────────────────────────────────────────────────────────────────
@router.post("/api/terminal/sessions")
async def api_terminal_sessions_create(request: Request):
    """Create a new named terminal session. Returns {id, name, ...}."""
    uid = require_user_id(request)
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    name = (body.get("name") if isinstance(body, dict) else None) or ""
    name = str(name).strip()[:64]
    if not name:
        name = _next_default_session_name(uid)
    # (passe 5, B5) — INSERT sous BEGIN IMMEDIATE : hors boucle.
    row = await asyncio.to_thread(_insert_session_row, uid, None, name)
    return {"ok": True, "session": row, "max": MAX_SESSIONS_PER_USER}


_DEFAULT_NAME_RE = re.compile(r"^Terminal (\d+)$")


def _next_default_session_name(uid: int) -> str:
    """Premier « Terminal N » LIBRE pour cet utilisateur.

    L'ancienne formule ``count + 1`` produisait des DOUBLONS dès qu'on fermait
    un onglet du milieu : avec Terminal 1/2/3 ouverts, fermer le 2 ramène le
    compte à 2, donc le suivant s'appelait « Terminal 3 » — deux onglets du
    même nom, impossibles à distinguer dans la barre. On cherche donc le plus
    petit entier non utilisé parmi les noms par défaut existants (les noms
    personnalisés par l'utilisateur sont ignorés : ils ne participent pas à la
    numérotation).
    """
    used: set = set()
    try:
        for row in _list_session_rows(uid, tid=None):
            m = _DEFAULT_NAME_RE.match(str((row or {}).get("name") or "").strip())
            if m:
                used.add(int(m.group(1)))
    except Exception:                                           # noqa: BLE001
        return "Terminal 1"
    n = 1
    while n in used:
        n += 1
    return f"Terminal {n}"


@router.get("/api/terminal/sessions")
def api_terminal_sessions_list(request: Request):
    """List the user's named terminal sessions."""
    uid = require_user_id(request)
    sessions = _list_session_rows(uid, tid=None)
    return {"sessions": sessions, "max": MAX_SESSIONS_PER_USER}


@router.patch("/api/terminal/sessions/{sid}")
async def api_terminal_sessions_rename(request: Request, sid: str):
    uid = require_user_id(request)
    if not _valid_sid(sid):
        raise HTTPException(400, "invalid sid")
    body = await request.json()
    name = (body.get("name") or "").strip() if isinstance(body, dict) else ""
    if not name:
        raise HTTPException(400, "name required")
    ok = _rename_session_row(sid, uid, name, tid=None)
    if not ok:
        raise HTTPException(404, "session not found")
    return {"ok": True}


@router.delete("/api/terminal/sessions/{sid}")
def api_terminal_sessions_delete(request: Request, sid: str):
    uid = require_user_id(request)
    if not _valid_sid(sid):
        raise HTTPException(400, "invalid sid")
    removed = _delete_session_row(sid, uid, tid=None)
    if not removed:
        # Still try the local kill (defensive — DB row may have been
        # deleted by a parallel call; PTY cleanup should still happen).
        _kill_local_session(uid, sid)
        raise HTTPException(404, "session not found")
    # Note: only THIS worker's PTY is killed. PTYs for the same sid
    # living on other workers (after a reconnect-on-different-worker)
    # are reaped by _cleanup_idle_terminals within 30 min.
    _kill_local_session(uid, sid)
    return {"ok": True}


# ─────────────────────────────────────────────────────────────────────────────
#  WEBSOCKET ENDPOINTS  (preferred transport)
# ─────────────────────────────────────────────────────────────────────────────
# The SSE /api/terminal/stream + POST /api/terminal/input pair above is
# functionally correct in single-worker mode but BROKEN under gunicorn with
# N>1 workers: ``_terminals`` is a module-level dict (per-process), and
# gunicorn has no sticky routing for HTTP requests. So SSE lands on worker
# A and spawns PTY-A, while POSTed keystrokes land on workers A/B/C round-
# robin — B and C each spawn their OWN PTY (bash processes nobody reads),
# so only ~1/N keystrokes reach the PTY whose output the SSE is actually
# streaming.
#
# A WebSocket is a single long-lived TCP connection to ONE worker; both
# input and output flow through it, so the PTY is guaranteed to live on
# that same worker. Also removes the per-keystroke HTTP overhead (handshake
# + auth + JSON parse).
#
# The old SSE/POST endpoints are KEPT as a transparent fallback so nothing
# breaks if WS fails (corporate proxies blocking Upgrade, etc.).
#
# The actual loop (``_terminal_ws_loop``), the auth helper (``_ws_auth_uid``)
# and the per-session DB row helpers all live in ``_legacy`` because they
# share state with the SSE path. We only expose the two routing endpoints
# here.
@router.websocket("/ws/terminal/{sid}")
async def ws_terminal_session(ws: WebSocket, sid: str):
    """Per-session bidirectional PTY WebSocket.

    Wire protocol is identical to /ws/terminal (see ``_terminal_ws_loop``
    for the spec). The only difference is ``sid`` in the path selects which
    of the user's named sessions to bind to.
    """
    # AUDIT 2026-08-02 (S9) — accept AVANT tout close codé : un
    # ``ws.close(code=…)`` émis avant ``accept()`` fait répondre Starlette
    # par un HTTP 403 au handshake, et le navigateur ne voit jamais le code
    # (onclose reçoit 1006). Le client traitait donc un échec d'auth comme
    # un blocage proxy et dégradait vers le SSE legacy, qui rebouclait sur
    # 401 toutes les 2 s. Accepter puis fermer immédiatement livre le code.
    await ws.accept()
    # AUDIT 2026-08-02 (E3) — contrôle d'origine (le middleware CSRF HTTP ne
    # voit pas le scope WS). Rejette un handshake cross-site AVANT l'auth.
    from shared_infra.security.csrf import ws_is_cross_site
    if ws_is_cross_site(ws):
        logger.warning("[PTY-WS] handshake cross-site refusé origin=%r",
                       ws.headers.get("origin"))
        try:
            await ws.close(code=4003, reason="cross-site refused")
        except Exception:
            pass
        return
    uid = _ws_auth_uid(ws)
    if uid is None:
        try:
            await ws.close(code=4001, reason="session expired")
        except Exception:
            pass
        return
    if not _valid_sid(sid):
        try:
            await ws.close(code=4002, reason="invalid sid")
        except Exception:
            pass
        return
    row = _get_session_row(sid, uid, tid=None)
    if row is None:
        try:
            await ws.close(code=4004, reason="session not found")
        except Exception:
            pass
        return
    try:
        state = await asyncio.to_thread(_get_or_create_terminal, uid, sid)
    except Exception as e:
        logger.warning(f"[PTY-WS] spawn failed uid={uid} sid={sid}: {e}")
        try:
            await ws.close(code=1011)
        except Exception:
            pass
        return
    _touch_session_row(sid)
    await _terminal_ws_loop(ws, state)


@router.websocket("/ws/terminal")
async def ws_terminal(ws: WebSocket):
    """Bidirectional PTY WebSocket for the personal sandbox.

    Protocol (client → server):
      * binary frame:  raw keystrokes (UTF-8 bytes, no framing)
      * text frame:    JSON {"op": "resize", "rows": N, "cols": M}
                       JSON {"op": "ping"}
    Protocol (server → client):
      * binary frame:  raw PTY output bytes (xterm-256color, ANSI OK)
      * text frame:    JSON {"type": "pong"}  in reply to ping
                       JSON {"type": "exit"}  when the PTY dies
    """
    # AUDIT 2026-08-02 (S9) — accept d'abord, pour que les codes de close
    # (4001, 1011) parviennent réellement au client (cf. ws_terminal_session).
    await ws.accept()
    # AUDIT 2026-08-02 (E3) — contrôle d'origine (cf. ws_terminal_session).
    from shared_infra.security.csrf import ws_is_cross_site
    if ws_is_cross_site(ws):
        logger.warning("[PTY-WS] handshake cross-site refusé origin=%r",
                       ws.headers.get("origin"))
        try:
            await ws.close(code=4003, reason="cross-site refused")
        except Exception:
            pass
        return
    uid = _ws_auth_uid(ws)
    if uid is None:
        try:
            await ws.close(code=4001, reason="session expired")
        except Exception:
            pass
        return

    try:
        state = await asyncio.to_thread(_get_or_create_terminal, uid)
    except Exception as e:
        logger.warning(f"[PTY-WS] spawn failed for uid={uid}: {e}")
        try:
            await ws.close(code=1011)
        except Exception:
            pass
        return

    await _terminal_ws_loop(ws, state)
