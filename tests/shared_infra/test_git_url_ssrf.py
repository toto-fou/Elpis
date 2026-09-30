# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_git_url_ssrf.py — anti-SSRF de _validate_git_url.

Couvre : schémas refusés, IP littérales non publiques, et surtout l'anti
DNS-rebinding (un hostname « public » qui résout vers loopback/privé est bloqué).
"""
from __future__ import annotations

import io
import socket
import urllib.request

import pytest
from fastapi import HTTPException

from shared_infra.sandbox.routes_git import _validate_git_url


def test_blocks_disallowed_scheme():
    for bad in ["file:///etc/passwd", "ssh://git@host/repo", "ftp://h/r"]:
        with pytest.raises(HTTPException):
            _validate_git_url(bad)


def test_blocks_loopback_and_metadata_ip_literal():
    # AUDIT 2026-08-02 — app sur réseau local : seules les cibles SSRF à haute
    # valeur restent bloquées côté éditeur (loopback + link-local metadata).
    for bad in ["http://127.0.0.1:6379/x", "http://169.254.169.254/latest/meta-data",
                "http://[::1]/r.git", "http://0.0.0.0/r.git"]:
        with pytest.raises(HTTPException):
            _validate_git_url(bad)


def test_allows_private_lan_ip_literal():
    # Le dépôt du propriétaire sur le LAN (ex. 10.1.2.3/24) DOIT être
    # clonable/rebasable depuis l'éditeur — ne doit PAS lever.
    for ok in ["http://10.1.2.3/repo.git", "http://10.0.0.5/repo.git",
               "https://172.16.4.4/r.git"]:
        _validate_git_url(ok)


def test_blocks_dns_rebinding_to_loopback(monkeypatch):
    # hostname public à la validation, mais résout vers loopback → bloqué.
    monkeypatch.setattr(socket, "getaddrinfo",
                        lambda *a, **k: [(2, 1, 6, "", ("127.0.0.1", 443))])
    with pytest.raises(HTTPException):
        _validate_git_url("https://evil.example.com/repo.git")


def test_allows_public_host(monkeypatch):
    # résout vers une IP publique → autorisé (pas d'exception).
    monkeypatch.setattr(socket, "getaddrinfo",
                        lambda *a, **k: [(2, 1, 6, "", ("140.82.121.4", 443))])
    _validate_git_url("https://github.com/user/repo.git")


def test_blocks_unresolvable_host(monkeypatch):
    def _boom(*a, **k):
        raise socket.gaierror("nope")
    monkeypatch.setattr(socket, "getaddrinfo", _boom)
    with pytest.raises(HTTPException):
        _validate_git_url("https://does-not-resolve.example/repo.git")


# ── SSRF sur les REDIRECTIONS des appels d'API git (_http.http_json) ──────────

def test_redirect_handler_bloque_saut_vers_ip_interne():
    """Régression 2026-07-18 : urllib suivait les 30x sans re-valider la cible
    → un endpoint git pouvait rediriger vers 169.254.169.254 (métadonnées
    cloud) / LAN. Le handler re-valide chaque saut et REFUSE."""
    import urllib.error

    from shared_infra.git._http import _SsrfValidatingRedirectHandler

    h = _SsrfValidatingRedirectHandler(allow_hosts=("api.example.com",),
                                       allow_schemes=("https",))
    req = urllib.request.Request("https://api.example.com/x",
                                 headers={"Authorization": "Bearer secret"})
    with pytest.raises(urllib.error.HTTPError):
        h.redirect_request(req, io.BytesIO(b""), 302, "Found", {},
                           "http://169.254.169.254/latest/meta-data/")


def test_redirect_handler_autorise_meme_host_allowliste():
    """Une redirection vers le host ENREGISTRÉ (self-hosted) reste suivie."""
    from shared_infra.git._http import _SsrfValidatingRedirectHandler

    h = _SsrfValidatingRedirectHandler(allow_hosts=("git.lan:3000",),
                                       allow_schemes=("https",))
    req = urllib.request.Request("http://git.lan:3000/a")
    new = h.redirect_request(req, io.BytesIO(b""), 302, "Found", {},
                             "http://git.lan:3000/b")
    assert new is not None


def test_redirect_handler_retire_authorization_cross_host(monkeypatch):
    """Le header Authorization ne DOIT pas fuiter vers un host différent."""
    # Neutralise la validation SSRF pour ISOLER le strip d'Authorization
    # (le handler importe block_remote_url_reason depuis ssrf à chaque appel).
    import shared_infra.git.ssrf as _ssrf
    monkeypatch.setattr(_ssrf, "block_remote_url_reason", lambda *a, **k: None)
    from shared_infra.git._http import _SsrfValidatingRedirectHandler

    h = _SsrfValidatingRedirectHandler(allow_hosts=(), allow_schemes=("https", "http"))
    req = urllib.request.Request("https://a.example.com/x",
                                 headers={"Authorization": "Bearer secret"})
    new = h.redirect_request(req, io.BytesIO(b""), 302, "Found", {},
                             "https://b.example.com/y")
    assert new is not None
    # Ni dans headers ni dans unredirected_hdrs.
    combined = {**getattr(new, "headers", {}), **getattr(new, "unredirected_hdrs", {})}
    assert not any(k.lower() == "authorization" for k in combined)


# ── AUDIT 2026-08-02 — schémas de remote git alignés (http autorisé) ──────────
# Les outils git de l'agent forçaient https-only : un remote HTTP (serveur
# interne, miroir public en clair) clonable via l'UI se prenait un
# ``blocked_remote`` au fetch/push. On autorise désormais http/https/git via
# ``GIT_REMOTE_SCHEMES``, la protection SSRF restant portée par les checks IP.

def test_git_remote_schemes_allow_http_public_host(monkeypatch):
    from shared_infra.git.ssrf import GIT_REMOTE_SCHEMES, block_remote_url_reason
    monkeypatch.setattr(socket, "getaddrinfo",
                        lambda *a, **k: [(2, 1, 6, "", ("140.82.121.4", 80))])
    assert block_remote_url_reason("http://git.example.com/u/r.git",
                                   allow_schemes=GIT_REMOTE_SCHEMES) is None


def test_git_remote_schemes_still_block_internal_http():
    from shared_infra.git.ssrf import GIT_REMOTE_SCHEMES, block_remote_url_reason
    for bad in ["http://169.254.169.254/meta.git", "http://10.0.0.5/r.git",
                "http://localhost/r.git", "http://gitea.internal/r.git"]:
        assert block_remote_url_reason(bad, allow_schemes=GIT_REMOTE_SCHEMES), bad


def test_git_remote_schemes_still_block_file_and_ssh():
    from shared_infra.git.ssrf import GIT_REMOTE_SCHEMES, block_remote_url_reason
    for bad in ["file:///etc/passwd", "ssh://host/repo", "ftp://host/r"]:
        assert block_remote_url_reason(bad, allow_schemes=GIT_REMOTE_SCHEMES), bad


# ── AUDIT 2026-08-02 — mode critical_only (outils git de l'agent) ─────────────
# On ne bloque QUE loopback + link-local (metadata cloud) ; le LAN privé et les
# hosts internes sont autorisés (serveur git self-hosted légitime du proprio).

def test_critical_only_allows_private_lan():
    from shared_infra.git.ssrf import GIT_REMOTE_SCHEMES, block_remote_url_reason
    for ok in ["http://10.0.0.5/r.git", "http://10.168.1.10/r.git",
               "https://172.16.4.4/r.git"]:
        assert block_remote_url_reason(ok, allow_schemes=GIT_REMOTE_SCHEMES,
                                       critical_only=True) is None, ok


def test_critical_only_still_blocks_metadata_and_loopback():
    from shared_infra.git.ssrf import GIT_REMOTE_SCHEMES, block_remote_url_reason
    for bad in ["http://169.254.169.254/latest/meta-data", "http://127.0.0.1:6379/x",
                "http://localhost/r.git", "http://[::1]/r.git", "http://0.0.0.0/r.git"]:
        assert block_remote_url_reason(bad, allow_schemes=GIT_REMOTE_SCHEMES,
                                       critical_only=True), bad


def test_critical_only_internal_hostname_resolving_private_is_allowed(monkeypatch):
    from shared_infra.git.ssrf import GIT_REMOTE_SCHEMES, block_remote_url_reason
    monkeypatch.setattr(socket, "getaddrinfo",
                        lambda *a, **k: [(2, 1, 6, "", ("10.1.2.3", 80))])
    assert block_remote_url_reason("http://gitea.internal/u/r.git",
                                   allow_schemes=GIT_REMOTE_SCHEMES,
                                   critical_only=True) is None


def test_critical_only_dns_rebind_to_loopback_still_blocked(monkeypatch):
    from shared_infra.git.ssrf import GIT_REMOTE_SCHEMES, block_remote_url_reason
    monkeypatch.setattr(socket, "getaddrinfo",
                        lambda *a, **k: [(2, 1, 6, "", ("127.0.0.1", 80))])
    assert block_remote_url_reason("http://sneaky.example/r.git",
                                   allow_schemes=GIT_REMOTE_SCHEMES,
                                   critical_only=True)


def test_git_tools_clone_reason_uses_critical_only():
    # Le wrapper des outils agent autorise le LAN privé mais bloque le metadata.
    from llm_core.tools.git_tools import _clone_url_block_reason
    assert _clone_url_block_reason("http://10.0.0.5/r.git") is None
    assert _clone_url_block_reason("https://169.254.169.254/meta.git")
