# SPDX-License-Identifier: MIT
"""tests/deploy/conftest.py — tmp_ouvert : dossier d'essai traversable par les autres comptes (0711, sous le dossier temporaire du système), pour les dépôts que « service print » doit rendre en un compte par service (sous les dossiers 0700 de pytest, il les juge fermés : repli)."""
from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

import pytest


@pytest.fixture(scope="session")
def _base_ouverte():
    d = Path(tempfile.mkdtemp(prefix="pytest-elpis-deploy-"))
    d.chmod(0o711)
    yield d
    shutil.rmtree(d, ignore_errors=True)


@pytest.fixture
def tmp_ouvert(_base_ouverte):
    d = Path(tempfile.mkdtemp(dir=_base_ouverte))
    d.chmod(0o711)
    return d
