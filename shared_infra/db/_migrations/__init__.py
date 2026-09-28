# SPDX-License-Identifier: MIT
"""
shared_infra/db/_migrations — Framework de migration DB idempotent.

Pose une table ``schema_migrations(id, name UNIQUE, applied_at)`` et
applique en ordre les modules ``00xx_*.py`` qui n'ont pas encore tourné.
Chaque module doit exposer une fonction ``migrate(conn)`` qui prend une
connexion ouverte et fait ses modifications **sans commit** (le runner ouvre
une transaction par migration, sous verrou d'écriture, et la valide avec le
tampon).

Base NEUVE : le schéma de référence (``shared_infra/db/_schema.py``) la crée
d'un coup et les migrations qu'il contient déjà sont tamponnées
(``stamp_baseline``) au lieu d'être rejouées. Règle : une nouvelle migration
met à jour ce schéma ET s'ajoute à ``BASELINE_COVERS``.

Invocation
==========
Depuis :func:`shared_infra.db._connection.init_db` après les ``CREATE TABLE`` :

    from shared_infra.db._migrations import run_pending
    run_pending(conn)

Conventions
===========
- Chaque migration est rangée dans un fichier nommé ``00NN_short_name.py``
  où ``NN`` détermine l'ordre d'application (lex sort).
- Une fois appliquée et taggée dans ``schema_migrations``, une migration
  n'est plus jamais ré-exécutée — la mutation doit être idempotente OU
  protégée par un test "already done".
- Pour rollback : un fichier compagnon ``00NN_*_rollback.py`` peut être
  fourni, mais le framework ne le lance JAMAIS automatiquement (la
  décision appartient à l'opérateur).
"""
from __future__ import annotations

import importlib
import logging
import pkgutil
import sqlite3
import time
from typing import List

logger = logging.getLogger("uvicorn.error")


def _ensure_schema_migrations_table(conn: sqlite3.Connection) -> None:
    # Même DDL que le schéma de référence (rendu pour le moteur de ``conn``).
    from shared_infra.db._dialect import dialect_of
    from shared_infra.db._schema import TABLES_BY_NAME, create_table_sql
    conn.execute(create_table_sql(TABLES_BY_NAME["schema_migrations"], dialect_of(conn)))


def _applied(conn: sqlite3.Connection) -> set[str]:
    _ensure_schema_migrations_table(conn)
    cur = conn.execute("SELECT name FROM schema_migrations")
    return {row[0] for row in cur.fetchall()}


def _discover() -> List[str]:
    """Liste les modules de migration triés par nom (ordre d'application)."""
    pkg_name = __name__
    pkg = importlib.import_module(pkg_name)
    names: List[str] = []
    for _, modname, _ in pkgutil.iter_modules(pkg.__path__):
        if not modname[0].isdigit():
            continue  # ignore les non-migrations (rollback, helpers)
        if modname.endswith("_rollback"):
            continue
        names.append(modname)
    names.sort()
    return names


def _stamp(conn, name: str) -> None:
    conn.execute(
        "INSERT INTO schema_migrations(name, applied_at) VALUES(?, ?) "
        "ON CONFLICT(name) DO NOTHING",
        (name, time.time()),
    )


def stamp_baseline(conn, names) -> int:
    """Base NEUVE créée d'un coup par le schéma de référence : on inscrit les
    migrations qu'il contient déjà (``BASELINE_COVERS``) sans les rejouer.
    Rend le nombre de noms inscrits."""
    _ensure_schema_migrations_table(conn)
    before = _applied(conn)
    for name in names:
        _stamp(conn, name)
    conn.commit()
    return len(set(names) - before)


def run_pending(conn: sqlite3.Connection) -> int:
    """Applique en ordre toutes les migrations non encore taggées.

    Retourne le nombre de migrations effectivement appliquées. Les erreurs
    sont loggées et la migration en cours est rollbackée — les migrations
    suivantes ne sont pas tentées.

    (2026-09-26) Chaque migration tourne dans SA transaction, prise avec le
    verrou d'écriture (``begin_write`` : ``BEGIN IMMEDIATE`` en SQLite), et la
    liste des migrations appliquées est RELUE sous ce verrou : plusieurs
    workers démarrent ensemble, un seul applique, les autres voient le
    tampon. Avant, le mode historique de sqlite3 n'ouvrait pas de transaction
    pour le DDL — un ``ALTER TABLE`` survivait au rollback d'une migration en
    échec.
    """
    from shared_infra.db._dialect import begin_write

    applied = _applied(conn)
    pending = [m for m in _discover() if m not in applied]
    if not pending:
        return 0

    from shared_infra.db._dialect import MYSQL, POSTGRES, dialect_of
    dialect = dialect_of(conn)

    n = 0
    previous = conn.isolation_level
    if conn.in_transaction:
        conn.commit()
    conn.isolation_level = None             # transactions pilotées ici
    # Moteurs serveur : verrou de SESSION pour toute la passe (le DDL de MySQL
    # valide implicitement et romprait un verrou de transaction), relâché en
    # sortie ; SQLite : ``BEGIN IMMEDIATE`` par migration suffit.
    if dialect == POSTGRES:
        conn.execute("SELECT pg_advisory_lock(727733001)")
    elif dialect == MYSQL:
        conn.execute("SELECT GET_LOCK('elpis_migrations', 300)")
    try:
        for name in pending:
            full = f"{__name__}.{name}"
            try:
                mod = importlib.import_module(full)
            except Exception as exc:
                logger.error("[migrations] cannot import %s: %s", full, exc)
                return n
            fn = getattr(mod, "migrate", None)
            if fn is None:
                logger.error("[migrations] %s has no migrate(conn) — skipping", full)
                continue
            try:
                begin_write(conn)
                if name in _applied(conn):          # un autre worker l'a faite
                    conn.execute("COMMIT")
                    continue
                logger.info("[migrations] applying %s", name)
                fn(conn)
                # Une migration peut avoir validé elle-même (PRAGMA hors
                # transaction, cf. 0003) : on ne referme que ce qui est ouvert.
                _stamp(conn, name)
                if conn.in_transaction:
                    conn.execute("COMMIT")
                n += 1
            except Exception as exc:
                logger.error("[migrations] %s FAILED: %s — rolling back", name, exc)
                try:
                    if conn.in_transaction:
                        conn.execute("ROLLBACK")
                except Exception:
                    pass
                return n
        return n
    finally:
        try:
            if dialect == POSTGRES:
                conn.execute("SELECT pg_advisory_unlock(727733001)")
            elif dialect == MYSQL:
                conn.execute("SELECT RELEASE_LOCK('elpis_migrations')")
        except Exception:
            pass
        try:
            conn.isolation_level = previous
        except Exception:
            pass


__all__ = ["run_pending", "stamp_baseline"]
