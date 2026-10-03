# SPDX-License-Identifier: MIT
"""Client de l'API native ``/sdcpp/v1`` de ``sd-server`` (stable-diffusion.cpp).

Pourquoi ce dialecte plutôt que celui d'OpenAI, que sd-server expose aussi :
c'est le seul qui donne la file d'attente (``queue_position``) et l'annulation.
Référence : ``examples/server/api.md`` de leejet/stable-diffusion.cpp.

    POST /sdcpp/v1/img_gen          → 202 {id, status:"queued"}
    GET  /sdcpp/v1/jobs/{id}        → queued | generating | completed | failed | cancelled
    POST /sdcpp/v1/jobs/{id}/cancel → 200 (job en file) ; 409 (job en cours)
    GET  /sdcpp/v1/capabilities     → modèle chargé, current_mode, limits, defaults

Un processus sd-server = un modèle : rien ici ne choisit de modèle. Le job
n'expose ni graine ni (dans les builds publiés) pourcentage : la graine est
tirée ici pour être connue, l'avancée est estimée par l'appelant.

Délais : le délai de l'administrateur (``timeout_sec``) compte à partir du
DÉBUT DU CALCUL (``generating``), pas de la soumission — un job resté en file
derrière ceux d'autres comptes n'expire pas sans avoir calculé. L'attente en
file a sa propre borne (``QUEUE_MAX_S``).

Stop : un job en file est annulé ; un job en cours ne peut pas l'être
(sd-server répond 409) — il est abandonné, son résultat ignoré.
"""
from __future__ import annotations

import asyncio
import logging
import random
import time
from typing import Any, Dict, List, Optional

import httpx

from llm_core.imagegen.base import (
    HINT_ADMIN,
    QUEUE_MAX_S,
    CancelledCb,
    ImageError,
    ImageRequest,
    ImageResult,
    ProgressCb,
    data_url,
    to_result,
)
from llm_core.imagegen.http import LARGE_BYTES, client, fetch, json_body, raise_for_status

logger = logging.getLogger("uvicorn.error")

# Cadence de sondage : rapide au début (une image Turbo sort en quelques
# secondes), plus lâche ensuite pour ne pas marteler un serveur mono-worker.
_POLL_FIRST, _POLL_MAX = 0.5, 2.0
_TERMINAUX = ("completed", "failed", "cancelled")


def progress_info(job: Dict[str, Any]) -> Dict[str, Any]:
    """Ce que le job dit VRAIMENT de son avancée.

    L'API documentée ne publie que ``started`` (epoch). Les champs d'avancée et
    d'aperçu sont lus s'ils apparaissent (builds récents ou serveur patché) —
    ``progress`` (0–1, 0–100 ou ``{step, steps, preview}``), ``step``/``steps``,
    ``current_step``/``total_steps``, ``preview`` (base64, data URL ou
    ``{b64_json}``). Rien de tout ça n'est inventé : absent = absent.
    """
    out: Dict[str, Any] = {}
    started = job.get("started")
    if isinstance(started, (int, float)) and started > 0:
        out["started_at"] = float(started)
    prog = job.get("progress")
    step = steps = None
    pct = None
    if isinstance(prog, dict):
        step = prog.get("step", prog.get("current_step", prog.get("current")))
        steps = prog.get("steps", prog.get("total_steps", prog.get("total")))
        frac = prog.get("fraction", prog.get("percent"))
        if isinstance(frac, (int, float)):
            pct = frac * 100 if frac <= 1 else frac
    elif isinstance(prog, (int, float)) and not isinstance(prog, bool):
        pct = prog * 100 if prog <= 1 else prog
    if step is None:
        step = job.get("step", job.get("current_step"))
        steps = job.get("steps", job.get("total_steps"))
    if pct is None and isinstance(step, (int, float)) and isinstance(steps, (int, float)) and steps > 0:
        pct = 100.0 * step / steps
    if isinstance(pct, (int, float)):
        out["pct"] = max(0.0, min(100.0, float(pct)))
    prev = job.get("preview")
    if prev is None and isinstance(prog, dict):
        prev = prog.get("preview")
    if isinstance(prev, dict):
        prev = prev.get("b64_json") or prev.get("data")
    # Aperçu plafonné (~1,5 Mo) : c'est un repère visuel, pas l'image finale.
    if isinstance(prev, str) and 32 < len(prev) <= 2_000_000:
        out["preview"] = prev if prev.startswith("data:image/") else "data:image/png;base64," + prev
        out["preview_key"] = (len(prev), prev[-48:])
    return out


class SdcppProvider:
    def __init__(self, url: str, *, timeout_sec: int = 180, verify: bool = True,
                 ca_pem: str = "", api_key: str = "") -> None:
        self.url = (url or "").rstrip("/")
        self.timeout_sec = int(timeout_sec)
        self.verify = verify
        self.ca_pem = ca_pem
        # sd-server n'a pas d'authentification ; un proxy devant peut en avoir.
        self._headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}

    def _client(self, timeout: float) -> httpx.AsyncClient:
        return client(timeout, verify=self.verify, ca_pem=self.ca_pem)

    def _url(self, path: str) -> str:
        if not self.url:
            raise ImageError("Aucune adresse configurée. " + HINT_ADMIN, code="unavailable")
        return self.url + path

    async def capabilities(self) -> Dict[str, Any]:
        async with self._client(10.0) as c:
            r = await fetch(c, "GET", self._url("/sdcpp/v1/capabilities"), headers=self._headers)
        raise_for_status(r, "capabilities")
        data = json_body(r, "capabilities")
        if not isinstance(data, dict):
            raise ImageError("Réponse illisible : est-ce bien un sd-server ?", code="engine")
        raw_model = data.get("model")
        model: Dict[str, Any] = raw_model if isinstance(raw_model, dict) else {}
        by_mode = data.get("defaults_by_mode")
        defaults = by_mode.get("img_gen") if isinstance(by_mode, dict) else None
        return {
            "model": str(model.get("stem") or model.get("name") or data.get("model_name") or ""),
            "mode": str(data.get("current_mode") or ""),
            "limits": data.get("limits") if isinstance(data.get("limits"), dict) else {},
            "defaults": defaults if isinstance(defaults, dict) else {},
        }

    async def list_models(self) -> List[Dict[str, str]]:
        caps = await self.capabilities()
        name = caps.get("model") or ""
        return [{"id": name, "label": name or "(modèle chargé)"}]

    def build_payload(self, req: ImageRequest) -> Dict[str, Any]:
        """Charge utile ``img_gen``. Étapes et cfg restent les défauts du modèle
        chargé tant que l'utilisateur ne les change pas."""
        p: Dict[str, Any] = {
            "prompt": req.prompt,
            "width": req.width,
            "height": req.height,
            "seed": req.seed,
            "batch_count": max(1, req.n),
            "output_format": "png",
        }
        if req.negative_prompt:
            p["negative_prompt"] = req.negative_prompt
        if req.steps > 0:
            p["sample_params"] = {"sample_steps": min(req.steps, 200)}
        if req.init_image:
            if req.edit_mode == "ref":
                p["ref_images"] = [data_url(req.init_image)]
            else:
                p["init_image"] = data_url(req.init_image)
                p["strength"] = round(min(max(req.strength or 0.75, 0.05), 1.0), 2)
        return p

    async def generate(self, req: ImageRequest, on_progress: ProgressCb,
                       cancelled: CancelledCb) -> List[ImageResult]:
        if req.seed < 0:
            # Tirée ici : le job ne la renvoie pas, et la carte l'affiche.
            req.seed = random.randint(1, 2**31 - 1)
        t_submit = time.monotonic()
        async with self._client(30.0) as c:
            r = await fetch(c, "POST", self._url("/sdcpp/v1/img_gen"), headers=self._headers,
                            json=self.build_payload(req))
            raise_for_status(r, "img_gen")
            job = json_body(r, "img_gen")
            if not isinstance(job, dict) or not job.get("id"):
                raise ImageError("Réponse de soumission illisible.", code="engine")
            job_id = str(job["id"])
            terminal = False
            gen_t0: Optional[float] = None
            last: tuple = (None, None, None, None)
            delay = _POLL_FIRST
            try:
                while True:
                    if cancelled():
                        raise ImageError("Génération annulée.", code="cancelled")
                    now = time.monotonic()
                    if gen_t0 is not None and now - gen_t0 > self.timeout_sec:
                        raise ImageError(
                            f"Génération trop longue (plus de {self.timeout_sec} s).",
                            code="timeout")
                    if gen_t0 is None and now - t_submit > QUEUE_MAX_S + self.timeout_sec:
                        raise ImageError("File d'attente du moteur trop longue.", code="busy")
                    r = await fetch(c, "GET", self._url(f"/sdcpp/v1/jobs/{job_id}"),
                                    headers=self._headers, limit=LARGE_BYTES)
                    if r.status_code in (404, 410):
                        terminal = True
                        raise ImageError("Le moteur a perdu la génération (redémarré ?).",
                                         code="engine", status=r.status_code)
                    raise_for_status(r, "jobs")
                    # Un job terminé porte le lot entier en base64 : décodé
                    # hors de la boucle d'événements.
                    st = await asyncio.to_thread(json_body, r, "jobs")
                    if not isinstance(st, dict):
                        raise ImageError("État de génération illisible.", code="engine")
                    status = str(st.get("status") or "")
                    if status in _TERMINAUX:
                        terminal = True
                    if status == "completed":
                        return await asyncio.to_thread(self._results, st.get("result"), req)
                    if status == "failed":
                        err = st.get("error")
                        msg = err.get("message") if isinstance(err, dict) else err
                        raise ImageError("Le moteur n'a pas pu générer l'image.",
                                         code="refused", detail=str(msg or "")[:300])
                    if status == "cancelled":
                        raise ImageError("Génération annulée par le moteur.", code="cancelled")
                    qp = st.get("queue_position")
                    info = progress_info(st)
                    if status == "generating" and gen_t0 is None:
                        # ``started`` vient de l'horloge du moteur : l'écart
                        # avec la nôtre est borné par le temps réellement
                        # écoulé depuis la soumission.
                        started = info.get("started_at")
                        lag = max(0.0, time.time() - float(started)) if started else 0.0
                        lag = min(lag, time.monotonic() - t_submit)
                        gen_t0 = time.monotonic() - lag
                    cur = (status, qp if isinstance(qp, int) else None,
                           info.get("pct"), info.get("preview_key"))
                    if cur != last:
                        last = cur
                        info.pop("preview_key", None)
                        await on_progress(status or "queued", cur[1], info)
                    await asyncio.sleep(delay)
                    delay = min(_POLL_MAX, delay * 1.5)
            except BaseException:
                if not terminal:
                    # Stop, délai dépassé, client parti : libérer le serveur.
                    # Protégé : une seconde annulation de la tâche ne doit pas
                    # couper cet appel.
                    pending = asyncio.ensure_future(self._cancel(job_id))
                    try:
                        await asyncio.shield(pending)
                    except asyncio.CancelledError:
                        pass
                raise

    async def _cancel(self, job_id: str) -> None:
        try:
            async with self._client(5.0) as c:
                r = await fetch(c, "POST", self._url(f"/sdcpp/v1/jobs/{job_id}/cancel"),
                                headers=self._headers)
        except ImageError as exc:
            logger.info("[image] annulation du job %s impossible : %s", job_id,
                        exc.detail or exc.message)
            return
        if r.status_code == 409:
            logger.info("[image] job %s déjà en calcul : abandonné, résultat ignoré", job_id)

    def _results(self, result: Any, req: ImageRequest) -> List[ImageResult]:
        images = (result or {}).get("images") if isinstance(result, dict) else None
        if not isinstance(images, list) or not images:
            raise ImageError("Le moteur n'a renvoyé aucune image.", code="engine")
        out: List[ImageResult] = []
        for i, item in enumerate(images):
            raw = item.get("b64_json") if isinstance(item, dict) else item
            # sd-server incrémente la graine d'une image à la suivante du lot.
            out.append(to_result(raw, (req.width, req.height),
                                 seed=req.seed + i if req.seed >= 0 else None))
        return out
