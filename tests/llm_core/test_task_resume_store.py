# SPDX-License-Identifier: MIT
"""tests/llm_core/test_task_resume_store.py — reprise ``task_id`` CROSS-WORKER.

Quand un sous-agent est interrompu, le handler rend au modèle un ``task_id``
avec la consigne « pass task_id to resume this agent from its partial work ».
Le store d'origine était un dictionnaire module-level : le tour suivant (une
NOUVELLE requête HTTP, worker arbitraire sous gunicorn) répondait
``unknown_task_id`` (N-1)/N du temps — on proposait au modèle une reprise
impossible. Le store partagé sur disque comble ce trou ; le dictionnaire reste
le cache chaud.
"""
from __future__ import annotations

import json
import time

import pytest

import llm_core.tools.task_tool as task_tool
from llm_core.tools import _task_resume


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setattr(_task_resume, "STORE_DIR", tmp_path / "resume")
    task_tool._RESUME_STORE.clear()
    yield
    task_tool._RESUME_STORE.clear()


REC = {"agent": "explore", "messages": [{"role": "user", "content": "partiel"}],
       "ts": time.time()}


def test_aller_retour():
    assert _task_resume.put("alice", "t1-abc", REC) is True
    got = _task_resume.get("alice", "t1-abc", 3600)
    assert got is not None and got["agent"] == "explore"
    assert got["messages"] == REC["messages"]


def test_cloisonnement_par_utilisateur():
    _task_resume.put("alice", "t1-abc", REC)
    assert _task_resume.get("bob", "t1-abc", 3600) is None


def test_ttl_expire_et_nettoie():
    vieux = dict(REC, ts=time.time() - 10_000)
    _task_resume.put("alice", "t1-abc", vieux)
    assert _task_resume.get("alice", "t1-abc", 3600) is None
    assert not _task_resume._path("alice", "t1-abc").exists()


def test_fichier_corrompu_ignore_et_retire():
    _task_resume.put("alice", "t1-abc", REC)
    _task_resume._path("alice", "t1-abc").write_text("{tronqué", encoding="utf-8")
    assert _task_resume.get("alice", "t1-abc", 3600) is None
    assert not _task_resume._path("alice", "t1-abc").exists()


def test_enregistrement_trop_gros_reste_en_memoire(monkeypatch):
    """Un historique d'enfant peut peser des Mo : au-delà du plafond on
    n'écrit pas (la reprise reste possible sur le worker d'origine)."""
    monkeypatch.setattr(_task_resume, "_MAX_BYTES", 200)
    gros = dict(REC, messages=[{"role": "user", "content": "x" * 5000}])
    assert _task_resume.put("alice", "t1-abc", gros) is False
    assert _task_resume.get("alice", "t1-abc", 3600) is None


def test_child_id_hostile_ne_construit_pas_de_chemin():
    p = _task_resume._path("alice", "../../etc/passwd")
    assert p.parent == _task_resume.STORE_DIR
    assert "/" not in p.name and ".." not in p.name


def test_prune_ttl_puis_cap():
    for i in range(5):
        _task_resume.put("alice", f"t{i}", dict(REC, ts=time.time()))
    _task_resume.prune(3600, 2)
    restants = list(_task_resume.STORE_DIR.iterdir())
    assert len(restants) == 2, restants


def test_ecriture_atomique_pas_de_json_tronque():
    """os.replace : un lecteur ne voit jamais un fichier à moitié écrit."""
    _task_resume.put("alice", "t1-abc", REC)
    brut = _task_resume._path("alice", "t1-abc").read_text(encoding="utf-8")
    json.loads(brut)                       # ne lève pas
    assert not list(_task_resume.STORE_DIR.glob("*.tmp"))


def test_fail_open_si_dossier_inutilisable(monkeypatch, tmp_path):
    fichier = tmp_path / "pas_un_dossier"
    fichier.write_text("x")
    monkeypatch.setattr(_task_resume, "STORE_DIR", fichier / "sous")
    assert _task_resume.put("alice", "t1-abc", REC) is False
    assert _task_resume.get("alice", "t1-abc", 3600) is None
    _task_resume.prune(3600, 5)            # ne lève pas


# ── Intégration avec task_tool ──────────────────────────────────────────────

def test_lookup_retombe_sur_le_disque_et_rehydrate_le_cache():
    """Le worker qui reçoit la reprise n'a rien en mémoire : il doit lire le
    store partagé, puis garder l'entrée en cache local."""
    _task_resume.put("alice", "t1-abc", REC)
    assert ("alice", "t1-abc") not in task_tool._RESUME_STORE

    got = task_tool._resume_lookup("alice", "t1-abc")

    assert got is not None and got["agent"] == "explore"
    assert ("alice", "t1-abc") in task_tool._RESUME_STORE


def test_lookup_prefere_la_memoire():
    task_tool._RESUME_STORE[("alice", "t1-abc")] = dict(REC, agent="memoire")
    _task_resume.put("alice", "t1-abc", dict(REC, agent="disque"))
    assert task_tool._resume_lookup("alice", "t1-abc")["agent"] == "memoire"


def test_lookup_inconnu_rend_none():
    assert task_tool._resume_lookup("alice", "jamais-vu") is None


# ── AUDIT 2026-09-24 (point 11) — L1 périmé face au disque ──────────────────

def test_peek_ts_suit_le_ts_du_record():
    _task_resume.put("alice", "t1-abc", dict(REC, ts=1_000_000.5))
    assert abs(_task_resume.peek_ts("alice", "t1-abc") - 1_000_000.5) < 1e-3
    assert _task_resume.peek_ts("alice", "absent") is None


def test_lookup_prend_le_disque_quand_il_est_plus_recent():
    """Un autre worker a repris l'agent et réécrit le store partagé : le L1 de
    ce worker est périmé et ne doit plus être servi (sinon il écrase ensuite
    le travail plus récent sur disque)."""
    t = time.time()
    task_tool._RESUME_STORE[("alice", "t1-abc")] = dict(REC, agent="vieux", ts=t - 60)
    _task_resume.put("alice", "t1-abc", dict(REC, agent="recent", ts=t))
    got = task_tool._resume_lookup("alice", "t1-abc")
    assert got["agent"] == "recent"
    assert task_tool._RESUME_STORE[("alice", "t1-abc")]["agent"] == "recent"


def test_lookup_garde_le_l1_quand_le_disque_manque():
    """Record trop gros pour le disque (ou retiré) : le L1 reste la source."""
    task_tool._RESUME_STORE[("alice", "t1-abc")] = dict(REC, agent="memoire")
    assert task_tool._resume_lookup("alice", "t1-abc")["agent"] == "memoire"
