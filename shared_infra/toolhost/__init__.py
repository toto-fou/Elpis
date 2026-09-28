# SPDX-License-Identifier: MIT
"""shared_infra/toolhost — famille « hôte d'outils » (2026-09-11, P4).

Ce que l'APP et l'HÔTE D'OUTILS partagent pour se parler :

* ``client``          — rappels de l'hôte vers l'app (``/api/internal/*`` :
                        introspection de jeton, identité, identifiants git) ;
* ``routes_internal`` — ces routes, côté app (jeton de service requis).

Le paquet déployable lui-même est ``toolhost/`` à la racine (config, auth,
app FastAPI, ``python -m toolhost``). Rangement par famille : ce dossier ne
contient que la logique partagée — jamais d'import de route depuis ce
``__init__`` (l'ordre d'enregistrement reste piloté par ``shared_infra/routes``).
"""
