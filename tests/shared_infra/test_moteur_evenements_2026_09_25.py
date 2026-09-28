# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_moteur_evenements_2026_09_25.py — audit du moteur
d'événements (SSE, bus inter-workers, terminal).

Verrouille :
  • B3/B4 — ``file_bus`` : rotation par renommage SANS perte, ligne à moitié
    écrite jamais consommée, fichier d'un autre compte refusé ;
  • B1 — ``chat_locks`` : une sonde ``is_held`` ne fait plus échouer un
    ``acquire`` ; ``lock_dir_usable`` tranche le fail-open ;
  • A2 — deux ``PipelineEvents`` (deux workers) se parlent par le fichier ;
  • B2 — ``/api/code/stream`` relaie les messages de contrôle, et la cause
    d'une révocation part avant la fermeture ;
  • A3/A4 — événements de contrôle appliqués (pas rediffusés), plus de
    ``metric_dirty``, un ``log`` diffusé passe par le journal commun ;
  • B6 — terminal SSE : contre-pression, aucun octet perdu.
"""
from __future__ import annotations

import asyncio
import json
import os
import threading
import time

import pytest

from shared_infra.observability.file_bus import FileBus


# ── B3/B4 : journal fichier partagé ──────────────────────────────────────────

def test_rotation_ne_perd_ni_la_ligne_declenchante_ni_l_arriere(tmp_path):
    """Seuil minuscule → une rotation toutes les ~8 lignes ; le lecteur ne
    passe que toutes les 3 lignes (arriéré au moment des rotations)."""
    bus = FileBus(tmp_path / "ev.jsonl", max_bytes=200)
    t = bus.tail()
    recus = []
    for i in range(60):
        assert bus.append({"n": i})
        if i % 3 == 2:
            recus += [m["n"] for m in t.read_new()]
    recus += [m["n"] for m in t.read_new()]
    assert recus == list(range(60)), "des événements ont été perdus à la rotation"
    assert (tmp_path / "ev.jsonl.1").exists(), "aucune rotation n'a eu lieu"


def test_ligne_incomplete_attend_sa_fin(tmp_path):
    bus = FileBus(tmp_path / "ev.jsonl")
    t = bus.tail()
    with open(bus.path, "ab") as f:
        f.write(b'{"a": 1}\n{"b": ')          # écriture concurrente en cours
    assert t.read_new() == [{"a": 1}]
    with open(bus.path, "ab") as f:
        f.write(b'2}\n')
    assert t.read_new() == [{"b": 2}], "la fin de ligne a été perdue"


def test_fichier_cree_prive(tmp_path):
    bus = FileBus(tmp_path / "ev.jsonl")
    bus.append({"x": 1})
    assert (os.stat(bus.path).st_mode & 0o077) == 0


# ── B1 : verrou de génération ────────────────────────────────────────────────

def test_acquire_tolere_une_sonde_concurrente(tmp_path, monkeypatch):
    import fcntl

    from shared_infra.runtime import chat_locks as cl
    monkeypatch.setattr(cl, "LOCK_DIR", tmp_path / "locks")
    # Simule une sonde ``is_held`` qui tient le flock 1 ms.
    assert cl._ensure_dir()
    path = cl._key_path("gen", 1, "c")
    fd = os.open(str(path), os.O_RDWR | os.O_CREAT, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    threading.Timer(0.001, lambda: (fcntl.flock(fd, fcntl.LOCK_UN), os.close(fd))).start()
    pris = cl.acquire("gen", 1, "c")
    try:
        assert pris is not None, "la sonde a fait croire à un verrou tenu"
    finally:
        cl.release(pris)


def test_verrou_vraiment_tenu_reste_refuse(tmp_path, monkeypatch):
    from shared_infra.runtime import chat_locks as cl
    monkeypatch.setattr(cl, "LOCK_DIR", tmp_path / "locks")
    fd = cl.acquire("gen", 1, "c")
    try:
        assert cl.acquire("gen", 1, "c") is None
        assert cl.lock_dir_usable() is True   # tenu ≠ indisponible
    finally:
        cl.release(fd)


def test_dossier_inutilisable_signale(tmp_path, monkeypatch):
    from shared_infra.runtime import chat_locks as cl
    fichier = tmp_path / "pas-un-dossier"
    fichier.write_text("x")
    monkeypatch.setattr(cl, "LOCK_DIR", fichier / "sous")
    assert cl.lock_dir_usable() is False


# ── A2 : deux workers, un fichier ───────────────────────────────────────────

def _worker(tmp_path, monkeypatch):
    from shared_infra.observability.events_bus import PipelineEvents
    monkeypatch.setenv("ELPIS_DISABLE_REDIS", "1")
    b = PipelineEvents()
    b.EVENTS_FILE = tmp_path / "pipe.jsonl"
    b._wake = asyncio.Event()
    b._init_lock = asyncio.Lock()
    return b


async def test_deux_workers_se_parlent_par_le_fichier(tmp_path, monkeypatch):
    w1, w2 = _worker(tmp_path, monkeypatch), _worker(tmp_path, monkeypatch)
    await w1._ensure_initialized()
    await w2._ensure_initialized()
    assert w1._mode == w2._mode == w1.MODE_FILE
    q = asyncio.Queue()
    w2._register(7, q)
    try:
        await w1.broadcast_to_user(7, {"type": "code.event", "n": 1})
        msg = await asyncio.wait_for(q.get(), timeout=2.0)
        assert msg["n"] == 1
    finally:
        for w in (w1, w2):
            for t in (w._file_poll_task, w._redis_retry_task):
                if t:
                    t.cancel()
        await asyncio.sleep(0)


def test_revocation_pousse_la_cause_avant_la_sentinelle():
    from shared_infra.observability.events_bus import _CLIENT_CLOSED, PipelineEvents
    b = PipelineEvents()
    q = asyncio.Queue(maxsize=2)
    b._register(3, q)
    q.put_nowait({"x": 1}); q.put_nowait({"x": 2})          # file PLEINE
    assert b.disconnect_user(3, message={"type": "session_expired"}) == 1
    assert q.get_nowait() == {"type": "session_expired"}
    assert q.get_nowait() is _CLIENT_CLOSED


# ── B2 : flux de la page Code ────────────────────────────────────────────────

async def test_flux_code_relaie_le_controle_et_filtre_le_reste(monkeypatch):
    """Le vrai ``listen`` du bus + le rendu de la page Code : chaque message
    n'est encodé qu'une fois, le contrôle passe, le reste est filtré."""
    import shared_infra.opencode.routes_code as rc
    from shared_infra.observability.events_bus import PipelineEvents
    monkeypatch.setenv("ELPIS_DISABLE_REDIS", "1")
    bus = PipelineEvents()
    bus._initialized = True                     # mode mémoire, sans tail
    monkeypatch.setattr(rc, "pipeline_events", bus)
    gen = rc._stream_gen(1, validity_check=lambda: True)
    premier = asyncio.ensure_future(gen.__anext__())
    await asyncio.sleep(0)                       # inscription du client
    for p in ({"type": "code.event", "data": {"type": "session.idle"}},
              {"type": "autre"},
              {"type": "session_expired"}):
        bus._distribute_local(1, p)
    sortie = [await premier, await gen.__anext__()]
    bus.disconnect_user(1)
    reste = [c async for c in gen]
    donnees = [json.loads(c[6:]) for c in sortie + reste if c.startswith("data: ")]
    assert donnees == [{"type": "session.idle"},
                       {"__control": {"type": "session_expired"}}]


def test_flux_code_passe_la_revalidation():
    import inspect

    import shared_infra.opencode.routes_code as rc
    src = inspect.getsource(rc.code_stream)
    assert "validity_check=_still_valid" in src and "stream_session_still_valid" in src


# ── A3/A4 : événements de contrôle, journal commun ───────────────────────────

async def test_controle_applique_jamais_rediffuse(tmp_path, monkeypatch):
    import shared_infra.observability.events_bus as EB
    import shared_infra.observability.metrics.broadcast as bc
    monkeypatch.setattr(bc, "EVENTS_FILE", tmp_path / "metric.jsonl")
    monkeypatch.setattr(bc, "_TAIL_POLL_SEC", 0.02)
    appels = []

    async def faux_refresh():
        appels.append("refresh")
    monkeypatch.setattr(EB, "_refresh_model_cache", faux_refresh)

    class Bus:
        recus = []

        async def broadcast(self, m):
            self.recus.append(m)
    bus = Bus()
    t = asyncio.create_task(bc._tail_loop(bus))
    try:
        await asyncio.sleep(0.05)
        bc.publish_event({"type": "model_cache_refresh"})
        bc.publish_event({"type": "notification", "data": {"user_id": 1}})
        for _ in range(100):
            if appels and bus.recus:
                break
            await asyncio.sleep(0.02)
    finally:
        t.cancel()
        await asyncio.gather(t, return_exceptions=True)
    assert appels == ["refresh"]
    assert [m["type"] for m in bus.recus] == ["notification"]


def test_plus_de_metric_dirty(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    import shared_infra.observability.metrics.broadcast as bc
    publies = []
    monkeypatch.setattr(bc, "publish_event", lambda p: publies.append(p))
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    legacy.reset_pool()
    legacy.init_db()
    legacy.log_metric("message_sent", 1, {"user": "x"})
    assert not any(p.get("type") == "metric_dirty" for p in publies)
    assert not hasattr(bc, "publish")


async def test_log_diffuse_passe_par_le_journal(tmp_path, monkeypatch):
    from shared_infra.observability import access_logging as A
    from shared_infra.observability.events_bus import SystemEvents
    journal = tmp_path / "app.log.jsonl"
    monkeypatch.setattr(A, "_log_path", lambda: journal)
    A._drop_log_fd()
    try:
        bus = SystemEvents()
        q = asyncio.Queue()
        bus.clients[q] = {"staff": True, "uid": 1}
        await bus.broadcast({"type": "log", "message": "vu partout", "level": "info"})
        assert q.qsize() == 0, "un log ne doit plus sortir en local seulement"
    finally:
        A._drop_log_fd()
    lignes = [json.loads(l) for l in journal.read_text().splitlines()]
    assert lignes[-1]["message"] == "vu partout" and lignes[-1]["level"] == "INFO"


# ── B6 : terminal SSE, contre-pression ───────────────────────────────────────

async def test_terminal_sse_ne_perd_aucun_octet(monkeypatch):
    import base64

    import shared_infra.terminal.routes as tr

    master, slave = os.openpty()
    os.set_blocking(master, False)
    state = {"master_fd": master, "alive": True, "pid": os.getpid(),
             "root": "/tmp", "stream_epoch": 0}
    monkeypatch.setattr(tr, "_get_or_create_terminal", lambda uid: state)
    monkeypatch.setattr(tr, "require_user_id", lambda req: 1)
    monkeypatch.setattr(tr, "get_user_settings", lambda uid: {"sandbox_quota_mb": 10 ** 6})
    monkeypatch.setattr(tr, "sandbox_usage_bytes", lambda *a, **k: 0)

    class Req:
        session: dict = {}

        async def is_disconnected(self):
            return False
    resp = await tr.api_terminal_stream(Req())
    total = 600_000
    attendu = bytes((i * 7) % 251 for i in range(total))

    def ecrire():
        vue = memoryview(attendu)
        while vue:
            n = os.write(slave, vue[:4096])
            vue = vue[n:]
    # Pas d'écho ni de conversion \n → \r\n : on compare des octets bruts.
    import termios
    import tty
    tty.setraw(slave)
    th = threading.Thread(target=ecrire, daemon=True)
    th.start()
    recu = bytearray()
    gen = resp.body_iterator
    try:
        debut = time.monotonic()
        while len(recu) < total and time.monotonic() - debut < 20:
            chunk = await gen.__anext__()
            if isinstance(chunk, bytes):
                chunk = chunk.decode()
            if chunk.startswith("data: ") and not chunk.startswith("data: ["):
                recu += base64.b64decode(chunk[6:].strip())
            await asyncio.sleep(0.002 if len(recu) < 200_000 else 0)   # client lent
    finally:
        state["alive"] = False
        await gen.aclose()
        os.close(slave)
        os.close(master)
        del termios
    assert bytes(recu) == attendu, f"{total - len(recu)} octets perdus ou désordonnés"
