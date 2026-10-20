# SPDX-License-Identifier: MIT
# rag_app/extracteur/ocr_pont.py — OCR des pages PDF sans texte par le client de vision existant de rag_app/ocr.
from __future__ import annotations

import base64
import re
from collections.abc import AsyncIterator
from typing import Any

from .blocs import Collecteur
from .erreurs import ErreurExtracteur
from .format_texte import markdown_vers_blocs
from .isolation import executer
from .reglages import reglages

_PROMPT = "<|grounding|>Convert the document to markdown."
_DELAI_PAGE_S = 900


def _client():
    try:
        from ..ocr import client
    except (ImportError, ValueError):
        from ocr import client
    return client


def ocr_pris_en_charge() -> bool:
    try:
        _client()
        return True
    except Exception:  # noqa: BLE001 — santé : jamais d'exception
        return False


def config_client(service: dict[str, Any]) -> dict[str, Any]:
    """Réglages du client de vision à partir de ceux que le core envoie (rag.ocr de config.json)."""
    return {"endpoint_url": str(service["url"]).rstrip("/"), "api_key": service.get("api_key") or "",
            "model": service.get("model") or "", "prompt": _PROMPT, "timeout_sec": int(service.get("timeout_s") or 180),
            "page_deadline_sec": max(_DELAI_PAGE_S, int(service.get("timeout_s") or 180)),
            "max_tokens": int(service.get("max_tokens") or 8192), "max_side_px": int(service.get("max_side_px") or 1280)}


def _norm(texte: str) -> str:
    return re.sub(r"\W+", " ", texte.casefold()).strip()


def _attacher_boites(blocs: list[dict[str, Any]], zones: list[dict[str, Any]], echelle: tuple[float, float]) -> None:
    for bloc in blocs:
        texte = _norm(bloc["text"])
        boites = []
        for zone in zones:
            amorce = _norm(str(zone.get("text", "")))[:60]
            if len(amorce) >= 3 and amorce in texte:
                x0, y0, x1, y1 = zone["box"]
                boites.append([round(x0 * echelle[0], 1), round(y0 * echelle[1], 1),
                               round(x1 * echelle[0], 1), round(y1 * echelle[1], 1)])
        if boites:
            bloc["boxes"] = boites


async def lire_pages(chemin_pdf: str, pages: list[int],
                     service: dict[str, Any]) -> AsyncIterator[tuple[int, list[dict[str, Any]], list[dict]]]:
    """Pour chaque page : (numéro, blocs, avertissements) lus par le modèle de vision."""
    client = _client()
    cfg = config_client(service)
    try:
        cfg = await client.ensure_model(cfg)
    except client.OcrError as exc:
        raise ErreurExtracteur("ocr_unavailable", str(exc), 503)
    for n in pages:
        image = await executer({"type": "render", "path": chemin_pdf, "page": n, "fmt": "png",
                                "max_side_px": cfg.get("max_side_px") or 1280,
                                "pixels_max": reglages().pixels_max}, reglages().delai_rendu_s)
        png = base64.b64decode(image["data"])
        avert: list[dict] = []
        try:
            async with client.gpu_slot():
                brut = await client.stream_ocr(png, cfg=cfg)
        except client.OcrTruncated as exc:
            brut = exc.raw
            avert.append({"code": "ocr_truncated", "message": f"Page {n} : texte coupé par le plafond de génération.",
                          "page": n})
        except client.OcrError as exc:
            raise ErreurExtracteur("ocr_unavailable", str(exc), 503)
        texte, zones = client.parse_grounding(brut, image["width_px"], image["height_px"])
        col = Collecteur(1 << 40)
        markdown_vers_blocs(texte, col, {})
        for bloc in col.blocs:
            bloc["page"] = n
        echelle = (image["page_width"] / max(1, image["width_px"]), image["page_height"] / max(1, image["height_px"]))
        _attacher_boites(col.blocs, zones, echelle)
        if not col.blocs:
            avert.append({"code": "ocr_empty", "message": f"Page {n} : aucun texte reconnu.", "page": n})
        yield n, col.blocs, avert
