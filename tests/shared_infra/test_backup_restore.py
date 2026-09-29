# SPDX-License-Identifier: MIT
"""Sauvegarde et restauration admin : instantané cohérent, restauration sûre.

Trois défauts corrigés ensemble, parce qu'un aller-retour les teste tous :

* la sauvegarde copiait ``app.db`` octet par octet alors que la base est en
  WAL : les transactions encore dans ``-wal`` manquaient, et la base partait
  en double (``db/`` et ``user_db/``) ;
* la restauration écrivait ``app.db`` à chaud, sous les connexions ouvertes
  des workers ;
* les noms d'entrées du zip n'étaient pas contrôlés : ``user_db/../x``
  écrivait hors du dossier (zip-slip).
"""
import os
import sqlite3
import stat
import zipfile
from pathlib import Path

import pytest

import shared_infra.config as cfg
import shared_infra.routes._helpers as helpers
from shared_infra.routes._helpers import _make_backup_zip
from shared_infra.routes.admin.lifecycle import _restore_from_zip


def _base_wal(path: Path, valeurs) -> sqlite3.Connection:
    """Base en WAL, lignes écrites mais jamais recopiées dans le fichier
    principal : la connexion reste ouverte et l'autocheckpoint est coupé."""
    conn = sqlite3.connect(str(path))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA wal_autocheckpoint=0")
    conn.execute("CREATE TABLE t (x INTEGER)")
    conn.executemany("INSERT INTO t VALUES (?)", [(v,) for v in valeurs])
    conn.commit()
    return conn


def _zip(path: Path, entrees: dict) -> Path:
    with zipfile.ZipFile(path, "w") as zf:
        for nom, contenu in entrees.items():
            zf.writestr(nom, contenu)
    return path


@pytest.fixture
def instance(tmp_path, monkeypatch):
    """Une installation minimale : user_db/app.db, sandboxes, serveurs MCP."""
    root = tmp_path / "projet"
    (root / "user_db").mkdir(parents=True)
    sb = root / "user_sandboxes"
    sb.mkdir()
    mcp = root / "mcp_custom_servers"
    mcp.mkdir()
    db = root / "user_db" / "app.db"
    monkeypatch.setattr(cfg, "DB_PATH", str(db))
    monkeypatch.setattr(cfg, "SANDBOX_DIR", sb)
    monkeypatch.setattr(cfg, "MCP_SERVERS_DIR", mcp)
    monkeypatch.setattr(helpers, "PROJECT_ROOT", root)
    # Installation SQLite, quel que soit le moteur de la suite.
    from shared_infra.db import _connection
    monkeypatch.setattr(_connection, "DB_BACKEND", "sqlite")
    return {"root": root, "db": db, "user_db": root / "user_db",
            "sb": sb, "mcp": mcp}


def _restaurer(inst, zip_path, scope="full"):
    return _restore_from_zip(Path(zip_path), scope, db_path=inst["db"],
                             user_db_dir=inst["user_db"],
                             sandbox_dir=inst["sb"], mcp_dir=inst["mcp"])


# ── Sauvegarde ─────────────────────────────────────────────────────────────

def test_instantane_contient_les_transactions_encore_dans_le_wal(instance):
    vivante = _base_wal(instance["db"], range(50))
    try:
        assert Path(str(instance["db"]) + "-wal").stat().st_size > 0
        zip_path, _ = _make_backup_zip("db")
    finally:
        vivante.close()
    try:
        with zipfile.ZipFile(zip_path) as zf:
            noms = zf.namelist()
            copie = instance["root"] / "copie.db"
            copie.write_bytes(zf.read("db/app.db"))
        # La base ne part plus en double, ni avec ses fichiers annexes.
        assert "db/app.db" in noms
        assert not [n for n in noms if n.startswith("user_db/app.db")]
        c = sqlite3.connect(str(copie))
        try:
            assert c.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            assert c.execute("SELECT count(*) FROM t").fetchone()[0] == 50
            # Instantané autonome : un seul fichier, sans -wal à emporter.
            assert c.execute("PRAGMA journal_mode").fetchone()[0] == "delete"
        finally:
            c.close()
    finally:
        Path(zip_path).unlink(missing_ok=True)


def test_les_autres_fichiers_de_user_db_restent_sauvegardes(instance):
    _base_wal(instance["db"], [1]).close()
    (instance["user_db"] / "avatars").mkdir()
    (instance["user_db"] / "avatars" / "a.png").write_bytes(b"png")
    zip_path, _ = _make_backup_zip("db")
    try:
        with zipfile.ZipFile(zip_path) as zf:
            assert "user_db/avatars/a.png" in zf.namelist()
    finally:
        Path(zip_path).unlink(missing_ok=True)


# ── Restauration ───────────────────────────────────────────────────────────

def test_aller_retour_sauvegarde_puis_restauration(instance, tmp_path):
    _base_wal(instance["db"], range(20)).close()
    zip_path, _ = _make_backup_zip("full")
    try:
        # La base vivante a divergé depuis la sauvegarde.
        c = sqlite3.connect(str(instance["db"]))
        c.execute("DELETE FROM t")
        c.commit()
        c.close()
        restaures, erreurs, base = _restaurer(instance, zip_path)
    finally:
        Path(zip_path).unlink(missing_ok=True)
    assert erreurs == []
    assert base is True
    c = sqlite3.connect(str(instance["db"]))
    try:
        assert c.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert c.execute("SELECT count(*) FROM t").fetchone()[0] == 20
    finally:
        c.close()


def test_restauration_sous_une_connexion_ouverte(instance, tmp_path):
    """Un worker garde sa connexion : il voit la base restaurée à sa requête
    suivante, et la base reste en WAL."""
    worker = _base_wal(instance["db"], [1])
    try:
        source = tmp_path / "source.db"
        s = sqlite3.connect(str(source))
        s.execute("CREATE TABLE t (x INTEGER)")
        s.executemany("INSERT INTO t VALUES (?)", [(i,) for i in range(7)])
        s.commit()
        s.close()
        zip_path = _zip(tmp_path / "b.zip", {"db/app.db": source.read_bytes()})
        restaures, erreurs, base = _restaurer(instance, zip_path, "db")
        assert erreurs == [] and base is True
        assert worker.execute("SELECT count(*) FROM t").fetchone()[0] == 7
        assert worker.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        assert worker.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    finally:
        worker.close()


def test_base_corrompue_refusee_et_base_vivante_intacte(instance, tmp_path):
    _base_wal(instance["db"], [1, 2, 3]).close()
    zip_path = _zip(tmp_path / "b.zip", {"db/app.db": b"pas une base" * 400})
    restaures, erreurs, base = _restaurer(instance, zip_path, "db")
    assert base is False
    assert erreurs and "db/app.db" in erreurs[0]
    c = sqlite3.connect(str(instance["db"]))
    try:
        assert c.execute("SELECT count(*) FROM t").fetchone()[0] == 3
    finally:
        c.close()


def test_la_base_n_est_jamais_ecrasee_par_sa_copie_brute(instance, tmp_path):
    """Les anciennes sauvegardes emportaient aussi ``user_db/app.db`` (+ -wal) :
    ces entrées ne doivent plus jamais écraser le fichier vivant."""
    _base_wal(instance["db"], [1]).close()
    zip_path = _zip(tmp_path / "b.zip", {
        "user_db/app.db": b"x" * 4096,
        "user_db/app.db-wal": b"y" * 64,
        "user_db/notes.txt": b"ok",
    })
    restaures, erreurs, base = _restaurer(instance, zip_path, "db")
    assert base is False
    assert restaures == ["user_db/notes.txt"]
    c = sqlite3.connect(str(instance["db"]))
    try:
        assert c.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    finally:
        c.close()


def test_zip_slip_refuse_dans_chaque_zone(instance, tmp_path):
    zip_path = _zip(tmp_path / "b.zip", {
        "user_db/../evasion_user_db.txt": b"x",
        "sandboxes/../../evasion_sb.txt": b"x",
        "mcp_custom_servers//tmp/evasion_absolue.txt": b"x",
        "sandboxes/alice/ok.txt": b"ok",
    })
    restaures, erreurs, base = _restaurer(instance, zip_path, "full")
    assert restaures == ["sandboxes/alice/ok.txt"]
    assert len(erreurs) == 3
    assert not (instance["root"] / "evasion_user_db.txt").exists()
    assert not (tmp_path / "evasion_sb.txt").exists()
    assert not Path("/tmp/evasion_absolue.txt").exists()
    assert (instance["sb"] / "alice" / "ok.txt").read_bytes() == b"ok"


def test_fichiers_restaures_dans_user_db_prives(instance, tmp_path):
    zip_path = _zip(tmp_path / "b.zip", {"user_db/.encryption_key": b"k" * 44})
    restaures, erreurs, _ = _restaurer(instance, zip_path, "db")
    assert erreurs == []
    mode = stat.S_IMODE(os.stat(instance["user_db"] / ".encryption_key").st_mode)
    assert mode == 0o600


# ── Fichiers propres à l'hôte et moteur serveur (2026-09-27) ────────────────

def test_fichiers_propres_a_l_hote_ni_sauves_ni_restaures(instance):
    conn = _base_wal(instance["db"], [1])
    conn.close()
    ud = instance["user_db"]
    (ud / ".db_password").write_text("secret-local")
    (ud / ".encryption_key").write_text("cle")
    (ud / "app.db.bak-20260927-010203").write_text("vieille base")
    tmp, _ = _make_backup_zip("full")
    try:
        noms = zipfile.ZipFile(tmp).namelist()
    finally:
        os.unlink(tmp)
    assert "user_db/.encryption_key" in noms
    assert "user_db/.db_password" not in noms
    assert not any(".bak-" in n for n in noms)
    z = _zip(instance["root"] / "r.zip", {"user_db/.db_password": "autre-hote",
                                          "user_db/.encryption_key": "cle2"})
    restored, errors, _ = _restaurer(instance, z)
    assert (ud / ".db_password").read_text() == "secret-local"
    assert (ud / ".encryption_key").read_text() == "cle2" and not errors


def test_restauration_de_la_base_refusee_sur_un_serveur(instance, monkeypatch):
    from shared_infra.db import _connection
    monkeypatch.setattr(_connection, "DB_BACKEND", "postgres")
    src = instance["root"] / "src.db"
    _base_wal(src, [7]).close()
    z = _zip(instance["root"] / "r.zip", {"db/app.db": src.read_bytes()})
    restored, errors, replaced = _restaurer(instance, z, scope="db")
    assert not replaced and not restored
    assert errors and "revenir à SQLite" in errors[0]
    assert not instance["db"].exists()


def test_sauvegarde_d_une_base_serveur_passe_par_un_instantane(instance, monkeypatch):
    """Hors SQLite, le zip porte un instantané SQLite produit par le transfert,
    pas l'app.db inactif laissé sur le disque."""
    from shared_infra.db import _connection
    from shared_infra.db import transfer as T
    monkeypatch.setattr(_connection, "DB_BACKEND", "postgres")
    instance["db"].write_text("PÉRIMÉE")
    appels = []

    def faux_transfert(src, dst, **kw):
        appels.append(dst)
        c = sqlite3.connect(dst["path"])
        c.execute("CREATE TABLE t (x)")
        c.commit()
        c.close()
        return {"ok": True}

    monkeypatch.setattr(T, "active_target", lambda: {"backend": "postgres"})
    monkeypatch.setattr(T, "transfer", faux_transfert)
    tmp, _ = _make_backup_zip("db")
    try:
        with zipfile.ZipFile(tmp) as zf:
            data = zf.read("db/app.db")
            noms = zf.namelist()
    finally:
        os.unlink(tmp)
    assert appels and appels[0]["backend"] == "sqlite"
    assert data.startswith(b"SQLite format 3") and "user_db/app.db" not in noms


def test_restauration_des_sandboxes_ne_suit_aucun_lien(instance, tmp_path):
    """Un dossier de sandbox remplacé par un lien ne fait rien écrire ailleurs :
    l'entrée est refusée, le reste restauré."""
    dehors = tmp_path / "dehors"
    dehors.mkdir()
    (instance["sb"] / "alice").mkdir()
    os.symlink(dehors, instance["sb"] / "alice" / "work")
    zip_path = _zip(tmp_path / "b.zip", {
        "sandboxes/alice/work/f.txt": b"x",
        "sandboxes/bob/work/g.txt": b"ok",
    })
    restaures, erreurs, _base = _restaurer(instance, zip_path, "sandboxes")
    assert restaures == ["sandboxes/bob/work/g.txt"] and len(erreurs) == 1
    assert list(dehors.iterdir()) == []
    assert (instance["sb"] / "bob" / "work" / "g.txt").read_bytes() == b"ok"
