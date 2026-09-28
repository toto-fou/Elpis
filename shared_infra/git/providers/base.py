# SPDX-License-Identifier: MIT
"""
shared_infra.git.providers.base — Interface d'un provider git (création PR/MR).

Stateless : toutes les valeurs (api_base, token, owner/repo, branches) sont
passées en argument. ``http`` est le client JSON injecté (``shared_infra.git
._http.http_json``) — mockable en test.

Forme de retour de ``create_pr`` (identique à l'ancien ``_open_pr_github``) :
  succès → ``{ok: True, pr_url, pr_number, already_open?}``
  échec  → ``{ok: False, error_code, error, status, body}``
``test_connection`` → ``{ok, login?, error?}``.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Callable, Dict

Http = Callable[..., Dict[str, Any]]


class GitProvider(ABC):
    provider_type: str = ""

    @abstractmethod
    def api_base(self, host: str, override: str = "") -> str:
        """URL de base de l'API pour ce host (gère cloud vs self-hosted)."""

    @abstractmethod
    def create_pr(self, http: Http, *, api_base: str, token: str, username: str,
                  owner: str, repo: str, head: str, base: str,
                  title: str, body: str, draft: bool) -> Dict[str, Any]:
        """Ouvre (ou retrouve) la PR/MR. Vérifie d'abord l'existence."""

    @abstractmethod
    def test_connection(self, http: Http, *, api_base: str, token: str,
                        username: str) -> Dict[str, Any]:
        """Valide le token via un GET authentifié léger."""

    def list_repos(self, http: Http, *, api_base: str, token: str,
                   username: str, query: str = "") -> Dict[str, Any]:
        """Liste les dépôts accessibles avec ce token (pour le clone 1-clic).

        Défaut = non supporté (provider sans API de listing). Les providers qui
        savent lister surchargent. Forme de retour :
          succès → ``{ok: True, repos: [ {full_name, clone_url, private,
                       description, updated_at, web_url}, … ]}``
          échec  → ``{ok: False, error?, error_code?, status?, repos: []}``
        Les dépôts sont triés du plus récemment actif au plus ancien et plafonnés
        (~100) ; le filtrage fin se fait côté client.
        """
        return {"ok": False, "error_code": "no_api",
                "error": "provider sans API de listing", "repos": []}

    def compare_url(self, *, host: str, owner: str, repo: str,
                    head: str, base: str) -> str:
        """URL web de repli pour ouvrir la PR à la main (sans token)."""
        return ""


def _err(code: str, r: Dict[str, Any]) -> Dict[str, Any]:
    return {"ok": False, "error_code": code, "error": r.get("error", "unknown"),
            "status": r.get("status"), "body": r.get("body", "")}
