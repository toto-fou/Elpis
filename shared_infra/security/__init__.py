# SPDX-License-Identifier: MIT
"""
shared_infra.security — Garde HTTP, secrets et journal d'audit.

    csrf.py         jetons anti-CSRF
    deps.py         dépendances FastAPI (require_user_id…)
    encryption.py   chiffrement Fernet des secrets stockés
    audit.py        journal d'audit des actions sensibles

Rangement par famille (2026-09-04) : ce paquet réunit la logique, les routes et
le stockage du sujet. Les routes s'enregistrent à l'IMPORT de leur module, et
cet import est fait par ``shared_infra/routes/__init__.py`` — jamais ici, pour
qu'il n'existe qu'un seul ordre d'enregistrement.
"""
