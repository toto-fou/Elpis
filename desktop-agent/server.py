# SPDX-License-Identifier: MIT
"""
desktop-agent — a tiny cross-platform control-agent the chatbot drives over HTTP.

Runs ON the target machine/VM. Exposes a uniform API the backend's
``desktop_tools`` calls: /health, /screenshot, /ui_tree, /click, /type, /key,
/scroll, /move, /drag.

LAN deployment: no auth. This agent is a full remote-control surface — only run
it on machines you intend to be controlled, on a trusted local network.
(Décision 2026-06 : déploiement full local assumé — pas de couche token,
surface de complexité inutile ici.)

    DESKTOP_AGENT_HOST    bind host (default 0.0.0.0)
    DESKTOP_AGENT_PORT    bind port (default 8765)

Start:  python server.py     (or)   uvicorn server:app --host 0.0.0.0 --port 8765
"""
from __future__ import annotations

import asyncio
import base64
import contextvars as _contextvars
import logging
import os
import queue as _queue
import sys
import threading as _threading
import time as _time
from concurrent.futures import Future as _Future
from pathlib import Path

# Make sibling modules importable whether launched via `python server.py` or
# `uvicorn server:app` from this directory.
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from backends import NotSupported, get_backend
from fastapi import FastAPI, HTTPException, Request
from starlette.middleware.gzip import GZipMiddleware

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("desktop-agent")

app = FastAPI(title="desktop-agent", version="1.0")
# Compresse les réponses JSON volumineuses : un /ui_tree de ~400 nœuds fait
# 60-150 Ko de JSON → ~10-25 Ko gzip. ``requests`` (client host) décompresse seul.
# minimum_size=1024 → les petites réponses (/health, actions) restent brutes.
# ⚠ compresslevel=1 (pas 9) : le b64 des screenshots (1-3 Mo, quasi incompressible)
# passe AUSSI par le middleware ; au niveau 9 le match-finding sur ces Mo coûtait
# 30-150 ms CPU/capture pour ~4-10 ms de gain LAN (perte nette sur le chemin chaud).
# Le niveau 1 garde ~5× sur le JSON de /ui_tree à un débit bien supérieur.
app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=1)

# Délai du CLIENT (en-tête ``X-Elpis-Timeout``, secondes) : au-delà, Elpis a déjà rendu
# ``agent_timeout`` — une op encore EN FILE à ce moment ne doit plus partir (le clic
# « fantôme » exécuté 40 s plus tard, puis celui du réessai). Absent : vieil hôte.
_CLIENT_TIMEOUT: "_contextvars.ContextVar" = _contextvars.ContextVar("client_timeout", default=None)


class _ClientDeadline:
    """Middleware ASGI pur : lit l'en-tête et le pose dans le contexte de la requête."""
    def __init__(self, app_):
        self.app = app_

    async def __call__(self, scope, receive, send):
        if scope.get("type") == "http":
            for k, v in scope.get("headers") or []:
                if k == b"x-elpis-timeout":
                    try:
                        t = float(v.decode("latin-1"))
                        if t > 0:
                            _CLIENT_TIMEOUT.set(t)
                    except (TypeError, ValueError):
                        pass
                    break
        await self.app(scope, receive, send)


app.add_middleware(_ClientDeadline)


def _int(v, default=0):
    """Entier d'un corps JSON sans 500 : ``"abc"``, ``{}``, ``null`` → ``default``."""
    try:
        return int(v)
    except (TypeError, ValueError):
        try:
            return int(float(v))
        except (TypeError, ValueError):
            return default

try:
    backend = get_backend()
    logger.info("desktop-agent backend=%s health=%s", backend.name, backend.health())
except Exception as e:  # pragma: no cover
    logger.error("backend init failed: %s", e)
    backend = None


def _backend():
    if backend is None:
        raise HTTPException(500, "backend unavailable on this host")
    return backend


async def _body(request: Request) -> dict:
    try:
        data = await request.json()
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


# ── Sérialisation UIA sur UN worker dédié (R2) ────────────────────────────────
# HISTORIQUE : les endpoints d'action UIA étaient ``async def`` à corps synchrone
# → exécutés INLINE sur le thread de la boucle event. Une op UIA figée (app cible
# qui ne répond pas, p99 observe ≈ 121 s) gelait alors uvicorn ENTIER : plus
# aucune requête acceptée, /health muet, arrêt impossible.
#
# Le backend force l'APARTMENT COM **MTA** (``coinit_flags = 0`` dans
# backends/windows.py) : en MTA, les objets COM sont accessibles depuis N'IMPORTE
# quel thread (contrairement à STA). Le vieux commentaire « affinité de thread /
# non marshalable » décrivait STA et était PÉRIMÉ — la preuve : /health, /monitors,
# /screenshot… (``def`` synchrones) tournent DÉJÀ sur le threadpool anyio.
#
# On route donc toutes les ops UIA vers UN thread worker unique (``_UIAWorker``) :
#   • préserve la SÉRIALISATION historique (une op UIA à la fois, pas de course) ;
#   • MTA-sûr (COM créé/partagé sans souci depuis ce thread) ;
#   • ISOLE les blocages : une op figée n'occupe que le worker → /health et les
#     endpoints hors-worker restent vivants, et les appels UIA suivants reçoivent
#     un 503 ``agent_busy`` NET au lieu d'un gel total.
# Un thread Python figé dans un appel COM ne peut pas être tué : la seule sortie
# reste de relancer l'agent (run.bat) — voir DESKTOP_AGENT_EXIT_ON_HANG_SEC.


def _cursor():
    """Position actuelle du curseur (best-effort) — jointe à CHAQUE réponse d'action
    pour que le modèle sache toujours où est le pointeur (repère écran capturé)."""
    try:
        return _backend().cursor_pos()
    except Exception:
        return None


def _do(fn, *args):
    """Run a backend action; NotSupported→501, autres→500."""
    try:
        fn(*args)
        return {"ok": True, "cursor": _cursor()}
    except NotSupported as e:
        raise HTTPException(501, str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("action failed")
        raise HTTPException(500, str(e))


# ── Worker UIA sérialisé ──────────────────────────────────────────────────────
def _env_num(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "") or default)
    except (TypeError, ValueError):
        return float(default)


# File de profondeur bornée : au-delà, on REFUSE (503) plutôt que d'empiler des
# requêtes qui expireraient toutes ensemble côté client.
_QUEUE_MAX = max(1, int(_env_num("DESKTOP_AGENT_QUEUE_MAX", 4)))
# Une op « occupée » depuis plus de N s est considérée FIGÉE : les appels suivants
# reçoivent 503 immédiat (au lieu d'attendre puis d'expirer un par un).
_HUNG_AFTER_SEC = _env_num("DESKTOP_AGENT_HUNG_AFTER_SEC", 60.0)
# Attente maximale d'une op côté serveur (le client borne déjà, mais on protège
# la file). Les /wait_*/launch passent un timeout dédié (timeout_ms + marge).
_OP_TIMEOUT_SEC = _env_num("DESKTOP_AGENT_OP_TIMEOUT_SEC", 120.0)
# Auto-sortie si une op reste figée trop longtemps (0 = OFF, défaut). ⚠ sans
# superviseur de relance (l'autostart est ONLOGON seulement), l'activer laisse la
# VM SANS agent → OFF par défaut, décision opérateur.
_EXIT_ON_HANG_SEC = _env_num("DESKTOP_AGENT_EXIT_ON_HANG_SEC", 0.0)

_UIA_QUEUE: "_queue.Queue" = _queue.Queue(maxsize=_QUEUE_MAX)
_worker_lock = _threading.Lock()
_worker_state = {"op": None, "since": None, "budget": None}   # op courante + départ + délai propre de l'op
_worker_started = False


def _worker_ensure_com() -> None:
    """Init COM (MTA) SUR le thread worker — idempotent, no-op hors Windows."""
    try:
        from backends import windows as _win  # ImportError sous Linux (comtypes absent)
        _win._ensure_com()
    except Exception:
        pass


def _worker_loop() -> None:
    _worker_ensure_com()
    while True:
        item = _UIA_QUEUE.get()
        op_name, thunk, fut = item[0], item[1], item[2]
        budget = item[3] if len(item) > 3 else None
        # L'appelant a abandonné (timeout côté serveur ou client) AVANT le départ :
        # ne pas exécuter quand même — sinon le réessai du client doublait l'action
        # (clic rejoué, case rebasculée).
        if not fut.set_running_or_notify_cancel():
            _UIA_QUEUE.task_done()
            continue
        with _worker_lock:
            _worker_state["op"] = op_name
            _worker_state["since"] = _time.time()
            _worker_state["budget"] = budget
        try:
            result = thunk()
            fut.set_result(result)
        except BaseException as e:      # HTTPException incluse → propagée à l'appelant
            try:
                fut.set_exception(e)
            except Exception:
                pass
        finally:
            with _worker_lock:
                _worker_state["op"] = None
                _worker_state["since"] = None
                _worker_state["budget"] = None
            _UIA_QUEUE.task_done()


def _ensure_worker() -> None:
    global _worker_started
    if _worker_started:
        return
    with _worker_lock:
        if _worker_started:
            return
        t = _threading.Thread(target=_worker_loop, name="uia-worker", daemon=True)
        t.start()
        _worker_started = True


def _worker_snapshot():
    """Lecture ATOMIQUE (op, since) du worker → paire cohérente en une prise de
    verrou. ``busy_for`` s'en dérive (0.0 si libre)."""
    with _worker_lock:
        return _worker_state["op"], _worker_state["since"]


async def _run_uia(op_name: str, thunk, *, timeout_s: float = None):
    """Exécute ``thunk`` (→ dict réponse, peut lever HTTPException) sur le worker
    UIA sérialisé, avec garde d'occupation et timeout. 503 ``agent_busy`` si le
    worker est figé (op en cours trop longue) ou si la file est saturée."""
    _ensure_worker()
    stuck, _since = _worker_snapshot()
    busy_for = (_time.time() - _since) if _since else 0.0
    with _worker_lock:
        _budget = _worker_state.get("budget")
    # Une attente LÉGITIME (/wait_window 90 s, /launch d'une appli lourde) n'est pas
    # un gel : on ne déclare l'op figée qu'au-delà de SON propre délai.
    hung_after = max(_HUNG_AFTER_SEC, float(_budget or 0))
    if busy_for > hung_after:
        if _EXIT_ON_HANG_SEC and busy_for > _EXIT_ON_HANG_SEC:
            logger.error("uia-worker figé sur '%s' depuis %.0fs → sortie (EXIT_ON_HANG)",
                         stuck, busy_for)
            os._exit(1)
        raise HTTPException(503, f"agent occupé : op '{stuck}' bloquée depuis "
                                 f"{busy_for:.0f}s — relancer l'agent (run.bat) si nécessaire")
    if _UIA_QUEUE.full():
        raise HTTPException(503, "agent occupé : file d'opérations saturée — réessayer")

    fut: "_Future" = _Future()
    # Budget propre = seulement pour les ops qui DÉCLARENT une attente (/wait_*, /launch) ;
    # une op courte bloquée au-delà de _HUNG_AFTER_SEC reste un gel.
    _UIA_QUEUE.put((op_name, thunk, fut, float(timeout_s) if timeout_s else None))
    wait_s = timeout_s or _OP_TIMEOUT_SEC
    client_s = _CLIENT_TIMEOUT.get()
    if client_s:
        # Jamais plus longtemps que le client : à l'expiration, l'op encore en file est
        # ANNULÉE (le worker la saute) au lieu de partir après l'abandon d'Elpis.
        wait_s = max(1.0, min(float(wait_s), float(client_s) - 1.5))
    try:
        return await asyncio.wait_for(asyncio.wrap_future(fut), timeout=wait_s)
    except asyncio.TimeoutError:
        # L'op continue dans le worker (un thread figé ne se tue pas) ; le marqueur
        # busy prendra le relais pour les appels suivants → 503 net.
        raise HTTPException(503, f"agent occupé : op '{op_name}' n'a pas répondu à temps")


@app.get("/health")
def health():
    # Reste RESPONSIVE même si le worker UIA est figé (sync def → threadpool anyio,
    # ne touche pas le worker). ``worker`` expose l'état pour diagnostiquer un gel.
    _op, _since = _worker_snapshot()
    worker = {"busy": _op is not None, "op": _op,
              "busy_for_s": round((_time.time() - _since), 1) if _since else 0.0,
              "queue": _UIA_QUEUE.qsize()}
    if backend is None:
        return {"ok": False, "error": "backend unavailable", "worker": worker}
    try:
        return {"ok": True, "worker": worker, **backend.health()}
    except Exception as e:
        return {"ok": False, "error": str(e), "worker": worker}


@app.get("/monitors")
def monitors():
    """Liste les écrans (mss) + l'écran capturé courant — pour le sélecteur Studio."""
    if backend is None:
        return {"ok": False, "error": "backend unavailable"}
    try:
        return {"ok": True, **backend.list_monitors()}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/select_monitor")
async def select_monitor(request: Request):
    """Choisit l'écran capturé/piloté (0=tous, 1=primaire, N=écran N). Persistant."""
    b = await _body(request)
    try:
        idx = int(b.get("monitor", 1))
    except (TypeError, ValueError):
        idx = 1
    return await _run_uia("select_monitor",
                          lambda: {"ok": True, "selected": _backend().set_monitor(idx)})


@app.post("/screenshot")
async def screenshot(request: Request):
    # L'hôte pilote le format par requête ({"format","quality"}) — défaut PNG.
    # Un agent ANCIEN ignorait le body → PNG : dégradation propre. Reste hors du
    # worker UIA (capture d'écran = pas d'affinité COM) → survit à un worker figé.
    # ⚠ La capture + encode (PNG/JPEG) + base64 d'un écran (1-3 Mo, ~50-300 ms)
    # est DÉPORTÉE via to_thread : sinon, sur l'endpoint le PLUS chaud (chaque
    # observe/act/settle), elle bloquerait l'event-loop → /health muet (contre R2).
    b = await _body(request)
    fmt = b.get("format")
    quality = b.get("quality")

    def _shot():
        try:
            img_bytes, w, h = _backend().screenshot(fmt=fmt, quality=quality)
        except NotSupported as e:
            raise HTTPException(501, str(e))
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(500, str(e))
        return {"ok": True, "image": base64.b64encode(img_bytes).decode("ascii"),
                "width": w, "height": h}

    return await asyncio.to_thread(_shot)


def _ui_tree_body(mx: int, scope: str, fanout: int = 80):
    try:
        try:
            elements, w, h = _backend().ui_tree(max_nodes=mx, scope=scope, fanout=fanout)
        except TypeError:
            # backend sans ``fanout`` (Linux / tiers) : signature historique
            elements, w, h = _backend().ui_tree(max_nodes=mx, scope=scope)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))
    return {"ok": True, "elements": elements, "width": w, "height": h, "scope": scope}


@app.post("/ui_tree")
async def ui_tree(request: Request):
    body = await _body(request)
    try:
        mx = int(body.get("max_nodes", 300) or 300)
    except (TypeError, ValueError):
        mx = 300
    # ``fanout`` : enfants lus par nœud (80 par défaut). Le Studio l'élargit avec
    # son plafond de nœuds pour ne pas tronquer les longues listes.
    try:
        fanout = max(8, min(400, int(body.get("fanout", 80) or 80)))
    except (TypeError, ValueError):
        fanout = 80
    scope = str(body.get("scope", "focus") or "focus")
    return await _run_uia("ui_tree", lambda: _ui_tree_body(mx, scope, fanout))


@app.post("/click")
async def click(request: Request):
    b = await _body(request)
    return await _run_uia("click", lambda: _do(
        _backend().click, _int(b.get("x"), 0), _int(b.get("y"), 0),
        str(b.get("button", "left")), _int(b.get("clicks"), 1) or 1,
        str(b.get("modifiers", ""))))


@app.post("/type")
async def type_text(request: Request):
    b = await _body(request)
    return await _run_uia("type", lambda: _do(_backend().type_text, str(b.get("text", ""))))


@app.post("/key")
async def key(request: Request):
    b = await _body(request)
    return await _run_uia("key", lambda: _do(_backend().key, str(b.get("keys", ""))))


@app.post("/scroll")
async def scroll(request: Request):
    b = await _body(request)
    x = b.get("x"); y = b.get("y")
    return await _run_uia("scroll", lambda: _do(
        _backend().scroll,
        (_int(x, None) if x is not None else None),
        (_int(y, None) if y is not None else None),
        _int(b.get("dy"), 0)))


@app.post("/move")
async def move(request: Request):
    b = await _body(request)
    return await _run_uia("move", lambda: _do(
        _backend().move, _int(b.get("x"), 0), _int(b.get("y"), 0)))


@app.post("/drag")
async def drag(request: Request):
    b = await _body(request)
    return await _run_uia("drag", lambda: _do(
        _backend().drag, _int(b.get("x1"), 0), _int(b.get("y1"), 0),
        _int(b.get("x2"), 0), _int(b.get("y2"), 0), str(b.get("modifiers", ""))))


def _ret(fn, **kw):
    """Run a backend op that RETURNS a payload dict; NotSupported→501, autres→500."""
    try:
        out = fn(**kw)
        return {"ok": True, "cursor": _cursor(), **(out if isinstance(out, dict) else {})}
    except NotSupported as e:
        raise HTTPException(501, str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("op failed")
        raise HTTPException(500, str(e))


@app.post("/invoke")
async def invoke(request: Request):
    """Actionne un contrôle par son PATTERN UIA (Invoke), ciblé par ``auto_id``
    (+ name/control_type) ; repli sur un clic en coordonnées x,y."""
    b = await _body(request)
    x = b.get("x"); y = b.get("y")
    return await _run_uia("invoke", lambda: _ret(
        _backend().invoke,
        auto_id=str(b.get("auto_id", "")), name=str(b.get("name", "")),
        control_type=str(b.get("control_type", "")),
        x=(_int(x, None) if x is not None else None), y=(_int(y, None) if y is not None else None),
        button=str(b.get("button", "left")), clicks=_int(b.get("clicks"), 1) or 1))


@app.post("/set_value")
async def set_value(request: Request):
    """Renseigne un champ via ValuePattern (sans timing de frappe), ciblé auto_id."""
    b = await _body(request)
    kw = dict(auto_id=str(b.get("auto_id", "")), name=str(b.get("name", "")),
              control_type=str(b.get("control_type", "")), text=str(b.get("text", "")))
    try:                        # point (écran capturé) : départage deux champs homonymes
        if b.get("x") is not None and b.get("y") is not None:
            kw.update(x=int(b["x"]), y=int(b["y"]))
    except (TypeError, ValueError):
        pass

    def _call():
        import inspect
        fn = _backend().set_value
        try:
            params = inspect.signature(fn).parameters
        except (TypeError, ValueError):
            params = {}
        if "x" not in params:   # backend sans x/y (Linux) : l'identité seule
            kw.pop("x", None); kw.pop("y", None)
        return _ret(fn, **kw)
    return await _run_uia("set_value", _call)


@app.post("/element")
async def element(request: Request):
    """Action SÉMANTIQUE par control pattern UIA : ``action`` ∈ toggle|check|
    uncheck|select|expand|collapse|scroll_into_view|set_value|click, ciblée
    ``auto_id`` (+ name/control_type) ; repli clic coordonnées x,y."""
    b = await _body(request)
    x = b.get("x"); y = b.get("y")
    return await _run_uia("element", lambda: _ret(
        _backend().element_action,
        action=str(b.get("action", "click")),
        auto_id=str(b.get("auto_id", "")), name=str(b.get("name", "")),
        control_type=str(b.get("control_type", "")), text=str(b.get("text", "")),
        x=(_int(x, None) if x is not None else None), y=(_int(y, None) if y is not None else None),
        button=str(b.get("button", "left")), clicks=_int(b.get("clicks"), 1) or 1))


# Marge ajoutée au timeout_ms d'une op d'attente pour obtenir le timeout SERVEUR :
# l'attente légitime peut durer jusqu'à timeout_ms, on laisse un coussin réseau.
_WAIT_SLACK_SEC = 10.0


@app.post("/launch")
async def launch(request: Request):
    """Lance un programme/raccourci puis attend son init (WaitForInputIdle)."""
    b = await _body(request)
    try:
        to_ms = int(b.get("timeout_ms", 15000) or 15000)
    except (TypeError, ValueError):
        to_ms = 15000      # parse défensif (cohérent avec /select_monitor, /ui_tree)
    return await _run_uia("launch", lambda: _ret(
        _backend().launch, target=str(b.get("target", "") or b.get("path", "")),
        args=str(b.get("args", "")), timeout_ms=to_ms),
        # nouvelle fenêtre (≤ timeout_ms) PUIS WaitForInputIdle (≤ timeout_ms)
        timeout_s=2 * to_ms / 1000.0 + _WAIT_SLACK_SEC)


@app.post("/wait_window")
async def wait_window(request: Request):
    """Attend qu'une fenêtre matche ET soit PRÊTE (ReadyForUserInteraction)."""
    b = await _body(request)
    to_ms = _int(b.get("timeout_ms"), 15000) or 15000
    return await _run_uia("wait_window", lambda: _ret(
        _backend().wait_window, title_re=str(b.get("title_re", "")), auto_id=str(b.get("auto_id", "")),
        class_name=str(b.get("class_name", "")), ready=bool(b.get("ready", True)),
        timeout_ms=to_ms),
        timeout_s=to_ms / 1000.0 + _WAIT_SLACK_SEC)


@app.post("/wait_element")
async def wait_element(request: Request):
    """Attend qu'un contrôle atteigne un état (exists|visible|enabled|ready)."""
    b = await _body(request)
    to_ms = _int(b.get("timeout_ms"), 15000) or 15000
    return await _run_uia("wait_element", lambda: _ret(
        _backend().wait_element, auto_id=str(b.get("auto_id", "")), name=str(b.get("name", "")),
        control_type=str(b.get("control_type", "")), state=str(b.get("state", "exists")),
        timeout_ms=to_ms),
        timeout_s=to_ms / 1000.0 + _WAIT_SLACK_SEC)


@app.get("/windows")
def windows():
    """Liste légère des fenêtres top-level (titre + état + premier plan) — ~0 token,
    sans parcourir leur sous-arbre. Sert au modèle à atteindre/basculer une autre appli."""
    return _ret(_backend().list_windows)


@app.post("/window_action")
async def window_action(request: Request):
    """Agit sur une fenêtre par HWND : activate|focus|minimize|maximize|restore|close."""
    b = await _body(request)
    try:
        hwnd = int(b.get("hwnd", 0) or 0)
    except (TypeError, ValueError):
        hwnd = 0
    return await _run_uia("window_action", lambda: _ret(
        _backend().window_action, action=str(b.get("action", "activate")), hwnd=hwnd))


@app.post("/clipboard_get")
def clipboard_get():
    try:
        return {"ok": True, "text": _backend().clipboard_get()}
    except NotSupported as e:
        raise HTTPException(501, str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("clipboard_get failed")
        raise HTTPException(500, str(e))


@app.post("/clipboard_set")
async def clipboard_set(request: Request):
    b = await _body(request)
    return await _run_uia("clipboard_set",
                          lambda: _do(_backend().clipboard_set, str(b.get("text", ""))))


# ── Scripts d'automatisation (elpis_auto) : dépôt, exécution, rapports ────────
# L'agent lancé par run.bat vit DANS la session interactive de l'utilisateur :
# un script lancé d'ici voit le bureau (là où une session SSH ou un service ne
# voit rien). Elpis pousse le .py (+ lib/, assets/) dans ``automations/``, lance
# ``python -m elpis_auto`` avec l'interpréteur de l'agent, suit l'exécution et
# rapatrie ``rapports/…``. Pas d'auth inter-machine (déploiement local, cf.
# _agent_req côté Elpis) ; les chemins sont BORNÉS à ``automations/``.
import subprocess as _subprocess
import uuid as _uuid

_AUTOMATIONS = _HERE / "automations"
_RUNS: dict = {}            # run_id → état (proc, journal, code, dossier de rapport)
_RUNS_MAX = 20
_LOG_MAX_LINES = 400


_RESERVED_MODULES = frozenset({"elpis_auto", "backends", "normalize", "lib", "server",
                               "sitecustomize", "usercustomize"}) | frozenset(getattr(sys, "stdlib_module_names", ()))


def _shadows_import(rel: str) -> bool:
    """Un .py à la RACINE d'automations/ dont le nom est un module (``csv``, ``json``,
    ``elpis_auto``) : importé à la place du vrai module par TOUTE exécution suivante."""
    rel = str(rel or "").replace("\\", "/").strip().lstrip("/")
    if "/" in rel or not rel.endswith(".py"):
        return False
    stem = rel[:-3]
    return stem.isidentifier() and stem in _RESERVED_MODULES


def _auto_path(rel: str) -> Path:
    """Chemin sous automations/ ; refuse ``..``, les chemins absolus et les lecteurs."""
    rel = str(rel or "").replace("\\", "/").strip().lstrip("/")
    if not rel or ".." in rel.split("/") or ":" in rel:
        raise HTTPException(400, "chemin invalide")
    p = (_AUTOMATIONS / rel).resolve()
    try:
        p.relative_to(_AUTOMATIONS.resolve())
    except ValueError:
        raise HTTPException(400, "chemin hors du dossier automations")
    return p


@app.post("/put_file")
async def put_file(request: Request):
    """Dépose un fichier sous automations/ : ``{path, content}`` (texte) ou
    ``{path, content_b64}`` (binaire : vignettes)."""
    b = await _body(request)
    p = _auto_path(b.get("path"))
    if _shadows_import(b.get("path")):
        raise HTTPException(400, "nom de script réservé (masquerait le module Python du même nom) : renommer le script")
    if isinstance(b.get("content_b64"), str):
        try:
            data = base64.b64decode(b["content_b64"], validate=True)
        except Exception:
            raise HTTPException(400, "content_b64 invalide")
    elif isinstance(b.get("content"), str):
        data = b["content"].encode("utf-8")
    else:
        raise HTTPException(400, "content ou content_b64 requis")
    if len(data) > 16 * 1024 * 1024:
        raise HTTPException(413, "fichier trop volumineux")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    return {"ok": True, "path": str(p.relative_to(_AUTOMATIONS.resolve())).replace("\\", "/"), "size": len(data)}


@app.get("/get_file")
async def get_file(path: str = ""):
    """Lit un fichier sous automations/ (rapport JSON, capture PNG) en base64."""
    p = _auto_path(path)
    if not p.is_file():
        raise HTTPException(404, "fichier introuvable")
    data = p.read_bytes()
    if len(data) > 32 * 1024 * 1024:
        raise HTTPException(413, "fichier trop volumineux")
    return {"ok": True, "path": path, "size": len(data), "content_b64": base64.b64encode(data).decode("ascii")}


@app.get("/list_files")
async def list_files(path: str = ""):
    p = _auto_path(path or ".")
    if not p.is_dir():
        raise HTTPException(404, "dossier introuvable")
    items = []
    for child in sorted(p.iterdir(), key=lambda c: c.name):
        try:
            st = child.stat()
        except OSError:
            continue
        items.append({"name": child.name, "dir": child.is_dir(), "size": int(st.st_size), "mtime": int(st.st_mtime)})
    return {"ok": True, "path": path, "items": items}


def _reap_runs() -> None:
    if len(_RUNS) <= _RUNS_MAX:
        return
    done = sorted((k for k, v in _RUNS.items() if v.get("code") is not None), key=lambda k: _RUNS[k]["started"])
    for k in done[: len(_RUNS) - _RUNS_MAX]:
        _RUNS.pop(k, None)


def _report_dir_ok(tail: str) -> bool:
    try:
        t = str(tail).replace("\\", "/")          # « rapports\\x » (Windows) comme « rapports/x »
        d = Path(t) if (Path(t).is_absolute() or Path(tail).is_absolute()) else (_AUTOMATIONS / t)
        # rapport.json (une exécution) ; stabilite.json (--repeat) ; donnees.json (--data)
        return any((d / f).is_file() for f in ("rapport.json", "stabilite.json", "donnees.json"))
    except Exception:          # noqa: BLE001
        return False


def _pump(run: dict) -> None:
    """Thread : lit la sortie du script ligne à ligne (journal borné), repère le
    dossier de rapport (« … → rapports\\x ») et le code de sortie."""
    proc = run["proc"]
    try:
        for raw in iter(proc.stdout.readline, b""):
            line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            run["log"].append(line)
            if len(run["log"]) > _LOG_MAX_LINES:
                del run["log"][: len(run["log"]) - _LOG_MAX_LINES]
            sep = "  →  " if "  →  " in line else ("  ->  " if "  ->  " in line else "")
            if sep:
                tail = line.rsplit(sep, 1)[1].strip()
                # Seule la ligne de FIN du rapport compte : un ``s.note("A  →  B")`` ou un
                # libellé d'étape qui contient la flèche faisait pointer le rapport ailleurs.
                # La fin s'écrit APRÈS rapport.json : on exige que ce fichier existe.
                if tail and _report_dir_ok(tail):
                    run["report_dir"] = tail.replace("\\", "/")
                    run["summary"] = line.rsplit(sep, 1)[0].strip()
    except Exception as e:          # noqa: BLE001 — le journal est un bonus
        run["log"].append(f"[journal interrompu : {e}]")
    finally:
        try:
            run["code"] = int(proc.wait(timeout=5))
        except Exception:
            run["code"] = -1
        run["ended"] = _time.time()


@app.post("/run_script")
async def run_script(request: Request):
    """Lance ``python -m elpis_auto [options] <name>.py [args…]`` avec l'interpréteur
    de l'agent, dans automations/ (cwd), en arrière-plan. Rend ``run_id``."""
    b = await _body(request)
    name = str(b.get("name") or "").strip()
    rel = name if name.endswith(".py") else name + ".py"
    script = _auto_path(rel)
    if _shadows_import(rel):
        raise HTTPException(400, "nom de script réservé (masquerait le module Python du même nom) : renommer le script")
    if not script.is_file():
        raise HTTPException(404, f"script introuvable : {name}")
    # Une exécution à la fois : deux scripts pilotaient sinon le MÊME bureau (souris,
    # clavier, premier plan) et se sabotaient mutuellement.
    for other in list(_RUNS.values()):
        try:
            alive = other.get("code") is None and other["proc"].poll() is None
        except Exception:
            alive = False
        if alive:
            raise HTTPException(409, f"une exécution est déjà en cours sur cette machine ({other.get('name')}, {other.get('id')})")
    cmd = [sys.executable, "-m", "elpis_auto"]
    if b.get("dry_run"):
        cmd.append("--dry-run")
    if b.get("trace"):
        cmd.append("--trace")
    rep = _int(b.get("repeat"), 0)
    if rep > 1:
        cmd += ["--repeat", str(min(rep, 50))]
    data = str(b.get("data") or "").strip()
    if data:
        cmd += ["--data", str(_auto_path(data))]
    cmd.append(str(script))
    for a in (b.get("args") or []):
        if isinstance(a, str) and a.startswith("--") and "=" in a and len(a) < 500:
            cmd.append(a)
    env = dict(os.environ)
    env["PYTHONPATH"] = str(_HERE) + os.pathsep + env.get("PYTHONPATH", "")
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONSAFEPATH"] = "1"        # 3.11+ : le dossier courant (automations/) n'est pas mis en tête des imports
    env.setdefault("PYTHONUNBUFFERED", "1")
    for k in ("ELPIS_URL", "ELPIS_TOKEN"):
        if isinstance(b.get(k.lower()), str) and b.get(k.lower()):
            env[k] = b[k.lower()]
    _AUTOMATIONS.mkdir(parents=True, exist_ok=True)
    try:
        proc = await asyncio.to_thread(_subprocess.Popen, cmd, cwd=str(_AUTOMATIONS), env=env,
                                       stdout=_subprocess.PIPE, stderr=_subprocess.STDOUT)
    except Exception as e:          # noqa: BLE001
        raise HTTPException(500, f"lancement impossible : {e}")
    run_id = _uuid.uuid4().hex[:12]
    run = {"id": run_id, "name": name, "proc": proc, "started": _time.time(), "log": [],
           "code": None, "report_dir": "", "summary": "", "cmd": cmd[1:]}
    _RUNS[run_id] = run
    _threading.Thread(target=_pump, args=(run,), name=f"elpis-auto-{run_id}", daemon=True).start()
    _reap_runs()
    return {"ok": True, "run_id": run_id, "name": name, "started": run["started"]}


def _run_view(run: dict, log_tail: int = 60) -> dict:
    code = run.get("code")
    return {"ok": True, "run_id": run["id"], "name": run["name"], "running": code is None, "code": code,
            "started": run["started"], "elapsed_s": round((run.get("ended") or _time.time()) - run["started"], 1),
            "report_dir": run.get("report_dir", ""), "summary": run.get("summary", ""),
            "log": run["log"][-int(log_tail):] if log_tail else []}


@app.get("/run_status")
async def run_status(run_id: str = "", log_tail: int = 60):
    run = _RUNS.get(run_id)
    if run is None:
        raise HTTPException(404, "exécution inconnue")
    return _run_view(run, log_tail)


@app.post("/run_stop")
async def run_stop(request: Request):
    b = await _body(request)
    run = _RUNS.get(str(b.get("run_id") or ""))
    if run is None:
        raise HTTPException(404, "exécution inconnue")
    if run.get("code") is None:
        released = await asyncio.to_thread(_stop_run_process, run["proc"])
        if released:
            run["log"].append("[arrêt : relâché " + ", ".join(released) + "]")
    return _run_view(run, 20)


def _stop_run_process(proc) -> list:
    """Arrête le script ET ses enfants, puis relâche ce qui est resté enfoncé : tué en
    plein ``click(modifiers="ctrl")`` ou glisser, il ne passe pas par son ``finally``."""
    try:
        if os.name == "nt":
            from backends.windows import kill_process_tree
            kill_process_tree(proc.pid)
        else:
            proc.terminate()
    except Exception:
        try:
            proc.terminate()
        except Exception:
            pass
    try:
        proc.wait(timeout=5)
    except Exception:
        pass
    if os.name != "nt":
        return []
    try:
        from backends.windows import release_stuck_inputs
        return release_stuck_inputs()
    except Exception:
        return []


@app.post("/run_command")
async def run_command(request: Request):
    """Exécute une commande sur la cible (PowerShell par défaut sous Windows, bash
    sous Linux) et renvoie {returncode, stdout, stderr, truncated, duration_ms}.

    ⚠️ EXCEPTION délibérée à la règle « corps sur le thread de la boucle » (note en
    tête de fichier) : un subprocess n'est PAS un objet COM/UIA (aucune affinité de
    thread), et une commande longue (jusqu'à 600 s) FIGERAIT /health et TOUS les
    endpoints UIA si elle tournait sur le thread de la boucle. On la déporte donc
    via ``asyncio.to_thread``. Les endpoints UIA, eux, doivent RESTER inline."""
    b = await _body(request)

    def _run():
        return _ret(_backend().run_command,
                    command=str(b.get("command", "")),
                    shell=str(b.get("shell", "")),
                    cwd=str(b.get("cwd", "")),
                    timeout_ms=_int(b.get("timeout_ms"), 120000) or 120000,
                    max_output=_int(b.get("max_output"), 20000) or 20000)

    return await asyncio.to_thread(_run)


if __name__ == "__main__":
    import uvicorn
    host = os.environ.get("DESKTOP_AGENT_HOST", "0.0.0.0")
    port = int(os.environ.get("DESKTOP_AGENT_PORT", "8765") or 8765)
    uvicorn.run(app, host=host, port=port)
