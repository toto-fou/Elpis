# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_gitea_selfhosted.py — support Gitea self-hosted (LAN).

AUDIT 2026-08-02 — passe sur le support Gitea :
  #2 ``GiteaProvider.api_base`` : schéma adaptatif (http pour IP privée / host
     interne, https pour un host public) — sans override explicite.
  #3 ``compare_url_for`` : respecte le ``provider_type`` du connecteur (une Gitea
     est ``unknown`` à la détection d'URL, mais le connecteur sait) → vraie
     compare-URL au lieu d'une chaîne vide.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shared_infra.git.providers import compare_url_for, get_provider

# ── #2 — api_base : schéma adaptatif ─────────────────────────────────────────

def test_gitea_api_base_http_for_private_lan():
    g = get_provider("gitea")
    assert g.api_base("git.example.lan:3000") == "http://git.example.lan:3000/api/v1"
    assert g.api_base("10.0.0.5") == "http://10.0.0.5/api/v1"
    assert g.api_base("localhost:3000") == "http://localhost:3000/api/v1"
    assert g.api_base("gitea.internal") == "http://gitea.internal/api/v1"


def test_gitea_api_base_https_for_public_host():
    g = get_provider("gitea")
    assert g.api_base("git.acme.io") == "https://git.acme.io/api/v1"


def test_gitea_api_base_override_wins():
    g = get_provider("gitea")
    assert g.api_base("git.example.lan:3000", "https://forced/api/v1") == "https://forced/api/v1"


# ── #3 — compare_url_for : provider_type du connecteur prioritaire ───────────

def test_compare_url_uses_connector_provider_type_for_gitea():
    # Host sur IP → provider DÉTECTÉ = "unknown", mais le connecteur dit "gitea".
    url = compare_url_for("unknown", host="git.example.lan:3000", owner="bob",
                          repo="proj", head="agent/x", base="main",
                          provider_type="gitea")
    assert url and "git.example.lan:3000/bob/proj/compare/main...agent/x" in url


def test_compare_url_empty_when_unknown_and_no_connector():
    assert compare_url_for("unknown", host="h", owner="o", repo="r",
                           head="a", base="b") == ""


def test_compare_url_detected_github_still_works():
    url = compare_url_for("github", host="github.com", owner="o", repo="r",
                          head="agent/x", base="main")
    assert "github.com/o/r/compare/main...agent/x" in url


# ── AUDIT 2026-08-02 — 404 /pulls = Pull Requests désactivées (message clair) ─

def test_gitea_create_pr_detects_disabled_on_get():
    g = get_provider("gitea")
    def fake_http(url, method="GET", body=None, headers=None):
        return {"ok": False, "status": 404,
                "body": '{"message":"The target couldn\'t be found."}'}
    res = g.create_pr(fake_http, api_base="http://localhost:3000/api/v1", token="t",
                      username="u", owner="o", repo="r", head="agent/x", base="main",
                      title="t", body="b", draft=True)
    assert res["ok"] is False
    assert res["error_code"] == "pull_requests_disabled"
    assert "Pull Requests" in res["error"]


def test_gitea_create_pr_detects_disabled_on_post():
    g = get_provider("gitea")
    def fake_http(url, method="GET", body=None, headers=None):
        if "?state=open" in url:               # GET dédup OK (liste vide)
            return {"ok": True, "status": 200, "body": []}
        return {"ok": False, "status": 404, "body": "{}"}   # POST /pulls → 404
    res = g.create_pr(fake_http, api_base="http://x/api/v1", token="t", username="u",
                      owner="o", repo="r", head="h", base="b", title="t", body="b", draft=True)
    assert res["error_code"] == "pull_requests_disabled"
