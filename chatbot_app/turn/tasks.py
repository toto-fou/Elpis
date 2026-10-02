# SPDX-License-Identifier: MIT
"""
chatbot_app.turn.tasks — références fortes des tâches de fond du flux de
chat.

asyncio ne retient ses tâches qu'en ``WeakSet`` : une tâche lancée sans
référence peut être collectée avant d'avoir tourné. ``keep`` la garde
jusqu'à sa fin ; ``server/app.py`` annule et attend ``_BG_TASKS`` à l'arrêt
du worker, ce qui couvre aussi les runs détachés.
"""
from __future__ import annotations

import asyncio

# Références FORTES des tâches que le flux de chat confie à ``keep``
# (``execution``, ``preparation``) ; ce module n'en lance aucune.
_BG_TASKS: set = set()

def keep(task: "asyncio.Task") -> "asyncio.Task":
    """Garde une référence forte sur ``task`` jusqu'à sa fin ; rend ``task``."""
    _BG_TASKS.add(task)
    task.add_done_callback(_BG_TASKS.discard)
    return task
