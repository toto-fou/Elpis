# SPDX-License-Identifier: MIT
"""Garde de ``./elpis upgrade`` et fichiers propres à la machine hors des sauvegardes (2026-09-29)."""
from __future__ import annotations

import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_upgrade_refuse_une_option_inconnue():
    r = subprocess.run(["bash", str(ROOT / "elpis"), "upgrade", "--vite"],
                       capture_output=True, text=True, timeout=30)
    assert r.returncode != 0 and "Usage" in r.stderr


