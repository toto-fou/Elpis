# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_desktop_memo_bounds.py — bornes des memos desktop (R5).

Les memos vision/a11y sont TTL-gated mais grandissaient sans cap taille (entrées
expirées retenues à vie). ``_memo_put`` borne l'occupation : purge des expirées,
puis éviction des plus vieilles au-delà du cap, en gardant toujours l'entrée
qu'on vient d'écrire.
"""
from __future__ import annotations

import time

from llm_core.tools import desktop_tools as dt


def test_memo_put_caps_size_keeps_recent():
    d = {}
    cap = 8
    now = time.time()
    # Insère 20 entrées non expirées avec ts croissant.
    for i in range(20):
        rec = {"ts": now + i, "elements": [i]}
        dt._memo_put(d, f"k{i}", rec, ttl=100.0, cap=cap)
    assert len(d) <= cap
    # La dernière insérée est TOUJOURS présente.
    assert "k19" in d
    # Les plus vieilles ont été éjectées, les plus récentes conservées.
    assert "k0" not in d and "k1" not in d
    kept = sorted(int(k[1:]) for k in d)
    assert kept[-1] == 19 and all(k >= 20 - cap for k in kept)


def test_memo_put_purges_expired_first():
    d = {}
    cap = 4
    old = time.time() - 1000       # bien au-delà de ttl×4
    # 4 entrées EXPIRÉES.
    for i in range(4):
        d[f"old{i}"] = {"ts": old, "elements": [i]}
    # Une nouvelle entrée fraîche → dépasse le cap → purge des expirées d'abord.
    dt._memo_put(d, "fresh", {"ts": time.time(), "elements": [99]}, ttl=1.0, cap=cap)
    assert "fresh" in d
    assert len(d) <= cap
    # Les expirées ont été balayées en priorité.
    assert not any(k.startswith("old") for k in d)


def test_memo_put_under_cap_is_noop_purge():
    d = {}
    dt._memo_put(d, "a", {"ts": time.time(), "elements": [1]}, ttl=1.0, cap=64)
    dt._memo_put(d, "b", {"ts": time.time(), "elements": [2]}, ttl=1.0, cap=64)
    assert set(d) == {"a", "b"}      # sous le cap → rien n'est purgé


# ── P8 : throttle de prune_frames ─────────────────────────────────────────────
def test_prune_frames_throttled(monkeypatch, tmp_path):
    import llm_core._desktop_session as ds
    monkeypatch.setattr(ds, "DESKTOP_SCREENS_DIR", str(tmp_path))
    scans = {"n": 0}
    real_listdir = ds.os.listdir

    def counting_listdir(p):
        scans["n"] += 1
        return real_listdir(p)
    monkeypatch.setattr(ds.os, "listdir", counting_listdir)

    ds._last_prune_ts = 0.0
    ds._PRUNE_MIN_INTERVAL_S = 9999          # fenêtre large → throttle actif
    ds.prune_frames()                        # 1er appel : scanne
    ds.prune_frames()                        # throttlé
    ds.prune_frames()                        # throttlé
    assert scans["n"] == 1
    ds.prune_frames(force=True)              # force : rescanne
    assert scans["n"] == 2
