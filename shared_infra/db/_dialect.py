# SPDX-License-Identifier: MIT
"""
shared_infra.db._dialect — ce qui diffère d'un moteur de base à l'autre.

Le code applicatif écrit un SQL commun aux trois moteurs visés — SQLite (par
défaut), PostgreSQL, MariaDB/MySQL : placeholders ``?``, ``ON CONFLICT … DO
UPDATE``, ``RETURNING``, index partiels côté SQLite/PG. Les rares fragments
sans écriture commune passent par les helpers de ce module, appelés
EXPLICITEMENT au site d'appel : aucune réécriture implicite du SQL, un
comportement lisible dans le code qui l'utilise.

Tant que seul SQLite est branché (lot A du chantier multi-moteurs, cf.
``docs/base-de-donnees-multi-moteurs-design-2026-09-26.md``), toutes les
connexions parlent ``sqlite`` et chaque helper rend exactement le SQL qui
s'écrivait avant lui : aucun changement de comportement.
"""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from typing import Any, Iterator, Optional

SQLITE = "sqlite"
POSTGRES = "postgres"
MYSQL = "mysql"
BACKENDS = (SQLITE, POSTGRES, MYSQL)


def backend() -> str:
    """Moteur de la base principale (``shared_infra.config.DB_BACKEND``, relu
    via ``_connection`` que les tests re-pointent)."""
    from shared_infra.db import _connection
    return _connection.DB_BACKEND


def dialect_of(conn: Any) -> str:
    """Dialecte d'une connexion : les enveloppes PG/MySQL portent un attribut
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

    PostgreSQL / MySQL : ``BEGIN`` puis ``SELECT … FOR UPDATE`` sur la ligne
    ``write`` de la table ``elpis_locks`` — un verrou de TRANSACTION, relâché
    tout seul au COMMIT/ROLLBACK, même quand l'appelant valide par texte SQL
    (``GET_LOCK`` / ``pg_advisory_lock`` survivraient au COMMIT).
    """
    d = dialect_of(conn)
    if d == SQLITE:
        conn.execute("BEGIN IMMEDIATE")
        return
    if not getattr(conn, "_locks_ready", False):
        # Base dont le schéma n'a pas (encore) été posé par ``create_all`` —
        # typiquement une base de test aux tables créées à la main : la table
        # du verrou est créée ici, HORS transaction (le DDL de MySQL valide).
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

def is_missing_table(exc: BaseException) -> bool:
    """L'erreur signale-t-elle une table absente ? (SQLite « no such table »,
    PG SQLSTATE 42P01, MySQL 1146 — les enveloppes PG/MySQL relèvent ces
    erreurs en ``sqlite3.OperationalError`` avec un message normalisé.)"""
    return isinstance(exc, sqlite3.Error) and "no such table" in str(exc).lower()


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
    elif d == POSTGRES:
        rows = conn.execute(
            "SELECT table_name AS name FROM information_schema.tables "
            "WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' "
            "ORDER BY table_name").fetchall()
    else:
        rows = conn.execute(
            "SELECT table_name AS name FROM information_schema.tables "
            "WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' "
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
    schema = "current_schema()" if d == POSTGRES else "DATABASE()"
    rows = conn.execute(
        "SELECT column_name AS name FROM information_schema.columns "
        f"WHERE table_schema = {schema} AND table_name = ? ORDER BY ordinal_position",
        (table,)).fetchall()
    return [_row_value(r, "name", 0) for r in rows]


def has_column(conn: Any, table: str, column: str) -> bool:
    return column in table_columns(conn, table)


def add_column_if_missing(conn: Any, table: str, column: str, decl: str) -> bool:
    """Ajoute ``column`` (déclaration SQL ``decl``, ex. ``"TEXT NOT NULL
    DEFAULT ''"``) si elle manque. Rend True si la colonne a été ajoutée.

    Remplace le motif ``try: ALTER TABLE … ADD COLUMN … except: pass``, qui
    avorte la transaction en PostgreSQL quand la colonne existe déjà.
    """
    if has_column(conn, table, column):
        return False
    conn.execute(f'ALTER TABLE "{table}" ADD COLUMN "{column}" {decl}')
    return True


# ─────────────────────────────────────────────────────────────────────────────
#  Fragments SQL sans écriture commune
# ─────────────────────────────────────────────────────────────────────────────

def insert_id(cur: Any, sql: str, params: tuple = ()) -> int:
    """Exécute un INSERT et rend l'id de la ligne créée (colonne ``id``).

    SQLite et MySQL : ``cursor.lastrowid``. PostgreSQL n'a pas de
    ``lastrowid`` : l'enveloppe PG ajoutera ``RETURNING id``.
    """
    d = dialect_of(getattr(cur, "connection", None))
    if d == POSTGRES:
        row = cur.execute(sql.rstrip().rstrip(";") + " RETURNING id", params).fetchone()
        return int(row[0]) if row else 0
    cur.execute(sql, params)
    return int(cur.lastrowid or 0)                    # SQLite, MySQL


def ci_like(col: str, dialect: Optional[str] = None) -> str:
    """Prédicat « ``col`` ressemble au motif ``?`` », insensible à la casse
    comme le LIKE de SQLite.

    PostgreSQL : ``ILIKE`` ; MySQL : la base est en ``utf8mb4_bin`` (égalité
    exacte, comme SQLite) → comparaison en minuscules des deux côtés.
    """
    d = _dialect(dialect=dialect)
    if d == POSTGRES:
        return f"{col} ILIKE ?"
    if d == MYSQL:
        return f"LOWER({col}) LIKE LOWER(?)"
    return f"{col} LIKE ?"


def group_concat(expr: str, sep: str = ",", distinct: bool = False,
                 dialect: Optional[str] = None) -> str:
    """Concaténation d'agrégat : ``GROUP_CONCAT`` (SQLite, MySQL) /
    ``string_agg`` (PostgreSQL). ``sep`` est un littéral de confiance.

    ``distinct`` : SQLite n'accepte ``DISTINCT`` qu'avec un seul argument —
    le séparateur est alors la virgule, imposée."""
    d = _dialect(dialect=dialect)
    lit = "'" + sep.replace("'", "''") + "'"
    dist = "DISTINCT " if distinct else ""
    if d == POSTGRES:
        return f"string_agg({dist}CAST({expr} AS TEXT), {lit})"
    if d == MYSQL:
        return f"GROUP_CONCAT({dist}{expr} SEPARATOR {lit})"
    if distinct:
        if sep != ",":
            raise ValueError("SQLite : GROUP_CONCAT(DISTINCT …) n'accepte que la virgule")
        return f"GROUP_CONCAT(DISTINCT {expr})"
    return f"GROUP_CONCAT({expr}, {lit})"


def greatest(*exprs: str, dialect: Optional[str] = None) -> str:
    """Maximum de plusieurs expressions : ``MAX(a, b)`` scalaire en SQLite,
    ``GREATEST(a, b)`` ailleurs (attention : GREATEST ignore NULL en PG mais
    rend NULL en MySQL — protéger par COALESCE si une valeur peut manquer)."""
    d = _dialect(dialect=dialect)
    fn = "MAX" if d == SQLITE else "GREATEST"
    return f"{fn}({', '.join(exprs)})"


def round_(expr: str, digits: int, dialect: Optional[str] = None) -> str:
    """``ROUND(x, n)`` : PostgreSQL n'a pas ``round(double precision, int)``."""
    d = _dialect(dialect=dialect)
    if d == POSTGRES:
        return f"ROUND(CAST({expr} AS NUMERIC), {int(digits)})"
    return f"ROUND({expr}, {int(digits)})"


def cast_int(expr: str, dialect: Optional[str] = None) -> str:
    """Partie entière, avec la troncature de SQLite (``CAST(x AS INTEGER)``).

    PostgreSQL et MySQL ARRONDISSENT au lieu de tronquer : ``FLOOR`` d'abord
    (valeurs positives — horodatages, durées)."""
    d = _dialect(dialect=dialect)
    if d == POSTGRES:
        return f"CAST(FLOOR({expr}) AS BIGINT)"
    if d == MYSQL:
        return f"CAST(FLOOR({expr}) AS SIGNED)"
    return f"CAST({expr} AS INTEGER)"


def cast_float(expr: str, dialect: Optional[str] = None) -> str:
    d = _dialect(dialect=dialect)
    if d == POSTGRES:
        return f"CAST({expr} AS DOUBLE PRECISION)"
    if d == MYSQL:
        return f"CAST({expr} AS DOUBLE)"
    return f"CAST({expr} AS REAL)"


def no_limit(dialect: Optional[str] = None) -> str:
    """Borne « sans limite » à placer après LIMIT quand un OFFSET suit :
    ``LIMIT -1 OFFSET ?`` en SQLite, ``LIMIT ALL`` en PG, le plus grand
    entier non signé en MySQL."""
    d = _dialect(dialect=dialect)
    if d == POSTGRES:
        return "ALL"
    if d == MYSQL:
        return "18446744073709551615"
    return "-1"


def bytes_order(expr: str, dialect: Optional[str] = None) -> str:
    """Clé de tri TEXTE comparée octet par octet, comme SQLite (``BINARY``) :
    l'ordre ne dépend plus de la collation du serveur (un PostgreSQL en
    ``fr_FR``/``en_US.UTF-8`` range « a » avant « B », SQLite l'inverse)."""
    d = _dialect(dialect=dialect)
    if d == POSTGRES:
        return f'{expr} COLLATE "C"'
    if d == MYSQL:
        return f"CAST({expr} AS BINARY)"
    return expr


def nulls_first(expr: str, desc: bool = False, dialect: Optional[str] = None) -> str:
    """Tri avec les NULL en tête, écrit pour chaque moteur (``NULLS FIRST``
    n'existe pas en MySQL/MariaDB)."""
    d = _dialect(dialect=dialect)
    direction = "DESC" if desc else "ASC"
    if d == MYSQL:
        return f"({expr} IS NULL) DESC, {expr} {direction}"
    return f"{expr} {direction} NULLS FIRST"


def json_get(col: str, key: str, dialect: Optional[str] = None) -> str:
    """Valeur texte d'une clé de premier niveau d'une colonne JSON (TEXT).
    ``key`` est un identifiant de confiance (écrit dans le code)."""
    if not key.replace("_", "").isalnum():
        raise ValueError(f"clé JSON inattendue : {key!r}")
    d = _dialect(dialect=dialect)
    if d == POSTGRES:
        return f"(CAST({col} AS JSONB) ->> '{key}')"
    if d == MYSQL:
        return f"JSON_UNQUOTE(JSON_EXTRACT({col}, '$.{key}'))"
    return f"json_extract({col}, '$.{key}')"


def json_get_num(col: str, key: str, dialect: Optional[str] = None) -> str:
    """Valeur numérique d'une clé JSON (comparable à un nombre)."""
    d = _dialect(dialect=dialect)
    if d == SQLITE:
        return json_get(col, key, dialect=d)
    return cast_float(json_get(col, key, dialect=d), dialect=d)


def json_get_param(col: str, dialect: Optional[str] = None) -> str:
    """Comme ``json_get``, pour une clé passée en PARAMÈTRE (un ``?`` dans le
    fragment, à lier au nom de la clé)."""
    d = _dialect(dialect=dialect)
    if d == POSTGRES:
        return f"(CAST({col} AS JSONB) ->> ?)"
    if d == MYSQL:
        return f"JSON_UNQUOTE(JSON_EXTRACT({col}, CONCAT('$.', ?)))"
    return f"json_extract({col}, '$.' || ?)"


def json_get_param_num(col: str, dialect: Optional[str] = None) -> str:
    d = _dialect(dialect=dialect)
    if d == SQLITE:
        return json_get_param(col, dialect=d)
    return cast_float(json_get_param(col, dialect=d), dialect=d)


# ─────────────────────────────────────────────────────────────────────────────
#  Dates locales (tableaux de bord)
# ─────────────────────────────────────────────────────────────────────────────
#  SQLite convertit un epoch en heure locale avec ``'localtime'`` : le fuseau
#  du PROCESSUS, changements d'heure compris. PostgreSQL et MySQL n'ont pas cet
#  équivalent sans configuration du serveur (fuseau de session, tables de
#  fuseaux MySQL souvent absentes). On y ajoute donc à l'epoch le décalage
#  local du process, PAR MORCEAUX : ``CASE WHEN ts < t1 THEN o0 WHEN ts < t2
#  THEN o1 … END``, transitions calculées ici sur ~2 ans autour de maintenant.
#  Même résultat que ``'localtime'``, y compris les jours de 23 h ou 25 h.
#  Les littéraux sont des entiers calculés par ce module : aucune donnée
#  extérieure n'entre dans le SQL.

_OFFSET_CACHE: dict = {}
_DIRECTIVES = {"%Y": ("YYYY", "%Y"), "%m": ("MM", "%m"), "%d": ("DD", "%d"),
               "%H": ("HH24", "%H"), "%M": ("MI", "%i"), "%S": ("SS", "%s")}


def _local_offset(ts: float) -> int:
    import time as _time
    return int(_time.localtime(ts).tm_gmtoff)


def _offset_segments(now: Optional[float] = None) -> list:
    """[(borne, décalage)] : le décalage s'applique AVANT ``borne`` ; la
    dernière borne est None. Recalculé une fois par jour."""
    import time as _time
    now = _time.time() if now is None else now
    day = int(now // 86400)
    cached = _OFFSET_CACHE.get(day)
    if cached is not None:
        return cached
    start, end = now - 800 * 86400, now + 400 * 86400
    segments, t, cur = [], start, _local_offset(start)
    step = 86400
    while t < end:
        nxt = min(t + step, end)
        off = _local_offset(nxt)
        if off != cur:
            lo, hi = t, nxt                     # dichotomie jusqu'à la seconde
            while hi - lo > 1:
                mid = (lo + hi) // 2
                if _local_offset(mid) == cur:
                    lo = mid
                else:
                    hi = mid
            segments.append((int(hi), cur))
            cur = off
        t = nxt
    segments.append((None, cur))
    _OFFSET_CACHE.clear()
    _OFFSET_CACHE[day] = segments
    return segments


def local_offset_sql(col: str) -> str:
    """Décalage local (secondes) de l'instant ``col``, en SQL portable."""
    segments = _offset_segments()
    if len(segments) == 1:
        return str(segments[0][1])
    parts = [f"WHEN {col} < {bound} THEN {off}" for bound, off in segments[:-1]]
    return f"(CASE {' '.join(parts)} ELSE {segments[-1][1]} END)"


def _pg_format(fmt: str) -> str:
    out, i = [], 0
    while i < len(fmt):
        two = fmt[i:i + 2]
        if two in _DIRECTIVES:
            out.append(_DIRECTIVES[two][0])
            i += 2
            continue
        ch = fmt[i]
        if ch.isalpha():
            out.append(f'"{ch}"')            # texte littéral pour to_char
        else:
            out.append(ch)
        i += 1
    return "".join(out)


def _mysql_format(fmt: str) -> str:
    out, i = [], 0
    while i < len(fmt):
        two = fmt[i:i + 2]
        if two in _DIRECTIVES:
            out.append(_DIRECTIVES[two][1])
            i += 2
            continue
        out.append(fmt[i])
        i += 1
    return "".join(out)


def _check_format(fmt: str) -> None:
    import re as _re
    for d in _re.findall(r"%.", fmt):
        if d not in _DIRECTIVES and d != "%w":
            raise ValueError(f"directive de date non prise en charge : {d}")
    if "'" in fmt:
        raise ValueError("format de date : apostrophe interdite")


def local_strftime(fmt: str, col: str, dialect: Optional[str] = None) -> str:
    """Instant epoch ``col`` formaté en heure LOCALE — équivalent portable de
    ``strftime(fmt, datetime(col, 'unixepoch', 'localtime'))``. Directives :
    %Y %m %d %H %M %S, et %w seul (jour de semaine, 0 = dimanche)."""
    _check_format(fmt)
    d = _dialect(dialect=dialect)
    if d == SQLITE:
        return f"strftime('{fmt}', datetime({col},'unixepoch','localtime'))"
    shifted = f"({col} + {local_offset_sql(col)})"
    return utc_strftime(fmt, shifted, dialect=d)


def utc_strftime(fmt: str, expr: str, dialect: Optional[str] = None) -> str:
    """Epoch ``expr`` formaté en UTC (``strftime(fmt, datetime(expr,
    'unixepoch'))``) — l'appelant y ajoute lui-même un décalage fixe."""
    _check_format(fmt)
    d = _dialect(dialect=dialect)
    if d == SQLITE:
        return f"strftime('{fmt}', datetime({expr}, 'unixepoch'))"
    if fmt == "%w":
        if d == POSTGRES:
            return f"CAST(CAST(EXTRACT(DOW FROM (to_timestamp({expr}) AT TIME ZONE 'UTC')) AS INTEGER) AS TEXT)"
        return f"CAST(DAYOFWEEK(FROM_UNIXTIME({expr})) - 1 AS CHAR)"
    if d == POSTGRES:
        return f"to_char(to_timestamp({expr}) AT TIME ZONE 'UTC', '{_pg_format(fmt)}')"
    # MySQL : la session est en UTC (fuseau posé par l'enveloppe).
    return f"DATE_FORMAT(FROM_UNIXTIME({expr}), '{_mysql_format(fmt)}')"


def local_part_int(part: str, col: str, dialect: Optional[str] = None) -> str:
    """Composante ENTIÈRE de l'heure locale : ``'%H'`` (0-23) ou ``'%w'``
    (jour de semaine, 0 = dimanche) — équivalent de
    ``CAST(strftime(part, datetime(col,'unixepoch','localtime')) AS INTEGER)``."""
    if part not in ("%H", "%w"):
        raise ValueError(f"composante non prise en charge : {part}")
    d = _dialect(dialect=dialect)
    if d == SQLITE:
        return f"CAST({local_strftime(part, col, dialect=d)} AS INTEGER)"
    shifted = f"({col} + {local_offset_sql(col)})"
    if d == POSTGRES:
        field = "HOUR" if part == "%H" else "DOW"
        return f"CAST(EXTRACT({field} FROM (to_timestamp({shifted}) AT TIME ZONE 'UTC')) AS INTEGER)"
    if part == "%H":
        return f"HOUR(FROM_UNIXTIME({shifted}))"
    return f"(DAYOFWEEK(FROM_UNIXTIME({shifted})) - 1)"


def local_datetime(col: str, dialect: Optional[str] = None) -> str:
    """``datetime(col,'unixepoch','localtime')`` : 'AAAA-MM-JJ HH:MM:SS' local."""
    d = _dialect(dialect=dialect)
    if d == SQLITE:
        return f"datetime({col},'unixepoch','localtime')"
    return local_strftime("%Y-%m-%d %H:%M:%S", col, dialect=d)


__all__ = [
    "SQLITE", "POSTGRES", "MYSQL", "BACKENDS",
    "backend", "dialect_of", "begin_write", "savepoint", "is_missing_table",
    "has_table", "table_names", "table_columns", "has_column", "add_column_if_missing",
    "insert_id", "ci_like", "group_concat", "greatest", "round_", "cast_int",
    "cast_float", "no_limit", "nulls_first", "json_get", "json_get_num",
    "json_get_param", "json_get_param_num", "local_offset_sql", "local_strftime",
    "utc_strftime", "local_part_int", "local_datetime",
]
