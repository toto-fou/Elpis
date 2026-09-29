# SPDX-License-Identifier: MIT
import logging

logger = logging.getLogger("uvicorn.error")
import json
import os
import sqlite3
import threading
import time
from contextlib import contextmanager

# Importé sous alias : ce module expose tout son espace de noms via la façade
# ``shared_infra.db``, et un nom aussi générique que ``swallow`` y deviendrait
# public par accident.
from pathlib import Path as _Path
from typing import Any, Dict, Iterator, Optional

# Moteur de la base (sqlite | postgres | mysql) — relu à chaque emprunt, les
# tests le re-pointent comme DB_PATH.
from shared_infra.config import DB_BACKEND, DB_PATH, METRICS_RETENTION_DAYS, PROJECT_ROOT as _PROJECT_ROOT
from shared_infra.observability.tracing import swallow as _swallow

# ─────────────────────────────────────────────────────────────────────────────
#  Connexion SQLite — une par thread, réutilisée
# ─────────────────────────────────────────────────────────────────────────────
# Ouvrir une connexion coûtait 900 µs, et ``db()`` est appelée depuis 241
# endroits — au moins deux fois par requête authentifiée mutante
# (``_session_validity_checks`` puis la gate ``must_change_pwd``), et une fois
# par appel d'outil dans la boucle du harnais.
#
# Le coût N'EST PAS dans les PRAGMA ni dans ``connect()`` — qui est paresseux —
# mais dans le PREMIER statement qui touche réellement le fichier : SQLite
# parse alors tout ``sqlite_master``. Mesures sur cette base :
#
#     connect() + close(), aucun statement          62 µs
#     connect() + "SELECT 1" (ne touche pas la DB)  50 µs
#     petite base (1 table)   + SELECT             195 µs
#     app.db (40 tables)      + SELECT             896 µs   ← ce qu'on payait
#     connexion RÉUTILISÉE    + SELECT               4 µs
#
# Le coût suit donc la taille du schéma, et aucun réglage ne le réduit : il
# faut cesser de rouvrir. On garde une connexion par (thread, PID, chemin).
#
# Contrat des appelants INCHANGÉ : ``close()`` reste l'appel à faire, il rend
# simplement la connexion au lieu de la détruire. Les ~15 sites en
# ``conn = db() ... conn.close()`` et les 241 en ``with db_conn()`` marchent
# sans modification.
_pool = threading.local()


class _PooledConnection(sqlite3.Connection):
    """Connexion dont ``close()`` REND au pool au lieu de fermer.

    Indispensable pour ne pas avoir à toucher les sites d'appel : beaucoup
    font ``conn = db()`` puis ``conn.close()`` dans un ``finally``.
    """

    def close(self) -> None:      # noqa: D102 — cf. docstring de classe
        _release(self)

    def _hard_close(self) -> None:
        """Fermeture RÉELLE — réservée au pool lui-même."""
        super().close()


def _sanitize(conn: sqlite3.Connection) -> None:
    """Rend la connexion à son état neuf.

    Sans ça, le partage ferait fuiter l'état d'un emprunteur vers le suivant :

    * une transaction laissée ouverte — aujourd'hui un ``close()`` la
      rollbackait, il faut donc rollbacker explicitement pour ne rien changer ;
    * ``isolation_level = None``, que trois fonctions posent pour piloter leurs
      transactions à la main (``chats.py:192``, ``users.py:299``,
      ``routines.py:602``) et qui, propagé, mettrait le code suivant en
      autocommit à son insu ;
    * ``row_factory``, sur lequel tout le code compte pour l'accès par nom.
    """
    # Instrumenté plutôt que muet : un rollback qui échoue ICI est justement le
    # scénario que le partage rend dangereux — l'emprunteur suivant hériterait
    # de la transaction restée ouverte. C'est le genre de cas qu'on veut voir
    # remonter dans le palmarès admin, pas découvrir par une incohérence.
    with _swallow("db.pool_sanitize_rollback"):
        if conn.in_transaction:
            conn.rollback()
    conn.isolation_level = ""          # défaut Python : BEGIN implicite avant DML
    conn.row_factory = sqlite3.Row


def _release(conn: "_PooledConnection") -> None:
    depth = getattr(_pool, "depth", 0) - 1
    _pool.depth = max(0, depth)
    if _pool.depth == 0:
        if getattr(conn, "dialect", "sqlite") != "sqlite":
            _release_server(conn)
            return
        _sanitize(conn)


# Profondeur au-delà de laquelle on soupçonne un ``db()`` sans ``close()``.
# Mesurée sur les 2 545 tests qui touchent la base : la profondeur maximale
# atteinte est 2, exclusivement par ``init_db`` → ``init_tool_metrics_db`` (et
# ses cinq jumeaux), et elle retombe toujours à 0. Un dépassement franc de ce
# seuil ne peut donc venir que d'un emprunt jamais rendu — qui, contrairement à
# l'ancien code où la connexion fuyait sans conséquence fonctionnelle, ferait
# ici rejoindre la transaction de l'étourdi par l'appelant suivant. On ne
# corrige pas d'office (on ne saurait pas QUOI annuler), on rend le symptôme
# visible dans les logs plutôt que silencieux.
_POOL_DEPTH_ALARM = 8


_gen_checked_at = 0.0
_gen_stale = False


def _db_generation() -> int:
    from shared_infra import config as _cfg
    return int(getattr(_cfg, "DB_GENERATION", 0) or 0)


def _generation_guard() -> None:
    """Refuse l'emprunt quand la base a été basculée depuis le démarrage du
    process (``database.generation`` de config.json > celle de l'import) : un
    ancien worker qui finit un run après le rechargement écrirait sinon dans
    l'ANCIENNE base, et ces écritures seraient perdues. Lecture de config.json
    au plus une fois par seconde ; l'état « périmé » est définitif."""
    global _gen_checked_at, _gen_stale
    if _gen_stale:
        raise sqlite3.OperationalError(
            "base de données basculée : ce processus doit être rechargé")
    now = time.monotonic()
    if now - _gen_checked_at < 1.0:
        return
    _gen_checked_at = now
    try:
        from shared_infra.config import config_view
        published = int(((config_view().get("database") or {}).get("generation")) or 0)
    except Exception:
        return
    if published > _db_generation():
        _gen_stale = True
        logger.error("[db] base basculée (génération %d > %d) : emprunts refusés "
                     "jusqu'au rechargement de ce processus.", published, _db_generation())
        raise sqlite3.OperationalError(
            "base de données basculée : ce processus doit être rechargé")


def db() -> sqlite3.Connection:
    """Connexion du thread courant. À rendre avec ``close()``.

    Réentrante : un appel imbriqué (``init_db`` appelle six ``init_*_db``)
    reçoit la MÊME connexion, et seul le dernier ``close()`` la nettoie.

    CONTRAT — tout ``db()`` doit être suivi d'un ``close()``, idéalement via
    ``db_conn()``. C'était déjà vrai avant (sinon la connexion fuyait) ; ça le
    reste, avec une conséquence différente en cas d'oubli, cf.
    ``_POOL_DEPTH_ALARM``.
    """
    _generation_guard()
    if DB_BACKEND != "sqlite":
        return _db_server()
    # La clé porte le PID — une connexion héritée d'un fork gunicorn
    # corromprait la base — et le CHEMIN, que les tests monkeypatchent vers un
    # fichier temporaire : changer DB_PATH retire donc naturellement l'ancienne
    # connexion du pool, sans que les tests aient à s'en occuper.
    key = (os.getpid(), str(DB_PATH))
    conn: Optional[_PooledConnection] = getattr(_pool, "conn", None)
    if conn is not None and getattr(_pool, "key", None) == key:
        depth = getattr(_pool, "depth", 0)
        if depth == 0:
            # Nettoyage à l'EMPRUNT, pas seulement au rendu : un appelant qui
            # oublierait son ``close()`` ne peut pas contaminer le suivant.
            _sanitize(conn)
        _pool.depth = depth + 1
        if _pool.depth == _POOL_DEPTH_ALARM:
            logger.warning(
                "[db] profondeur d'emprunt = %d sur le thread %s — un appel à "
                "db() n'a probablement pas été suivi de close(). La connexion "
                "est partagée : l'appelant suivant hériterait de la "
                "transaction restée ouverte.",
                _pool.depth, threading.current_thread().name,
                stack_info=True,
            )
        return conn

    if conn is not None:
        try:
            conn._hard_close()
        except Exception:
            pass

    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30, factory=_PooledConnection)
    conn.row_factory = sqlite3.Row
    try:
        # ``journal_mode`` est une propriété PERSISTANTE du fichier : la poser
        # ici ne sert qu'au tout premier boot sur une base neuve. Les trois
        # autres sont bien par-connexion, donc posées une fois par connexion
        # du pool — au lieu d'une fois par appel.
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        conn.execute("PRAGMA foreign_keys=ON;")
        conn.execute("PRAGMA busy_timeout=10000;")
    except Exception:
        pass
    _pool.key, _pool.conn, _pool.depth = key, conn, 1
    return conn


def reset_pool() -> None:
    """Ferme RÉELLEMENT la connexion du thread courant — et, pour un moteur
    serveur, TOUTES les connexions inactives des pools du process.

    Pour les tests qui suppriment le fichier de base, et pour le shutdown.
    """
    conn = getattr(_pool, "conn", None)
    if conn is not None:
        try:
            if hasattr(conn, "_hard_close"):
                conn._hard_close()
            else:
                conn.hard_close()
        except Exception:
            pass
    _pool.key, _pool.conn, _pool.depth = None, None, 0
    with _server_pools_lock:
        pools = list(_server_pools.values())
        _server_pools.clear()
    for p in pools:
        p.close_all()


# ─────────────────────────────────────────────────────────────────────────────
#  Moteurs serveur (PostgreSQL, MariaDB/MySQL) — pool borné par process
# ─────────────────────────────────────────────────────────────────────────────
# Même contrat que SQLite pour les appelants : ``db()`` réentrant par thread
# (la connexion d'un appel imbriqué est la même), ``close()`` rend. La
# différence : au dernier ``close()`` la connexion est remise à neuf (rollback
# de ce qui traîne, verrous consultatifs relâchés) et RENDUE au pool du
# process, au lieu de rester attachée au thread — un serveur facture chaque
# connexion ouverte, pas SQLite.
_server_pools: Dict[tuple, Any] = {}
_server_pools_lock = threading.Lock()


def server_settings() -> Dict[str, Any]:
    """Paramètres de connexion du moteur serveur, lus à l'emprunt."""
    from shared_infra import config as _cfg
    return {"backend": DB_BACKEND, "host": _cfg.DB_HOST, "port": _cfg.DB_PORT,
            "name": _cfg.DB_NAME, "user": _cfg.DB_USER, "tls": _cfg.DB_TLS,
            "timeout": _cfg.DB_TIMEOUT, "pool_max": _cfg.DB_POOL_MAX,
            "schema": _test_schema()}


def _test_schema() -> Optional[str]:
    """Mode test ``ELPIS_TEST_DB`` : chaque ``DB_PATH`` distinct reçoit sa
    propre base (MySQL) ou son propre schéma (PostgreSQL), comme chaque
    fichier SQLite temporaire était une base neuve. Hors test : None."""
    if not os.environ.get("ELPIS_TEST_DB"):
        return None
    import hashlib
    return "t_" + hashlib.sha1(str(DB_PATH).encode("utf-8")).hexdigest()[:16]


def connect_server(settings: Dict[str, Any]):
    """Connexion NEUVE (hors pool) au moteur serveur décrit par ``settings``."""
    from shared_infra import config as _cfg
    kwargs = dict(host=settings["host"], port=settings["port"], name=settings["name"],
                  user=settings["user"], password=settings.get("password", _cfg.db_password()),
                  tls=settings.get("tls", "off"), timeout=settings.get("timeout", 60.0),
                  schema=settings.get("schema"),
                  application=f"elpis-{os.environ.get('APP_MODE', 'main')}")
    if settings["backend"] == "postgres":
        from shared_infra.db import _pg
        return _pg.connect(**kwargs)
    if settings["backend"] == "mysql":
        from shared_infra.db import _mysql
        return _mysql.connect(**kwargs)
    raise ValueError(f"moteur serveur inconnu : {settings['backend']!r}")


def _server_pool(key: tuple, settings: Dict[str, Any]):
    with _server_pools_lock:
        pool = _server_pools.get(key)
        if pool is None:
            from shared_infra.db._pool import Pool
            if settings.get("schema"):
                _ensure_test_schema(settings)
            pool = Pool(lambda: connect_server(settings), max_size=settings["pool_max"],
                        timeout=max(10.0, float(settings["timeout"]) / 2))
            _server_pools[key] = pool
        return pool


def _ensure_test_schema(settings: Dict[str, Any]) -> None:
    """Crée le schéma (PG) ou la base (MySQL) de test s'il manque."""
    admin = dict(settings, schema=None)
    conn = connect_server(admin)
    try:
        if settings["backend"] == "postgres":
            conn.execute(f'CREATE SCHEMA IF NOT EXISTS "{settings["schema"]}"')
        else:
            conn.execute(f'CREATE DATABASE IF NOT EXISTS "{settings["schema"]}" '
                         "CHARACTER SET utf8mb4 COLLATE utf8mb4_bin")
    finally:
        conn.hard_close()


def _db_server():
    settings = server_settings()
    key = (os.getpid(), settings["backend"], settings["host"], settings["port"],
           settings["name"], settings["user"], settings["schema"])
    conn = getattr(_pool, "conn", None)
    if conn is not None and getattr(_pool, "key", None) == key:
        _pool.depth = getattr(_pool, "depth", 0) + 1
        if _pool.depth == _POOL_DEPTH_ALARM:
            logger.warning("[db] profondeur d'emprunt = %d sur le thread %s — un appel à "
                           "db() n'a probablement pas été suivi de close().",
                           _pool.depth, threading.current_thread().name, stack_info=True)
        return conn
    if conn is not None:
        # Connexion d'une autre cible (tests qui re-pointent la base) : on la
        # rend avant d'en emprunter une nouvelle.
        _pool.depth = 1
        _release(conn)
    pool = _server_pool(key, settings)
    conn = pool.get()
    conn.release = _release
    conn._pool = pool
    _pool.key, _pool.conn, _pool.depth = key, conn, 1
    return conn


def _release_server(conn) -> None:
    try:
        conn.reset()
    except Exception:
        conn.broken = True
    if getattr(_pool, "conn", None) is conn:
        _pool.key, _pool.conn = None, None
    pool = getattr(conn, "_pool", None)
    if pool is not None:
        pool.put(conn)
    else:
        conn.hard_close()


def pool_stats() -> Optional[Dict[str, Any]]:
    """État du pool du moteur serveur de ce process (None en SQLite)."""
    if DB_BACKEND == "sqlite":
        return None
    with _server_pools_lock:
        pools = list(_server_pools.values())
    if not pools:
        return {"max": server_settings()["pool_max"], "open": 0, "idle": 0, "in_use": 0}
    agg = {"max": 0, "open": 0, "idle": 0, "in_use": 0}
    for p in pools:
        for k, v in p.stats().items():
            agg[k] += v
    return agg



def db_info() -> Dict[str, Any]:
    """État de la base active (page admin, ``python -m shared_infra.db info``) :
    moteur, version, emplacement, taille, schéma, pool."""
    from shared_infra.db import transfer as _t
    from shared_infra.db._dialect import MYSQL, POSTGRES, dialect_of, has_table
    out: Dict[str, Any] = {"backend": DB_BACKEND, "location": _t.describe(_t.active_target()),
                           "generation": _db_generation()}
    with db_conn() as conn:
        d = dialect_of(conn)
        out["version"] = _t.server_version(conn)
        try:
            if d == POSTGRES:
                out["size_bytes"] = int(conn.execute(
                    "SELECT COALESCE(SUM(pg_total_relation_size(c.oid)), 0) FROM pg_class c "
                    "JOIN pg_namespace n ON n.oid = c.relnamespace "
                    "WHERE n.nspname = current_schema() AND c.relkind = 'r'").fetchone()[0])
            elif d == MYSQL:
                out["size_bytes"] = int(conn.execute(
                    "SELECT COALESCE(SUM(data_length + index_length), 0) "
                    "FROM information_schema.tables WHERE table_schema = DATABASE()").fetchone()[0])
            else:
                out["size_bytes"] = sum(os.path.getsize(p) for p in
                                        (DB_PATH, f"{DB_PATH}-wal") if os.path.exists(p))
        except Exception:
            out["size_bytes"] = None
        if has_table(conn, "schema_migrations"):
            row = conn.execute("SELECT COUNT(*), MAX(name) FROM schema_migrations").fetchone()
            out["migrations"], out["last_migration"] = int(row[0]), row[1]
        else:
            out["migrations"], out["last_migration"] = 0, None
    out["pool"] = pool_stats()
    return out


@contextmanager
def db_conn() -> "Iterator[sqlite3.Connection]":
    """Context manager autour de :func:`db` qui garantit la fermeture.

    Corrige la fuite systémique de connexions SQLite de l'ancien pattern
    ``conn = db() ; ... ; conn.close()`` : si une exception se produisait
    entre l'ouverture et le close, la connexion n'était jamais libérée,
    ce qui provoquait :

    * épuisement des file-descriptors sur un run de plusieurs semaines,
    * croissance illimitée du fichier ``.db-wal`` (le mode WAL ne peut
      pas être checkpointé tant que toutes les lectures sont fermées),
    * fuite mémoire directe (buffers Python/SQLite par connexion).

    Usage recommandé pour toutes les nouvelles fonctions DB::

        def list_stuff(uid):
            with db_conn() as conn:
                cur = conn.cursor()
                cur.execute("SELECT ...", (uid,))
                return cur.fetchall()

    ``conn.commit()`` reste à la charge de l'appelant (pas de commit
    implicite) pour préserver le comportement des fonctions migrées.
    La fermeture est garantie par le ``finally``, même si une exception
    survient ou si l'appelant fait un ``return`` anticipé.

    Depuis la mise en pool (cf. :func:`db`), ce ``close()`` REND la connexion
    au thread au lieu de la détruire. Rien ne change pour l'appelant, y compris
    sur le point qui compte : une transaction laissée ouverte est rollbackée,
    exactement comme le faisait la fermeture.
    """
    conn = db()
    try:
        yield conn
    finally:
        try:
            conn.close()
        except Exception:
            # Ne jamais laisser une exception de close masquer
            # l'exception réelle remontant du bloc ``with``.
            pass

@contextmanager
def db_tx() -> "Iterator[sqlite3.Connection]":
    """Transaction à commit implicite sur la connexion du pool : l'équivalent
    de ``with sqlite3.connect(...) as c`` (commit à la sortie normale, rollback
    sur exception), la connexion étant rendue au pool à la fin.

    Remplace les connexions privées qui comptaient sur ce comportement
    (``opencode/store.py``). Imbriquée dans une transaction déjà ouverte sur ce
    thread — la connexion est réentrante —, elle devient un point de
    sauvegarde : elle ne valide pas le travail de l'appelant et n'annule que
    le sien.
    """
    conn = db()
    savepoint = None
    try:
        if conn.in_transaction:
            savepoint = f"db_tx_{getattr(_pool, 'depth', 0)}"
            conn.execute(f"SAVEPOINT {savepoint}")
        yield conn
        if savepoint is None:
            conn.commit()
        elif conn.in_transaction:
            # Un ``commit()`` explicite dans le bloc a pu clore la transaction
            # de l'appelant (et le point de sauvegarde avec elle).
            conn.execute(f"RELEASE SAVEPOINT {savepoint}")
    except BaseException:
        with _swallow("db.tx_rollback"):
            if savepoint is None:
                conn.rollback()
            elif conn.in_transaction:
                conn.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
                conn.execute(f"RELEASE SAVEPOINT {savepoint}")
        raise
    finally:
        try:
            conn.close()
        except Exception:
            pass


@contextmanager
def db_autocommit() -> "Iterator[sqlite3.Connection]":
    """Connexion du pool en autocommit : chaque instruction est validée
    aussitôt, comme le faisait la connexion privée de la mémoire AX
    (``isolation_level=None``).

    Imbriquée dans une transaction ouverte sur ce thread, elle la REJOINT :
    passer ``isolation_level`` à None validerait de force la transaction de
    l'appelant. Le mode précédent est rétabli à la sortie, pour qu'un
    appelant extérieur ne se retrouve pas en autocommit à son insu.
    """
    conn = db()
    previous = conn.isolation_level
    switched = False
    try:
        if not conn.in_transaction and previous is not None:
            conn.isolation_level = None
            switched = True
        yield conn
    finally:
        if switched:
            with _swallow("db.autocommit_restore"):
                if conn.in_transaction:
                    conn.rollback()
                conn.isolation_level = previous
        try:
            conn.close()
        except Exception:
            pass


def _harden_data_perms() -> None:
    """Ferme la base aux autres comptes locaux : ``app.db`` et ses fichiers
    annexes en 0600, le dossier ``user_db/`` en 0700.

    Ils naissaient avec l'umask du lanceur (0002 sur un shell Debian, 0022
    sous systemd) : la base — comptes, conversations, mémoires — restait
    lisible par tout compte local. On resserre AVANT la première connexion,
    car SQLite recopie le mode de la base sur ``-wal``/``-shm`` en les créant.
    Le dossier n'est touché que s'il est bien ``<projet>/user_db`` : une base
    placée ailleurs (tmp de test, chemin personnalisé) ne fait jamais changer
    les droits du dossier qui la contient. Même motif que
    ``_harden_secret_file_mode`` (config.py)."""
    db_file = _Path(DB_PATH)
    cibles = [(db_file, 0o600)] + [
        (db_file.with_name(db_file.name + suffixe), 0o600)
        for suffixe in ("-wal", "-shm", "-journal")]
    try:
        if db_file.parent.resolve() == (_Path(_PROJECT_ROOT) / "user_db").resolve():
            cibles.append((db_file.parent, 0o700))
    except OSError:
        pass
    for chemin, voulu in cibles:
        try:
            mode = chemin.stat().st_mode & 0o777
            if mode & 0o077:
                chemin.chmod(voulu)
                logger.warning("[startup] %s était en %o (ouvert hors propriétaire) "
                               "— remis en %o.", chemin, mode, voulu)
        except OSError:
            continue


def init_db() -> None:
    """Pose le schéma et fait avancer la chaîne de migrations. Idempotent —
    chaque worker l'appelle au démarrage.

    (2026-09-26) Le schéma n'est plus écrit ici ni dans six ``init_*_db`` :
    il vient du schéma de référence (``shared_infra/db/_schema.py``), rendu
    pour le moteur de la base. Une base VIERGE est créée d'un coup et les
    migrations qu'il contient déjà sont tamponnées ; une base existante
    reçoit les tables et colonnes qui lui manquent, puis rejoue ses
    migrations en attente — le même ordre qu'avant (tables d'abord,
    migrations ensuite).
    """
    _harden_data_perms()
    with _schema_lock():
        _init_schema()
    _run_startup_cleanup()


@contextmanager
def _schema_lock():
    """Un seul process à la fois pose le schéma : les workers gunicorn
    démarrent ensemble et, sur une base NEUVE, leurs DDL concurrents
    échouaient (SQLite « database schema has changed », course connue de
    PostgreSQL sur ``CREATE TABLE IF NOT EXISTS``). Verrou fichier bloquant
    à côté de la base, libéré par le noyau si le process meurt ; sans lui
    (dossier en lecture seule…), on continue comme avant."""
    fh = None
    try:
        import fcntl as _fcntl
        path = _Path(DB_PATH).parent / ".init_db.lock"
        path.parent.mkdir(parents=True, exist_ok=True)
        fh = open(path, "a+")
        _fcntl.flock(fh.fileno(), _fcntl.LOCK_EX)
    except (OSError, ImportError) as exc:
        logger.warning("[init_db] verrou de schéma indisponible : %s", exc)
    try:
        yield
    finally:
        if fh is not None:
            fh.close()


def _migrate(conn, fresh: bool) -> None:
    """Chaîne de migrations de ``conn`` (``fresh`` : aucune table avant
    ``create_all``).

    Une base SERVEUR naît toujours du schéma de référence (installation ou
    transfert), jamais de l'ancienne chaîne SQLite : les migrations qu'il
    contient sont tamponnées, jamais rejouées — leur SQL est propre à SQLite
    (``sqlite_master``, ``PRAGMA``). Avant, seule une base sans AUCUNE table
    était tamponnée : un premier démarrage interrompu après ``create_all``, ou
    une table étrangère au schéma, faisait rejouer 0001+ et échouer les
    migrations à chaque démarrage (2026-09-27)."""
    from shared_infra.db import _schema
    from shared_infra.db._dialect import SQLITE, dialect_of
    from shared_infra.db._migrations import run_pending, stamp_baseline
    if fresh or dialect_of(conn) != SQLITE:
        stamped = stamp_baseline(conn, _schema.BASELINE_COVERS)
        if stamped:
            logger.info("[init_db] schéma de référence : %d migration(s) tamponnée(s)", stamped)
    applied_n = run_pending(conn)
    if applied_n:
        logger.info("[init_db] %d DB migration(s) applied", applied_n)


def _init_schema() -> None:
    from shared_infra.db import _schema
    from shared_infra.db._dialect import SQLITE, dialect_of
    with db_conn() as conn:
        fresh = _schema.is_fresh(conn)
        if not fresh and dialect_of(conn) == SQLITE:
            # Anciennes formes de tables AX (v1, identifiants sans
            # propriétaire) : à mettre à niveau AVANT que le schéma ne les
            # complète.
            try:
                from shared_infra.memory.ax.init import upgrade_legacy_sqlite
                upgrade_legacy_sqlite(conn)
                conn.commit()
            except Exception as _e:
                logger.warning("[init_db] mise à niveau AX héritée : %s", _e)
        fts_ok = _schema.create_all(conn)
        conn.commit()
        try:
            from shared_infra.memory import store as _memory_store
            _memory_store._FTS_OK = fts_ok
        except Exception:
            pass

        # ── Migrations DB versionnées ───────────────────────────────────────────
        # Idempotent via la table schema_migrations ; les erreurs sont loggées
        # sans interrompre le démarrage des autres composants.
        try:
            _migrate(conn, fresh)
        except Exception as _e:
            logger.error("[init_db] migrations framework failed: %s", _e)

    # ── Nettoyage au démarrage : un seul worker (file lock, dans
    # ``_run_startup_cleanup``) — appelé par ``init_db`` hors du verrou de
    # schéma : N workers faisant le même nettoyage = contention WAL inutile.


def _run_startup_cleanup() -> None:
    """Exécute purge_old_metrics / wal_checkpoint une seule fois parmi tous les
    workers Gunicorn grâce à un verrou fichier non-bloquant.

    Si un autre worker détient déjà le verrou (il fait le travail), on passe
    silencieusement — le nettoyage sera fait par ce premier worker.
    """
    import fcntl as _fcntl
    from pathlib import Path as _Path

    lock_path = _Path(DB_PATH).parent / ".startup_cleanup.lock"
    try:
        lf = open(lock_path, "w")
        try:
            # LOCK_EX | LOCK_NB : échoue immédiatement si déjà pris
            _fcntl.flock(lf.fileno(), _fcntl.LOCK_EX | _fcntl.LOCK_NB)
        except (BlockingIOError, OSError):
            # Un autre worker est en train de faire le nettoyage → on skip
            lf.close()
            return
        try:
            # Purge old metric events to prevent unbounded table growth.
            # Honore la rétention CONFIGURÉE (METRICS_RETENTION_DAYS), comme la
            # passe de maintenance : avant, l'appel sans argument retombait sur
            # le défaut codé en dur (90 j) et supprimait à CHAQUE redémarrage
            # des métriques qu'un admin avait configuré de garder plus longtemps.
            # 0 = illimité (même convention que maintenance.py) → on ne purge pas.
            if METRICS_RETENTION_DAYS > 0:
                purge_old_metrics(METRICS_RETENTION_DAYS)
            # Compact the WAL file to prevent it from growing indefinitely.
            wal_checkpoint()
        finally:
            _fcntl.flock(lf.fileno(), _fcntl.LOCK_UN)
            lf.close()
            try:
                lock_path.unlink(missing_ok=True)
            except Exception:
                pass
    except Exception as _e:
        logger.warning(f"[startup] _run_startup_cleanup: verrou inaccessible ({_e}), "
                       "nettoyage exécuté quand même en fallback.")
        # Fallback : si le mécanisme de verrou est indisponible (ex: FS read-only),
        # on exécute quand même le nettoyage (comportement original).
        if METRICS_RETENTION_DAYS > 0:
            purge_old_metrics(METRICS_RETENTION_DAYS)
        wal_checkpoint()





















# ``get_global_stats()`` RETIRÉE : importée par 9 modules de routes admin,
# appelée par zéro. Elle agrégeait ``total_tokens`` / ``input_tokens`` /
# ``output_tokens`` de ``metric_events`` — trois séries que plus personne
# n'émet depuis que la consommation vit dans ``usage_events``. La ranimer
# aurait donc rendu des zéros. Les agrégats de conso : voir
# ``shared_infra/observability/usage_store.py``.




_UID_BY_NAME: Dict[str, Optional[int]] = {}


def _uid_for_username(name: Any) -> Optional[int]:
    """Résout un username → user_id, avec cache borné.

    Le tag ``user`` des métriques a toujours été le *username* : un rename
    orphelinait tout l'historique de l'utilisateur. On remplit désormais une
    colonne ``user_id`` en plus du tag (l'un n'invalide pas l'autre : les
    lignes antérieures gardent NULL). Le cache évite un SELECT par métrique
    sur le chemin chaud d'un tour de chat ; il est borné pour ne pas devenir
    une fuite sur une instance à beaucoup de comptes.
    """
    if not name or not isinstance(name, str):
        return None
    if name in _UID_BY_NAME:
        return _UID_BY_NAME[name]
    uid: Optional[int] = None
    try:
        conn = db()
        try:
            row = conn.execute("SELECT id FROM users WHERE username=?", (name,)).fetchone()
            uid = int(row[0]) if row else None
        finally:
            conn.close()
    except Exception:
        return None          # DB indisponible : on ne cache pas un faux négatif
    if len(_UID_BY_NAME) > 512:
        _UID_BY_NAME.clear()
    _UID_BY_NAME[name] = uid
    return uid


def log_metric(event_type: str, value: float = 1.0, tags: Dict[str, Any] = None,
               user_id: Optional[int] = None):
    """
    Append one row to ``metric_events``. Best-effort : une métrique ne doit
    JAMAIS casser une requête (erreurs journalisées puis avalées). Le tableau
    de bord relit la base à son propre rythme.
    """
    # ``db()`` lui-même peut lever (DB inaccessible) : on le garde DANS le try, sinon
    # l'exception remonterait au caller (chemin de chat) au lieu d'être avalée — une
    # métrique best-effort ne doit JAMAIS casser une requête.
    try:
        conn = db()
    except Exception as e:
        logger.error(f"Metric DB open error: {e}")
        return
    try:
        uid = user_id if user_id is not None else _uid_for_username((tags or {}).get("user"))
        cur = conn.cursor()
        cur.execute("INSERT INTO metric_events(event_type, value, tags_json, created_at, user_id) VALUES(?,?,?,?,?)", (event_type, value, json.dumps(tags or {}), time.time(), uid))
        conn.commit()
    except Exception as e: logger.error(f"Metric Error: {e}")
    finally:
        try: conn.close()
        except Exception: pass

    # (2026-09-25) Plus de ``metric_dirty`` diffusé ici : aucun consommateur
    # front, et l'événement partait vers TOUS les utilisateurs connectés à
    # chaque métrique (cf. metrics/broadcast.py).




























# ── Pipeline reports (V&V) ────────────────────────────────────────────────
# Stockage des rapports d'exécution générés. Rétention : 5 par utilisateur.
# Le contenu HTML est stocké en TEXT, le contenu PDF en BLOB. La signature
# HMAC est conservée séparément pour vérification d'intégrité.






# ── User groups CRUD + membership moved to backend.db.groups ──
# Functions: create_group, list_groups, get_group, update_group, delete_group,
# get_group_members, get_user_groups, set_user_groups, add_user_to_group,
# remove_user_from_group, get_all_users_with_groups
# Still importable via backend.db.<n> thanks to the package façade.

# ── Pipeline Versions ────────────────────────────────────────────────────────





# ── Pipeline Schedules ───────────────────────────────────────────────────────








# ── Startup cleanup ───────────────────────────────────────────────────────────

def purge_old_metrics(retention_days: int = 90) -> int:
    """Supprime les metric_events de plus de `retention_days` jours.

    Appelé au startup (init_db) et peut être appelé périodiquement.
    Avec 15 utilisateurs actifs (~1000 events/jour), 90 jours ≈ 90K lignes
    ce qui reste très rapide pour SQLite.
    """
    with db_conn() as conn:
        cur = conn.cursor()
        cutoff = time.time() - retention_days * 86400
        cur.execute("DELETE FROM metric_events WHERE created_at < ?", (cutoff,))
        count = cur.rowcount
        conn.commit()
        if count:
            logger.info(f"[startup] {count} metric_events purgé(s) (>{retention_days}j).")
        return count


def wal_checkpoint() -> None:
    """Force un checkpoint WAL + truncate pour compacter le fichier -wal.

    Sans checkpoint périodique, le fichier -wal grossit indéfiniment
    (surtout avec metric_events qui fait beaucoup d'INSERT).
    TRUNCATE remet le fichier -wal à 0 après avoir fusionné dans le .db.
    """
    if DB_BACKEND != "sqlite":
        return                      # propre à SQLite (le serveur gère son journal)
    try:
        conn = db()
    except Exception as e:
        logger.debug(f"[wal_checkpoint] db open: {e}")
        return
    try:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE);")
    except Exception as e:
        logger.debug(f"[wal_checkpoint] {e}")
    finally:
        try: conn.close()
        except Exception: pass
