# SPDX-License-Identifier: MIT
"""
tests/shared_infra/test_run_journal_2026_09_16.py — journal des événements d'un
run de chat (chantier C, 2026-09-16).

Revenir sur une conversation qui génère encore doit REJOUER le tour puis le
suivre en direct, depuis n'importe quel worker. Ce qui est verrouillé ici :
  - ordre et numérotation des lignes, fusion des tokens consécutifs,
    ``run_started`` en tête, ``run_end`` + marque ``.end`` en fin ;
  - plafond : au-delà, seuls les événements structurants passent ;
  - lecture par décalage : une ligne en cours d'écriture n'est jamais rendue
    à moitié ;
  - pointeur ``current.json`` (réconciliation client) et runs actifs (journal
    non terminé ET verrou de présence tenu) ;
  - rétention (journal terminé, orphelin) ;
  - une racine qui n'est pas privée désactive le journal (injection).
"""
from __future__ import annotations

import json
import os
import time

import pytest

from shared_infra.runtime import chat_locks, run_journal as rj


@pytest.fixture(autouse=True)
def _iso(tmp_path, monkeypatch):
    monkeypatch.setattr(rj, "RUN_DIR", tmp_path / "runs")
    monkeypatch.setattr(chat_locks, "LOCK_DIR", tmp_path / "locks")
    monkeypatch.setattr(rj, "_last_sweep", time.time())    # pas de balayage implicite
    yield


def _lire_tout(path):
    items, _off = rj.read_lines(path, 0)
    return [it["e"] for it in items], [it["s"] for it in items]


async def test_ordre_fusion_debut_et_fin():
    j = rj.RunJournal(1, "chat-a", "run1", meta={"base_count": 3, "user_message": "salut"})
    assert await j.open({"chat_id": "chat-a"})
    j.append({"type": "mode", "text": "Réflexion…"})
    for tok in ("Bon", "jour", " !"):
        j.append({"type": "content_token", "text": tok})
    j.append({"type": "tool_call", "name": "read_file"})
    j.append({"type": "content_token", "text": "fin"})
    j.append({"type": "final", "assistant": "Bonjour !fin"})
    await j.close("done")
    evs, seqs = _lire_tout(j.path)
    assert [e["type"] for e in evs] == ["run_started", "mode", "content_token",
                                         "tool_call", "content_token", "final", "run_end"]
    assert evs[2]["text"] == "Bonjour !" and evs[2]["n"] == 3
    assert seqs == list(range(1, len(seqs) + 1))
    assert evs[0]["run_id"] == "run1" and evs[0]["chat_id"] == "chat-a"
    assert rj.is_ended(1, "chat-a", "run1")
    cur = rj.current_run(1, "chat-a")
    assert cur["run_id"] == "run1" and cur["ended"] is True
    assert cur["base_count"] == 3 and cur["user_message"] == "salut"


async def test_close_idempotent_et_append_apres_close_ignore():
    j = rj.RunJournal(1, "c", "r2")
    assert await j.open({})
    await j.close("done")
    await j.close("error")
    j.append({"type": "content_token", "text": "trop tard"})
    evs, _ = _lire_tout(j.path)
    assert [e["type"] for e in evs] == ["run_started", "run_end"]
    assert evs[-1]["status"] == "done"


async def test_plafond_garde_les_evenements_structurants(monkeypatch):
    j = rj.RunJournal(1, "c", "r3")
    assert await j.open({})
    j._cap = 200                                  # octets
    for i in range(40):
        j.append({"type": "tool_call", "name": f"outil{i}"} if i % 10 == 0
                 else {"type": "shell_output", "text": "x" * 50})
    j.append({"type": "final", "assistant": "ok"})
    await j.close("done")
    evs, _ = _lire_tout(j.path)
    types = [e["type"] for e in evs]
    assert "journal_truncated" in types
    assert types.count("tool_call") == 4, "un événement structurant a été perdu"
    assert types[-2:] == ["final", "run_end"]
    apres = types[types.index("journal_truncated"):]
    assert "shell_output" not in apres


def test_lecture_par_decalage_ne_rend_jamais_une_ligne_partielle(tmp_path):
    p = tmp_path / "j.jsonl"
    l1 = json.dumps({"s": 1, "e": {"type": "a"}}) + "\n"
    p.write_text(l1 + '{"s": 2, "e": {"type": "b"')           # ligne 2 en cours
    items, off = rj.read_lines(p, 0)
    assert [it["e"]["type"] for it in items] == ["a"] and off == len(l1)
    with open(p, "a") as fh:
        fh.write('}}\n')
    items, off2 = rj.read_lines(p, off)
    assert [it["e"]["type"] for it in items] == ["b"] and off2 == p.stat().st_size


def test_lecture_par_morceaux_rend_tout_dans_lordre(tmp_path):
    p = tmp_path / "j.jsonl"
    with open(p, "w") as fh:
        for i in range(1, 501):
            fh.write(json.dumps({"s": i, "e": {"type": "x", "text": "y" * 40}}) + "\n")
    off, seqs = 0, []
    while True:
        items, off2 = rj.read_lines(p, off, max_bytes=1000)
        if not items:
            break
        seqs += [it["s"] for it in items]
        off = off2
    assert seqs == list(range(1, 501))


async def test_runs_actifs_exigent_journal_ouvert_et_verrou_tenu():
    j = rj.RunJournal(7, "chat-x", "rx")
    assert await j.open({})
    assert rj.list_active_chat_ids(7) == [], "sans verrou de présence, pas actif"
    fd = chat_locks.acquire("gen", 7, "chat-x")
    try:
        assert rj.list_active_chat_ids(7) == ["chat-x"]
        assert rj.list_active_chat_ids(8) == [], "jamais les runs d'un autre compte"
        await j.close("done")
        assert rj.list_active_chat_ids(7) == [], "journal terminé = plus actif"
    finally:
        chat_locks.release(fd)


async def test_un_nouveau_run_remplace_les_journaux_termines_du_chat():
    a = rj.RunJournal(1, "c", "ancien")
    assert await a.open({})
    await a.close("done")
    b = rj.RunJournal(1, "c", "nouveau")
    assert await b.open({})
    assert not (a.dir / "ancien.jsonl").exists()
    assert rj.current_run(1, "c")["run_id"] == "nouveau"
    await b.close("done")


async def test_retention_termine_et_orphelin():
    fini = rj.RunJournal(1, "c1", "fini")
    assert await fini.open({})
    await fini.close("done")
    orphelin = rj.RunJournal(1, "c2", "orph")
    assert await orphelin.open({})
    maintenant = time.time()
    assert rj.sweep(maintenant) == 0, "rien n'est encore périmé"
    assert rj.sweep(maintenant + rj.RETENTION_S + 5) == 1
    assert not fini.path.exists() and orphelin.path.exists()
    assert rj.sweep(maintenant + rj.ORPHAN_S + 5) == 1
    assert not orphelin.path.exists()


async def test_racine_ouverte_a_tous_desactive_le_journal(tmp_path, monkeypatch):
    base = tmp_path / "partage"
    base.mkdir()
    os.chmod(base, 0o777)
    monkeypatch.setattr(rj, "RUN_DIR", base)
    monkeypatch.setattr(rj, "_base_ok", lambda create: False)
    j = rj.RunJournal(1, "c", "r")
    assert await j.open({}) is False
    assert rj.current_run(1, "c") is None
