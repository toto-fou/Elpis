# SPDX-License-Identifier: MIT
"""tests/llm_core/test_fs_write_lock.py — verrou optimiste flock de
write_file/edit_file (AUDIT 2026-06, calqué sur test_skills_write_lock.py).

Couvre : exclusion cross-process réelle, précondition sha vérifiée par
l'agent sous le verrou (_ecrire_garde), fail-open (désactivé / contention /
base absente), et inactivité totale sans expected_sha256.
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
# _ecrire_garde — précondition vérifiée par l'agent, sous le verrou partagé
# ──────────────────────────────────────────────────────────────────────────

@pytest.fixture()
def esp(tmp_path, monkeypatch):
    from llm_core.tools._espace import Espace
    base = tmp_path / "sandboxes"
    work = base / "guest" / "work"
    work.mkdir(parents=True)
    monkeypatch.setenv("APP_SANDBOX_DIR", str(base))
    return Espace("guest", work), work


def _ecrire(esp_, work, rel, data, etat, expected=""):
    return F._ecrire_garde(esp_, "guest", work, work / rel, rel, data, etat=etat,
                           expected_sha256=expected)


def test_ecriture_detecte_un_changement_concurrent(esp, locks_base):
    """sha lu AVANT, fichier modifié ENTRE-temps : l'écriture est refusée."""
    esp_, work = esp
    (work / "f.txt").write_text("v1")
    etat = F._actuel(esp_, "f.txt")
    (work / "f.txt").write_text("v2-concurrent")      # écriture concurrente
    r, err = _ecrire(esp_, work, "f.txt", b"v3", etat, expected=etat[2])
    assert r is None and err["error"] == "hash_mismatch"
    assert (work / "f.txt").read_text() == "v2-concurrent"   # rien écrasé


def test_ecriture_passe_si_inchange(esp, locks_base):
    esp_, work = esp
    (work / "f.txt").write_text("v1")
    etat = F._actuel(esp_, "f.txt")
    r, err = _ecrire(esp_, work, "f.txt", b"v2", etat, expected=etat[2])
    assert err is None and (work / "f.txt").read_text() == "v2"


def test_ecriture_sans_expected_prend_le_verrou(esp, locks_base):
    """Audit éditeur 2026-09-23 (E7) : le verrou est pris à CHAQUE écriture,
    même sans ``expected_sha256`` (l'éditeur et l'agent se voient)."""
    esp_, work = esp
    r, err = _ecrire(esp_, work, "f.txt", b"x", ({"kind": "missing"}, None, ""))
    assert err is None and (work / "f.txt").read_text() == "x"
    assert _lockfile_for(work / "f.txt", locks_base).exists()


def test_deux_ecrivains_un_seul_gagne(esp, locks_base):
    """Deux écrivains 'optimistes' avec le même sha de départ : exactement
    UN gagne, l'autre reçoit hash_mismatch."""
    esp_, work = esp
    (work / "f.txt").write_text("base")
    etat = F._actuel(esp_, "f.txt")
    results = []

    def writer(tag):
        results.append((tag, _ecrire(esp_, work, "f.txt", f"by-{tag}".encode(), etat,
                                     expected=etat[2])[1]))

    t1 = threading.Thread(target=writer, args=("a",))
    t2 = threading.Thread(target=writer, args=("b",))
    t1.start(); t2.start(); t1.join(); t2.join()

    winners = [tag for tag, e in results if e is None]
    losers = [tag for tag, e in results if e is not None]
    assert len(winners) == 1 and len(losers) == 1, f"results: {results}"
    assert (work / "f.txt").read_text() == f"by-{winners[0]}"
