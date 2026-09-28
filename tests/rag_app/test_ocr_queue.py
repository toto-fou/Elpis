# SPDX-License-Identifier: MIT
"""tests/rag_app/test_ocr_queue.py — file d'attente FIFO persistée (globale).

Version MONO-TENANT (une seule file pour le service). Couvre : enqueue
(dédoublonnage, borne, lot), pop (pause/actif), solde du lot (une seule
fois), retrait (refus de l'actif), vidage, réconciliation d'un actif
orphelin (re-tête, pages préservées), snapshot (purge des docs supprimés).
Tout est disque pur — aucun job réel.
"""
from __future__ import annotations

import time

import pytest

from rag_app.ocr import queue as Q
from rag_app.ocr import store


@pytest.fixture
def root(monkeypatch, tmp_path):
    monkeypatch.setattr(store, "ocr_root", lambda: tmp_path)
    return tmp_path


def _doc(name="a.pdf"):
    d = store.create_doc(name, ".pdf")
    return store.read_meta(d)["id"]


def test_enqueue_dedoublonne_et_ouvre_le_lot(root):
    a, b = _doc("a.pdf"), _doc("b.pdf")
    q = Q.enqueue([a, b, a])          # doublon ignoré
    assert [it["doc"] for it in q["items"]] == [a, b]
    assert q["batch"]["total"] == 2
    q = Q.enqueue([b])                # déjà en file → rien
    assert q["batch"]["total"] == 2


def test_enqueue_borne(root, monkeypatch):
    monkeypatch.setattr(Q, "MAX_QUEUE", 2)
    ids = [_doc(f"{i}.pdf") for i in range(4)]
    q = Q.enqueue(ids)
    assert len(q["items"]) == 2


def test_pop_respecte_pause_et_actif(root):
    a, b = _doc(), _doc("b.pdf")
    Q.enqueue([a, b])
    Q.set_paused(True)
    assert Q.pop_next() is None          # pause : rien ne sort
    Q.set_paused(False)
    item = Q.pop_next()
    assert item["doc"] == a
    assert Q.read_queue()["active"] == a
    assert Q.pop_next() is None          # un actif à la fois


def test_finish_solde_le_lot_une_seule_fois(root):
    a, b = _doc(), _doc("b.pdf")
    Q.enqueue([a, b])
    Q.pop_next()
    q, batch = Q.finish_active(a, "done")
    assert batch is None                  # b attend encore
    Q.pop_next()
    q, batch = Q.finish_active(b, "error")
    assert batch == {"total": 2, "done": 1, "failed": 1, "canceled": 0,
                     "started_at": batch["started_at"]}
    assert q["batch"] is None             # lot clôturé
    _q, again = Q.finish_active(b, "done")
    assert again is None                  # jamais deux notices


def test_remove_refuse_l_actif(root):
    a, b = _doc(), _doc("b.pdf")
    Q.enqueue([a, b])
    Q.pop_next()
    assert Q.remove_item(a) is False   # actif → non
    assert Q.remove_item(b) is True
    assert Q.read_queue()["items"] == []


def test_clear(root):
    a, b = _doc(), _doc("b.pdf")
    Q.enqueue([a, b])
    q = Q.clear()
    assert q["items"] == [] and q["batch"] is None


def test_reconcile_retete_un_actif_orphelin(root):
    a, b = _doc(), _doc("b.pdf")
    Q.enqueue([a, b])
    Q.pop_next()
    # L'actif n'est plus vivant (statut uploaded, heartbeat quelconque).
    q = Q.reconcile()
    assert q["active"] is None
    assert [it["doc"] for it in q["items"]] == [a, b]   # re-TÊTE


def test_reconcile_respecte_un_actif_vivant(root):
    a = _doc()
    Q.enqueue([a])
    Q.pop_next()
    d = store.ocr_root() / a
    store.update_meta(d, lambda m: (m.__setitem__("status", "running"),
                                    m.__setitem__("heartbeat_at", time.time())))
    q = Q.reconcile()
    assert q["active"] == a               # heartbeat frais → pas touché
    q = Q.reconcile(running_probe=lambda doc_id: True)
    assert q["active"] == a


def test_reconcile_actif_supprime(root):
    a = _doc()
    Q.enqueue([a])
    Q.pop_next()
    store.delete_doc(a)
    q = Q.reconcile()
    assert q["active"] is None and q["items"] == []
    # File vidée : le lot est CLOS (et rendu pour la notice de fin de lot).
    assert q["batch"] is None and q["closed_batch"]["canceled"] == 1


def test_snapshot_purge_les_docs_disparus(root):
    a, b = _doc("garde.pdf"), _doc("efface.pdf")
    Q.enqueue([a, b])
    store.delete_doc(b)
    snap = Q.snapshot()
    assert [it["doc"] for it in snap["items"]] == [a]
    assert snap["items"][0]["name"] == "garde.pdf"
    assert snap["items"][0]["position"] == 1
    # la purge est PERSISTÉE (pas seulement cosmétique)
    assert [it["doc"] for it in Q.read_queue()["items"]] == [a]
