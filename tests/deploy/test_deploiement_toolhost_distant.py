# SPDX-License-Identifier: MIT
"""tests/deploy/test_deploiement_toolhost_distant.py — déploiement distant de l'hôte d'outils (deploy/toolhost) : unité de l'hôte TS valide, liées, ports cohérents avec toolhost.example.json ; copie du dépôt qui garde la configuration de la machine."""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
DEPLOY = REPO / "deploy" / "toolhost"


def _unite(nom: str) -> list[str]:
    return (DEPLOY / nom).read_text(encoding="utf-8").splitlines()


def test_hote_ts_relance_sur_75_sans_elpis_tools():
    hote = _unite("elpis-toolhost.service")
    assert "ExecStart=/opt/elpis/node/bin/node --enable-source-maps --use-system-ca /opt/elpis/apps/toolhost/dist/main.mjs" in hote
    for attendue in ("After=network-online.target docker.service", "Wants=network-online.target",
                     "Environment=ELPIS_RACINE=/opt/elpis", "Environment=TOOLHOST_CONFIG=/opt/elpis/toolhost.json",
                     "Restart=always", "SuccessExitStatus=75", "TimeoutStopSec=30"):
        assert attendue in hote, attendue
    assert not any("elpis-tools" in ligne or "UPSTREAM" in ligne or "-m toolhost" in ligne for ligne in hote)
    assert not (DEPLOY / "elpis-tools.service").exists()
    exemple = json.loads((DEPLOY / "toolhost.example.json").read_text(encoding="utf-8"))
    assert "mcp_upstream" not in exemple


def test_installation_pose_node_le_bundle_et_l_unite_et_retire_elpis_tools():
    script = (DEPLOY / "install_toolhost.sh").read_text(encoding="utf-8")
    assert 'bash deploy/node/installer.sh node "${o[@]}"' in script
    assert 'bash deploy/node/installer.sh hote "${o[@]}"' in script
    assert "systemctl enable elpis-toolhost.service" in script
    assert "systemctl disable --now elpis-tools.service" in script and "rm -f /etc/systemd/system/elpis-tools.service" in script
    assert subprocess.run(["bash", "-n", str(DEPLOY / "install_toolhost.sh")], timeout=30).returncode == 0


@pytest.mark.skipif(shutil.which("systemd-analyze") is None, reason="systemd-analyze absent")
def test_unites_distantes_valides_pour_systemd(tmp_path):
    racine = tmp_path / "elpis"
    for chemin in ("node/bin/node", "venv/bin/python"):
        (racine / chemin).parent.mkdir(parents=True, exist_ok=True)
        (racine / chemin).write_text("#!/bin/sh\n", encoding="utf-8")
        (racine / chemin).chmod(0o755)
    dossier = tmp_path / "unites"
    dossier.mkdir()
    for nom in ("elpis-toolhost.service",):
        texte = (DEPLOY / nom).read_text(encoding="utf-8").replace("/opt/elpis", str(racine))
        (dossier / nom).write_text(texte, encoding="utf-8")
    v = subprocess.run(["systemd-analyze", "verify", "--man=no", "--recursive-errors=no",
                        *sorted(str(p) for p in dossier.iterdir())], capture_output=True, text=True, timeout=120)
    assert v.returncode == 0, v.stderr


@pytest.mark.skipif(shutil.which("rsync") is None, reason="rsync absent")
def test_copie_du_depot_garde_la_configuration_de_la_machine(tmp_path):
    """Relancé depuis une autre copie : toolhost.json, Caddyfile.toolhost, node/ et données restent ; le reste suit le dépôt."""
    script = (DEPLOY / "install_toolhost.sh").read_text(encoding="utf-8")
    fonction = re.search(r"^copier_depot\(\) \{\n.*?^\}\n", script, re.S | re.M)
    assert fonction is not None
    src, dest = tmp_path / "src", tmp_path / "dest"
    fichiers_src = {"deploy/a.txt": "neuf", "deploy/toolhost/toolhost.json": "modèle imbriqué", "toolhost.example.json": "{}"}
    fichiers_dest = {"toolhost.json": "conf de la machine", "Caddyfile.toolhost": "tls", "node/bin/node": "runtime",
                     "user_db/.local_mcp_token": "jeton", "venv/bin/python": "py", "vieux.txt": "périmé",
                     "deploy/a.txt": "ancien"}
    for racine, fichiers in ((src, fichiers_src), (dest, fichiers_dest)):
        for rel, texte in fichiers.items():
            (racine / rel).parent.mkdir(parents=True, exist_ok=True)
            (racine / rel).write_text(texte, encoding="utf-8")
    r = subprocess.run(["bash", "-c", f'set -euo pipefail\n{fonction[0]}copier_depot "$1" "$2"', "copie", str(src), str(dest)],
                       capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    lus = {p.relative_to(dest).as_posix(): p.read_text(encoding="utf-8") for p in dest.rglob("*") if p.is_file()}
    assert lus == {"toolhost.json": "conf de la machine", "Caddyfile.toolhost": "tls", "node/bin/node": "runtime",
                   "user_db/.local_mcp_token": "jeton", "venv/bin/python": "py", "deploy/a.txt": "neuf",
                   "deploy/toolhost/toolhost.json": "modèle imbriqué", "toolhost.example.json": "{}"}
