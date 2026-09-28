# SPDX-License-Identifier: MIT
"""Boucle de tail du bus d'événements — cadence liée aux abonnés.

Le backend fichier tournait à 20 tours/seconde en permanence, y compris quand
personne n'écoutait sur ce worker. Coût mesuré : 0,48 % d'un cœur par worker,
dominé non par le ``stat`` (2 µs) mais par la machinerie de timer d'asyncio.

Le contrat à préserver est que la bascule ne coûte AUCUNE latence : dès qu'un
abonné existe, la cadence rapide est intégralement conservée, et un client qui
se connecte pendant l'attente longue la fait sortir immédiatement.
"""
import asyncio
import json

import pytest

from shared_infra.observability.events_bus import PipelineEvents


@pytest.fixture
def bus(tmp_path):
    b = PipelineEvents()
    b.EVENTS_FILE = tmp_path / "events.jsonl"
    b.EVENTS_FILE.write_text("", encoding="utf-8")
    b._wake = asyncio.Event()
    return b


def _append(bus, uid, msg):
    with open(bus.EVENTS_FILE, "a", encoding="utf-8") as f:
        f.write(json.dumps({"__uid": uid, "__msg": msg}) + "\n")


# ── Détection d'abonné ──────────────────────────────────────────────────────

def test_sans_client_la_boucle_se_sait_inactive(bus):
    assert bus._has_clients() is False


def test_un_client_enregistre_rend_la_boucle_active(bus):
    bus._register(7, asyncio.Queue())
    assert bus._has_clients() is True


def test_un_utilisateur_sans_file_ne_compte_pas(bus):
    """``clients`` peut porter une clé avec un ensemble VIDE après départ."""
    q = asyncio.Queue()
    bus._register(7, q)
    bus._unregister(7, q)
    assert bus._has_clients() is False


def test_l_enregistrement_arme_le_reveil(bus):
    assert not bus._wake.is_set()
    bus._register(7, asyncio.Queue())
    assert bus._wake.is_set(), \
        "sans ce réveil, le premier event du client arriverait jusqu'à 1 s en retard"


# ── Position de lecture pendant l'inactivité ────────────────────────────────

def test_l_inactivite_ne_laisse_pas_s_accumuler_un_arriere(bus):
    """Un abonné qui arrive reçoit la SUITE, pas l'historique.

    C'est la sémantique d'avant, où la boucle rapide consommait le flux en
    continu. Sans ce recalage, un client qui se connecte après une heure de
    silence recevrait d'un coup tout ce qui s'est écrit entre-temps.
    """
    for i in range(5):
        _append(bus, 1, {"n": i})
    bus._file_skip_to_end()
    assert bus._tail().pos == bus.EVENTS_FILE.stat().st_size


def test_le_recalage_survit_a_un_fichier_absent(bus):
    bus.EVENTS_FILE.unlink()
    bus._tail().pos = 999
    bus._file_skip_to_end()
    assert bus._tail().pos == 0


# ── La boucle elle-même ─────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_la_boucle_livre_toujours_quand_un_client_ecoute(bus):
    q = asyncio.Queue()
    bus._register(1, q)
    bus._file_skip_to_end()

    task = asyncio.create_task(bus._file_poll_loop())
    try:
        _append(bus, 1, {"type": "code.event", "n": 1})
        msg = await asyncio.wait_for(q.get(), timeout=2.0)
        assert msg["n"] == 1
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_la_livraison_reste_rapide_sous_charge(bus):
    """La cadence rapide doit être intacte : plusieurs events d'affilée."""
    q = asyncio.Queue()
    bus._register(1, q)
    bus._file_skip_to_end()

    task = asyncio.create_task(bus._file_poll_loop())
    try:
        for i in range(5):
            _append(bus, 1, {"n": i})
        recus = [ (await asyncio.wait_for(q.get(), timeout=2.0))["n"] for _ in range(5) ]
        assert recus == [0, 1, 2, 3, 4]
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_un_client_qui_arrive_pendant_l_attente_longue_est_servi_vite(bus):
    """Le cœur du compromis : aucune latence perdue à la bascule."""
    task = asyncio.create_task(bus._file_poll_loop())
    try:
        await asyncio.sleep(0.15)          # la boucle est en attente longue
        q = asyncio.Queue()
        bus._register(1, q)                 # → arme _wake
        await asyncio.sleep(0.05)
        _append(bus, 1, {"n": 42})
        msg = await asyncio.wait_for(q.get(), timeout=1.0)
        assert msg["n"] == 42
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_sans_client_la_boucle_ne_tourne_presque_plus(bus, monkeypatch):
    """La raison d'être du changement, vérifiée par comptage de tours."""
    tours = {"n": 0}
    vrai_stat = bus._file_skip_to_end

    def compte():
        tours["n"] += 1
        vrai_stat()
    monkeypatch.setattr(bus, "_file_skip_to_end", compte)

    task = asyncio.create_task(bus._file_poll_loop())
    try:
        await asyncio.sleep(0.6)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    # À 20 Hz on aurait fait ~12 tours ; en cadence lente (1 s), 0 ou 1.
    assert tours["n"] <= 1, f"{tours['n']} tours en 0,6 s — la cadence lente ne s'applique pas"


@pytest.mark.asyncio
async def test_la_boucle_s_arrete_proprement(bus):
    """Le shutdown annule cette tâche : elle doit sortir vite et sans bruit.

    La boucle attrape ``CancelledError`` et fait ``return`` — choix d'origine,
    conservé. On vérifie donc la terminaison, pas une exception : c'est
    l'attente longue qui aurait pu retenir l'arrêt, et elle ne le fait pas.
    """
    task = asyncio.create_task(bus._file_poll_loop())
    await asyncio.sleep(0.05)          # la boucle est dans son attente longue
    task.cancel()
    await asyncio.wait_for(asyncio.gather(task, return_exceptions=True), timeout=1.0)
    assert task.done()
