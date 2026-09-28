# SPDX-License-Identifier: MIT
"""Pool de connexions SQLite — le contrat des appelants ne bouge pas.

``db()`` rend désormais une connexion réutilisée par thread. Tout l'enjeu est
qu'aucun appelant ne s'en aperçoive : ``close()`` doit rendre la connexion,
et surtout AUCUN état ne doit fuiter d'un emprunteur au suivant.
"""
import os
import sqlite3
import threading

import pytest

from shared_infra.db import _connection as _legacy

# Internes du pool SQLite par thread (le pool serveur est testé dans tests/db/test_moteurs_serveur_2026_09_26.py).
pytestmark = pytest.mark.sqlite_only


@pytest.fixture
def dbfile(tmp_path, monkeypatch):
    monkeypatch.setattr(_legacy, "DB_PATH", str(tmp_path / "app.db"))
    _legacy.reset_pool()
    with _legacy.db_conn() as conn:
        conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
        conn.commit()
    yield tmp_path / "app.db"
    _legacy.reset_pool()


# ── Réutilisation ───────────────────────────────────────────────────────────

def test_la_connexion_est_reutilisee_dans_un_thread(dbfile):
    with _legacy.db_conn() as a:
        id_a = id(a)
    with _legacy.db_conn() as b:
        assert id(b) == id_a


def test_close_ne_ferme_pas_vraiment(dbfile):
    with _legacy.db_conn() as conn:
        pass
    # Si close() avait vraiment fermé, ceci lèverait ProgrammingError.
    assert conn.execute("SELECT 1").fetchone()[0] == 1


def test_reset_pool_ferme_pour_de_bon(dbfile):
    with _legacy.db_conn() as conn:
        pass
    _legacy.reset_pool()
    with pytest.raises(sqlite3.ProgrammingError):
        conn.execute("SELECT 1")


def test_chaque_thread_a_sa_connexion(dbfile):
    """sqlite3 interdit le partage entre threads : le pool doit être local."""
    # On garde une référence FORTE sur chaque connexion : sans elle, l'objet
    # est libéré à la fin du thread et CPython peut réattribuer la même
    # adresse au suivant — le test passerait ou échouerait au hasard.
    seen = {}

    def work(name):
        with _legacy.db_conn() as conn:
            seen[name] = conn
            conn.execute("SELECT 1").fetchone()

    ts = [threading.Thread(target=work, args=(i,)) for i in range(4)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert len({id(c) for c in seen.values()}) == 4
    # Pas de fermeture explicite ici : sqlite3 refuse qu'un objet soit touché
    # depuis un autre thread que celui qui l'a créé. Le thread-local meurt avec
    # son thread, et la connexion est fermée par la finalisation — c'est
    # précisément ce qui borne le nombre de connexions du pool.


# ── Aucune fuite d'état entre emprunteurs ───────────────────────────────────

def test_isolation_level_ne_fuit_pas(dbfile):
    """Trois fonctions du code posent ``isolation_level = None``.

    Propagé à l'emprunteur suivant, il le mettrait en autocommit à son insu :
    son ``rollback()`` ne défairait plus rien.
    """
    with _legacy.db_conn() as conn:
        conn.isolation_level = None
    with _legacy.db_conn() as conn:
        assert conn.isolation_level == ""


def test_row_factory_ne_fuit_pas(dbfile):
    with _legacy.db_conn() as conn:
        conn.row_factory = None
    with _legacy.db_conn() as conn:
        row = conn.execute("SELECT 1 AS n").fetchone()
        assert row["n"] == 1, "tout le code lit ses colonnes par nom"


def test_transaction_pendante_est_annulee_comme_avant(dbfile):
    """Un close() sans commit jetait l'écriture. Ça doit rester vrai."""
    with _legacy.db_conn() as conn:
        conn.execute("INSERT INTO t (v) VALUES ('perdu')")
        # pas de commit — l'ancien close() rollbackait
    with _legacy.db_conn() as conn:
        assert conn.execute("SELECT COUNT(*) FROM t").fetchone()[0] == 0


def test_le_commit_explicite_est_toujours_durable(dbfile):
    with _legacy.db_conn() as conn:
        conn.execute("INSERT INTO t (v) VALUES ('gardé')")
        conn.commit()
    _legacy.reset_pool()
    with _legacy.db_conn() as conn:
        assert conn.execute("SELECT v FROM t").fetchone()[0] == "gardé"


def test_nettoyage_a_l_emprunt_et_pas_seulement_au_rendu(dbfile):
    """Un état laissé par un emprunt DÉNOUÉ ne contamine pas le suivant.

    Le nettoyage a lieu aux deux bouts. Ici on force le cas où seul celui de
    l'emprunt peut agir, en salissant la connexion après son rendu.
    """
    with _legacy.db_conn() as conn:
        pass
    # On salit APRÈS le rendu : le nettoyage du close() a déjà eu lieu, seul
    # celui de l'emprunt suivant peut rattraper.
    conn.execute("INSERT INTO t (v) VALUES ('sale')")
    assert conn.in_transaction, "le test ne prouve rien sans transaction ouverte"

    with _legacy.db_conn() as conn2:
        assert conn2.execute("SELECT COUNT(*) FROM t").fetchone()[0] == 0


def test_un_emprunt_jamais_rendu_finit_par_alerter(dbfile, caplog):
    """Le pool ne peut pas deviner QUOI annuler, mais il ne se tait pas.

    Un ``db()`` sans ``close()`` était déjà un bug avant (la connexion
    fuyait) ; il en devient un plus sournois, puisque l'appelant suivant
    hériterait de la transaction ouverte. La profondeur mesurée sur toute la
    suite plafonne à 2 (``init_db``), donc franchir le seuil ne peut venir que
    de là.
    """
    import logging
    with caplog.at_level(logging.WARNING, logger="uvicorn.error"):
        for _ in range(_legacy._POOL_DEPTH_ALARM):
            _legacy.db()      # jamais rendue
    assert any("profondeur d'emprunt" in r.getMessage() for r in caplog.records)


# ── Réentrance ──────────────────────────────────────────────────────────────

def test_appel_imbrique_partage_la_connexion(dbfile):
    """``init_db`` appelle six ``init_*_db`` en tenant déjà une connexion."""
    with _legacy.db_conn() as outer:
        with _legacy.db_conn() as inner:
            assert inner is outer
        # Le close() interne ne doit PAS avoir nettoyé sous les pieds du bloc
        # externe : la connexion reste utilisable.
        assert outer.execute("SELECT 1").fetchone()[0] == 1


def test_le_close_interne_ne_rollback_pas_le_bloc_externe(dbfile):
    with _legacy.db_conn() as outer:
        outer.execute("INSERT INTO t (v) VALUES ('externe')")
        with _legacy.db_conn():
            pass
        outer.commit()
    _legacy.reset_pool()
    with _legacy.db_conn() as conn:
        assert conn.execute("SELECT COUNT(*) FROM t").fetchone()[0] == 1


# ── Clé du pool ─────────────────────────────────────────────────────────────

def test_changer_DB_PATH_donne_une_nouvelle_connexion(dbfile, tmp_path, monkeypatch):
    """Ce que font des dizaines de tests : monkeypatcher DB_PATH."""
    with _legacy.db_conn() as a:
        first = id(a)
    monkeypatch.setattr(_legacy, "DB_PATH", str(tmp_path / "autre.db"))
    with _legacy.db_conn() as b:
        assert id(b) != first
        b.execute("CREATE TABLE u (x)")
    assert (tmp_path / "autre.db").exists()


def test_la_cle_du_pool_porte_le_pid(dbfile, monkeypatch):
    """Une connexion héritée d'un fork gunicorn corromprait la base."""
    with _legacy.db_conn() as before:
        avant = id(before)
    vrai_pid = os.getpid()
    monkeypatch.setattr(_legacy.os, "getpid", lambda: vrai_pid + 1)
    with _legacy.db_conn() as after:
        assert id(after) != avant


def test_la_profondeur_retombe_a_zero(dbfile):
    """L'invariant qui rend le partage sûr : tout emprunt est rendu."""
    with _legacy.db_conn():
        with _legacy.db_conn():
            assert _legacy._pool.depth == 2
        assert _legacy._pool.depth == 1
    assert _legacy._pool.depth == 0


# ── Les réglages attendus sont bien posés ───────────────────────────────────

def test_les_pragma_par_connexion_sont_appliques(dbfile):
    with _legacy.db_conn() as conn:
        assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        assert conn.execute("PRAGMA busy_timeout").fetchone()[0] == 10000
        assert conn.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
