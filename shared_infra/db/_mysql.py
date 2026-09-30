# SPDX-License-Identifier: MIT
"""
shared_infra.db._mysql — adaptateur MariaDB / MySQL (pilote PyMySQL, MIT).

PyMySQL est en pur Python et sous licence MIT (mysqlclient et le connecteur
d'Oracle sont GPL, le connecteur MariaDB LGPL). Ce que l'adaptateur règle :

* **Placeholders.** PyMySQL applique ``requête % paramètres`` à TOUTE la
  chaîne dès qu'il y a des paramètres : sans paramètre, la requête passe
  telle quelle (``args=None``) ; avec, chaque ``%`` est doublé (littéraux
  compris) et les ``?`` hors littéraux/commentaires deviennent ``%s``.
* **Upserts.** ``ON CONFLICT(…) DO UPDATE SET c = excluded.c`` devient
  ``ON DUPLICATE KEY UPDATE c = VALUES(c)`` (MariaDB) ou
  ``AS new ON DUPLICATE KEY UPDATE c = new.c`` (MySQL ≥ 8.0.19).
  ``DO NOTHING`` devient un INSERT simple dont SEULE l'erreur de doublon
  (1062) est absorbée, ``rowcount`` = 0 — la déduplication des webhooks en
  dépend ; ``INSERT IGNORE`` avalerait aussi les troncatures. Un ``WHERE``
  dans ``DO UPDATE`` n'a pas d'équivalent : la traduction refuse, le site
  concerné a sa branche écrite à la main (``chat/store.upsert_chat``).
* **Session.** ``sql_mode`` = ANSI_QUOTES (guillemets doubles = identifiants,
  comme ailleurs), PIPES_AS_CONCAT (``||`` concatène), STRICT_TRANS_TABLES,
  NO_ENGINE_SUBSTITUTION — pas ``ANSI`` complet (REAL_AS_FLOAT, et le
  ONLY_FULL_GROUP_BY de MariaDB refuserait la liste des comptes) ; READ
  COMMITTED ; ``time_zone`` UTC (les dates locales sont décalées par nos
  helpers) ; ``CLIENT.FOUND_ROWS`` : ``rowcount`` = lignes TROUVÉES, comme
  SQLite (MySQL compte sinon les lignes modifiées).
"""
from __future__ import annotations

import functools
import re
from typing import Any, NamedTuple, Optional

from shared_infra.db._server import (
    ServerConnection,
    ServerDataError,
    ServerError,
    ServerIntegrityError,
    ServerOperationalError,
    ServerProgrammingError,
)

SQL_MODE = "ANSI_QUOTES,PIPES_AS_CONCAT,STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION"


def _pymysql():
    import pymysql  # noqa: F401 — import paresseux : pilote facultatif
    import pymysql.constants.CLIENT
    return pymysql


# ─────────────────────────────────────────────────────────────────────────────
#  Traduction
# ─────────────────────────────────────────────────────────────────────────────

class Plan(NamedTuple):
    sql: str
    do_nothing: bool


def _placeholders(sql: str) -> str:
    """``?`` → ``%s`` hors littéraux et commentaires ; tout ``%`` doublé."""
    out, i, n, quote = [], 0, len(sql), None
    while i < n:
        ch = sql[i]
        if ch == "%":
            out.append("%%")
            i += 1
            continue
        if quote:
            out.append(ch)
            if ch == quote:
                if i + 1 < n and sql[i + 1] == quote:
                    out.append(quote)
                    i += 1
                else:
                    quote = None
            elif ch == "\\" and quote == "'" and i + 1 < n:
                out.append(sql[i + 1])
                i += 1
        elif ch in ("'", '"', "`"):
            quote = ch
            out.append(ch)
        elif ch == "-" and sql.startswith("--", i):
            j = sql.find("\n", i)
            j = n if j < 0 else j
            out.append(sql[i:j].replace("%", "%%"))
            i = j
            continue
        elif ch == "/" and sql.startswith("/*", i):
            j = sql.find("*/", i + 2)
            j = n if j < 0 else j + 2
            out.append(sql[i:j].replace("%", "%%"))
            i = j
            continue
        elif ch == "?":
            out.append("%s")
        else:
            out.append(ch)
        i += 1
    return "".join(out)


_CONFLICT_NOTHING = re.compile(r"\s+ON\s+CONFLICT\s*(\([^)]*\))?\s*DO\s+NOTHING\s*;?\s*$", re.I | re.S)
_CONFLICT_UPDATE = re.compile(r"\s+ON\s+CONFLICT\s*\([^)]*\)\s*DO\s+UPDATE\s+SET\s+(.*?)\s*;?\s*$", re.I | re.S)
_EXCLUDED = re.compile(r"\bexcluded\.([A-Za-z_][A-Za-z0-9_]*)\b", re.I)
_TOP_WHERE = re.compile(r"\bWHERE\b", re.I)


@functools.lru_cache(maxsize=2048)
def translate(sql: str, has_params: bool, flavor: str) -> Plan:
    do_nothing = False
    m = _CONFLICT_NOTHING.search(sql)
    if m:
        sql = sql[:m.start()]
        do_nothing = True
    else:
        m = _CONFLICT_UPDATE.search(sql)
        if m:
            assignments = m.group(1)
            if _TOP_WHERE.search(assignments):
                raise ServerProgrammingError(
                    "ON CONFLICT … DO UPDATE … WHERE n'a pas d'équivalent en MySQL : "
                    "ce site doit avoir sa branche MySQL écrite à la main")
            head = sql[:m.start()]
            if flavor == "mysql":
                assignments = _EXCLUDED.sub(lambda mm: f"new.{mm.group(1)}", assignments)
                sql = f"{head} AS new ON DUPLICATE KEY UPDATE {assignments}"
            else:
                assignments = _EXCLUDED.sub(lambda mm: f"VALUES({mm.group(1)})", assignments)
                sql = f"{head} ON DUPLICATE KEY UPDATE {assignments}"
    if has_params:
        sql = _placeholders(sql)
    return Plan(sql, do_nothing)


# ─────────────────────────────────────────────────────────────────────────────
#  Connexion
# ─────────────────────────────────────────────────────────────────────────────

_DUPLICATE = 1062


class MySQLConnection(ServerConnection):
    dialect = "mysql"

    def __init__(self, raw: Any, flavor: str):
        super().__init__(raw)
        self.flavor = flavor                            # "mariadb" | "mysql"
        pm = _pymysql()
        self._err = pm.err

    def _exec(self, sql: str, params: Any, many: bool):
        plan = translate(sql, bool(params) or many, self.flavor)
        cur = self.raw.cursor()
        try:
            if many:
                rowcount = 0
                if plan.do_nothing:
                    for p in params:
                        rowcount += self._insert_or_nothing(cur, plan.sql, p)
                else:
                    cur.executemany(plan.sql, list(params))
                    rowcount = cur.rowcount
                return None, None, rowcount
            if plan.do_nothing:
                return None, None, self._insert_or_nothing(cur, plan.sql, params)
            cur.execute(plan.sql, params if params else None)
            self._last_insert_id = cur.lastrowid
            names = [d[0] for d in cur.description] if cur.description else None
            rows = list(cur.fetchall()) if names else None
            return names, rows, cur.rowcount
        finally:
            cur.close()

    def _insert_or_nothing(self, cur, sql: str, params: Any) -> int:
        try:
            cur.execute(sql, params if params else None)
            return cur.rowcount
        except self._err.IntegrityError as exc:
            if exc.args and exc.args[0] == _DUPLICATE:
                return 0
            raise

    def _raw_begin(self) -> None:
        self.raw.begin()

    def _raw_commit(self) -> None:
        self.raw.commit()

    def _raw_rollback(self) -> None:
        self.raw.rollback()

    def ping(self) -> bool:
        try:
            self.raw.ping(reconnect=False)
            return True
        except Exception:
            self.broken = True
            return False

    def reset(self) -> None:
        super().reset()
        if not self.broken:
            try:
                with self.raw.cursor() as c:
                    c.execute("DO RELEASE_ALL_LOCKS()")
            except Exception:
                pass

    def _map_error(self, exc: BaseException) -> BaseException:
        import sqlite3
        if isinstance(exc, sqlite3.Error):
            return exc
        e = self._err
        code = exc.args[0] if getattr(exc, "args", None) and isinstance(exc.args[0], int) else 0
        text = str(exc.args[1]) if getattr(exc, "args", None) and len(exc.args) > 1 else str(exc)
        full = f"{text} [MySQL {code}]" if code else text
        if code == 1146:
            return ServerOperationalError(f"no such table: {text}")
        if code == 1054:
            return ServerOperationalError(f"no such column: {text}")
        if isinstance(exc, e.IntegrityError):
            return ServerIntegrityError(full)
        if isinstance(exc, e.DataError):
            return ServerDataError(full)
        if isinstance(exc, (e.OperationalError, e.InterfaceError)):
            if code in (2003, 2006, 2013, 2055, 0) or isinstance(exc, e.InterfaceError):
                self.broken = True
            return ServerOperationalError(full)
        if isinstance(exc, e.ProgrammingError):
            return ServerOperationalError(full)
        if isinstance(exc, e.Error):
            return ServerError(full)
        if isinstance(exc, (OSError, EOFError)):
            self.broken = True
            return ServerOperationalError(f"connexion MySQL perdue : {exc!r}")
        return exc


def connect(*, host: str, port: int, name: str, user: str, password: str,
            tls: str = "off", timeout: float = 60.0, schema: Optional[str] = None,
            application: str = "elpis") -> MySQLConnection:
    pm = _pymysql()
    kwargs = dict(user=user, password=password, database=schema or name,
                  charset="utf8mb4", autocommit=True,
                  client_flag=pm.constants.CLIENT.FOUND_ROWS,
                  connect_timeout=10, read_timeout=timeout, write_timeout=timeout)
    if host.startswith("/"):
        kwargs["unix_socket"] = host
    else:
        kwargs["host"], kwargs["port"] = host, int(port)
    from shared_infra.db._pg import _ssl_context
    ctx = _ssl_context(tls)
    if ctx is not None:
        kwargs["ssl"] = ctx
    try:
        raw = pm.connect(**kwargs)
    except Exception as exc:
        raise ServerOperationalError(f"connexion MySQL/MariaDB impossible : {exc}") from exc
    with raw.cursor() as c:
        c.execute("SET NAMES utf8mb4 COLLATE utf8mb4_bin")
        c.execute(f"SET SESSION sql_mode='{SQL_MODE}', SESSION group_concat_max_len=1048576, "
                  "SESSION time_zone='+00:00'")
        c.execute("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED")
        c.execute("SELECT VERSION()")
        version = str(c.fetchone()[0])
    flavor = "mariadb" if "mariadb" in version.lower() else "mysql"
    return MySQLConnection(raw, flavor)


__all__ = ["MySQLConnection", "Plan", "translate", "connect", "SQL_MODE"]
