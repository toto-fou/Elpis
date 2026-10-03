# SPDX-License-Identifier: MIT
"""Client « OpenAI-compatible » : ``POST /v1/images/generations`` et ``/edits``.

Couvre gpt-image / DALL-E, LocalAI, et sd-server lui-même en dialecte OpenAI.
Appel SYNCHRONE : pas de file visible, pas d'annulation côté serveur — Stop
abandonne la requête (le calcul distant continue : le créneau de
``slots.py`` reste tenu jusqu'à sa fin estimée).

Comme Open WebUI (``routers/images.py``) : ``response_format: b64_json`` sauf
pour les modèles ``gpt-image-*`` qui le refusent (ils renvoient toujours du
base64) ; une réponse en ``url`` est téléchargée ici, jamais par le navigateur,
sans l'en-tête d'autorisation, et seulement sur l'origine du moteur configuré
(hôte et port) : un moteur ne fait pas joindre d'autres machines au serveur.
On ne garde que les ``n`` images demandées.
"""
from __future__ import annotations

import asyncio
import re
import time
from typing import Any, Dict, List

import httpx

from llm_core.imagegen.base import (
    HINT_ADMIN,
    CancelledCb,
    ImageError,
    ImageRequest,
    ImageResult,
    ProgressCb,
    to_result,
)
from llm_core.imagegen.http import (
    LARGE_BYTES,
    client,
    fetch,
    json_body,
    raise_for_status,
)
from shared_infra.image.config import engine_origin

_NO_RESPONSE_FORMAT = re.compile(r"^gpt-image", re.I)
# Plafond d'une image téléchargée par URL : au-delà, ce n'est pas une image.
_MAX_DOWNLOAD = 40 * 1024 * 1024
# Cadence à laquelle on regarde si l'utilisateur a cliqué Stop.
_CANCEL_TICK = 0.5


def endpoint(base: str, suffix: str) -> str:
    """Base « http://h:port », « …/v1 » ou route complète : les trois marchent."""
    base = (base or "").rstrip("/")
    if base.endswith(suffix):
        return base
    if base.endswith("/v1"):
        return base + suffix[3:]
    return base + suffix


class OpenAIProvider:
    def __init__(self, url: str, *, model: str = "", api_key: str = "",
                 timeout_sec: int = 180, verify: bool = True, ca_pem: str = "") -> None:
        self.url = (url or "").rstrip("/")
        self.model = model
        self.timeout_sec = int(timeout_sec)
        self.verify = verify
        self.ca_pem = ca_pem
        self._headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}

    def _client(self, timeout: float) -> httpx.AsyncClient:
        return client(timeout, verify=self.verify, ca_pem=self.ca_pem)

    def _endpoint(self, suffix: str) -> str:
        if not self.url:
            raise ImageError("Aucune adresse configurée. " + HINT_ADMIN, code="unavailable")
        return endpoint(self.url, suffix)

    async def capabilities(self) -> Dict[str, Any]:
        models = await self.list_models()
        return {"model": self.model, "mode": "img_gen", "limits": {}, "defaults": {},
                "models": [m["id"] for m in models]}

    async def list_models(self) -> List[Dict[str, str]]:
        async with self._client(10.0) as c:
            r = await fetch(c, "GET", self._endpoint("/v1/models"), headers=self._headers)
        raise_for_status(r, "models")
        data = json_body(r, "models")
        items = data.get("data") if isinstance(data, dict) else None
        if not isinstance(items, list):
            raise ImageError("Liste de modèles illisible.", code="engine")
        ids = sorted({str(m.get("id")) for m in items if isinstance(m, dict) and m.get("id")})
        return [{"id": i, "label": i} for i in ids]

    def build_payload(self, req: ImageRequest) -> Dict[str, Any]:
        p: Dict[str, Any] = {"prompt": req.prompt, "n": max(1, req.n),
                             "size": f"{req.width}x{req.height}"}
        if self.model:
            p["model"] = self.model
        if not _NO_RESPONSE_FORMAT.match(self.model or ""):
            p["response_format"] = "b64_json"
        return p

    async def generate(self, req: ImageRequest, on_progress: ProgressCb,
                       cancelled: CancelledCb) -> List[ImageResult]:
        # Le délai couvre tout l'appel : le transport, lui, ne borne que
        # chaque lecture.
        async with self._client(float(self.timeout_sec)) as c:
            t0 = time.monotonic()
            await on_progress("generating", None, {"started_at": time.time()})
            if req.init_image:
                fields = {k: str(v) for k, v in self.build_payload(req).items()}
                call = fetch(c, "POST", self._endpoint("/v1/images/edits"),
                             headers=self._headers, limit=LARGE_BYTES, data=fields,
                             files={"image": ("source.png", req.init_image, "image/png")})
            else:
                call = fetch(c, "POST", self._endpoint("/v1/images/generations"),
                             headers=self._headers, limit=LARGE_BYTES,
                             json=self.build_payload(req))
            task = asyncio.ensure_future(call)
            try:
                while not task.done():
                    if cancelled():
                        raise ImageError("Génération annulée.", code="cancelled")
                    if time.monotonic() - t0 > self.timeout_sec:
                        raise ImageError(
                            f"Génération trop longue (plus de {self.timeout_sec} s).",
                            code="timeout")
                    await asyncio.wait({task}, timeout=_CANCEL_TICK)
                r = task.result()
            finally:
                if not task.done():
                    task.cancel()
            what = "images/edits" if req.init_image else "images/generations"
            raise_for_status(r, what)
            # Le lot en base64 est décodé hors de la boucle d'événements.
            body = await asyncio.to_thread(json_body, r, what)
            items = body.get("data") if isinstance(body, dict) else None
            if not isinstance(items, list) or not items:
                raise ImageError("Le moteur n'a renvoyé aucune image.", code="engine")
            out: List[ImageResult] = []
            for item in items[:max(1, req.n)]:
                if not isinstance(item, dict):
                    continue
                if item.get("b64_json"):
                    raw: Any = item["b64_json"]
                elif item.get("url"):
                    raw = await self._download(c, str(item["url"]))
                else:
                    continue
                out.append(await asyncio.to_thread(
                    to_result, raw, (req.width, req.height),
                    revised_prompt=str(item.get("revised_prompt") or "")))
            if not out:
                raise ImageError("Le moteur n'a renvoyé aucune image.", code="engine")
            return out

    async def _download(self, c: httpx.AsyncClient, url: str) -> bytes:
        origin = engine_origin(url)
        if not origin or origin != engine_origin(self.url):
            raise ImageError("Adresse d'image invalide renvoyée par le moteur.",
                             code="engine", detail=url[:200])
        r = await fetch(c, "GET", url, limit=_MAX_DOWNLOAD)
        if r.status_code != 200:
            raise ImageError("Image introuvable à l'adresse renvoyée.",
                             code="engine", detail=f"HTTP {r.status_code}")
        return r.content
