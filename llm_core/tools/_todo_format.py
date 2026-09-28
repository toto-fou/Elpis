# SPDX-License-Identifier: MIT
"""
tools/_todo_format.py — Forme CANONIQUE d'une todo-list montrée au modèle.

Une seule mise en forme pour le résultat de ``todowrite`` et pour le rappel
``<todo_status>`` de début de tour : ``N. [status] contenu``. Le modèle recopie
ce qu'il voit ; lui montrer deux formes différentes l'invitait à reformuler
(libellés qui dérivent d'un appel à l'autre). Pur, sans dépendance.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

OPEN_STATUSES = ("pending", "in_progress")


def render_checklist(todos: List[Dict[str, Any]]) -> str:
    lines = []
    n = 0
    for t in todos or []:
        if not isinstance(t, dict):
            continue
        n += 1
        lines.append(f"{n}. [{t.get('status') or 'pending'}] {t.get('content') or ''}")
    return "\n".join(lines)


def counts(todos: List[Dict[str, Any]]) -> Dict[str, int]:
    items = [t for t in (todos or []) if isinstance(t, dict)]
    return {
        "total": len(items),
        "done": sum(1 for t in items if t.get("status") == "completed"),
        "open": sum(1 for t in items if t.get("status") in OPEN_STATUSES),
    }


def current_task(todos: List[Dict[str, Any]]) -> Optional[str]:
    for t in todos or []:
        if isinstance(t, dict) and t.get("status") == "in_progress":
            return str(t.get("content") or "")
    return None
