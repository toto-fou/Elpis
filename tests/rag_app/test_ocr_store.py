# SPDX-License-Identifier: MIT
"""tests/rag_app/test_ocr_store.py — stockage disque des documents OCR.

Version MONO-TENANT du store (plus d'user_id nulle part). Couvre : cycle de
vie (create/read/update/list/delete), validation du doc_id (anti-traversal),
résultats de page, réconciliation des jobs orphelins (heartbeat figé) avec
respect du prédicat « job vivant dans ce process », recherche plafonnée,
usage disque.
"""
from __future__ import annotations

import time

import pytest

from rag_app.ocr import store


@pytest.fixture
def root(monkeypatch, tmp_path):
    """Racine du store isolée — court-circuite la lecture de rag_config.json."""
    monkeypatch.setattr(store, "ocr_root", lambda: tmp_path)
    return tmp_path


def test_create_et_lecture(root):
    d = store.create_doc("Rapport final.pdf", ".pdf")
    meta = store.read_meta(d)
    assert meta["status"] == "uploaded"
    assert meta["name"] == "Rapport final.pdf"
    assert store._DOC_ID_RE.match(meta["id"])
    for sub in ("pages", "text", "result", "boxes"):
        assert (d / sub).is_dir()


def test_nom_sans_separateurs(root):
    d = store.create_doc("../..\\evil.pdf", ".pdf")
    assert "/" not in store.read_meta(d)["name"]
    assert "\\" not in store.read_meta(d)["name"]


def test_extension_refusee(root):
    with pytest.raises(ValueError):
        store.create_doc("x.exe", ".exe")


def test_doc_id_invalide_rejete(root):
    for bad in ("../autre", "abc", "20260721-120000-zzzz zzz", ""):
        with pytest.raises(FileNotFoundError):
            store.doc_dir(bad)


def test_update_meta_atomique(root):
    d = store.create_doc("a.pdf", ".pdf")
    meta = store.update_meta(d, lambda m: m.__setitem__("status", "running"))
    assert meta["status"] == "running"
    assert store.read_meta(d)["status"] == "running"
    assert not (d / "meta.json.tmp").exists()


def test_page_result_et_load(root):
    d = store.create_doc("a.pdf", ".pdf")
    store.update_meta(d, lambda m: m.update(
        pages=[{"n": 1, "w": 100, "h": 200, "chars": 5,
                "status": "running", "edited": False, "divergence": None, "boxes": 0}],
        pages_total=1))
    store.save_page_result(d, 1, "# Bonjour", [{"text": "t", "box": [1, 2, 3, 4]}], 0.12)
    page = store.load_page(d, 1)
    assert page["md"] == "# Bonjour"
    assert page["boxes"] == [{"text": "t", "box": [1, 2, 3, 4]}]
    assert page["status"] == "done" and page["divergence"] == 0.12
    with pytest.raises(FileNotFoundError):
        store.load_page(d, 99)


def test_list_et_delete(root):
    d1 = store.create_doc("a.pdf", ".pdf")
    time.sleep(0.02)
    store.create_doc("b.docx", ".docx")
    items = store.list_docs()
    assert [i["name"] for i in items] == ["b.docx", "a.pdf"]   # récents d'abord
    assert store.count_docs() == 2
    store.delete_doc(store.read_meta(d1)["id"])
    assert store.count_docs() == 1


def test_reconcile_orphelin(root):
    d = store.create_doc("a.pdf", ".pdf")
    store.update_meta(d, lambda m: (
        m.__setitem__("status", "running"),
        m.__setitem__("heartbeat_at", time.time() - store.STALE_SEC - 10),
        m.__setitem__("pages", [{"n": 1, "status": "running"}])))
    meta = store.reconcile_stale(d, store.read_meta(d))
    assert meta["status"] == "error"
    assert meta["pages"][0]["status"] == "error"


def test_reconcile_respecte_le_job_local(root):
    d = store.create_doc("a.pdf", ".pdf")
    store.update_meta(d, lambda m: (
        m.__setitem__("status", "running"),
        m.__setitem__("heartbeat_at", time.time() - store.STALE_SEC - 10)))
    meta = store.reconcile_stale(d, store.read_meta(d),
                                 running_probe=lambda doc_id: True)
    assert meta["status"] == "running"   # une task vit ici → pas orphelin


def test_reconcile_heartbeat_frais(root):
    d = store.create_doc("a.pdf", ".pdf")
    store.update_meta(d, lambda m: m.__setitem__("status", "running"))
    assert store.reconcile_stale(d, store.read_meta(d))["status"] == "running"


def _doc_avec_pages(root, n=3, md="texte de la page"):
    d = store.create_doc("multi.pdf", ".pdf")
    pages = []
    for i in range(1, n + 1):
        store.page_result_path(d, i).write_text(f"{md} {i}", encoding="utf-8")
        pages.append({"n": i, "w": 100, "h": 100, "chars": 0, "status": "done",
                      "edited": False, "divergence": None, "boxes": 0})
    store.update_meta(d, lambda m: (m.__setitem__("pages", pages),
                                    m.__setitem__("pages_total", n),
                                    m.__setitem__("pages_done", n)))
    return d


def test_iter_page_markdown(root):
    d = _doc_avec_pages(root, 3)
    store.page_result_path(d, 2).unlink()     # page sans résultat → sautée
    out = list(store.iter_page_markdown(d, store.read_meta(d)))
    assert [n for n, _ in out] == [1, 3]
    assert out[0][1] == "texte de la page 1"


def test_search_retourne_partial(root, monkeypatch):
    """Le scan est PLAFONNÉ en lectures : au-delà, partial=true (l'UI peut
    le signaler) — max_page_hits seul ne bornait pas les read_text."""
    _doc_avec_pages(root, 4, md="alpha bravo")
    monkeypatch.setattr(store, "_MAX_SCAN_FILES", 2)
    res = store.search_docs("alpha")
    assert res["partial"] is True
    assert len(res["items"][0]["pages"]) == 2      # 2 fichiers lus seulement
    monkeypatch.setattr(store, "_MAX_SCAN_FILES", 2000)
    res2 = store.search_docs("alpha")
    assert res2["partial"] is False
    assert len(res2["items"][0]["pages"]) == 4
    assert store.search_docs("x") == {"items": [], "partial": False}


def test_disk_usage(root):
    d = _doc_avec_pages(root, 2, md="0123456789")
    assert store.disk_usage() > 0
    before = store.disk_usage()
    store.page_result_path(d, 1).write_text("0123456789" * 100, encoding="utf-8")
    assert store.disk_usage() > before
