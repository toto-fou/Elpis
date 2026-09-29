# SPDX-License-Identifier: MIT
"""
tests/shared_infra/test_pty_lifecycle.py — correctifs PTY (AUDIT 2026-06).

- ``_kill_terminal`` cross-thread : le couple (remove_reader + os.close) est
  différé ENSEMBLE dans le thread de la loop — le close ne précède plus
  jamais le unregister (fenêtre fd-recyclé).
- Cap mémoire par user : au-delà de PTY_MAX_PER_USER, le PTY le plus
  inactif du même user est évincé avant le spawn.
"""
from __future__ import annotations

import asyncio
import os
import sys
import threading
import time

import pytest

pytestmark = pytest.mark.skipif(sys.platform != "linux", reason="PTY = Linux only")

# Piège connu du package routes : son __init__ réexporte les symboles des
# submodules dans son namespace — ``from shared_infra.routes import _pty``
# récupère alors le module STDLIB ``pty`` (importé ``as _pty`` ailleurs).
# Import par nom qualifié via importlib (insensible au shadowing).
import importlib

ptymod = importlib.import_module("shared_infra.terminal.pty")


# ──────────────────────────────────────────────────────────────────────────
# _kill_terminal — ordre remove_reader → close en cross-thread
# ──────────────────────────────────────────────────────────────────────────

def _make_state(fd, loop, pid=2**30):
    # pid par défaut = inexistant (> pid_max) : surtout PAS 0 — _kill_terminal
    # fait os.kill(pid, 9) et kill(0) signalerait TOUT le groupe (pytest
    # compris). ProcessLookupError/OverflowError sont avalés par le except.
    return {
        "master_fd": fd, "pid": pid, "alive": True,
        "lock": threading.Lock(), "last_io": time.time(),
        "_loop": loop, "uid": 1, "sid": "deadbeef",
    }


def test_kill_terminal_cross_thread_unregisters_before_close():
    """Loop dans un AUTRE thread : remove_reader doit s'exécuter avant
    os.close, tous deux dans le thread de la loop."""
    r_fd, w_fd = os.pipe()
    events = []  # (étape, thread_ident)

    loop = asyncio.new_event_loop()
    t = threading.Thread(target=loop.run_forever, daemon=True)
    t.start()
    try:
        # Enregistre un reader depuis le thread de la loop.
        def _register():
            loop.add_reader(r_fd, lambda: None)
        asyncio.run_coroutine_threadsafe(asyncio.sleep(0), loop).result(2)
        loop.call_soon_threadsafe(_register)
        time.sleep(0.05)

        # Spy : trace l'ordre réel remove_reader / close.
        orig_remove = loop.remove_reader
        orig_close = os.close

        def spy_remove(fd):
            events.append(("remove", threading.get_ident()))
            return orig_remove(fd)

        def spy_close(fd):
            if fd == r_fd:
                events.append(("close", threading.get_ident()))
            return orig_close(fd)

        loop.remove_reader = spy_remove
        try:
            ptymod.os.close = spy_close
            state = _make_state(r_fd, loop)
            ptymod._kill_terminal(state)   # appelé depuis CE thread (≠ loop)
            time.sleep(0.2)                # laisse le call_soon_threadsafe tourner
        finally:
            ptymod.os.close = orig_close
            loop.remove_reader = orig_remove

        steps = [e[0] for e in events]
        assert steps == ["remove", "close"], f"ordre observé : {steps}"
        # Les deux étapes dans le THREAD DE LA LOOP (pas le thread appelant)
        loop_thread_ids = {e[1] for e in events}
        assert loop_thread_ids == {t.ident}
        assert state["alive"] is False
    finally:
        loop.call_soon_threadsafe(loop.stop)
        t.join(timeout=2)
        loop.close()
        try:
            os.close(w_fd)
        except OSError:
            pass


def test_kill_terminal_no_loop_closes_directly():
    r_fd, w_fd = os.pipe()
    state = _make_state(r_fd, loop=None)
    ptymod._kill_terminal(state)
    with pytest.raises(OSError):
        os.fstat(r_fd)   # bien fermé
    os.close(w_fd)


def test_kill_terminal_dead_loop_falls_back_to_direct_close():
    r_fd, w_fd = os.pipe()
    loop = asyncio.new_event_loop()
    loop.close()   # loop morte → call_soon_threadsafe lève → fallback direct
    state = _make_state(r_fd, loop)
    ptymod._kill_terminal(state)
    with pytest.raises(OSError):
        os.fstat(r_fd)
    os.close(w_fd)


# ──────────────────────────────────────────────────────────────────────────
# Cap par user — éviction douce du plus vieux
# ──────────────────────────────────────────────────────────────────────────

def test_user_cap_evicts_oldest(monkeypatch):
    monkeypatch.setattr(ptymod, "PTY_MAX_PER_USER", 3)
    killed = []
    monkeypatch.setattr(ptymod, "_kill_terminal", lambda st: killed.append(st["sid"]))
    # waitpid sur les fakes : "toujours vivant"
    monkeypatch.setattr(ptymod.os, "waitpid", lambda pid, flags: (0, 0))
    monkeypatch.setattr(ptymod, "_spawn_terminal",
                        lambda uid, sid: {"pid": 999, "sid": sid, "uid": uid,
                                          "alive": True, "last_io": time.time()})

    fakes = {}
    for i, sid in enumerate(["s1", "s2", "s3"]):
        fakes[(1, sid)] = {"pid": 100 + i, "sid": sid, "uid": 1, "alive": True,
                           "last_io": float(i)}   # s1 = le plus vieux
    # Un PTY d'un AUTRE user ne doit pas compter ni être évincé.
    fakes[(2, "zz")] = {"pid": 200, "sid": "zz", "uid": 2, "alive": True, "last_io": 0.0}
    monkeypatch.setattr(ptymod, "_terminals", dict(fakes))

    st = ptymod._get_or_create_terminal(1, "s4")
    assert st["sid"] == "s4"
    assert killed == ["s1"], "le plus inactif du MÊME user est évincé"
    assert (2, "zz") in ptymod._terminals, "l'autre user n'est pas touché"
    assert (1, "s1") not in ptymod._terminals
