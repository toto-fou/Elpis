# SPDX-License-Identifier: MIT
"""
shared_infra.observability — Ce que le système dit de lui-même : journaux, métriques, usage.

    access_logging.py  journal d'accès applicatif
    tracing.py         traces et corrélation
    usage_ctx.py       contexte d'usage porté par la requête
    metrics/           moteur de métriques, séries, échantillonneur
    events_bus.py      bus SSE inter-workers
    usage_store.py, daily_reports_store.py, tool_metrics_store.py
    routes_usage.py, routes_events.py

Rangement par famille (2026-09-04) : ce paquet réunit la logique, les routes et
le stockage du sujet. Les routes s'enregistrent à l'IMPORT de leur module, et
cet import est fait par ``shared_infra/routes/__init__.py`` — jamais ici, pour
qu'il n'existe qu'un seul ordre d'enregistrement.
"""
