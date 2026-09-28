# SPDX-License-Identifier: MIT
"""tests/rag_app/conftest.py — stubs communs pour importer rag_app.*.

⚠ pdf2docx (→ cv2) est MORTEL à importer dans la VM dev (Bus error natif,
pas une ImportError) : stub INCONDITIONNEL posé avant tout import de
``rag_app.rag_engine``. Les autres dépendances lourdes ne sont stubbées que
si elles manquent dans l'environnement (les fichiers de test historiques
portent les mêmes stubs — les deux couches sont idempotentes).
"""
from __future__ import annotations

import sys
import types


def _stub_always(name: str, **attrs) -> None:
    if name in sys.modules:
        return
    mod = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(mod, k, v)
    sys.modules[name] = mod


def _stub_missing(name: str, **attrs) -> None:
    if name in sys.modules:
        return
    try:
        __import__(name)
    except ImportError:
        mod = types.ModuleType(name)
        for k, v in attrs.items():
            setattr(mod, k, v)
        sys.modules[name] = mod


_stub_always("pdf2docx", Converter=object)
_stub_missing("pandas")
_stub_missing("yaml", safe_load=lambda *a, **k: {}, safe_dump=lambda *a, **k: "")
_stub_missing("charset_normalizer", from_bytes=lambda b: None)
_stub_missing("docx", Document=object)


import pytest


@pytest.fixture(autouse=True)
def _rag_sans_fichier_jeton(monkeypatch, tmp_path):
    """Un ``user_db/.rag_service_token`` réel (généré par ./elpis configure) ne doit
    pas changer le résultat des tests : fichier de jeton absent par défaut."""
    app_mod = sys.modules.get("rag_app.app")
    if app_mod is not None and hasattr(app_mod, "_TOKEN_FILE"):
        monkeypatch.setattr(app_mod, "_TOKEN_FILE", tmp_path / "pas-de-jeton")
