# SPDX-License-Identifier: MIT
"""Pied d'un message (modèle, durée, débits) des tours PRÉCÉDENTS : conservé
à l'aller-retour client, sans le raisonnement ni les outils, borné
(2026-09-29 — il disparaissait au tour suivant)."""
from chatbot_app.routes.chats import _normalize_client_messages


def test_pied_de_message_conserve_et_borne():
    _f, pers = _normalize_client_messages([
        {"role": "user", "content": "q"},
        {"role": "assistant", "content": "r", "metrics": {
            "model": "m", "duration": 3.2, "write_tps": 41.5, "estimated": False,
            "thinking": "x" * 10_000, "tool_history": [1], "gros": "y" * 500,
            "imbrique": {"a": 1},
            "kv_cache": {"used": 10, "total": 100, "pct": 10.0, "extra": "?"}}},
    ])
    assert pers[-1]["metrics"] == {
        "model": "m", "duration": 3.2, "write_tps": 41.5, "estimated": False,
        "kv_cache": {"used": 10, "total": 100, "pct": 10.0}}


def test_pied_absent_ou_invalide_ignore():
    _f, pers = _normalize_client_messages([
        {"role": "assistant", "content": "r", "metrics": "pas un dict"},
    ])
    assert "metrics" not in pers[-1]
