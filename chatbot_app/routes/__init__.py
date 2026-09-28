# SPDX-License-Identifier: MIT
"""chatbot_app.routes — endpoints HTTP propres au chatbot.

Les modules enregistrent leurs routes sur le ``router`` partagé exposé par
``shared_infra.routes._state``. Leur montage effectif est piloté par la
composition root (entrypoint), pas par ce package.
"""
