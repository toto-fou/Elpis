# SPDX-License-Identifier: MIT
"""Provider générique : aucune API PR. Repli sur la compare-URL si connue."""
from __future__ import annotations

from typing import Any, Dict

from shared_infra.git.providers.base import GitProvider, Http


class GenericProvider(GitProvider):
    provider_type = "generic"

    def api_base(self, host: str, override: str = "") -> str:
        return override.rstrip("/") if override else ""

    def create_pr(self, http: Http, *, api_base, token, username, owner, repo,
                  head, base, title, body, draft) -> Dict[str, Any]:
        return {"ok": False, "error_code": "no_api",
                "error": "provider sans API de PR (ouverture manuelle requise)"}

    def test_connection(self, http: Http, *, api_base, token, username) -> Dict[str, Any]:
        return {"ok": False, "error": "no_api"}
