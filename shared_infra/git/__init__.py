# SPDX-License-Identifier: MIT
"""
shared_infra.git — Infrastructure git PARTAGÉE entre le chemin MCP
(``llm_core.tools.git_tools``, l'agent) et le chemin routes HTTP
(``shared_infra.sandbox.routes_git``, l'UI humaine).

Placé dans ``shared_infra`` (et NON ``llm_core``) pour respecter le sens des
dépendances : ``llm_core`` importe ``shared_infra`` (jamais l'inverse). Les deux
couches consomment donc le MÊME résolveur de credentials, la MÊME abstraction de
providers et le MÊME validateur SSRF ; l'identifiant est ajouté aux requêtes
Git par le relais de l'hôte (``shared_infra.sandbox.git_relay``).

Modules :
  - ``detect``    : parse une URL de remote → {provider, host, owner, repo}
  - ``ssrf``      : validateur SSRF unifié (clone/fetch/push/pull + API)
  - ``resolver``  : ``resolve_git_credential`` (remplace le fichier sandbox)
  - ``providers`` : abstraction PR/MR multi-provider (GitHub/GitLab/Bitbucket/Gitea)
"""
