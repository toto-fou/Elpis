# SPDX-License-Identifier: MIT
"""Schéma de référence (``shared_infra/db/_schema.py``, chantier multi-moteurs).

Le schéma n'est plus écrit à dix endroits mais déclaré une fois et rendu pour
chaque moteur. Ces tests verrouillent :

* qu'une base NEUVE créée par ``init_db`` est identique, colonne par colonne
  et index par index, au schéma que produisait le code avant la bascule
  (instantané figé dans ``fixtures/schema_sqlite_2026_09_26.json``) ;
* qu'elle tamponne les migrations au lieu de les rejouer, et que la liste
  tamponnée couvre TOUTES les migrations du dépôt (règle : une nouvelle
  migration met à jour le schéma de référence et ``BASELINE_COVERS``) ;
* qu'une base EXISTANTE n'est pas modifiée, et qu'une base ancienne reçoit les
  colonnes venues après coup ;
* qu'aucune famille ne réécrit de DDL en dehors du schéma et des migrations.
"""
import ast
import json
import os
import sqlite3
from pathlib import Path

import pytest

from shared_infra.db import _connection as _legacy, _schema as S

ROOT = Path(__file__).resolve().parents[2]
TEMOIN = json.loads((Path(__file__).parent / "fixtures" /
                     "schema_sqlite_2026_09_26.json").read_text(encoding="utf-8"))


# ── Outils ───────────────────────────────────────────────────────────────────

def _introspection(con):
    """Schéma normalisé : colonnes (nom, type, NOT NULL, défaut, rang de PK),
    clés étrangères, index (unicité, origine, colonnes et sens, prédicat)."""
    out = {}
    for (name,) in con.execute("SELECT name FROM sqlite_master WHERE type='table' "
                               "AND name NOT LIKE 'sqlite_%' ORDER BY name"):
        cols = [(c[1], (c[2] or "").upper(), c[3], c[4], c[5])
                for c in con.execute(f'PRAGMA table_info("{name}")')]
        fks = sorted((f[2], f[3], f[4], f[6])
                     for f in con.execute(f'PRAGMA foreign_key_list("{name}")'))
        idx = []
        for il in con.execute(f'PRAGMA index_list("{name}")'):
            iname = il[1]
            parts = tuple((x[2], x[3]) for x in con.execute(f'PRAGMA index_xinfo("{iname}")') if x[5])
            sql = con.execute("SELECT sql FROM sqlite_master WHERE name=?", (iname,)).fetchone()
            sql = " ".join((sql[0] or "").split()) if sql and sql[0] else ""
            where = sql.split(" WHERE ", 1)[1] if " WHERE " in sql else None
            idx.append((il[2], il[3], il[4], parts, where))
        out[name] = (cols, fks, sorted(idx))
    triggers = sorted(r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='trigger'"))
    return out, triggers


def _base_temoin(path, sauf_colonnes=()):
    """Base construite avec le DDL d'AVANT (instantané figé)."""
    con = sqlite3.connect(path)
    rang = {"table": 0, "index": 1, "trigger": 2}
    for typ, name, _tbl, sql in sorted(TEMOIN["objects"], key=lambda o: rang[o[0]]):
        if not sql:
            continue
        for table, col in sauf_colonnes:
            if typ == "table" and name == table:
                parts = sql.split(",")
                gardees = [p for p in parts if not p.strip().startswith(col + " ")]
                if parts[-1].strip().startswith(col + " "):
                    gardees[-1] += ")"            # la colonne retirée fermait la table
                sql = ",".join(gardees)
        con.execute(sql)
    con.commit()
    return con


@pytest.fixture
def db_path(tmp_path, monkeypatch):
    import shared_infra.config as _config
    path = tmp_path / "app.db"
    monkeypatch.setattr(_legacy, "DB_PATH", str(path))
    monkeypatch.setattr(_config, "DB_PATH", str(path))
    _legacy.reset_pool()
    yield path
    _legacy.reset_pool()


# ── Base neuve ───────────────────────────────────────────────────────────────

@pytest.mark.sqlite_only
def test_base_neuve_identique_au_schema_d_avant(db_path, tmp_path):
    _legacy.init_db()
    _legacy.reset_pool()
    neuve = _introspection(sqlite3.connect(db_path))
    temoin = _introspection(_base_temoin(tmp_path / "temoin.db"))
    assert neuve[1] == temoin[1], "déclencheurs plein texte"
    diff = {t for t in set(neuve[0]) | set(temoin[0]) if neuve[0].get(t) != temoin[0].get(t)}
    assert not diff, {t: (temoin[0].get(t), neuve[0].get(t)) for t in sorted(diff)}


def test_base_neuve_tamponne_les_migrations(db_path):
    _legacy.init_db()
    with _legacy.db_conn() as c:
        names = {r[0] for r in c.execute("SELECT name FROM schema_migrations")}
    assert names == set(S.BASELINE_COVERS)


def test_le_tampon_couvre_toutes_les_migrations():
    """Règle : toute nouvelle migration met à jour le schéma de référence ET
    s'ajoute à ``BASELINE_COVERS``, sinon une base neuve la sauterait ou la
    rejouerait sur un schéma qui la contient déjà."""
    from shared_infra.db._migrations import _discover
    assert set(_discover()) == set(S.BASELINE_COVERS)


def test_recherche_plein_texte_operationnelle(db_path):
    _legacy.init_db()
    from shared_infra.accounts.users import create_user
    from shared_infra.memory import store as M
    uid = create_user("alice", "pw-alice-1")
    assert M._FTS_OK is True
    M.session_index_message(user_id=uid, app="chat", session_id="c1", scope_key="",
                            role="user", content="la réunion budgétaire de mardi")
    hits = M.session_search_fts(uid, "budgetaire")
    assert hits and hits[0]["session_id"] == "c1"


# ── Base existante ───────────────────────────────────────────────────────────

@pytest.mark.sqlite_only
def test_base_existante_n_est_pas_modifiee(db_path):
    con = _base_temoin(db_path)
    con.executemany("INSERT INTO schema_migrations(name, applied_at) VALUES(?, 1.0)",
                    [(n,) for n in S.BASELINE_COVERS])
    con.commit()
    avant = _introspection(con)
    con.close()
    _legacy.init_db()
    _legacy.reset_pool()
    con = sqlite3.connect(db_path)
    assert _introspection(con) == avant
    assert {r[0] for r in con.execute("SELECT DISTINCT applied_at FROM schema_migrations")} == {1.0}


@pytest.mark.sqlite_only
def test_base_ancienne_recoit_les_colonnes_venues_apres_coup(db_path):
    manquantes = (("users", "must_change_pwd"), ("users", "session_min_ts"),
                  ("editor_routines", "connector_id"), ("editor_routine_runs", "files"),
                  ("code_sessions", "preview"), ("metric_events", "user_id"))
    con = _base_temoin(db_path, sauf_colonnes=manquantes)
    con.executemany("INSERT INTO schema_migrations(name, applied_at) VALUES(?, 1.0)",
                    [(n,) for n in S.BASELINE_COVERS])
    con.commit()
    for table, col in manquantes:
        assert col not in {r[1] for r in con.execute(f'PRAGMA table_info("{table}")')}
    con.close()
    _legacy.init_db()
    with _legacy.db_conn() as c:
        for table, col in manquantes:
            assert col in {r[1] for r in c.execute(f'PRAGMA table_info("{table}")')}, (table, col)


@pytest.mark.sqlite_only
def test_base_partielle_rejoue_sa_chaine(db_path):
    """Une base qui a au moins une table n'est pas « neuve » : elle rejoue ses
    migrations (ici 0012, qui retire un index d'une vieille table)."""
    con = sqlite3.connect(db_path)
    con.execute("CREATE TABLE metric_events (id INTEGER PRIMARY KEY, event_type TEXT, "
                "value REAL, tags_json TEXT, created_at REAL, user_id INTEGER)")
    con.execute("CREATE INDEX idx_metrics_user_date ON metric_events(user_id, created_at DESC)")
    con.commit()
    con.close()
    _legacy.init_db()
    with _legacy.db_conn() as c:
        idx = {r[1] for r in c.execute("PRAGMA index_list(metric_events)")}
        applied = {r[0] for r in c.execute("SELECT name FROM schema_migrations")}
    assert "idx_metrics_user_date" not in idx
    assert applied == set(S.BASELINE_COVERS)


# ── Rendu pour les autres moteurs (texte ; exécuté au lot B) ────────────────

def test_rendu_postgresql():
    t = S.TABLES_BY_NAME["usage_events"]
    ddl = S.create_table_sql(t, "postgres")
    assert "GENERATED BY DEFAULT AS IDENTITY" in ddl and "AUTOINCREMENT" not in ddl
    assert "DOUBLE PRECISION" in ddl and "BIGINT" in ddl
    ix = next(i for i in t.indexes if i.where)
    assert S.create_index_sql(t, ix, "postgres").endswith(f"WHERE {ix.where}")
    assert 'CREATE TABLE IF NOT EXISTS "groups"' in S.create_table_sql(S.TABLES_BY_NAME["groups"], "postgres")


def test_rendu_mysql():
    meta = S.create_table_sql(S.TABLES_BY_NAME["code_meta"], "mysql")
    assert "`key` VARCHAR(191) NOT NULL" in meta and "`value` LONGTEXT NOT NULL" in meta
    assert meta.endswith("COLLATE=utf8mb4_bin")
    chats = S.create_table_sql(S.TABLES_BY_NAME["chats"], "mysql")
    assert "`meta_json` LONGTEXT NOT NULL DEFAULT ('{}')" in chats
    t = S.TABLES_BY_NAME["usage_events"]
    ix = next(i for i in t.indexes if i.where)
    assert "WHERE" not in S.create_index_sql(t, ix, "mysql")
    notif = S.create_table_sql(S.TABLES_BY_NAME["notifications"], "mysql")
    assert "`ref_id` LONGTEXT" in notif


# ── Une seule source de DDL ──────────────────────────────────────────────────

_DDL = ("CREATE TABLE", "CREATE INDEX", "CREATE UNIQUE INDEX", "CREATE VIRTUAL TABLE",
        "CREATE TRIGGER", "ALTER TABLE")
# Le schéma, les helpers de DDL du dialecte, et les mises à niveau héritées
# d'AX (propres à SQLite) ; les migrations sont exclues plus bas. Le transfert
# entre moteurs recale l'``AUTO_INCREMENT`` MySQL (``ALTER TABLE``).
_AUTORISES = {"shared_infra/db/_schema.py", "shared_infra/db/_dialect.py",
              "shared_infra/memory/ax/init.py", "shared_infra/db/transfer.py"}


def _chaines_sql(noeud):
    if isinstance(noeud, ast.Constant) and isinstance(noeud.value, str):
        yield noeud.value
    elif isinstance(noeud, ast.JoinedStr):
        yield "".join(v.value for v in noeud.values
                      if isinstance(v, ast.Constant) and isinstance(v.value, str))


def test_aucune_famille_n_ecrit_de_ddl_hors_du_schema():
    fautifs = []
    for base in ("shared_infra", "llm_core", "chatbot_app", "server", "toolhost"):
        for p in sorted((ROOT / base).rglob("*.py")):
            rel = p.relative_to(ROOT).as_posix()
            if rel in _AUTORISES or "/_migrations/" in rel:
                continue
            arbre = ast.parse(p.read_text(encoding="utf-8"))
            for n in ast.walk(arbre):
                if not isinstance(n, ast.Call):
                    continue
                for a in n.args:
                    for s in _chaines_sql(a):
                        if any(k in s.upper() for k in _DDL):
                            fautifs.append(f"{rel}:{n.lineno}")
    assert not fautifs, fautifs


# ── Premier démarrage : workers simultanés sur une base neuve ────────────────

@pytest.mark.sqlite_only   # la course visée : DDL concurrents sur le fichier SQLite
def test_workers_simultanes_sur_une_base_neuve(tmp_path):
    """Les workers gunicorn démarrent ensemble : sans verrou de schéma, leurs
    ``init_db`` concurrents échouaient sur une base neuve (« database schema
    has changed »)."""
    import subprocess
    import sys
    code = ("import sys; from shared_infra.db._connection import init_db; init_db(); "
            "print('ok')")
    for tour in range(3):
        env = dict(os.environ, APP_DB_PATH=str(tmp_path / f"t{tour}" / "app.db"),
                   APP_DB_BACKEND="sqlite")
        procs = [subprocess.Popen([sys.executable, "-c", code], env=env, cwd=str(ROOT),
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                 for _ in range(6)]
        outs = [p.communicate(timeout=120) for p in procs]
        assert all(p.returncode == 0 and "ok" in o for p, (o, _) in zip(procs, outs)), \
            [e[-800:] for (_, e) in outs if e and "Traceback" in e]
