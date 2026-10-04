# SPDX-License-Identifier: MIT
"""Reading an image source into something python-pptx can embed, and sizing it.

Slides are a fixed canvas, so *how* an image fills its box is a real decision:
``contain`` never crops and may leave space, ``cover`` fills the box and crops
the overflow. Both are computed here so every caller gets the same answer.
"""

from __future__ import annotations

import io
from dataclasses import dataclass

from PIL import Image

from ..assets import load_bytes
from ..errors import InvalidSpec

#: What PowerPoint embeds directly.
SUPPORTED = {"PNG", "JPEG", "GIF", "BMP", "TIFF", "WMF", "EMF"}


@dataclass
class ResolvedImage:
    stream: io.BytesIO
    width_px: int
    height_px: int

    @property
    def aspect(self) -> float:
        return (self.width_px / self.height_px) if self.height_px else 1.0

    def rewound(self) -> io.BytesIO:
        self.stream.seek(0)
        return self.stream


def resolve_image(source: str) -> ResolvedImage:
    """Return an open stream plus the image's pixel size."""
    if not source or not str(source).strip():
        raise InvalidSpec("An image needs a non-empty 'source'.")
    blob = load_bytes(source, "image")
    return _validate(blob, str(source))


def _validate(blob: bytes, source: str) -> ResolvedImage:
    if not blob:
        raise InvalidSpec(f"Image source {source[:60]!r} produced no data.")
    if blob.lstrip()[:256].lower().startswith((b"<?xml", b"<svg")):
        raise InvalidSpec(
            "SVG images cannot be embedded in a .pptx. Convert to PNG first "
            "(any raster format works: PNG, JPEG, GIF, BMP, TIFF)."
        )
    try:
        with Image.open(io.BytesIO(blob)) as image:
            fmt = (image.format or "").upper()
            width, height = image.size
    except Exception as exc:
        raise InvalidSpec(
            f"Could not read {source[:60]!r} as an image: {exc}. "
            "Supported formats: PNG, JPEG, GIF, BMP, TIFF."
        ) from exc
    if fmt not in SUPPORTED:
        raise InvalidSpec(
            f"Image format {fmt!r} is not supported in .pptx. Convert to PNG or JPEG."
        )
    return ResolvedImage(io.BytesIO(blob), width, height)


def contain(aspect: float, box_w: float, box_h: float) -> tuple[float, float]:
    """Largest size with this aspect ratio that fits entirely inside the box."""
    if aspect <= 0:
        return box_w, box_h
    height = box_w / aspect
    if height <= box_h:
        return box_w, height
    return box_h * aspect, box_h


def cover(aspect: float, box_w: float, box_h: float) -> tuple[float, float]:
    """Smallest size with this aspect ratio that covers the box (overflow is cropped)."""
    if aspect <= 0:
        return box_w, box_h
    height = box_w / aspect
    if height >= box_h:
        return box_w, height
    return box_h * aspect, box_h


def crop_to_box(picture, box_w: int, box_h: int) -> None:
    """Crop a ``cover``-sized picture back to the box, keeping its centre.

    python-pptx crops as a fraction of each edge, so the maths is: how much of
    the picture hangs outside the box, halved, over the picture's own size.
    """
    if picture.width > box_w and picture.width:
        overflow = (picture.width - box_w) / picture.width / 2
        picture.crop_left = overflow
        picture.crop_right = overflow
        picture.width = box_w
    if picture.height > box_h and picture.height:
        overflow = (picture.height - box_h) / picture.height / 2
        picture.crop_top = overflow
        picture.crop_bottom = overflow
        picture.height = box_h
