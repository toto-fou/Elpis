# SPDX-License-Identifier: MIT
"""Le ring ``llm_calls`` ne doit plus balayer toute la table à chaque appel LLM.

``record_llm_call`` est invoqué à la fin de CHAQUE échange llama.cpp — donc à
chaque itération d'une boucle d'outils, jusqu'à 200 par run. Il insérait ~20 Ko
puis purgeait avec ``id NOT IN (SELECT id … LIMIT n)``, une forme que SQLite ne
sait exécuter qu'en parcourant deux fois l'intégralité de la table (12 Mo sur
l'instance observée) — le tout **dans la transaction d'écriture**, c'est-à-dire
pendant que le verrou d'écriture, unique pour tous les workers, est tenu.

La borne par clé primaire supprime EXACTEMENT le même jeu de lignes. Ces tests
verrouillent cette équivalence, y compris là où l'intuition hésite : ids à
trous, table plus courte que le ring, ring de taille 1.
"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shared_infra.llm import debug as llm_debug  # noqa: E402

ANCIENNE_PURGE = ("DELETE FROM llm_calls WHERE id NOT IN "
                  "(SELECT id FROM llm_calls ORDER BY id DESC LIMIT ?)")


@pytest.fixture()
def base(tmp_path, monkeypatch):
    fichier = tmp_path / "app.db"
    monkeypatch.setattr("shared_infra.db._connection.DB_PATH", str(fichier))
    from shared_infra.db import _connection as _legacy
    _legacy.reset_pool()
    llm_debug.init_llm_debug_db()
    yield fichier
    _legacy.reset_pool()


def _ids(base) -> list[int]:
    from shared_infra.db import _connection as _legacy
    with _legacy.db_conn() as conn:
        return [r[0] for r in conn.execute("SELECT id FROM llm_calls ORDER BY id")]


def _ecrire(n: int, max_entries: int = 500) -> None:
    for i in range(n):
        llm_debug.record_llm_call(req_id=f"r{i}", model="m", path="tools",
                                  request_json='{"messages":[]}',
                                  response_json="{}", max_entries=max_entries)


# ── Comportement du ring : inchangé ─────────────────────────────────────────

def test_le_ring_garde_exactement_les_n_plus_recents(base):
    _ecrire(25, max_entries=10)
    ids = _ids(base)
    assert len(ids) == 10
    assert ids == list(range(16, 26)), "ce doivent être les 10 DERNIERS insérés"


def test_en_dessous_du_plafond_rien_n_est_supprime(base):
    _ecrire(4, max_entries=10)
    assert len(_ids(base)) == 4


def test_pile_au_plafond_rien_n_est_supprime(base):
    _ecrire(10, max_entries=10)
    assert len(_ids(base)) == 10


def test_un_ring_de_taille_1(base):
    _ecrire(5, max_entries=1)
    assert _ids(base) == [5]


def test_le_contenu_reste_lisible(base):
    _ecrire(3, max_entries=10)
    lignes = llm_debug.list_llm_calls(limit=10)
    assert len(lignes) == 3
    assert lignes[0]["req_id"] == "r2"          # plus récent d'abord
    detail = llm_debug.get_llm_call(lignes[0]["id"])
    assert detail["request_json"] == '{"messages":[]}'


# ── Équivalence stricte avec l'ancienne formulation ─────────────────────────

@pytest.mark.parametrize("trous", [
    [],                                   # ids contigus
    [3, 4, 5],                            # trou au milieu
    [1, 2],                               # trou en tête
    [18, 19, 20],                         # trou en queue
    [2, 5, 8, 11, 14, 17],                # trous dispersés
])
def test_meme_jeu_supprime_que_l_ancienne_formulation(trous):
    """Deux bases identiques, deux purges, même résultat — la borne par clé
    primaire lit X *par position*, elle ne l'extrapole pas depuis MAX(id)."""
    max_entries = 7

    def preparer():
        conn = sqlite3.connect(":memory:")
        conn.execute("CREATE TABLE llm_calls(id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL)")
        conn.executemany("INSERT INTO llm_calls(id, ts) VALUES(?, 0)",
                         [(i,) for i in range(1, 21) if i not in trous])
        return conn

    ancienne, nouvelle = preparer(), preparer()
    ancienne.execute(ANCIENNE_PURGE, (max_entries,))
    nouvelle.execute(
        "DELETE FROM llm_calls WHERE id < "
        "(SELECT id FROM llm_calls ORDER BY id DESC LIMIT 1 OFFSET ?)",
        (max_entries - 1,))

    attendu = [r[0] for r in ancienne.execute("SELECT id FROM llm_calls ORDER BY id")]
    obtenu = [r[0] for r in nouvelle.execute("SELECT id FROM llm_calls ORDER BY id")]
    assert obtenu == attendu
    assert len(obtenu) == max_entries


# ── Le plan d'exécution, qui est tout l'objet du correctif ──────────────────

@pytest.mark.sqlite_only   # EXPLAIN QUERY PLAN propre à SQLite
def test_la_purge_n_est_plus_un_balayage_de_table(base):
    from shared_infra.db import _connection as _legacy
    _ecrire(12, max_entries=10)
    with _legacy.db_conn() as conn:
        plan = [r[3] for r in conn.execute(
            "EXPLAIN QUERY PLAN DELETE FROM llm_calls WHERE id < "
            "(SELECT id FROM llm_calls ORDER BY id DESC LIMIT 1 OFFSET 9)")]
    assert any("PRIMARY KEY" in p for p in plan), plan
    balayages = [p for p in plan if p.startswith("SCAN llm_calls")]
    assert len(balayages) <= 1, f"il reste plus d'un balayage complet : {plan}"


@pytest.mark.sqlite_only   # EXPLAIN QUERY PLAN propre à SQLite
def test_l_ancienne_formulation_balayait_bien_deux_fois(base):
    """Témoin de la mesure : sans lui, l'affirmation du commentaire n'est
    qu'une croyance."""
    from shared_infra.db import _connection as _legacy
    _ecrire(12, max_entries=10)
    with _legacy.db_conn() as conn:
        plan = [r[3] for r in conn.execute(
            "EXPLAIN QUERY PLAN " + ANCIENNE_PURGE.replace("?", "10"))]
    assert len([p for p in plan if p.startswith("SCAN llm_calls")]) == 2, plan


# ── Robustesse : la capture ne doit jamais casser un chat ───────────────────

def test_une_erreur_d_ecriture_reste_silencieuse(base, monkeypatch):
    from shared_infra.db import _connection as _legacy
    monkeypatch.setattr(_legacy, "DB_PATH", "/proc/interdit/app.db")
    _legacy.reset_pool()
    llm_debug.record_llm_call(req_id="x", max_entries=10)      # ne doit pas lever
