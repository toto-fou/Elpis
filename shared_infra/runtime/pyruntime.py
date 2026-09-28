# SPDX-License-Identifier: MIT
"""
shared_infra.runtime.pyruntime — réglages d'environnement à poser AVANT tout import lourd.

Module **feuille** (n'importe que ``os``) : il doit pouvoir être importé en
toute première ligne d'un point d'entrée, avant ``fastapi``/``pydantic`` ou
``fastmcp``.

Deux réglages y vivent, pour deux raisons différentes : couper un plugin
pydantic que personne n'a demandé (§ 1), et couper un appel réseau sortant
qu'une bibliothèque fait dans notre dos (§ 2).

§ 1 — Plugins pydantic
----------------------
``pydantic`` expose un système de *plugins* : au premier modèle construit, il
balaie les métadonnées de TOUTES les distributions installées (191 ici) à la
recherche d'entry points du groupe ``pydantic``, et importe ceux qu'il trouve.

Le venv en contient un, jamais demandé par l'application :

    logfire-plugin -> logfire.integrations.pydantic:plugin   (dist: logfire)

``logfire`` est le service d'observabilité **hébergé** de Pydantic. Il figure
dans ``requirements.txt`` (bloc « Stack LLM / agentique ») mais
**aucun module du dépôt ne l'importe** — c'est un reliquat. Son entry point
suffit pourtant à le charger dans chaque worker, avec toute sa dépendance :
``opentelemetry`` (132 modules), ``rich``, ``requests``, les stubs protobuf
``google``… Mesuré sur cette machine, par worker :

    | | plugins actifs | plugins coupés |
    |---|---|---|
    | modules chargés | 1467 | 990 |
    | RSS après ``create_app()`` | 114,1 Mo | 92,5 Mo |
    | ``create_app()`` | 372 ms | 162 ms |

Soit **−21,6 Mo par worker** (−65 Mo sur les 3 workers de la config gunicorn)
et un démarrage nettement plus court — ce qui compte à chaque recyclage
``max_requests=2000``, où un worker manque à l'appel le temps de renaître.

Le drapeau est lu par ``pydantic.plugin._loader.get_plugins()`` **à l'appel**,
pas à l'import : le poser tôt suffit, et il vaut aussi pour tout plugin tiers
qui s'installerait plus tard. C'est donc un garde-fou, pas un correctif ponctuel.

Échappatoire : ``PYDANTIC_DISABLE_PLUGINS=0`` dans l'environnement rétablit le
chargement. On ne touche jamais à une valeur déjà posée par l'exploitant.

§ 2 — Vérification de version de FastMCP
----------------------------------------
Au démarrage du serveur MCP local, ``fastmcp`` affiche une bannière et en
profite pour interroger **https://pypi.org/pypi/fastmcp/json** afin de signaler
une éventuelle mise à jour (``fastmcp/utilities/version_check.py``, cache de
12 h dans ``~/.local/share/fastmcp/``). Constaté ici : le fichier de cache
était bien réécrit à chaque démarrage à froid — l'appel partait pour de bon.

C'est contraire à la promesse du produit (installation locale, autonome, sans
dépendance externe), et ce n'est pas gratuit : ``server/local_mcp_server.py``
est un **sous-process relancé par session**, et la requête est plafonnée à 2 s.

    | démarrage du sous-process MCP | durée | appel PyPI |
    |---|---|---|
    | tel quel | 2,124 s | oui |
    | ``FASTMCP_CHECK_FOR_UPDATES=off`` | 1,882 s | non |

−242 ms par démarrage sur une machine **connectée** ; sur la cible réelle
(réseau fermé), c'est le délai de garde de 2 s qui serait payé, ou pire selon
la façon dont la résolution DNS échoue.

La bannière, elle, ne se coupe plus par l'environnement : depuis fastmcp 2.13
``show_server_banner`` a été renommé ``show_cli_banner`` et ne pilote plus que
``fastmcp run`` (la CLI), que nous n'utilisons pas — poser l'ancienne clé était
devenu un no-op silencieux. Elle est donc coupée à l'appel, dans
``server/local_mcp_server.py`` (``mcp.run(show_banner=False)``), ce qui vaut
pour toutes les versions. Le format de journalisation, lui, n'est pas touché.
"""
from __future__ import annotations

import os

#: Nom du drapeau lu par ``pydantic.plugin._loader.get_plugins()``.
PYDANTIC_PLUGINS_FLAG = "PYDANTIC_DISABLE_PLUGINS"

#: Réglages ``fastmcp`` (préfixe d'environnement ``FASTMCP_``) qui suppriment
#: l'appel sortant vers PyPI au démarrage du serveur MCP. La bannière, elle, se
#: coupe à l'appel (``mcp.run(show_banner=False)``) : sa clé d'environnement a
#: été renommée en amont et n'agit plus que sur la CLI.
FASTMCP_OFFLINE_SETTINGS = {
    "FASTMCP_CHECK_FOR_UPDATES": "off",
}


def disable_pydantic_plugins() -> bool:
    """Coupe le chargement des plugins pydantic. Rend True si on a bien posé
    le drapeau, False si l'environnement en portait déjà un (choix explicite
    de l'exploitant, qu'on respecte)."""
    if os.environ.get(PYDANTIC_PLUGINS_FLAG) is not None:
        return False
    os.environ[PYDANTIC_PLUGINS_FLAG] = "1"
    return True


def keep_fastmcp_offline() -> list[str]:
    """Coupe la vérification de version de FastMCP. Rend la liste des clés
    effectivement posées (vide si l'exploitant les avait déjà toutes fixées)."""
    posees = []
    for cle, valeur in FASTMCP_OFFLINE_SETTINGS.items():
        if os.environ.get(cle) is None:
            os.environ[cle] = valeur
            posees.append(cle)
    return posees


# Effet de bord à l'import : c'est tout l'intérêt du module — un point d'entrée
# n'a qu'à écrire ``import shared_infra.runtime.pyruntime`` en tête de fichier.
disable_pydantic_plugins()
keep_fastmcp_offline()
