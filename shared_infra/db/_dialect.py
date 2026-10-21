# SPDX-License-Identifier: MIT
"""
shared_infra.db._dialect — ce qui diffère d'un moteur de base à l'autre.

Le code applicatif écrit un SQL commun aux deux moteurs visés — SQLite (par
défaut) et PostgreSQL : placeholders ``?``, ``ON CONFLICT … DO UPDATE``,
``RETURNING``, index partiels. Les rares fragments sans écriture commune
passent par les helpers de ce module, appelés EXPLICITEMENT au site d'appel :
aucune réécriture implicite du SQL, un comportement lisible dans le code qui
l'utilise. En SQLite, chaque helper rend exactement le SQL qui s'écrivait
avant lui.
"""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from typing import Any, Iterator, Optional

SQLITE = "sqlite"
POSTGRES = "postgres"


def backend() -> str:
    """Moteur de la base principale (``shared_infra.config.DB_BACKEND``, relu
    via ``_connection`` que les tests re-pointent)."""
    from shared_infra.db import _connection
    return _connection.DB_BACKEND


def dialect_of(conn: Any) -> str:
    """Dialecte d'une connexion : l'enveloppe PostgreSQL porte un attribut
    ``dialect`` ; une connexion ``sqlite3`` n'en a pas."""
    return getattr(conn, "dialect", SQLITE)


def _dialect(conn: Any = None, dialect: Optional[str] = None) -> str:
    if dialect:
        return dialect
    if conn is not None:
        return dialect_of(conn)
    return backend()


# ─────────────────────────────────────────────────────────────────────────────
#  Transactions
# ─────────────────────────────────────────────────────────────────────────────

def begin_write(conn: Any) -> None:
    """Ouvre une transaction d'écriture exclusive : la lecture qui suit et
    l'écriture qui en dépend sont atomiques face aux autres workers.

    SQLite : ``BEGIN IMMEDIATE`` prend le verrou d'écriture tout de suite
    (la connexion doit être hors transaction : autocommit, ou mode historique
    sans transaction ouverte). La transaction se clôt par ``conn.commit()`` /
    ``conn.rollback()`` (ou le texte ``COMMIT`` / ``ROLLBACK``, que la
    connexion SQLite accepte aussi).

    PostgreSQL : ``BEGIN`` puis ``SELECT … FOR UPDATE`` sur la ligne
    ``write`` de la table ``elpis_locks`` — un verrou de TRANSACTION, relâché
    tout seul au COMMIT/ROLLBACK, même quand l'appelant valide par texte SQL
    (``pg_advisory_lock`` survivrait au COMMIT).
    """
    d = dialect_of(conn)
    if d == SQLITE:
        conn.execute("BEGIN IMMEDIATE")
        return
    if not getattr(conn, "_locks_ready", False):
        # Base dont le schéma n'a pas (encore) été posé par ``create_all`` —
        # typiquement une base de test aux tables créées à la main : la table
        # du verrou est créée et validée ici, avant la transaction d'écriture.
        from shared_infra.db._schema import TABLES_BY_NAME, create_table_sql
        conn.execute(create_table_sql(TABLES_BY_NAME["elpis_locks"], d))
        conn.execute("INSERT INTO elpis_locks(name) VALUES ('write') ON CONFLICT DO NOTHING")
        if conn.in_transaction:
            conn.commit()
        conn._locks_ready = True
    conn.execute("BEGIN")
    conn.execute("SELECT name FROM elpis_locks WHERE name = 'write' FOR UPDATE").fetchone()


@contextmanager
def savepoint(conn: Any, name: str = "sp") -> Iterator[Any]:
    """Point de sauvegarde : une erreur dans le bloc n'annule que le bloc.

    Indispensable autour d'une instruction dont on AVALE l'erreur au milieu
    d'une transaction d'écriture : en PostgreSQL, toute erreur avorte la
    transaction entière et les instructions suivantes échouent. En SQLite, le
    bloc se comporte comme avant.
    """
    conn.execute(f"SAVEPOINT {name}")
    try:
        yield conn
    except BaseException:
        conn.execute(f"ROLLBACK TO SAVEPOINT {name}")
        conn.execute(f"RELEASE SAVEPOINT {name}")
        raise
    conn.execute(f"RELEASE SAVEPOINT {name}")


# ─────────────────────────────────────────────────────────────────────────────
#  Erreurs
# ─────────────────────────────────────────────────────────────────────────────


# ─────────────────────────────────────────────────────────────────────────────
#  Introspection du schéma
# ─────────────────────────────────────────────────────────────────────────────

def _row_value(row: Any, name: str, index: int) -> Any:
    try:
        return row[name]
    except (IndexError, KeyError, TypeError):
        return row[index]


def has_table(conn: Any, table: str) -> bool:
    d = dialect_of(conn)
    if d == SQLITE:
        row = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()
        return row is not None
    return table in table_names(conn)


def table_names(conn: Any) -> list:
    """Tables de l'application (hors tables internes du moteur), triées."""
    d = dialect_of(conn)
    if d == SQLITE:
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall()
    else:
        rows = conn.execute(
            "SELECT table_name AS name FROM information_schema.tables "
            "WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' "
            "ORDER BY table_name").fetchall()
    return [_row_value(r, "name", 0) for r in rows]


def table_columns(conn: Any, table: str) -> list:
    """Noms des colonnes d'une table ([] si la table n'existe pas)."""
    d = dialect_of(conn)
    if d == SQLITE:
        try:
            rows = conn.execute(f'PRAGMA table_info("{table}")').fetchall()
        except sqlite3.Error:
            return []
        return [_row_value(r, "name", 1) for r in rows]
    rows = conn.execute(
        "SELECT column_name AS name FROM information_schema.columns "
        "WHERE table_schema = current_schema() AND table_name = ? ORDER BY ordinal_position",
        (table,)).fetchall()
    return [_row_value(r, "name", 0) for r in rows]


# ─────────────────────────────────────────────────────────────────────────────
#  Fragments SQL sans écriture commune
# ─────────────────────────────────────────────────────────────────────────────

def insert_id(cur: Any, sql: str, params: tuple = ()) -> int:
    """Exécute un INSERT et rend l'id de la ligne créée (colonne ``id``).

    SQLite : ``cursor.lastrowid``. PostgreSQL n'a pas de ``lastrowid`` :
    ``RETURNING id`` est ajouté à l'instruction.
    """
    d = dialect_of(getattr(cur, "connection", None))
    if d == POSTGRES:
        row = cur.execute(sql.rstrip().rstrip(";") + " RETURNING id", params).fetchone()
        return int(row[0]) if row else 0
    cur.execute(sql, params)
    return int(cur.lastrowid or 0)                    # SQLite


def bytes_order(expr: str, dialect: Optional[str] = None) -> str:
    """Clé de tri TEXTE comparée octet par octet, comme SQLite (``BINARY``) :
    l'ordre ne dépend plus de la collation du serveur (un PostgreSQL en
    ``fr_FR``/``en_US.UTF-8`` range « a » avant « B », SQLite l'inverse)."""
    d = _dialect(dialect=dialect)
    if d == POSTGRES:
        return f'{expr} COLLATE "C"'
    return expr


__all__ = [
    "SQLITE", "POSTGRES", "backend", "dialect_of", "begin_write", "savepoint",
    "has_table", "table_names", "table_columns", "insert_id", "bytes_order",
]
