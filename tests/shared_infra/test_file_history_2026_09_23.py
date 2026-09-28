# SPDX-License-Identifier: MIT
"""Historique de session des fichiers (2026-09-23) : original + chaque version."""
import pytest

import shared_infra.sandbox.file_history as H


@pytest.fixture(autouse=True)
def _racine(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_FILE_HISTORY_DIR", str(tmp_path / "hist"))


def test_original_puis_versions():
    H.start_session(1)
    H.record_write(1, "work/a.py", b"v0", b"v1", "editor")
    H.record_write(1, "a.py", b"v1", b"v2", "assistant")
    H.record_write(1, "/a.py", b"v2", b"v2", "assistant")          # identique : ignoré
    e = H.file_entry(1, "./a.py")
    assert H.get_blob(1, e["original"]["sha"]) == b"v0"
    assert [H.get_blob(1, v["sha"]) for v in e["versions"]] == [b"v1", b"v2"]
    assert [v["source"] for v in e["versions"]] == ["editor", "assistant"]
    info = H.session_info(1)
    assert info["files"][0]["path"] == "a.py" and info["files"][0]["versions"] == 2


def test_creation_et_suppression():
    H.start_session(1)
    H.record_write(1, "n.txt", None, b"x", "assistant")
    H.record_write(1, "n.txt", b"x", None, "editor")
    e = H.file_entry(1, "n.txt")
    assert e["original"]["exists"] is False and e["versions"][-1]["exists"] is False
    assert H.session_info(1)["files"][0]["deleted"] is True


def test_nouvelle_session_nouvel_original():
    H.start_session(1)
    H.record_write(1, "a", b"0", b"1")
    H.start_session(1)
    assert H.file_entry(1, "a") is None
    H.record_write(1, "a", b"1", b"2")
    assert H.get_blob(1, H.file_entry(1, "a")["original"]["sha"]) == b"1"


def test_renommage_et_bornes(monkeypatch):
    H.start_session(1)
    H.record_write(1, "d/a", b"0", b"1")
    H.record_move(1, "d", "e")
    assert H.file_entry(1, "e/a") and H.file_entry(1, "d/a") is None
    monkeypatch.setattr(H, "MAX_FILE", 4)
    H.record_write(1, "big", b"12345", b"123456789")
    e = H.file_entry(1, "big")
    assert e["original"].get("too_big") and e["versions"][0].get("too_big")
    assert H.norm_rel("../x") == "" and H.norm_rel("work") == ""


def test_elagage_sessions(tmp_path):
    for _ in range(5):
        H.start_session(2)
        H.record_write(2, "a", b"0", b"1")
    assert len(H._sessions(2)) <= 3


def test_blob_refuse_les_noms_forges():
    assert H.get_blob(1, "../../etc/passwd") is None


def test_premiere_ecriture_sans_session_ne_bloque_pas():
    """Le flock n'est pas réentrant : créer la session sous le verrou ne doit
    pas le reprendre (attente de 5 s avant correction)."""
    import time
    t0 = time.monotonic()
    H.record_write(9, "a", b"0", b"1")
    assert time.monotonic() - t0 < 1.0
    assert H.file_entry(9, "a")
