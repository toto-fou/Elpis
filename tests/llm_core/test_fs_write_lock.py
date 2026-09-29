# SPDX-License-Identifier: MIT
"""tests/llm_core/test_fs_write_lock.py — verrou optimiste flock de
write_file/edit_file (AUDIT 2026-06, calqué sur test_skills_write_lock.py).

Couvre : exclusion cross-process réelle, re-check du sha sous verrou
(_guarded_write), fail-open (désactivé / contention / base absente),
et inactivité totale sans expected_sha256.
"""
from __future__ import annotations

import hashlib
import os
import threading
import time

import pytest

import llm_core.tools.fs_tools as F

fcntl = pytest.importorskip("fcntl")
pytestmark = pytest.mark.skipif(os.name != "posix", reason="flock = POSIX only")


@pytest.fixture()
def locks_base(tmp_path, monkeypatch):
    # Audit éditeur 2026-09-23 (E7) : le verrou des outils fs EST celui de
    # ``shared_infra.sandbox.file_lock`` (commun avec /api/sandbox/save).
    import shared_infra.sandbox.file_lock as FL
    base = tmp_path / ".write_locks"
    monkeypatch.setattr(FL, "_locks_base", lambda: base)
    monkeypatch.setattr(F, "_WRITE_LOCKS_BASE", base)
    monkeypatch.setattr(F, "_FSTOOLS_FLOCK", True)
    return base


def _lockfile_for(p, base):
    return base / (hashlib.sha1(os.path.realpath(str(p)).encode()).hexdigest() + ".lock")


# ──────────────────────────────────────────────────────────────────────────
# _optimistic_write_lock
# ──────────────────────────────────────────────────────────────────────────

def test_lock_acquired_and_released(tmp_path, locks_base):
    target = tmp_path / "f.txt"
    with F._optimistic_write_lock(target, enabled=True) as got:
        assert got is True
        lf = _lockfile_for(target, locks_base)
        assert lf.exists()
        # Un AUTRE fd (= autre worker) est refusé tant qu'on tient le flock
        fd2 = os.open(str(lf), os.O_RDWR)
        try:
            with pytest.raises(BlockingIOError):
                fcntl.flock(fd2, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            os.close(fd2)
    # après le with : le flock est libéré
    fd3 = os.open(str(_lockfile_for(target, locks_base)), os.O_RDWR)
    try:
        fcntl.flock(fd3, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(fd3, fcntl.LOCK_UN)
    finally:
        os.close(fd3)


def test_lock_noop_when_disabled(tmp_path, locks_base, monkeypatch):
    monkeypatch.setattr(F, "_FSTOOLS_FLOCK", False)   # kill switch
    with F._optimistic_write_lock(tmp_path / "f", enabled=True) as got:
        assert got is False
    assert not any(locks_base.glob("*.lock")) if locks_base.exists() else True


def test_lock_noop_without_expected(tmp_path, locks_base):
    with F._optimistic_write_lock(tmp_path / "f", enabled=False) as got:
        assert got is False
    assert not locks_base.exists()    # aucun sidecar créé sans expected_sha256


def test_lock_fail_open_on_contention(tmp_path, locks_base):
    target = tmp_path / "f.txt"
    locks_base.mkdir(parents=True)
    lf = _lockfile_for(target, locks_base)
    holder = os.open(str(lf), os.O_CREAT | os.O_RDWR, 0o644)
    try:
        fcntl.flock(holder, fcntl.LOCK_EX)            # un « autre worker » tient
        t0 = time.monotonic()
        with F._optimistic_write_lock(target, enabled=True, timeout_s=0.2) as got:
            assert got is False                        # fail-open, pas d'exception
        assert time.monotonic() - t0 < 2.0             # borné
    finally:
        os.close(holder)


# ──────────────────────────────────────────────────────────────────────────
# _guarded_write — re-check sous verrou
# ──────────────────────────────────────────────────────────────────────────

def test_guarded_write_detects_concurrent_change(tmp_path, locks_base):
    """Le scénario exact du bug : sha lu AVANT, fichier modifié ENTRE-temps,
    l'écriture doit être refusée au re-check sous verrou."""
    target = tmp_path / "f.txt"
    target.write_text("v1")
    sha_v1 = F._sha256_of_file(target)

    target.write_text("v2-concurrent")               # écriture concurrente

    res = F._guarded_write(tmp_path, target, sha_v1, lambda: target.write_text("v3"))
    assert res is not None                            # err hash_mismatch
    assert target.read_text() == "v2-concurrent"      # rien écrasé


def test_guarded_write_passes_when_unchanged(tmp_path, locks_base):
    target = tmp_path / "f.txt"
    target.write_text("v1")
    sha_v1 = F._sha256_of_file(target)
    res = F._guarded_write(tmp_path, target, sha_v1, lambda: target.write_text("v2"))
    assert res is None
    assert target.read_text() == "v2"


def test_guarded_write_no_expected_still_locks(tmp_path, locks_base):
    """Audit éditeur 2026-09-23 (E7) : le verrou est pris à CHAQUE écriture,
    même sans ``expected_sha256`` (avant : aucun verrou → l'enregistrement de
    l'éditeur et l'écriture de l'agent ne se voyaient pas)."""
    target = tmp_path / "f.txt"
    res = F._guarded_write(tmp_path, target, "", lambda: target.write_text("x"))
    assert res is None
    assert target.read_text() == "x"
    assert _lockfile_for(target, locks_base).exists()


def test_guarded_write_serializes_two_threads(tmp_path, locks_base):
    """Deux écrivains 'optimistes' avec le même sha de départ : exactement
    UN gagne, l'autre reçoit hash_mismatch (avant : les deux gagnaient)."""
    target = tmp_path / "f.txt"
    target.write_text("base")
    sha0 = F._sha256_of_file(target)
    results = []

    def writer(tag):
        def _do():
            time.sleep(0.05)                          # élargit la fenêtre
            target.write_text(f"by-{tag}")
        results.append((tag, F._guarded_write(tmp_path, target, sha0, _do)))

    t1 = threading.Thread(target=writer, args=("a",))
    t2 = threading.Thread(target=writer, args=("b",))
    t1.start(); t2.start(); t1.join(); t2.join()

    winners = [tag for tag, r in results if r is None]
    losers = [tag for tag, r in results if r is not None]
    assert len(winners) == 1 and len(losers) == 1, f"results: {results}"
    assert target.read_text() == f"by-{winners[0]}"
