# SPDX-License-Identifier: MIT
"""
shared_infra.scheduling — Tout ce qui se déclenche tout seul : cron, routines.

    cron_lock.py           élection du leader multi-worker
    routines_scheduler.py  boucle des routines planifiées
    routines_store.py
    routes_routines.py, routes_cron.py
    routes_webhooks.py     /api/webhooks/* (déclencheurs HMAC publics)

(2026-09-12) Les scénarios rejouables du Studio (magasin, runner, planificateur,
routes) ont été retirés : le Studio produit désormais des scripts
d'automatisation qui s'exécutent SUR la machine cible (``desktop-agent/
elpis_auto``). La mémoire des ancres du ciblage live, qui vivait dans leur
magasin, est passée dans ``shared_infra/desktop/anchors.py``.

Rangement par famille (2026-09-04) : ce paquet réunit la logique, les routes et
le stockage du sujet. Les routes s'enregistrent à l'IMPORT de leur module, et
cet import est fait par ``shared_infra/routes/__init__.py`` — jamais ici, pour
qu'il n'existe qu'un seul ordre d'enregistrement.
"""
