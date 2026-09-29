# SPDX-License-Identifier: MIT
import os

# Coupe le chargement des plugins pydantic AVANT l'import de fastapi (le venv
# en porte un, ``logfire``, qui traîne opentelemetry/rich/requests derrière
# lui : ~21 Mo de RSS pour une fonctionnalité que rien n'utilise). Recopié ici
# plutôt qu'importé : ce service se déploie SEUL, sans ``shared_infra`` — cf.
# shared_infra/runtime/pyruntime.py pour la mesure et l'échappatoire.
os.environ.setdefault("PYDANTIC_DISABLE_PLUGINS", "1")

import asyncio
import json
import logging
import re
import shutil
import sys
from contextlib import asynccontextmanager
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, List, Optional

from fastapi import Body, Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

# ─────────────────────────────────────────────────────────────────────────────
#  Tâches de fond — garder une référence forte
# ─────────────────────────────────────────────────────────────────────────────
# ``asyncio.create_task`` ne rend qu'une référence FAIBLE à la boucle : sans
# référence forte côté appelant, le ramasse-miettes peut détruire la tâche en
# plein vol (« Task was destroyed but it is pending! »). Deux tâches y étaient
# exposées ici, dont le REDÉMARRAGE : l'API répondait « Le serveur redémarre… »
# et, si la tâche disparaissait avant son réveil, il ne redémarrait jamais.
#
# ``shared_infra`` a le même registre, mais ce service se déploie seul (aucun
# import de shared_infra dans ce module) — on le garde donc local.
_bg_tasks: set = set()


def _spawn(coro) -> "asyncio.Task":
    """Lance une tâche de fond en la gardant vivante jusqu'à sa fin."""
    task = asyncio.create_task(coro)
    _bg_tasks.add(task)
    task.add_done_callback(_bg_tasks.discard)
    return task

# Imports tolérants aux deux contextes (service lancé depuis rag_app/ vs
# import en paquet ``rag_app.app`` — tests, outillage) ; même motif que
# ``ocr/rag_index.py``.
try:
    import rag_query as _rq
    from rag_engine import ConfigInvalide, IngestionEnCours, RAGEngine, clear_cancel, exclusive_index_op, request_cancel
except ImportError:
    from rag_app import rag_query as _rq
    from rag_app.rag_engine import (
        ConfigInvalide,
        IngestionEnCours,
        RAGEngine,
        clear_cancel,
        exclusive_index_op,
        request_cancel,
    )

rag_search_only        = _rq.rag_search_only        # /api/search playground
count_chunks_for_file  = _rq.count_chunks_for_file  # tool: rag_get_document (total exact)
get_document_chunk_window = _rq.get_document_chunk_window  # tool: fenêtre triée
list_indexed_files     = _rq.list_indexed_files
list_indexed_docs      = _rq.list_indexed_docs
resolve_documents      = _rq.resolve_documents
invalidate_docs_cache  = _rq.invalidate_docs_cache
load_config            = _rq.load_config
rag                    = _rq.rag                    # auto-RAG (apply_rag côté chatbot)
rag_tool_search        = _rq.rag_tool_search        # tool: rag_search / rag_cite
_SEARCH_ERROR          = _rq._SEARCH_ERROR          # panne ≠ aucun résultat

# ─── Logging ───────────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).resolve().parent
LOG_DIR  = BASE_DIR / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)
LOG_FILE = LOG_DIR / "app.log"

# Mode test : sous pytest (ou RAG_APP_KEEP_STDIO=1), on ne touche NI aux
# handlers globaux NI à stdout/stderr — l'ancienne prise de contrôle
# inconditionnelle au niveau module (root handlers remplacés, loggers
# uvicorn propagate=False, stdio détourné) cassait caplog/capsys de toute
# la session de test dès que ce module était importé.
_TEST_MODE = os.environ.get("RAG_APP_KEEP_STDIO") == "1" or "pytest" in sys.modules

if not _TEST_MODE:
    file_handler = RotatingFileHandler(LOG_FILE, mode="a", maxBytes=5*1024*1024,
                                       backupCount=3, encoding="utf-8")
    file_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s",
                                                 datefmt="%Y-%m-%d %H:%M:%S"))
    root_logger = logging.getLogger()
    root_logger.setLevel(logging.INFO)
    root_logger.handlers.clear()
    root_logger.addHandler(file_handler)

    for _ln in ("uvicorn", "uvicorn.error", "uvicorn.access", "fastapi"):
        _l = logging.getLogger(_ln)
        _l.handlers.clear(); _l.addHandler(file_handler); _l.setLevel(logging.INFO); _l.propagate = False


class StreamToLogger:
    def __init__(self, name, level):
        self.logger = logging.getLogger(name); self.level = level
    def write(self, buf):
        for line in buf.rstrip().splitlines():
            if line.strip(): self.logger.log(self.level, line.strip())
    def flush(self): pass


# Détournement stdout/stderr → log fichier (même gate que le bloc logging).
if not _TEST_MODE:
    sys.stdout = StreamToLogger("PRINT", logging.INFO)
    sys.stderr = StreamToLogger("ERROR", logging.ERROR)

# ─── Auth (Bearer token shared with chatbot) ───────────────────────────────
# Le service est conçu pour être joignable :
#   • depuis le chatbot (via /api/tools/* en SSE)
#   • depuis un admin humain via le navigateur
#
# Jeton : ``RAG_SERVICE_TOKEN`` > ``rag_config.json › service_token`` >
# ``user_db/.rag_service_token`` (généré par ./elpis configure, lu aussi par le client
# du chatbot). Audit 2026-09-22 (C4) : SANS jeton, le service n'est plus
# ouvert — seul un appel DIRECT depuis la machine (loopback, sans en-tête de
# proxy) passe. Avant, ``/api/reset``, ``/api/restart`` et la config étaient
# ouverts à tout le LAN (bind 0.0.0.0, Caddy :8444).
_TOKEN_FILE = BASE_DIR.parent / "user_db" / ".rag_service_token"


_token_cache: dict = {"key": None, "value": ""}


def _mtime(p: Path) -> float:
    try:
        return p.stat().st_mtime
    except OSError:
        return -1.0


def _expected_token() -> str:
    """Jeton attendu, mis en CACHE sur les mtimes de la config et du fichier
    de jeton (passe 2) : le middleware relisait et reparsait rag_config.json
    + le fichier de jeton à CHAQUE requête /api/*, sur la boucle. Une lecture
    ratée (fichier en cours de remplacement) garde le dernier jeton connu au
    lieu de basculer le service en « loopback seul » (401 pour le chatbot)."""
    tok = os.environ.get("RAG_SERVICE_TOKEN", "").strip()
    if tok:
        return tok
    cfg_path = Path(getattr(_rq, "CONFIG_FILE", BASE_DIR / "rag_config.json"))
    key = (str(_TOKEN_FILE), id(load_config), _mtime(cfg_path), _mtime(_TOKEN_FILE))
    if _token_cache["key"] == key:
        return _token_cache["value"]
    failed = False
    try:
        value = ((load_config() or {}).get("service_token") or "").strip()
    except Exception:                                           # noqa: BLE001
        value, failed = "", True
    if not value and _TOKEN_FILE.exists():
        try:
            value = _TOKEN_FILE.read_text(encoding="utf-8").strip()
        except OSError:
            failed = True
    if failed and _token_cache["key"] is not None:
        return _token_cache["value"]
    _token_cache["key"], _token_cache["value"] = key, value
    return value


_LOOPBACK = ("127.0.0.1", "::1", "localhost")
_PROXY_HEADERS = ("x-forwarded-for", "x-real-ip", "forwarded", "via")


def _direct_loopback(request: Request) -> bool:
    """Appel local SANS proxy : un reverse proxy local (Caddy) ferait
    apparaître tout le LAN comme 127.0.0.1, d'où l'exigence d'aucun en-tête
    de relais."""
    host = request.client.host if request.client else ""
    return host in _LOOPBACK and not any(h in request.headers for h in _PROXY_HEADERS)


_NO_TOKEN_MSG = ("Service RAG sans jeton : accès limité à la machine locale. "
                 "Définissez RAG_SERVICE_TOKEN ou user_db/.rag_service_token.")


def require_token(request: Request):
    expected = _expected_token()
    if not expected:
        if _direct_loopback(request):
            return
        raise HTTPException(401, _NO_TOKEN_MSG)
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        raise HTTPException(401, "Bearer token requis.")
    parts = auth.split(None, 1)
    token = parts[1].strip() if len(parts) == 2 else ""
    # compare_digest : comparaison en temps constant (pas d'oracle de
    # préfixe) ; l'ancien ``[1]`` sans garde faisait un 500 sur
    # « Authorization: Bearer » sans valeur.
    import secrets
    if not secrets.compare_digest(token.encode("utf-8"),
                                  expected.encode("utf-8")):
        raise HTTPException(403, "Token invalide.")


# ─── App ───────────────────────────────────────────────────────────────────
_startup_result: dict = {"done": False}

@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Au démarrage : vérifie que tous les fichiers marqués comme indexés ont bien
    des vecteurs en base. Si ce n'est pas le cas (DB purgée, migration, etc.),
    les réindexe silencieusement en arrière-plan.
    """
    async def _run():
        log = logging.getLogger("uvicorn.error")
        # Reprise de la file OCR interrompue par le redémarrage — SANS délai :
        # un GET /api/ocr/queue arrivé avant pouvait lancer la pompe et faire
        # prendre le job en cours pour un orphelin.
        try:
            if _ocr_lifecycle is not None:
                await _ocr_lifecycle.on_startup()
            else:
                try:
                    from ocr.jobs import ensure_queue_runner
                except ImportError:
                    from rag_app.ocr.jobs import ensure_queue_runner
                ensure_queue_runner()
        except Exception as e:                                  # noqa: BLE001
            log.warning(f"[startup] reprise OCR : {e}")
        await asyncio.sleep(2)
        # AUDIT 2026-09-01 (passe 5, B2) — contrôle en thread (POST httpx
        # synchrones). (passe 2) Qdrant pas encore prêt (même hôte, démarré
        # après nous) : le contrôle est REPORTÉ et retenté, au lieu de
        # conclure « 0 vecteur » et de tout ré-embedder.
        for attempt in range(20):
            try:
                result = await asyncio.to_thread(engine.startup_reembed_check)
            except Exception as e:                              # noqa: BLE001
                result = {"ok": False, "msg": str(e)}
            if not result.get("retry"):
                break
            _startup_result.update({"done": False, "msg": result.get("msg")})
            await asyncio.sleep(min(60, 5 * (attempt + 1)))
        _startup_result.update(result)
        _startup_result["done"] = True
        if result.get("reindexed", 0) > 0:
            invalidate_docs_cache()
            log.info(f"[startup] {result['reindexed']} fichier(s) ré-indexés automatiquement.")
    _spawn(_run())
    try:
        yield
    finally:
        await _graceful_shutdown(timeout_s=10.0)

app    = FastAPI(title="RAG Manager API", version="2.4.0", lifespan=lifespan)
engine = RAGEngine()

# CORS — fermé par défaut (audit 2026-09-22, C4 : ``*`` laissait toute page
# web lire l'API depuis le navigateur d'un poste du LAN). Le chatbot appelle
# le service côté SERVEUR, sans CORS ; ``RAG_CORS_ORIGINS`` (csv) ouvre des
# origines précises si un front tiers en a besoin.
_origins = [o.strip() for o in os.environ.get("RAG_CORS_ORIGINS", "").split(",")
            if o.strip() and o.strip() != "*"]
if _origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_origins,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

# ── Console d'administration : jeton du service (audit 2026-09-21, S7) ─────
# Toute l'API de la console (config, ingestion, suppression, reset, OCR,
# journaux) était ouverte : ``GET /api/config`` rendait même le jeton qui
# protège ``/api/tools/*`` et les clés API. Dès qu'un jeton est configuré, les
# routes ``/api/*`` exigent soit ``Authorization: Bearer <jeton>`` (le
# chatbot, côté serveur), soit le cookie de console posé par
# ``/api/console/login`` (le navigateur : un EventSource ne peut pas porter
# d'en-tête). Sans jeton configuré : machine locale seulement (2026-09-22).
_CONSOLE_COOKIE = "rag_console"
_CONSOLE_OPEN = ("/api/health", "/api/console/login", "/api/console/logout")


_CONSOLE_TTL_S = 12 * 3600
# Sessions révoquées par « Déconnexion » (nonce → expiration) : le cookie
# était un HMAC FIXE du jeton — la déconnexion ne l'invalidait pas et
# l'expiration de 12 h n'était appliquée que par le navigateur (passe 2).
_revoked_nonces: dict = {}


def _console_sig(token: str, exp: int, nonce: str) -> str:
    import hashlib
    import hmac
    msg = f"rag-console-v2|{exp}|{nonce}".encode("utf-8")
    return hmac.new(token.encode("utf-8"), msg, hashlib.sha256).hexdigest()


def _console_cookie_value(token: str, exp: Optional[int] = None,
                          nonce: Optional[str] = None) -> str:
    import secrets
    import time as _time
    exp = int(exp if exp is not None else _time.time() + _CONSOLE_TTL_S)
    nonce = nonce or secrets.token_hex(8)
    return f"{exp}.{nonce}.{_console_sig(token, exp, nonce)}"


def _parse_console_cookie(cookie: str):
    parts = (cookie or "").split(".")
    if len(parts) != 3 or not parts[0].isdigit():
        return None
    return int(parts[0]), parts[1], parts[2]


def _console_authorized(request: Request, expected: str) -> bool:
    import secrets
    import time as _time
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        tok = auth.split(None, 1)[1].strip() if len(auth.split(None, 1)) == 2 else ""
        if tok and secrets.compare_digest(tok.encode("utf-8"), expected.encode("utf-8")):
            return True
    parsed = _parse_console_cookie(request.cookies.get(_CONSOLE_COOKIE, ""))
    if not parsed:
        return False
    exp, nonce, sig = parsed
    if exp < _time.time() or nonce in _revoked_nonces:
        return False
    return secrets.compare_digest(sig.encode("utf-8"),
                                  _console_sig(expected, exp, nonce).encode("utf-8"))


class _ConsoleGate:
    """Contrôle d'accès de la console, en middleware ASGI PUR (passe 2) :
    ``@app.middleware("http")`` (BaseHTTPMiddleware) enveloppait chaque
    réponse, flux SSE longs compris (OCR, suivi d'indexation), et détecte mal
    les déconnexions sur ces flux."""

    def __init__(self, app_):
        self.app = app_

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            return await self.app(scope, receive, send)
        path = scope.get("path", "")
        if (scope.get("method") == "OPTIONS" or not path.startswith("/api/")
                or path in _CONSOLE_OPEN or path.startswith("/api/tools/")):
            return await self.app(scope, receive, send)
        request = Request(scope)
        expected = _expected_token()
        if expected:
            ok, msg = _console_authorized(request, expected), "Jeton du service RAG requis."
        else:
            ok, msg = _direct_loopback(request), _NO_TOKEN_MSG
        if not ok:
            from fastapi.responses import JSONResponse
            return await JSONResponse({"detail": msg}, status_code=401)(scope, receive, send)
        return await self.app(scope, receive, send)


app.add_middleware(_ConsoleGate)


@app.post("/api/console/login")
async def console_login(request: Request, payload: dict = Body(...)):
    import secrets
    expected = _expected_token()
    from fastapi.responses import JSONResponse
    if not expected:
        return {"ok": True, "open": True}
    tok = str((payload or {}).get("token") or "").strip()
    if not tok or not secrets.compare_digest(tok.encode("utf-8"), expected.encode("utf-8")):
        await asyncio.sleep(0.5)            # freine l'essai de jetons à la chaîne
        raise HTTPException(403, "Jeton invalide.")
    resp = JSONResponse({"ok": True})
    resp.set_cookie(_CONSOLE_COOKIE, _console_cookie_value(expected), max_age=_CONSOLE_TTL_S,
                    httponly=True, samesite="strict",
                    secure=(request.url.scheme == "https"), path="/")
    return resp


@app.post("/api/console/logout")
def console_logout(request: Request):
    import time as _time

    from fastapi.responses import JSONResponse
    parsed = _parse_console_cookie(request.cookies.get(_CONSOLE_COOKIE, ""))
    if parsed:
        now = _time.time()
        for n, e in list(_revoked_nonces.items()):
            if e < now:
                _revoked_nonces.pop(n, None)
        _revoked_nonces[parsed[1]] = parsed[0]
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(_CONSOLE_COOKIE, path="/")
    return resp


# Secrets de la config : jamais renvoyés au navigateur. Le masque revient tel
# quel au POST quand le champ n'a pas été retouché → valeur stockée conservée.
_SECRET_KEY_RE = re.compile(r"(api_key|_token|secret|password)$", re.I)
_SECRET_MASK = "••••••••"


def _mask_secrets(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: (_SECRET_MASK if (_SECRET_KEY_RE.search(str(k)) and isinstance(v, str) and v)
                    else _mask_secrets(v))
                for k, v in obj.items()}
    if isinstance(obj, list):
        return [_mask_secrets(v) for v in obj]
    return obj


def _unmask_secrets(new: Any, old: Any) -> Any:
    if not isinstance(new, dict):
        return new
    out = {}
    for k, v in new.items():
        prev = old.get(k) if isinstance(old, dict) else None
        if _SECRET_KEY_RE.search(str(k)) and v == _SECRET_MASK:
            out[k] = prev if isinstance(prev, str) else ""
        else:
            out[k] = _unmask_secrets(v, prev)
    return out


# Répertoire résolu contre rag_app/ : le service démarré depuis un autre
# cwd servait un 500 sur / et /static.
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")

# ── Feature « Documents » (OCR) — paquet ocr/, migrée du chatbot 2026-07-23.
# Toute la surface /api/ocr/* vit dans ocr/routes.py (APIRouter dédié).
try:
    from ocr.routes import router as ocr_router  # noqa: E402
except ImportError:
    from rag_app.ocr.routes import router as ocr_router  # noqa: E402
app.include_router(ocr_router)

try:
    try:
        from ocr import lifecycle as _ocr_lifecycle  # noqa: E402
    except ImportError:
        from rag_app.ocr import lifecycle as _ocr_lifecycle  # noqa: E402
except ImportError:
    _ocr_lifecycle = None

@app.get("/api/startup_status")
def startup_status():
    """Retourne l'état du check de démarrage (pour la bannière UI)."""
    return _startup_result

# ── Index ──────────────────────────────────────────────────────────────────

@app.get("/")
def index():
    return HTMLResponse((BASE_DIR / "static" / "index.html").read_text(encoding="utf-8"))

# ── Config ─────────────────────────────────────────────────────────────────

@app.get("/api/config")
def get_config():
    return _mask_secrets(engine.cfg)

@app.post("/api/config")
def save_config(cfg: dict = Body(...)):
    cfg = _unmask_secrets(cfg, engine.cfg)
    if "collection" in cfg:
        _coll = str(cfg.get("collection") or "").strip()
        if not _COLLECTION_RE.match(_coll):
            raise HTTPException(400, "Nom de collection invalide (lettres, chiffres, - et _).")
        cfg["collection"] = _coll
    # Modèle d'embedding ou découpage changé : l'index existant n'est plus
    # cohérent — la console le dit (la prochaine ingestion réindexe tout).
    _reindex = engine.index_fingerprint_changed(cfg)
    # (2026-09-20) Refusé pendant une ingestion : l'engine relit sa config à
    # chaque lot, la changer en plein milieu corrompait l'index en silence.
    try:
        engine.save_config(cfg)
    except IngestionEnCours as exc:
        raise HTTPException(409, str(exc))
    except ConfigInvalide as exc:
        # Validation (passe 2) : types, URL, state_file confiné, listes.
        raise HTTPException(422, str(exc))
    _health_cache["at"] = 0.0
    invalidate_docs_cache()
    return {"status": "ok", "reindex_required": _reindex}

# ── Health & Status ────────────────────────────────────────────────────────

@app.get("/api/health")
def health_check():
    """
    Public health-check, no auth. Utilisé par le bouton "Tester la connexion"
    de l'admin du chatbot pour valider qu'un service RAG est joignable et
    fonctionnel à l'URL fournie.
    """
    import time as _time
    # Cache 10 s (passe 2) : route publique, chaque appel faisait 2 requêtes
    # sortantes (Qdrant + serveur d'embedding).
    if _time.monotonic() - _health_cache["at"] < 10.0 and _health_cache["value"]:
        return dict(_health_cache["value"])
    h = engine.check_health()
    # Enrichit avec quelques métadonnées utiles pour l'UI admin distante
    try:
        h.setdefault("service", "rag_app")
        h.setdefault("version", app.version)
        h.setdefault("collection", engine.cfg.get("collection", ""))
        h.setdefault("auth_required", bool(_expected_token()))
        # Surface reranker status — admins debugging "why is rerank not
        # happening?" can see at a glance whether it's wired up.
        rr = engine.cfg.get("reranker") or {}
        h["reranker_enabled"] = bool(rr.get("enabled") and rr.get("url"))
    except Exception:
        pass
    _health_cache.update(at=_time.monotonic(), value=dict(h))
    return h


_health_cache: dict = {"at": 0.0, "value": None}


@app.get("/api/reranker/test")
def api_reranker_test():
    """
    Probe the configured reranker with a trivial 1-document request.
    Used by the admin panel "Tester le reranker" button.

    Returns the same shape as :func:`reranker.health_check` — an
    ``{ok, configured, msg, ...}`` dict the UI renders directly. We
    don't 4xx/5xx on failure: the test endpoint *successfully*
    determined the reranker is unreachable, which is information, not
    an error.
    """
    try:
        from reranker import health_check as _rr_health
    except ImportError:
        return {"ok": False, "configured": False,
                "msg": "Module reranker absent — réinstaller le patch."}
    try:
        return _rr_health(engine.cfg or {})
    except Exception as e:
        return {"ok": False, "configured": True, "msg": f"Erreur interne: {e}"}


@app.get("/api/sparse/test")
def api_sparse_test():
    """Probe the sparse embedding endpoint with a trivial input.

    Same contract as ``/api/reranker/test`` — never raises, returns
    a structured dict the UI renders directly. The "configured"
    flag distinguishes "no URL set" from "URL set but unreachable".
    """
    try:
        from sparse import health_check as _sp_health
    except ImportError:
        return {"ok": False, "configured": False,
                "msg": "Module sparse absent — réinstaller le patch."}
    try:
        return _sp_health(engine.cfg or {})
    except Exception as e:
        return {"ok": False, "configured": True, "msg": f"Erreur interne: {e}"}


@app.get("/api/contextual/test")
def api_contextual_test():
    """Probe the Contextual Retrieval LLM endpoint with a synthetic
    1-doc/1-chunk pair.

    Returns a structured dict including the actual generated context
    string so the admin can sanity-check the prompt is producing
    French output, doesn't ramble, etc. Same never-raises contract
    as the other test endpoints.
    """
    try:
        from contextual import health_check as _ctx_health
    except ImportError:
        return {"ok": False, "configured": False,
                "msg": "Module contextual absent — réinstaller le patch."}
    try:
        return _ctx_health(engine.cfg or {})
    except Exception as e:
        return {"ok": False, "configured": True, "msg": f"Erreur interne: {e}"}

@app.get("/api/collections")
def api_get_collections():
    return engine.get_collections()

@app.get("/api/stats")
def get_stats():
    """Métriques précises de la collection active (GET /collections/{name})."""
    return engine.get_collection_stats()


# ── Files ──────────────────────────────────────────────────────────────────

@app.get("/api/files")
def list_files():
    data_dir = engine.get_current_data_dir()
    files = []
    if data_dir.exists():
        state = engine._load_state().get("files", {})
        for p in data_dir.rglob("*"):
            if p.is_file() and p.suffix.lower() in engine.cfg.get("allowed_ext", []):
                key  = str(p.resolve())
                stat = p.stat()
                is_indexed = (key in state and state[key].get("mtime") == int(stat.st_mtime))
                files.append({
                    "name":      p.name,
                    "rel_path":  str(p.relative_to(data_dir)).replace("\\", "/"),
                    "full_path": key,
                    "size":      stat.st_size,
                    "mtime":     int(stat.st_mtime),
                    "indexed":   is_indexed,
                    "ext":       p.suffix.lower(),
                })
    return sorted(files, key=lambda x: x["rel_path"])

@app.get("/api/file_text")
def get_file_text(path: str, max_chars: int = 0):
    """
    Pour les formats texte natifs (csv, txt, md, json, py…) : retourne le contenu brut.
    Pour les formats binaires (pdf, docx, xlsx…) : utilise extract_text() pour convertir.

    Memory guard
    ------------
    Loading a 50 MB log file into the chunk-preview UI triggered ~500 MB
    of DOM + JS allocation in the browser (the file went through 3 JSON
    serialisations and was re-emitted as a `<pre x-text>` per chunk).
    Browsers crashed.

    To prevent that:
      * a hard cap of ``DEFAULT_MAX_CHARS`` is enforced server-side
        (configurable via the optional ``max_chars`` query param up to
        ``ABSOLUTE_CEILING``);
      * we return a ``truncated`` flag + ``total_chars`` so the UI can
        warn the user that they're previewing a head-snippet, not the
        whole file;
      * extracted text from binary formats (PDF/DOCX) goes through the
        same cap — these are the most likely to be huge after extraction.

    The cap is intentionally generous (2 MB ≈ 700 pages of text) so it
    doesn't get in the way for typical RAG corpora; it only triggers on
    pathological inputs that would crash the browser anyway.
    """
    RAW_EXTS = {".txt", ".md", ".csv", ".json", ".py", ".js", ".ts", ".html",
                ".htm", ".css", ".xml", ".yaml", ".yml", ".toml", ".ini",
                ".sh", ".bat", ".robot", ".rst", ".tex"}

    DEFAULT_MAX_CHARS  = 2_000_000     # 2 MB ≈ 700 pages — sane default
    ABSOLUTE_CEILING   = 10_000_000    # never exceed even with explicit max_chars=

    cap = max_chars if max_chars and max_chars > 0 else DEFAULT_MAX_CHARS
    cap = min(cap, ABSOLUTE_CEILING)

    try:
        # Confinement : l'endpoint acceptait n'importe quel chemin absolu
        # de la machine. On ne sert que le dossier DATA de la collection
        # active (la liste /api/files fournit des full_path dedans).
        data_dir = engine.get_current_data_dir().resolve()
        raw = Path(path)
        try:
            p = (raw if raw.is_absolute() else data_dir / raw).resolve()
            p.relative_to(data_dir)
        except (ValueError, OSError):
            raise HTTPException(403, "Chemin hors du dossier de données.")
        if not p.exists():
            raise HTTPException(404, "Fichier introuvable")
        if p.is_dir():
            raise HTTPException(400, "C'est un dossier.")
        if p.suffix.lower() in RAW_EXTS:
            # Lecture BORNÉE (passe 2) : le fichier entier était chargé puis
            # passé à charset_normalizer avant d'appliquer le plafond — un
            # upload de 512 Mo coûtait ~2 Go de RAM. On lit au plus 4 octets
            # par caractère servi (UTF-8), l'encodage est détecté sur 64 Ko.
            size = p.stat().st_size
            with open(p, "rb") as fh:
                raw = fh.read(cap * 4)
            try:
                from charset_normalizer import from_bytes as _fb
                best = _fb(raw[:65536]).best()
                enc = (best.encoding if best else None) or "utf-8"
            except Exception:                                   # noqa: BLE001
                enc = "utf-8"
            text = raw.decode(enc, errors="replace")
            del raw
            if size > cap * 4:
                return {"path": path, "text": text[:cap], "truncated": True,
                        "total_chars": None, "total_bytes": size,
                        "returned_chars": min(len(text), cap), "cap": cap}
        else:
            text = engine.extract_text(p) or ""

        total_chars = len(text)
        truncated = total_chars > cap
        if truncated:
            # Slice from the START — for chunking previews the head is
            # what the user wants to see (chunking is uniform across the
            # file when params are well chosen, the head is representative).
            text = text[:cap]
        return {
            "path": path,
            "text": text,
            "truncated": truncated,
            "total_chars": total_chars,
            "returned_chars": len(text),
            "cap": cap,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))

@app.post("/api/files/save")
def save_file_text(payload: dict = Body(...)):
    rel_path = payload.get("rel_path"); content = payload.get("content")
    if not rel_path or content is None: return {"ok": False, "msg": "Données invalides"}
    return engine.save_file_text(rel_path, content)

@app.post("/api/files/convert")
def convert_file_api(payload: dict = Body(...)):
    rel_path = payload.get("rel_path"); target_ext = payload.get("target_ext")
    if not rel_path or not target_ext: return {"ok": False, "msg": "Paramètres manquants"}
    return engine.convert_file(rel_path, target_ext)

@app.post("/api/files/delete")
def delete_file(payload: dict = Body(...)):
    rel_path = payload.get("rel_path")
    if not rel_path: return {"status": "error", "msg": "rel_path manquant"}
    res = engine.delete_file(rel_path)
    invalidate_docs_cache()
    if isinstance(res, dict) and not res.get("ok", True):
        # Code HTTP d'erreur (passe 2) : l'UI affichait « Fichier supprimé »
        # sur un refus rendu en 200.
        raise HTTPException(409, res.get("msg", "Suppression refusée."))
    return {"status": "ok"}

@app.post("/api/files/reindex")
def reindex_file(payload: dict = Body(...)):
    return engine.reindex_single_file(payload.get("rel_path"), payload.get("params"))

@app.post("/api/files/reindex_from_chunks")
def reindex_from_chunks(payload: dict = Body(...)):
    """
    Réindexe un fichier à partir d'une liste de textes de chunks fournie explicitement.
    Body: { rel_path: str, chunks: [{ text: str }] }
    """
    rel_path    = payload.get("rel_path", "")
    chunk_texts = [c.get("text", "") for c in payload.get("chunks", []) if c.get("text", "").strip()]
    if not rel_path:    return {"ok": False, "msg": "rel_path manquant"}
    if not chunk_texts: return {"ok": False, "msg": "Liste de chunks vide"}
    return engine.reindex_from_chunks(rel_path, chunk_texts)

@app.post("/api/files/inspect")
def inspect_file(payload: dict = Body(...)):
    full_path = payload.get("full_path")
    if not full_path: return []
    return engine.get_file_chunks(full_path)

@app.get("/api/files/duplicates")
def get_duplicates():
    return engine.find_duplicate_files()

# ── Chunk split ────────────────────────────────────────────────────────────

@app.post("/api/chunks/split/preview")
def chunk_split_preview(payload: dict = Body(...)):
    chunk_text = payload.get("chunk_text", "")
    params     = payload.get("params", {})
    if not chunk_text.strip():
        return {"ok": False, "msg": "Texte vide.", "chunks": []}
    return engine.preview_chunk_split(chunk_text, params)

@app.post("/api/chunks/split/apply")
def chunk_split_apply(payload: dict = Body(...)):
    original_payload = payload.get("original_payload", {})
    params           = payload.get("params", {})
    if not original_payload:
        return {"ok": False, "msg": "original_payload manquant."}
    if not params:
        return {"ok": False, "msg": "params manquant."}
    return engine.apply_chunk_split(original_payload, params)

# ── Upload ─────────────────────────────────────────────────────────────────

def _sanitize_upload_rel(rel: str, fallback: str) -> str:
    """Neutralise un chemin relatif fourni par le client (composants «..»,
    chemins absolus, antislashs) — sans quoi /api/upload écrivait hors de
    DATA/ avec un simple ``paths=../../…``."""
    rel = (rel or "").strip().replace("\\", "/")
    if not rel or rel == "undefined":
        rel = fallback or "upload.bin"
    parts = [p for p in rel.split("/") if p not in ("", ".", "..")]
    if not parts:
        parts = [Path(fallback or "upload.bin").name or "upload.bin"]
    return "/".join(parts)


# Passe RAG 2026-09-26 — plafonds de l'import. Avant : corps copié sans
# limite (plusieurs Go acceptés), archive décompressée sans borner la taille
# réelle (un zip de 1 Mo → 50 Go : disque plein), fichier écrit EN PLACE (une
# ingestion concurrente lisait une version tronquée et la marquait indexée),
# et toute erreur d'extraction avalée en laissant l'archive dans DATA/.
_UPLOAD_MAX_BYTES = int(os.environ.get("RAG_UPLOAD_MAX_MB", "512")) * 1024 * 1024
_UNPACK_MAX_BYTES = int(os.environ.get("RAG_UNPACK_MAX_MB", "2048")) * 1024 * 1024
_UNPACK_MAX_MEMBERS = 20_000


def _safe_unpack(archive: Path, extract_dir: Path) -> None:
    """Décompression avec garde anti zip-slip : les tar passent par le
    filtre ``data`` (refuse membres absolus/«..»/liens sortants) ; zipfile
    neutralise déjà ces chemins nativement. Taille DÉCOMPRESSÉE et nombre de
    membres bornés AVANT d'écrire quoi que ce soit (``ValueError`` sinon)."""
    name = archive.name.lower()
    if name.endswith((".tar", ".tar.gz", ".tgz", ".bz2", ".xz")):
        import tarfile
        with tarfile.open(archive) as tf:
            members = tf.getmembers()
            if (len(members) > _UNPACK_MAX_MEMBERS
                    or sum(max(0, m.size) for m in members if m.isfile()) > _UNPACK_MAX_BYTES):
                raise ValueError("archive trop volumineuse une fois décompressée")
            tf.extractall(extract_dir, filter="data")
    else:
        import zipfile
        with zipfile.ZipFile(archive) as zf:
            infos = zf.infolist()
            if (len(infos) > _UNPACK_MAX_MEMBERS
                    or sum(i.file_size for i in infos) > _UNPACK_MAX_BYTES):
                raise ValueError("archive trop volumineuse une fois décompressée")
        shutil.unpack_archive(str(archive), extract_dir=str(extract_dir))


def _copy_upload_bounded(src, dest: Path) -> None:
    """Copie bornée vers ``dest.part`` puis renommage atomique."""
    tmp = dest.with_name(dest.name + ".part")
    total = 0
    try:
        with open(tmp, "wb") as out:
            while True:
                chunk = src.read(1 << 20)
                if not chunk:
                    break
                total += len(chunk)
                if total > _UPLOAD_MAX_BYTES:
                    raise ValueError(f"fichier trop volumineux (plafond : "
                                     f"{_UPLOAD_MAX_BYTES // (1024 * 1024)} Mo)")
                out.write(chunk)
        os.replace(tmp, dest)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


_ARCHIVE_EXTS = (".tar.gz", ".tgz", ".zip", ".tar", ".bz2", ".xz")


@app.post("/api/upload")
async def upload_files(files: List[UploadFile] = File(...), paths: List[str] = Form(...)):
    base = engine.get_current_data_dir().resolve()
    if not base.exists(): base.mkdir(parents=True, exist_ok=True)
    # ``zip`` tronquait en silence : fichiers et chemins doivent correspondre.
    if len(files) != len(paths):
        raise HTTPException(400, f"{len(files)} fichier(s) pour {len(paths)} chemin(s).")
    allowed = set(engine.cfg.get("allowed_ext", []))
    count = 0
    errors: List[str] = []
    rejected: List[dict] = []
    overwritten: List[str] = []
    for file, rel_path in zip(files, paths):
        filename  = Path(file.filename or "upload.bin").name
        final_rel = _sanitize_upload_rel(rel_path, filename)
        dest      = (base / final_rel).resolve()
        try:
            dest.relative_to(base)   # ceinture : jamais hors de DATA/
        except ValueError:
            rejected.append({"name": filename, "reason": "chemin hors du dossier"})
            continue
        is_archive = filename.lower().endswith(_ARCHIVE_EXTS)
        # (passe 2) Extension non gérée : le fichier était stocké mais jamais
        # listé — impossible à voir ou à supprimer depuis la console.
        if not is_archive and allowed and dest.suffix.lower() not in allowed:
            rejected.append({"name": filename,
                             "reason": f"extension {dest.suffix or '(aucune)'} non autorisée"})
            continue
        if not is_archive and dest.exists():
            overwritten.append(final_rel)
        if not dest.parent.exists(): dest.parent.mkdir(parents=True, exist_ok=True)
        # AUDIT 2026-08-31 (passe 4, B9) — copie du corps + extraction
        # tar/zip tournaient SUR la boucle (une archive de plusieurs Mo
        # gelait toutes les requêtes RAG/OCR du process). Déport en thread.
        def _write_and_unpack(_file=file, _dest=dest, _filename=filename):
            _copy_upload_bounded(_file.file, _dest)
            if _filename.lower().endswith(_ARCHIVE_EXTS):
                try:
                    for e in _ARCHIVE_EXTS:
                        if _filename.lower().endswith(e):
                            base_name = _filename[:-len(e)]; break
                    else:
                        base_name = _filename
                    extract_dir = _dest.parent / base_name
                    extract_dir.mkdir(parents=True, exist_ok=True)
                    _safe_unpack(_dest, extract_dir)
                finally:
                    # L'archive ne reste JAMAIS dans DATA/ (elle serait
                    # ingérée telle quelle, ou comptée comme document).
                    try:
                        os.remove(_dest)
                    except OSError:
                        pass
        try:
            await asyncio.to_thread(_write_and_unpack)
        except Exception as e:                                   # noqa: BLE001
            errors.append(f"{filename} : {e}")
            continue
        count += 1
    bad = bool(errors or rejected)
    out = {"status": "ok" if not bad else ("partial" if count else "error"),
           "count": count, "rejected": rejected, "overwritten": overwritten}
    if errors:
        out["errors"] = errors
    return out


# Plafond du CORPS de requête des imports, appliqué PENDANT la réception
# (passe 2) : Starlette écrit tout le multipart dans un fichier temporaire
# AVANT le handler — un POST de 50 Go remplissait /tmp avant tout contrôle.
_REQUEST_MAX_BYTES = int(os.environ.get("RAG_UPLOAD_REQUEST_MAX_MB", "2048")) * 1024 * 1024
_BODY_LIMITED_PREFIXES = ("/api/upload", "/api/ocr/docs")


class _BodyLimit:
    """Middleware ASGI : 413 si Content-Length dépasse le plafond, et coupe
    la réception si un corps sans longueur (chunked) le dépasse en cours."""

    def __init__(self, app_):
        self.app = app_

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http" or scope.get("method") != "POST" \
                or not scope.get("path", "").startswith(_BODY_LIMITED_PREFIXES):
            return await self.app(scope, receive, send)
        limit = _REQUEST_MAX_BYTES
        for k, v in scope.get("headers") or []:
            if k == b"content-length":
                try:
                    if int(v) > limit:
                        return await self._reject(send, limit)
                except ValueError:
                    pass
        seen = 0

        async def _limited_receive():
            nonlocal seen
            msg = await receive()
            if msg.get("type") == "http.request":
                seen += len(msg.get("body") or b"")
                if seen > limit:
                    raise HTTPException(413, "Import trop volumineux.")
            return msg
        return await self.app(scope, _limited_receive, send)

    @staticmethod
    async def _reject(send, limit):
        body = json.dumps({"detail": f"Import trop volumineux (plafond : "
                                     f"{limit // (1024 * 1024)} Mo par envoi)."}).encode()
        await send({"type": "http.response.start", "status": 413,
                    "headers": [(b"content-type", b"application/json"),
                                (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})


app.add_middleware(_BodyLimit)

# ── Preview & Ingest ───────────────────────────────────────────────────────

@app.post("/api/preview_text")
def preview_text_chunks(payload: dict = Body(...)):
    return {"chunks": engine.chunk_text(payload.get("text", ""), ".txt", payload.get("params"))}

# ── Tâche d'indexation de FOND (ingestion / réindexation en masse) ────────
# (passe 2) L'indexation tournait DANS le générateur SSE : fermer l'onglet ou
# un délai d'inactivité du proxy l'arrêtait après le fichier en cours, sans
# ping entre deux fichiers (un gros PDF = plusieurs minutes muettes). Elle
# tourne désormais dans un fil dédié ; le flux SSE ne fait que la SUIVRE et
# peut être rouvert à tout moment (reprise de l'affichage au rechargement).
import collections as _collections
import threading as _threading
import time as _time_mod
import uuid as _uuid


class _IndexTask:
    MAX_EVENTS = 500

    def __init__(self, kind: str, folder: Optional[str]):
        self.id = _uuid.uuid4().hex[:12]
        self.kind = kind
        self.folder = folder
        self.state = "running"
        self.started_at = _time_mod.time()
        self.finished_at: Optional[float] = None
        self.total = 0
        self.current = 0
        self.success = 0
        self.error: Optional[str] = None
        self.events: "_collections.deque" = _collections.deque(maxlen=self.MAX_EVENTS)
        self.seq = 0
        self.lock = _threading.Lock()
        self.thread: Optional[_threading.Thread] = None

    def push(self, evt: dict) -> None:
        with self.lock:
            self.seq += 1
            evt = {**evt, "seq": self.seq}
            t = evt.get("type")
            if t == "start":
                self.total = int(evt.get("total") or 0)
            if isinstance(evt.get("current"), int):
                self.current = evt["current"]
            if t in ("ok", "ingest"):
                self.success += 1
            if t == "error" and not evt.get("file"):
                self.error = evt.get("msg") or self.error
            self.events.append(evt)

    def since(self, seq: int) -> list:
        with self.lock:
            return [e for e in self.events if e["seq"] > seq]

    def snapshot(self, with_events: bool = True) -> dict:
        with self.lock:
            out = {"id": self.id, "kind": self.kind, "folder": self.folder,
                   "state": self.state, "started_at": self.started_at,
                   "finished_at": self.finished_at, "total": self.total,
                   "current": self.current, "success": self.success,
                   "error": self.error, "seq": self.seq}
            if with_events:
                out["events"] = list(self.events)
            return out


_index_task: Optional[_IndexTask] = None
_index_task_lock = _threading.Lock()


def _index_task_running() -> bool:
    t = _index_task
    return t is not None and t.state == "running"


def _run_index_task(task: _IndexTask) -> None:
    clear_cancel()
    try:
        if task.kind == "ingest":
            for evt in engine.ingest_process():
                task.push(evt)
        else:
            data_dir  = engine.get_current_data_dir()
            allowed   = set(engine.cfg.get("allowed_ext", []))
            files = sorted(p for p in data_dir.rglob("*")
                           if p.is_file() and p.suffix.lower() in allowed)
            if task.folder:
                f = task.folder.strip("/")
                files = [p for p in files
                         if str(p.relative_to(data_dir)).replace("\\", "/").startswith(f + "/")
                         or p.parent.name == f]
            total = len(files)
            task.push({"type": "start", "total": total})
            # Verrou tenu pour TOUTE la boucle : ni ingestion, ni changement de
            # collection, ni reset au milieu (2026-09-21).
            try:
                with exclusive_index_op():
                    success = 0
                    for i, p in enumerate(files, 1):
                        if engine._cancel_requested():
                            task.push({"type": "info", "msg": "Annulé : arrêt avant le fichier suivant."})
                            break
                        rel = str(p.relative_to(data_dir)).replace("\\", "/")
                        try:
                            res = engine._reindex_single_file_locked(rel)
                        except Exception as e:                  # noqa: BLE001
                            res = {"ok": False, "msg": str(e)}
                        if res.get("ok"):
                            success += 1
                            task.push({"type": "ok", "file": p.name, "chunks": res.get("chunks", 0),
                                       "current": i, "total": total})
                        else:
                            task.push({"type": "error", "file": p.name, "msg": res.get("msg", ""),
                                       "current": i, "total": total})
                    # Réindexation COMPLÈTE réussie (sans filtre de dossier ni
                    # annulation) : l'empreinte d'index est à jour — sinon la
                    # synchronisation suivante refaisait tout.
                    if (not task.folder and success == total
                            and not engine._cancel_requested()):
                        fp = engine._index_fingerprint()
                        engine._update_state(lambda st: st.__setitem__("index_fingerprint", fp))
                    task.push({"type": "done", "success": success, "total": total})
            except IngestionEnCours as e:
                task.push({"type": "error", "file": "", "msg": str(e), "current": 0, "total": total})
                task.push({"type": "done", "success": 0, "total": total})
        final = "canceled" if engine._cancel_requested() else ("error" if task.error else "done")
    except Exception as e:                                      # noqa: BLE001
        logging.getLogger("uvicorn.error").exception("[index-task] échec")
        task.push({"type": "error", "msg": f"Erreur interne : {e}"})
        final = "error"
    finally:
        invalidate_docs_cache()
    with task.lock:
        task.state = final
        task.finished_at = _time_mod.time()
    task.push({"type": "end", "state": final})
    clear_cancel()


@app.post("/api/tasks/index", status_code=202)
def start_index_task(payload: dict = Body(default={})):
    global _index_task
    kind = (payload or {}).get("kind") or "ingest"
    if kind not in ("ingest", "bulk_reindex"):
        raise HTTPException(400, "kind : « ingest » ou « bulk_reindex ».")
    folder = (payload or {}).get("folder") or None
    if folder is not None and not isinstance(folder, str):
        raise HTTPException(400, "folder : chaîne attendue.")
    with _index_task_lock:
        if _index_task_running():
            from fastapi.responses import JSONResponse
            return JSONResponse({"detail": "Une indexation est déjà en cours.",
                                 "task_id": _index_task.id}, status_code=409)
        task = _IndexTask(kind, folder)
        _index_task = task
        task.thread = _threading.Thread(target=_run_index_task, args=(task,),
                                        name=f"rag-index-{task.id}", daemon=True)
        task.thread.start()
    return {"task_id": task.id}


@app.get("/api/tasks/index")
def get_index_task():
    t = _index_task
    return {"task": t.snapshot() if t else None}


@app.post("/api/tasks/index/cancel")
def cancel_index_task():
    if _index_task_running():
        request_cancel()
    return {"ok": True}


@app.get("/api/tasks/index/events")
async def index_task_events(request: Request, since: int = 0,
                            task_id: Optional[str] = None):
    """Suit la tâche courante : rejoue les événements après ``since`` puis
    pousse les nouveaux ; ping toutes les 5 s ; se ferme après ``end``."""
    async def _iter():
        task = _index_task
        if task is None:
            yield _sse({"type": "idle"})
            return
        # ``since`` n'a de sens que pour LA tâche suivie : une autre tâche
        # démarrée entre-temps est rejouée depuis le début.
        last = max(0, int(since or 0)) if (not task_id or task_id == task.id) else 0
        last_ping = _time_mod.monotonic()
        while True:
            for evt in task.since(last):
                last = evt["seq"]
                yield _sse(evt)
                if evt.get("type") == "end":
                    return
            if await request.is_disconnected():
                return
            if _time_mod.monotonic() - last_ping >= 5.0:
                last_ping = _time_mod.monotonic()
                yield _sse({"type": "ping"})
            await asyncio.sleep(0.3)
    return StreamingResponse(_iter(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})

# ── Search Playground (admin UI) ───────────────────────────────────────────

@app.post("/api/search")
def semantic_search(payload: dict = Body(...)):
    """
    Playground sémantique (admin UI de rag_app).
    Body: { query, top_k?, folder?, ext?, use_hybrid?, use_mmr? }
    """
    query = payload.get("query", "").strip()
    if not query: return {"ok": False, "msg": "Query vide.", "results": []}
    try:
        top_k = max(1, min(int(payload.get("top_k", 10)), 100))
    except (TypeError, ValueError):
        top_k = 10
    return rag_search_only(
        query,
        target_folder=payload.get("folder") or None,
        target_ext=payload.get("ext") or None,
        top_k=top_k,
        use_hybrid=bool(payload.get("use_hybrid", True)),
        use_mmr=bool(payload.get("use_mmr", True)),
    )

# ═════════════════════════════════════════════════════════════════════════
#  TOOL ENDPOINTS — SSE protocol consumed by the chatbot
# ═════════════════════════════════════════════════════════════════════════
#
# Why SSE for short request/response?
# -----------------------------------
# 1. Uniform with the existing /api/ingest, /api/files/bulk_reindex streams
#    so the same plumbing can be reused on both sides.
# 2. Allows progressive events for slow searches (start → progress → result),
#    useful when the chatbot wants to display a "RAG en cours…" indicator.
# 3. Connection stays open through long Qdrant queries without HTTP timeouts.
#
# Protocol
# --------
# Every tool emits exactly:
#   data: {"type":"start", "tool":"<name>"}\n\n
#   [optional]  data: {"type":"progress", "msg":"..."}\n\n
#   data: {"type":"result", "payload": <object>}\n\n
#   data: {"type":"done"}\n\n
# On failure:
#   data: {"type":"error", "msg":"..."}\n\n
#   data: {"type":"done"}\n\n
#
# All endpoints accept POST with JSON body for the chatbot client. Some also
# accept GET with query params for easy curl/browser debugging.
# ═════════════════════════════════════════════════════════════════════════

def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


import concurrent.futures as _cf_mod

# Threads dédiés aux calculs des outils (hors du pool de requêtes Starlette,
# qui itère le générateur SSE et doit rester libre pour les pings).
_TOOL_POOL = _cf_mod.ThreadPoolExecutor(max_workers=16, thread_name_prefix="rag-tool")


def _stream_one_shot(tool_name: str, compute):
    """
    Wrap a synchronous compute() into a 3-event SSE stream.
    `compute()` returns a dict (the payload) or raises.
    """
    def _iter():
        yield _sse({"type": "start", "tool": tool_name})
        try:
            # Passe RAG 2026-09-26 — plus RIEN n'était émis entre « start » et
            # le résultat : embedding + sonde + requête hybride + repli +
            # rerank dépassent parfois le délai de lecture du client (30 s) →
            # ReadTimeout côté app alors que le calcul aboutissait. Le calcul
            # tourne dans un thread (contexte copié : ``_SEARCH_ERROR`` y est
            # posé ET lu) et un commentaire SSE part toutes les 5 s.
            import concurrent.futures as _cf
            import contextvars as _cv
            fut = _TOOL_POOL.submit(_cv.copy_context().run, compute)
            while True:
                try:
                    payload = fut.result(timeout=5.0)
                    break
                except _cf.TimeoutError:
                    yield ": ping\n\n"
            yield _sse({"type": "result", "payload": payload})
        except HTTPException as e:
            yield _sse({"type": "error", "msg": str(e.detail), "status": e.status_code})
        except Exception as e:
            logging.getLogger("uvicorn.error").exception(f"[tools/{tool_name}] failure")
            yield _sse({"type": "error", "msg": str(e)})
        yield _sse({"type": "done"})
    return StreamingResponse(_iter(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


# ── rag_search ─────────────────────────────────────────────────────────────

_SEARCH_POOL = _cf_mod.ThreadPoolExecutor(max_workers=8, thread_name_prefix="rag-search")


def _pooled_search(query: str, cols: list, search_mode: str, k: int,
                   use_mmr: bool, cfg_base: dict):
    """Recherche sur plusieurs collections EN PARALLÈLE (passe 2 : en série,
    N collections = N fois le délai d'une recherche). Chaque ligne reçoit
    ``_collection``, ``name``, ``folder`` et ``rel`` (chemin relatif unique)."""
    import contextvars as _cv

    def _one(coll):
        return coll, rag_tool_search(query, collection=coll or None,
                                     search_mode=search_mode, top_k=k, use_mmr=use_mmr)
    futs = [_SEARCH_POOL.submit(_cv.copy_context().run, _one, c) for c in cols]
    pooled, failures = [], []
    for fut in futs:
        try:
            coll, res = fut.result()
        except Exception as e:                                  # noqa: BLE001
            failures.append(str(e)[:200])
            logging.getLogger("uvicorn.error").warning(f"[tools/search] {e}")
            continue
        if not res.get("ok"):
            failures.append(str(res.get("error") or "erreur inconnue"))
            continue
        coll_name = coll or cfg_base.get("collection", "")
        for r in (res.get("results") or []):
            src = r.get("source", "")
            folder, _, name = src.rpartition("/") if "/" in src else ("", "", src)
            r["_collection"] = coll_name
            r["name"] = r.get("name") or name
            r["folder"] = folder
            r["rel"] = _rq._rel_of(r.get("path") or "", r["name"], coll_name)
            pooled.append(r)
    return pooled, failures


@app.post("/api/tools/rag_search", dependencies=[Depends(require_token)])
def tool_rag_search(payload: dict = Body(...)):
    """
    Body:
      query (str, required), top_k (int, default 8),
      use_hybrid (bool, default False), use_mmr (bool, default True),
      collections ([str], optional — union de plusieurs collections),
      filters ({file_glob, folder_contains, folder_equals}, optional),
      score_threshold (float, optional)
    """
    def _do():
        query = (payload.get("query") or "").strip()
        if not query:
            raise HTTPException(400, "Paramètre 'query' requis.")
        top_k = int(payload.get("top_k") or 8)
        use_hybrid = bool(payload.get("use_hybrid", False))
        use_mmr = bool(payload.get("use_mmr", True))
        # Resolve collections: accept singular ("collection") or plural
        # ("collections" — list). The cfg-mutation hack v2 used to support
        # multi-collection didn't actually work (load_config re-reads JSON
        # each call) so we now pass the collection through rag_tool_search,
        # which already takes a per-call override.
        cols = _checked_collections(payload)

        filters = payload.get("filters") or {}
        score_threshold = payload.get("score_threshold")
        try:
            score_threshold = float(score_threshold) if score_threshold is not None else None
        except (TypeError, ValueError):
            score_threshold = None

        # Over-fetch when filters are active so we have enough rows after
        # post-filtering to still return top_k.
        k = max(1, min(top_k * (3 if filters else 1), 64))
        search_mode = "hybrid" if use_hybrid else "classic"
        cfg_base = load_config() or {}

        pooled, failures = _pooled_search(query, cols, search_mode, k, use_mmr, cfg_base)

        if not pooled:
            # (2026-09-21) Une PANNE n'est pas une absence de résultat : sans
            # cette distinction, le modèle concluait que les documents ne
            # contenaient rien et répondait de mémoire.
            if failures:
                raise HTTPException(503, "Recherche documentaire indisponible : " + failures[0])
            return {"results": [], "count": 0,
                    "message": "Aucun résultat trouvé.",
                    "collections_searched": [c or "" for c in cols]}

        # Dedup (collection, document, chunk_index) keep best score
        best = {}
        for r in pooled:
            key = (r.get("_collection", ""), r.get("path") or r.get("name", ""),
                   r.get("chunk_index", 0))
            if key not in best or r.get("score", 0) > best[key].get("score", 0):
                best[key] = r
        items = list(best.values())

        # Post-filters
        import fnmatch
        def _match(r):
            if score_threshold is not None and float(r.get("score", 0)) < score_threshold:
                return False
            fg = filters.get("file_glob")
            if fg and not fnmatch.fnmatch((r.get("name") or "").lower(), fg.lower()):
                return False
            fc = filters.get("folder_contains")
            if fc and fc.lower() not in (r.get("folder") or "").lower():
                return False
            fe = filters.get("folder_equals")
            if fe and (r.get("folder") or "").lower().rstrip("/") != fe.lower().rstrip("/"):
                return False
            return True

        items = [r for r in items if _match(r)]
        items.sort(key=lambda x: -float(x.get("score", 0)))
        items = items[:top_k]

        return {
            "results": [{
                "source": (f"{r.get('folder','')}/{r.get('name','')}"
                           if r.get("folder") else r.get("name", "")),
                # Chemin RELATIF (unique) : deux « README.md » de dossiers
                # différents ne désignent plus le même document.
                "get_document_name": r.get("rel") or r.get("name", ""),
                "chunk": r.get("chunk_index", 0),
                "score": round(float(r.get("score", 0)), 4),
                "text": (r.get("text") or "")[:1500],
                "collection": r.get("_collection") or None,
            } for r in items],
            "count": len(items),
            "collections_searched": [c or "" for c in cols],
            "note": "Utilisez 'get_document_name' (pas 'source') dans rag_get_document.",
        }
    return _stream_one_shot("rag_search", _do)


# ── rag_get_document ───────────────────────────────────────────────────────

# Nombre max de chunks RAPATRIÉS en un appel, quelle que soit la fenêtre
# demandée. ``max_chars`` borne déjà ce qui est RENVOYÉ ; ce plafond borne ce
# qui transite depuis Qdrant (un chunk_end fantaisiste ne doit pas charger un
# document entier en mémoire). Le reste se lit via ``next_chunk_start``.
_DOC_WINDOW_HARD_CAP = 500


@app.post("/api/tools/rag_get_document", dependencies=[Depends(require_token)])
def tool_rag_get_document(payload: dict = Body(...)):
    """
    Body:
      filename (str, required),
      chunk_start (int, optional), chunk_end (int, optional, exclusive),
      max_chunks (int, optional, default 15),
      max_chars  (int, optional, default 20000),
      collection (str, optional — override default collection)
    """
    def _do():
        filename = (payload.get("filename") or "").strip()
        if not filename:
            raise HTTPException(400, "Paramètre 'filename' requis.")
        chunk_start = payload.get("chunk_start")
        chunk_end = payload.get("chunk_end")
        try: chunk_start = int(chunk_start) if chunk_start is not None else None
        except (TypeError, ValueError): chunk_start = None
        try: chunk_end = int(chunk_end) if chunk_end is not None else None
        except (TypeError, ValueError): chunk_end = None

        max_chunks = int(payload.get("max_chunks") or 15)
        max_chars  = int(payload.get("max_chars")  or 20000)
        collection = _checked_collection(payload.get("collection"))

        cfg = load_config() or {}
        if not cfg:
            raise HTTPException(500, "Config RAG introuvable.")
        if collection:
            cfg = {**cfg, "collection": collection}

        # (passe 2) Document désigné par CHEMIN relatif (ou nom) → UN
        # ``path`` : les homonymes de dossiers différents ne sont plus fusionnés,
        # une panne Qdrant n'est plus « document introuvable ».
        _SEARCH_ERROR.set(None)
        matches = resolve_documents(cfg, filename)
        if _SEARCH_ERROR.get():
            raise HTTPException(503, f"Base documentaire indisponible : {_SEARCH_ERROR.get()}.")
        if len(matches) > 1:
            names = ", ".join(m["rel"] for m in matches[:20])
            return {"results": [], "count": 0, "ambiguous": True,
                    "message": f"'{filename}' désigne plusieurs documents : {names}. "
                               "Relancez avec le chemin complet."}
        doc_path = matches[0]["path"] if matches else None
        if matches:
            filename = matches[0]["rel"]
        # Total EXACT compté côté Qdrant (un scroll plafonné annonçait un
        # total égal au plafond : le modèle croyait avoir tout lu).
        total_available = (count_chunks_for_file(cfg, matches[0]["name"], path=doc_path)
                           if matches else 0)
        if _SEARCH_ERROR.get():
            raise HTTPException(503, f"Base documentaire indisponible : {_SEARCH_ERROR.get()}.")

        if not total_available:
            hint = ""
            avail = (list_indexed_files(cfg) or [])[:20]
            if avail:
                hint = f" Documents disponibles : {', '.join(avail)}"
            return {"results": [], "count": 0,
                    "message": f"Aucun contenu pour '{filename}'.{hint}"}

        # ``chunk_start``/``chunk_end`` sont des bornes de ``chunk_index``
        # (fin exclusive) — c'est déjà ce que promet le message ``warning``
        # ci-dessous. La fenêtre est découpée côté Qdrant, donc seuls les
        # chunks demandés transitent, quelle que soit la taille du document.
        s = max(0, chunk_start or 0)
        e = chunk_end if chunk_end is not None else s + max_chunks
        # Plafond dur par appel : borne la mémoire même si l'appelant demande
        # chunk_end=100000. Ce qui dépasse reste joignable via next_chunk_start.
        # Borné par le plafond d'appel, PAS par le compte : un découpage manuel
        # laisse des trous d'index, la fin du document dépassait ``total``.
        e = min(e, s + _DOC_WINDOW_HARD_CAP)

        chunks_to_send = (get_document_chunk_window(cfg, matches[0]["name"], s, e,
                                                     path=doc_path)
                          if e > s else [])

        results, total = [], 0
        for c in chunks_to_send:
            text = c.get("text", "")
            if total + len(text) > max_chars:
                break
            results.append({"chunk": c.get("chunk_index", 0), "text": text})
            total += len(text)

        out = {
            "filename": filename,
            "results": results,
            "count": len(results),
            "total_chars": total,
            "limit_chars": max_chars,
            "total_chunks_available": total_available,
        }
        # Reste-t-il du document APRÈS ce qu'on renvoie ? Vrai aussi bien quand
        # le budget de caractères a coupé (truncated) que quand la fenêtre
        # demandée s'arrêtait avant la fin — les deux cas doivent proposer la
        # suite, sinon le modèle s'arrête en croyant avoir tout lu.
        next_start = (results[-1]["chunk"] + 1) if results else s
        remaining = count_chunks_for_file(cfg, matches[0]["name"], path=doc_path,
                                          min_index=next_start)
        if not results and not remaining:
            out["message"] = (
                f"chunk_start={s} dépasse la fin du document "
                f"({total_available} chunks au total, indices 0 à {total_available - 1})."
            )
        elif remaining:
            out["warning"] = (
                f"Document tronqué à {len(results)} chunk(s) sur {total_available} "
                f"(chunks {s} à {next_start - 1}). Pour lire la suite : "
                f"rag_get_document(filename, chunk_start={next_start})."
            )
            out["next_chunk_start"] = next_start
        return out
    return _stream_one_shot("rag_get_document", _do)


# ── rag_list_sources ───────────────────────────────────────────────────────

@app.post("/api/tools/rag_list_sources", dependencies=[Depends(require_token)])
def tool_rag_list_sources(payload: dict = Body(...)):
    """
    Body:
      name_filter (str, optional, substring case-insensitive),
      collection  (str, optional)
    """
    def _do():
        cfg = load_config() or {}
        if not cfg:
            raise HTTPException(500, "Config RAG introuvable.")
        coll = _checked_collection(payload.get("collection"))
        if coll:
            cfg = {**cfg, "collection": coll}
        _SEARCH_ERROR.set(None)
        files = list_indexed_files(cfg) or []
        if not files and _SEARCH_ERROR.get():
            raise HTTPException(503, f"Base documentaire indisponible : {_SEARCH_ERROR.get()}.")
        name_filter = (payload.get("name_filter") or "").strip().lower()
        if name_filter:
            files = [f for f in files if name_filter in f.lower()]
        return {
            "files": files,
            "count": len(files),
            "collection": coll or cfg.get("collection", ""),
            "note": "Utilisez ces chemins exacts dans rag_get_document.",
        }
    return _stream_one_shot("rag_list_sources", _do)


# ── rag_cite ───────────────────────────────────────────────────────────────

@app.post("/api/tools/rag_cite", dependencies=[Depends(require_token)])
def tool_rag_cite(payload: dict = Body(...)):
    """
    Body:
      query (str, required),
      max_sources (int, optional, default 5, max 10),
      use_hybrid (bool, default False), use_mmr (bool, default True),
      collections ([str], optional)
    """
    def _do():
        query = (payload.get("query") or "").strip()
        if not query:
            raise HTTPException(400, "Paramètre 'query' requis.")
        k = max(1, min(int(payload.get("max_sources") or 5), 10))
        use_hybrid = bool(payload.get("use_hybrid", False))
        use_mmr = bool(payload.get("use_mmr", True))
        cols = _checked_collections(payload)

        cfg_base = load_config() or {}
        search_mode = "hybrid" if use_hybrid else "classic"

        pooled, failures = _pooled_search(query, cols, search_mode, k * 2, use_mmr, cfg_base)

        if not pooled and failures:
            # Panne ≠ absence de source (cf. rag_search).
            raise HTTPException(503, "Recherche documentaire indisponible : " + failures[0])

        best = {}
        for r in pooled:
            key = (r.get("_collection", ""), r.get("path") or r.get("name", ""),
                   r.get("chunk_index", 0))
            if key not in best or r.get("score", 0) > best[key].get("score", 0):
                best[key] = r
        items = sorted(best.values(), key=lambda x: -float(x.get("score", 0)))[:k]

        if not items:
            return {"sources": [], "count": 0,
                    "message": "Aucune source trouvée pour cette requête."}

        sources = []
        for i, r in enumerate(items, 1):
            name = r.get("name", "")
            folder = r.get("folder", "")
            sources.append({
                "cite_id": f"S{i}",
                "source": f"{folder}/{name}" if folder else name,
                "document": r.get("rel") or name,
                "chunk": r.get("chunk_index", 0),
                "collection": r.get("_collection") or None,
                "score": round(float(r.get("score", 0)), 4),
                "excerpt": (r.get("text") or "")[:600],
            })
        return {
            "sources": sources,
            "count": len(sources),
            "instruction_for_llm": (
                "Cite each factual claim with [S1], [S2]… matching the sources above. "
                "If a claim is not supported by any excerpt, say so explicitly."
            ),
        }
    return _stream_one_shot("rag_cite", _do)


# ── rag_index_document / rag_deindex_document (feature OCR du chatbot) ─────

_COLLECTION_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _checked_collection(value: Any) -> Optional[str]:
    """Nom de collection reçu → nom validé, ou ``None`` (collection active).

    Le nom est inséré TEL QUEL dans l'URL Qdrant : avant le 2026-09-21, seules
    l'indexation et la désindexation le validaient, et un
    ``collection="x/points/delete?"`` envoyé à une route de lecture pouvait
    changer un scroll filtré en suppression dans la base partagée."""
    if value is None:
        return None
    name = str(value).strip()
    if not name:
        return None
    if not _COLLECTION_RE.match(name):
        raise HTTPException(400, "Nom de collection invalide (lettres, chiffres, - et _).")
    return name


def _checked_collections(payload: dict) -> list:
    """``collections`` (liste) ou ``collection`` (seule), validées une à une."""
    cols = payload.get("collections")
    if not isinstance(cols, list) or not cols:
        cols = [payload.get("collection")]
    return [_checked_collection(c) for c in cols]


def _engine_for(collection: Optional[str]) -> RAGEngine:
    """Engine ciblant ``collection`` (défaut : l'engine global).

    Instance FRAÎCHE plutôt que mutation de ``engine.cfg`` : le service est
    concurrent, et les méthodes lisent ``self.cfg`` — une instance dédiée à
    l'appel est le seul override sûr. Le client httpx du service est
    PARTAGÉ (l'instance jetable n'en est pas propriétaire) : l'ancienne
    version créait un client par appel sans jamais le fermer — fuite de
    sockets sous charge.
    """
    if not collection:
        return engine
    eng = RAGEngine(engine.config_path, http_client=engine.http_client)
    eng.cfg["collection"] = collection
    return eng


_INDEX_DOC_MAX_CHUNKS = 20_000


@app.post("/api/tools/rag_index_document", dependencies=[Depends(require_token)])
def tool_rag_index_document(payload: dict = Body(...)):
    """
    Indexe un document EXTERNE déjà découpé (pages OCR du chatbot).
    Body:
      rel_path (str, required — relatif à DATA/<collection>),
      chunks ([{text, page?}], required),
      collection (str, optional — défaut : collection active),
      meta (dict, optional — fusionné dans le payload de chaque point)
    """
    def _do():
        rel_path = str(payload.get("rel_path") or "").strip()
        chunks = payload.get("chunks")
        if not rel_path:
            raise HTTPException(400, "Paramètre 'rel_path' requis.")
        if not isinstance(chunks, list) or not chunks:
            raise HTTPException(400, "Paramètre 'chunks' requis (liste non vide).")
        collection = str(payload.get("collection") or "").strip() or None
        if collection and not _COLLECTION_RE.match(collection):
            raise HTTPException(400, "Nom de collection invalide.")
        meta = payload.get("meta")
        # Plus de troncature SILENCIEUSE à 2000 (le document était marqué
        # indexé en entier) : refus explicite au-delà du plafond.
        if len(chunks) > _INDEX_DOC_MAX_CHUNKS:
            raise HTTPException(413, f"{len(chunks)} chunks : plafond "
                                     f"{_INDEX_DOC_MAX_CHUNKS} par document.")
        norm_chunks = [c if isinstance(c, dict) else {"text": str(c)}
                       for c in chunks]
        res = _engine_for(collection).index_document_chunks(
            rel_path, norm_chunks,
            extra_meta=meta if isinstance(meta, dict) else None)
        invalidate_docs_cache()
        if not res.get("ok"):
            raise HTTPException(502, res.get("msg") or "Indexation impossible.")
        return res
    return _stream_one_shot("rag_index_document", _do)


@app.post("/api/tools/rag_deindex_document", dependencies=[Depends(require_token)])
def tool_rag_deindex_document(payload: dict = Body(...)):
    """Body: rel_path (str, required), collection (str, optional)."""
    def _do():
        rel_path = str(payload.get("rel_path") or "").strip()
        if not rel_path:
            raise HTTPException(400, "Paramètre 'rel_path' requis.")
        collection = str(payload.get("collection") or "").strip() or None
        if collection and not _COLLECTION_RE.match(collection):
            raise HTTPException(400, "Nom de collection invalide.")
        res = _engine_for(collection).deindex_document(rel_path)
        invalidate_docs_cache()
        if not res.get("ok"):
            raise HTTPException(502, res.get("msg") or "Désindexation impossible.")
        return res
    return _stream_one_shot("rag_deindex_document", _do)


# ── rag_inline (auto-RAG: pre-pend context to messages) ────────────────────

@app.post("/api/tools/rag_inline", dependencies=[Depends(require_token)])
def tool_rag_inline(payload: dict = Body(...)):
    """
    Auto-RAG endpoint utilisé par apply_rag() côté chatbot.
    Body: { question (str), collection (str, optional), search_mode (str, optional) }
    Renvoie : { context_text (str), sources ([str]) } ou { used: false }.
    """
    def _do():
        q = (payload.get("question") or "").strip()
        if not q:
            return {"used": False, "reason": "empty question"}
        coll = _checked_collection(payload.get("collection"))
        mode = payload.get("search_mode") or "classic"
        # rag() in rag_query.py already takes collection + search_mode as
        # explicit kwargs (no need for module-state hacks). The double
        # try/except keeps us robust if someone deploys a much-older
        # rag_query.py without those parameters.
        _SEARCH_ERROR.set(None)
        try:
            res = rag(q, search_mode=mode, collection=coll)
        except TypeError:
            try:
                res = rag(q, search_mode=mode)
            except TypeError:
                res = rag(q)
        if not res:
            # Panne ≠ aucun passage pertinent : le chat l'annonce au lieu de
            # laisser le modèle répondre de mémoire sans rien dire.
            if _SEARCH_ERROR.get():
                return {"used": False, "error": f"recherche indisponible : {_SEARCH_ERROR.get()}"}
            return {"used": False}
        context_text, sources = res
        return {"used": True, "context_text": context_text, "sources": sources}
    return _stream_one_shot("rag_inline", _do)


# ── DB management ──────────────────────────────────────────────────────────

@app.post("/api/reset")
def reset_database():
    res = engine.purge_database()
    invalidate_docs_cache()
    return res

def _ocr_busy() -> bool:
    try:
        return bool(_ocr_lifecycle and _ocr_lifecycle.busy())
    except Exception:                                           # noqa: BLE001
        return False


async def _graceful_shutdown(timeout_s: float = 15.0) -> None:
    """Arrêt propre (passe 2) : indexation annulée ENTRE deux fichiers et
    attendue (un fichier coupé au milieu gardait un mélange d'anciens et de
    nouveaux points, marqué indexé), file OCR arrêtée, traces écrites, pools
    et clients fermés."""
    t = _index_task
    if t is not None and t.state == "running":
        request_cancel()
        if t.thread is not None:
            await asyncio.to_thread(t.thread.join, timeout_s)
    if _ocr_lifecycle is not None:
        try:
            await asyncio.wait_for(_ocr_lifecycle.on_shutdown(), timeout_s)
        except Exception as e:                                  # noqa: BLE001
            logging.getLogger("uvicorn.error").warning(f"[shutdown] OCR : {e}")
    try:
        await asyncio.to_thread(_rq.flush_traces, 3.0)
    except Exception:                                           # noqa: BLE001
        pass
    for pool in (_TOOL_POOL, _SEARCH_POOL):
        pool.shutdown(wait=False, cancel_futures=True)
    engine.close()


@app.post("/api/restart")
async def restart_server(payload: dict = Body(default={})):
    # (passe 2) Refus si du travail tourne, sauf ``force`` : execv tuait
    # l'ingestion, la file OCR et les recherches en cours sans prévenir.
    busy = []
    if _index_task_running():
        busy.append("indexation")
    if _ocr_busy():
        busy.append("OCR")
    if busy and not (payload or {}).get("force"):
        raise HTTPException(409, f"Travail en cours ({', '.join(busy)}) : "
                                 "attendez sa fin ou forcez le redémarrage.")

    async def do_restart():
        await asyncio.sleep(0.5)
        try:
            await _graceful_shutdown()
        finally:
            os.execv(sys.executable, [sys.executable] + sys.argv)
    _spawn(do_restart())
    return {"ok": True, "msg": "Le serveur redémarre..."}

# ── Logs ───────────────────────────────────────────────────────────────────

@app.get("/api/logs/traces")
def get_traces():
    trace_file = BASE_DIR / "rag_traces.json"
    if trace_file.exists():
        try: return json.loads(trace_file.read_text(encoding="utf-8"))
        except Exception: pass
    return []

@app.get("/api/logs/raw")
def get_raw_logs(type: str):
    if type != "app": return {"text": "Type non autorisé."}
    if LOG_FILE.exists():
        lines = LOG_FILE.read_text(encoding="utf-8", errors="replace").splitlines()
        if lines: return {"text": "\n".join(lines[-500:])}
    return {"text": "--- app.log vide ---"}

@app.get("/api/qdrant/telemetry")
def get_qdrant_telemetry():
    return engine.get_qdrant_telemetry()

@app.post("/api/logs/clear")
def clear_logs():
    try:
        (BASE_DIR / "rag_traces.json").write_text("[]", encoding="utf-8")
        if LOG_FILE.exists():
            with open(LOG_FILE, "w", encoding="utf-8") as f: f.truncate(0)
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "msg": str(e)}

# ── Help ───────────────────────────────────────────────────────────────────

@app.get("/api/help/readme")
def get_readme():
    for p in [BASE_DIR / "README.md", BASE_DIR.parent / "README.md"]:
        if p.exists(): return {"content": p.read_text(encoding="utf-8")}
    return {"content": "# Documentation introuvable\n`README.md` absent."}

if __name__ == "__main__":
    import uvicorn
    # Pas de ``reload`` : le rechargeur relançait le service à chaque écriture
    # d'un .py (et tuait ingestion et file OCR au passage).
    uvicorn.run("app:app", host=os.environ.get("RAG_HOST", "127.0.0.1"),
                port=int(os.environ.get("RAG_PORT", "8000")), log_config=None)
