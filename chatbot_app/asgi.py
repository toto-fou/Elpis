# SPDX-License-Identifier: MIT
"""Entrypoint ASGI du CHATBOT (process dédié).

    gunicorn -c server/gunicorn_conf.py chatbot_app.asgi:app

Ce process monte les routes du chatbot (+ l'infra commune). L'ancien moteur
agentic maison a été retiré (remplacé par Flowise, service externe) : il ne
reste qu'un seul applicatif. ``APP_PROFILE`` est conservé pour compat mais vaut
toujours ``chatbot``.
"""
import os

os.environ.setdefault("APP_MODE", "main")        # pas d'endpoints admin ici
os.environ.setdefault("APP_PROFILE", "chatbot")   # routes chatbot uniquement
os.environ.setdefault("APP_SERVICE", "chatbot")   # tag de log unifié
os.environ["APP_DEFER_CREATE"] = "1"              # on instancie nous-mêmes

from server.app import create_app  # noqa: E402

app = create_app()
