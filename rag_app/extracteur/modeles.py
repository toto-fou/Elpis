# SPDX-License-Identifier: MIT
# rag_app/extracteur/modeles.py — corps de requête des routes /api/extract, /api/render et /api/locate.
from __future__ import annotations

from pydantic import BaseModel, Field


class ServiceOcrIn(BaseModel):
    url: str = Field(min_length=8, max_length=2048, pattern=r"^https?://[^\s]+$")
    model: str = Field(default="", max_length=256)
    api_key: str = Field(default="", max_length=4096)
    timeout_s: int = Field(default=180, ge=5, le=3600)
    max_side_px: int = Field(default=1280, ge=256, le=4096)
    max_tokens: int = Field(default=8192, ge=256, le=65536)


class ExtraireIn(BaseModel):
    source: str = Field(max_length=1024)
    ext: str = Field(max_length=16)
    ocr: bool = False
    max_chars: int | None = Field(default=None, ge=1)
    ocr_service: ServiceOcrIn | None = None


class RendreIn(BaseModel):
    source: str = Field(max_length=1024)
    ext: str = Field(max_length=16)
    page: int = Field(ge=1)
    dpi: int = Field(default=110, ge=36, le=300)


class LocaliserIn(BaseModel):
    source: str = Field(max_length=1024)
    ext: str = Field(max_length=16)
    text: str = Field(min_length=1, max_length=20000)
    page_hint: int | None = Field(default=None, ge=1)
