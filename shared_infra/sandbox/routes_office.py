# SPDX-License-Identifier: MIT
"""shared_infra.sandbox.routes_office — HTTP des aperçus Office / PDF de l'éditeur.

- POST /api/sandbox/office/prepare            {path, view?} → manifeste (convertit au besoin)
- GET  /api/sandbox/office/pdf/{key}/{name}   PDF servi DEPUIS LE CACHE (visualiseur natif)
- GET  /api/sandbox/office/sheet/{key}/{s}/{c} morceau de grille xlsx (JSON)

``prepare`` est un POST : la garde CSRF s'applique et une navigation tierce ne
peut pas déclencher de conversion. Les deux GET ne lisent que le cache de
l'utilisateur authentifié ; leur URL porte la clé (qui change avec le
fichier), d'où ``immutable``.

Cf. docs/editor-office-preview-design-2026-09-15.md
"""
from __future__ import annotations

import asyncio

from fastapi import HTTPException, Request
from fastapi.responses import FileResponse

from shared_infra.config import feature_enabled
from shared_infra.routes._helpers import _get_work_path
from shared_infra.routes._state import router
from shared_infra.sandbox import office_preview as op
from shared_infra.sandbox.office_convert import OfficeError
from shared_infra.security.deps import require_user_id

_IMMUTABLE = "private, max-age=86400, immutable"


def _http(exc: OfficeError) -> HTTPException:
    return HTTPException(exc.status, {"code": exc.code, "message": exc.message})


def _user_dir(user_id: int) -> str:
    # ``_get_work_path`` = ``P/work`` ; le nom de ``P`` est le dossier de
    # l'utilisateur (identité de l'hôte d'outils comprise).
    return _get_work_path(user_id).parent.name


@router.post("/api/sandbox/office/prepare")
async def api_office_prepare(request: Request):
    user_id = require_user_id(request)
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(400, {"code": "invalid", "message": "Requête invalide"})
    if not isinstance(data, dict):
        raise HTTPException(400, {"code": "invalid", "message": "Requête invalide"})
    path = data.get("path")
    view = data.get("view")
    if not isinstance(path, str) or not path or len(path) > 1024:
        raise HTTPException(400, {"code": "invalid", "message": "Chemin invalide"})
    if view is not None and view not in ("grid", "pages"):
        raise HTTPException(400, {"code": "invalid", "message": "Vue invalide"})
    kind = op.kind_of(path)
    if kind is None:
        raise _http(OfficeError("unsupported", 415, "Format non pris en charge"))
    if kind != "pdf" and not feature_enabled("office_preview"):
        raise _http(OfficeError("disabled", 403, "Aperçu Office désactivé"))
    root = _get_work_path(user_id)
    try:
        return await op.prepare(uid=user_id, user_dir=root.parent.name, root=root,
                                path=path, view=view)
    except OfficeError as exc:
        raise _http(exc)


def _cached_headers() -> dict:
    return {
        "Cache-Control": _IMMUTABLE,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "same-origin",
    }


@router.get("/api/sandbox/office/pdf/{key}/{name}")
def api_office_pdf(request: Request, key: str, name: str):
    user_id = require_user_id(request)
    if not op.KEY_RE.match(key):
        raise HTTPException(400, {"code": "invalid", "message": "Clé d'aperçu invalide"})
    try:
        pdf = op.pdf_file(_user_dir(user_id), key)
    except OfficeError as exc:
        raise _http(exc)
    if pdf is None:
        raise _http(OfficeError("expired", 404, "Aperçu expiré"))
    filename = name if name.lower().endswith(".pdf") and "/" not in name else "document.pdf"
    headers = _cached_headers()
    # Visualiseur natif en iframe même origine (vérifié Chromium) : pas de CSP
    # ``sandbox``, qui n'est pas garanti sans effet sur tous les navigateurs.
    headers["X-Frame-Options"] = "SAMEORIGIN"
    headers["Content-Security-Policy"] = "frame-ancestors 'self'"
    return FileResponse(pdf, media_type="application/pdf", headers=headers,
                        filename=filename, content_disposition_type="inline")


@router.get("/api/sandbox/office/sheet/{key}/{sheet}/{chunk}")
async def api_office_sheet(request: Request, key: str, sheet: int, chunk: int):
    user_id = require_user_id(request)
    if not op.KEY_RE.match(key):
        raise HTTPException(400, {"code": "invalid", "message": "Clé d'aperçu invalide"})
    try:
        # La construction éventuelle part EN FOND (elle écrit les morceaux dans
        # l'ordre des lignes) et la demande attend SON morceau, en THREAD : sur
        # la boucle, lire une feuille de 200 000 lignes gèlerait tout le worker
        # — sondes, flux de chat et SSE compris.
        op.want_sheet(_user_dir(user_id), key, sheet)
        f, taille = await asyncio.to_thread(op.sheet_chunk, _user_dir(user_id), key, sheet, chunk)
    except OfficeError as exc:
        raise _http(exc)
    if f is None:
        raise _http(OfficeError("expired", 404, "Aperçu expiré"))
    headers = _cached_headers()
    # TAILLE RÉELLE de la feuille, apprise en la lisant : un classeur sans
    # ``<dimension>`` (ou dont la plage déclarée est fausse) est annoncé court
    # dans le manifeste ; la grille se redimensionne sur ces en-têtes plutôt
    # que d'afficher un tableau tronqué sans le dire.
    if taille:
        headers["X-Office-Rows"] = str(taille.get("rows", 0))
        headers["X-Office-Cols"] = str(taille.get("cols", 0))
        headers["X-Office-Complete"] = "1" if taille.get("complete") else "0"
    return FileResponse(f, media_type="application/json", headers=headers)
