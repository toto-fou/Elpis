# SPDX-License-Identifier: MIT
"""tests/deploy/test_installeur_depot_ferme_2026_11_23.py — install.sh en services systemd : un dépôt que les comptes des services ne traversent pas arrête une première installation avant ses étapes, avec la commande qui le déplace (ou l'ouvre)."""
from __future__ import annotations

import os
import shutil
import stat
import subprocess
import tempfile
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
FICHIERS = ("install.sh", "deploy/qdrant/qdrant.env", "deploy/node/node.env", "deploy/prerequis-apt.sh",
            "deploy/prerequis-apt.txt", "deploy/droits.py")
SANS = ("--yes", "--skip-system", "--no-sandbox", "--no-browser", "--no-office", "--no-caddy")
ARRET = "Un compte par service impossible"
CIBLE = "/opt/<dossier libre>" if os.path.exists("/opt/elpis") else "/opt/elpis"


def _depot(dossier: Path) -> Path:
    """Copie minimale du dépôt pour install.sh, dans DOSSIER/elpis."""
    racine = dossier / "elpis"
    for f in FICHIERS:
        (racine / f).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(REPO / f, racine / f)
    return racine


def _install(racine: Path, *args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(["bash", str(racine / "install.sh"), *SANS, *args], capture_output=True, text=True,
                          timeout=120, stdin=subprocess.DEVNULL, env={**os.environ, **(env or {})})


# Dossier personnel fermé (0700) : arrêt avant toute étape, avec la commande qui déplace le dépôt vers /opt/elpis.
def test_dossier_personnel_ferme_arrete_avec_la_commande_qui_deplace_le_depot(tmp_path):
    maison = tmp_path / "maison"
    racine = _depot(maison)
    maison.chmod(0o700)
    r = _install(racine, "--dry-run", "--service")
    assert r.returncode == 1, r.stdout + r.stderr
    attendu = f"{'' if os.geteuid() == 0 else 'sudo '}mv '{racine}' {CIBLE} && cd {CIBLE} && ./install.sh"
    assert f"{ARRET} : {maison} est fermé aux autres comptes" in r.stderr and attendu in r.stderr, r.stderr
    assert "ELPIS_COMPTE_UNIQUE=1 ./install.sh" in r.stderr


# Dépôt lui-même fermé (clone sous umask 077) : le déplacer ne servirait à rien, la commande l'ouvre aux autres comptes.
def test_depot_lui_meme_ferme_rendu_lisible(tmp_path):
    racine = _depot(tmp_path)
    racine.chmod(0o700)
    r = _install(racine, "--dry-run", "--service")
    assert r.returncode == 1 and f"chmod -R o+rX '{racine}' && ./install.sh" in r.stderr, r.stderr
    assert " mv " not in r.stderr


# Pas d'arrêt hors d'une première installation en services : lancement sans service, un seul compte demandé, configuration en place.
@pytest.mark.parametrize("cas", ["start", "compte_unique", "configuration"])
def test_aucun_arret_hors_premiere_installation_en_services(tmp_path, cas):
    maison = tmp_path / "maison"
    racine = _depot(maison)
    if cas == "configuration":
        (racine / "config.json").write_text("{}\n", encoding="utf-8")
    maison.chmod(0o700)
    r = _install(racine, "--dry-run", "--start" if cas == "start" else "--service",
                 env={"ELPIS_COMPTE_UNIQUE": "1"} if cas == "compte_unique" else None)
    assert ARRET not in r.stdout + r.stderr


# Témoin : un dépôt que tous les comptes traversent n'est pas arrêté.
def test_depot_ouvert_sans_arret():
    base = Path(tempfile.mkdtemp(dir=tempfile.gettempdir()))
    try:
        base.chmod(0o755)
        if any(not p.stat().st_mode & stat.S_IXOTH for p in (base, *base.parents)):
            pytest.skip("dossier temporaire fermé aux autres comptes sur cet hôte")
        r = _install(_depot(base), "--dry-run", "--service")
        assert ARRET not in r.stdout + r.stderr
    finally:
        shutil.rmtree(base)


# Installation réelle (sudo simulé) : arrêt avant ses étapes, ni venv/ ni node/ ; ELPIS_COMPTE_UNIQUE suit jusqu'à service install.
def test_installation_reelle_arretee_avant_ses_etapes(tmp_path):
    faux = tmp_path / "faux-bin"
    faux.mkdir()
    (faux / "sudo").write_text('#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -n|-v) shift ;; *) break ;; esac; done\n'
                               '[ $# -eq 0 ] && exit 0\nexec "$@"\n', encoding="utf-8")
    (faux / "sudo").chmod(0o755)
    maison = tmp_path / "maison"
    racine = _depot(maison)
    maison.chmod(0o700)
    r = _install(racine, "--service", env={"PATH": f"{faux}:{os.environ.get('PATH', '/usr/bin:/bin')}"})
    assert r.returncode == 1 and ARRET in r.stdout + r.stderr, r.stdout + r.stderr
    assert not (racine / "venv").exists() and not (racine / "node").exists()
    texte = (REPO / "install.sh").read_text(encoding="utf-8")
    assert 'ELPIS_COMPTE_UNIQUE="${ELPIS_COMPTE_UNIQUE:-0}" "$ROOT/elpis" service install' in texte
