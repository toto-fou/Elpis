# SPDX-License-Identifier: MIT
"""GitLab (Cloud + self-hosted). Auth: PRIVATE-TOKEN. Merge Requests."""
from __future__ import annotations

import urllib.parse
from typing import Any, Dict

from shared_infra.git.providers.base import GitProvider, Http, _err


class GitLabProvider(GitProvider):
    provider_type = "gitlab"

    def api_base(self, host: str, override: str = "") -> str:
        if override:
            return override.rstrip("/")
        return f"https://{host}/api/v4"

    def _headers(self, token: str) -> Dict[str, str]:
        return {"PRIVATE-TOKEN": token}

    def create_pr(self, http: Http, *, api_base, token, username, owner, repo,
                  head, base, title, body, draft) -> Dict[str, Any]:
        hdr = self._headers(token)
        project = urllib.parse.quote(f"{owner}/{repo}", safe="")  # groupes imbriqués OK
        existing = (f"{api_base}/projects/{project}/merge_requests"
                    f"?source_branch={head}&target_branch={base}&state=opened")
        r1 = http(existing, headers=hdr)
        if r1.get("ok") and isinstance(r1.get("body"), list) and r1["body"]:
            mr = r1["body"][0]
            return {"ok": True, "pr_url": mr.get("web_url"),
                    "pr_number": mr.get("iid"), "already_open": True}
        final_title = (f"Draft: {title}"
                       if draft and not title.lower().startswith(("draft:", "wip:"))
                       else title)
        payload = {"title": final_title, "description": body,
                   "source_branch": head, "target_branch": base}
        r2 = http(f"{api_base}/projects/{project}/merge_requests", method="POST",
                  body=payload, headers=hdr)
        if r2.get("ok") and isinstance(r2.get("body"), dict):
            mr = r2["body"]
            return {"ok": True, "pr_url": mr.get("web_url"), "pr_number": mr.get("iid")}
        return _err("gitlab_api_error", r2)

    def test_connection(self, http: Http, *, api_base, token, username) -> Dict[str, Any]:
        r = http(f"{api_base}/user", headers=self._headers(token))
        if r.get("ok") and isinstance(r.get("body"), dict):
            return {"ok": True, "login": r["body"].get("username")}
        return {"ok": False, "error": r.get("error", "auth_failed"), "status": r.get("status")}

    def list_repos(self, http: Http, *, api_base, token, username, query="") -> Dict[str, Any]:
        r = http(f"{api_base}/projects?membership=true&simple=true&per_page=100"
                 f"&order_by=last_activity_at", headers=self._headers(token))
        if not (r.get("ok") and isinstance(r.get("body"), list)):
            return {"ok": False, "error": r.get("error", "auth_failed"),
                    "status": r.get("status"), "repos": []}
        repos = [{"full_name": x.get("path_with_namespace"),
                  "clone_url": x.get("http_url_to_repo"),
                  "private": (x.get("visibility") or "private") != "public",
                  "description": x.get("description") or "",
                  "updated_at": x.get("last_activity_at"), "web_url": x.get("web_url")}
                 for x in r["body"] if x.get("http_url_to_repo")]
        return {"ok": True, "repos": repos}

    def compare_url(self, *, host, owner, repo, head, base) -> str:
        return f"https://{host}/{owner}/{repo}/-/compare/{base}...{head}"
