# SPDX-License-Identifier: MIT
"""
shared_infra.git.providers — Registry des providers git pour la création de PR/MR.

``get_provider(provider_type)`` → l'instance (singleton) pour un type de
connecteur ; défaut = ``generic`` (sans API). ``compare_url_for`` construit
l'URL web de repli à partir du provider DÉTECTÉ (sans token).
"""
from __future__ import annotations

from typing import Dict

from shared_infra.git.providers.base import GitProvider
from shared_infra.git.providers.github import GitHubProvider
from shared_infra.git.providers.gitlab import GitLabProvider
from shared_infra.git.providers.bitbucket import (
    BitbucketCloudProvider, BitbucketServerProvider,
)
from shared_infra.git.providers.gitea import GiteaProvider
from shared_infra.git.providers.generic import GenericProvider

_INSTANCES = [
    GitHubProvider(), GitLabProvider(),
    BitbucketCloudProvider(), BitbucketServerProvider(),
    GiteaProvider(), GenericProvider(),
]
_REGISTRY: Dict[str, GitProvider] = {p.provider_type: p for p in _INSTANCES}

# provider DÉTECTÉ (heuristique host) → provider utilisé pour la compare-URL.
_DETECTED_COMPARE = {
    "github": "github", "gitlab": "gitlab", "bitbucket": "bitbucket-cloud",
}


def get_provider(provider_type: str) -> GitProvider:
    return _REGISTRY.get((provider_type or "").lower(), _REGISTRY["generic"])


def provider_types() -> list:
    return [p.provider_type for p in _INSTANCES]


def compare_url_for(detected_provider: str, *, host: str, owner: str, repo: str,
                    head: str, base: str, provider_type: str = "") -> str:
    """URL web de repli (sans token) pour ouvrir la PR à la main.

    ``provider_type`` (AUDIT 2026-08-02) : type du CONNECTEUR enregistré s'il
    existe — il PRIME sur la détection d'URL. Une Gitea self-hosted est
    ``unknown`` à la détection (host sur IP) mais son connecteur sait qu'elle est
    ``gitea`` → on produit alors la vraie compare-URL Gitea au lieu d'une chaîne
    vide (``GiteaProvider.compare_url`` existait mais n'était jamais atteint)."""
    key = (provider_type or "").lower()
    prov = _REGISTRY.get(key) if key else None
    if prov is None:
        ptype = _DETECTED_COMPARE.get((detected_provider or "").lower())
        prov = _REGISTRY.get(ptype) if ptype else None
    if prov is None:
        return ""
    return prov.compare_url(host=host, owner=owner, repo=repo, head=head, base=base)
