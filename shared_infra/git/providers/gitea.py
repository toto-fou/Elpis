# SPDX-License-Identifier: MIT
"""Gitea (self-hosted le plus souvent). Auth: HTTP Basic.

IMPORTANT : on utilise **Basic** (``user:password`` ou ``user:token``) et NON
``Authorization: token <…>``. Le schéma ``token`` de Gitea n'accepte QU'un
Personal Access Token → un mot de passe de compte y renvoie 401 (alors qu'il est
valide). Basic accepte le mot de passe ET le PAT, donc « ça marche avec mes
identifiants ».
"""
from __future__ import annotations

from typing import Any, ClassVar, Dict

from shared_infra.git._http import basic_auth_header
from shared_infra.git.providers.base import GitProvider, Http, _err


def _host_is_private(host: str) -> bool:
    """True si ``host`` (port éventuel inclus) désigne une IP privée/loopback/
    link-local ou un host interne → défaut HTTP pour l'API self-hosted."""
    import ipaddress
    hp = (host or "").strip()
    if hp.startswith("["):                       # [IPv6]:port
        h = hp[1:hp.index("]")] if "]" in hp else hp[1:]
    else:
        h = hp.split(":")[0]                     # host:port (IPv4 / nom)
    h = h.strip().lower()
    if not h:
        return False
    try:
        return not ipaddress.ip_address(h).is_global
    except ValueError:
        return h == "localhost" or h.endswith(
            (".local", ".internal", ".lan", ".home", ".corp", ".intranet"))


class GiteaProvider(GitProvider):
    provider_type = "gitea"

    def api_base(self, host: str, override: str = "") -> str:
        if override:
            return override.rstrip("/")
        # AUDIT 2026-08-02 — schéma adaptatif : une Gitea self-hosted sur le LAN
        # (IP privée / host interne) est le plus souvent en HTTP. Forcer https
        # faisait échouer l'API PR/test SANS override explicite. Un host public
        # reste en https.
        scheme = "http" if _host_is_private(host) else "https"
        return f"{scheme}://{host}/api/v1"

    def _headers(self, username: str, token: str) -> Dict[str, str]:
        # Avec login : Basic(user, token-ou-mdp). Sans login : token en username
        # (Gitea accepte un PAT comme username, mot de passe vide).
        user = username or token
        pw = token if username else ""
        return {"Authorization": basic_auth_header(user, pw)}

    # AUDIT 2026-08-02 — Gitea renvoie 404 « The target couldn't be found » sur
    # l'endpoint ``/pulls`` quand l'UNIT « Pull Requests » est DÉSACTIVÉE sur le
    # dépôt (le repo et ``/branches`` répondent pourtant 200). L'ancien code
    # remontait un « HTTP 404 » cryptique. On détecte ce cas et on renvoie un
    # message ACTIONNABLE. (Un 404 sur le POST/GET pulls d'un repo accessible =
    # PR désactivées ; un vrai « repo introuvable » aurait 404 dès /repos.)
    _PR_DISABLED: ClassVar[Dict[str, Any]] = {     # copié à chaque réponse
        "ok": False, "error_code": "pull_requests_disabled",
        "error": ("Les Pull Requests sont DÉSACTIVÉES sur ce dépôt Gitea. "
                  "Activez-les : dépôt → Paramètres → onglet « Unités » "
                  "(ou Advanced) → cochez « Pull Requests », puis réessayez."),
        "status": 404,
    }

    def create_pr(self, http: Http, *, api_base, token, username, owner, repo,
                  head, base, title, body, draft) -> Dict[str, Any]:
        hdr = self._headers(username, token)
        # L'API liste les pulls ouverts ; on filtre par branche côté client.
        r1 = http(f"{api_base}/repos/{owner}/{repo}/pulls?state=open", headers=hdr)
        if r1.get("status") == 404:
            return dict(self._PR_DISABLED)
        if r1.get("ok") and isinstance(r1.get("body"), list):
            for pr in r1["body"]:
                if ((pr.get("head") or {}).get("ref") == head and
                        (pr.get("base") or {}).get("ref") == base):
                    return {"ok": True, "pr_url": pr.get("html_url"),
                            "pr_number": pr.get("number"), "already_open": True}
        payload = {"title": title, "body": body, "head": head, "base": base}
        r2 = http(f"{api_base}/repos/{owner}/{repo}/pulls", method="POST",
                  body=payload, headers=hdr)
        if r2.get("ok") and isinstance(r2.get("body"), dict):
            pr = r2["body"]
            return {"ok": True, "pr_url": pr.get("html_url"), "pr_number": pr.get("number")}
        if r2.get("status") == 404:
            return dict(self._PR_DISABLED)
        return _err("gitea_api_error", r2)

    def test_connection(self, http: Http, *, api_base, token, username) -> Dict[str, Any]:
        r = http(f"{api_base}/user", headers=self._headers(username, token))
        if r.get("ok") and isinstance(r.get("body"), dict):
            return {"ok": True, "login": r["body"].get("login")}
        return {"ok": False, "error": r.get("error", "auth_failed"), "status": r.get("status")}

    def list_repos(self, http: Http, *, api_base, token, username, query="") -> Dict[str, Any]:
        r = http(f"{api_base}/user/repos?limit=50", headers=self._headers(username, token))
        if not (r.get("ok") and isinstance(r.get("body"), list)):
            return {"ok": False, "error": r.get("error", "auth_failed"),
                    "status": r.get("status"), "repos": []}
        repos = [{"full_name": x.get("full_name"), "clone_url": x.get("clone_url"),
                  "private": bool(x.get("private")), "description": x.get("description") or "",
                  "updated_at": x.get("updated_at"), "web_url": x.get("html_url")}
                 for x in r["body"] if x.get("clone_url")]
        return {"ok": True, "repos": repos}

    def compare_url(self, *, host, owner, repo, head, base) -> str:
        return f"https://{host}/{owner}/{repo}/compare/{base}...{head}"
