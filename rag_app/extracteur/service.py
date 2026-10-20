# SPDX-License-Identifier: MIT
# rag_app/extracteur/service.py — orchestration côté serveur : flux d'extraction, rendu d'une page, localisation.
from __future__ import annotations

import base64
import json
import logging
import os
from collections.abc import AsyncIterator
from contextlib import aclosing
from typing import Any

from . import ocr_pont, prison
from .chemins import CONVERTIBLES, resoudre_source
from .conversion import pdf_converti, soffice_bin
from .erreurs import CODES_EXTRACTION, ErreurExtracteur
from .isolation import executer, flux
from .reglages import reglages

log = logging.getLogger("rag.extracteur")


def ligne(objet: dict[str, Any]) -> bytes:
    return (json.dumps(objet, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def sante() -> dict[str, bool]:
    return {"soffice": bool(soffice_bin()), "isolated": bool(prison.bwrap_utilisable()),
            "ocr": ocr_pont.ocr_pris_en_charge()}


async def _extraire(chemin: str, ext: str, ocr: bool, max_chars: int | None,
                    service_ocr: dict[str, Any] | None) -> AsyncIterator[dict[str, Any]]:
    cfg = reglages()
    taille = os.stat(chemin).st_size
    if taille > cfg.taille_max_octets:
        raise ErreurExtracteur("too_large", "Fichier trop volumineux.", 413)
    plafond = min(max_chars, cfg.texte_max_car) if max_chars else cfg.texte_max_car
    job = {"type": "extract", "path": chemin, "ext": ext, "max_chars": plafond, "zip_max_mo": cfg.zip_max_mo,
           "tolerer_vide": bool(ocr)}
    resultat: dict[str, Any] = {}
    async with aclosing(flux(job, cfg.delai_extraction_s)) as messages:
        async for message in messages:
            if message["type"] == "progress":
                yield message
            else:
                resultat = message
    vides = resultat.pop("pages_sans_texte", [])
    blocs, avertissements, meta = resultat["blocks"], resultat["warnings"], resultat["meta"]
    if ocr and vides and service_ocr is None:
        if not blocs:
            raise ErreurExtracteur("ocr_unavailable", "Aucun serveur OCR n'est configuré (rag.ocr.url).", 503)
        avertissements.append({"code": "ocr_unavailable", "message": "OCR non configuré : pages sans texte ignorées.",
                               "pages": vides[:50]})
    elif ocr and vides:
        nouveaux: list[dict[str, Any]] = []
        fait = 0
        async with aclosing(ocr_pont.lire_pages(chemin, vides, service_ocr)) as pages:
            async for _page, lus, avert in pages:
                fait += 1
                nouveaux.extend(lus)
                avertissements.extend(avert)
                yield {"type": "progress", "done": fait, "total": len(vides)}
        blocs = sorted([*blocs, *nouveaux], key=lambda b: b.get("page") or 0)
        meta["text_layer"] = len(vides) < (meta.get("pages") or 0)
        if not blocs:
            raise ErreurExtracteur("no_text", "Aucun texte reconnu, même par OCR.")
    elif ocr and not blocs:
        raise ErreurExtracteur("no_text", "Aucun texte extractible.")
    yield {"type": "result", "meta": meta, "blocks": blocs, "warnings": avertissements}


async def flux_extraction(chemin: str, ext: str, ocr: bool, max_chars: int | None,
                          service_ocr: dict[str, Any] | None = None) -> AsyncIterator[bytes]:
    """Lignes NDJSON : progress*, puis result ou error."""
    try:
        async with aclosing(_extraire(chemin, ext, ocr, max_chars, service_ocr)) as messages:
            async for message in messages:
                yield ligne(message)
    except ErreurExtracteur as exc:
        code = exc.code if exc.code in CODES_EXTRACTION else "corrupt"
        log.info("extraction %s : %s", code, exc.message)
        yield ligne({"type": "error", "code": code, "message": exc.message})
    except Exception:  # noqa: BLE001 — le flux se termine toujours par une ligne typée
        log.exception("extraction : erreur interne")
        yield ligne({"type": "error", "code": "corrupt", "message": "Erreur interne de l'extracteur."})


async def _pdf_de(source: str, ext: str) -> tuple[str, str]:
    chemin, ext = resoudre_source(source, ext)
    if ext == ".pdf":
        return str(chemin), ext
    if ext in CONVERTIBLES:
        return str(await pdf_converti(chemin, ext)), ext
    raise ErreurExtracteur("unsupported", "Seuls pdf, docx, pptx et xlsx ont des pages.", 415)


async def rendre(source: str, ext: str, page: int, dpi: int) -> tuple[bytes, dict[str, Any]]:
    pdf, _ = await _pdf_de(source, ext)
    res = await executer({"type": "render", "path": pdf, "page": page, "dpi": dpi, "fmt": "webp",
                          "pixels_max": reglages().pixels_max}, reglages().delai_rendu_s)
    return base64.b64decode(res.pop("data")), res


async def localiser(source: str, ext: str, texte: str, indice: int | None) -> dict[str, Any]:
    pdf, _ = await _pdf_de(source, ext)
    res = await executer({"type": "locate", "path": pdf, "text": texte, "page_hint": indice},
                         reglages().delai_rendu_s)
    return res
