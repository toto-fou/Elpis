# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_chat_locks.py — présence d'activité CROSS-WORKER.

Contexte du bug corrigé (2026-07-30) : ``_active_chat_tasks`` (génération en
cours) et ``_manual_compressions`` (compaction manuelle) sont par-process, mais
gunicorn tourne avec plusieurs workers sans affinité. Les gardes 409
``generation_running`` / ``compression_running`` étaient donc aveugles dès que
l'activité vivait ailleurs : le /compact partait pendant une génération, et le
tour se terminait en conflit optimiste — donc NON persisté.

``flock`` porte sur l'open file description, pas sur le process : la sonde voit
aussi bien un autre worker que ce process-ci. C'est cette propriété qui rend le
test hermétique (pas besoin de vrais workers).
"""
from __future__ import annotations

import os
import time

import pytest

from shared_infra.runtime import chat_locks


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setattr(chat_locks, "LOCK_DIR", tmp_path / "locks")


def test_verrou_pris_puis_libere():
    assert chat_locks.is_held("gen", 7, "chatA") is False
    fd = chat_locks.acquire("gen", 7, "chatA")
    assert fd is not None
    assert chat_locks.is_held("gen", 7, "chatA") is True
    chat_locks.release(fd)
    assert chat_locks.is_held("gen", 7, "chatA") is False


def test_second_acquire_refuse_tant_que_tenu():
    """C'est l'exclusion mutuelle qui porte la garde 409."""
    fd = chat_locks.acquire("gen", 7, "chatA")
    try:
        assert chat_locks.acquire("gen", 7, "chatA") is None
    finally:
        chat_locks.release(fd)
    fd2 = chat_locks.acquire("gen", 7, "chatA")
    assert fd2 is not None
    chat_locks.release(fd2)


def test_cles_independantes():
    """kind, user et chat forment la clé : aucun blocage croisé."""
    fds = [chat_locks.acquire("gen", 7, "chatA"),
           chat_locks.acquire("compact", 7, "chatA"),
           chat_locks.acquire("gen", 8, "chatA"),
           chat_locks.acquire("gen", 7, "chatB")]
    try:
        assert all(fd is not None for fd in fds)
    finally:
        for fd in fds:
            chat_locks.release(fd)


def test_chat_id_none_a_sa_propre_cle():
    fd = chat_locks.acquire("gen", 7, None)
    try:
        assert chat_locks.is_held("gen", 7, None) is True
        assert chat_locks.is_held("gen", 7, "chatA") is False
    finally:
        chat_locks.release(fd)


def test_chat_id_hostile_ne_construit_pas_de_chemin():
    """Un chat_id est une donnée CLIENT : jamais concaténée telle quelle."""
    hostile = "../../../etc/passwd"
    fd = chat_locks.acquire("gen", 7, hostile)
    try:
        assert fd is not None
        p = chat_locks._key_path("gen", 7, hostile)
        assert p.parent == chat_locks.LOCK_DIR
        assert ".." not in p.name and "/" not in p.name
    finally:
        chat_locks.release(fd)


def test_release_tolere_none():
    chat_locks.release(None)          # fail-open : ne doit pas lever


def test_fail_open_si_le_dossier_est_inutilisable(monkeypatch, tmp_path):
    """/tmp plein ou non inscriptible : on retombe sur la garde per-worker,
    jamais sur un chat cassé."""
    fichier = tmp_path / "pas_un_dossier"
    fichier.write_text("x")
    monkeypatch.setattr(chat_locks, "LOCK_DIR", fichier / "sous")
    assert chat_locks.acquire("gen", 7, "chatA") is None
    assert chat_locks.is_held("gen", 7, "chatA") is False


def test_purge_ne_touche_jamais_un_verrou_vivant(monkeypatch):
    """Supprimer un fichier encore tenu ferait repartir le prochain acquire sur
    un NOUVEL inode → deux détenteurs simultanés, exclusion rompue."""
    monkeypatch.setattr(chat_locks, "_PRUNE_WHEN_OVER", 1)
    monkeypatch.setattr(chat_locks, "_STALE_AFTER_S", 0)

    vivant = chat_locks.acquire("gen", 1, "vivant")
    mort = chat_locks.acquire("gen", 2, "mort")
    chat_locks.release(mort)                       # libre et « périmé »
    p_mort = chat_locks._key_path("gen", 2, "mort")
    p_vivant = chat_locks._key_path("gen", 1, "vivant")
    os.utime(p_mort, (0, 0))
    os.utime(p_vivant, (0, 0))

    try:
        chat_locks._maybe_prune(now=time.time())
        assert not p_mort.exists(), "l'entrée libre et périmée devait partir"
        assert p_vivant.exists(), "un verrou TENU a été supprimé"
        assert chat_locks.is_held("gen", 1, "vivant") is True
    finally:
        chat_locks.release(vivant)
