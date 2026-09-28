# SPDX-License-Identifier: MIT
"""
shared_infra.db._server — socle commun des moteurs SERVEUR (PostgreSQL,
MariaDB/MySQL) : une connexion et un curseur qui se comportent comme ceux de
``sqlite3``, pour que les ~615 appels SQL de l'application n'aient pas à
savoir à quel moteur ils parlent.

Ce que l'on reproduit de sqlite3, et pourquoi
=============================================
* **Transactions « historiques ».** sqlite3 n'ouvre une transaction qu'avant
  le premier INSERT/UPDATE/DELETE ; une lecture reste hors transaction. La
  connexion serveur est donc en autocommit et l'enveloppe pose ``BEGIN``
  juste avant la première écriture. Effets : aucune session « idle in
  transaction » qui retient des verrous, et une LECTURE en échec n'avorte
  jamais de transaction (en PostgreSQL, toute erreur dans une transaction
  rend la suite inutilisable).
* ``isolation_level = None`` : autocommit strict (pas de BEGIN implicite) ;
  passer à None pendant une transaction la valide, comme sqlite3.
* ``with conn:`` valide ou annule SANS fermer (le ``with`` d'un pilote
  serveur ferme la connexion).
* Lignes ``ElpisRow`` : accès par position ET par nom (insensible à la casse,
  comme ``sqlite3.Row``), ``keys()``, ``dict(row)``, dépaquetage.
* Valeurs : booléens envoyés en entiers ; ``Decimal`` relu en ``int`` s'il
  est entier (``SUM`` d'entiers rend un ``int`` en SQLite), en ``float``
  sinon ; booléens relus en 0/1.
* Erreurs relevées en sous-classes des exceptions de ``sqlite3``
  (``IntegrityError``, ``OperationalError``…) : les ``except sqlite3.X``
  existants restent valides ; une table absente dit « no such table ».
* ``close()`` rend la connexion au pool (cf. ``_connection.db``).
"""
from __future__ import annotations

import decimal
import functools
import logging
import re
import sqlite3
from typing import Any, Callable, Iterable, List, Optional, Sequence, Tuple

log = logging.getLogger("uvicorn.error")


# ─────────────────────────────────────────────────────────────────────────────
#  Erreurs — sous-classes de sqlite3 (les « except sqlite3.X » restent justes)
# ─────────────────────────────────────────────────────────────────────────────

class ServerError(sqlite3.DatabaseError):
    """Erreur d'un moteur serveur non classée plus finement."""


class ServerIntegrityError(sqlite3.IntegrityError):
    """Contrainte violée (doublon, clé étrangère, NOT NULL, CHECK)."""


class ServerOperationalError(sqlite3.OperationalError):
    """Table/colonne absente, verrou, délai, connexion perdue…"""


class ServerDataError(sqlite3.DataError):
    """Valeur hors domaine (texte trop long pour sa colonne…)."""


class ServerProgrammingError(sqlite3.ProgrammingError):
    """Requête mal formée côté appelant."""


# ─────────────────────────────────────────────────────────────────────────────
#  Lignes
# ─────────────────────────────────────────────────────────────────────────────

class ElpisRow(tuple):
    """Ligne de résultat : tuple + accès par nom, comme ``sqlite3.Row``."""
    __slots__ = ()
    _keys: Tuple[str, ...] = ()
    _index: dict = {}

    def __getitem__(self, key):
        if isinstance(key, str):
            try:
                i = self._index[key]
            except KeyError:
                try:
                    i = self._index[key.lower()]
                except KeyError:
                    raise IndexError(f"No item with that key: {key!r}") from None
            return tuple.__getitem__(self, i)
        return tuple.__getitem__(self, key)

    def keys(self) -> List[str]:
        return list(self._keys)

    def __repr__(self) -> str:                      # pragma: no cover — débogage
        return f"<ElpisRow {dict(zip(self._keys, self))!r}>"


@functools.lru_cache(maxsize=512)
def row_class(names: Tuple[str, ...]) -> type:
    index = {}
    for i, n in enumerate(names):
        index.setdefault(n, i)
        index.setdefault(n.lower(), i)
    return type("ElpisRow", (ElpisRow,), {"__slots__": (), "_keys": names, "_index": index})


def to_python(v: Any) -> Any:
    """Valeur relue → type que rendrait SQLite."""
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, decimal.Decimal):
        if v == v.to_integral_value():
            return int(v)
        return float(v)
    if isinstance(v, memoryview):
        return bytes(v)
    return v


def adapt_params(params: Any, strip_nul: bool = False) -> Any:
    """Paramètres → valeurs que le moteur accepte comme SQLite les stockait."""
    if params is None:
        return ()
    if isinstance(params, dict):
        return {k: _adapt_one(v, strip_nul) for k, v in params.items()}
    return tuple(_adapt_one(v, strip_nul) for v in params)


def _adapt_one(v: Any, strip_nul: bool) -> Any:
    if isinstance(v, bool):
        return int(v)
    if strip_nul and isinstance(v, str) and "\x00" in v:
        return v.replace("\x00", "")
    return v


# ─────────────────────────────────────────────────────────────────────────────
#  Classification des instructions
# ─────────────────────────────────────────────────────────────────────────────

_WORD = re.compile(r"\s*(?:--[^\n]*\n\s*|/\*.*?\*/\s*)*([A-Za-z]+)", re.S)
_DML = {"INSERT", "UPDATE", "DELETE", "REPLACE", "MERGE"}
_DDL = {"CREATE", "ALTER", "DROP", "TRUNCATE", "RENAME"}


def first_word(sql: str) -> str:
    m = _WORD.match(sql)
    return m.group(1).upper() if m else ""


# ─────────────────────────────────────────────────────────────────────────────
#  Curseur et connexion
# ─────────────────────────────────────────────────────────────────────────────

class ServerCursor:
    """Sous-ensemble de ``sqlite3.Cursor`` utilisé par l'application."""

    def __init__(self, conn: "ServerConnection"):
        self.connection = conn
        self._rows: List[Any] = []
        self._pos = 0
        self.rowcount = -1
        self.description = None
        self.arraysize = 1
        self._lastrowid = None

    # Remplis par ServerConnection._run
    def _set(self, names: Optional[Sequence[str]], rows: Optional[List[Sequence[Any]]],
             rowcount: int) -> None:
        if names:
            cls = row_class(tuple(names))
            self._rows = [cls(to_python(v) for v in r) for r in (rows or ())]
            self.description = tuple((n, None, None, None, None, None, None) for n in names)
        else:
            self._rows = []
            self.description = None
        self._pos = 0
        self.rowcount = rowcount

    def execute(self, sql: str, params: Any = ()) -> "ServerCursor":
        self.connection._run(self, sql, params)
        return self

    def executemany(self, sql: str, seq: Iterable[Any]) -> "ServerCursor":
        self.connection._run_many(self, sql, seq)
        return self

    def fetchone(self):
        if self._pos >= len(self._rows):
            return None
        r = self._rows[self._pos]
        self._pos += 1
        return r

    def fetchmany(self, size: Optional[int] = None):
        n = size or self.arraysize
        out = self._rows[self._pos:self._pos + n]
        self._pos += len(out)
        return out

    def fetchall(self):
        out = self._rows[self._pos:]
        self._pos = len(self._rows)
        return out

    def __iter__(self):
        while True:
            r = self.fetchone()
            if r is None:
                return
            yield r

    @property
    def lastrowid(self):
        if self.connection.dialect == "mysql":
            return self._lastrowid
        raise ServerProgrammingError(
            "lastrowid n'existe pas en PostgreSQL : utiliser "
            "shared_infra.db._dialect.insert_id() (RETURNING id).")

    def close(self) -> None:
        self._rows = []


class ServerConnection:
    """Base des connexions PostgreSQL / MySQL. Les sous-classes fournissent
    ``_exec(sql, params, many)`` → (noms de colonnes, lignes, rowcount),
    ``_raw_begin/_raw_commit/_raw_rollback`` et ``_map_error(exc)``."""

    dialect = "server"
    strip_nul = False

    def __init__(self, raw: Any):
        self.raw = raw
        self._in_tx = False
        self._isolation: Optional[str] = ""
        self.row_factory = sqlite3.Row          # accepté, sans effet (ElpisRow)
        self.broken = False
        self.release: Optional[Callable[["ServerConnection"], None]] = None
        self._locks_ready = False               # table elpis_locks vérifiée (begin_write)

    # ── API sqlite3 ─────────────────────────────────────────────────────────
    @property
    def in_transaction(self) -> bool:
        return self._in_tx

    @property
    def isolation_level(self) -> Optional[str]:
        return self._isolation

    @isolation_level.setter
    def isolation_level(self, value: Optional[str]) -> None:
        if value is None and self._in_tx:
            self.commit()                       # comme sqlite3
        self._isolation = value

    def cursor(self) -> ServerCursor:
        return ServerCursor(self)

    def execute(self, sql: str, params: Any = ()) -> ServerCursor:
        return self.cursor().execute(sql, params)

    def executemany(self, sql: str, seq: Iterable[Any]) -> ServerCursor:
        return self.cursor().executemany(sql, seq)

    def executescript(self, script: str) -> ServerCursor:
        cur = self.cursor()
        for stmt in split_statements(script):
            cur.execute(stmt)
        return cur

    def commit(self) -> None:
        if self._in_tx:
            try:
                self._raw_commit()
            except Exception as exc:
                self._in_tx = False
                raise self._map_error(exc) from exc
            self._in_tx = False

    def rollback(self) -> None:
        if self._in_tx:
            try:
                self._raw_rollback()
            except Exception as exc:
                self._in_tx = False
                raise self._map_error(exc) from exc
            self._in_tx = False

    def close(self) -> None:
        """Rend la connexion (pool) ; ferme vraiment hors pool."""
        if self.release is not None:
            self.release(self)
        else:
            self.hard_close()

    def __enter__(self) -> "ServerConnection":
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        if exc_type is None:
            self.commit()
        else:
            try:
                self.rollback()
            except Exception:
                pass
        return False

    # ── Exécution ───────────────────────────────────────────────────────────
    def _before(self, sql: str) -> str:
        """Pose ``BEGIN`` avant la première écriture ; suit les BEGIN /
        COMMIT / ROLLBACK écrits en SQL par l'appelant. Rend le mot-clé."""
        word = first_word(sql)
        if word in _DML and not self._in_tx and self._isolation is not None:
            self._begin()
        elif word == "SAVEPOINT" and not self._in_tx:
            self._begin()                       # SQLite ouvre une transaction
        return word

    def _after(self, word: str, sql: str) -> None:
        if word in ("BEGIN", "START"):
            self._in_tx = True
        elif word in ("COMMIT", "END"):
            self._in_tx = False
        elif word == "ROLLBACK" and not re.match(r"\s*ROLLBACK\s+TO\b", sql, re.I):
            self._in_tx = False
        elif word in _DDL and self.dialect == "mysql":
            self._in_tx = False                 # le DDL valide implicitement en MySQL

    def _begin(self) -> None:
        try:
            self._raw_begin()
        except Exception as exc:
            raise self._map_error(exc) from exc
        self._in_tx = True

    def _run(self, cur: ServerCursor, sql: str, params: Any) -> None:
        word = self._before(sql)
        if word == "PRAGMA":
            raise ServerOperationalError(f"PRAGMA propre à SQLite : {sql.strip()[:60]}")
        try:
            names, rows, rowcount = self._exec(sql, adapt_params(params, self.strip_nul), False)
        except Exception as exc:
            raise self._map_error(exc) from exc
        self._after(word, sql)
        cur._set(names, rows, rowcount)
        cur._lastrowid = getattr(self, "_last_insert_id", None)

    def _run_many(self, cur: ServerCursor, sql: str, seq: Iterable[Any]) -> None:
        word = self._before(sql)
        batch = [adapt_params(p, self.strip_nul) for p in seq]
        try:
            names, rows, rowcount = self._exec(sql, batch, True)
        except Exception as exc:
            raise self._map_error(exc) from exc
        self._after(word, sql)
        cur._set(names, rows, rowcount)

    # ── À fournir par le moteur ─────────────────────────────────────────────
    def _exec(self, sql: str, params: Any, many: bool):      # pragma: no cover
        raise NotImplementedError

    def _raw_begin(self) -> None:                             # pragma: no cover
        raise NotImplementedError

    def _raw_commit(self) -> None:                            # pragma: no cover
        raise NotImplementedError

    def _raw_rollback(self) -> None:                          # pragma: no cover
        raise NotImplementedError

    def _map_error(self, exc: BaseException) -> BaseException:   # pragma: no cover
        raise NotImplementedError

    def ping(self) -> bool:                                   # pragma: no cover
        raise NotImplementedError

    def reset(self) -> None:
        """Remise à neuf avant retour au pool."""
        if self._in_tx:
            try:
                self.rollback()
            except Exception:
                self.broken = True
        self._isolation = ""

    def hard_close(self) -> None:
        try:
            self.raw.close()
        except Exception:
            pass


def split_statements(script: str) -> List[str]:
    """Découpe un script SQL sur les « ; » hors littéraux et commentaires."""
    out, buf, i, n = [], [], 0, len(script)
    quote = None
    while i < n:
        ch = script[i]
        if quote:
            buf.append(ch)
            if ch == quote:
                if i + 1 < n and script[i + 1] == quote:
                    buf.append(script[i + 1])
                    i += 1
                else:
                    quote = None
        elif ch in ("'", '"', "`"):
            quote = ch
            buf.append(ch)
        elif ch == "-" and script.startswith("--", i):
            j = script.find("\n", i)
            j = n if j < 0 else j
            buf.append(script[i:j])
            i = j
            continue
        elif ch == ";":
            stmt = "".join(buf).strip()
            if stmt:
                out.append(stmt)
            buf = []
        else:
            buf.append(ch)
        i += 1
    stmt = "".join(buf).strip()
    if stmt:
        out.append(stmt)
    return out


__all__ = [
    "ServerError", "ServerIntegrityError", "ServerOperationalError", "ServerDataError",
    "ServerProgrammingError", "ElpisRow", "row_class", "to_python", "adapt_params",
    "first_word", "ServerCursor", "ServerConnection", "split_statements",
]
