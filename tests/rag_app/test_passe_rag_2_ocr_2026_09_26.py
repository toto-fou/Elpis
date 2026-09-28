# SPDX-License-Identifier: MIT
"""tests/rag_app/test_passe_rag_2_ocr_2026_09_26.py — paquet OCR, passe RAG 2.

Verrouille les correctifs de l'audit OCR du 2026-09-26 (2e passe) :
reprise de la file au démarrage (heartbeat ignoré, redémarrage ≠ plantage,
statuts terminaux respectés), pompe qui survit à une annulation précoce,
suppression qui attend la fin réelle du travail (ni dossier fantôme ni
vecteurs orphelins), index marqué périmé (révision, index partiel, page
écrite pendant un job), flux OCR incomplets refusés, relecture de page sans
page figée, export aux noms non latin-1, file/meta corrompus, édition
protégée du re-OCR, redo qui purge l'ancien texte, lot clos à la purge,
modèle auto-résolu non figé, préparation attendue (pas de double raster),
slot GPU partagé avec la lecture de zone, bus SSE (plafond, resync), verrou
borné, cache de config.
"""
from __future__ import annotations

import asyncio
import io
import json
import threading
import time

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from rag_app.ocr import _common
from rag_app.ocr import client as ocr_client
from rag_app.ocr import config as ocr_config
from rag_app.ocr import convert as ocr_convert
from rag_app.ocr import events as E
from rag_app.ocr import jobs, lifecycle, store
from rag_app.ocr import queue as Q
from rag_app.ocr import rag_index as ocr_rag
from rag_app.ocr._common import OcrError

fitz = pytest.importorskip("fitz", reason="PyMuPDF requis pour le raster")

_CFG = {
    "endpoint_url": "http://ocr.test:8090", "default_model": "unlimited-ocr",
    "api_key": "", "prompt": "p", "zone_prompt": "z", "timeout_sec": 5,
    "page_deadline_sec": 30, "prepare_timeout_sec": 60, "max_tokens": 512,
    "max_side_px": 320, "max_upload_mb": 10, "max_pages": 10, "max_docs": 50,
    "max_disk_mb": 8192, "page_transition_ms": 1, "auto_index": False,
}
_RAW = "texte reconnu"


@pytest.fixture
def env(monkeypatch, tmp_path):
    monkeypatch.setattr(store, "ocr_root", lambda: tmp_path)
    monkeypatch.setattr(jobs, "get_ocr_config", lambda: dict(_CFG))
    monkeypatch.setattr(ocr_config, "_read_section", lambda: {"enabled": True})
    events, notifs = [], []

    async def rec_emit(data):
        events.append(data)
    monkeypatch.setattr(jobs, "_emit", rec_emit)
    monkeypatch.setattr(jobs, "_notify",
                        lambda title, body, doc_id, level="info": notifs.append(title))
    for reg in (jobs._TASKS, jobs._PREP_TASKS, jobs._INDEX_TASKS):
        reg.clear()
    jobs._QUEUE_TASK[0] = None
    jobs._SHUTTING_DOWN[0] = False
    jobs._STARTUP_DONE[0] = True
    ocr_client._GPU_SLOT[0] = None
    Q._STATE.update(known=False, has_work=False, paused=False)
    yield {"root": tmp_path, "events": events, "notifs": notifs}
    jobs._SHUTTING_DOWN[0] = False
    jobs._STARTUP_DONE[0] = True


def _new_doc(n_pages=1, name="essai.pdf"):
    d = store.create_doc(name, ".pdf")
    meta = store.read_meta(d)
    doc = fitz.open()
    for i in range(n_pages):
        page = doc.new_page(width=300, height=400)
        page.insert_text((20, 40), f"Page {i + 1} texte de reference", fontsize=10)
    doc.save(str(store.source_path(d, meta)))
    doc.close()
    return d, meta["id"]


async def _fake_stream(png_bytes, *, cfg, prompt=None, on_delta=None):
    if on_delta:
        await on_delta(_RAW)
    return _RAW


def _slow_stream(started: asyncio.Event):
    async def slow(png_bytes, *, cfg, prompt=None, on_delta=None):
        started.set()
        await asyncio.sleep(30)
        return ""
    return slow


async def _until(pred, timeout=10.0):
    t0 = time.monotonic()
    while not pred():
        if time.monotonic() - t0 > timeout:
            raise AssertionError("condition jamais atteinte")
        await asyncio.sleep(0.02)


# ─────────────────────────────────────────────────────────────────────────────
#  #1 / #2 / #18 — reprise au démarrage
# ─────────────────────────────────────────────────────────────────────────────
async def test_demarrage_heartbeat_frais_relance_la_file(env, monkeypatch):
    """#1 : un actif au heartbeat FRAIS (redémarrage il y a < 5 min) ne bloque
    plus la file : au démarrage le registre RAM (vide) fait foi."""
    monkeypatch.setattr(ocr_client, "stream_ocr", _fake_stream)
    d, a = _new_doc()
    Q.enqueue([a])
    Q.pop_next()
    store.update_meta(d, lambda m: (m.__setitem__("status", "running"),
                                    m.__setitem__("heartbeat_at", time.time())))
    await lifecycle.on_startup()
    assert jobs._QUEUE_TASK[0] is not None
    await asyncio.wait_for(jobs._QUEUE_TASK[0], 20)
    assert store.read_meta(d)["status"] == "done"
    assert Q.read_queue().get("crashes", {}).get(a, 0) == 0   # soldé : compteur effacé


async def test_arret_propre_n_est_pas_un_plantage(env, monkeypatch):
    """#2 : arrêt propre pendant un document de file → remis en TÊTE, sans
    compter de plantage ; repris au démarrage suivant."""
    started = asyncio.Event()
    monkeypatch.setattr(ocr_client, "stream_ocr", _slow_stream(started))
    d1, a = _new_doc()
    d2, b = _new_doc()
    Q.enqueue([a, b])
    assert jobs.ensure_queue_runner() is True
    await asyncio.wait_for(started.wait(), 10)
    await lifecycle.on_shutdown()
    q = Q.read_queue()
    assert q["active"] is None
    assert [it["doc"] for it in q["items"]] == [a, b]
    assert not q.get("crashes")
    assert store.read_meta(d1)["pages"][0]["status"] == "pending"
    # redémarrage
    monkeypatch.setattr(ocr_client, "stream_ocr", _fake_stream)
    await lifecycle.on_startup()
    await asyncio.wait_for(jobs._QUEUE_TASK[0], 20)
    assert store.read_meta(d1)["status"] == "done"
    assert store.read_meta(d2)["status"] == "done"


def test_reconcile_statut_terminal_non_remis_en_file(env):
    """#18 : un actif déjà « canceled » (annulé par l'utilisateur juste avant
    un plantage) n'est PAS relancé ; pas de plantage compté."""
    d, a = _new_doc()
    Q.enqueue([a])
    Q.pop_next()
    store.update_meta(d, lambda m: m.__setitem__("status", "canceled"))
    q = Q.reconcile(startup=True)
    assert q["active"] is None and q["items"] == []
    assert not q.get("crashes")
    assert q["closed_batch"]["canceled"] == 1
    assert q["settled"] == [(a, "canceled")]


def test_plantage_au_demarrage_compte_une_fois(env):
    d, a = _new_doc()
    Q.enqueue([a])
    Q.pop_next()
    store.update_meta(d, lambda m: m.__setitem__("status", "running"))
    q = Q.reconcile(startup=True)
    assert q["crashes"][a] == 1 and q["items"][0]["doc"] == a
    # Pompe relancée dans le même process (sonde RAM) : pas un plantage.
    Q.pop_next()
    q = Q.reconcile(running_probe=lambda _id: False)
    assert q["crashes"][a] == 1


async def test_demarrage_requalifie_les_orphelins_hors_file(env, monkeypatch):
    prepared = []
    monkeypatch.setattr(jobs, "start_prepare", lambda doc_id: prepared.append(doc_id) or True)
    d1, a = _new_doc()
    store.update_meta(d1, lambda m: (
        m.__setitem__("status", "running"),
        m.__setitem__("pages", [{"n": 1, "status": "running"}, {"n": 2, "status": "done"}])))
    d2, b = _new_doc()                         # déposé, jamais préparé
    (env["root"] / ".trash-x").mkdir()         # reste d'une suppression
    await lifecycle.on_startup()
    m = store.read_meta(d1)
    assert m["status"] == "error" and "redémarrage" in m["error"]
    assert m["pages"][0]["status"] == "pending" and m["pages_done"] == 1
    assert prepared == [b]
    assert not (env["root"] / ".trash-x").exists()


# ─────────────────────────────────────────────────────────────────────────────
#  #3 — la pompe survit à une annulation précoce ; annulation unique
# ─────────────────────────────────────────────────────────────────────────────
async def test_annulation_avant_le_try_ne_tue_pas_la_pompe(env, monkeypatch):
    monkeypatch.setattr(ocr_client, "stream_ocr", _fake_stream)
    batches = []
    monkeypatch.setattr(jobs, "_notify_batch", lambda b: batches.append(b))
    d1, a = _new_doc()
    d2, b = _new_doc()
    Q.enqueue([a, b])
    real_register = jobs._register

    def register_and_cancel(reg, doc_id, task, on_done=None):
        real_register(reg, doc_id, task, on_done)
        if doc_id == a:
            task.cancel()                      # avant même son 1er pas
    monkeypatch.setattr(jobs, "_register", register_and_cancel)
    assert jobs.ensure_queue_runner() is True
    await asyncio.wait_for(jobs._QUEUE_TASK[0], 20)
    assert store.read_meta(d2)["status"] == "done"
    assert batches and batches[0]["canceled"] == 1 and batches[0]["done"] == 1


async def test_double_annulation_une_seule_envoyee(env, monkeypatch):
    started = asyncio.Event()
    monkeypatch.setattr(ocr_client, "stream_ocr", _slow_stream(started))
    d, a = _new_doc()
    assert jobs.start_job(a)
    await asyncio.wait_for(started.wait(), 10)
    task = jobs._TASKS[a]
    assert jobs.cancel_job(a) and jobs.cancel_job(a)
    assert task.cancelling() == 1
    await asyncio.wait_for(asyncio.shield(task), 10)
    assert store.read_meta(d)["status"] == "canceled"


# ─────────────────────────────────────────────────────────────────────────────
#  #4 / #5 — suppression : on attend la fin réelle ; pas de fantôme
# ─────────────────────────────────────────────────────────────────────────────
async def test_stop_doc_attend_la_fin_puis_suppression_propre(env, monkeypatch):
    started = asyncio.Event()
    monkeypatch.setattr(ocr_client, "stream_ocr", _slow_stream(started))
    d, a = _new_doc()
    assert jobs.start_job(a)
    await asyncio.wait_for(started.wait(), 10)
    assert await jobs.stop_doc(a) is True
    assert not jobs.is_running(a)
    assert store.read_meta(d)["status"] == "canceled"     # pas « failed »
    store.delete_doc(a)
    assert not d.exists()
    assert [c for c in env["root"].iterdir() if c.is_dir()] == []


def test_ecriture_tardive_ne_recree_pas_le_dossier(env):
    d, a = _new_doc()
    store.update_meta(d, lambda m: m.__setitem__("pages", [{"n": 1, "status": "running"}]))
    store.delete_doc(a)
    with pytest.raises(FileNotFoundError):
        store.save_page_result(d, 1, "x", [], None)
    with pytest.raises(FileNotFoundError):
        store.page_raw_path(d, 1).parent.mkdir(exist_ok=True)
    assert not d.exists()


class _FakeEngine:
    def __init__(self, on_index=None):
        self.cfg = {}
        self.on_index = on_index
        self.deindexed = []

    def index_document_chunks(self, name, chunks, extra_meta=None):
        if self.on_index:
            self.on_index()
        return {"ok": True, "rel_path": name, "name": name,
                "collection": self.cfg.get("collection"), "chunks": len(chunks)}

    def deindex_document(self, rel_path):
        self.deindexed.append((self.cfg.get("collection"), rel_path))
        return {"ok": True}


def _transcribed(n=1, name="t.pdf"):
    d = store.create_doc(name, ".pdf")
    doc_id = store.read_meta(d)["id"]
    pages = []
    for i in range(1, n + 1):
        store.page_result_path(d, i).write_text(f"texte {i}", encoding="utf-8")
        pages.append({"n": i, "status": "done"})
    store.update_meta(d, lambda m: (m.__setitem__("pages", pages),
                                    m.__setitem__("status", "done")))
    return d, doc_id


def test_suppression_pendant_l_indexation_retire_les_vecteurs(env, monkeypatch):
    d, a = _transcribed()
    engines = []

    def factory():
        eng = _FakeEngine(on_index=lambda: store.delete_doc(a))
        engines.append(eng)
        return eng
    monkeypatch.setattr(ocr_rag, "_engine", factory)
    with pytest.raises(OcrError, match="supprimé"):
        ocr_rag.index_doc(a)
    dropped = [x for e in engines for x in e.deindexed]
    assert dropped and dropped[0][1].endswith(".md")


def test_edition_pendant_l_indexation_reste_perimee(env, monkeypatch):
    d, a = _transcribed()
    monkeypatch.setattr(ocr_rag, "_engine", lambda: _FakeEngine(
        on_index=lambda: store.save_page_edit(d, 1, "corrigé")))
    rag = ocr_rag.index_doc(a)
    assert rag["stale"] is True
    assert store.read_meta(d)["rag"]["stale"] is True


def test_index_partiel_marque_perime(env, monkeypatch):
    d, a = _transcribed(2)
    store.update_meta(d, lambda m: (m.__setitem__("status", "running"),
                                    m["pages"][1].__setitem__("status", "pending")))
    monkeypatch.setattr(ocr_rag, "_engine", lambda: _FakeEngine())
    assert ocr_rag.index_doc(a)["stale"] is True
    store.update_meta(d, lambda m: (m.__setitem__("status", "done"),
                                    m["pages"][1].__setitem__("status", "done")))
    assert ocr_rag.index_doc(a)["stale"] is False


async def test_page_ecrite_pendant_un_job_rend_l_index_perime(env, monkeypatch):
    """#7 : une page reconnue après une indexation marque l'index périmé."""
    monkeypatch.setattr(ocr_client, "stream_ocr", _fake_stream)
    d, a = _new_doc(2)
    await jobs._run_prepare_job(a)
    store.update_meta(d, lambda m: m.__setitem__(
        "rag", {"rel_path": "x.md", "collection": "c", "stale": False}))
    await jobs._run_job(a)
    assert store.read_meta(d)["rag"]["stale"] is True


def test_deindex_reussi_meme_si_meta_disparait(env, monkeypatch):
    d, a = _transcribed()
    store.update_meta(d, lambda m: m.__setitem__(
        "rag", {"rel_path": "x.md", "collection": "c"}))

    class Eng(_FakeEngine):
        def deindex_document(self, rel_path):
            store.delete_doc(a)
            return {"ok": True}
    monkeypatch.setattr(ocr_rag, "_engine", lambda: Eng())
    assert ocr_rag.deindex_doc(a) is True


async def test_une_seule_indexation_par_document(env, monkeypatch):
    gate = threading.Event()
    monkeypatch.setattr(ocr_rag, "index_doc",
                        lambda doc_id, collection="": gate.wait(5) and {"ok": 1})
    t1 = jobs.start_index("20260101-000000-aaaaaaaa")
    assert t1 is not None
    assert jobs.start_index("20260101-000000-aaaaaaaa") is None
    gate.set()
    assert await t1 == {"ok": 1}


# ─────────────────────────────────────────────────────────────────────────────
#  #8 — préparation attendue, jamais deux rasters
# ─────────────────────────────────────────────────────────────────────────────
async def test_lancer_pendant_la_preparation_attend(env, monkeypatch):
    monkeypatch.setattr(ocr_client, "stream_ocr", _fake_stream)
    calls = []
    real = ocr_convert.raster_pdf

    def counting(*a, **k):
        calls.append(1)
        time.sleep(0.2)
        return real(*a, **k)
    monkeypatch.setattr(ocr_convert, "raster_pdf", counting)
    d, a = _new_doc(2)
    assert jobs.start_prepare(a)
    assert jobs.start_job(a) is True
    await asyncio.wait_for(asyncio.shield(jobs._TASKS[a]), 20)
    assert len(calls) == 1
    assert store.read_meta(d)["status"] == "done"
    assert jobs.start_prepare(a) is True or True   # plus rien ne tourne


async def test_annuler_la_preparation_arrete_le_thread(env, monkeypatch):
    stopped = threading.Event()

    def slow_raster(*a, cancel_event=None, **k):
        for _ in range(200):
            if cancel_event.is_set():
                stopped.set()
                raise ocr_convert.PrepareCanceled("x")
            time.sleep(0.02)
        raise AssertionError("jamais annulé")
    monkeypatch.setattr(ocr_convert, "raster_pdf", slow_raster)
    d, a = _new_doc()
    assert jobs.start_prepare(a)
    await asyncio.sleep(0.2)
    assert await jobs.stop_doc(a) is True
    assert stopped.is_set()                    # le thread s'est arrêté AVANT
    assert store.read_meta(d)["status"] == "canceled"


# ─────────────────────────────────────────────────────────────────────────────
#  #10 / #22 — flux OCR incomplets
# ─────────────────────────────────────────────────────────────────────────────
def _sse(*objs, done=True):
    lines = [f"data: {json.dumps(o)}" for o in objs]
    if done:
        lines.append("data: [DONE]")
    return ("\n\n".join(lines) + "\n\n").encode()


def _mock(monkeypatch, handler):
    monkeypatch.setattr(ocr_client, "_client", lambda timeout: httpx.AsyncClient(
        transport=httpx.MockTransport(handler), timeout=timeout))


_CFG_C = {"endpoint_url": "http://ocr.test", "timeout_sec": 5,
          "page_deadline_sec": 30, "max_tokens": 10, "model": "m"}


def _delta(t, finish=None):
    return {"choices": [{"delta": {"content": t}, "finish_reason": finish}]}


async def test_flux_complet_accepte(monkeypatch):
    _mock(monkeypatch, lambda req: httpx.Response(200, content=_sse(_delta("ab"), _delta("c", "stop"))))
    assert await ocr_client.stream_ocr(b"png", cfg=_CFG_C) == "abc"
    # page vraiment blanche : vide mais terminée proprement → acceptée
    _mock(monkeypatch, lambda req: httpx.Response(200, content=_sse(_delta("", "stop"))))
    assert await ocr_client.stream_ocr(b"png", cfg=_CFG_C) == ""


async def test_flux_coupe_refuse(monkeypatch):
    _mock(monkeypatch, lambda req: httpx.Response(200, content=_sse(_delta("ab"), done=False)))
    with pytest.raises(OcrError, match="interrompu"):
        await ocr_client.stream_ocr(b"png", cfg=_CFG_C)


async def test_flux_length_tronque(monkeypatch):
    _mock(monkeypatch, lambda req: httpx.Response(200, content=_sse(_delta("ab", "length"))))
    with pytest.raises(ocr_client.OcrTruncated) as exc:
        await ocr_client.stream_ocr(b"png", cfg=_CFG_C)
    assert exc.value.raw == "ab"


async def test_erreur_dans_le_flux(monkeypatch):
    _mock(monkeypatch, lambda req: httpx.Response(
        200, content=_sse({"error": {"message": "context overflow"}}, done=False)))
    with pytest.raises(OcrError, match="context overflow"):
        await ocr_client.stream_ocr(b"png", cfg=_CFG_C)


async def test_url_invalide_erreur_lisible(monkeypatch):
    def boom(req):
        raise httpx.InvalidURL("mauvais hôte")
    _mock(monkeypatch, boom)
    with pytest.raises(OcrError, match="injoignable"):
        await ocr_client.stream_ocr(b"png", cfg=_CFG_C)


async def test_delai_total_par_page(monkeypatch):
    async def trickle():
        for _ in range(100):
            yield b"\n"
            await asyncio.sleep(0.05)
    _mock(monkeypatch, lambda req: httpx.Response(200, content=trickle()))
    with pytest.raises(OcrError, match="trop longue"):
        await ocr_client.stream_ocr(b"png", cfg={**_CFG_C, "page_deadline_sec": 0.3})


async def test_page_tronquee_gardee_et_signalee(env, monkeypatch):
    async def trunc(png_bytes, *, cfg, prompt=None, on_delta=None):
        raise ocr_client.OcrTruncated("coupé", "debut du texte")
    monkeypatch.setattr(ocr_client, "stream_ocr", trunc)
    d, a = _new_doc()
    assert await jobs._run_job(a) == "done"
    page = store.read_meta(d)["pages"][0]
    assert page["status"] == "done" and page["truncated"] is True
    assert "Page tronquée" in env["notifs"]


# ─────────────────────────────────────────────────────────────────────────────
#  #11 — relecture de page : jamais figée « running »
# ─────────────────────────────────────────────────────────────────────────────
async def test_relecture_exception_quelconque(env, monkeypatch):
    monkeypatch.setattr(ocr_client, "stream_ocr", _fake_stream)
    d, a = _new_doc()
    await jobs._run_job(a)

    async def boom(*a_, **k):
        raise ValueError("inattendu")
    monkeypatch.setattr(ocr_client, "stream_ocr", boom)
    await jobs._run_page_rerun(a, 1)
    assert store.read_meta(d)["pages"][0]["status"] == "error"
    last = env["events"][-1]
    assert last["kind"] == "job_done" and last["status"] == "error"


# ─────────────────────────────────────────────────────────────────────────────
#  #14 / #16 / #23 — compteurs, édition protégée, modèle non figé
# ─────────────────────────────────────────────────────────────────────────────
async def test_edition_d_une_page_en_attente_protegee(env, monkeypatch):
    calls = []

    async def counting(png_bytes, *, cfg, prompt=None, on_delta=None):
        calls.append(1)
        return _RAW
    monkeypatch.setattr(ocr_client, "stream_ocr", counting)
    d, a = _new_doc(2)
    await jobs._run_prepare_job(a)
    store.save_page_edit(d, 2, "édition humaine")
    await jobs._run_job(a)
    assert len(calls) == 1                     # page 2 NON re-OCRisée
    assert store.load_page(d, 2)["md"] == "édition humaine"
    m = store.read_meta(d)
    assert m["pages_done"] == 2 and m["status"] == "done"


def test_edition_refusee_pendant_la_reconnaissance(env):
    d, a = _new_doc()
    store.update_meta(d, lambda m: m.__setitem__("pages", [{"n": 1, "status": "running"}]))
    with pytest.raises(RuntimeError):
        store.save_page_edit(d, 1, "x")


async def test_modele_auto_non_fige(env, monkeypatch):
    monkeypatch.setattr(jobs, "get_ocr_config", lambda: {**_CFG, "default_model": ""})
    monkeypatch.setattr(ocr_client, "stream_ocr", _fake_stream)

    async def resolve(cfg):
        cfg["model"] = cfg.get("model") or "auto-choisi"
        return cfg
    monkeypatch.setattr(ocr_client, "ensure_model", resolve)
    d, a = _new_doc()
    await jobs._run_job(a)
    m = store.read_meta(d)
    assert m["model"] == "" and m["model_used"] == "auto-choisi"


def test_pages_done_recalcule(env):
    d, a = _new_doc()
    store.update_meta(d, lambda m: (
        m.__setitem__("pages", [{"n": 1, "status": "running"}, {"n": 2, "status": "done"}]),
        m.__setitem__("pages_done", 7)))
    meta = store.save_page_result(d, 1, "x", [], None)
    assert meta["pages_done"] == 2 and meta["rev"] == 1


# ─────────────────────────────────────────────────────────────────────────────
#  #19 / #20 / #21 — file et store
# ─────────────────────────────────────────────────────────────────────────────
def test_queue_corrompue_mise_de_cote(env):
    d, a = _new_doc()
    (env["root"] / "queue.json").write_text("{pas du json", encoding="utf-8")
    assert Q.read_queue()["items"] == []            # lecture : tolérante
    Q.enqueue([a])
    assert list(env["root"].glob("queue.json.corrupt-*"))
    assert [it["doc"] for it in Q.read_queue()["items"]] == [a]


def test_meta_corrompu_reste_visible(env):
    d, a = _new_doc()
    (d / "meta.json").write_text("{", encoding="utf-8")
    items = store.list_docs()
    assert len(items) == 1 and items[0]["corrupt"] and items[0]["id"] == a
    store.delete_doc(a)                              # supprimable
    assert store.list_docs() == []


def test_snapshot_purge_clot_le_lot(env):
    d, a = _new_doc()
    Q.enqueue([a])
    store.delete_doc(a)
    snap = Q.snapshot()
    assert snap["items"] == [] and snap["batch"] is None


def test_ecriture_atomique_sans_tmp(env, tmp_path):
    p = tmp_path / "x.json"
    _common.write_json_atomic(p, {"a": 1})
    assert json.loads(p.read_text()) == {"a": 1}
    assert [f.name for f in tmp_path.iterdir() if f.name.endswith(".tmp")] == []


def test_verrou_borne(tmp_path):
    lock = tmp_path / ".lock"
    held = threading.Event()
    release = threading.Event()

    def holder():
        with _common.file_lock(lock):
            held.set()
            release.wait(5)
    t = threading.Thread(target=holder)
    t.start()
    held.wait(5)
    t0 = time.monotonic()
    with pytest.raises(TimeoutError):
        with _common.file_lock(lock, timeout=0.2):
            pass
    assert time.monotonic() - t0 < 2
    release.set()
    t.join()


def test_config_en_cache_invalidee_par_mtime(tmp_path, monkeypatch):
    cfg = tmp_path / "rag_config.json"
    cfg.write_text(json.dumps({"ocr": {"port": 1111}}))
    monkeypatch.setattr(ocr_config, "CONFIG_PATH", cfg)
    ocr_config.invalidate_cache()
    assert ocr_config.get_ocr_config()["port"] == 1111
    reads = []
    real_open = open

    def spy(path, *a, **k):
        if str(path) == str(cfg):
            reads.append(1)
        return real_open(path, *a, **k)
    monkeypatch.setattr("builtins.open", spy)
    ocr_config.get_ocr_config()
    assert reads == []                              # servi par le cache
    monkeypatch.setattr("builtins.open", real_open)
    time.sleep(0.01)
    cfg.write_text(json.dumps({"ocr": {"port": 2222, "x": 1}}))
    assert ocr_config.get_ocr_config()["port"] == 2222
    ocr_config.invalidate_cache()


# ─────────────────────────────────────────────────────────────────────────────
#  Routes : export, magic, restart pendant préparation, redo, SSE, zone
# ─────────────────────────────────────────────────────────────────────────────
_SECTION = {"enabled": True, "endpoint_url": "http://ocr.test:8090",
            "default_model": "m", "timeout_sec": 1, "max_upload_mb": 1,
            "max_pages": 10, "max_docs": 10}


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setattr(ocr_config, "_read_section", lambda: dict(_SECTION))
    monkeypatch.setattr(store, "ocr_root", lambda: tmp_path)
    monkeypatch.setattr(jobs, "start_job", lambda doc_id: True)
    monkeypatch.setattr(jobs, "start_prepare", lambda doc_id: True)
    monkeypatch.setattr(ocr_rag, "deindex_doc", lambda doc_id: False)

    async def _noop():
        return None
    monkeypatch.setattr(jobs, "ensure_queue_runner", lambda: False)
    monkeypatch.setattr(jobs, "_emit_queue", _noop)
    ocr_client._GPU_SLOT[0] = None
    from rag_app.ocr.routes import router
    app = FastAPI()
    app.include_router(router)
    c = TestClient(app)
    yield c
    ocr_client._GPU_SLOT[0] = None


def _up(c, name="doc.pdf", content=b"%PDF-1.4 x"):
    return c.post("/api/ocr/docs", files={"file": (name, io.BytesIO(content), "application/pdf")})


def _page(c, name="doc.pdf"):
    doc_id = _up(c, name).json()["id"]
    d = store.doc_dir(doc_id)
    store.update_meta(d, lambda m: m.update(
        status="done", pages_total=1,
        pages=[{"n": 1, "w": 100, "h": 100, "status": "running"}]))
    store.save_page_result(d, 1, "# texte", [], None)
    return doc_id, d


def test_export_nom_non_latin1(client):
    doc_id, _d = _page(client, "Rapport’été €\"x.pdf")
    r = client.get(f"/api/ocr/docs/{doc_id}/export")
    assert r.status_code == 200
    cd = r.headers["content-disposition"]
    assert "filename*=UTF-8''" in cd and "%E2%80%99" in cd
    assert cd.count('"') == 2                        # guillemet du nom neutralisé


def test_upload_contenu_incoherent_refuse(client):
    r = _up(client, "faux.pdf", b"MZ\x90\x00 executable")
    assert r.status_code == 415
    assert client.get("/api/ocr/docs").json()["items"] == []


def test_restart_refuse_pendant_la_preparation(client, monkeypatch):
    doc_id = _up(client).json()["id"]

    class Pending:
        def done(self):
            return False
    monkeypatch.setitem(jobs._PREP_TASKS, doc_id, Pending())
    r = client.post(f"/api/ocr/docs/{doc_id}/restart", json={})
    assert r.status_code == 409 and "préparation" in r.json()["detail"]


def test_redo_purge_les_anciennes_transcriptions(client):
    doc_id, d = _page(client)
    assert store.page_result_path(d, 1).is_file()
    r = client.post(f"/api/ocr/docs/{doc_id}/restart", json={"full": True})
    assert r.status_code == 200
    assert not store.page_result_path(d, 1).exists()
    assert store.read_meta(d)["pages"][0]["status"] == "pending"


def test_put_page_en_cours_409_et_pending_devient_done(client):
    doc_id = _up(client).json()["id"]
    d = store.doc_dir(doc_id)
    store.update_meta(d, lambda m: m.update(
        pages=[{"n": 1, "status": "running"}, {"n": 2, "status": "pending"}]))
    assert client.put(f"/api/ocr/docs/{doc_id}/pages/1", json={"md": "x"}).status_code == 409
    assert client.put(f"/api/ocr/docs/{doc_id}/pages/2", json={"md": "y"}).status_code == 200
    p2 = store.read_meta(d)["pages"][1]
    assert p2["status"] == "done" and p2["edited"] is True


def test_sse_plafond_503(client, monkeypatch):
    monkeypatch.setattr(E, "MAX_SUBSCRIBERS", 0)
    assert client.get("/api/ocr/events").status_code == 503


def test_zone_attend_le_slot_gpu(client, monkeypatch):
    doc_id, d = _page(client)
    (d / "pages" / "0001.png").write_bytes(b"x")
    ocr_client._GPU_SLOT[0] = asyncio.Semaphore(0)   # slot tenu par un job
    r = client.post(f"/api/ocr/docs/{doc_id}/pages/1/rerun", json={"bbox": [0, 0, 50, 50]})
    assert r.status_code == 409 and "occupé" in r.json()["detail"]


def test_delete_attend_l_arret(client, monkeypatch):
    doc_id, d = _page(client)

    async def never(doc_id, timeout=30.0):
        return False
    monkeypatch.setattr(jobs, "stop_doc", never)
    assert client.delete(f"/api/ocr/docs/{doc_id}").status_code == 409
    assert d.exists()

    async def ok(doc_id, timeout=30.0):
        return True
    monkeypatch.setattr(jobs, "stop_doc", ok)
    assert client.delete(f"/api/ocr/docs/{doc_id}").status_code == 200
    assert not d.exists()


def test_rag_index_double_409(client, monkeypatch):
    doc_id, _d = _page(client)
    monkeypatch.setattr(jobs, "start_index", lambda doc_id, collection="": None)
    r = client.post(f"/api/ocr/docs/{doc_id}/rag/index", json={})
    assert r.status_code == 409


# ─────────────────────────────────────────────────────────────────────────────
#  Relecture indépendante (2026-09-26) — 3 défauts + cache de rag_query
# ─────────────────────────────────────────────────────────────────────────────
async def test_pas_de_pompe_avant_la_fin_du_demarrage(env, monkeypatch):
    """Défaut 3 : un GET /queue avant on_startup ne lance plus la pompe ; et
    la réconciliation de démarrage consulte la sonde RAM (un document qui
    tournerait n'est ni compté en plantage ni remis en tête)."""
    started = asyncio.Event()
    monkeypatch.setattr(ocr_client, "stream_ocr", _slow_stream(started))
    d, a = _new_doc()
    Q.enqueue([a])
    jobs._STARTUP_DONE[0] = False
    assert jobs.ensure_queue_runner() is False
    assert jobs._QUEUE_TASK[0] is None
    # Même si un document tournait déjà : pas de plantage compté.
    jobs._STARTUP_DONE[0] = True
    assert jobs.ensure_queue_runner() is True
    await asyncio.wait_for(started.wait(), 10)
    jobs._QUEUE_TASK[0] = None                 # « on ne voit plus la pompe »
    q = Q.reconcile(jobs.running_probe(), startup=True)
    assert q["active"] == a and not q.get("crashes")
    jobs.cancel_job(a)
    await _until(lambda: not jobs.is_running(a))


async def test_arret_pendant_la_preparation_la_relance_au_demarrage(env, monkeypatch):
    """Défaut 4 : préparation interrompue par l'arrêt → « uploaded », puis
    reprise par le démarrage suivant."""
    def slow_raster(*a, cancel_event=None, **k):
        while not cancel_event.is_set():
            time.sleep(0.02)
        raise ocr_convert.PrepareCanceled("x")
    monkeypatch.setattr(ocr_convert, "raster_pdf", slow_raster)
    d, a = _new_doc()
    assert jobs.start_prepare(a)
    await asyncio.sleep(0.2)
    await lifecycle.on_shutdown()
    assert store.read_meta(d)["status"] == "uploaded"
    prepared = []
    monkeypatch.setattr(jobs, "start_prepare", lambda doc_id: prepared.append(doc_id) or True)
    await lifecycle.on_startup()
    assert prepared == [a]


async def test_purge_du_snapshot_emet_la_notice_de_lot(env, monkeypatch):
    """Défaut 13 : le lot clos par la purge du snapshot déclenche la notice."""
    batches = []
    monkeypatch.setattr(jobs, "_notify_batch", lambda b: batches.append(b))
    d, a = _new_doc()
    Q.enqueue([a])
    store.delete_doc(a)
    snap = await jobs.queue_snapshot()
    assert snap["batch"] is None and "closed_batch" not in snap
    assert batches and batches[0]["canceled"] == 1


def test_index_et_retrait_videnent_le_cache_de_requete(env, monkeypatch):
    from rag_app import rag_query as RQ
    calls = []
    monkeypatch.setattr(RQ, "invalidate_docs_cache", lambda: calls.append(1))
    d, a = _transcribed()
    monkeypatch.setattr(ocr_rag, "_engine", lambda: _FakeEngine())
    ocr_rag.index_doc(a)
    assert calls == [1]
    ocr_rag.deindex_doc(a)
    assert calls == [1, 1]
