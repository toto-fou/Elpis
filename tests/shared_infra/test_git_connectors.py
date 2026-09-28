# SPDX-License-Identifier: MIT
"""Connecteurs Git : store DB + résolveur + SSRF unifié + providers + routes.

Couvre la feature qui remplace le fichier ``.git-credentials.json`` sale :
store par-(user,host) host-only, token write-only, résolution unifiée
push/pull + PR, validateur SSRF avec allowlist self-hosted, abstraction de
providers (http mocké), import legacy, et le contrat HTTP owner-scoped.
"""
from __future__ import annotations

import importlib
import sqlite3

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture()
def gc(tmp_path, monkeypatch):
    """Temp DB avec table users + migration 0006 ; renvoie le module CRUD."""
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    from shared_infra.db._connection import db_conn
    with db_conn() as conn:
        conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT)")
        conn.executemany("INSERT INTO users(id, username) VALUES (?,?)",
                         [(1, "alice"), (2, "bob")])
        from shared_infra.db._dialect import SQLITE, dialect_of
        if dialect_of(conn) == SQLITE:
            importlib.import_module(
                "shared_infra.db._migrations.0006_git_connectors").migrate(conn)
        else:                           # base serveur : née du schéma de référence
            from shared_infra.db import _schema
            _schema.ensure_tables(conn, ["git_connectors"])
        conn.commit()
    import shared_infra.git.connectors as _gc
    # le résolveur dé-duplique l'import legacy par process → on réinitialise.
    import shared_infra.git.resolver as R
    R._imported_users.clear()
    return _gc


# ── DB CRUD ───────────────────────────────────────────────────────────────────
def test_crud_token_writeonly_and_lowercase(gc):
    cid = gc.create_connector(1, "github", "GitHub.com", token="ghp_x",
                              username="ci", label="work")
    lst = gc.list_connectors(1)
    assert len(lst) == 1
    assert "token" not in lst[0] and lst[0]["has_token"] is True
    assert lst[0]["host"] == "github.com"                       # normalisé
    assert "token" not in gc.get_connector(1, cid)
    assert gc.get_connector_secret(1, cid)["token"] == "ghp_x"  # host-side only
    # isolation par owner
    assert gc.list_connectors(2) == []
    assert gc.get_connector(2, cid) is None


def test_unique_host_label_and_multiaccount(gc):
    gc.create_connector(1, "github", "github.com", token="t", label="work")
    with pytest.raises(sqlite3.IntegrityError):
        gc.create_connector(1, "github", "github.com", token="t2", label="work")
    gc.create_connector(1, "github", "github.com", token="t3", label="perso")
    assert len(gc.find_for_host(1, "github.com")) == 2
    assert gc.list_connector_hosts(1) == ["github.com"]


def test_update_token_optional(gc):
    cid = gc.create_connector(1, "github", "github.com", token="orig", label="x")
    assert gc.update_connector(1, cid, label="renamed")
    assert gc.get_connector_secret(1, cid)["token"] == "orig"   # inchangé
    assert gc.get_connector(1, cid)["label"] == "renamed"
    assert gc.update_connector(1, cid, token="new")
    assert gc.get_connector_secret(1, cid)["token"] == "new"
    assert gc.delete_connector(1, cid)
    assert gc.list_connectors(1) == []


# ── Résolveur ─────────────────────────────────────────────────────────────────
def test_resolve_by_host_and_api_base(gc):
    import shared_infra.git.resolver as R
    gc.create_connector(1, "github", "github.com", token="ghp", username="ci")
    cred = R.resolve_git_credential(1, "https://github.com/o/r.git")
    assert cred and cred["token"] == "ghp" and cred["provider_type"] == "github"
    assert cred["api_base"] == "https://api.github.com"


def test_resolve_self_hosted(gc):
    import shared_infra.git.resolver as R
    gc.create_connector(1, "gitlab", "gitlab.acme.internal", token="glp")
    cred = R.resolve_git_credential(1, "git@gitlab.acme.internal:g/sub/r.git")
    assert cred["api_base"] == "https://gitlab.acme.internal/api/v4"
    assert cred["token"] == "glp"


def test_resolve_miss(gc):
    import shared_infra.git.resolver as R
    assert R.resolve_git_credential(1, "https://github.com/o/r.git") is None


def test_normalize_host_tolerant():
    from shared_infra.git.detect import normalize_host as N
    assert N("10.168.1.50:3000") == "10.168.1.50:3000"
    assert N("GitHub.com") == "github.com"
    # l'utilisateur colle l'URL complète du repo (avec creds) → on garde le host
    assert N("http://user:pass@10.168.1.50:3000/owner/repo.git") == "10.168.1.50:3000"
    assert N("https://gitea.acme.io/team/proj.git") == "gitea.acme.io"
    assert N("10.168.1.50:3000/owner/repo") == "10.168.1.50:3000"
    assert N("git@gitea.acme.io:owner/repo.git") == "gitea.acme.io"


def test_import_legacy_idempotent(gc, tmp_path):
    import shared_infra.git.resolver as R
    sb = tmp_path / "sb"
    sb.mkdir()
    (sb / ".git-credentials.json").write_text(
        '{"github": {"token":"ghp_old","user":"bot"}, '
        '"gitlab": {"token":"glp","url":"https://gl.corp.com"}}', encoding="utf-8")
    assert R.import_legacy_git_credentials(1, sb) == 2
    assert not (sb / ".git-credentials.json").exists()
    assert (sb / ".git-credentials.json.imported").exists()
    hosts = set(gc.list_connector_hosts(1))
    assert "github.com" in hosts and "gl.corp.com" in hosts
    # 2e appel = no-op (dé-dupliqué par process)
    assert R.import_legacy_git_credentials(1, sb) == 0


# ── SSRF unifié ───────────────────────────────────────────────────────────────
def test_ssrf_unified():
    from shared_infra.git.ssrf import block_remote_url_reason as B
    assert B("https://github.com/o/r") is None                  # public https OK
    assert B("http://github.com/o/r") is not None               # https-only défaut
    assert B("http://github.com/o/r", allow_schemes=("http", "https")) is None
    assert B("https://10.0.0.1/x") is not None                  # IP privée
    assert B("https://localhost/x") is not None                 # littéral bloqué
    assert B("https://gitlab.local/x") is not None              # suffixe interne
    assert B("https://user:pw@github.com/x") is not None        # creds dans l'URL
    # allowlist self-hosted → autorisé malgré une IP privée
    assert B("https://gitlab.acme.internal/x",
             allow_hosts={"gitlab.acme.internal"}) is None
    # Self-hosted sur le LAN : HTTP + IP privée autorisés pour un host enregistré
    # (Gitea/GitLab sur la même VM/réseau, souvent en HTTP). C'est le cas du bug.
    assert B("http://10.168.1.50:3000/o/r.git", allow_hosts={"10.168.1.50:3000"}) is None
    assert B("http://10.168.1.50:3000/o/r.git", allow_hosts={"10.168.1.50"}) is None
    assert B("http://gitea.local/api/v1", allow_hosts={"gitea.local"}) is None
    # …mais ssh:// / file:// restent refusés même pour un host allowlisté
    assert B("ssh://10.168.1.50/x", allow_hosts={"10.168.1.50"}) is not None
    assert B("file:///etc/passwd", allow_hosts={"10.168.1.50"}) is not None


# ── Providers (http mocké) ────────────────────────────────────────────────────
def test_github_create_pr_new_and_existing():
    from shared_infra.git.providers import get_provider
    gp = get_provider("github")

    calls = []
    def http_new(url, method="GET", body=None, headers=None, timeout=12):
        calls.append(method)
        if method == "GET":
            return {"ok": True, "status": 200, "body": []}
        return {"ok": True, "status": 201, "body": {"html_url": "https://gh/pr/1", "number": 1}}
    r = gp.create_pr(http_new, api_base="https://api.github.com", token="t", username="u",
                     owner="o", repo="r", head="h", base="b", title="T", body="B", draft=True)
    assert r["ok"] and r["pr_number"] == 1 and "POST" in calls

    def http_exists(url, method="GET", body=None, headers=None, timeout=12):
        return {"ok": True, "status": 200, "body": [{"html_url": "https://gh/pr/9", "number": 9}]}
    r2 = gp.create_pr(http_exists, api_base="x", token="t", username="u", owner="o",
                      repo="r", head="h", base="b", title="T", body="B", draft=False)
    assert r2.get("already_open") and r2["pr_number"] == 9


def test_provider_registry_and_api_bases():
    from shared_infra.git.providers import get_provider, provider_types
    assert {"github", "gitlab", "bitbucket-cloud", "bitbucket-server",
            "gitea", "generic"}.issubset(set(provider_types()))
    assert get_provider("gitea").api_base("git.acme.io") == "https://git.acme.io/api/v1"
    assert get_provider("bitbucket-cloud").api_base("x") == "https://api.bitbucket.org/2.0"
    assert get_provider("bitbucket-server").api_base("bb.acme.io") == "https://bb.acme.io/rest/api/1.0"
    # generic n'a pas d'API
    assert get_provider("generic").create_pr(
        lambda *a, **k: {}, api_base="", token="", username="", owner="o", repo="r",
        head="h", base="b", title="t", body="", draft=False)["error_code"] == "no_api"


def test_gitea_uses_basic_auth_not_token():
    # Gitea : Basic (accepte mot de passe ET PAT) — PAS ``Authorization: token``
    # (qui n'accepte QU'un PAT → 401 avec un mot de passe). C'est le bug du 401.
    import base64
    from shared_infra.git.providers import get_provider
    cap = {}
    def http(url, method="GET", body=None, headers=None, timeout=12):
        cap["auth"] = (headers or {}).get("Authorization", "")
        return {"ok": True, "status": 200, "body": {"login": "admin"}}
    gitea = get_provider("gitea")
    r = gitea.test_connection(http, api_base="http://10.168.1.50:3000/api/v1",
                              token="myPassw0rd", username="admin")
    assert r["ok"] and r["login"] == "admin"
    assert cap["auth"].startswith("Basic ")        # surtout PAS "token "
    assert base64.b64decode(cap["auth"].split(" ", 1)[1]).decode() == "admin:myPassw0rd"
    # token seul (sans login) → token en username
    cap.clear()
    gitea.test_connection(http, api_base="x", token="ghp_x", username="")
    assert base64.b64decode(cap["auth"].split(" ", 1)[1]).decode() == "ghp_x:"


def test_askpass_token_only():
    from shared_infra.git.askpass import git_askpass_env
    with git_askpass_env("", "ghp_tok") as env:    # token sans login → injecté
        assert env.get("GIT_ASKPASS")
        assert env["GIT_ASKPASS_USER"] == "ghp_tok"
        assert env["GIT_ASKPASS_PASS"] == "ghp_tok"
    with git_askpass_env("alice", "pw") as env2:
        assert env2["GIT_ASKPASS_USER"] == "alice" and env2["GIT_ASKPASS_PASS"] == "pw"
    with git_askpass_env("alice", "") as env3:     # pas de token → rien
        assert env3 == {}


def test_test_connection_mocked():
    from shared_infra.git.providers import get_provider
    def http(url, method="GET", body=None, headers=None, timeout=12):
        return {"ok": True, "status": 200, "body": {"login": "octocat"}}
    assert get_provider("github").test_connection(
        http, api_base="x", token="t", username="u")["login"] == "octocat"


# ── Providers : listing des dépôts (clone 1-clic, http mocké) ──────────────────
def test_github_list_repos():
    from shared_infra.git.providers import get_provider
    def http(url, method="GET", body=None, headers=None, timeout=12):
        assert "/user/repos" in url
        return {"ok": True, "status": 200, "body": [
            {"full_name": "o/api", "clone_url": "https://github.com/o/api.git",
             "private": True, "description": "d", "updated_at": "2026-01-01",
             "html_url": "https://github.com/o/api"},
            {"full_name": "o/noclone"},                 # filtré : pas de clone_url
        ]}
    r = get_provider("github").list_repos(http, api_base="https://api.github.com",
                                          token="t", username="u")
    assert r["ok"] and len(r["repos"]) == 1
    repo = r["repos"][0]
    assert repo["full_name"] == "o/api" and repo["clone_url"].endswith("api.git")
    assert repo["private"] is True and repo["web_url"].endswith("/o/api")


def test_gitlab_list_repos_visibility():
    from shared_infra.git.providers import get_provider
    def http(url, method="GET", body=None, headers=None, timeout=12):
        return {"ok": True, "status": 200, "body": [
            {"path_with_namespace": "grp/sub/proj", "http_url_to_repo": "https://gl/grp/sub/proj.git",
             "visibility": "private", "description": "x", "last_activity_at": "2026",
             "web_url": "https://gl/grp/sub/proj"},
            {"path_with_namespace": "grp/pub", "http_url_to_repo": "https://gl/grp/pub.git",
             "visibility": "public"},
        ]}
    r = get_provider("gitlab").list_repos(http, api_base="https://gl/api/v4", token="t", username="")
    assert r["ok"] and len(r["repos"]) == 2
    assert r["repos"][0]["full_name"] == "grp/sub/proj" and r["repos"][0]["private"] is True
    assert r["repos"][1]["private"] is False


def test_gitea_list_repos():
    from shared_infra.git.providers import get_provider
    def http(url, method="GET", body=None, headers=None, timeout=12):
        return {"ok": True, "status": 200, "body": [
            {"full_name": "bob/repo", "clone_url": "http://host/bob/repo.git",
             "private": False, "description": "", "updated_at": "t",
             "html_url": "http://host/bob/repo"}]}
    r = get_provider("gitea").list_repos(http, api_base="http://host/api/v1", token="t", username="bob")
    assert r["ok"] and r["repos"][0]["clone_url"] == "http://host/bob/repo.git"


def test_bitbucket_cloud_list_repos_picks_https():
    from shared_infra.git.providers import get_provider
    def http(url, method="GET", body=None, headers=None, timeout=12):
        return {"ok": True, "status": 200, "body": {"values": [
            {"full_name": "team/api", "is_private": True, "description": "d", "updated_on": "t",
             "links": {"clone": [{"name": "ssh", "href": "git@bb:team/api.git"},
                                  {"name": "https", "href": "https://bb/team/api.git"}],
                       "html": {"href": "https://bb/team/api"}}},
            {"full_name": "team/nohttps",
             "links": {"clone": [{"name": "ssh", "href": "x"}]}},     # filtré : pas d'https
        ]}}
    r = get_provider("bitbucket-cloud").list_repos(
        http, api_base="https://api.bitbucket.org/2.0", token="t", username="u")
    assert r["ok"] and len(r["repos"]) == 1
    assert r["repos"][0]["clone_url"] == "https://bb/team/api.git" and r["repos"][0]["private"] is True


def test_bitbucket_server_list_repos():
    from shared_infra.git.providers import get_provider
    def http(url, method="GET", body=None, headers=None, timeout=12):
        return {"ok": True, "status": 200, "body": {"values": [
            {"slug": "api", "name": "api", "public": False, "description": "d",
             "project": {"key": "PROJ"},
             "links": {"clone": [{"name": "ssh", "href": "ssh://..."},
                                  {"name": "http", "href": "https://bb/scm/proj/api.git"}],
                       "self": [{"href": "https://bb/projects/PROJ/repos/api"}]}},
        ]}}
    r = get_provider("bitbucket-server").list_repos(
        http, api_base="https://bb/rest/api/1.0", token="t", username="")
    assert r["ok"] and r["repos"][0]["full_name"] == "PROJ/api"
    assert r["repos"][0]["clone_url"] == "https://bb/scm/proj/api.git"
    assert r["repos"][0]["private"] is True       # not public


def test_generic_list_repos_no_api():
    from shared_infra.git.providers import get_provider
    r = get_provider("generic").list_repos(lambda *a, **k: {}, api_base="", token="", username="")
    assert r["ok"] is False and r["error_code"] == "no_api" and r["repos"] == []


def test_list_repos_auth_failure_returns_status():
    from shared_infra.git.providers import get_provider
    def http(url, **k):
        return {"ok": False, "status": 401, "error": "HTTP 401"}
    r = get_provider("github").list_repos(http, api_base="x", token="bad", username="")
    assert r["ok"] is False and r["status"] == 401 and r["repos"] == []


# ── Routes HTTP (owner-scoped) ────────────────────────────────────────────────
@pytest.fixture()
def client(gc, monkeypatch):
    import shared_infra.git.routes as routes
    holder = {"uid": 1}
    monkeypatch.setattr(routes, "require_user_id", lambda request: holder["uid"])
    monkeypatch.setattr(routes, "audit_event", lambda **k: None)
    from shared_infra.routes._state import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app), holder, monkeypatch


def test_routes_crud_owner_scoped(client):
    c, holder, _ = client
    r = c.post("/api/git/connectors",
               json={"provider_type": "github", "host": "github.com",
                     "token": "ghp_secret", "username": "ci"})
    assert r.status_code == 200
    cid = r.json()["id"]
    listed = c.get("/api/git/connectors").json()
    assert listed["connectors"][0]["has_token"] is True
    assert "token" not in listed["connectors"][0]               # write-only
    assert "github" in listed["provider_types"]
    # bob ne voit rien et ne peut pas supprimer
    holder["uid"] = 2
    assert c.get("/api/git/connectors").json()["connectors"] == []
    assert c.delete(f"/api/git/connectors/{cid}").status_code == 404
    holder["uid"] = 1
    assert c.delete(f"/api/git/connectors/{cid}").status_code == 200


def test_route_normalizes_pasted_url_host(client):
    # L'utilisateur colle l'URI complète du repo (avec login:mdp) dans « host »
    # → le serveur n'en garde que le host:port (sinon matching cassé).
    c, _holder, _ = client
    r = c.post("/api/git/connectors", json={
        "provider_type": "gitea",
        "host": "http://bob:secret@10.168.1.50:3000/bob/repo.git",
        "token": "t", "username": "bob"})
    assert r.status_code == 200
    assert c.get("/api/git/connectors").json()["connectors"][0]["host"] == "10.168.1.50:3000"


def test_route_parse_repo_url(client):
    c, _holder, _ = client
    # Gitea local en HTTP (avec creds dans l'URL) → host extrait, api_base http.
    d = c.post("/api/git/connectors/parse",
               json={"url": "http://bob:pw@10.168.1.50:3000/team/repo.git",
                     "provider_type": "gitea"}).json()
    assert d["ok"] and d["host"] == "10.168.1.50:3000"
    assert d["api_base"] == "http://10.168.1.50:3000/api/v1"   # schéma http préservé
    # GitHub cloud auto-détecté, api_base https.
    d2 = c.post("/api/git/connectors/parse",
                json={"url": "https://github.com/o/r.git"}).json()
    assert d2["host"] == "github.com" and d2["detected_provider_type"] == "github"
    assert d2["api_base"] == "https://api.github.com"


def test_routes_validation(client):
    c, _holder, _ = client
    assert c.post("/api/git/connectors", json={"provider_type": "nope", "host": "x", "token": "t"}).status_code == 400
    assert c.post("/api/git/connectors", json={"provider_type": "github", "host": "", "token": "t"}).status_code == 400
    assert c.post("/api/git/connectors", json={"provider_type": "github", "host": "github.com"}).status_code == 400


def test_route_test_connection(client):
    c, _holder, monkeypatch = client
    cid = c.post("/api/git/connectors",
                 json={"provider_type": "github", "host": "github.com", "token": "t"}).json()["id"]
    # mock l'HTTP + le validateur SSRF (pas de réseau dans le test)
    import shared_infra.git._http as H
    import shared_infra.git.ssrf as S
    monkeypatch.setattr(H, "http_json",
                        lambda url, **k: {"ok": True, "status": 200, "body": {"login": "octo"}})
    monkeypatch.setattr(S, "block_remote_url_reason", lambda *a, **k: None)
    r = c.post(f"/api/git/connectors/{cid}/test")
    assert r.status_code == 200 and r.json()["ok"] and r.json()["login"] == "octo"


def test_route_list_connector_repos(client):
    c, holder, monkeypatch = client
    cid = c.post("/api/git/connectors",
                 json={"provider_type": "github", "host": "github.com", "token": "t"}).json()["id"]
    import shared_infra.git._http as H
    import shared_infra.git.ssrf as S
    monkeypatch.setattr(H, "http_json", lambda url, **k: {"ok": True, "status": 200, "body": [
        {"full_name": "o/r", "clone_url": "https://github.com/o/r.git", "private": False,
         "description": "", "updated_at": "t", "html_url": "https://github.com/o/r"}]})
    monkeypatch.setattr(S, "block_remote_url_reason", lambda *a, **k: None)
    r = c.get(f"/api/git/connectors/{cid}/repos")
    assert r.status_code == 200
    d = r.json()
    assert d["ok"] and len(d["repos"]) == 1 and d["repos"][0]["full_name"] == "o/r"
    assert all("token" not in repo for repo in d["repos"])       # jamais de secret
    # owner-scoping : bob ne voit pas le connecteur d'alice → 404
    holder["uid"] = 2
    assert c.get(f"/api/git/connectors/{cid}/repos").status_code == 404


def test_route_list_connector_repos_no_api(client):
    # Connecteur générique → pas d'api_base → no_api (avant tout appel réseau/SSRF).
    c, _holder, _ = client
    cid = c.post("/api/git/connectors",
                 json={"provider_type": "generic", "host": "git.acme.io", "token": "t"}).json()["id"]
    d = c.get(f"/api/git/connectors/{cid}/repos").json()
    assert d["ok"] is False and d["error"] == "no_api" and d["repos"] == []


# ── AUDIT 2026-08-02 — save_git_credential : enregistrement keyé sur le host ──
# L'utilisateur donne ses creds UNE FOIS (clone / chat) → persistés pour le host
# de l'URL → réutilisés par clone/push/pull/PR sans connecteur manuel.

def test_save_git_credential_creates_for_url_host(gc):
    import shared_infra.git.resolver as R
    cid = R.save_git_credential(1, "http://10.0.0.42:3000/alice/repo.git",
                                "alice", "TOK-123")
    assert cid
    rows = gc.find_for_host(1, "10.0.0.42:3000")
    assert len(rows) == 1
    assert rows[0]["provider_type"] == "gitea"      # self-hosted "unknown" → gitea
    assert rows[0]["token"] == "TOK-123"
    assert rows[0]["username"] == "alice"


def test_save_git_credential_accepts_bare_host(gc):
    import shared_infra.git.resolver as R
    assert R.save_git_credential(1, "10.0.0.42:3000", "u", "T")
    assert gc.find_for_host(1, "10.0.0.42:3000")[0]["token"] == "T"


def test_save_git_credential_upserts_same_host(gc):
    import shared_infra.git.resolver as R
    R.save_git_credential(1, "http://10.0.0.42:3000/a/b.git", "u1", "OLD")
    R.save_git_credential(1, "http://10.0.0.42:3000/other/c.git", "u2", "NEW")
    rows = gc.find_for_host(1, "10.0.0.42:3000")
    assert len(rows) == 1 and rows[0]["token"] == "NEW" and rows[0]["username"] == "u2"


def test_save_git_credential_detects_github(gc):
    import shared_infra.git.resolver as R
    R.save_git_credential(1, "https://github.com/o/r.git", "octocat", "ghp_x")
    rows = gc.find_for_host(1, "github.com")
    assert rows and rows[0]["provider_type"] == "github"


def test_save_then_resolve_roundtrip_gitea_lan(gc):
    # LE scénario cible : je donne mes creds, ensuite push/clone les résolvent.
    import shared_infra.git.resolver as R
    R.save_git_credential(1, "http://10.0.0.42:3000/alice/demo.git",
                          "alice", "TOK-123")
    cred = R.resolve_git_credential(
        1, "http://10.0.0.42:3000/alice/demo.git")
    assert cred and cred["token"] == "TOK-123"
    assert cred["provider_type"] == "gitea"
    # api_base dérivé en HTTP (IP privée) — cf. GiteaProvider.api_base adaptatif.
    assert cred["api_base"] == "http://10.0.0.42:3000/api/v1"
