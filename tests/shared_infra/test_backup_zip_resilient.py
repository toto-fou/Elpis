# SPDX-License-Identifier: MIT
"""Backup admin résilient (régression 2026-07-19).

Un backup full/sandboxes plantait en 500 sur le PREMIER fichier illisible
depuis l'hôte (créés dans le container en UID 10001 sans o+r — caches black,
pickles…). _make_backup_zip doit maintenant IGNORER ces fichiers et lister
les ignorés dans backup-warnings.txt à la racine du zip.
"""
import os
import zipfile
from pathlib import Path

import pytest

from shared_infra.routes._helpers import _make_backup_zip


@pytest.fixture
def sandbox_root(tmp_path, monkeypatch):
    import shared_infra.config as cfg
    root = tmp_path / "user_sandboxes"
    (root / "alice" / "work").mkdir(parents=True)
    (root / "alice" / "work" / "ok.txt").write_text("lisible")
    bad = root / "alice" / "work" / "cache.pickle"
    bad.write_text("secret")
    os.chmod(bad, 0o000)                     # illisible pour l'hôte (non-root)
    (root / "alice" / "work" / "dead-link").symlink_to(root / "absent")
    monkeypatch.setattr(cfg, "SANDBOX_DIR", root)
    yield root
    os.chmod(bad, 0o644)                     # cleanup tmp_path


def test_backup_skips_unreadable_and_writes_manifest(sandbox_root):
    if os.geteuid() == 0:
        pytest.skip("root lit tout — chmod 000 inopérant")
    tmp_zip, filename = _make_backup_zip("sandboxes")
    try:
        assert filename.startswith("backup_sandboxes_")
        with zipfile.ZipFile(tmp_zip) as zf:
            names = zf.namelist()
            assert "sandboxes/alice/work/ok.txt" in names
            assert "sandboxes/alice/work/cache.pickle" not in names
            assert "sandboxes/alice/work/dead-link" not in names
            manifest = zf.read("backup-warnings.txt").decode()
            assert "cache.pickle" in manifest
            assert "dead-link" in manifest
    finally:
        Path(tmp_zip).unlink(missing_ok=True)


def test_backup_clean_tree_has_no_manifest(tmp_path, monkeypatch):
    import shared_infra.config as cfg
    root = tmp_path / "user_sandboxes"
    (root / "bob").mkdir(parents=True)
    (root / "bob" / "a.txt").write_text("x")
    monkeypatch.setattr(cfg, "SANDBOX_DIR", root)
    tmp_zip, _ = _make_backup_zip("sandboxes")
    try:
        with zipfile.ZipFile(tmp_zip) as zf:
            names = zf.namelist()
            assert "sandboxes/bob/a.txt" in names
            assert "backup-warnings.txt" not in names
    finally:
        Path(tmp_zip).unlink(missing_ok=True)
