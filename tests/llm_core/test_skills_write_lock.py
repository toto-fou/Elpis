# SPDX-License-Identifier: MIT
"""tests/llm_core/test_skills_write_lock.py — verrou skills RLock+flock (E2).

Couvre la réentrance, l'exclusion cross-process réelle (flock advisory), et les
deux garde-fous fail-open (désactivé, contention plafonnée).
"""
from __future__ import annotations

import os
import time

import pytest

from llm_core import skills as S

fcntl = S.fcntl
pytestmark = pytest.mark.skipif(fcntl is None, reason="fcntl absent (non-POSIX)")


def test_reentrant_acquire_release(tmp_path, monkeypatch):
    monkeypatch.setenv("SKILLS_LOCK_PATH", str(tmp_path / "l.lock"))
    lk = S._SkillsWriteLock()
    with lk:
        assert lk._depth == 1
        with lk:                       # ré-acquisition (ne deadlock pas)
            assert lk._depth == 2
        assert lk._depth == 1
    assert lk._depth == 0
    assert lk._fd is None              # flock relâché au retour à 0


def test_real_cross_process_exclusion(tmp_path, monkeypatch):
    """Tant qu'une instance détient le flock, un AUTRE fd (= autre worker) est refusé."""
    lock_path = tmp_path / "l.lock"
    monkeypatch.setenv("SKILLS_LOCK_PATH", str(lock_path))
    lk = S._SkillsWriteLock()
    with lk:
        assert lk._fd is not None      # flock réellement pris
        fd2 = os.open(str(lock_path), os.O_RDWR | os.O_CREAT, 0o600)
        try:
            with pytest.raises(BlockingIOError):
                fcntl.flock(fd2, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            os.close(fd2)
    # après libération : un autre fd peut prendre le lock
    fd3 = os.open(str(lock_path), os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd3, fcntl.LOCK_EX | fcntl.LOCK_NB)   # ne lève pas
        fcntl.flock(fd3, fcntl.LOCK_UN)
    finally:
        os.close(fd3)


def test_failopen_when_disabled(tmp_path, monkeypatch):
    monkeypatch.setenv("SKILLS_FILELOCK", "0")
    monkeypatch.setenv("SKILLS_LOCK_PATH", str(tmp_path / "l.lock"))
    lk = S._SkillsWriteLock()
    with lk:
        assert lk._fd is None          # désactivé → pas de flock, mais pas d'erreur
    assert lk._depth == 0


def test_failopen_on_prolonged_contention(tmp_path, monkeypatch):
    """Contention au-delà du plafond → fail-open borné (jamais de blocage infini)."""
    monkeypatch.setenv("SKILLS_LOCK_PATH", str(tmp_path / "l.lock"))
    monkeypatch.setattr(S, "_FLOCK_TIMEOUT_S", 0.1)
    monkeypatch.setattr(S, "_FLOCK_POLL_S", 0.01)
    a = S._SkillsWriteLock()
    a.acquire()
    try:
        b = S._SkillsWriteLock()       # simule un 2e worker concurrent
        t0 = time.monotonic()
        b.acquire()
        try:
            assert b._fd is None                       # n'a PAS volé le flock
            assert time.monotonic() - t0 >= 0.1        # a bien attendu le plafond
        finally:
            b.release()
    finally:
        a.release()
