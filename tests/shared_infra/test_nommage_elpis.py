# SPDX-License-Identifier: MIT
"""Noms Elpis : variables ``ELPIS_*``, en-tête ``x-elpis-token``, conteneurs
``elpis-sb-*``, étiquettes ``elpis.*``."""
from __future__ import annotations

import asyncio


def test_env_lit_la_variable(monkeypatch):
    from shared_infra.env_compat import env
    monkeypatch.delenv("ELPIS_ZZ_TEST", raising=False)
    assert env("ELPIS_ZZ_TEST", "defaut") == "defaut"
    monkeypatch.setenv("ELPIS_ZZ_TEST", "valeur")
    assert env("ELPIS_ZZ_TEST", "defaut") == "valeur"
    # une valeur vide est un choix explicite
    monkeypatch.setenv("ELPIS_ZZ_TEST", "")
    assert env("ELPIS_ZZ_TEST", "defaut") == ""


def test_config_reexporte_env():
    from shared_infra import config
    from shared_infra.env_compat import env
    assert config.env is env


def test_token_header():
    from shared_infra.env_compat import token_header
    assert token_header({"x-elpis-token": " pcr_a "}) == "pcr_a"
    assert token_header({"x-autre-token": "pcr_b"}) == ""
    assert token_header({}) == ""


def test_noms_et_etiquettes_du_sandbox():
    from shared_infra.sandbox import naming as n
    assert n.container_name("alice") == "elpis-sb-alice"
    assert n.label("user_id", 7) == "elpis.user_id=7"
    assert n.label_filter("user_id") == ["--filter", "label=elpis.user_id"]
    assert n.label_filter("user_id", 7) == ["--filter", "label=elpis.user_id=7"]
    assert n.label_tpl("netcfg") == '{{index .Config.Labels "elpis.netcfg"}}'
    assert n.label_tpl("username", ps=True) == '{{.Label "elpis.username"}}'


def test_config_sandbox_garde_l_image_configuree():
    from shared_infra.sandbox.executors._user_sandbox import SandboxAdminConfig
    assert SandboxAdminConfig.from_dict({"image": " maison/sb:2 "}).image == "maison/sb:2"
    from shared_infra.sandbox.executors import DEFAULT_IMAGE
    assert SandboxAdminConfig.from_dict({}).image == DEFAULT_IMAGE
    assert DEFAULT_IMAGE.startswith("elpis/sandbox:")


def test_image_loader_archive_elpis():
    from shared_infra.sandbox.executors import _image_loader as il
    names = {p.name for p in il._candidate_tar_paths("elpis/sandbox:1.7.0")}
    assert {"elpis-sandbox-1.7.0.tar.gz", "elpis-sandbox-1.7.0.tar"} <= names


class _FakeCLI:
    def __init__(self, existing):
        self.existing = set(existing)
        self.calls = []

    async def call(self, *args, timeout=None):
        self.calls.append(args)
        if args[:2] == ("container", "inspect") and args[2] in self.existing:
            return 0, f"cid|/{args[2]}|true|elpis/sandbox:1.7.0|2026-01-01".encode(), b""
        return 1, b"", b"No such container"


def test_status_conteneur_elpis():
    from shared_infra.sandbox.executors._user_sandbox import UserSandbox
    sb = UserSandbox.__new__(UserSandbox)
    sb.username = "alice"
    sb._cli = _FakeCLI({"elpis-sb-alice"})
    st = asyncio.run(sb.status())
    assert st.exists and st.running and st.container_name == "elpis-sb-alice"
    sb._cli = _FakeCLI(set())
    st = asyncio.run(sb.status())
    assert not st.exists
    assert not any(c[0] == "rename" for c in sb._cli.calls)


def test_marqueur_de_restauration(tmp_path):
    from shared_infra.sandbox import routes_snapshots as rs
    assert rs._restore_marker(tmp_path).name == ".elpis_restore_incomplete"


def test_image_livree_une_seule_version():
    """DEFAULT_IMAGE, le script de construction et l'étiquette du Dockerfile
    donnent la même version : sinon ./install.sh construit une image que
    l'app ne lance pas."""
    import re
    from pathlib import Path

    from shared_infra.sandbox.executors import DEFAULT_IMAGE
    racine = Path(__file__).resolve().parents[2] / "deploy" / "docker" / "sandbox"
    script = (racine / "build_offline.sh").read_text(encoding="utf-8")
    version = DEFAULT_IMAGE.rpartition(":")[2]
    assert re.search(r'^IMAGE="([^"]+)"', script, re.M).group(1) == DEFAULT_IMAGE
    assert re.search(r'^ARCHIVE="([^"]+)"', script, re.M).group(1) == f"elpis-sandbox-{version}.tar.gz"
    dockerfile = (racine / "Dockerfile").read_text(encoding="utf-8")
    assert re.search(r'image\.version="([^"]+)"', dockerfile).group(1) == version
