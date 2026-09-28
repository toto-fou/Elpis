# SPDX-License-Identifier: MIT
"""
shared_infra.terminal — Terminal interactif : PTY et flux.

    pty.py     création et cycle de vie des PTY
    routes.py  /api/terminal/*

Rangement par famille (2026-09-04) : ce paquet réunit la logique, les routes et
le stockage du sujet. Les routes s'enregistrent à l'IMPORT de leur module, et
cet import est fait par ``shared_infra/routes/__init__.py`` — jamais ici, pour
qu'il n'existe qu'un seul ordre d'enregistrement.
"""
