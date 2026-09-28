# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_gunicorn_bind.py — bind par défaut des confs gunicorn.

Les confs (``server/gunicorn_conf.py`` / ``gunicorn_admin_conf.py``) sont
ré-exécutées par le master gunicorn à chaque SIGHUP : le host par défaut suit
``config.json`` — HTTPS → 127.0.0.1 ; sinon ``security.listen`` (« local » →
127.0.0.1, « lan » → 0.0.0.0, clé absente → 0.0.0.0 pour les installations
d'avant le réglage) ; config absente ou illisible → 127.0.0.1. L'env ``BIND``
reste prioritaire (break-glass).

On exécute les fichiers avec ``runpy.run_path`` (exactement ce que fait
gunicorn) et on inspecte le global ``bind`` résultant.
"""
from __future__ import annotations

import json
import runpy
from pathlib import Path

import pytest

_SERVER_DIR = Path(__file__).resolve().parents[2] / "server"
_CONFS = [
    ("gunicorn_conf.py",       "8001"),
    ("gunicorn_admin_conf.py", "8002"),
]


def _run_conf(name: str) -> dict:
    return runpy.run_path(str(_SERVER_DIR / name))


@pytest.mark.parametrize("conf,port", _CONFS)
def test_default_bind_follows_https_toggle(tmp_path, monkeypatch, conf, port):
    monkeypatch.delenv("BIND", raising=False)
    p = tmp_path / "config.json"
    monkeypatch.setenv("APP_CONFIG_PATH", str(p))

    # HTTPS off, pas de security.listen → accès direct historique.
    p.write_text(json.dumps({"security": {"https": {"enabled": False}}}), encoding="utf-8")
    assert _run_conf(conf)["bind"] == f"0.0.0.0:{port}"

    # HTTPS on → loopback, Caddy seul point d'entrée.
    p.write_text(json.dumps({"security": {"https": {"enabled": True}}}), encoding="utf-8")
    assert _run_conf(conf)["bind"] == f"127.0.0.1:{port}"


@pytest.mark.parametrize("conf,port", _CONFS)
@pytest.mark.parametrize("listen,host", [("local", "127.0.0.1"), ("lan", "0.0.0.0"),
                                         ("LAN", "0.0.0.0"), ("autre", "127.0.0.1")])
def test_listen_setting(tmp_path, monkeypatch, conf, port, listen, host):
    """``security.listen`` hors HTTPS ; valeur inconnue → loopback."""
    monkeypatch.delenv("BIND", raising=False)
    p = tmp_path / "config.json"
    p.write_text(json.dumps({"security": {"listen": listen}}), encoding="utf-8")
    monkeypatch.setenv("APP_CONFIG_PATH", str(p))
    assert _run_conf(conf)["bind"] == f"{host}:{port}"


@pytest.mark.parametrize("conf,port", _CONFS)
def test_https_wins_over_listen_lan(tmp_path, monkeypatch, conf, port):
    monkeypatch.delenv("BIND", raising=False)
    p = tmp_path / "config.json"
    p.write_text(json.dumps({"security": {"listen": "lan", "https": {"enabled": True}}}),
                 encoding="utf-8")
    monkeypatch.setenv("APP_CONFIG_PATH", str(p))
    assert _run_conf(conf)["bind"] == f"127.0.0.1:{port}"


@pytest.mark.parametrize("conf,port", _CONFS)
def test_existing_config_without_listen_keeps_lan(tmp_path, monkeypatch, conf, port):
    """Config d'avant le réglage (aucune section security) : 0.0.0.0, pour ne
    pas couper l'accès réseau d'une installation existante à la mise à jour."""
    monkeypatch.delenv("BIND", raising=False)
    p = tmp_path / "config.json"
    p.write_text("{}", encoding="utf-8")
    monkeypatch.setenv("APP_CONFIG_PATH", str(p))
    assert _run_conf(conf)["bind"] == f"0.0.0.0:{port}"


@pytest.mark.parametrize("conf,port", _CONFS)
def test_bind_env_wins_over_toggle(tmp_path, monkeypatch, conf, port):
    """Break-glass : BIND env prioritaire même quand le toggle dit loopback."""
    p = tmp_path / "config.json"
    p.write_text(json.dumps({"security": {"https": {"enabled": True}}}), encoding="utf-8")
    monkeypatch.setenv("APP_CONFIG_PATH", str(p))
    monkeypatch.setenv("BIND", "0.0.0.0:9999")
    assert _run_conf(conf)["bind"] == "0.0.0.0:9999"


@pytest.mark.parametrize("conf,port", _CONFS)
@pytest.mark.parametrize("content", ["{not json", "[]"])
def test_unreadable_config_fails_closed(tmp_path, monkeypatch, conf, port, content):
    """Config PRÉSENTE mais corrompue → on ignore si HTTPS est actif :
    boucle locale (audit 2026-09-22, H2 — le fail-open exposait app et admin
    sur le LAN). Break-glass : BIND."""
    monkeypatch.delenv("BIND", raising=False)
    p = tmp_path / "config.json"
    p.write_text(content, encoding="utf-8")
    monkeypatch.setenv("APP_CONFIG_PATH", str(p))
    assert _run_conf(conf)["bind"] == f"127.0.0.1:{port}"


@pytest.mark.parametrize("conf,port", _CONFS)
def test_config_absente_loopback(tmp_path, monkeypatch, conf, port):
    """Aucun config.json (installation neuve, pas encore configurée) →
    loopback : sûr par défaut."""
    monkeypatch.delenv("BIND", raising=False)
    monkeypatch.setenv("APP_CONFIG_PATH", str(tmp_path / "config.json"))
    assert _run_conf(conf)["bind"] == f"127.0.0.1:{port}"


@pytest.mark.parametrize("conf,port", _CONFS)
def test_bind_env_wins_over_listen_local(tmp_path, monkeypatch, conf, port):
    p = tmp_path / "config.json"
    p.write_text(json.dumps({"security": {"listen": "local"}}), encoding="utf-8")
    monkeypatch.setenv("APP_CONFIG_PATH", str(p))
    monkeypatch.setenv("BIND", "0.0.0.0:9999")
    assert _run_conf(conf)["bind"] == "0.0.0.0:9999"


# ── Même règle dans ./elpis › _bind_default (bind du RAG) ────────────────
_ELPIS = Path(__file__).resolve().parents[2] / "elpis"


def _launcher_bind(tmp_path, content) -> str:
    """Exécute le script Python embarqué dans ``_bind_default``."""
    import os
    import re
    import subprocess
    import sys
    src = _ELPIS.read_text(encoding="utf-8")
    block = src[src.index("_bind_default() {"):]
    py = re.search(r"<<'PYEOF'[^\n]*\n(.*?)\nPYEOF", block, re.S).group(1)
    p = tmp_path / "config.json"
    if content is not None:
        p.write_text(content, encoding="utf-8")
    env = dict(os.environ, APP_CONFIG_PATH=str(p))
    return subprocess.run([sys.executable, "-c", py], env=env, capture_output=True,
                          text=True, check=True).stdout.strip()


@pytest.mark.parametrize("content,host", [
    (None, "127.0.0.1"),
    ("{not json", "127.0.0.1"),
    ("{}", "0.0.0.0"),
    (json.dumps({"security": {"listen": "local"}}), "127.0.0.1"),
    (json.dumps({"security": {"listen": "lan"}}), "0.0.0.0"),
    (json.dumps({"security": {"listen": "lan", "https": {"enabled": True}}}), "127.0.0.1"),
])
def test_launcher_matches_bind_host(tmp_path, monkeypatch, content, host):
    """Le RAG (``./elpis``) et les confs gunicorn doivent retenir le même
    hôte : sinon un port interne s'ouvre au réseau quand l'app est locale."""
    assert _launcher_bind(tmp_path, content) == host
    monkeypatch.setenv("APP_CONFIG_PATH", str(tmp_path / "config.json"))
    assert runpy.run_path(str(_SERVER_DIR / "_bind_host.py"))["default_host"]() == host
