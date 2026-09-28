# SPDX-License-Identifier: MIT
"""Bitbucket Cloud (API 2.0, Basic auth) + Bitbucket Server/DC (REST 1.0, Bearer)."""
from __future__ import annotations

from typing import Any, Dict

from shared_infra.git._http import basic_auth_header
from shared_infra.git.providers.base import GitProvider, Http, _err


def _pick_clone(links: Dict[str, Any], scheme: str) -> str:
    """Extrait l'URL de clone ``scheme`` (``https``/``http``) de ``links.clone[]``."""
    for c in (links or {}).get("clone") or []:
        if (c.get("name") or "").lower() == scheme:
            return c.get("href") or ""
    return ""


class BitbucketCloudProvider(GitProvider):
    provider_type = "bitbucket-cloud"

    def api_base(self, host: str, override: str = "") -> str:
        return override.rstrip("/") if override else "https://api.bitbucket.org/2.0"

    def _headers(self, username: str, token: str) -> Dict[str, str]:
        # App password → Basic (username obligatoire côté Cloud).
        return {"Authorization": basic_auth_header(username or "x-token-auth", token)}

    def create_pr(self, http: Http, *, api_base, token, username, owner, repo,
                  head, base, title, body, draft) -> Dict[str, Any]:
        hdr = self._headers(username, token)
        r1 = http(f"{api_base}/repositories/{owner}/{repo}/pullrequests?state=OPEN", headers=hdr)
        if r1.get("ok") and isinstance(r1.get("body"), dict):
            for pr in (r1["body"].get("values") or []):
                if ((pr.get("source") or {}).get("branch", {}).get("name") == head and
                        (pr.get("destination") or {}).get("branch", {}).get("name") == base):
                    return {"ok": True,
                            "pr_url": (pr.get("links") or {}).get("html", {}).get("href"),
                            "pr_number": pr.get("id"), "already_open": True}
        payload = {"title": title, "description": body,
                   "source": {"branch": {"name": head}},
                   "destination": {"branch": {"name": base}}}
        r2 = http(f"{api_base}/repositories/{owner}/{repo}/pullrequests",
                  method="POST", body=payload, headers=hdr)
        if r2.get("ok") and isinstance(r2.get("body"), dict):
            pr = r2["body"]
            return {"ok": True,
                    "pr_url": (pr.get("links") or {}).get("html", {}).get("href"),
                    "pr_number": pr.get("id")}
        return _err("bitbucket_api_error", r2)

    def test_connection(self, http: Http, *, api_base, token, username) -> Dict[str, Any]:
        r = http(f"{api_base}/user", headers=self._headers(username, token))
        if r.get("ok") and isinstance(r.get("body"), dict):
            return {"ok": True, "login": r["body"].get("username") or r["body"].get("nickname")}
        return {"ok": False, "error": r.get("error", "auth_failed"), "status": r.get("status")}

    def list_repos(self, http: Http, *, api_base, token, username, query="") -> Dict[str, Any]:
        r = http(f"{api_base}/repositories?role=member&pagelen=100&sort=-updated_on",
                 headers=self._headers(username, token))
        if not (r.get("ok") and isinstance(r.get("body"), dict)):
            return {"ok": False, "error": r.get("error", "auth_failed"),
                    "status": r.get("status"), "repos": []}
        repos = []
        for x in (r["body"].get("values") or []):
            clone_url = _pick_clone(x.get("links") or {}, "https")
            if not clone_url:
                continue
            repos.append({"full_name": x.get("full_name"), "clone_url": clone_url,
                          "private": bool(x.get("is_private")),
                          "description": x.get("description") or "",
                          "updated_at": x.get("updated_on"),
                          "web_url": ((x.get("links") or {}).get("html") or {}).get("href")})
        return {"ok": True, "repos": repos}

    def compare_url(self, *, host, owner, repo, head, base) -> str:
        return f"https://{host}/{owner}/{repo}/pull-requests/new?source={head}&dest={base}"


class BitbucketServerProvider(GitProvider):
    provider_type = "bitbucket-server"

    def api_base(self, host: str, override: str = "") -> str:
        return override.rstrip("/") if override else f"https://{host}/rest/api/1.0"

    def _headers(self, token: str) -> Dict[str, str]:
        return {"Authorization": f"Bearer {token}"}

    def create_pr(self, http: Http, *, api_base, token, username, owner, repo,
                  head, base, title, body, draft) -> Dict[str, Any]:
        # owner = clé de projet (PROJ), repo = slug.
        hdr = self._headers(token)
        listed = http(f"{api_base}/projects/{owner}/repos/{repo}/pull-requests"
                      f"?state=OPEN&direction=OUTGOING", headers=hdr)
        if listed.get("ok") and isinstance(listed.get("body"), dict):
            for pr in (listed["body"].get("values") or []):
                if ((pr.get("fromRef") or {}).get("displayId") == head and
                        (pr.get("toRef") or {}).get("displayId") == base):
                    links = (pr.get("links") or {}).get("self") or [{}]
                    return {"ok": True, "pr_url": links[0].get("href"),
                            "pr_number": pr.get("id"), "already_open": True}
        payload = {"title": title, "description": body,
                   "fromRef": {"id": f"refs/heads/{head}"},
                   "toRef": {"id": f"refs/heads/{base}"}}
        r2 = http(f"{api_base}/projects/{owner}/repos/{repo}/pull-requests",
                  method="POST", body=payload, headers=hdr)
        if r2.get("ok") and isinstance(r2.get("body"), dict):
            pr = r2["body"]
            links = (pr.get("links") or {}).get("self") or [{}]
            return {"ok": True, "pr_url": links[0].get("href"), "pr_number": pr.get("id")}
        return _err("bitbucket_server_api_error", r2)

    def test_connection(self, http: Http, *, api_base, token, username) -> Dict[str, Any]:
        r = http(f"{api_base}/projects?limit=1", headers=self._headers(token))
        if r.get("ok"):
            return {"ok": True, "login": username or None}
        return {"ok": False, "error": r.get("error", "auth_failed"), "status": r.get("status")}

    def list_repos(self, http: Http, *, api_base, token, username, query="") -> Dict[str, Any]:
        r = http(f"{api_base}/repos?limit=100", headers=self._headers(token))
        if not (r.get("ok") and isinstance(r.get("body"), dict)):
            return {"ok": False, "error": r.get("error", "auth_failed"),
                    "status": r.get("status"), "repos": []}
        repos = []
        for x in (r["body"].get("values") or []):
            links = x.get("links") or {}
            clone_url = _pick_clone(links, "http")
            if not clone_url:
                continue
            key = ((x.get("project") or {}).get("key")) or ""
            slug = x.get("slug") or x.get("name") or ""
            self_links = links.get("self") or [{}]
            repos.append({"full_name": f"{key}/{slug}" if key else slug,
                          "clone_url": clone_url,
                          "private": not bool(x.get("public")),
                          "description": x.get("description") or "",
                          "updated_at": None,
                          "web_url": (self_links[0] or {}).get("href")})
        return {"ok": True, "repos": repos}

    def compare_url(self, *, host, owner, repo, head, base) -> str:
        return (f"https://{host}/projects/{owner}/repos/{repo}/compare/commits"
                f"?sourceBranch=refs/heads/{head}&targetBranch=refs/heads/{base}")
