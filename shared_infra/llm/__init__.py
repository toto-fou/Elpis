# SPDX-License-Identifier: MIT
"""
shared_infra.llm — Moteurs de langage : connecteurs, file d'attente, réflexion.

    connectors.py        magasin des connecteurs (backends)
    debug.py             capture des échanges pour diagnostic
    reasoning_control.py budget et contrôle du raisonnement
    routes.py            /api/llm/*
    routes_connectors.py /api/llm/connectors/*
    routes_queue.py      /api/llm/queue-status

Rangement par famille (2026-09-04) : ce paquet réunit la logique, les routes et
le stockage du sujet. Les routes s'enregistrent à l'IMPORT de leur module, et
cet import est fait par ``shared_infra/routes/__init__.py`` — jamais ici, pour
qu'il n'existe qu'un seul ordre d'enregistrement.
"""
