# SPDX-License-Identifier: MIT
"""
shared_infra.runtime — Primitives de processus, sans métier.

    pyruntime.py   réglages d'interpréteur posés avant pydantic
    runtime_dir.py répertoire d'exécution partagé
    ordered_io.py  écritures ordonnées vers le client
    cancel_bus.py  annulation propagée entre workers
    chat_locks.py  verrous de génération par utilisateur

Rangement par famille (2026-09-04) : ce paquet réunit la logique, les routes et
le stockage du sujet. Les routes s'enregistrent à l'IMPORT de leur module, et
cet import est fait par ``shared_infra/routes/__init__.py`` — jamais ici, pour
qu'il n'existe qu'un seul ordre d'enregistrement.
"""
