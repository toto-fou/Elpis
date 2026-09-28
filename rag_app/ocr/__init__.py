# SPDX-License-Identifier: MIT
"""rag_app.ocr — feature « Documents » (OCR) hébergée par le service RAG.

Migrée depuis le chatbot (``shared_infra/ocr``) le 2026-07-23, en version
LEAN et MONO-TENANT :

- cœur : upload PDF/.docx → préparation (soffice + pypdfium2) → job OCR page
  par page en streaming → lecture/édition → export Markdown → suppression ;
- file multi-documents (FIFO persistée, pompe séquentielle) ;
- indexation RAG **in-process** (``rag_engine.index_document_chunks``) dans
  la collection unique ``ocr.collection`` (défaut ``ocr-documents``).

Points de contact volontairement minimaux avec le reste de rag_app :
``rag_index`` importe ``rag_engine`` (tardif), ``routes`` expose un
``APIRouter`` inclus par ``app.py``, la config vit dans le bloc ``ocr`` de
``rag_config.json``. Aucune notion d'utilisateur : le service est
mono-tenant (comme le reste de rag_app).

Imports intra-paquet RELATIFS partout : le paquet se résout aussi bien en
``ocr.*`` (service, cwd = rag_app/) qu'en ``rag_app.ocr.*`` (tests).
"""
from ._common import OcrError  # noqa: F401 — exception publique du paquet
