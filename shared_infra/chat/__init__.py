# SPDX-License-Identifier: MIT
"""
shared_infra.chat — Le contenu du chatbot : conversations, prompts, skills.

    store.py            chats (CRUD, archive, recherche)
    prompts_store.py    prompts enregistrés et partagés
    routes_prompts.py   /api/prompts/*
    routes_skills.py    /api/skills/*

Rangement par famille (2026-09-04) : ce paquet réunit la logique, les routes et
le stockage du sujet. Les routes s'enregistrent à l'IMPORT de leur module, et
cet import est fait par ``shared_infra/routes/__init__.py`` — jamais ici, pour
qu'il n'existe qu'un seul ordre d'enregistrement.
"""
