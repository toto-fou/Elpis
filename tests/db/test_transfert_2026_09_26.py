# SPDX-License-Identifier: MIT
"""Transfert entre moteurs (``shared_infra/db/transfer.py``, lot D).

* toujours : SQLite → SQLite (deux fichiers), cibles, conversions, refus ;
* avec ``ELPIS_TEST_PG`` / ``ELPIS_TEST_MARIADB`` / ``ELPIS_TEST_MYSQL``
  (cf. ``test_moteurs_serveur_2026_09_26.py``) : aller-retour SQLite → serveur
  → SQLite, chaque serveur dans un schéma / une base jetable.
"""
import os
import sqlite3
import uuid

import pytest

from shared_infra.db import _schema
from shared_infra.db import transfer as T


def _source(path):
    """Base SQLite complète, au bout de sa chaîne, SANS passer par le pool
    (la suite peut tourner sur un autre moteur)."""
    from shared_infra.db._migrations import _discover, stamp_baseline
    conn = T.connect({"backend": "sqlite", "path": str(path)})
    conn.execute("BEGIN")
    _schema.create_all(conn)
    conn.execute("COMMIT")
    stamp_baseline(conn, _discover())
    conn.execute("BEGIN")
    conn.execute("INSERT INTO users(id, username, pass_salt, pass_hash, created_at) "
                 "VALUES(1, 'alice', 's', 'h', 1.0)")
    conn.execute("INSERT INTO chats(id, user_id, title, messages_json, updated_at, archived) "
                 "VALUES('c1', 1, 'Réunion ’budget’', '[]', 2.5, 0)")
    # Orphelin : SQLite sans contrainte active l'accepte, la cible non.
    conn.execute("INSERT INTO chats(id, user_id, title, messages_json, updated_at, archived) "
                 "VALUES('perdu', 99, 'x', '[]', 1, 0)")
    for i in range(2500):                         # > une page de lecture
        conn.execute("INSERT INTO metric_events(event_type, value, tags_json, created_at) "
                     "VALUES('tok', ?, '{}', ?)", (i, 1000.0 + i))
    # Enfant d'id INFÉRIEUR à son parent : l'ordre de copie doit s'adapter.
    conn.execute("INSERT INTO ax_nodes(id, site, path, parent_id, node_type, role, name, node_key) "
                 "VALUES(2, 's', 'r', NULL, 'n', 'window', 'w', 'k2')")
    conn.execute("INSERT INTO ax_nodes(id, site, path, parent_id, node_type, role, name, node_key) "
                 "VALUES(1, 's', 'r/b', 2, 'n', 'button', 'b', 'k1')")
    conn.execute("INSERT INTO session_messages(user_id, app, session_id, role, content, ts) "
                 "VALUES(1, 'chat', 'c1', 'user', 'voir notes/plan.md', 3.0)")
    conn.execute("CREATE TABLE wf_vestige(x)")
    conn.execute("INSERT INTO wf_vestige VALUES(1)")
    conn.execute("COMMIT")
    conn.close()
    return {"backend": "sqlite", "path": str(path)}


def _verifie(report):
    assert report["ok"], report
    assert report["orphans"] == 1 and report["tables"]["chats"]["orphans"] == 1
    assert report["ignored"] == {"wf_vestige": 1}
    assert report["tables"]["metric_events"]["target"] == 2500


def _relit(path):
    c = sqlite3.connect(str(path))
    try:
        assert c.execute("SELECT title FROM chats").fetchall() == [("Réunion ’budget’",)]
        assert c.execute("SELECT COUNT(*) FROM metric_events").fetchone()[0] == 2500
        assert c.execute("SELECT id, parent_id FROM ax_nodes ORDER BY id").fetchall() == [(1, 2), (2, None)]
        # Plein texte reconstruit, identités recalées.
        assert c.execute("SELECT COUNT(*) FROM session_messages_fts "
                         "WHERE session_messages_fts MATCH '\"plan.md\"'").fetchone()[0] == 1
        c.execute("INSERT INTO metric_events(event_type, value, tags_json, created_at) VALUES('x', 0, '{}', 0)")
        assert c.execute("SELECT MAX(id) FROM metric_events").fetchone()[0] == 2501
        n = c.execute("SELECT COUNT(*) FROM schema_migrations").fetchone()[0]
        from shared_infra.db._migrations import _discover
        assert n >= len(_discover())
    finally:
        c.close()


def test_sqlite_vers_sqlite(tmp_path):
    src = _source(tmp_path / "a.db")
    dst = {"backend": "sqlite", "path": str(tmp_path / "b.db")}
    _verifie(T.transfer(src, dst))
    _relit(tmp_path / "b.db")


def test_simulation_n_ecrit_rien(tmp_path):
    src = _source(tmp_path / "a.db")
    r = T.transfer(src, {"backend": "sqlite", "path": str(tmp_path / "b.db")}, dry_run=True)
    assert r["ok"] and r["tables"]["metric_events"]["source"] == 2500
    c = sqlite3.connect(str(tmp_path / "b.db"))
    assert c.execute("SELECT COUNT(*) FROM sqlite_master").fetchone()[0] == 0
    c.close()


def test_refus_cible_non_vide_ou_source_en_retard(tmp_path):
    src = _source(tmp_path / "a.db")
    with pytest.raises(T.TransferError, match="non vide"):
        T.transfer(src, _source(tmp_path / "c.db"))
    c = sqlite3.connect(str(tmp_path / "a.db"))
    c.execute("DELETE FROM schema_migrations WHERE name = (SELECT MAX(name) FROM schema_migrations)")
    c.commit()
    c.close()
    with pytest.raises(T.TransferError, match="pas à jour"):
        T.transfer(src, {"backend": "sqlite", "path": str(tmp_path / "d.db")})
    with pytest.raises(T.TransferError, match="identiques"):
        T.transfer(src, dict(src))


def test_cibles_textuelles():
    assert T.parse_target("sqlite:/srv/app.db") == {"backend": "sqlite", "path": "/srv/app.db"}
    t = T.parse_target("postgresql://elpis@db.local/prod?tls=verify", password="x")
    assert (t["backend"], t["host"], t["port"], t["name"], t["tls"], t["password"]) == (
        "postgres", "db.local", 5432, "prod", "verify", "x")
    assert T.parse_target("mariadb://root@h:3307/e")["port"] == 3307
    assert "x" not in T.describe(t)                  # jamais de mot de passe
    with pytest.raises(ValueError):
        T.parse_target("oracle://h/x")


@pytest.mark.parametrize("v,kind,attendu", [
    ("12", "int", 12), (3.0, "int", 3), ("4.0", "int", 4), (True, "int", 1),
    ("1.5", "real", 1.5), (7, "real", 7.0), (b"ab", "text", "ab"), (5, "text", "5"),
    (None, "int", None),
])
def test_conversions(v, kind, attendu):
    out = T._coerce(v, kind)
    assert out == attendu and type(out) is type(attendu)


def test_conversion_impossible_rejetee():
    with pytest.raises(ValueError):
        T._coerce("abc", "int")


# ── Serveurs réels ───────────────────────────────────────────────────────────

def _serveurs():
    out = []
    for var, backend in (("ELPIS_TEST_PG", "postgres"), ("ELPIS_TEST_MARIADB", "mysql"),
                         ("ELPIS_TEST_MYSQL", "mysql")):
        v = os.environ.get(var)
        if v:
            host, port, name, user, password = v.split(":", 4)
            out.append(pytest.param(dict(backend=backend, host=host, port=int(port), name=name,
                                         user=user, password=password, tls="off",
                                         timeout=30, schema=None), id=var))
    return out or [pytest.param(None, marks=pytest.mark.skip("aucun serveur de test fourni"))]


@pytest.fixture(params=_serveurs())
def serveur(request):
    from shared_infra.db._connection import connect_server
    base = request.param
    sch = "x_" + uuid.uuid4().hex[:12]
    admin = connect_server(base)
    admin.execute(f'CREATE SCHEMA "{sch}"' if base["backend"] == "postgres"
                  else f'CREATE DATABASE "{sch}" CHARACTER SET utf8mb4 COLLATE utf8mb4_bin')
    try:
        yield dict(base, schema=sch)
    finally:
        admin.execute(f'DROP SCHEMA "{sch}" CASCADE' if base["backend"] == "postgres"
                      else f'DROP DATABASE "{sch}"')
        admin.hard_close()


def test_aller_retour_par_un_serveur(tmp_path, serveur):
    src = _source(tmp_path / "a.db")
    _verifie(T.transfer(src, serveur))
    assert T.check_target(serveur)["tables"] > 40
    back = {"backend": "sqlite", "path": str(tmp_path / "retour.db")}
    r = T.transfer(serveur, back)
    assert r["ok"] and r["orphans"] == 0, r
    _relit(tmp_path / "retour.db")
