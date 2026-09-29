# SPDX-License-Identifier: MIT
"""Adaptateurs PostgreSQL (pg8000) et MariaDB/MySQL (PyMySQL) — lot B.

Deux niveaux :

* tests UNITAIRES, toujours exécutés : traduction MySQL (placeholders, ``%``,
  upserts), lignes façon ``sqlite3.Row``, découpage de scripts, conversion
  des valeurs ;
* tests d'INTÉGRATION contre de vrais serveurs, activés par les variables
  ``ELPIS_TEST_PG`` / ``ELPIS_TEST_MARIADB`` / ``ELPIS_TEST_MYSQL`` au format
  ``hôte:port:base:utilisateur:mot_de_passe`` (conteneurs jetables, cf.
  ``docs/base-de-donnees-multi-moteurs-design-2026-09-26.md``). Chaque test
  travaille dans un schéma / une base à lui, supprimé à la fin.
"""
import decimal
import os
import sqlite3
import uuid

import pytest

from shared_infra.db import _dialect as D
from shared_infra.db import _mysql as M
from shared_infra.db import _server as S


# ── Unitaires ────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("sql,params,attendu", [
    ("SELECT * FROM t WHERE a=? AND b=?", True, "SELECT * FROM t WHERE a=%s AND b=%s"),
    ("SELECT '?' , x FROM t WHERE y=?", True, "SELECT '?' , x FROM t WHERE y=%s"),
    ("SELECT x FROM t WHERE y LIKE '%a%' AND z=?", True, "SELECT x FROM t WHERE y LIKE '%%a%%' AND z=%s"),
    ("SELECT x FROM t WHERE y LIKE '%a%'", False, "SELECT x FROM t WHERE y LIKE '%a%'"),
    ('SELECT "key" FROM code_meta WHERE "key"=? -- un ? ici', True,
     'SELECT "key" FROM code_meta WHERE "key"=%s -- un ? ici'),
])
def test_placeholders_mysql(sql, params, attendu):
    assert M.translate(sql, params, "mariadb").sql == attendu


def test_upsert_mysql_mariadb_et_mysql():
    sql = ("INSERT INTO t(a, b) VALUES(?, ?) ON CONFLICT(a) DO UPDATE SET "
           "b=excluded.b, n=n+1")
    assert M.translate(sql, True, "mariadb").sql == (
        "INSERT INTO t(a, b) VALUES(%s, %s) ON DUPLICATE KEY UPDATE b=VALUES(b), n=n+1")
    assert M.translate(sql, True, "mysql").sql == (
        "INSERT INTO t(a, b) VALUES(%s, %s) AS new ON DUPLICATE KEY UPDATE b=new.b, n=n+1")


def test_do_nothing_devient_insert_simple():
    plan = M.translate("INSERT INTO t(a) VALUES(?) ON CONFLICT(a) DO NOTHING", True, "mysql")
    assert plan.do_nothing and plan.sql == "INSERT INTO t(a) VALUES(%s)"
    assert M.translate("INSERT INTO t(a) VALUES(?) ON CONFLICT DO NOTHING", True, "mysql").do_nothing


def test_upsert_avec_where_refuse():
    with pytest.raises(sqlite3.ProgrammingError):
        M.translate("INSERT INTO t(a) VALUES(?) ON CONFLICT(a) DO UPDATE SET b=excluded.b "
                    "WHERE t.u = excluded.u", True, "mysql")


def test_ligne_facon_sqlite_row():
    cls = S.row_class(("id", "Name"))
    r = cls((1, "x"))
    assert r[0] == 1 and r["id"] == 1 and r["name"] == "x" and r["NAME"] == "x"
    assert dict(r) == {"id": 1, "Name": "x"} and r.keys() == ["id", "Name"]
    a, b = r
    assert (a, b) == (1, "x")
    with pytest.raises(IndexError):
        r["absente"]


def test_conversions_de_valeurs():
    assert S.to_python(decimal.Decimal("12")) == 12 and isinstance(S.to_python(decimal.Decimal("12")), int)
    assert S.to_python(decimal.Decimal("1.5")) == 1.5
    assert S.to_python(True) == 1
    assert S.adapt_params((True, "a\x00b"), strip_nul=True) == (1, "ab")


def test_decoupage_de_script():
    assert S.split_statements("CREATE TABLE a(x TEXT DEFAULT ';'); -- ; commentaire\nSELECT 1;") == [
        "CREATE TABLE a(x TEXT DEFAULT ';')", "-- ; commentaire\nSELECT 1"]


def test_erreurs_sous_classes_de_sqlite3():
    assert issubclass(S.ServerIntegrityError, sqlite3.IntegrityError)
    assert issubclass(S.ServerOperationalError, sqlite3.OperationalError)
    assert D.is_missing_table(S.ServerOperationalError("no such table: absente"))


# ── Intégration (serveurs jetables) ──────────────────────────────────────────

def _cibles():
    out = []
    for var, backend in (("ELPIS_TEST_PG", "postgres"), ("ELPIS_TEST_MARIADB", "mysql"),
                         ("ELPIS_TEST_MYSQL", "mysql")):
        v = os.environ.get(var)
        if v:
            host, port, name, user, password = v.split(":", 4)
            out.append(pytest.param((backend, host, int(port), name, user, password), id=var))
    return out or [pytest.param(None, marks=pytest.mark.skip("aucun serveur de test fourni"))]


@pytest.fixture(params=_cibles())
def conn(request):
    from shared_infra.db import _connection as C
    backend, host, port, name, user, password = request.param
    schema = "t_" + uuid.uuid4().hex[:12]
    base = dict(backend=backend, host=host, port=port, name=name, user=user,
                password=password, tls="off", timeout=30, schema=None)
    admin = C.connect_server(base)
    if backend == "postgres":
        admin.execute(f'CREATE SCHEMA "{schema}"')
    else:
        admin.execute(f'CREATE DATABASE "{schema}" CHARACTER SET utf8mb4 COLLATE utf8mb4_bin')
    c = C.connect_server(dict(base, schema=schema))
    try:
        from shared_infra.db import _schema
        _schema.create_all(c)
        yield c
    finally:
        c.hard_close()
        if backend == "postgres":
            admin.execute(f'DROP SCHEMA "{schema}" CASCADE')
        else:
            admin.execute(f'DROP DATABASE "{schema}"')
        admin.hard_close()


def test_migrations_tamponnees_sur_une_base_serveur_non_vierge(conn):
    """Base serveur NON vierge et sans migration inscrite (premier démarrage
    interrompu après ``create_all``, table étrangère) : les migrations du
    schéma de référence sont tamponnées, jamais rejouées (SQL propre à
    SQLite) — sinon elles échouent à chaque démarrage."""
    from shared_infra.db import _connection as C, _schema
    from shared_infra.db._migrations import _applied
    conn.execute("CREATE TABLE etrangere (x INTEGER)")
    conn.commit()
    C._migrate(conn, fresh=False)
    assert set(_schema.BASELINE_COVERS) <= _applied(conn)


def test_schema_cree_et_introspecte(conn):
    from shared_infra.db import _schema
    noms = set(D.table_names(conn))
    attendues = {t.name for t in _schema.TABLES}
    assert attendues <= noms
    assert D.has_column(conn, "chats", "meta_json")


def test_begin_differe_et_lecture_hors_transaction(conn):
    conn.execute("SELECT COUNT(*) FROM users").fetchone()
    assert not conn.in_transaction, "une lecture ne doit pas ouvrir de transaction"
    conn.execute('INSERT INTO "groups"(name, created_at) VALUES(?, ?)', ("g1", 1.0))
    assert conn.in_transaction
    conn.rollback()
    assert conn.execute('SELECT COUNT(*) FROM "groups"').fetchone()[0] == 0


def test_lecture_en_echec_n_avorte_rien(conn):
    with pytest.raises(sqlite3.OperationalError) as ei:
        conn.execute("SELECT * FROM table_absente")
    assert D.is_missing_table(ei.value)
    conn.execute('INSERT INTO "groups"(name, created_at) VALUES(?, ?)', ("g", 1.0))
    conn.commit()
    assert conn.execute('SELECT name FROM "groups"').fetchone()["name"] == "g"


def test_doublon_integrity_error_et_savepoint(conn):
    conn.execute('INSERT INTO "groups"(name, created_at) VALUES(?, ?)', ("g", 1.0))
    with pytest.raises(sqlite3.IntegrityError):
        with D.savepoint(conn):
            conn.execute('INSERT INTO "groups"(name, created_at) VALUES(?, ?)', ("g", 2.0))
    conn.execute('INSERT INTO "groups"(name, created_at) VALUES(?, ?)', ("h", 3.0))
    conn.commit()
    assert [r[0] for r in conn.execute('SELECT name FROM "groups" ORDER BY name')] == ["g", "h"]


def test_upsert_et_do_nothing_rowcount(conn):
    cur = conn.cursor()
    cur.execute("INSERT INTO editor_webhook_deliveries(delivery_id, routine_id, received_at) "
                "VALUES(?,?,?) ON CONFLICT(delivery_id, routine_id) DO NOTHING", ("d", 1, 1.0))
    assert cur.rowcount == 1
    cur.execute("INSERT INTO editor_webhook_deliveries(delivery_id, routine_id, received_at) "
                "VALUES(?,?,?) ON CONFLICT(delivery_id, routine_id) DO NOTHING", ("d", 1, 2.0))
    assert cur.rowcount == 0
    cur.execute('INSERT INTO code_meta(user_id, "key", value) VALUES(?,?,?) '
                'ON CONFLICT(user_id, "key") DO UPDATE SET value=excluded.value', (0, "k", "a"))
    cur.execute('INSERT INTO code_meta(user_id, "key", value) VALUES(?,?,?) '
                'ON CONFLICT(user_id, "key") DO UPDATE SET value=excluded.value', (0, "k", "b"))
    conn.commit()
    assert conn.execute('SELECT value FROM code_meta WHERE "key"=?', ("k",)).fetchone()[0] == "b"


def test_rowcount_update_lignes_trouvees(conn):
    conn.execute('INSERT INTO "groups"(name, created_at) VALUES(?, ?)', ("g", 1.0))
    cur = conn.execute('UPDATE "groups" SET created_at=? WHERE name=?', (1.0, "g"))
    assert cur.rowcount == 1, "rowcount doit compter les lignes TROUVÉES, comme SQLite"
    conn.rollback()


def test_insert_id_et_verrou_d_ecriture(conn):
    conn.isolation_level = None
    D.begin_write(conn)
    assert conn.in_transaction
    gid = D.insert_id(conn.cursor(), 'INSERT INTO "groups"(name, created_at) VALUES(?, ?)', ("g", 1.0))
    conn.execute("COMMIT")
    assert not conn.in_transaction and gid > 0
    assert conn.execute('SELECT id FROM "groups" WHERE name=?', ("g",)).fetchone()[0] == gid


def test_valeurs_et_types(conn):
    conn.execute("INSERT INTO usage_events(ts, user_id, input_tokens, output_tokens) "
                 "VALUES(?,?,?,?)", (1.5, 1, 10, 5))
    conn.execute("INSERT INTO usage_events(ts, user_id, input_tokens, output_tokens) "
                 "VALUES(?,?,?,?)", (2.5, 1, 20, 5))
    row = conn.execute("SELECT SUM(input_tokens) AS s, AVG(input_tokens) AS a, "
                       f"{D.round_('AVG(ts)', 1, dialect=D.dialect_of(conn))} AS r FROM usage_events").fetchone()
    assert row["s"] == 30 and isinstance(row["s"], int)
    assert row["a"] == 15 and row["r"] == 2.0
    conn.rollback()


def test_plein_texte(conn):
    from shared_infra.db import _schema
    assert _schema.ensure_fts(conn) is True
    conn.execute("INSERT INTO users(username, pass_salt, pass_hash, created_at) VALUES(?,?,?,?)",
                 ("u", "s", "h", 1.0))
    uid = conn.execute("SELECT id FROM users WHERE username='u'").fetchone()[0]
    conn.execute("INSERT INTO session_messages(user_id, app, session_id, role, content, ts) "
                 "VALUES(?,?,?,?,?,?)", (uid, "chat", "c1", "user", "La Réunion Budgétaire", 1.0))
    conn.commit()
    from shared_infra.memory import store as MS
    d = D.dialect_of(conn)
    q = MS._fts_terms(["budgetaire"], d)
    if d == "postgres":
        rows = conn.execute("SELECT session_id FROM session_messages "
                            "WHERE content_tsv @@ websearch_to_tsquery('elpis_simple', ?)", (q,)).fetchall()
    else:
        rows = conn.execute("SELECT session_id FROM session_messages "
                            "WHERE MATCH(content) AGAINST (? IN BOOLEAN MODE)", (q,)).fetchall()
    assert [r[0] for r in rows] == ["c1"]
