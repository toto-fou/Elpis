# SPDX-License-Identifier: MIT
"""Orchestration : choix du moteur, capacités, validation, créneaux,
génération, magasin.

Hors de ``llm_scheduling_guard`` : le moteur d'images est une machine distincte
du serveur de modèles de langage, l'ordonnanceur LLM n'a rien à arbitrer.

Capacités (sd-server seulement) : gardées 60 s ; un échec est gardé 10 s, pour
qu'un moteur éteint réponde tout de suite « injoignable » au lieu de refaire
attendre la connexion à chaque demande. Les capacités lues au pré-vol servent
à toute la génération : une seule sonde par tour.
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import logging
import time
from typing import Any, Dict, List, Optional, Tuple

from llm_core.imagegen.base import (
    IMAGE_FORMATS,
    CancelledCb,
    ImageError,
    ImageRequest,
    ImageResult,
    ProgressCb,
    sniff_mime,
)
from llm_core.imagegen.openai import OpenAIProvider
from llm_core.imagegen.sdcpp import SdcppProvider
from shared_infra.image.config import (
    api_key,
    effective_max_n,
    features,
    parse_size,
    round_step,
)

logger = logging.getLogger("uvicorn.error")

PROMPT_MAX = 4000
NEGATIVE_MAX = 2000
SOURCE_MAX_BYTES = 20 * 1024 * 1024
_SOURCE_MAX_PIXELS = 40_000_000

_CAPS_TTL = 60.0
_CAPS_FAIL_TTL = 10.0
_caps_cache: Dict[Tuple[str, ...], Tuple[float, Any]] = {}


def get_provider(cfg: Dict[str, Any]):
    """Client du moteur configuré (``cfg`` = :func:`get_image_config` ou sa
    fusion avec le formulaire de la console, qui peut porter ``api_key``)."""
    key = cfg["api_key"] if "api_key" in cfg else api_key(cfg)
    common = {"timeout_sec": cfg.get("timeout_sec", 180), "verify": cfg.get("verify", True),
              "ca_pem": cfg.get("ca_pem", "")}
    if cfg.get("provider") == "openai":
        return OpenAIProvider(cfg.get("url", ""), model=cfg.get("model", ""),
                              api_key=key, **common)
    return SdcppProvider(cfg.get("url", ""), api_key=key, **common)


def _caps_key(cfg: Dict[str, Any]) -> Tuple[str, ...]:
    ca = hashlib.sha256((cfg.get("ca_pem") or "").encode("utf-8")).hexdigest()[:12]
    return (cfg.get("url", ""), cfg.get("provider", ""), str(cfg.get("verify", True)), ca)


async def capabilities(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Capacités du moteur (sd-server : limites, modèle chargé), ou ``{}`` pour
    un service OpenAI (rien d'utile à sonder avant chaque image).

    :class:`ImageError` si le moteur est injoignable ou trop lent ; une
    réponse inattendue rend ``{}`` (le moteur tranchera à la soumission)."""
    if cfg.get("provider") != "sdcpp":
        return {}
    k = _caps_key(cfg)
    now = time.monotonic()
    hit = _caps_cache.get(k)
    if hit:
        age = now - hit[0]
        if isinstance(hit[1], ImageError):
            if age < _CAPS_FAIL_TTL:
                raise hit[1]
        elif age < _CAPS_TTL:
            return hit[1]
    try:
        caps = await get_provider(cfg).capabilities()
    except ImageError as exc:
        if exc.code in ("unavailable", "timeout"):
            _caps_cache[k] = (now, exc)
            raise
        logger.info("[image] capacités indisponibles : %s", exc.detail or exc.message)
        return {}
    _caps_cache[k] = (now, caps)
    return caps


def forget_capabilities() -> None:
    """Après un changement de configuration (test de la console)."""
    _caps_cache.clear()


def _int(v: Any, default: int) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def prepare_source(data: bytes, width: int, height: int) -> bytes:
    """Image source d'une édition → PNG RGB exactement ``width×height``.

    Recadrage « cover » (on remplit le cadre, on rogne l'excédent centré) :
    les moteurs de diffusion exigent la taille demandée, et étirer déforme.
    :class:`ImageError` ``invalid`` si ce n'est pas une image PNG, JPEG ou WEBP
    lisible, ou si elle est démesurée (bombe de décompression). Le format est
    vérifié sur la signature AVANT toute ouverture, puis Pillow n'ouvre que ces
    formats. Synchrone : à appeler en thread.
    """
    from PIL import Image, ImageOps, UnidentifiedImageError
    if not data or len(data) > SOURCE_MAX_BYTES:
        raise ImageError("Image source trop lourde (20 Mo au plus).", code="invalid", status=400)
    if sniff_mime(data) is None:
        raise ImageError("Image source : PNG, JPEG ou WEBP seulement.", code="invalid",
                         status=400)
    try:
        with Image.open(io.BytesIO(data), formats=list(IMAGE_FORMATS)) as im:
            if im.width * im.height > _SOURCE_MAX_PIXELS:
                raise ImageError("Image source trop grande.", code="invalid", status=400)
            rgb = ImageOps.exif_transpose(im).convert("RGB")
            out = ImageOps.fit(rgb, (width, height), method=Image.Resampling.LANCZOS)
            buf = io.BytesIO()
            out.save(buf, "PNG")
            return buf.getvalue()
    except ImageError:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as exc:
        raise ImageError("Image source illisible.", code="invalid", status=400,
                         detail=repr(exc)) from exc


def _refus(message: str) -> ImageError:
    return ImageError(message, code="invalid", status=400)


def build_request(cfg: Dict[str, Any], prompt: str, opts: Dict[str, Any],
                  caps: Optional[Dict[str, Any]] = None,
                  source: Optional[bytes] = None) -> ImageRequest:
    """Valide la demande ; :class:`ImageError` ``invalid`` (400) sinon. Les
    options que le moteur ne comprend pas (graine, négatif, étapes) sont
    ignorées. Synchrone (prépare l'image source) : à appeler en thread."""
    prompt = (prompt or "").strip()
    if not prompt:
        raise _refus("Décrivez l'image à générer.")
    if len(prompt) > PROMPT_MAX:
        raise _refus(f"Description trop longue ({PROMPT_MAX} caractères au plus).")
    side = cfg.get("default_side") or 1024
    wh = parse_size(opts.get("size") or f"{side}x{side}")
    if wh is None:
        raise _refus("Format d'image invalide.")
    if cfg.get("size_policy") == "fixed":
        if f"{wh[0]}x{wh[1]}" not in (cfg.get("sizes") or []):
            raise _refus("Taille non proposée par ce moteur : "
                         + ", ".join(cfg.get("sizes") or []) + ".")
        w, h = wh
    else:
        w, h = round_step(wh[0]), round_step(wh[1])
        max_side = int(cfg.get("max_side") or 2048)
        if max(w, h) > max_side:
            raise _refus(f"Image trop grande : {max_side} px au plus par côté.")
    limits = (caps or {}).get("limits") or {}
    for key, val, label in (("width", w, "Largeur"), ("height", h, "Hauteur")):
        lo, hi = _int(limits.get(f"min_{key}"), 0), _int(limits.get(f"max_{key}"), 0)
        if (lo and val < lo) or (hi and val > hi):
            raise _refus(f"{label} {val} hors des limites du moteur ({lo}–{hi}).")
    n = _int(opts.get("n"), 1)
    max_n = effective_max_n(cfg)
    batch_max = _int(limits.get("max_batch_count"), 0)
    if batch_max:
        max_n = min(max_n, batch_max)
    if not 1 <= n <= max_n:
        raise _refus(f"Nombre d'images entre 1 et {max_n}.")
    req = ImageRequest(prompt=prompt, width=w, height=h, n=n)
    feats = features(cfg)
    if source:
        req.init_image = prepare_source(source, w, h)
        req.edit_mode = cfg.get("edit_mode") or "init"
        raw_st = opts.get("strength")
        try:
            st = float(raw_st) if raw_st is not None else 0.0
        except (TypeError, ValueError):
            st = 0.0
        req.strength = st if 0.05 <= st <= 1.0 else 0.75
    if feats["seed"]:
        seed = _int(opts.get("seed"), -1)
        req.seed = seed if 0 <= seed < 2**31 else -1
    if feats["negative"]:
        req.negative_prompt = str(opts.get("negative_prompt") or "").strip()[:NEGATIVE_MAX]
    if feats["steps"]:
        steps = _int(opts.get("steps"), 0)
        req.steps = steps if 0 < steps <= 200 else 0
    return req


async def run_generation(cfg: Dict[str, Any], req: ImageRequest, on_progress: ProgressCb,
                         cancelled: CancelledCb, *, eta_s: Optional[float] = None
                         ) -> List[ImageResult]:
    """Génère ``req.n`` images avec le moteur configuré.

    Service OpenAI : un créneau commun à tous les workers (``slots``), gardé
    après un Stop jusqu'à la fin estimée du calcul distant."""
    provider = get_provider(cfg)
    if cfg.get("provider") != "openai":
        return await provider.generate(req, on_progress, cancelled)
    from llm_core.imagegen import slots

    async def _attente() -> None:
        await on_progress("waiting", None)
    slot: Optional[slots.Slot] = await slots.acquire(
        cfg.get("url", ""), cfg.get("max_concurrent", 1), on_wait=_attente, cancelled=cancelled)
    t0 = time.monotonic()
    try:
        return await provider.generate(req, on_progress, cancelled)
    except (ImageError, asyncio.CancelledError) as exc:
        if isinstance(exc, asyncio.CancelledError) or exc.code == "cancelled":
            reste = (eta_s or 30.0) - (time.monotonic() - t0)
            if slot is not None:
                slot.release_after(min(max(0.0, reste), float(cfg.get("timeout_sec") or 180)))
                slot = None
        raise
    finally:
        if slot is not None:
            slot.release()


def estimate_seconds(model: str, req: ImageRequest) -> Optional[float]:
    """Durée de calcul attendue d'un lot, d'après les lots précédents du même
    modèle (médiane des secondes par mégapixel). ``None`` sans historique :
    mieux vaut pas d'estimation qu'une estimation inventée. Synchrone."""
    from shared_infra.image.store import recent_timings
    try:
        hist = recent_timings(model, req.steps)
    except Exception:                                           # noqa: BLE001
        logger.info("[image] historique de durées illisible", exc_info=True)
        return None
    if not hist:
        return None
    rates = sorted(d / mp for d, mp in hist if mp > 0)
    if not rates:
        return None
    rate = rates[len(rates) // 2]
    return max(1.0, rate * (req.width * req.height * max(1, req.n) / 1e6))


class ProgressTracker:
    """Avancée d'une génération, pour la tuile du chat.

    Pourcentage seulement s'il est RÉEL (le moteur publie ses étapes). Sinon
    l'interface montre le temps écoulé et, s'il existe un historique, la durée
    attendue (``eta_s``) qu'elle marque « ≈ ».
    """

    def __init__(self, req: ImageRequest, eta_s: Optional[float] = None) -> None:
        self.w, self.h, self.n = req.width, req.height, req.n
        self.t0 = time.monotonic()
        self.state: str = "queued"
        self.qp: Optional[int] = None
        self.eta_s = eta_s
        self.gen_t0: Optional[float] = None
        self.pct_real: Optional[float] = None
        self.preview: Optional[str] = None
        self._preview_sent: Optional[str] = None

    def update(self, state: str, qp: Optional[int] = None,
               info: Optional[Dict[str, Any]] = None) -> None:
        info = info or {}
        self.state, self.qp = state, qp
        if state == "generating" and self.gen_t0 is None:
            # ``started_at`` vient de l'horloge du moteur : l'écart avec la
            # nôtre est borné par le temps réellement écoulé depuis la demande.
            started = info.get("started_at")
            lag = max(0.0, time.time() - float(started)) if started else 0.0
            self.gen_t0 = time.monotonic() - min(lag, time.monotonic() - self.t0)
        if isinstance(info.get("pct"), (int, float)):
            self.pct_real = float(info["pct"])
        if info.get("preview"):
            self.preview = info["preview"]

    def event(self, source: Optional[str] = None) -> Dict[str, Any]:
        ev: Dict[str, Any] = {
            "type": "image_progress", "state": self.state, "queue_position": self.qp,
            "elapsed_s": int(time.monotonic() - self.t0),
            "eta_s": int(round(self.eta_s)) if self.eta_s else None,
            "pct": int(self.pct_real) if self.pct_real is not None else None,
            "pct_real": self.pct_real is not None,
            "width": self.w, "height": self.h, "n": self.n,
        }
        if source:
            ev["source"] = source
        # Aperçu envoyé UNE fois par nouvelle image (il pèse), pas à chaque état.
        if self.preview and self.preview != self._preview_sent:
            ev["preview"] = self.preview
            self._preview_sent = self.preview
        return ev

    def gen_seconds(self) -> Optional[float]:
        return None if self.gen_t0 is None else time.monotonic() - self.gen_t0


async def _hors_annulation(fut: "asyncio.Future[Any]") -> Any:
    """Attend ``fut`` jusqu'à son terme même si la tâche est annulée (Stop).

    Les images calculées sont en cours d'écriture dans un thread que
    l'annulation n'arrête pas : on attend l'écriture, on rend les références
    (le tour ou l'outil les montre) et on retire l'annulation absorbée."""
    annulations = 0
    while True:
        try:
            res = await asyncio.shield(fut)
            break
        except asyncio.CancelledError:
            if fut.cancelled():
                raise
            annulations += 1
    if annulations:
        t = asyncio.current_task()
        if t is not None and hasattr(t, "uncancel"):
            for _ in range(annulations):
                t.uncancel()
    return res


def model_name(cfg: Dict[str, Any], caps: Optional[Dict[str, Any]]) -> str:
    """Nom du modèle : celui que sd-server annonce, sinon celui de la config."""
    return str((caps or {}).get("model") or cfg.get("model") or "")


async def generate_and_store(cfg: Dict[str, Any], req: ImageRequest, *, user_id: int,
                             chat_id: Optional[str], prompt: str,
                             caps: Optional[Dict[str, Any]],
                             on_progress: ProgressCb, cancelled: CancelledCb,
                             tracker: ProgressTracker,
                             extra: Optional[Dict[str, Any]] = None
                             ) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Génère puis range les images du compte. Rend ``(références, méta)`` où
    ``méta = {model, duration_s}`` (pied de la carte).

    Commun au tour « Images » et à l'outil ``generate_image`` : même moteur,
    même magasin, même rétention."""
    model = model_name(cfg, caps)
    if tracker.eta_s is None:
        tracker.eta_s = await asyncio.to_thread(estimate_seconds, model, req)

    async def _progress(state: str, qp: Optional[int] = None,
                        info: Optional[Dict[str, Any]] = None) -> None:
        tracker.update(state, qp, info)
        await on_progress(state, qp, info)

    results = await run_generation(cfg, req, _progress, cancelled, eta_s=tracker.eta_s)
    gs = tracker.gen_seconds()
    duration = round(gs, 2) if gs and gs > 0.2 else None
    params: Dict[str, Any] = {"size": f"{req.width}x{req.height}", "provider": cfg["provider"],
                              "negative_prompt": req.negative_prompt, "steps": req.steps,
                              "edit": bool(req.init_image)}
    if extra:
        params.update(extra)
    from shared_infra.image.store import save_images
    refs = await _hors_annulation(asyncio.ensure_future(asyncio.to_thread(
        save_images, user_id, chat_id, prompt, model=model, params=params, results=results,
        keep=cfg["keep_per_user"], steps=req.steps, duration_s=duration)))
    meta: Dict[str, Any] = {"model": model}
    if duration is not None:
        meta["duration_s"] = round(duration, 1)
    return refs, meta
