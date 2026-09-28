# SPDX-License-Identifier: MIT
"""
shared_infra.opencode — Intégration opencode : distribution du CLI, sessions déportées.

    routes_cli.py   /api/cli/* — installeurs et artefacts LAN
    routes_code.py  /api/code/* — appairage et sessions
    store.py        état des sessions déportées (SQLite)
    plugin/         le plugin elpis-remote (TypeScript) servi aux postes

Rangement par famille (2026-09-04) : ce paquet réunit la logique, les routes et
le stockage du sujet. Les routes s'enregistrent à l'IMPORT de leur module, et
cet import est fait par ``shared_infra/routes/__init__.py`` — jamais ici, pour
qu'il n'existe qu'un seul ordre d'enregistrement.
"""
