# SPDX-License-Identifier: MIT
# tests/rag_app/conftest.py — magasin, cache et jeton de l'extracteur pour les tests, sans dépendre d'un user_db réel.
from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _rag_sans_fichier_jeton(monkeypatch, tmp_path):
    """Un ``user_db/.rag_service_token`` réel ne change pas le résultat des tests : fichier de jeton absent par défaut."""
    monkeypatch.setenv("RAG_SERVICE_TOKEN_FILE", str(tmp_path / "pas-de-jeton"))


@pytest.fixture
def magasin_rag(monkeypatch, tmp_path):
    """Racines RAG_STORE_DIR (le magasin du core) et RAG_CACHE_DIR, plus un jeton de service."""
    store, cache = tmp_path / "store", tmp_path / "cache"
    (store / "sources").mkdir(parents=True)
    monkeypatch.setenv("RAG_STORE_DIR", str(store))
    monkeypatch.setenv("RAG_CACHE_DIR", str(cache))
    monkeypatch.setenv("RAG_SERVICE_TOKEN", "jeton-test")
    return store
