# SPDX-License-Identifier: MIT
"""llm_core.imagegen — clients des moteurs d'images (sd-server, OpenAI-compatible).

Un seul moteur actif, choisi par l'administrateur (``config.json`` ›
``image``, lu par ``shared_infra.image.config``). Points d'entrée :
:func:`llm_core.imagegen.service.build_request` (validation) et
:func:`llm_core.imagegen.service.generate_and_store` (génération + magasin),
communs au tour « Images » du chat et à l'outil ``generate_image``.
"""
from llm_core.imagegen.base import ImageError, ImageRequest, ImageResult

__all__ = ["ImageError", "ImageRequest", "ImageResult"]
