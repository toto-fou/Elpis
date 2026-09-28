# SPDX-License-Identifier: MIT
"""
RAG : la configuration ne change pas pendant une ingestion (2026-09-20).

``save_config`` remplaçait ``engine.cfg`` sans regarder ``_INGEST_LOCK`` ; une
ingestion en cours relisait la nouvelle collection / le nouveau bloc sparse à
son prochain lot et laissait un index incohérent, sans erreur.
"""
from __future__ import annotations

import json

import pytest


def _engine(tmp_path):
    from rag_app import rag_engine as re_
    eng = object.__new__(re_.RAGEngine)          # sans Qdrant ni modèles
    eng.cfg = {"collection": "a", "top_k": "5"}
    eng.config_path = str(tmp_path / "config.json")
    return re_, eng


def test_save_config_ecrit_quand_aucune_ingestion(tmp_path):
    re_, eng = _engine(tmp_path)
    eng.save_config({"collection": "b"})
    assert eng.cfg["collection"] == "b" and eng.cfg["top_k"] == 5
    assert json.loads((tmp_path / "config.json").read_text())["collection"] == "b"
    assert not re_._INGEST_LOCK.locked(), "le verrou est rendu"


def test_save_config_refuse_pendant_une_ingestion(tmp_path):
    re_, eng = _engine(tmp_path)
    assert re_._INGEST_LOCK.acquire(blocking=False)
    try:
        with pytest.raises(re_.IngestionEnCours):
            eng.save_config({"collection": "b"})
        assert eng.cfg["collection"] == "a", "rien n'a bougé"
        assert not (tmp_path / "config.json").exists()
    finally:
        re_._INGEST_LOCK.release()
    eng.save_config({"collection": "c"})          # après l'ingestion : passe
    assert eng.cfg["collection"] == "c"


def test_la_route_repond_409(tmp_path, monkeypatch):
    from rag_app import app as rag_app_mod
    re_, eng = _engine(tmp_path)
    monkeypatch.setattr(rag_app_mod, "engine", eng)
    from fastapi import HTTPException
    assert re_._INGEST_LOCK.acquire(blocking=False)
    try:
        with pytest.raises(HTTPException) as ei:
            rag_app_mod.save_config({"collection": "b"})
        assert ei.value.status_code == 409
    finally:
        re_._INGEST_LOCK.release()
    assert rag_app_mod.save_config({"collection": "b"}) == {"status": "ok",
                                                            "reindex_required": False}


def test_reindexation_et_reset_refuses_pendant_une_ingestion(tmp_path):
    """(2026-09-21, M10) Le verrou ne couvrait que /api/ingest."""
    re_, eng = _engine(tmp_path)
    assert re_._INGEST_LOCK.acquire(blocking=False)
    try:
        for out in (eng.reindex_single_file("a.txt"),
                    eng.reindex_from_chunks("a.txt", ["x"]),
                    eng.purge_database()):
            assert out["ok"] is False and "en cours" in out["msg"]
    finally:
        re_._INGEST_LOCK.release()
