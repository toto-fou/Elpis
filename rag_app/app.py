# SPDX-License-Identifier: MIT
# rag_app/app.py — extracteur du RAG intégré (service elpis-rag) : /api/extract, /api/render, /api/locate, /api/health.
import os

# Avant l'import de fastapi : le venv porte un greffon pydantic (logfire) qui ne sert à rien ici (cf. shared_infra/runtime/pyruntime.py).
os.environ.setdefault("PYDANTIC_DISABLE_PLUGINS", "1")

import asyncio
import hmac
import logging
import sys
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response, StreamingResponse

try:
    from extracteur import service as _ex
    from extracteur.erreurs import ErreurExtracteur
    from extracteur.modeles import ExtraireIn, LocaliserIn, RendreIn
except ImportError:
    from rag_app.extracteur import service as _ex
    from rag_app.extracteur.erreurs import ErreurExtracteur
    from rag_app.extracteur.modeles import ExtraireIn, LocaliserIn, RendreIn

VERSION = "3.0.0"
BASE_DIR = Path(__file__).resolve().parent
_TOKEN_FILE = BASE_DIR.parent / "user_db" / ".rag_service_token"
_LOOPBACK = ("127.0.0.1", "::1", "localhost")
_PROXY_HEADERS = ("x-forwarded-for", "x-real-ip", "forwarded", "via")
_NO_TOKEN_MSG = ("Extracteur sans jeton : accès limité à la machine locale. "
                 "Définissez RAG_SERVICE_TOKEN ou user_db/.rag_service_token.")
_ROUTES_EXTRACTEUR = ("/api/extract", "/api/render", "/api/locate")

if os.environ.get("RAG_APP_KEEP_STDIO") != "1" and "pytest" not in sys.modules:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s : %(message)s")


def _fichier_jeton() -> Path:
    brut = os.environ.get("RAG_SERVICE_TOKEN_FILE", "").strip()
    return Path(brut) if brut else _TOKEN_FILE


def _expected_token() -> str:
    """Jeton attendu : RAG_SERVICE_TOKEN, sinon le fichier de jeton (relu à chaque appel : il change à ./elpis configure)."""
    tok = os.environ.get("RAG_SERVICE_TOKEN", "").strip()
    if tok:
        return tok
    try:
        return _fichier_jeton().read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def _direct_loopback(request: Request) -> bool:
    """Appel local sans relais : un proxy local ferait passer tout le réseau pour 127.0.0.1."""
    host = request.client.host if request.client else ""
    return host in _LOOPBACK and not any(h in request.headers for h in _PROXY_HEADERS)


def require_token(request: Request) -> None:
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
    if not hmac.compare_digest(token.encode("utf-8"), expected.encode("utf-8")):
        raise HTTPException(403, "Token invalide.")


app = FastAPI(title="Elpis — extracteur RAG", version=VERSION, docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/api/health")
def health_check():
    """Santé publique, sans détail sensible : version, LibreOffice présent, OCR pris en charge (adresse donnée par le core)."""
    return {"ok": True, "service": "rag_app", "version": VERSION, **_ex.sante()}


def _erreur_http(exc: ErreurExtracteur) -> HTTPException:
    return HTTPException(exc.http, exc.detail())


@app.exception_handler(RequestValidationError)
async def _validation_422(request: Request, exc: RequestValidationError):
    if request.url.path not in _ROUTES_EXTRACTEUR:
        return await request_validation_exception_handler(request, exc)
    erreurs = [{"loc": list(e.get("loc", ())), "msg": e.get("msg", ""), "type": e.get("type", "")} for e in exc.errors()]
    return JSONResponse({"detail": erreurs}, status_code=422)


@app.post("/api/extract", dependencies=[Depends(require_token)])
async def api_extract(req: ExtraireIn):
    try:
        chemin, ext = _ex.resoudre_source(req.source, req.ext)
    except ErreurExtracteur as exc:
        if exc.code != "unsupported":
            raise _erreur_http(exc)
        corps = _ex.ligne({"type": "error", "code": "unsupported", "message": exc.message})
        return Response(corps, media_type="application/x-ndjson")
    try:
        await asyncio.to_thread(_ex.prison.exiger)
    except ErreurExtracteur as exc:
        raise _erreur_http(exc)
    service_ocr = req.ocr_service.model_dump() if req.ocr_service is not None else None
    return StreamingResponse(_ex.flux_extraction(str(chemin), ext, req.ocr, req.max_chars, service_ocr),
                             media_type="application/x-ndjson", headers={"Cache-Control": "no-store"})


@app.post("/api/render", dependencies=[Depends(require_token)])
async def api_render(req: RendreIn):
    try:
        image, infos = await _ex.rendre(req.source, req.ext, req.page, req.dpi)
    except ErreurExtracteur as exc:
        raise _erreur_http(exc)
    return Response(image, media_type="image/webp", headers={
        "X-Rag-Pages": str(infos["pages"]), "X-Rag-Page-Width": str(infos["page_width"]),
        "X-Rag-Page-Height": str(infos["page_height"]), "Cache-Control": "no-store"})


@app.post("/api/locate", dependencies=[Depends(require_token)])
async def api_locate(req: LocaliserIn):
    try:
        return await _ex.localiser(req.source, req.ext, req.text, req.page_hint)
    except ErreurExtracteur as exc:
        raise _erreur_http(exc)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host=os.environ.get("RAG_HOST", "127.0.0.1"),
                port=int(os.environ.get("RAG_PORT", "8000")), log_config=None)
