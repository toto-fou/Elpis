# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_https_deployment_coherence.py — le mode HTTPS tient
sur quatre fichiers qui doivent rester d'accord.

Le Caddyfile, les confs gunicorn, le script de lancement et `config.json`
décrivent la MÊME topologie, chacun de son côté :

    navigateur ─https─▶ Caddy :443 / :8443 / :8444 ─http 127.0.0.1─▶ :8001 / :8002 / :8000

Un désaccord ne casse rien tout de suite — il crée un port qui écoute sans
frontal devant, ou une garde anti-lockout qui sonde le mauvais port et refuse
(ou pire, autorise) la bascule. C'est exactement la forme de la panne qui a
exposé l'app en clair sur le LAN : personne ne mentait, les fichiers ne
parlaient simplement plus du même déploiement.

On verrouille donc ici les accords transverses.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CADDYFILE = REPO / "deploy" / "caddy" / "Caddyfile.template"
APP_PY = REPO / "server" / "app.py"
START_SH = REPO / "elpis"


def _caddy_sites() -> dict[int, int]:
    """``{port TLS: port upstream}`` déclaré par le Caddyfile (hors site :80)."""
    text = CADDYFILE.read_text(encoding="utf-8")
    sites: dict[int, int] = {}
    for m in re.finditer(r"^:(\d+) \{$(.*?)^\}$", text, re.S | re.M):
        listen = int(m.group(1))
        if listen == 80:
            continue
        up = re.search(r"reverse_proxy 127\.0\.0\.1:(\d+)", m.group(2))
        assert up, f"site :{listen} sans reverse_proxy loopback"
        sites[listen] = int(up.group(1))
    return sites


def _conf_port(name: str) -> int:
    """Port par défaut d'une conf gunicorn, sans exécuter tout le fichier."""
    src = (REPO / "server" / name).read_text(encoding="utf-8")
    m = re.search(r'bind = os\.environ\.get\("BIND", f"\{_default_host\}:(\d+)"\)', src)
    assert m, f"{name} : la ligne de bind n'a plus la forme attendue"
    return int(m.group(1))


def test_caddy_fronts_exactly_the_three_services():
    assert _caddy_sites() == {443: 8001, 8443: 8002, 8444: 8000}


def test_config_default_ports_match_the_caddyfile(tmp_path, monkeypatch):
    """``https_ports()`` sert la garde anti-lockout du toggle (elle sonde ces
    ports avant de couper l'accès direct) et la synthèse des URLs publiques.
    Désaligné, le toggle refuserait d'activer — ou activerait à tort."""
    import shared_infra.config as cfg
    p = tmp_path / "config.json"
    p.write_text("{}", encoding="utf-8")       # aucune section → défauts purs
    monkeypatch.setattr(cfg, "CONFIG_JSON_PATH", p)

    defaults = cfg.https_ports()
    listen = sorted(_caddy_sites())
    assert [defaults["main"], defaults["admin"], defaults["rag"]] == listen


def test_admin_toggle_and_config_agree_on_the_default_ports(tmp_path, monkeypatch):
    """``admin/security.py`` porte sa PROPRE copie des défauts (lecture d'une
    config déjà en main). Les deux doivent rester identiques."""
    import shared_infra.config as cfg
    import shared_infra.routes.admin.security as sec
    p = tmp_path / "config.json"
    p.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(cfg, "CONFIG_JSON_PATH", p)
    assert sec._https_cfg_ports({}) == cfg.https_ports()


def test_gunicorn_ports_match_the_caddy_upstreams():
    caddy = _caddy_sites()
    assert _conf_port("gunicorn_conf.py") == caddy[443]
    assert _conf_port("gunicorn_admin_conf.py") == caddy[8443]


def test_rag_is_launched_on_the_port_caddy_proxies():
    src = START_SH.read_text(encoding="utf-8")
    assert f"RAG_PORT={_caddy_sites()[8444]}" in src
    assert '--port "$RAG_PORT"' in src


def test_launcher_reads_the_same_config_file_as_gunicorn():
    """Le bind du RAG était calculé depuis un ``shared_infra/config.json`` EN
    DUR alors que les confs gunicorn honorent ``APP_CONFIG_PATH`` : sur un
    déploiement qui pose la variable (config d'instance hors du dépôt), le RAG
    partait sur 0.0.0.0 pendant que main et admin se rabattaient en loopback —
    un port interne ouvert en clair au LAN, mode HTTPS actif, aucun signal."""
    src = START_SH.read_text(encoding="utf-8")
    start = src.index("_bind_default() {")
    bind_block = src[start:src.index("\n}\n", start)]
    assert "APP_CONFIG_PATH" in bind_block
    # …et le chemin en dur ne subsiste que comme repli de la variable. Il suit
    # le défaut de ``shared_infra.config`` : la racine du dépôt.
    assert 'os.environ.get("APP_CONFIG_PATH") or "config.json"' in bind_block


def test_rag_bind_follows_the_toggle():
    src = START_SH.read_text(encoding="utf-8")
    assert '--host "${RAG_HOST:-$BIND_DEFAULT}"' in src


def test_owned_config_paths_cover_the_https_mode():
    """Garde-fou sur le garde-fou : la liste de propriété est la barrière qui
    empêche l'éditeur de configuration de rouvrir les binds."""
    from shared_infra.routes.admin.config import _OWNED_PATHS
    assert ("security", "https") in _OWNED_PATHS
    assert ("security", "session", "https_only") in _OWNED_PATHS
    assert ("security", "session", "global_min_ts") in _OWNED_PATHS


def test_caddyfile_carries_no_hsts():
    """HSTS mémorisé = retour en HTTP direct impossible depuis la console.
    Le toggle est réversible par conception ; ne pas « durcir »."""
    text = CADDYFILE.read_text(encoding="utf-8").lower()
    assert "strict-transport-security" not in text
    assert "redir https://{host}{uri} 302" in CADDYFILE.read_text(encoding="utf-8")
