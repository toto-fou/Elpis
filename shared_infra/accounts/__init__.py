# SPDX-License-Identifier: MIT
"""
shared_infra.accounts — Comptes, identités, groupes et réglages utilisateur.

    users.py            CRUD comptes, sessions, préférences, avatar
    groups.py           groupes et appartenances
    passwd.py           hachage de mot de passe hors boucle asyncio
    routes_auth.py      /api/{me,login,logout}-lite
    routes_settings.py  /api/{settings,users,avatars}/*

Rangement par famille (2026-09-04) : ce paquet réunit la logique, les routes et
le stockage du sujet. Les routes s'enregistrent à l'IMPORT de leur module, et
cet import est fait par ``shared_infra/routes/__init__.py`` — jamais ici, pour
qu'il n'existe qu'un seul ordre d'enregistrement.
"""
