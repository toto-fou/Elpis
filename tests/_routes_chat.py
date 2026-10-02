# SPDX-License-Identifier: MIT
"""tests/_routes_chat.py — monter les routes du chat comme en production.

Les routes du chat vivent dans plusieurs modules (``chats``, ``chat_control``,
``chat_compression``, ``saved_chats``), enregistrés par
``register_chatbot_routes()``. Un test qui n'importerait que l'un d'eux
recevrait des 404 pour les routes des autres, et un faux ``require_user_id``
posé sur un seul module laisserait les autres exiger une vraie session.
"""
from __future__ import annotations

import importlib

from fastapi import FastAPI


def monter_routes_chat(monkeypatch, require_user_id) -> FastAPI:
    """App FastAPI portant le routeur partagé après l'enregistrement des routes
    du chat ; ``require_user_id`` remplace l'authentification de chacune."""
    from shared_infra.routes import _CHATBOT_ROUTE_MODULES, register_chatbot_routes
    from shared_infra.routes._state import router

    register_chatbot_routes()
    for nom in _CHATBOT_ROUTE_MODULES:
        monkeypatch.setattr(importlib.import_module(nom), "require_user_id",
                            require_user_id)
    app = FastAPI()
    app.include_router(router)
    return app
