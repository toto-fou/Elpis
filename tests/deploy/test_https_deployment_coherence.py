# SPDX-License-Identifier: MIT
"""tests/deploy/test_https_deployment_coherence.py — le mode HTTPS tient
sur quatre fichiers qui doivent rester d'accord.

Le Caddyfile, la règle d'écoute du core, le script de lancement et `config.json`
décrivent la MÊME topologie, chacun de son côté :

    navigateur ─https─▶ Caddy :443 / :8443 ─http 127.0.0.1─▶ :8001 / :8002 (l'extracteur :8000 reste local)

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


def test_caddy_fronts_exactly_main_and_admin():
    assert _caddy_sites() == {443: 8001, 8443: 8002}
    assert ":8444" not in (REPO / "deploy" / "caddy" / "Caddyfile.acme.template").read_text(encoding="utf-8")


def test_rag_is_launched_on_its_loopback_port():
    src = START_SH.read_text(encoding="utf-8")
    assert "RAG_PORT=8000" in src and 8000 not in _caddy_sites().values()
    assert '--port "$RAG_PORT"' in src


def test_launcher_reads_the_same_config_file_as_gunicorn(tmp_path):
    """Le bind du RAG était calculé depuis un ``shared_infra/config.json`` EN
    DUR alors que les confs gunicorn honorent ``APP_CONFIG_PATH`` : sur un
    déploiement qui pose la variable (config d'instance hors du dépôt), le RAG
    partait sur 0.0.0.0 pendant que main et admin se rabattaient en loopback —
    un port interne ouvert en clair au LAN, mode HTTPS actif, aucun signal.
    Le lanceur demande l'écoute au core (``exploitation.mjs lanceur ecoute``),
    qui lit ``APP_CONFIG_PATH``, sinon le ``config.json`` du dossier courant
    (la racine du dépôt : ``./elpis`` s'y place)."""
    import os
    import shutil
    import subprocess
    src = START_SH.read_text(encoding="utf-8")
    start = src.index("_bind_default() {")
    assert 'lanceur ecoute' in src[start:src.index("\n}\n", start)]
    tsx = REPO / "node_modules" / ".bin" / "tsx"
    node = shutil.which("node")
    version = subprocess.run([node, "--version"], capture_output=True, text=True).stdout if node else ""
    if not tsx.exists() or not version.startswith("v24."):
        return
    (tmp_path / "config.json").write_text(json.dumps({"security": {"listen": "lan"}}), encoding="utf-8")
    (tmp_path / "instance.json").write_text(json.dumps({"security": {"listen": "local"}}), encoding="utf-8")

    def ecoute(**env: str) -> str:
        e = {k: v for k, v in os.environ.items() if k != "APP_CONFIG_PATH"} | env
        return subprocess.run([str(tsx), str(REPO / "apps/core/src/exploitation.ts"), "lanceur", "ecoute"], env=e,
                              cwd=str(tmp_path), capture_output=True, text=True, check=True).stdout.strip()
    assert ecoute() == "0.0.0.0"
    assert ecoute(APP_CONFIG_PATH=str(tmp_path / "instance.json")) == "127.0.0.1"


def test_rag_bind_stays_local_whatever_the_toggle():
    src = START_SH.read_text(encoding="utf-8")
    assert '--host "${RAG_HOST:-127.0.0.1}"' in src


def test_caddyfile_carries_no_hsts():
    """HSTS mémorisé = retour en HTTP direct impossible depuis la console.
    Le toggle est réversible par conception ; ne pas « durcir »."""
    text = CADDYFILE.read_text(encoding="utf-8").lower()
    assert "strict-transport-security" not in text
    assert "redir https://{host}{uri} 302" in CADDYFILE.read_text(encoding="utf-8")
