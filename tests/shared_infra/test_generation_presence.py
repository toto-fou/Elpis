# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_generation_presence.py — ``is_generation_active``.

Le registre ``_active_chat_tasks`` ne voit que SON worker. La garde 409 du
/compact s'appuyait dessus : une génération hébergée par un autre worker
gunicorn passait inaperçue, la compaction démarrait, et le tour finissait en
conflit optimiste (donc perdu). ``register_chat_task`` pose désormais un verrou
de présence partagé, relâché à ``unregister_chat_task``.
"""
from __future__ import annotations

import asyncio

import pytest

from shared_infra.routes import _state
from shared_infra.runtime import chat_locks


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setattr(chat_locks, "LOCK_DIR", tmp_path / "locks")
    _state._active_chat_tasks.clear()
    for _fd in list(_state._activity_fds.values()):
        chat_locks.release(_fd)
    _state._activity_fds.clear()
    yield
    for _fd in list(_state._activity_fds.values()):
        chat_locks.release(_fd)
    _state._activity_fds.clear()
    _state._active_chat_tasks.clear()


async def _gen():
    await asyncio.sleep(30)


@pytest.mark.asyncio
async def test_presence_posee_puis_liberee():
    task = asyncio.create_task(_gen())
    await asyncio.sleep(0)
    _state.register_chat_task(7, task, "chatA")
    assert _state.is_generation_active(7, "chatA") is True
    assert chat_locks.is_held("gen", 7, "chatA") is True    # visible d'un autre worker

    _state.unregister_chat_task(7, "chatA", task)
    assert chat_locks.is_held("gen", 7, "chatA") is False
    assert _state.is_generation_active(7, "chatA") is False
    task.cancel()


@pytest.mark.asyncio
async def test_presence_vue_meme_sans_task_locale():
    """Le cœur du fix : le worker qui reçoit le POST /compact n'a AUCUNE task
    pour ce chat, il doit malgré tout voir la génération."""
    task = asyncio.create_task(_gen())
    await asyncio.sleep(0)
    _state.register_chat_task(7, task, "chatA")

    _state._active_chat_tasks.clear()          # simule l'autre worker
    assert _state.get_active_chat_task(7, "chatA") is None
    assert _state.is_generation_active(7, "chatA") is True
    task.cancel()


@pytest.mark.asyncio
async def test_passation_garde_la_presence_continue():
    """Édition + régénération : l'ancien ``finally`` s'exécute APRÈS
    l'enregistrement de la nouvelle task. La présence ne doit pas clignoter,
    et l'unregister de l'ancienne ne doit pas relâcher le verrou de la
    nouvelle."""
    old, new = asyncio.create_task(_gen()), asyncio.create_task(_gen())
    await asyncio.sleep(0)
    _state.register_chat_task(7, old, "chatA")
    _state.register_chat_task(7, new, "chatA")            # la nouvelle prend la clé

    _state.unregister_chat_task(7, "chatA", old)          # finally de l'ancienne
    assert _state.is_generation_active(7, "chatA") is True, "présence perdue"

    _state.unregister_chat_task(7, "chatA", new)
    assert _state.is_generation_active(7, "chatA") is False
    old.cancel(); new.cancel()


@pytest.mark.asyncio
async def test_chats_independants():
    tA, tB = asyncio.create_task(_gen()), asyncio.create_task(_gen())
    await asyncio.sleep(0)
    _state.register_chat_task(7, tA, "chatA")
    _state.register_chat_task(7, tB, "chatB")
    _state.unregister_chat_task(7, "chatA", tA)
    assert _state.is_generation_active(7, "chatA") is False
    assert _state.is_generation_active(7, "chatB") is True
    _state.unregister_chat_task(7, "chatB", tB)
    tA.cancel(); tB.cancel()
