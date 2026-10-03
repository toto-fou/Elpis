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
    from tests.conftest import sandboxes_sur_agent
    sandboxes_sur_agent(monkeypatch, sb, ["alice"])          # /work lu par l'agent
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


@pytest.fixture
def instance(tmp_path, monkeypatch):
    """Base SQLite, user_db (journaux et PID compris), sandboxes vides."""
    import sqlite3

    from shared_infra import config
    from shared_infra.routes import _helpers as H
    root = tmp_path / "projet"
    (root / "user_db" / "logs").mkdir(parents=True)
    (root / "user_db" / "run").mkdir()
    (root / "user_db" / "logs" / "app.log").write_text("journal")
    (root / "user_db" / "run" / "main.pid").write_text("123")
    (root / "user_db" / "cle.txt").write_text("k")
    db = root / "user_db" / "app.db"
    sqlite3.connect(str(db)).execute("CREATE TABLE t (x)").connection.commit()
    monkeypatch.setattr(config, "DB_PATH", str(db))
    monkeypatch.setattr(config, "SANDBOX_DIR", root / "sb")
    monkeypatch.setattr(config, "MCP_SERVERS_DIR", root / "mcp")
    monkeypatch.setattr(H, "PROJECT_ROOT", root)
    from shared_infra.db import _connection
    monkeypatch.setattr(_connection, "DB_BACKEND", "sqlite")
    return root


def test_ni_journaux_ni_pid_dans_l_archive(instance, tmp_path, capsys):
    from shared_infra.ops import backup_cli
    assert backup_cli.main(["db", "--dest", str(tmp_path / "b")]) == 0
    with zipfile.ZipFile(Path(capsys.readouterr().out.strip())) as z:
        noms = z.namelist()
    assert "db/app.db" in noms and "user_db/cle.txt" in noms
    assert not any(n.startswith(("user_db/logs/", "user_db/run/")) for n in noms)


def test_sans_la_base_la_sauvegarde_echoue(instance, tmp_path, monkeypatch, capsys):
    import sqlite3

    from shared_infra.ops import backup_cli
    from shared_infra.routes import _helpers as H
    notes = []
    monkeypatch.setattr(H, "_snapshot_sqlite", lambda *a: (_ for _ in ()).throw(sqlite3.Error("abîmée")))
    import shared_infra.db as D
    monkeypatch.setattr(D, "log_metric", lambda *a, **k: notes.append(a))
    assert backup_cli.main(["full", "--dest", str(tmp_path / "b")]) == 1
    assert "la base n'y est pas" in capsys.readouterr().err
    assert notes == []                        # pas comptée comme sauvegarde récente


def test_dossier_existant_garde_ses_droits_et_rien_ne_traine(instance, tmp_path, monkeypatch):
    from shared_infra.ops import backup_cli
    from shared_infra.routes import _helpers as H
    partage = tmp_path / "partage"
    partage.mkdir()
    partage.chmod(0o775)
    assert backup_cli.main(["db", "--dest", str(partage)]) == 0
    assert stat.S_IMODE(partage.stat().st_mode) == 0o775
    monkeypatch.setattr(H, "_build_backup_zip", lambda *a: (_ for _ in ()).throw(OSError("disque plein")))
    avant = set(partage.iterdir())
    with pytest.raises(OSError):
        backup_cli.main(["db", "--dest", str(partage)])
    assert set(partage.iterdir()) == avant     # temporaire retiré


def test_restauration_ignore_les_dossiers_d_execution(tmp_path):
    from shared_infra.routes.admin.lifecycle import _restore_from_zip
    z = tmp_path / "a.zip"
    with zipfile.ZipFile(z, "w") as zf:
        zf.writestr("user_db/run/main.pid", "999")
        zf.writestr("user_db/logs/app.log", "x")
        zf.writestr("user_db/cle.txt", "k")
    user_db = tmp_path / "user_db"
    restaures, erreurs, _ = _restore_from_zip(z, "full", db_path=user_db / "app.db", user_db_dir=user_db,
                                              sandbox_dir=tmp_path / "sb", mcp_dir=tmp_path / "mcp")
    assert restaures == ["user_db/cle.txt"] and not erreurs
    assert not (user_db / "run").exists()


def test_skills_personnels_sauvegardes_et_restaures(instance, tmp_path, monkeypatch, capsys):
    from shared_infra import config
    from shared_infra.ops import backup_cli
    from shared_infra.routes.admin.lifecycle import _restore_from_zip
    skills = tmp_path / "user_skills"
    (skills / "alice" / "rapport").mkdir(parents=True)
    (skills / "alice" / "rapport" / "SKILL.md").write_text("# Rapport")
    monkeypatch.setattr(config, "USER_SKILLS_DIR", skills)
    monkeypatch.setattr(config, "SKINS_DIR", tmp_path / "user_skins")
    assert backup_cli.main(["full", "--dest", str(tmp_path / "b")]) == 0
    archive = Path(capsys.readouterr().out.strip())
    with zipfile.ZipFile(archive) as z:
        assert "user_skills/alice/rapport/SKILL.md" in z.namelist()
    (skills / "alice" / "rapport" / "SKILL.md").unlink()
    _restore_from_zip(archive, "full", db_path=tmp_path / "ailleurs.db", user_db_dir=tmp_path / "udb",
                      sandbox_dir=tmp_path / "sb2", mcp_dir=tmp_path / "mcp2")
    assert (skills / "alice" / "rapport" / "SKILL.md").read_text() == "# Rapport"


def test_images_generees_hors_de_user_db_sauvegardees_et_restaurees(instance, tmp_path,
                                                                   monkeypatch, capsys):
    """Base hors de ``user_db/`` : ses images (à côté d'elle) partent quand
    même dans la sauvegarde, et reviennent à côté de la base."""
    from shared_infra import config
    from shared_infra.db import _connection
    from shared_infra.ops import backup_cli
    from shared_infra.routes.admin.lifecycle import _restore_from_zip
    ailleurs = tmp_path / "donnees"
    (ailleurs / "generated_images" / "1").mkdir(parents=True)
    (ailleurs / "generated_images" / "1" / "a.png").write_bytes(b"png")
    db = ailleurs / "app.db"
    import sqlite3
    sqlite3.connect(str(db)).execute("CREATE TABLE t (x)").connection.commit()
    monkeypatch.setattr(config, "DB_PATH", str(db))
    monkeypatch.setattr(_connection, "DB_PATH", str(db))
    assert backup_cli.main(["db", "--dest", str(tmp_path / "b")]) == 0
    archive = Path(capsys.readouterr().out.strip())
    with zipfile.ZipFile(archive) as z:
        assert "generated_images/1/a.png" in z.namelist()
    cible = tmp_path / "restauree" / "app.db"
    _restore_from_zip(archive, "db", db_path=cible, user_db_dir=tmp_path / "udb",
                      sandbox_dir=tmp_path / "sb2", mcp_dir=tmp_path / "mcp2")
    assert (cible.parent / "generated_images" / "1" / "a.png").read_bytes() == b"png"
