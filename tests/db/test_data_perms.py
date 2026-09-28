# SPDX-License-Identifier: MIT
"""La base et ``user_db/`` sont fermés aux autres comptes locaux.

Les fichiers naissaient avec l'umask du lanceur (0002 sur un shell Debian) :
``app.db`` restait lisible par tout compte local. Le démarrage resserre les
droits avant la première connexion.
"""
import os
import stat

import shared_infra.db._connection as conn
import pytest

# Droits des fichiers de la base SQLite.
pytestmark = pytest.mark.sqlite_only


def _mode(p):
    return stat.S_IMODE(os.stat(p).st_mode)


def test_base_annexes_et_dossier_resserres(tmp_path, monkeypatch):
    user_db = tmp_path / "user_db"
    user_db.mkdir()
    os.chmod(user_db, 0o775)
    db = user_db / "app.db"
    for f in (db, user_db / "app.db-wal", user_db / "app.db-shm"):
        f.write_bytes(b"")
        os.chmod(f, 0o664)
    monkeypatch.setattr(conn, "_PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(conn, "DB_PATH", str(db))

    conn._harden_data_perms()

    assert _mode(user_db) == 0o700
    assert _mode(db) == 0o600
    assert _mode(user_db / "app.db-wal") == 0o600
    assert _mode(user_db / "app.db-shm") == 0o600


def test_dossier_quelconque_jamais_touche(tmp_path, monkeypatch):
    """Une base déplacée ailleurs (tmp de test, chemin personnalisé) : seul
    son fichier est resserré, jamais le dossier qui la contient."""
    ailleurs = tmp_path / "ailleurs"
    ailleurs.mkdir()
    os.chmod(ailleurs, 0o775)
    db = ailleurs / "app.db"
    db.write_bytes(b"")
    os.chmod(db, 0o644)
    monkeypatch.setattr(conn, "_PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(conn, "DB_PATH", str(db))

    conn._harden_data_perms()

    assert _mode(ailleurs) == 0o775
    assert _mode(db) == 0o600


def test_droits_deja_stricts_inchanges(tmp_path, monkeypatch):
    user_db = tmp_path / "user_db"
    user_db.mkdir(mode=0o700)
    db = user_db / "app.db"
    db.write_bytes(b"")
    os.chmod(db, 0o600)
    monkeypatch.setattr(conn, "_PROJECT_ROOT", tmp_path)
    monkeypatch.setattr(conn, "DB_PATH", str(db))

    conn._harden_data_perms()          # base absente ou déjà stricte : sans effet

    assert _mode(user_db) == 0o700
    assert _mode(db) == 0o600
