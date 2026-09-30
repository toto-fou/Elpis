# SPDX-License-Identifier: MIT
"""Transfert des données d'une base Elpis vers une autre, entre n'importe
quels moteurs (SQLite, PostgreSQL, MariaDB/MySQL) — chantier multi-moteurs,
lot D.

Déroulé (``transfer``) :

1. contrôles : source au bout de sa chaîne de migrations, cible joignable et
   VIDE (aucune table) ;
2. schéma de référence + tampon des migrations sur la cible ;
3. copie table par table dans l'ordre des clés étrangères (celui de
   ``_schema.TABLES``), intersection des colonnes, lots d'INSERT multi-lignes,
   valeurs converties au type cible ; lignes orphelines (parent absent, que
   SQLite tolère sans contrainte active) écartées et comptées, jamais
   inventées ; tables inconnues du schéma (vestiges) listées et ignorées ;
4. identités / ``AUTO_INCREMENT`` recalés au-delà du maximum ;
5. vérification : comptes par table + empreinte des premières lignes.

La source est lue dans UNE transaction en lecture (instantané cohérent : WAL
en SQLite, REPEATABLE READ en PostgreSQL, instantané cohérent en MySQL).
Geler les écritures des autres process (mode maintenance) reste l'affaire de
l'appelant. ``dry_run`` s'arrête après les contrôles et les comptes.

Une cible se décrit par un dict : ``{"backend": "sqlite", "path": …}`` ou les
réglages d'un moteur serveur (``backend``, ``host``, ``port``, ``name``,
``user``, ``password``, ``tls``) ; ``parse_target`` lit la forme texte
(``sqlite:/chemin/app.db``, ``postgres://user@hôte:5432/base``,
``mysql://user@hôte:3306/base``).
"""
from __future__ import annotations

import hashlib
import logging
import sqlite3
import time
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple
from urllib.parse import parse_qs, unquote, urlsplit

from shared_infra.db import _schema
from shared_infra.db._dialect import MYSQL, POSTGRES, SQLITE, bytes_order, dialect_of, table_columns, table_names

log = logging.getLogger("uvicorn.error")

_BATCH_ROWS = 2000          # lignes lues par page
_MAX_PARAMS = 30000         # paramètres par INSERT multi-lignes (limites SQLite/PG)
_SAMPLE = 200               # lignes comparées par table à la vérification
_SKIP = {"schema_migrations", "elpis_locks"}


class TransferError(RuntimeError):
    """Contrôle préalable refusé : rien n'a été écrit sur la cible."""


# ── Cibles ───────────────────────────────────────────────────────────────────

_SCHEMES = {"postgres": POSTGRES, "postgresql": POSTGRES, "pg": POSTGRES,
            "mysql": MYSQL, "mariadb": MYSQL}


def parse_target(text: str, password: Optional[str] = None) -> Dict[str, Any]:
    """``sqlite:/chemin`` | ``postgres://user@hôte:port/base?tls=require`` |
    ``mysql://…``. Le mot de passe se passe à part (jamais dans l'historique
    du shell) ; un mot de passe présent dans l'URL est toléré."""
    text = (text or "").strip()
    if text.startswith("sqlite:"):
        path = text[len("sqlite:"):]
        if path.startswith("//"):
            path = path[2:]
        if not path:
            raise ValueError("chemin SQLite manquant (sqlite:/chemin/app.db)")
        return {"backend": SQLITE, "path": path}
    u = urlsplit(text)
    backend = _SCHEMES.get(u.scheme.lower())
    if backend is None or not u.hostname or not u.path.strip("/"):
        raise ValueError(f"cible illisible : {text!r} (attendu sqlite:/…, postgres://… ou mysql://…)")
    qs = parse_qs(u.query)
    return {"backend": backend, "host": u.hostname,
            "port": u.port or (5432 if backend == POSTGRES else 3306),
            "name": unquote(u.path.strip("/")), "user": unquote(u.username or "elpis"),
            "password": password if password is not None else unquote(u.password or ""),
            "tls": (qs.get("tls") or ["off"])[0], "timeout": 60.0, "schema": None}


def describe(target: Dict[str, Any]) -> str:
    """Forme lisible SANS mot de passe (journaux, rapport)."""
    if target["backend"] == SQLITE:
        return f"sqlite:{target['path']}"
    out = f"{target['backend']}://{target['user']}@{target['host']}:{target['port']}/{target['name']}"
    return out + (f"#{target['schema']}" if target.get("schema") else "")


def active_target() -> Dict[str, Any]:
    """La base qu'utilise ce process (config + environnement)."""
    from shared_infra.db import _connection as C
    if C.DB_BACKEND == SQLITE:
        return {"backend": SQLITE, "path": str(C.DB_PATH)}
    return dict(C.server_settings())


def connect(target: Dict[str, Any]):
    """Connexion NEUVE, hors pool, en autocommit (transactions explicites)."""
    if target["backend"] == SQLITE:
        conn = sqlite3.connect(target["path"], timeout=30, isolation_level=None,
                               check_same_thread=False)
        conn.execute("PRAGMA busy_timeout=30000")
        return conn
    from shared_infra.db._connection import connect_server
    settings = dict(target)
    if not settings.get("password"):
        settings.pop("password", None)          # repli : mot de passe de la config
    conn = connect_server(settings)
    conn.isolation_level = None
    return conn


def _close(conn) -> None:
    try:
        if hasattr(conn, "hard_close"):
            conn.hard_close()
        else:
            conn.close()
    except Exception:
        pass


def server_version(conn) -> str:
    d = dialect_of(conn)
    try:
        if d == SQLITE:
            return "SQLite " + conn.execute("SELECT sqlite_version()").fetchone()[0]
        if d == POSTGRES:
            return conn.execute("SELECT version()").fetchone()[0].split(" on ")[0]
        return conn.execute("SELECT VERSION()").fetchone()[0]
    except Exception as exc:                          # pragma: no cover — diagnostic
        return f"? ({exc})"


# ── Lecture ──────────────────────────────────────────────────────────────────

def _q(conn, name: str) -> str:
    return _schema._q_mysql(name) if dialect_of(conn) == MYSQL else _schema.q(name)


def _begin_snapshot(conn, freeze: bool = False) -> None:
    """Instantané cohérent de la source. freeze (bascule) bloque en plus
    les écritures des autres process jusqu'à la fin de la lecture : verrou
    d'écriture en SQLite, SHARE sur chaque table en PostgreSQL. MySQL n'a
    pas d'équivalent sans privilège RELOAD : le mode maintenance et la
    garde de génération y suffisent."""
    d = dialect_of(conn)
    if d == SQLITE:
        conn.execute("BEGIN IMMEDIATE" if freeze else "BEGIN")
    elif d == POSTGRES:
        if freeze:
            conn.execute("BEGIN ISOLATION LEVEL REPEATABLE READ")
            names = [n for n in table_names(conn) if n in {t.name for t in _schema.TABLES}]
            if names:
                conn.execute("LOCK TABLE " + ", ".join(_schema.q(n) for n in names)
                             + " IN SHARE MODE")
        else:
            conn.execute("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
    else:
        conn.execute("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY")


def _end_snapshot(conn) -> None:
    try:
        conn.execute("ROLLBACK")
    except Exception:
        pass


def _count(conn, table: str) -> int:
    return int(conn.execute(f"SELECT COUNT(*) FROM {_q(conn, table)}").fetchone()[0])


def _order_key(t: "_schema.Table") -> Tuple[str, ...]:
    if t.pk:
        return t.pk
    for c in t.cols:
        if c.primary or c.type == _schema.ID:
            return (c.name,)
    return tuple(c.name for c in t.cols)


def _pages(conn, t, cols: Sequence[str]) -> Iterable[List[tuple]]:
    """Lignes de ``t`` par pages, dans l'ordre de la clé (reproductible)."""
    qc = ", ".join(_q(conn, c) for c in cols)
    order = ", ".join(_q(conn, c) for c in _order_key(t))
    base = f"SELECT {qc} FROM {_q(conn, t.name)} ORDER BY {order}"
    offset = 0
    while True:
        rows = conn.execute(f"{base} LIMIT {_BATCH_ROWS} OFFSET {offset}").fetchall()
        if not rows:
            return
        yield [tuple(r) for r in rows]
        if len(rows) < _BATCH_ROWS:
            return
        offset += len(rows)


def _sample(conn, t, cols: Sequence[str]) -> List[tuple]:
    """Les ``_SAMPLE`` premières lignes de ``t`` dans un ordre IDENTIQUE sur
    tous les moteurs : clés texte comparées octet par octet. Trié selon la
    collation du serveur (PostgreSQL en ``fr_FR``/``en_US``), l'échantillon
    comparé à celui de SQLite n'était pas le même et la vérification refusait
    un transfert correct (2026-09-27)."""
    d = dialect_of(conn)
    kinds = {c.name: c.type for c in t.cols}
    order = ", ".join(
        bytes_order(_q(conn, c), d) if kinds.get(c) in (_schema.TEXT, _schema.TEXT_CI)
        else _q(conn, c) for c in _order_key(t))
    qc = ", ".join(_q(conn, c) for c in cols)
    sql = f"SELECT {qc} FROM {_q(conn, t.name)} ORDER BY {order} LIMIT {int(_SAMPLE)}"
    return [tuple(r) for r in conn.execute(sql).fetchall()]


# ── Conversion ───────────────────────────────────────────────────────────────

def _col_kind(c, dialect: str) -> str:
    typ = (c.types or {}).get(dialect, c.type)
    return {_schema.ID: "int", _schema.INT: "int", _schema.REAL: "real"}.get(typ, "text")


def _coerce(v: Any, kind: str) -> Any:
    """Valeur source → type cible. SQLite stocke ce qu'on lui donne (texte
    dans une colonne entière…) ; PG et MySQL en mode strict refusent."""
    if v is None:
        return None
    if kind == "int":
        if isinstance(v, bool):
            return int(v)
        if isinstance(v, int):
            return v
        if isinstance(v, float) and v.is_integer():
            return int(v)
        s = str(v).strip()
        try:
            return int(s)
        except ValueError:
            f = float(s)                       # « 3.0 » ; lève sinon (ligne rejetée)
            if not f.is_integer():
                raise ValueError(f"entier attendu : {v!r}")
            return int(f)
    if kind == "real":
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            return float(v)
        return float(str(v).strip())
    if isinstance(v, (bytes, bytearray, memoryview)):
        return bytes(v).decode("utf-8", errors="replace")
    return v if isinstance(v, str) else str(v)


def _norm(v: Any) -> str:
    """Forme comparable d'une valeur, quel que soit le moteur qui la rend."""
    if v is None:
        return "∅"
    if isinstance(v, float):
        return repr(int(v)) if v.is_integer() else f"{v:.9g}"
    if isinstance(v, (bytes, bytearray, memoryview)):
        return bytes(v).decode("utf-8", errors="replace")
    return str(v)


# ── Écriture ─────────────────────────────────────────────────────────────────

def _insert_rows(conn, table: str, cols: Sequence[str], rows: List[tuple]) -> None:
    if not rows:
        return
    per = max(1, min(500, _MAX_PARAMS // max(1, len(cols))))
    head = f"INSERT INTO {_q(conn, table)} ({', '.join(_q(conn, c) for c in cols)}) VALUES "
    one = "(" + ", ".join("?" for _ in cols) + ")"
    for i in range(0, len(rows), per):
        chunk = rows[i:i + per]
        params = [v for r in chunk for v in r]
        conn.execute(head + ", ".join([one] * len(chunk)), params)


def _reset_identity(conn, t) -> None:
    ids = [c.name for c in t.cols if c.type == _schema.ID]
    if not ids:
        return
    col = ids[0]
    d = dialect_of(conn)
    top = conn.execute(f"SELECT MAX({_q(conn, col)}) FROM {_q(conn, t.name)}").fetchone()[0]
    nxt = int(top or 0) + 1
    if d == POSTGRES:
        conn.execute(f"SELECT setval(pg_get_serial_sequence(?, ?), {nxt}, false)",
                     (_schema.q(t.name), col))
    elif d == MYSQL:
        conn.execute(f"ALTER TABLE {_q(conn, t.name)} AUTO_INCREMENT = {nxt}")
    # SQLite : ``sqlite_sequence`` suit tout seul les id explicites.


def _order_self_ref(rows: List[tuple], cols: Sequence[str], fk) -> List[tuple]:
    """Parents avant enfants pour une clé étrangère sur la table elle-même
    (``ax_nodes.parent_id``) : la contrainte est vérifiée ligne à ligne."""
    ic = cols.index(fk.ref_cols[0])
    pc = cols.index(fk.cols[0])
    pending, placed, out = list(rows), set(), []
    while pending:
        rest = []
        for r in pending:
            if r[pc] is None or r[pc] in placed:
                out.append(r)
                placed.add(r[ic])
            else:
                rest.append(r)
        if len(rest) == len(pending):          # cycle : cassé par l'appelant
            out.extend(rest)
            break
        pending = rest
    return out


# ── Transfert ────────────────────────────────────────────────────────────────

def _missing_migrations(conn) -> List[str]:
    from shared_infra.db import _migrations as M
    if "schema_migrations" not in set(table_names(conn)):
        return M._discover()
    done = {r[0] for r in conn.execute("SELECT name FROM schema_migrations").fetchall()}
    return [n for n in M._discover() if n not in done]


def check_target(target: Dict[str, Any]) -> Dict[str, Any]:
    """« Tester » : joignable ? version, tables présentes, latence."""
    t0 = time.perf_counter()
    conn = connect(target)
    try:
        latency_ms = (time.perf_counter() - t0) * 1000
        names = table_names(conn)
        t1 = time.perf_counter()
        conn.execute("SELECT 1").fetchone()
        rtt_ms = (time.perf_counter() - t1) * 1000
        out = {"ok": True, "target": describe(target), "version": server_version(conn),
               "tables": len(names), "empty": not names,
               "connect_ms": round(latency_ms, 1), "query_ms": round(rtt_ms, 2)}
        if dialect_of(conn) == MYSQL:
            out["max_allowed_packet"] = int(conn.execute(
                "SELECT @@max_allowed_packet").fetchone()[0])
        if dialect_of(conn) == POSTGRES:
            out["unaccent"] = conn.execute(
                "SELECT 1 FROM pg_available_extensions WHERE name='unaccent'").fetchone() is not None
        return out
    finally:
        _close(conn)


def transfer(source: Dict[str, Any], target: Dict[str, Any], *, dry_run: bool = False,
             freeze: bool = False, progress: Optional[Callable[[str, int, int], None]] = None) -> Dict[str, Any]:
    """Copie ``source`` → ``target`` (vide). Rend le rapport ; lève
    ``TransferError`` si un contrôle préalable échoue (cible intacte)."""
    started = time.time()
    report: Dict[str, Any] = {"source": describe(source), "target": describe(target),
                              "dry_run": dry_run, "tables": {}, "ignored": {},
                              "orphans": 0, "rejected": 0, "ok": False}
    if describe(source) == describe(target):
        raise TransferError("source et cible identiques")
    src = connect(source)
    dst = None
    try:
        missing = _missing_migrations(src)
        if missing:
            raise TransferError("source pas à jour (migrations non appliquées : "
                                + ", ".join(missing[:5]) + ") — démarrer l'application une fois")
        dst = connect(target)
        if table_names(dst):
            raise TransferError(f"cible non vide ({len(table_names(dst))} tables) : "
                                "le transfert exige une base vierge")
        d_dst = dialect_of(dst)
        report["source_version"] = server_version(src)
        report["target_version"] = server_version(dst)

        _begin_snapshot(src, freeze=freeze and not dry_run)
        present = set(table_names(src))
        known = {t.name for t in _schema.TABLES}
        for name in sorted(present - known - _SKIP):
            if name.startswith("session_messages_fts") or name.startswith("sqlite_"):
                continue
            try:
                report["ignored"][name] = _count(src, name)
            except Exception:
                report["ignored"][name] = None
        plan = [t for t in _schema.TABLES
                if t.name not in _SKIP and t.name in present
                and (t.only is None or d_dst in t.only)]

        if dry_run:
            for t in plan:
                src_cols = set(table_columns(src, t.name))
                report["tables"][t.name] = {
                    "source": _count(src, t.name),
                    "dropped_columns": sorted(src_cols - {c.name for c in t.cols})}
            report["ok"] = True
            return report

        # 2. Schéma + tampon (toutes les migrations connues de la source).
        _schema.create_all(dst)
        if dst.in_transaction:
            dst.execute("COMMIT")
        from shared_infra.db._migrations import stamp_baseline
        done = [r[0] for r in src.execute("SELECT name FROM schema_migrations").fetchall()]
        stamp_baseline(dst, sorted(set(done) | set(_schema.BASELINE_COVERS)))
        if d_dst == SQLITE:
            dst.execute("PRAGMA foreign_keys=OFF")

        # 3. Copie.
        copied_keys: Dict[str, set] = {}
        referenced = {(fk.table, fk.ref_cols) for t in _schema.TABLES for fk in t.fks}
        for t in plan:
            src_cols = table_columns(src, t.name)
            cols = [c.name for c in t.cols if c.name in src_cols]
            kinds = [_col_kind(t.col(c), d_dst) for c in cols]
            total = _count(src, t.name)
            fks = [fk for fk in t.fks if all(c in cols for c in fk.cols)]
            self_fks = [fk for fk in fks if fk.table == t.name]
            info = {"source": total, "copied": 0, "orphans": 0, "rejected": 0,
                    "dropped_columns": sorted(set(src_cols) - set(cols))}
            keep_keys = [rc for (tb, rc) in referenced if tb == t.name]

            def accept(r: tuple) -> Optional[tuple]:
                for fk in fks:  # noqa: B023 (même itération)
                    if fk.table == t.name:  # noqa: B023 (même itération)
                        continue
                    val = tuple(r[cols.index(c)] for c in fk.cols)  # noqa: B023 (même itération)
                    if any(v is None for v in val):
                        continue
                    parent = copied_keys.get(f"{fk.table}:{','.join(fk.ref_cols)}")
                    if parent is not None and val not in parent:
                        info["orphans"] += 1  # noqa: B023 (même itération)
                        return None
                try:
                    return tuple(_coerce(v, k) for v, k in zip(r, kinds))  # noqa: B023 (même itération)
                except (TypeError, ValueError) as exc:
                    info["rejected"] += 1  # noqa: B023 (même itération)
                    if info["rejected"] <= 5:  # noqa: B023 (même itération)
                        log.warning("[transfer] %s : ligne rejetée (%s)", t.name, exc)  # noqa: B023 (même itération)
                    return None

            batches = _pages(src, t, cols)
            if self_fks:                                # table petite : tout en mémoire
                everything = [r for page in batches for r in page]
                batches = [_order_self_ref(everything, cols, self_fks[0])]
            for page in batches:
                rows = [x for x in (accept(r) for r in page) if x is not None]
                if self_fks:
                    fk = self_fks[0]
                    ids = {r[cols.index(fk.ref_cols[0])] for r in rows}
                    pc = cols.index(fk.cols[0])
                    kept = []
                    for r in rows:
                        if r[pc] is not None and r[pc] not in ids:
                            info["orphans"] += 1
                        else:
                            kept.append(r)
                    rows = kept
                if d_dst != SQLITE:
                    dst.execute("BEGIN")
                else:
                    dst.execute("BEGIN IMMEDIATE")
                _insert_rows(dst, t.name, cols, rows)
                dst.execute("COMMIT")
                info["copied"] += len(rows)
                for rc in keep_keys:
                    idx = [cols.index(c) for c in rc]
                    copied_keys.setdefault(f"{t.name}:{','.join(rc)}", set()).update(
                        tuple(r[i] for i in idx) for r in rows)
                if progress:
                    progress(t.name, info["copied"], total)
            _reset_identity(dst, t)
            if dst.in_transaction:
                dst.execute("COMMIT")
            report["tables"][t.name] = info
            report["orphans"] += info["orphans"]
            report["rejected"] += info["rejected"]

        # 5. Vérification.
        mismatches = []
        for t in plan:
            info = report["tables"][t.name]
            n = _count(dst, t.name)
            info["target"] = n
            if n != info["copied"]:
                mismatches.append(f"{t.name}: {n} ≠ {info['copied']}")
                continue
            if info["orphans"] or info["rejected"]:
                continue                               # l'échantillon ne serait plus aligné
            cols = [c.name for c in t.cols if c.name in table_columns(src, t.name)]
            kinds = [_col_kind(t.col(c), d_dst) for c in cols]
            a = _sample(src, t, cols)
            b = _sample(dst, t, cols)
            ha = _digest([tuple(_coerce(v, k) for v, k in zip(r, kinds)) for r in a])
            hb = _digest(b)
            info["sample_ok"] = ha == hb
            if ha != hb:
                mismatches.append(f"{t.name}: échantillon différent")
        report["mismatches"] = mismatches
        report["ok"] = not mismatches
        return report
    finally:
        report["seconds"] = round(time.time() - started, 2)
        _end_snapshot(src)
        _close(src)
        if dst is not None:
            if dst.in_transaction:
                try:
                    dst.execute("ROLLBACK")
                except Exception:
                    pass
            _close(dst)


def _digest(rows: Iterable[tuple]) -> str:
    h = hashlib.sha256()
    for r in rows:
        h.update("\x1f".join(_norm(v) for v in r).encode("utf-8"))
        h.update(b"\x1e")
    return h.hexdigest()


__all__ = ["TransferError", "active_target", "check_target", "connect", "describe",
           "parse_target", "server_version", "transfer"]
