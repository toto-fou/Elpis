# SPDX-License-Identifier: MIT
"""
tests/db/conftest.py — fixtures et bootstrap d'importpath pour les tests DB.

Ajoute la racine du repo à ``sys.path`` afin que ``shared_infra.*`` soit
importable dans cette sous-arbo de tests.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
