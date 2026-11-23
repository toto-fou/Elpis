# SPDX-License-Identifier: MIT
"""tests/deploy/test_installeur_depot_ferme_2026_11_23.py — install.sh, première installation : un dépôt que les comptes des services ne traversent pas ou ne lisent pas est signalé avant la moindre installation, avec la commande qui le déplace (ou l'ouvre) ; arrêt avec --service, question si le démarrage n'est pas choisi."""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

from tests.deploy.test_installeur_assistant_2026_09_27 import _drive

# En root, une copie du dépôt à root arrête install.sh plus tôt (« Lancé en root… ») : rien à vérifier ici.
pytestmark = pytest.mark.skipif(os.geteuid() == 0, reason="lancé en root")

REPO = Path(__file__).resolve().parents[2]
FICHIERS = ("install.sh", "elpis", "deploy/qdrant/qdrant.env", "deploy/node/node.env", "deploy/prerequis-apt.sh",
            "deploy/prerequis-apt.txt", "deploy/droits.py")
SANS = ("--skip-system", "--no-sandbox", "--no-browser", "--no-office", "--no-caddy")
ARRET = "Un compte par service impossible d'ici"


def _cible() -> tuple[str, str]:
    """(préfixe, cible) de la commande, comme install.sh selon /opt/elpis sur cet hôte."""
    opt = Path("/opt/elpis")
    if opt.is_dir() and not any(opt.iterdir()):
        return "sudo rmdir /opt/elpis && ", "/opt/elpis"
    return "", "/opt/<dossier libre>" if opt.exists() else "/opt/elpis"


def _depot(dossier: Path) -> Path:
    """Copie minimale du dépôt pour install.sh, dans DOSSIER/elpis."""
    racine = dossier / "elpis"
    for f in FICHIERS:
        (racine / f).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(REPO / f, racine / f)
    return racine


def _env(**plus: str) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k != "ELPIS_COMPTE_UNIQUE"}
    return {**env, **plus}


def _install(racine: Path, *args: str, **env: str) -> subprocess.CompletedProcess:
    return subprocess.run(["bash", str(racine / "install.sh"), "--yes", *SANS, *args], capture_output=True, text=True,
                          timeout=120, stdin=subprocess.DEVNULL, env=_env(**env))


def _faux_sudo(dossier: Path) -> str:
    """PATH avec un sudo qui accepte -n et -v et lance le reste sans changer de compte."""
    faux = dossier / "faux-bin"
    faux.mkdir()
    (faux / "sudo").write_text('#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -n|-v) shift ;; *) break ;; esac; done\n'
                               '[ $# -eq 0 ] && exit 0\nexec "$@"\n', encoding="utf-8")
    (faux / "sudo").chmod(0o755)
    return f"{faux}:{os.environ.get('PATH', '/usr/bin:/bin')}"


# Dossier personnel fermé (0700) : arrêt, avec la commande qui déplace le dépôt vers /opt/elpis et les deux autres voies.
def test_dossier_personnel_ferme_arrete_avec_la_commande_qui_deplace_le_depot(tmp_path):
    maison = tmp_path / "maison"
    racine = _depot(maison)
    maison.chmod(0o700)
    r = _install(racine, "--dry-run", "--service")
    pre, cible = _cible()
    assert r.returncode == 1, r.stdout + r.stderr
    assert f"{ARRET} : {maison} n'est pas accessible aux comptes des services" in r.stderr, r.stderr
    assert f"relancez ainsi : {pre}sudo mv '{racine}' {cible} && cd {cible} && ./install.sh (mêmes options)" in r.stderr
    assert "./install.sh --start (sans service)" in r.stderr and "ELPIS_COMPTE_UNIQUE=1 ./install.sh" in r.stderr


# venv/ laissé par une installation interrompue : ses scripts gardent l'ancien chemin, la commande le retire d'abord.
def test_venv_laisse_retire_avant_le_deplacement(tmp_path):
    maison = tmp_path / "maison"
    racine = _depot(maison)
    (racine / "venv/bin").mkdir(parents=True)
    maison.chmod(0o700)
    r = _install(racine, "--dry-run", "--service")
    assert f"sudo rm -rf '{racine}/venv' && " in r.stderr, r.stderr


# Dépôt lui-même fermé (clone sous umask 077) : le déplacer ne servirait à rien, la commande l'ouvre aux autres comptes.
def test_depot_lui_meme_ferme_rendu_lisible(tmp_path):
    racine = _depot(tmp_path)
    racine.chmod(0o700)
    r = _install(racine, "--dry-run", "--service")
    assert r.returncode == 1 and f"chmod -R o+rX '{racine}' && cd '{racine}' && ./install.sh" in r.stderr, r.stderr
    assert " mv " not in r.stderr


# Dossiers traversables mais code illisible (clone sous umask 077 dans un /opt/elpis 0755) : ouvert aux autres comptes lui aussi.
def test_code_illisible_rendu_lisible(tmp_ouvert):
    racine = _depot(tmp_ouvert)
    (racine / "elpis").chmod(0o700)
    r = _install(racine, "--dry-run", "--service")
    assert r.returncode == 1 and f"chmod -R o+rX '{racine}'" in r.stderr, r.stderr


# Témoin : un dépôt que tous les comptes traversent et lisent n'est pas arrêté.
def test_depot_ouvert_sans_arret(tmp_ouvert):
    r = _install(_depot(tmp_ouvert), "--dry-run", "--service")
    assert ARRET not in r.stdout + r.stderr


# Pas d'arrêt hors d'une première installation en services : lancement sans service, un seul compte demandé, configuration en place.
@pytest.mark.parametrize("cas", ["start", "compte_unique", "configuration"])
def test_aucun_arret_hors_premiere_installation_en_services(tmp_path, cas):
    maison = tmp_path / "maison"
    racine = _depot(maison)
    if cas == "configuration":
        (racine / "config.json").write_text("{}\n", encoding="utf-8")
    maison.chmod(0o700)
    env = {"ELPIS_COMPTE_UNIQUE": "1"} if cas == "compte_unique" else {}
    r = _install(racine, "--dry-run", "--start" if cas == "start" else "--service", **env)
    assert ARRET not in r.stdout + r.stderr
    if cas == "compte_unique":
        assert "démarrage         : service (un seul compte : ELPIS_COMPTE_UNIQUE=1)" in r.stdout


# Installation réelle (sudo simulé) : arrêt avant la moindre installation, ni venv/ ni node/ ; sudo ./install.sh garde « sudo » dans la commande.
def test_installation_reelle_arretee_avant_toute_installation(tmp_path):
    maison = tmp_path / "maison"
    racine = _depot(maison)
    maison.chmod(0o700)
    r = _install(racine, "--service", PATH=_faux_sudo(tmp_path))
    sortie = r.stdout + r.stderr   # journal de l'installation : les deux flux passent par son filtre
    assert r.returncode == 1 and ARRET in sortie and "sudo mv " in sortie, sortie
    assert not (racine / "venv").exists() and not (racine / "node").exists()
    texte = (REPO / "install.sh").read_text(encoding="utf-8")
    assert 'ELPIS_COMPTE_UNIQUE="${ELPIS_COMPTE_UNIQUE:-0}" "$ROOT/elpis" service install' in texte
    assert "grep -qsx 'Environment=\"ELPIS_COMPTES=repli\"' /etc/systemd/system/elpis-main.service" in texte


# Démarrage pas encore choisi, dans un terminal : la question vient avant l'assistant ; Entrée (« non ») arrête avec la commande.
@pytest.mark.skipif(shutil.which("systemctl") is None, reason="sans systemd, les services ne sont pas proposés")
def test_question_avant_l_assistant_quand_le_demarrage_n_est_pas_choisi(tmp_path):
    maison = tmp_path / "maison"
    racine = _depot(maison)
    maison.chmod(0o700)
    env = {"PATH": _faux_sudo(tmp_path), "TERM": "xterm", "LANG": "C.UTF-8"}
    ecran, code = _drive(["bash", str(racine / "install.sh"), "--plain", *SANS], [b"\r"], env)
    assert code == 1, ecran[-2000:]
    assert "Continuer ici (sans service, ou services sous un seul compte) ?" in ecran and ARRET in ecran, ecran[-2000:]
    assert not (racine / "venv").exists()
