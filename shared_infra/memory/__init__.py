# SPDX-License-Identifier: MIT
"""
shared_infra.memory — Mémoire : souvenirs long terme et mémoire AX (interfaces apprises).

    store.py     magasin des souvenirs (Markdown + FTS5)
    ax/          mémoire AX — sites, chemins, sélecteurs appris
    routes.py    /api/memory/*
    routes_ax.py /api/ax/*

Rangement par famille (2026-09-04) : ce paquet réunit la logique, les routes et
le stockage du sujet. Les routes s'enregistrent à l'IMPORT de leur module, et
cet import est fait par ``shared_infra/routes/__init__.py`` — jamais ici, pour
qu'il n'existe qu'un seul ordre d'enregistrement.
"""
