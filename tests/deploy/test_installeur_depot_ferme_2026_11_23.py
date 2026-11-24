# SPDX-License-Identifier: MIT
"""tests/deploy/test_installeur_depot_ferme_2026_11_23.py — install.sh, première installation : le mode d'abord (standard : un compte par service, dépôt déplacé dans le dossier de l'installation standard s'il le faut ; essai : sous ce compte), --standard qui déplace, --service qui s'arrête avant la moindre installation quand le dépôt est fermé aux comptes des services."""
from __future__ import annotations

import os
import pty
import select
import shutil
import subprocess
import time
from pathlib import Path

import pytest

from tests.deploy.test_installeur_racine_2026_11_22 import _fonctions_install

# En root, une copie du dépôt à root arrête install.sh plus tôt (« Lancé en root… ») : rien à vérifier ici.
pytestmark = pytest.mark.skipif(os.geteuid() == 0, reason="lancé en root")

REPO = Path(__file__).resolve().parents[2]
FICHIERS = ("install.sh", "elpis", "deploy/qdrant/qdrant.env", "deploy/node/node.env", "deploy/prerequis-apt.sh",
            "deploy/prerequis-apt.txt", "deploy/droits.py")
SANS = ("--skip-system", "--no-sandbox", "--no-browser", "--no-office", "--no-caddy")
ARRET = "Un compte par service impossible d'ici"
MODE = "Où et comment installer Elpis ?"
LANCER = "Lancer l'installation ?"


def _depot(dossier: Path) -> Path:
    """Copie minimale du dépôt pour install.sh, dans DOSSIER/elpis."""
    racine = dossier / "elpis"
    for f in FICHIERS:
        (racine / f).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(REPO / f, racine / f)
    return racine


def _env(**plus: str) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k not in ("ELPIS_COMPTE_UNIQUE", "ELPIS_DOSSIER_INSTALL")}
    return {**env, **plus}


def _install(racine: Path, *args: str, **env: str) -> subprocess.CompletedProcess:
    return subprocess.run(["bash", str(racine / "install.sh"), "--yes", *SANS, *args], capture_output=True, text=True,
                          timeout=120, stdin=subprocess.DEVNULL, env=_env(**env))


def _repondre(argv: list[str], env: dict[str, str], reponses: list[tuple[str, bytes]], delai: float = 90) -> tuple[str, int | None]:
    """Lance ARGV dans un pseudo-terminal ; à chaque QUESTION vue à l'écran (dans l'ordre), tape sa TOUCHE ; (écran, code de sortie)."""
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        # Chef de session intermédiaire : sa sortie enverrait SIGHUP au filtre du journal avant ses dernières lignes.
        os.execvp("bash", ["bash", "-c", '"$@"; c=$?; sleep 2; exit $c', "bash", *argv])
    ecran, vu, fin, code, attente = b"", 0, time.time() + delai, None, list(reponses)
    # Après la sortie de bash, le filtre du journal écrit encore ses dernières lignes : lecture prolongée, bornée.
    while time.time() < fin:
        if select.select([fd], [], [], 0.1)[0]:
            try:
                morceau = os.read(fd, 65536)
            except OSError:
                morceau = b""
            if not morceau:
                break
            ecran += morceau
        if attente and attente[0][0].encode() in ecran[vu:]:
            vu = ecran.index(attente[0][0].encode(), vu) + 1
            os.write(fd, attente.pop(0)[1])
        if code is None:
            fini, etat = os.waitpid(pid, os.WNOHANG)
            if fini:
                code, fin = os.waitstatus_to_exitcode(etat), min(fin, time.time() + 5)
    if code is None:
        os.kill(pid, 9)
        code = os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1])
    os.close(fd)
    return ecran.decode("utf-8", "replace"), code


def _faux_sudo(dossier: Path) -> str:
    """PATH avec un sudo qui accepte -n et -v et lance le reste sans changer de compte."""
    faux = dossier / "faux-bin"
    faux.mkdir(exist_ok=True)
    (faux / "sudo").write_text('#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -n|-v) shift ;; *) break ;; esac; done\n'
                               '[ $# -eq 0 ] && exit 0\nexec "$@"\n', encoding="utf-8")
    (faux / "sudo").chmod(0o755)
    return f"{faux}:{os.environ.get('PATH', '/usr/bin:/bin')}"


# --service seul, dossier personnel fermé (0700) : arrêt, avec --standard, qui déplace le dépôt, et les deux autres voies.
def test_service_dans_un_dossier_ferme_arrete_et_propose_standard(tmp_path):
    maison = tmp_path / "maison"
    racine = _depot(maison)
    maison.chmod(0o700)
    r = _install(racine, "--dry-run", "--service")
    assert r.returncode == 1, r.stdout + r.stderr
    assert f"{ARRET} : {maison} n'est pas accessible aux comptes des services" in r.stderr, r.stderr
    assert "relancez avec --standard au lieu de --service (mêmes options) : le dépôt est alors déplacé dans /opt/elpis" in r.stderr
    assert "./install.sh --start (sans service)" in r.stderr and "ELPIS_COMPTE_UNIQUE=1 ./install.sh" in r.stderr


# --standard, dossier fermé : pas d'arrêt, le dépôt serait déplacé (essai à blanc) ; le récapitulatif dit le dossier.
def test_standard_dans_un_dossier_ferme_deplacerait_le_depot(tmp_path):
    maison = tmp_path / "maison"
    racine = _depot(maison)
    maison.chmod(0o700)
    r = _install(racine, "--dry-run", "--standard", ELPIS_DOSSIER_INSTALL="/srv/essai-elpis")
    assert ARRET not in r.stdout + r.stderr, r.stdout + r.stderr
    assert f"Installation standard : le dépôt serait déplacé de {racine} vers /srv/essai-elpis" in r.stdout
    assert f"dossier           : {racine}" in r.stdout and "démarrage         : service" in r.stdout


# Dépôt lui-même fermé (clone sous umask 077) : le déplacer ne servirait à rien, la commande l'ouvre aux autres comptes.
@pytest.mark.parametrize("option", ["--service", "--standard"])
def test_depot_lui_meme_ferme_rendu_lisible(tmp_path, option):
    racine = _depot(tmp_path)
    racine.chmod(0o700)
    r = _install(racine, "--dry-run", option)
    assert r.returncode == 1 and f"chmod -R o+rX '{racine}' && cd '{racine}' && ./install.sh" in r.stderr, r.stderr
    assert "Installation standard :" not in r.stdout + r.stderr


# Dossiers traversables mais code illisible (clone sous umask 077 dans un /opt/elpis 0755) : ouvert aux autres comptes lui aussi.
def test_code_illisible_rendu_lisible(tmp_ouvert):
    racine = _depot(tmp_ouvert)
    (racine / "elpis").chmod(0o700)
    r = _install(racine, "--dry-run", "--service")
    assert r.returncode == 1 and f"chmod -R o+rX '{racine}'" in r.stderr, r.stderr


# Témoin : un dépôt que tous les comptes traversent et lisent n'est ni arrêté ni déplacé.
@pytest.mark.parametrize("option", ["--service", "--standard"])
def test_depot_ouvert_sur_place(tmp_ouvert, option):
    r = _install(_depot(tmp_ouvert), "--dry-run", option)
    assert ARRET not in r.stdout + r.stderr and "Installation standard :" not in r.stdout + r.stderr, r.stdout + r.stderr


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


# Installation réelle (sudo simulé), --service : arrêt avant la moindre installation, ni venv/ ni node/.
def test_installation_reelle_arretee_avant_toute_installation(tmp_path):
    maison = tmp_path / "maison"
    racine = _depot(maison)
    maison.chmod(0o700)
    r = _install(racine, "--service", PATH=_faux_sudo(tmp_path))
    sortie = r.stdout + r.stderr   # journal de l'installation : les deux flux passent par son filtre
    assert r.returncode == 1 and ARRET in sortie and "--standard au lieu de --service" in sortie, sortie
    assert not (racine / "venv").exists() and not (racine / "node").exists()
    texte = (REPO / "install.sh").read_text(encoding="utf-8")
    assert 'ELPIS_COMPTE_UNIQUE="${ELPIS_COMPTE_UNIQUE:-0}" "$ROOT/elpis" service install' in texte
    assert "grep -qsx 'Environment=\"ELPIS_COMPTES=repli\"' /etc/systemd/system/elpis-main.service" in texte


def _deplacer(tmp_path: Path, cible: Path | str, journal: str = "", deplace: int = 0, args: str = "") -> subprocess.CompletedProcess:
    """vers_dossier_standard seule (root, sans sudo), appelée de l'intérieur du dépôt ; un install.sh d'essai au bout dit ses arguments, sa relance, son journal (rouvert ou non), son dossier d'appel."""
    corps = _fonctions_install(tmp_path, "_propre", "info", "bits_autres", "cible_install", "refus_cible", "vers_dossier_standard")
    racine = tmp_path / "maison/elpis"
    defaut = f'--standard "un argument" --caddy-cert "{racine}/certs/a.pem" "{racine}x"'
    lancer = (f'{corps}\ndie() {{ printf "%s\\n" "$*" >&2; exit 1; }}\ncleanup() {{ echo nettoyé; }}\ntrap "echo piège" EXIT\n'
              f'ROOT="{racine}"; APPEL="{racine}/logs"; AS_ROOT=1; JOURNAL_INSTALL="{journal}"; DEPLACE={deplace}; ferme=/x\n'
              f'OFFLINE_DIR="{tmp_path}/paquet"; CADDY_CERT="{tmp_path}/certs/c.pem"; CADDY_KEY="{tmp_path}/certs/c.key"\n'
              f'ARGS_INSTALL=({args or defaut})\nvers_dossier_standard')
    return subprocess.run(["bash", "-c", lancer], capture_output=True, text=True, timeout=60,
                          env=_env(ELPIS_DOSSIER_INSTALL=str(cible)))


def _depot_d_essai(tmp_path: Path) -> Path:
    racine = tmp_path / "maison/elpis"
    (racine / "logs").mkdir(parents=True)
    (racine / "install.sh").write_text('#!/bin/bash\nprintf "relance [%s] %s | %s %s | %s\\n" "$ELPIS_INSTALL_RELANCE" "$*" '
                                       '"$ELPIS_JOURNAL_HERITE" "$ELPIS_JOURNAL_ROUVRIR" "$ELPIS_APPEL_HERITE"\n', encoding="utf-8")
    return racine


# Installation standard : cible absente (dossier parent créé) ou vide, dépôt déplacé puis install.sh relancé de là, mêmes options (chemins du dépôt suivis), même journal, maintien de sudo arrêté.
@pytest.mark.parametrize("vide", [False, True])
def test_deplacement_puis_relance(tmp_path, tmp_ouvert, vide):
    racine, cible = _depot_d_essai(tmp_path), tmp_ouvert / "opt/elpis"
    if vide:
        cible.mkdir(parents=True)
    r = _deplacer(tmp_path, cible, f"{racine}/logs/install.log")
    assert r.returncode == 0, r.stdout + r.stderr
    attendu = (f"relance [1] --standard un argument --caddy-cert {tmp_path}/certs/c.pem {racine}x | "
               f"{cible}/logs/install.log 0 | {cible}/logs")
    assert attendu in r.stdout and "nettoyé" in r.stdout and "piège" not in r.stdout, r.stdout + r.stderr
    assert (cible / "install.sh").is_file() and not racine.exists()
    assert vide or (tmp_ouvert / "opt").stat().st_mode & 0o777 == 0o755   # parent créé en 0755, quel que soit l'umask


# Chemins des options rendus absolus avant le déplacement (--offline relatif au dépôt, certificats à l'appel), --offline en une seule forme, rien après « -- ».
def test_chemins_des_options_suivis(tmp_path, tmp_ouvert):
    racine, cible = _depot_d_essai(tmp_path), tmp_ouvert / "opt/elpis"
    args = '--offline ../paquet --caddy-key -- --offline="$ROOT/p2" -- --offline x'
    r = _deplacer(tmp_path, cible, args=args)
    assert r.returncode == 0, r.stdout + r.stderr
    assert (f"relance [1] --offline={tmp_path}/paquet --caddy-key {tmp_path}/certs/c.key --offline={tmp_path}/paquet "
            "-- --offline x |") in r.stdout, r.stdout


# Certificat donné en « ../ » depuis le dépôt : chemin physique et normalisé dès la lecture (sinon suivi à tort dans le dépôt déplacé).
def test_certificat_relatif_normalise(tmp_path):
    racine = _depot(tmp_path / "maison")
    r = subprocess.run(["bash", str(racine / "install.sh"), "--dry-run", "--caddy-cert", "../absent.pem"], capture_output=True,
                       text=True, timeout=60, cwd=racine, stdin=subprocess.DEVNULL, env=_env())
    assert r.returncode == 2 and f"--caddy-cert : {tmp_path / 'maison/absent.pem'} introuvable." in r.stderr, r.stderr


# Dossier refusé avant tout déplacement : occupé, relatif, dans le dépôt, sous un dossier fermé aux comptes des services ; venv/ retiré ensuite.
@pytest.mark.parametrize("cas", ["occupee", "relative", "dans_le_depot", "parent_ferme", "lien_vers_ferme", "modifiable_par_tous"])
def test_cible_refusee_avant_le_deplacement(tmp_path, tmp_ouvert, cas):
    racine = _depot_d_essai(tmp_path)
    cible = {"occupee": tmp_ouvert / "opt/elpis", "relative": "opt/elpis", "dans_le_depot": racine / "sous",
             "parent_ferme": tmp_path / "ferme/elpis", "lien_vers_ferme": tmp_ouvert / "lien/elpis",
             "modifiable_par_tous": tmp_ouvert / "ecrit/elpis"}[cas]
    attendu = {"occupee": f"{cible} existe déjà et n'est pas un dossier vide", "relative": "opt/elpis n'est pas un chemin absolu",
               "dans_le_depot": f"{cible} est dans le dépôt", "parent_ferme": "n'est pas traversable par les comptes des services",
               "lien_vers_ferme": "n'est pas traversable par les comptes des services",
               "modifiable_par_tous": f"{tmp_ouvert / 'ecrit'} est modifiable par tous les comptes"}[cas]
    if cas == "occupee":
        (tmp_ouvert / "opt/elpis/autre").mkdir(parents=True)
    if cas == "lien_vers_ferme":
        (tmp_path / "loin").mkdir()
        (tmp_ouvert / "lien").symlink_to(tmp_path / "loin")
    if cas == "modifiable_par_tous":
        (tmp_ouvert / "ecrit").mkdir()
        (tmp_ouvert / "ecrit").chmod(0o777)
    r = _deplacer(tmp_path, cible)
    assert r.returncode == 1 and "Installation standard : " in r.stderr and attendu in r.stderr, r.stderr
    assert racine.is_dir() and (racine / "install.sh").is_file() and not (tmp_path / "ferme").exists()
    assert not (tmp_path / "loin/elpis").exists()


# venv/ d'un passage interrompu retiré avant le déplacement ; journal hors du dépôt gardé tel quel, jamais rouvert.
def test_venv_retire_et_journal_hors_du_depot(tmp_path, tmp_ouvert):
    racine, cible = _depot_d_essai(tmp_path), tmp_ouvert / "opt/elpis"
    (racine / "venv/bin").mkdir(parents=True)
    r = _deplacer(tmp_path, cible, "/var/log/elpis-install.log")
    assert r.returncode == 0 and "| /var/log/elpis-install.log 0 |" in r.stdout and not (cible / "venv").exists(), r.stdout + r.stderr


# Relance d'un déplacement entre systèmes de fichiers : le journal déplacé est rouvert (sinon, rien n'y serait plus écrit).
@pytest.mark.parametrize("rouvrir", ["1", "0"])
def test_journal_rouvert_apres_un_changement_de_disque(tmp_ouvert, rouvrir):
    journal = tmp_ouvert / "j.log"
    r = _install(_depot(tmp_ouvert), "--dry-run", "--standard", ELPIS_INSTALL_RELANCE="1", ELPIS_JOURNAL_HERITE=str(journal),
                 ELPIS_JOURNAL_ROUVRIR=rouvrir)
    # Code de sortie selon l'hôte (sudo attendu pour les services) : seul le journal compte ici.
    assert ("dossier           :" in journal.read_text(encoding="utf-8")) if rouvrir == "1" else not journal.exists(), r.stdout + r.stderr


# --standard avec --start ou --no-start, dans un sens ou dans l'autre : refus d'emblée.
@pytest.mark.parametrize("ordre", [("--standard", "--start"), ("--no-start", "--standard")])
def test_standard_et_start_s_excluent(tmp_ouvert, ordre):
    r = _install(_depot(tmp_ouvert), "--dry-run", *ordre)
    assert r.returncode == 2 and "--standard ne va pas avec --start ni --no-start." in r.stderr, r.stderr


# Essai à blanc : le dossier occupé est signalé comme l'installation réelle le refuserait.
def test_essai_a_blanc_dossier_occupe(tmp_path, tmp_ouvert):
    maison = tmp_path / "maison"
    racine = _depot(maison)
    maison.chmod(0o700)
    (tmp_ouvert / "opt/elpis/autre").mkdir(parents=True)
    r = _install(racine, "--dry-run", "--standard", ELPIS_DOSSIER_INSTALL=str(tmp_ouvert / "opt/elpis"))
    assert r.returncode == 1 and "existe déjà et n'est pas un dossier vide ; rien ne serait installé" in r.stderr, r.stderr
    assert "serait déplacé" not in r.stdout


# Assistant en lignes, démarrage pas choisi : la question du mode d'abord. Standard : dépôt déplacé, relancé de là ; essai : sur place.
@pytest.mark.skipif(shutil.which("systemctl") is None, reason="sans systemd, les services ne sont pas proposés")
@pytest.mark.parametrize("choix", ["standard", "essai"])
def test_question_du_mode_avant_tout(tmp_path, tmp_ouvert, choix):
    maison = tmp_path / "maison"
    racine = _depot(maison)
    maison.chmod(0o700)
    cible = tmp_ouvert / "opt-elpis"
    env = {"PATH": _faux_sudo(tmp_path), "TERM": "xterm", "LANG": "C.UTF-8", "ELPIS_DOSSIER_INSTALL": str(cible)}
    touche = b"1\r" if choix == "standard" else b"2\r"
    ecran, code = _repondre(["bash", str(racine / "install.sh"), "--plain", *SANS, "--no-agpl", "--db", "sqlite"], env,
                            [(MODE, touche), (LANCER, b"n\r")])
    assert code == 0 and ecran.count(MODE) == 1, ecran[-3000:]
    if choix == "standard":
        assert f"Installation standard : dépôt déplacé de {racine} vers {cible}" in ecran and not racine.exists(), ecran[-3000:]
        assert f"dossier           : {cible}" in ecran and "démarrage         : service" in ecran, ecran[-3000:]
    else:
        assert racine.is_dir() and not cible.exists() and "Installation standard :" not in ecran, ecran[-3000:]
        assert f"dossier           : {racine}" in ecran and "démarrage         : start" in ecran, ecran[-3000:]


# Relancé après le déplacement, dossier de l'installation standard encore fermé aux comptes des services : arrêt net, pas de second déplacement.
def test_pas_de_second_deplacement(tmp_path, tmp_ouvert):
    racine, cible = _depot_d_essai(tmp_path), tmp_ouvert / "opt/elpis"
    r = _deplacer(tmp_path, cible, deplace=1)
    assert r.returncode == 1 and f"Installation standard : {cible} n'est pas accessible aux comptes des services (/x)" in r.stderr, r.stderr
    assert racine.is_dir() and not cible.exists()
