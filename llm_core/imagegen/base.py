# SPDX-License-Identifier: MIT
"""Types communs aux moteurs d'images.

Un moteur implémente trois appels :

  * ``capabilities()`` — ce qui est chargé et les limites annoncées ;
  * ``list_models()``  — pour la liste déroulante de la console ;
  * ``generate(req, on_progress, cancelled)`` — produit ``req.n`` images.

``on_progress(state, queue_position, info)`` est appelé à chaque changement
(``queued`` → ``generating``, ou nouvelle avancée) ; ``info`` (facultatif) porte
ce que le moteur sait VRAIMENT : ``started_at`` (epoch du début de calcul),
``pct`` (0–100, si le serveur publie les étapes), ``preview`` (data URL d'un
aperçu intermédiaire). ``cancelled()`` est consulté entre deux sondages.

Les erreurs portent un ``code`` stable, celui que l'interface reçoit dans
``image_error`` : ``unavailable`` (moteur injoignable ou mal configuré),
``forbidden``, ``invalid`` (demande refusée avant envoi), ``timeout``,
``busy`` (file pleine), ``refused`` (le moteur refuse la demande), ``engine``
(réponse inattendue, panne du moteur), ``cancelled``, ``too_large``.
``message`` se montre à l'utilisateur ; ``detail`` reste au journal.
"""
from __future__ import annotations

import base64
import binascii
import io
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Dict, List, Optional, Protocol, Tuple

HINT_ADMIN = "Vérifiez Administration › Modèles et services › Images."

#: Formats d'image lus par l'application (sources jointes, réponses des
#: moteurs, vignettes) : Pillow n'ouvre que ceux-là.
IMAGE_FORMATS = ("PNG", "JPEG", "WEBP")
#: Attente maximale en file (sd-server) ou d'un créneau (service OpenAI), en
#: plus du délai de calcul de l'administrateur.
QUEUE_MAX_S = 3600.0

_RETRYABLE = frozenset({"unavailable", "timeout", "busy", "engine", "cancelled"})


class ImageError(Exception):
    def __init__(self, message: str, *, code: str = "engine",
                 detail: str = "", status: Optional[int] = None) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.detail = detail
        self.status = status

    @property
    def retryable(self) -> bool:
        return self.code in _RETRYABLE

    def payload(self) -> Dict[str, Any]:
        """Forme de l'événement ``image_error`` et du champ de message."""
        return {"code": self.code, "message": self.message, "retryable": self.retryable}


@dataclass
class ImageRequest:
    prompt: str
    width: int
    height: int
    n: int = 1
    seed: int = -1
    negative_prompt: str = ""
    steps: int = 0
    # Édition : image source en PNG DÉJÀ recadrée à width×height
    # (``service.prepare_source``). ``edit_mode`` : « init » = img2img
    # (``init_image`` + ``strength``) ; « ref » = image de référence.
    init_image: Optional[bytes] = None
    strength: float = 0.0
    edit_mode: str = "init"


@dataclass
class ImageResult:
    data: bytes
    mime: str
    width: int
    height: int
    seed: Optional[int] = None
    revised_prompt: str = ""
    extra: Dict[str, Any] = field(default_factory=dict)


ProgressCb = Callable[..., Awaitable[None]]      # (state, queue_position, info=None)
CancelledCb = Callable[[], bool]


class ImageProvider(Protocol):
    async def capabilities(self) -> Dict[str, Any]: ...
    async def list_models(self) -> List[Dict[str, str]]: ...
    async def generate(self, req: ImageRequest, on_progress: ProgressCb,
                       cancelled: CancelledCb) -> List[ImageResult]: ...


def sniff_mime(data: bytes) -> Optional[str]:
    """Type d'image d'après la signature ; ``None`` si ce n'est pas une image."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def data_url(png: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")


def decode_b64(value: Any) -> bytes:
    """Base64 brut ou data URL → octets ; :class:`ImageError` si illisible."""
    s = str(value or "")
    if s.startswith("data:") and "," in s:
        s = s.split(",", 1)[1]
    try:
        return base64.b64decode(s, validate=False)
    except (binascii.Error, ValueError) as exc:
        raise ImageError("Image illisible renvoyée par le moteur.",
                         code="engine", detail=str(exc)) from exc


def image_dims(data: bytes, fallback: Tuple[int, int]) -> Tuple[int, int]:
    """``(largeur, hauteur)`` réelles de l'image (en-tête seulement) ;
    ``fallback`` si illisible. Le moteur peut arrondir la taille demandée :
    on enregistre ce qui a été produit."""
    try:
        from PIL import Image
        with Image.open(io.BytesIO(data), formats=list(IMAGE_FORMATS)) as im:
            return int(im.width), int(im.height)
    except Exception:                                           # noqa: BLE001
        return fallback


def to_result(raw: Any, fallback: Tuple[int, int], *, seed: Optional[int] = None,
              revised_prompt: str = "") -> ImageResult:
    """Base64 (ou octets) renvoyé par un moteur → :class:`ImageResult` vérifié."""
    data = raw if isinstance(raw, bytes) else decode_b64(raw)
    mime = sniff_mime(data)
    if not mime:
        raise ImageError("Le moteur a renvoyé autre chose qu'une image.", code="engine")
    w, h = image_dims(data, fallback)
    return ImageResult(data=data, mime=mime, width=w, height=h, seed=seed,
                       revised_prompt=revised_prompt)
