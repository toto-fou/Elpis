# SPDX-License-Identifier: MIT
"""Audit 2026-09-22 (H3) : le premier admin n'est plus offert au premier venu
du LAN — mot de passe libre en local direct seulement, sinon mot de passe
initial du fichier ``user_db/.bootstrap_admin``."""
from types import SimpleNamespace

import pytest

import shared_infra.accounts.routes_auth as ra
from shared_infra.security.local_request import is_direct_local


def _req(host, **headers):
    return SimpleNamespace(client=SimpleNamespace(host=host), headers=headers)


@pytest.fixture
def boot_file(tmp_path, monkeypatch):
    f = tmp_path / ".bootstrap_admin"
    monkeypatch.setattr(ra, "_bootstrap_file", lambda: f)
    return f


def test_local_direct():
    assert is_direct_local(_req("127.0.0.1"))
    assert is_direct_local(_req("::1"))
    assert not is_direct_local(_req("10.168.1.5"))
    assert not is_direct_local(_req("127.0.0.1", **{"x-forwarded-for": "10.0.0.2"}))


def test_lan_mot_de_passe_libre_refuse(boot_file):
    assert ra._bootstrap_mode(_req("10.168.1.5"), "nimportequoi") is None
    assert boot_file.exists() and (boot_file.stat().st_mode & 0o077) == 0


def test_lan_avec_mot_de_passe_initial(boot_file):
    ra._bootstrap_mode(_req("10.168.1.5"), "x")          # crée le fichier
    secret = boot_file.read_text().strip()
    assert ra._bootstrap_mode(_req("10.168.1.5"), secret) == "file"


def test_proxy_local_traite_comme_lan(boot_file):
    r = _req("127.0.0.1", **{"x-forwarded-for": "10.168.1.5"})
    assert ra._bootstrap_mode(r, "nimportequoi") is None


def test_machine_locale_mot_de_passe_libre(boot_file):
    assert ra._bootstrap_mode(_req("127.0.0.1"), "choisi") == "local"
