# SPDX-License-Identifier: MIT
"""Audit fluidité 2026-08-31, passe 4 — correctifs à logique nouvelle.

Couvre les deux correctifs qui ne sont pas de simples déports ``to_thread``
(ceux-là sont exercés par les suites de routes existantes) :

* B14 — ``_QueueStatusBroadcaster`` : TOCTOU d'extinction. La boucle décidait
  de sortir sous le lock, mais ``task.done()`` ne devient True qu'après le
  déroulement complet de la coroutine ; un ``subscribe()`` concurrent voyait
  ``done() == False`` et ne relançait pas → le nouvel abonné ne recevait que
  ``_last_payload``. Le fix efface ``_task`` dans le ``finally``.

* B6 — ``PipelineEvents._distribute_local`` : un client SSE saturé était
  retiré de ``clients`` SANS sentinelle → son ``listen()`` restait bloqué
  sur ``q.get()`` (pings à vie, page Code figée). Portage du fix E5 de
  SystemEvents : on jette les événements les plus anciens et on garde le
  client.
"""
import asyncio

from shared_infra.llm import routes_queue as QS
from shared_infra.observability import events_bus as EB


async def test_broadcaster_redemarre_apres_extinction(monkeypatch):
    """B14 — après la sortie de la boucle, ``_task`` est None et un nouvel
    abonné RELANCE une boucle vivante (pas seulement ``_last_payload``)."""
    monkeypatch.setattr(QS, "_SNAPSHOT_INTERVAL_SEC", 0.01, raising=True)
    monkeypatch.setattr(QS, "_build_snapshot", lambda: {"ok": True}, raising=True)
    b = QS._QueueStatusBroadcaster()
    q = await b.subscribe()
    assert b._task is not None and not b._task.done()
    await b.unsubscribe(q)
    # La boucle doit se terminer d'elle-même ET effacer _task (le fix B14).
    for _ in range(300):
        if b._task is None:
            break
        await asyncio.sleep(0.01)
    assert b._task is None, "la boucle éteinte doit effacer _task (finally B14)"
    # Un nouvel abonné relance la boucle — avant le fix, la fenêtre TOCTOU
    # (task pas encore done) laissait _task en place et subscribe ne relançait
    # rien : le flux du nouvel abonné restait muet.
    q2 = await b.subscribe()
    try:
        assert b._task is not None and not b._task.done()
        payload = await asyncio.wait_for(q2.get(), timeout=2)
        assert payload == {"ok": True}
    finally:
        await b.unsubscribe(q2)
        for _ in range(300):
            if b._task is None:
                break
            await asyncio.sleep(0.01)


async def test_pipeline_client_sature_garde_le_flux():
    """B6 — queue pleine : les plus anciens événements sont jetés, le message
    courant est livré, le client RESTE inscrit (pas de zombie silencieux)."""
    bus = EB.pipeline_events
    uid = 987654
    q: asyncio.Queue = asyncio.Queue(maxsize=2)
    assert bus._register(uid, q)
    try:
        q.put_nowait({"n": 1})
        q.put_nowait({"n": 2})          # pleine
        bus._distribute_local(uid, {"n": 3})
        # Le client est TOUJOURS inscrit…
        assert q in bus._snapshot_queues(uid)
        # …et le message courant a été livré après éviction des anciens.
        items = []
        while not q.empty():
            items.append(q.get_nowait())
        assert {"n": 3} in items
        assert EB._CLIENT_CLOSED not in items
    finally:
        bus._unregister(uid, q)


async def test_log_emis_depuis_un_thread_avec_staff_connecte(tmp_path, monkeypatch):
    """B7 — un log émis depuis un thread ouvrier avec un admin connecté atteint
    le flux staff. Depuis 2026-09-25, le chemin passe par le journal JSONL
    commun (``FileEventHandler`` → fichier → ``_staff_log_tail_loop``), qui
    ne dépend plus d'aucune boucle capturée."""
    import logging

    from shared_infra.observability import access_logging as A

    journal = tmp_path / "app.log.jsonl"
    monkeypatch.setattr(A, "_log_path", lambda: journal)
    monkeypatch.setattr(EB, "_STAFF_LOG_POLL_SEC", 0.02)
    A._drop_log_fd()
    staff_q: asyncio.Queue = asyncio.Queue(maxsize=EB.SystemEvents.QUEUE_MAX_SIZE)
    EB.system_events.clients[staff_q] = {"staff": True, "uid": 1}
    task = asyncio.create_task(EB._staff_log_tail_loop())
    try:
        await asyncio.sleep(0.05)              # curseur posé en fin de fichier
        handler = A.FileEventHandler()
        handler.setFormatter(logging.Formatter("%(message)s"))
        record = logging.LogRecord(
            "test.passe4", logging.WARNING, __file__, 1,
            "ligne emise depuis un thread (passe 4, B7)", (), None)
        await asyncio.to_thread(handler.emit, record)
        msg = await asyncio.wait_for(staff_q.get(), timeout=2.0)
        if isinstance(msg, str):            # texte déjà sérialisé (_fanout)
            import json
            msg = json.loads(msg)
        assert msg.get("type") == "log"
        assert "passe 4, B7" in str(msg.get("message"))
    finally:
        EB.system_events.clients.pop(staff_q, None)
        await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), timeout=2.0)
        A._drop_log_fd()
