# SPDX-License-Identifier: MIT
"""GitHub (Cloud + Enterprise Server). Auth: Bearer token."""
from __future__ import annotations

from typing import Any, Dict

from shared_infra.git.providers.base import GitProvider, Http, _err


class GitHubProvider(GitProvider):
    provider_type = "github"

    def api_base(self, host: str, override: str = "") -> str:
        if override:
            return override.rstrip("/")
        h = (host or "github.com").lower()
        # Cloud → api.github.com ; Enterprise Server → {host}/api/v3.
        return "https://api.github.com" if h == "github.com" else f"https://{host}/api/v3"

    def _headers(self, token: str) -> Dict[str, str]:
        return {"Authorization": f"Bearer {token}",
                "X-GitHub-Api-Version": "2022-11-28"}

    def create_pr(self, http: Http, *, api_base, token, username, owner, repo,
                  head, base, title, body, draft) -> Dict[str, Any]:
        hdr = self._headers(token)
        existing = (f"{api_base}/repos/{owner}/{repo}/pulls"
                    f"?head={owner}:{head}&base={base}&state=open")
        r1 = http(existing, headers=hdr)
        if r1.get("ok") and isinstance(r1.get("body"), list) and r1["body"]:
            pr = r1["body"][0]
            return {"ok": True, "pr_url": pr.get("html_url"),
                    "pr_number": pr.get("number"), "already_open": True}
        payload = {"title": title, "body": body, "head": head, "base": base,
                   "draft": bool(draft)}
        r2 = http(f"{api_base}/repos/{owner}/{repo}/pulls", method="POST",
                  body=payload, headers=hdr)
        if r2.get("ok") and isinstance(r2.get("body"), dict):
            pr = r2["body"]
            return {"ok": True, "pr_url": pr.get("html_url"), "pr_number": pr.get("number")}
        return _err("github_api_error", r2)

    def test_connection(self, http: Http, *, api_base, token, username) -> Dict[str, Any]:
        r = http(f"{api_base}/user", headers=self._headers(token))
        if r.get("ok") and isinstance(r.get("body"), dict):
            return {"ok": True, "login": r["body"].get("login")}
        return {"ok": False, "error": r.get("error", "auth_failed"), "status": r.get("status")}

    def list_repos(self, http: Http, *, api_base, token, username, query="") -> Dict[str, Any]:
        r = http(f"{api_base}/user/repos?per_page=100&sort=updated"
                 f"&affiliation=owner,collaborator,organization_member",
                 headers=self._headers(token))
        if not (r.get("ok") and isinstance(r.get("body"), list)):
            return {"ok": False, "error": r.get("error", "auth_failed"),
                    "status": r.get("status"), "repos": []}
        repos = [{"full_name": x.get("full_name"), "clone_url": x.get("clone_url"),
                  "private": bool(x.get("private")), "description": x.get("description") or "",
                  "updated_at": x.get("updated_at"), "web_url": x.get("html_url")}
                 for x in r["body"] if x.get("clone_url")]
        return {"ok": True, "repos": repos}

    def compare_url(self, *, host, owner, repo, head, base) -> str:
        return f"https://{host}/{owner}/{repo}/compare/{base}...{head}?expand=1"
