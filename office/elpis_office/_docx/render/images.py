# SPDX-License-Identifier: MIT
"""Resolving an image ``source`` into bytes python-docx accepts.

The resolution rules — path confinement, base64 forms, and whether an outbound
fetch is allowed at all — live in ``assets``, so an image, a document and a
template are all subject to exactly the same policy.
"""

from __future__ import annotations

import io

from PIL import Image

from .. import assets
from ..errors import InvalidSpec

#: What python-docx can embed directly.
SUPPORTED = {"PNG", "JPEG", "GIF", "BMP", "TIFF", "WMF", "EMF"}


def resolve_image(source: str) -> tuple[io.BytesIO, tuple[int, int]]:
    """Return an open stream plus the image's pixel size.

    Accepts a filesystem path inside an allowed directory, a ``data:`` URI, or a
    bare base64 payload. An ``http(s)`` URL only works where the operator has
    turned outbound fetching on.
    """
    if not source or not str(source).strip():
        raise InvalidSpec("An image block needs a non-empty 'source'.")
    text = str(source).strip()

    # A small inline PNG is legitimately short, so bare base64 counts from 64
    # characters here rather than the 512 used for documents and templates.
    blob = assets.load_bytes(text, "image", bare_base64_min=64)
    return _validate(blob, text)


def _validate(blob: bytes, source: str) -> tuple[io.BytesIO, tuple[int, int]]:
    if not blob:
        raise InvalidSpec(f"Image source {source[:60]!r} produced no data.")
    if blob.lstrip()[:256].lower().startswith((b"<?xml", b"<svg")):
        raise InvalidSpec(
            "SVG images cannot be embedded in a .docx. Convert to PNG first "
            "(any raster format works: PNG, JPEG, GIF, BMP, TIFF)."
        )
    stream = io.BytesIO(blob)
    try:
        with Image.open(io.BytesIO(blob)) as image:
            fmt = (image.format or "").upper()
            size = image.size
    except Exception as exc:
        raise InvalidSpec(
            f"Could not read {source[:60]!r} as an image: {exc}. "
            "Supported formats: PNG, JPEG, GIF, BMP, TIFF."
        ) from exc
    if fmt not in SUPPORTED:
        raise InvalidSpec(
            f"Image format {fmt!r} is not supported in .docx. Convert to PNG or JPEG."
        )
    stream.seek(0)
    return stream, size


def fit_size(
    pixel_size: tuple[int, int],
    width_cm: float | None,
    height_cm: float | None,
    max_width_cm: float,
) -> tuple[float | None, float | None]:
    """Work out the placement size, preserving aspect ratio and page width.

    Returns ``(width_cm, height_cm)`` with at most one of them set when the
    aspect ratio should drive the other — python-docx does that itself.
    """
    if width_cm and height_cm:
        return float(width_cm), float(height_cm)
    if width_cm:
        return min(float(width_cm), max_width_cm), None
    if height_cm:
        return None, float(height_cm)

    pixels_wide, pixels_high = pixel_size
    if not pixels_wide or not pixels_high:
        return max_width_cm, None
    # 96 dpi is the convention Word assumes for images without explicit metadata.
    natural_cm = pixels_wide / 96 * 2.54
    return min(natural_cm, max_width_cm), None
