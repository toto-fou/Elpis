# SPDX-License-Identifier: MIT
"""``./elpis backup`` (shared_infra.ops.backup_cli) et garde de ``./elpis
upgrade`` (2026-09-29)."""
from __future__ import annotations

import stat
import subprocess
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def test_sauvegarde_en_ligne_de_commande(tmp_path, monkeypatch, capsys):
    from shared_infra import config
    from shared_infra.ops import backup_cli
    sb = tmp_path / "sb"
    (sb / "alice" / "work").mkdir(parents=True)
    (sb / "alice" / "work" / "f.txt").write_text("x")
    monkeypatch.setattr(config, "SANDBOX_DIR", sb)
    dest = tmp_path / "backups"
    assert backup_cli.main(["sandboxes", "--dest", str(dest)]) == 0
    archive = Path(capsys.readouterr().out.strip())
    assert archive.parent == dest
    assert stat.S_IMODE(archive.stat().st_mode) == 0o600      # secrets de user_db
    assert stat.S_IMODE(dest.stat().st_mode) == 0o700
    with zipfile.ZipFile(archive) as z:
        assert "sandboxes/alice/work/f.txt" in z.namelist()


def test_portee_inconnue_refusee():
    from shared_infra.ops import backup_cli
    with pytest.raises(SystemExit):
        backup_cli.main(["tout"])


def test_upgrade_refuse_une_option_inconnue():
    r = subprocess.run(["bash", str(ROOT / "elpis"), "upgrade", "--vite"],
                       capture_output=True, text=True, timeout=30)
    assert r.returncode != 0 and "Usage" in r.stderr
