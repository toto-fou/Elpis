# SPDX-License-Identifier: MIT
"""
shared_infra.git.detect — Parse une URL de remote git.

Source unique (déplacée depuis ``llm_core.tools.git_tools._detect_provider``)
partagée par le chemin MCP et les routes. Gère les formes HTTPS et SSH.
"""
from __future__ import annotations

import re
from typing import Dict
from urllib.parse import urlsplit

# Provider DÉTECTÉ (heuristique sur le host) → type de connecteur par défaut.
# Le ``provider_type`` explicite d'un connecteur enregistré prime toujours sur
# cette détection (cf. resolver) — utile pour Gitea / self-hosted indétectables.
_DETECTED_TO_TYPE = {
    "github": "github",
    "gitlab": "gitlab",
    "bitbucket": "bitbucket-cloud",
}


def detect_provider(remote_url: str) -> Dict[str, str]:
    """``{provider, host, owner, repo}`` ou ``{}`` si non parsable.

    ``provider`` ∈ github | gitlab | bitbucket | unknown (heuristique host).
    ``host`` conserve la casse d'origine du netloc (port inclus si présent).
    """
    if not remote_url:
        return {}
    url = remote_url.strip()
    # On distingue d'abord par le schéma : une URL ``http(s)://`` (même avec
    # ``user:pass@host:port``) NE doit PAS matcher la regex SSH (sinon le port
    # serait coupé au premier « : »).
    if "://" in url:
        m = re.match(r"^https?://(?:[^@]+@)?([^/]+)/(.+?)(?:\.git)?/?$", url)
    else:
        # Forme SSH ``[user@]host:owner/repo(.git)``
        m = re.match(r"^(?:[^@/]+@)?([^:/]+):(.+?)(?:\.git)?$", url)
    if not m:
        return {}
    host, path = m.group(1), m.group(2)

    parts = path.strip("/").split("/")
    if len(parts) < 2:
        return {}
    owner = parts[0]
    repo = "/".join(parts[1:])  # GitLab peut avoir des groupes imbriqués

    host_lc = host.lower()
    if host_lc == "github.com":
        provider = "github"
    elif host_lc == "gitlab.com":
        provider = "gitlab"
    elif host_lc == "bitbucket.org":
        provider = "bitbucket"
    elif "gitlab" in host_lc:
        provider = "gitlab"      # GitLab self-hosted (heuristique)
    else:
        provider = "unknown"

    return {"provider": provider, "host": host, "owner": owner, "repo": repo}


def default_provider_type(detected_provider: str) -> str:
    """Type de connecteur par défaut pour un provider détecté."""
    return _DETECTED_TO_TYPE.get(detected_provider or "", "generic")


def normalize_host(raw: str) -> str:
    """Extrait le ``host[:port]`` de ce que l'utilisateur a pu coller dans le
    champ « host » : URL complète, ``user:pass@host``, ``host/owner/repo``,
    forme SSH ``git@host:owner/repo``… Renvoie le host minuscule, sans schéma,
    sans credentials, sans chemin. Tolérant pour éviter le piège du « j'ai collé
    l'URI du repo ».
    """
    s = (raw or "").strip()
    if not s:
        return ""
    if "://" in s:                                  # URL complète
        netloc = urlsplit(s).netloc or ""
    elif "@" in s and ":" in s.split("@", 1)[1] and "/" not in s.split("@", 1)[1].split(":", 1)[0]:
        # Forme SSH ``user@host:owner/repo`` → host = avant le « : »
        netloc = s.split("@", 1)[1].split(":", 1)[0]
    else:
        netloc = s.split("/", 1)[0]                 # coupe un éventuel /owner/repo
    if "@" in netloc:                               # retire user:pass@
        netloc = netloc.rsplit("@", 1)[1]
    return netloc.strip().lower()
