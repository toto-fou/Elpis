# SPDX-License-Identifier: MIT
"""
shared_infra.db._pg — adaptateur PostgreSQL (pilote pg8000, BSD-3-Clause).

pg8000 est en pur Python : rien à compiler, bundle hors ligne trivial, et
aucune licence copyleft (psycopg est LGPL-3.0). Deux particularités vérifiées
dans son code (1.31.5) et compensées ici :

* ses erreurs serveur sont TOUTES un ``DatabaseError`` générique portant le
  SQLSTATE dans ``args[0]["C"]`` → relevées par classe en sous-classes des
  exceptions de ``sqlite3`` (cf. ``_server``) ;
* une requête paramétrée coûte 3 allers-retours (``execute_unnamed`` :
  PARSE, puis DESCRIBE + BIND, puis EXECUTE) contre UN avec une instruction
  préparée (``prepare_statement`` une fois, puis ``execute_named``) → cache
  LRU d'instructions préparées par connexion.

Les ``?`` de l'application sont convertis par pg8000 lui-même
(``convert_paramstyle("qmark", …)``, qui ignore littéraux, identifiants
cités, ``E''``, ``$$`` et commentaires ``--``) ; les ``%`` ne sont pas
touchés. Une requête SANS paramètre passe par le protocole simple, sans
conversion (plusieurs instructions possibles).
"""
from __future__ import annotations

import os
import socket
import ssl
import struct
from collections import OrderedDict
from typing import Any, Optional

from shared_infra.db._server import (
    ServerConnection,
    ServerDataError,
    ServerError,
    ServerIntegrityError,
    ServerOperationalError,
    ServerProgrammingError,
)

_PREPARED_MAX = 256


def _pg8000():
    import pg8000.converters
    import pg8000.dbapi  # noqa: F401 — import paresseux : pilote facultatif
    import pg8000.exceptions
    return pg8000


class PgConnection(ServerConnection):
    dialect = "postgres"
    strip_nul = True                     # PostgreSQL refuse l'octet NUL dans TEXT

    def __init__(self, raw: Any):
        super().__init__(raw)
        self._prepared: "OrderedDict[str, tuple]" = OrderedDict()
        pg = _pg8000()
        self._convert = pg.dbapi.convert_paramstyle
        self._make_params = pg.converters.make_params
        self._DatabaseError = pg.exceptions.DatabaseError
        self._InterfaceError = pg.exceptions.InterfaceError

    # ── Exécution ───────────────────────────────────────────────────────────
    def _exec(self, sql: str, params: Any, many: bool):
        if many:
            total, names, rows = 0, None, None
            for p in params:
                names, rows, rc = self._exec_one(sql, p)
                total += max(rc, 0)
            return names, rows, total
        return self._exec_one(sql, params)

    def _exec_one(self, sql: str, params: Any):
        if not params:
            ctx = self.raw.execute_simple(sql)
        else:
            statement, vals = self._convert("qmark", sql, params)
            ctx = self._execute_prepared(statement, vals)
        names = [c["name"] for c in ctx.columns] if ctx.columns else None
        return names, ctx.rows, ctx.row_count

    def _execute_prepared(self, statement: str, vals: Any):
        entry = self._prepared.get(statement)
        if entry is None:
            entry = self.raw.prepare_statement(statement, ())
            self._prepared[statement] = entry
            while len(self._prepared) > _PREPARED_MAX:
                _, (old_name, _c, _f) = self._prepared.popitem(last=False)
                try:
                    self.raw.close_prepared_statement(old_name)
                except Exception:
                    pass
        else:
            self._prepared.move_to_end(statement)
        name_bin, columns, input_funcs = entry
        params = self._make_params(self.raw.py_types, vals)
        try:
            return self.raw.execute_named(name_bin, params, columns, input_funcs, statement)
        except self._DatabaseError as exc:
            info = exc.args[0] if exc.args and isinstance(exc.args[0], dict) else {}
            if info.get("C") in ("0A000", "26000"):
                # Plan en cache périmé (schéma modifié depuis la préparation) :
                # on oublie l'instruction et on repasse par le chemin simple.
                self._prepared.pop(statement, None)
                return self.raw.execute_unnamed(statement, vals=vals)
            raise

    def _raw_begin(self) -> None:
        self.raw.execute_simple("BEGIN")

    def _raw_commit(self) -> None:
        self.raw.execute_simple("COMMIT")

    def _raw_rollback(self) -> None:
        self.raw.execute_simple("ROLLBACK")

    def ping(self) -> bool:
        try:
            self.raw.execute_simple("SELECT 1")
            return True
        except Exception:
            self.broken = True
            return False

    def reset(self) -> None:
        super().reset()
        if not self.broken:
            try:
                self.raw.execute_simple("SELECT pg_advisory_unlock_all()")
            except Exception:
                self.broken = True

    # ── Erreurs ─────────────────────────────────────────────────────────────
    def _map_error(self, exc: BaseException) -> BaseException:
        import sqlite3
        if isinstance(exc, sqlite3.Error):
            return exc
        if isinstance(exc, self._DatabaseError):
            info = exc.args[0] if exc.args and isinstance(exc.args[0], dict) else {}
            code = str(info.get("C", ""))
            msg = str(info.get("M") or exc)
            full = f"{msg} [SQLSTATE {code}]" if code else msg
            if code.startswith("23"):
                return ServerIntegrityError(full)
            if code == "42P01":
                return ServerOperationalError(f"no such table: {msg}")
            if code == "42703":
                return ServerOperationalError(f"no such column: {msg}")
            if code.startswith("22"):
                return ServerDataError(full)
            if code.startswith("08") or code in ("57P01", "57P02", "57P03"):
                self.broken = True
                return ServerOperationalError(full)
            if code.startswith(("40", "42", "55", "57", "25", "0A", "26")):
                return ServerOperationalError(full)
            return ServerError(full)
        if isinstance(exc, self._InterfaceError):
            if "failed transaction" not in str(exc):
                self.broken = True
            return ServerOperationalError(str(exc))
        if isinstance(exc, (OSError, socket.error, struct.error, EOFError)):
            self.broken = True
            return ServerOperationalError(f"connexion PostgreSQL perdue : {exc!r}")
        if isinstance(exc, (TypeError, ValueError)):
            return ServerProgrammingError(str(exc))
        return exc


def _ssl_context(tls: str) -> Optional[ssl.SSLContext]:
    tls = (tls or "off").lower()
    if tls in ("off", "disable", "no", "false", ""):
        return None
    ctx = ssl.create_default_context()
    if tls != "verify":
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    return ctx


def connect(*, host: str, port: int, name: str, user: str, password: str,
            tls: str = "off", timeout: float = 60.0, schema: Optional[str] = None,
            application: str = "elpis") -> PgConnection:
    pg = _pg8000()
    kwargs = dict(user=user, host=host, port=int(port), database=name, password=password,
                  ssl_context=_ssl_context(tls), timeout=timeout, tcp_keepalive=True,
                  application_name=f"{application}-{os.getpid()}"[:63])
    if host.startswith("/"):
        kwargs.pop("host")
        kwargs["unix_sock"] = host if host.endswith(".s.PGSQL.%d" % int(port)) else \
            os.path.join(host, ".s.PGSQL.%d" % int(port))
    try:
        raw = pg.dbapi.connect(**kwargs)
    except Exception as exc:
        raise ServerOperationalError(f"connexion PostgreSQL impossible : {exc}") from exc
    conn = PgConnection(raw)
    if schema:
        conn.raw.execute_simple(f'SET search_path TO "{schema}"')
    return conn


__all__ = ["PgConnection", "connect"]
