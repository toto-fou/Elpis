# SPDX-License-Identifier: MIT
"""tests/rag_app/test_ocr_jobs.py — exécution asynchrone d'un document.

Version MONO-TENANT / MONO-PROCESS : le slot OCR = le registre RAM
``_TASKS`` (+ la pompe ``_QUEUE_TASK``) — plus de flock inter-worker.
Le modèle OCR est SIMULÉ (``client.stream_ocr`` patché) : on vérifie le
pipeline complet raster réel → stream nettoyé → résultat/boxes/divergence →
meta + séquence d'events live (bus in-process), plus l'annulation, l'échec,
la reprise (pages faites préservées), le re-OCR d'une page, l'exclusivité
du slot et la pompe de file.
"""
from __future__ import annotations

import asyncio

import pytest

from rag_app.ocr import client as ocr_client, jobs, queue as ocr_queue, store
from rag_app.ocr._common import OcrError

fpdf = pytest.importorskip("fpdf", reason="fpdf2 requis pour la fixture")

_CFG = {
    "endpoint_url": "http://ocr.test:8090", "default_model": "unlimited-ocr",
    "api_key": "", "prompt": "<|grounding|>Convert the document to markdown.",
    "zone_prompt": "Free OCR.", "timeout_sec": 5, "max_tokens": 512,
    "max_side_px": 640, "max_upload_mb": 10, "max_pages": 10, "max_docs": 5,
    "page_transition_ms": 1,   # quasi nul : ne ralentit pas la suite
    "auto_index": False,
}

_RAW = ("# Section\n<|ref|>alinea<|/ref|><|det|>[[100,100,900,200]]<|/det|>\n"
        "texte reconnu de la page")


@pytest.fixture
def env(monkeypatch, tmp_path):
    """Store isolé + config figée + bus/notices enregistrés (avec horodatage)."""
    import time as _t
    monkeypatch.setattr(store, "ocr_root", lambda: tmp_path)
    monkeypatch.setattr(jobs, "get_ocr_config", lambda: dict(_CFG))
    events, notifs = [], []
    times = []

    async def rec_emit(data):
        events.append(data)
        times.append((data.get("kind"), data.get("page"), _t.monotonic()))
    monkeypatch.setattr(jobs, "_emit", rec_emit)
    monkeypatch.setattr(jobs, "_notify",
                        lambda title, body, doc_id, level="info": notifs.append(title))
    jobs._TASKS.clear()
    jobs._PREP_TASKS.clear()
    jobs._INDEX_TASKS.clear()
    jobs._QUEUE_TASK[0] = None
    jobs._SHUTTING_DOWN[0] = False
    jobs._STARTUP_DONE[0] = True
    ocr_queue._STATE.update(known=False, has_work=False, paused=False)
    return {"root": tmp_path, "events": events, "notifs": notifs,
            "times": times, "monkeypatch": monkeypatch}


def _new_doc(n_pages=2):
    d = store.create_doc("essai.pdf", ".pdf")
    meta = store.read_meta(d)
    doc = fpdf.FPDF(unit="pt", format=(595, 842))
    doc.set_font("Helvetica", size=14)
    for i in range(n_pages):
        doc.add_page()
        doc.text(72, 100, f"Page {i + 1} texte de reference")
    doc.output(str(store.source_path(d, meta)))
    return d, meta["id"]


async def _fake_stream(png_bytes, *, cfg, prompt=None, on_delta=None):
    if on_delta:
        for chunk in ("# Sect", "ion\n<|ref|>alinea<|/ref|><|det|>",
                      "[[100,100,900,200]]<|/det|>\ntexte reconnu de la page"):
            await on_delta(chunk)
    return _RAW


async def test_prepare_seul_sans_ocr(env, monkeypatch):
    """Le dépôt prépare (aperçus) SANS appeler le modèle : status ready,
    pages en pending — la reconnaissance attend le bouton « Lancer »."""
    called = []

    async def never(*a, **k):
        called.append(1)
        return ""
    monkeypatch.setattr(ocr_client, "stream_ocr", never)
    d, doc_id = _new_doc(2)
    await jobs._run_prepare_job(doc_id)
    meta = store.read_meta(d)
    assert meta["status"] == "ready"
    assert meta["pages_total"] == 2
    assert all(p["status"] == "pending" for p in meta["pages"])
    assert store.page_image_path(d, 1).is_file()      # aperçus rendus
    assert called == []                                # AUCUN appel modèle
    kinds = [ev["kind"] for ev in env["events"]]
    assert kinds == ["progress", "progress"]           # preparing puis ready
    assert env["events"][-1]["status"] == "ready"
    # « Lancer » ensuite : pas de re-préparation (fichiers présents), OCR direct
    monkeypatch.setattr(ocr_client, "stream_ocr", _fake_stream)
    await jobs._run_job(doc_id)
    assert store.read_meta(d)["status"] == "done"


async def test_job_complet(env, monkeypatch):
    monkeypatch.setattr(ocr_client, "stream_ocr", _fake_stream)
    d, doc_id = _new_doc(2)
    await jobs._run_job(doc_id)

    meta = store.read_meta(d)
    assert meta["status"] == "done"
    assert meta["pages_total"] == 2 and meta["pages_done"] == 2
    page = store.load_page(d, 1)
    assert "texte reconnu" in page["md"] and "<|" not in page["md"]
    assert len(page["boxes"]) == 1
    # le BRUT est conservé (diagnostic formats + re-parse sans re-OCR)
    assert store.page_raw_path(d, 1).read_text(encoding="utf-8") == _RAW
    # coordonnées 0-1000 → pixels page
    w, h = page["w"], page["h"]
    assert page["boxes"][0]["box"] == [round(0.1 * w), round(0.1 * h),
                                       round(0.9 * w), round(0.2 * h)]
    # divergence calculée (couche texte présente mais ≠ OCR simulé)
    assert page["divergence"] is not None

    kinds = [ev["kind"] for ev in env["events"]]
    assert kinds[0] == "progress" and kinds[-1] == "job_done"
    assert "text" in kinds and kinds.count("page_done") == 2
    # le live est NETTOYÉ (jamais de tag grounding à l'écran)
    for ev in env["events"]:
        if ev["kind"] == "text":
            assert "<|" not in ev["delta"]
    # Boxes EN DIRECT : émises PENDANT le stream (avant le page_done de la
    # page), déjà converties en pixels page.
    assert kinds.index("boxes") < kinds.index("page_done")
    first_boxes = next(ev for ev in env["events"] if ev["kind"] == "boxes")
    assert first_boxes["page"] == 1 and first_boxes["total"] == 1
    assert first_boxes["boxes"][0]["box"] == page["boxes"][0]["box"]
    assert env["notifs"] == ["Document reconnu"]


async def test_job_erreur_endpoint(env, monkeypatch):
    async def boom(*a, **k):
        raise OcrError("Endpoint OCR injoignable (ConnectError).")
    monkeypatch.setattr(ocr_client, "stream_ocr", boom)
    d, doc_id = _new_doc(1)
    await jobs._run_job(doc_id)
    meta = store.read_meta(d)
    assert meta["status"] == "error" and "injoignable" in meta["error"]
    assert env["notifs"] == ["Échec de la reconnaissance"]
    last = env["events"][-1]
    assert last["kind"] == "job_done" and last["status"] == "error"


async def test_job_annulation(env, monkeypatch):
    started = asyncio.Event()

    async def slow(png_bytes, *, cfg, prompt=None, on_delta=None):
        started.set()
        await asyncio.sleep(30)
        return ""
    monkeypatch.setattr(ocr_client, "stream_ocr", slow)
    d, doc_id = _new_doc(1)
    assert jobs.start_job(doc_id) is True
    assert jobs.has_active_job() == doc_id
    assert jobs.start_job(doc_id) is False           # un seul job actif
    await asyncio.wait_for(started.wait(), 10)
    assert jobs.cancel_job(doc_id) is True
    for _ in range(100):                              # la task se termine vite
        if not jobs.is_running(doc_id):
            break
        await asyncio.sleep(0.05)
    meta = store.read_meta(d)
    assert meta["status"] == "canceled"
    assert meta["pages"][0]["status"] == "pending"    # repartira à la relance
    assert env["events"][-1]["status"] == "canceled"


async def test_slot_exclusif_in_process(env, monkeypatch):
    """NOUVEAU modèle mono-process : le slot = _TASKS + pompe. Un second
    start_job est refusé tant que le premier vit ; job_busy() rend « file »
    quand c'est la POMPE qui occupe le slot (entre deux documents)."""
    started = asyncio.Event()

    async def slow(png_bytes, *, cfg, prompt=None, on_delta=None):
        started.set()
        await asyncio.sleep(30)
        return ""
    monkeypatch.setattr(ocr_client, "stream_ocr", slow)
    d1, id1 = _new_doc(1)
    d2, id2 = _new_doc(1)
    assert jobs.job_busy() is None
    assert jobs.start_job(id1) is True
    await asyncio.wait_for(started.wait(), 10)
    assert jobs.job_busy() == id1                     # le doc occupe le slot
    assert jobs.start_job(id2) is False               # AUTRE doc refusé aussi
    assert jobs.start_page_rerun(id2, 1) is False     # même slot pour le rerun
    assert jobs.cancel_job(id1) is True
    for _ in range(100):
        if not jobs.is_running(id1):
            break
        await asyncio.sleep(0.05)


async def test_job_busy_file_pendant_la_pompe(env):
    """Une pompe vivante (même entre deux documents, _TASKS vide) tient le
    slot : job_busy() == "file" et tout démarrage direct est refusé."""
    hold = asyncio.Event()

    async def never_ending():
        await hold.wait()
    task = asyncio.create_task(never_ending())
    jobs._QUEUE_TASK[0] = task
    try:
        assert jobs.has_active_job() is None          # aucun doc en vol
        assert jobs.job_busy() == "file"              # mais la pompe vit
        assert jobs.start_job("20990101-000000-deadbeef") is False
    finally:
        hold.set()
        await task
        jobs._QUEUE_TASK[0] = None
    assert jobs.job_busy() is None


async def test_reprise_preserve_les_pages_faites(env, monkeypatch):
    calls = []

    async def counting(png_bytes, *, cfg, prompt=None, on_delta=None):
        calls.append(1)
        return _RAW
    monkeypatch.setattr(ocr_client, "stream_ocr", counting)
    d, doc_id = _new_doc(2)
    await jobs._run_job(doc_id)
    assert len(calls) == 2
    # Simule un doc annulé avec la page 2 à refaire
    store.update_meta(d, lambda m: (
        m.__setitem__("status", "canceled"),
        [p.__setitem__("status", "pending")
         for p in m["pages"] if p["n"] == 2]))
    await jobs._run_job(doc_id)
    assert len(calls) == 3                            # page 1 NON refaite
    assert store.read_meta(d)["status"] == "done"


async def test_transition_entre_pages(env, monkeypatch):
    """La pause ``page_transition_ms`` sépare le page_done d'une page du
    progress de la suivante (respiration visuelle en live)."""
    monkeypatch.setattr(jobs, "get_ocr_config",
                        lambda: {**_CFG, "page_transition_ms": 150})
    monkeypatch.setattr(ocr_client, "stream_ocr", _fake_stream)
    d, doc_id = _new_doc(2)
    await jobs._run_job(doc_id)
    times = env["times"]
    done_p1 = next(t for k, p, t in times if k == "page_done" and p == 1)
    prog_p2 = next(t for k, p, t in times if k == "progress" and p == 2)
    assert prog_p2 - done_p1 >= 0.14


async def test_le_modele_du_doc_part_dans_la_requete(env, monkeypatch):
    """Le modèle mémorisé par le document (sélecteur de la page) prime sur le
    défaut admin — c'est le champ ``model`` du body qui route (router llama)."""
    seen = []

    async def spy(png_bytes, *, cfg, prompt=None, on_delta=None):
        seen.append(cfg.get("model"))
        return _RAW
    monkeypatch.setattr(ocr_client, "stream_ocr", spy)
    d, doc_id = _new_doc(1)
    store.update_meta(d, lambda m: m.__setitem__("model", "deepseek-ocr"))
    await jobs._run_job(doc_id)
    assert seen == ["deepseek-ocr"]
    assert store.read_meta(d)["model"] == "deepseek-ocr"
    # sans choix : le défaut admin (default_model) est utilisé
    d2, doc_id2 = _new_doc(1)
    await jobs._run_job(doc_id2)
    assert seen[-1] == "unlimited-ocr"


async def test_rerun_page_reset_edited(env, monkeypatch):
    monkeypatch.setattr(ocr_client, "stream_ocr", _fake_stream)
    d, doc_id = _new_doc(1)
    await jobs._run_job(doc_id)
    store.update_meta(d, lambda m: [p.__setitem__("edited", True)
                                    for p in m["pages"]])
    await jobs._run_page_rerun(doc_id, 1)
    meta = store.read_meta(d)
    assert meta["pages"][0]["status"] == "done"
    assert meta["pages"][0]["edited"] is False        # le re-OCR écrase l'édition


async def test_heartbeat_rafraichi_pendant_le_stream(env, monkeypatch):
    """Une page longue ne doit jamais passer pour orpheline : le heartbeat
    est rafraîchi PENDANT le stream (pas seulement aux frontières de page)."""
    monkeypatch.setattr(jobs, "_HEARTBEAT_SEC", 0)
    d, doc_id = _new_doc(1)
    beats = []

    async def hb_stream(png_bytes, *, cfg, prompt=None, on_delta=None):
        await on_delta("premier morceau de texte assez long pour un flush " * 8)
        beats.append(store.read_meta(d)["heartbeat_at"])
        await asyncio.sleep(0.02)
        await on_delta("second morceau de texte assez long pour un flush " * 8)
        beats.append(store.read_meta(d)["heartbeat_at"])
        return _RAW
    monkeypatch.setattr(ocr_client, "stream_ocr", hb_stream)
    await jobs._run_job(doc_id)
    assert len(beats) == 2 and beats[1] > beats[0]


async def test_annulation_rerun_restaure_la_page(env, monkeypatch):
    """Annuler un re-run de page RESTAURE son état antérieur (elle avait un
    résultat valide — elle ne doit pas s'afficher « erreur »)."""
    monkeypatch.setattr(ocr_client, "stream_ocr", _fake_stream)
    d, doc_id = _new_doc(1)
    await jobs._run_job(doc_id)
    before = store.read_meta(d)["pages"][0]
    md_before = store.page_result_path(d, 1).read_text(encoding="utf-8")
    started = asyncio.Event()

    async def slow(png_bytes, *, cfg, prompt=None, on_delta=None):
        started.set()
        await asyncio.sleep(30)
        return ""
    monkeypatch.setattr(ocr_client, "stream_ocr", slow)
    assert jobs.start_page_rerun(doc_id, 1) is True
    await asyncio.wait_for(started.wait(), 10)
    assert jobs.cancel_job(doc_id) is True
    for _ in range(100):
        if not jobs.is_running(doc_id):
            break
        await asyncio.sleep(0.05)
    page = store.read_meta(d)["pages"][0]
    assert page["status"] == "done"                   # PAS « error »
    assert page["divergence"] == before["divergence"]
    assert page["boxes"] == before["boxes"]
    assert store.page_result_path(d, 1).read_text(encoding="utf-8") == md_before
    assert env["events"][-1]["status"] == "canceled"


async def test_notify_publie_une_notice_sur_le_bus():
    """rag_app n'a pas de centre de notifications : _notify publie un event
    ``notice`` sur le bus in-process (l'UI toaste), avec le doc en référence."""
    q = jobs.bus.subscribe()
    try:
        jobs._notify("Document reconnu", "corps", "20260722-101500-ab12cd34")
        data = q.get_nowait()
        assert data["kind"] == "notice" and data["level"] == "info"
        assert data["title"] == "Document reconnu" and data["body"] == "corps"
        assert data["doc"] == "20260722-101500-ab12cd34"
    finally:
        jobs.bus.unsubscribe(q)


async def test_auto_index_best_effort(env, monkeypatch):
    """``auto_index`` (ex-rag_auto_index) : indexation RAG en fin de job —
    BEST-EFFORT, un échec n'altère jamais le statut « done »."""
    from rag_app.ocr import rag_index as ocr_rag
    monkeypatch.setattr(jobs, "get_ocr_config",
                        lambda: {**_CFG, "auto_index": True})
    monkeypatch.setattr(ocr_client, "stream_ocr", _fake_stream)
    indexed = []
    monkeypatch.setattr(ocr_rag, "index_doc",
                        lambda doc_id, collection="": indexed.append(doc_id)
                        or {"ok": True})
    d, doc_id = _new_doc(1)
    await jobs._run_job(doc_id)
    # Passe RAG 2 : l'indexation tourne dans SA task (registre dédié) — le
    # slot OCR est libéré sans attendre les embeddings.
    await jobs._INDEX_TASKS[doc_id]
    assert indexed == [doc_id]
    assert store.read_meta(d)["status"] == "done"

    def _boom(doc_id, collection=""):
        raise RuntimeError("embedder éteint")
    monkeypatch.setattr(ocr_rag, "index_doc", _boom)
    d2, doc_id2 = _new_doc(1)
    await jobs._run_job(doc_id2)
    assert await jobs._INDEX_TASKS[doc_id2] == {}     # échec absorbé…
    assert store.read_meta(d2)["status"] == "done"
    assert "Indexation automatique échouée" in env["notifs"]   # …mais SIGNALÉ


# ─────────────────────────────────────────────────────────────────────────────
#  Pompe de file (lots multi-documents)
# ─────────────────────────────────────────────────────────────────────────────
async def test_pompe_vide_la_file_et_notifie_une_fois(env, monkeypatch):
    """Deux docs en file → traités en SÉQUENCE, events job_done pour chacun,
    UNE seule notice de lot (jamais par document)."""
    monkeypatch.setattr(ocr_client, "stream_ocr", _fake_stream)
    batches = []
    monkeypatch.setattr(jobs, "_notify_batch", lambda b: batches.append(b))
    d1, id1 = _new_doc(1)
    d2, id2 = _new_doc(1)
    ocr_queue.enqueue([id1, id2])
    await jobs._run_queue()
    assert store.read_meta(d1)["status"] == "done"
    assert store.read_meta(d2)["status"] == "done"
    dones = [ev for ev in env["events"] if ev["kind"] == "job_done"]
    assert [ev["doc"] for ev in dones] == [id1, id2]
    assert env["notifs"] == []                       # pas de notice PAR doc
    assert batches == [{"total": 2, "done": 2, "failed": 0, "canceled": 0,
                        "started_at": batches[0]["started_at"]}]
    q = ocr_queue.read_queue()
    assert q["active"] is None and q["items"] == [] and q["batch"] is None
    # des snapshots de file sont partis sur le bus (kind additif)
    assert any(ev["kind"] == "queue" for ev in env["events"])


async def test_pompe_doc_en_erreur_puis_suivant(env, monkeypatch):
    """Un doc en échec ne bloque pas la file : soldé « failed », suivant."""
    calls = []

    async def flaky(png_bytes, *, cfg, prompt=None, on_delta=None):
        calls.append(1)
        if len(calls) == 1:
            raise OcrError("Endpoint OCR injoignable (ConnectError).")
        return _RAW
    monkeypatch.setattr(ocr_client, "stream_ocr", flaky)
    batches = []
    monkeypatch.setattr(jobs, "_notify_batch", lambda b: batches.append(b))
    d1, id1 = _new_doc(1)
    d2, id2 = _new_doc(1)
    ocr_queue.enqueue([id1, id2])
    await jobs._run_queue()
    assert store.read_meta(d1)["status"] == "error"
    assert store.read_meta(d2)["status"] == "done"
    assert batches[0]["done"] == 1 and batches[0]["failed"] == 1


async def test_annuler_le_doc_actif_ne_tue_pas_la_pompe(env, monkeypatch):
    """cancel_job (bouton Arrêter) annule le doc EN COURS : la pompe le solde
    « canceled » et enchaîne sur le suivant."""
    started = asyncio.Event()
    releases = []

    async def slow_once(png_bytes, *, cfg, prompt=None, on_delta=None):
        if not releases:
            releases.append(1)
            started.set()
            await asyncio.sleep(30)
        return _RAW
    monkeypatch.setattr(ocr_client, "stream_ocr", slow_once)
    batches = []
    monkeypatch.setattr(jobs, "_notify_batch", lambda b: batches.append(b))
    d1, id1 = _new_doc(1)
    d2, id2 = _new_doc(1)
    ocr_queue.enqueue([id1, id2])
    assert jobs.ensure_queue_runner() is True
    await asyncio.wait_for(started.wait(), 10)
    assert jobs.job_busy() == id1                    # la pompe + le doc actif
    assert jobs.cancel_job(id1) is True              # le DOC, pas la pompe
    await asyncio.wait_for(jobs._QUEUE_TASK[0], 20)
    assert store.read_meta(d1)["status"] == "canceled"
    assert store.read_meta(d2)["status"] == "done"
    assert batches and batches[0]["canceled"] == 1 and batches[0]["done"] == 1


async def test_pause_arrete_la_pompe_entre_deux_docs(env, monkeypatch):
    monkeypatch.setattr(ocr_client, "stream_ocr", _fake_stream)
    monkeypatch.setattr(jobs, "_notify_batch", lambda b: None)
    d1, id1 = _new_doc(1)
    d2, id2 = _new_doc(1)
    ocr_queue.enqueue([id1, id2])
    ocr_queue.set_paused(True)
    await jobs._run_queue()
    # rien n'est parti (pause avant le premier pop)
    assert store.read_meta(d1)["status"] == "uploaded"
    ocr_queue.set_paused(False)
    await jobs._run_queue()
    assert store.read_meta(d1)["status"] == "done"
    assert store.read_meta(d2)["status"] == "done"


async def test_doc_supprime_pendant_l_attente(env, monkeypatch):
    monkeypatch.setattr(ocr_client, "stream_ocr", _fake_stream)
    batches = []
    monkeypatch.setattr(jobs, "_notify_batch", lambda b: batches.append(b))
    d1, id1 = _new_doc(1)
    d2, id2 = _new_doc(1)
    ocr_queue.enqueue([id1, id2])
    store.delete_doc(id1)                             # supprimé AVANT son tour
    await jobs._run_queue()
    assert store.read_meta(d2)["status"] == "done"
    assert batches[0]["canceled"] == 1 and batches[0]["done"] == 1


async def test_prepare_pendant_un_job_actif(env, monkeypatch):
    """La PRÉPARATION n'occupe pas le slot OCR : déposer pendant une
    reconnaissance est permis (comportement multi-lots)."""
    started = asyncio.Event()

    async def slow(png_bytes, *, cfg, prompt=None, on_delta=None):
        started.set()
        await asyncio.sleep(30)
        return ""
    monkeypatch.setattr(ocr_client, "stream_ocr", slow)
    d1, id1 = _new_doc(1)
    d2, id2 = _new_doc(1)
    assert jobs.start_job(id1) is True
    await asyncio.wait_for(started.wait(), 10)
    assert jobs.start_prepare(id2) is True            # accepté malgré le job
    for _ in range(200):
        if store.read_meta(d2)["status"] == "ready":
            break
        await asyncio.sleep(0.05)
    assert store.read_meta(d2)["status"] == "ready"
    assert jobs.cancel_job(id1) is True
    for _ in range(100):
        if not jobs.is_running(id1):
            break
        await asyncio.sleep(0.05)
