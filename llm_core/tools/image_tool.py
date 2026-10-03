# SPDX-License-Identifier: MIT
"""Outil ``generate_image`` — le modèle génère une image pendant un tour.

Builtin EN PROCESSUS (comme ``task``) : il a besoin du compte, de la
conversation, du moteur d'images et du magasin, que le serveur d'outils n'a
pas. Construit PAR TOUR par l'exécution du chat, qui capture le contexte dans
la fermeture ; ``_dispatch_tool`` attend la coroutine rendue par le handler.

Proposé seulement si l'instance, les groupes et les deux cases du compte le
permettent (``chatbot_app/turn/preparation.py``), jamais en mode plan. Au plus
``image.tool_max_calls`` appels et ``image.max_n`` images par tour : un modèle
qui boucle (ou qu'un document pousse à boucler) ne monopolise pas le GPU et ne
fait pas tourner la rétention du compte.

Délai : l'outil s'auto-borne (attente en file ``QUEUE_MAX_S``, puis délai de
calcul de l'administrateur) ; le délai du wrapper d'outils les couvre, comme
pour ``task``.

Pendant la génération, des événements ``image_progress`` (``source:
"tool"``) alimentent la tuile ; à la fin, ``image`` porte les références,
qui vont aussi dans ``sink["images"]`` : l'exécution les pose sur le message
assistant (``tool_images``), elles survivent au rechargement. Le modèle, lui,
ne reçoit qu'un accusé court (ids, tailles) — jamais les octets. Pour modifier
une image, il la désigne par son id (``ref_image_id``).

Même moteur, même magasin, même rétention que le tour « Images »
(``llm_core.imagegen.service.generate_and_store``).
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Awaitable, Callable, Dict, List, Optional

logger = logging.getLogger("uvicorn.error")

TOOL_NAME = "generate_image"


def _definition(max_n: int) -> Dict[str, Any]:
    from shared_infra.image.config import RATIOS
    return {
        "type": "function",
        "function": {
            "name": TOOL_NAME,
            "description": (
                "Generate images from a text description with the image engine and show "
                "them to the user in the chat. Use it when the user asks for a picture, an "
                "illustration, a logo, a mock-up or any visual. The images appear under your "
                "message automatically: do not describe links or paste URLs. To modify an "
                "image generated earlier, pass its id as ref_image_id."),
            "parameters": {
                "type": "object",
                "properties": {
                    "prompt": {
                        "type": "string",
                        "description": (
                            "Detailed visual description in English: subject, setting, "
                            "style, lighting, composition. Text to render goes in double "
                            "quotes, verbatim."),
                    },
                    "aspect_ratio": {"type": "string", "enum": list(RATIOS),
                                     "description": "Width:height (default 1:1)."},
                    "n": {"type": "integer", "minimum": 1, "maximum": max_n,
                          "description": "Number of images (default 1)."},
                    "ref_image_id": {"type": "string",
                                     "description": "Id of an image generated earlier, "
                                                    "to modify it."},
                },
                "required": ["prompt"],
            },
        },
    }


def _size(cfg: Dict[str, Any], ratio: str, side: int) -> str:
    """Taille demandée : format × côté préféré, ou la taille fixe du moteur
    dont le format est le plus proche."""
    from shared_infra.image.config import parse_size, size_for_ratio
    w, h = size_for_ratio(ratio, min(side, cfg["max_side"]))
    if cfg.get("size_policy") != "fixed":
        return f"{w}x{h}"
    voulu = w / h
    tailles = [s for s in (parse_size(x) for x in cfg.get("sizes") or []) if s]
    if not tailles:
        return f"{w}x{h}"
    bw, bh = min(tailles, key=lambda wh: abs(wh[0] / wh[1] - voulu))
    return f"{bw}x{bh}"


def build_image_builtin_tool(*, user_id: int, chat_id: Optional[str],
                             on_event: Callable[[Dict[str, Any]], Awaitable[None]],
                             is_cancelled: Callable[[], bool],
                             sink: Dict[str, Any],
                             prefs: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """``{"generate_image": {definition, handler}}`` ou ``{}`` si le moteur
    n'est pas prêt (l'outil n'est alors pas proposé au modèle)."""
    from shared_infra.image.access import clean_prefs
    from shared_infra.image.config import RATIOS, effective_max_n, get_image_config, image_ready
    cfg = get_image_config()
    if not image_ready(cfg):
        return {}
    side = clean_prefs(prefs or {}, cfg)["side"]
    # Compteurs du tour. Réservés AVANT l'attente : des appels parallèles ne
    # dépassent pas les plafonds.
    appels = {"n": 0, "images": 0}

    async def _run(args: Dict[str, Any]) -> str:
        from llm_core.imagegen.base import ImageError
        from llm_core.imagegen.service import (
            ProgressTracker,
            build_request,
            capabilities,
            generate_and_store,
        )
        from shared_infra.image.store import read_bytes, valid_id
        live = get_image_config()           # réglage changé en cours de tour
        if not image_ready(live):
            return json.dumps({"ok": False, "error": "Image engine disabled."})
        appels["n"] += 1
        if appels["n"] > live["tool_max_calls"]:
            return json.dumps({"ok": False, "error": (
                f"Limit reached: at most {live['tool_max_calls']} image generations per "
                "turn. Show the user what you have.")})
        args = args if isinstance(args, dict) else {}
        prompt = str(args.get("prompt") or "").strip()
        ratio = str(args.get("aspect_ratio") or "1:1")
        if ratio not in RATIOS:
            ratio = "1:1"
        try:
            n = int(args.get("n") or 1)
        except (TypeError, ValueError, OverflowError):
            n = 1
        reste = effective_max_n(live) - appels["images"]
        if reste <= 0:
            return json.dumps({"ok": False, "error": (
                f"Limit reached: at most {effective_max_n(live)} images per turn. "
                "Show the user what you have.")})
        n = max(1, min(n, reste))
        appels["images"] += n
        t0 = time.monotonic()
        tracker: Optional[ProgressTracker] = None

        async def on_progress(st: str, qp: Optional[int] = None, info: Any = None) -> None:
            if tracker is not None:
                await on_event(tracker.event(source="tool"))
        try:
            source = None
            ref = args.get("ref_image_id")
            if ref:
                if not valid_id(ref):
                    raise ImageError("Unknown ref_image_id.", code="invalid")
                source = await asyncio.to_thread(read_bytes, user_id, ref)
                if source is None:
                    raise ImageError("Image to modify not found or expired.", code="invalid")
            caps = await capabilities(live)
            req = await asyncio.to_thread(build_request, live, prompt,
                                          {"size": _size(live, ratio, side), "n": n},
                                          caps, source)
            tracker = ProgressTracker(req)
            await on_event(tracker.event(source="tool"))
            refs, meta = await generate_and_store(
                live, req, user_id=user_id, chat_id=chat_id, prompt=prompt, caps=caps,
                on_progress=on_progress, cancelled=is_cancelled, tracker=tracker,
                extra={"source": "tool"})
        except ImageError as exc:
            appels["images"] -= n
            if exc.detail:
                logger.warning("[image/outil] %s — %s", exc.message, exc.detail)
            await on_event({"type": "image_error", "source": "tool", **exc.payload()})
            return json.dumps({"ok": False, "error": exc.message}, ensure_ascii=False)
        images: List[Dict[str, Any]] = sink.setdefault("images", [])
        images.extend(refs)
        if meta:
            sink["meta"] = meta
        await on_event({"type": "image", "source": "tool", "items": refs, "prompt": prompt})
        logger.info("[image/outil] user=%s chat=%s : %d image(s) en %.1f s", user_id,
                    str(chat_id or "")[:12], len(refs), time.monotonic() - t0)
        return json.dumps({
            "ok": True,
            "images": [{"id": r["id"], "width": r.get("width"), "height": r.get("height")}
                       for r in refs],
            "note": "Displayed to the user under your message.",
        }, ensure_ascii=False)

    def handler(args: Dict[str, Any]):
        # Appelé via ``asyncio.to_thread`` : rend la coroutine, que
        # ``_dispatch_tool`` attend sur la boucle (même contrat que ``task``).
        return _run(args)

    return {TOOL_NAME: {"definition": _definition(effective_max_n(cfg)), "handler": handler}}


def tool_timeout_s() -> float:
    """Délai du wrapper d'outil : l'attente maximale en file, le délai de
    calcul du moteur, plus une marge (enregistrement). L'outil s'arrête de
    lui-même plus tôt : le wrapper ne coupe jamais une génération légitime."""
    from llm_core.imagegen.base import QUEUE_MAX_S
    from shared_infra.image.config import get_image_config
    return QUEUE_MAX_S + float(get_image_config()["timeout_sec"]) + 60.0
