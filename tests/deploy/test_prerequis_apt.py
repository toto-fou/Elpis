# SPDX-License-Identifier: MIT
"""tests/deploy/test_prerequis_apt.py — paquets apt prérequis : fichier, absents détectés (dpkg-query et apt simulés), installation par install.sh, --dry-run, doctor, docs."""
from __future__ import annotations

import getpass
import hashlib
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
FICHIER = REPO / "deploy/prerequis-apt.txt"
GROUPES = ["socle", "sandbox", "apercus-office", "navigateur", "https", "postgresql-local", "sauvegarde-distante",
           "construction-hote"]
COMMANDE = "sudo apt install --no-install-recommends"


def _groupes() -> dict[str, list[list[str]]]:
    groupes: dict[str, list[list[str]]] = {}
    groupe = None
    for ligne in FICHIER.read_text(encoding="utf-8").splitlines():
        if ligne.startswith("##") or not ligne.strip():
            continue
        if ligne.startswith("# "):
            m = re.fullmatch(r"# ([a-z0-9-]+) — (\S.*)", ligne)
            assert m, ligne
            groupe = m[1]
            groupes[groupe] = []
            continue
        assert groupe, ligne
        groupes[groupe].append([a.strip() for a in ligne.split("|")])
    return groupes


def _tous(*noms: str) -> str:
    return " ".join(a for g in noms for ligne in _groupes()[g] for a in ligne)


def _os_release(tmp_path: Path, version: str, os_id: str = "debian") -> str:
    f = tmp_path / f"os-release-{os_id}-{version}"
    f.write_text(f'PRETTY_NAME="{os_id} {version}"\nID={os_id}\nVERSION_ID="{version}"\n', encoding="utf-8")
    return str(f)


@pytest.fixture
def faux_bin(tmp_path):
    """dpkg-query, apt-cache, apt-get, apt, sudo, docker, systemctl, curl, npm et sleep 10 simulés : FAUX_DPKG (installés),
    FAUX_APT_DISPO (dans les dépôts, tous si absent), FAUX_SUDO=0 (sudo accordé ; verifypw : sans mot de passe, sauf sudo -v), FAUX_APT_RC (code d'apt-get install),
    FAUX_APT_VERROU (premiers « update » refusés, listes verrouillées), FAUX_APT_UPDATE_RC (« update » en échec),
    FAUX_DOCKER_INFO=0 (démon joignable), FAUX_DOCKER_IMAGES (images elpis/sandbox) ; appels notés dans tmp_path/appels."""
    b = tmp_path / "bin"
    b.mkdir()
    poses = tmp_path / "poses"
    _executable(b / "dpkg-query", f"""#!{sys.executable}
import os, pathlib, sys
poses = pathlib.Path("{poses}")
installes = set(os.environ.get("FAUX_DPKG", "").split()) | set(poses.read_text().split() if poses.exists() else [])
noms = [a for a in sys.argv[1:] if not a.startswith("-")]
for n in noms:
    if n in installes:
        print(n + "\\tinstalled")
sys.exit(0 if all(n in installes for n in noms) else 1)
""")
    _executable(b / "apt-cache", f"""#!{sys.executable}
import os, sys
dispo = os.environ.get("FAUX_APT_DISPO")
for n in sys.argv[2:]:
    print(n + ":")
    print("  Installed: (none)")
    print("  Candidate: " + ("1.0" if dispo is None or n in dispo.split() else "(none)"))
""")
    _executable(b / "apt-get", f"""#!/bin/sh
echo "apt-get $*" >> "{tmp_path}/appels"
case " $* " in *" update "*)
    n=$(cat "{tmp_path}/verrou" 2>/dev/null || echo 0)
    if [ "$n" -lt "${{FAUX_APT_VERROU:-0}}" ]; then
        echo $((n + 1)) > "{tmp_path}/verrou"
        echo "E: Could not get lock /var/lib/apt/lists/lock. It is held by process 1 (apt-get)" >&2; exit 100
    fi
    [ -z "${{FAUX_APT_UPDATE_RC:-}}" ] || {{ echo "E: Failed to fetch, Temporary failure resolving" >&2; exit "$FAUX_APT_UPDATE_RC"; }}
    exit 0 ;;
esac
if [ "${{FAUX_APT_RC:-0}}" = 0 ]; then
    a=0; for x in "$@"; do [ "$a" = 1 ] && case "$x" in -*) ;; *) echo "$x" >> "{poses}" ;; esac; [ "$x" = install ] && a=1; done
fi
exit "${{FAUX_APT_RC:-0}}"
""")
    _executable(b / "apt", f'#!/bin/sh\necho "apt $*" >> "{tmp_path}/appels"\nexit 1\n')
    _executable(b / "sudo", f"""#!/bin/sh
echo "sudo $*" >> "{tmp_path}/appels"
case "${{FAUX_SUDO:-1}}:$*" in
    verifypw:-v|"verifypw:-n -v") echo "sudo: a password is required" >&2; exit 1 ;;
    0:*|verifypw:*) ;;
    *) exit 1 ;;
esac
case "$1" in env) exec "$@" ;; esac
exit 0
""")
    for nom in ("systemctl", "curl", "npm", "usermod"):                    # rien de tout cela n'est lancé
        _executable(b / nom, f'#!/bin/sh\necho "{nom} $*" >> "{tmp_path}/appels"\nexit 1\n')
    _executable(b / "docker", f"""#!/bin/sh
echo "docker $*" >> "{tmp_path}/appels"
case "$1" in
    info) exit "${{FAUX_DOCKER_INFO:-1}}" ;;
    images) echo "${{FAUX_DOCKER_IMAGES:-}}"; exit 0 ;;
    ps) exit 0 ;;
esac
exit 1
""")
    _executable(b / "sleep", f'#!/bin/sh\n[ "$1" = 10 ] || exec /bin/sleep "$@"\necho "sleep $*" >> "{tmp_path}/appels"\n')
    return b


def _appels(tmp_path: Path) -> list[str]:
    f = tmp_path / "appels"
    return f.read_text(encoding="utf-8").splitlines() if f.exists() else []


def _actions(tmp_path: Path) -> list[str]:
    """Appels qui agiraient sur la machine : tous, sauf les lectures de Docker (démon, images, conteneurs)."""
    return [a for a in _appels(tmp_path) if not a.startswith(("docker image inspect ", "docker info", "docker images ",
                                                               "docker ps "))]


def _executable(chemin: Path, texte: str) -> Path:
    chemin.write_text(texte, encoding="utf-8")
    chemin.chmod(0o755)
    return chemin


def _bash(faux_bin: Path, script: str, installes: str, **extra: str) -> subprocess.CompletedProcess:
    env = {"PATH": f"{faux_bin}:/usr/bin:/bin", "FAUX_DPKG": installes, "LANG": "C.UTF-8",
           "PREREQUIS_OS_RELEASE": _os_release(faux_bin, "13"), **extra}
    return subprocess.run(["bash", "-c", f'. "{REPO}/deploy/prerequis-apt.sh"; {script}'], env=env,
                          capture_output=True, text=True, timeout=60)


def test_fichier_lisible():
    groupes = _groupes()
    assert list(groupes) == GROUPES
    for nom, lignes in groupes.items():
        noms = [a for ligne in lignes for a in ligne]
        assert lignes and len(lignes) == len({tuple(ligne) for ligne in lignes}), nom
        assert all(len(ligne) == len(set(ligne)) for ligne in lignes), nom
        assert all(re.fullmatch(r"[a-z0-9][a-z0-9+.-]+", n) for n in noms), noms
        assert not {"node", "nodejs", "npm"} & set(noms)
    assert ["python3"] in groupes["socle"] and ["python3-venv"] in groupes["socle"]
    assert ["docker.io", "docker-ce"] in groupes["sandbox"]
    # Debian 12 et Ubuntu 24.04 : client Docker dans docker.io, bibliothèques sans t64 sur Debian 12.
    assert ["docker-cli", "docker-ce-cli", "docker.io"] in groupes["sandbox"]
    assert ["libasound2t64", "libasound2"] in groupes["navigateur"]
    assert not [ligne for ligne in groupes["navigateur"] if ligne[0].endswith("t64") and len(ligne) == 1]


def test_bibliotheque_lit_les_groupes_et_les_roles(faux_bin):
    r = _bash(faux_bin, 'prerequis_groupes; prerequis_role sandbox; prerequis_lignes https sandbox', "")
    attendu = GROUPES + ["Docker pour la sandbox des utilisateurs (terminal, exécution de code)",
                         "docker.io | docker-ce", "docker-cli | docker-ce-cli | docker.io", "xz-utils", "caddy"]
    assert r.stdout.splitlines() == attendu, r.stderr


@pytest.mark.parametrize("installes,manquants", [
    (_tous("socle"), []),
    (_tous("socle").replace("git ", "").replace("curl ", ""), ["git", "curl"]),
    ("docker-ce xz-utils", ["docker-cli | docker-ce-cli | docker.io"]),
    ("docker.io xz-utils", []),
    ("", ["docker.io | docker-ce", "docker-cli | docker-ce-cli | docker.io", "xz-utils"]),
])
def test_paquets_absents_detectes(faux_bin, installes, manquants):
    groupe = "socle" if "python3" in installes else "sandbox"
    r = _bash(faux_bin, f"prerequis_manquants {groupe}", installes)
    assert r.returncode == 0 and r.stdout.splitlines() == manquants, r.stderr


def test_paquet_commun_a_deux_groupes_demande_une_fois(faux_bin):
    r = _bash(faux_bin, "prerequis_manquants apercus-office navigateur", "")
    assert r.stdout.splitlines().count("fonts-liberation") == 1, r.stdout


def test_commande_et_libelles(faux_bin):
    r = _bash(faux_bin, 'prerequis_commande "docker.io | docker-ce" xz-utils; prerequis_libelle "a | b | c"; '
                        'prerequis_libelle git', "")
    assert r.stdout.splitlines() == [f"{COMMANDE} docker.io xz-utils", "a (ou b ou c)", "git"]


def test_choix_premiere_forme_que_proposent_les_depots(faux_bin):
    lignes = '"libasound2t64 | libasound2" "docker.io | docker-ce" "docker-cli | docker-ce-cli | docker.io" caddy'
    r = _bash(faux_bin, f"prerequis_choix {lignes}; prerequis_commande {lignes}", "",
              FAUX_APT_DISPO="libasound2 docker.io")    # Debian 12 sans Caddy dans ses dépôts
    assert r.stdout.splitlines() == ["libasound2", "docker.io", "docker.io", "!caddy",
                                     f"{COMMANDE} libasound2 docker.io caddy"], r.stderr


@pytest.fixture
def depot(tmp_path):
    d = tmp_path / "elpis"
    suivis = subprocess.run(["git", "ls-files", "deploy"], cwd=REPO, capture_output=True, text=True, check=True)
    for f in ["install.sh", "requirements.txt", "requirements-rag.txt", *suivis.stdout.split()]:
        (d / f).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(REPO / f, d / f)
    return d


def _install(depot: Path, faux_bin: Path, installes: str, *args: str, debian: str = "13", os_id: str = "debian",
             **extra: str) -> subprocess.CompletedProcess:
    env = {"PATH": f"{faux_bin}:/usr/bin:/bin", "FAUX_DPKG": installes, "LANG": "C.UTF-8", "HOME": str(depot),
           "PREREQUIS_OS_RELEASE": _os_release(faux_bin, debian, os_id), **extra}
    return subprocess.run(["bash", str(depot / "install.sh"), "--yes", *args], env=env, capture_output=True,
                          text=True, timeout=120, cwd=str(depot), stdin=subprocess.DEVNULL)


def _installs(tmp_path: Path) -> list[list[str]]:
    """Paquets de chaque « apt-get install » lancé, dans l'ordre."""
    return [a.split(" install ", 1)[1].split()[1:] for a in _appels(tmp_path) if a.startswith("apt-get") and " install " in a]


def test_sans_droits_s_arrete_sur_le_socle_sans_rien_installer(depot, faux_bin, tmp_path):
    r = _install(depot, faux_bin, _tous("socle").replace("git ", ""))
    sortie = r.stdout + r.stderr                     # hors --dry-run, tout passe par le journal (tee)
    assert r.returncode == 1, sortie
    assert "Paquets système manquants" in sortie and "\n    git\n" in sortie
    assert f"\n    {COMMANDE} git\n" in sortie
    assert "(pas de droits administrateur) : rien n'a été installé" in sortie
    assert not [a for a in _appels(tmp_path) if a.startswith(("apt-get", "apt "))] and not (depot / "venv").exists()


def test_installe_le_socle_puis_les_groupes_choisis(depot, faux_bin, tmp_path):
    r = _install(depot, faux_bin, "", "--sandbox", "build", "--no-office", "--no-browser",
                 FAUX_SUDO="0", PYTHON_BIN="false")         # s'arrête ensuite, à la création du venv
    sortie = r.stdout + r.stderr
    assert "Échec de création du venv" in sortie, sortie
    apt = [a for a in _appels(tmp_path) if a.startswith("apt-get")]
    assert [a for a in apt if " update" in a] == [apt[0]], apt          # une seule mise à jour des listes, d'abord
    assert _installs(tmp_path) == [["python3", "python3-venv", "git", "curl", "ca-certificates", "openssl",
                                    "bubblewrap"], ["docker.io", "docker-cli", "xz-utils", "build-essential"]]
    sudo = [a for a in _appels(tmp_path) if a.startswith("sudo env")]
    assert sudo and all("DEBIAN_FRONTEND=noninteractive" in a and " -y " in a and "--no-install-recommends" in a
                        for a in sudo if " install " in a), sudo
    assert ("paquets système à installer : 4 : docker.io (ou docker-ce), docker-cli (ou docker-ce-cli ou docker.io), "
            "xz-utils, build-essential") in " ".join(sortie.split()), sortie
    assert "Paquets système installés (groupes socle sandbox construction-hote)." in sortie


def test_debian_12_installe_les_noms_de_ses_depots(depot, faux_bin, tmp_path):
    dispo = " ".join(_tous("socle", "navigateur", "construction-hote").split()).replace("t64", "") + " docker.io xz-utils"
    _install(depot, faux_bin, _tous("socle"), "--sandbox", "build", "--no-office", "--with-browser", debian="12",
             FAUX_SUDO="0", FAUX_APT_DISPO=dispo, PYTHON_BIN="false")
    (paquets,) = _installs(tmp_path)
    assert "libasound2" in paquets and "libglib2.0-0" in paquets and not [p for p in paquets if p.endswith("t64")]
    assert paquets.count("docker.io") == 1 and "docker-cli" not in paquets


def test_ubuntu_24_04_et_paquet_absent_des_depots(depot, faux_bin, tmp_path):
    r = _install(depot, faux_bin, _tous("socle", "construction-hote"), "--sandbox", "none", "--no-office", "--no-browser",
                 "--with-caddy", debian="24.04", os_id="ubuntu", FAUX_SUDO="0", FAUX_APT_DISPO="")
    sortie = r.stdout + r.stderr                     # hors --dry-run, tout passe par le journal (tee)
    assert r.returncode == 1 and not _installs(tmp_path)
    assert "Absents des dépôts apt de cette machine : caddy (dépôt universe activé ?)." in sortie, sortie
    assert f"\n    {COMMANDE} caddy\n" in sortie and "ou relancez sans le composant concerné : --no-caddy\n" in sortie
    assert "Prérequis système manquants : apt-get a échoué." in sortie


def test_echec_d_apt_get_commande_et_arret(depot, faux_bin, tmp_path):
    r = _install(depot, faux_bin, _tous("socle").replace("curl ", ""), "--offline", str(tmp_path),
                 FAUX_SUDO="0", FAUX_APT_RC="100")
    sortie = r.stdout + r.stderr
    assert r.returncode == 1 and _installs(tmp_path) == [["curl"]], sortie
    assert "hors ligne, apt passe par le miroir du LAN ou le support de l'OS" in sortie
    assert f"\n    {COMMANDE} curl\n" in sortie and "Prérequis système manquants : apt-get a échoué." in sortie


def test_no_apt_verifie_seulement(depot, faux_bin, tmp_path):
    r = _install(depot, faux_bin, _tous("socle").replace("git ", ""), "--no-apt", FAUX_SUDO="0")
    sortie = r.stdout + r.stderr
    assert r.returncode == 1 and not [a for a in _appels(tmp_path) if a.startswith("apt-get")], sortie
    assert f"\n    {COMMANDE} git\n" in sortie and "(--no-apt) : rien n'a été installé" in sortie


def _arbre(racine: Path) -> dict[str, tuple[int, int, str]]:
    """Mode, date et contenu (cible d'un lien) de chaque entrée, liens non suivis."""
    arbre = {}
    for f in sorted(racine.rglob("*")):
        st = f.lstat()
        contenu = os.readlink(f) if f.is_symlink() else hashlib.sha256(f.read_bytes()).hexdigest() if f.is_file() else ""
        arbre[str(f.relative_to(racine))] = (st.st_mode, st.st_mtime_ns, contenu)
    return arbre


def _path_sans(tmp_path: Path, faux_bin: Path, *noms: str) -> str:
    """PATH sans ces commandes : celles de /usr/bin et /bin en liens, les noms donnés (et leurs faux) retirés."""
    for nom in noms:
        (faux_bin / nom).unlink(missing_ok=True)
    d = tmp_path / "systeme"
    d.mkdir()
    for rep in ("/usr/bin", "/bin"):
        for f in Path(rep).iterdir():
            if f.name not in noms and not (d / f.name).exists() and os.access(f, os.X_OK) and not f.is_dir():
                (d / f.name).symlink_to(f)
    return f"{faux_bin}:{d}"


def _paquet_hors_ligne(racine: Path) -> Path:
    archive = re.search(r"^NODE_ASSET_x86_64=(\S+)\.tar\.gz$", (REPO / "deploy/node/node.env").read_text(), re.M)[1]
    for f in ("core/main.mjs", "core/construction.json", "toolhost/main.mjs", "toolhost/construction.json",
              "web/.vite/manifest.json", f"node/{archive}-sans-npm.tar.gz", "wheels/a.whl"):
        (racine / f).parent.mkdir(parents=True, exist_ok=True)
        (racine / f).write_text("x", encoding="utf-8")
    return racine


@pytest.mark.parametrize("existante,sudo", [(False, True), (True, True), (False, False)])
def test_dry_run_sans_question_sans_sudo_sans_rien_ecrire(depot, faux_bin, tmp_path, existante, sudo):
    if existante:
        for f, texte in {"config.json": "{}", ".env": "A=1\n", "mcp.json": "{}", "user_db/app.db": "base"}.items():
            (depot / f).parent.mkdir(parents=True, exist_ok=True)
            (depot / f).write_text(texte, encoding="utf-8")
        (depot / "user_sandboxes").mkdir()
    (tmp_path / "tmp").mkdir()                       # TMPDIR surveillé : aucun fichier temporaire laissé
    env = {"PATH": f"{faux_bin}:/usr/bin:/bin" if sudo else _path_sans(tmp_path, faux_bin, "sudo"), "FAUX_DPKG": _tous("socle"),
           "LANG": "C.UTF-8", "HOME": str(depot), "TMPDIR": str(tmp_path / "tmp"),
           "PREREQUIS_OS_RELEASE": _os_release(faux_bin, "13")}
    avant = _arbre(tmp_path)
    r = subprocess.run(["bash", str(depot / "install.sh"), "--dry-run", "--sandbox", "build", "--no-office",
                        "--no-browser"], env=env, capture_output=True, text=True, timeout=120, cwd=str(depot),
                       stdin=subprocess.DEVNULL)
    sortie = r.stdout + r.stderr
    apres = _arbre(tmp_path)
    apres.pop("appels", None)                        # journal des faux binaires
    assert apres == avant, sortie
    # Ni sudo, ni apt-get, ni apt, ni systemctl, curl ou npm : seule la lecture de l'image sandbox.
    assert _actions(tmp_path) == [], _appels(tmp_path)
    etapes = re.findall(r"^\s+\d+\. (.*?) :", r.stdout, re.M)
    assert etapes[0] == "paquets apt (groupes socle sandbox construction-hote)", etapes
    assert "base de données" in etapes and etapes[-1] == "démarrage", etapes
    gardes = ("Installation existante, gardés tels quels : config.json, .env, user_db/ (base SQLite app.db, jetons), "
              "user_sandboxes/ ; mcp.json mis à jour (relais, familles d'outils).")
    assert (gardes in r.stdout) is existante, r.stdout
    assert ("base de données : gardée" in r.stdout) is existante
    assert ("configuration : gardée" in r.stdout) is existante
    assert ("l'assistant les demanderait" in r.stdout) and ("rouvrirait l'assistant" in r.stdout) is existante
    if not sudo:
        assert r.returncode == 1 and "sudo absent : pas de droits administrateur." in r.stderr, sortie
        assert "4 manquant(s), NON installés (pas de droits administrateur)" in r.stdout, r.stdout
        assert "Prérequis système manquants (pas de droits administrateur) : rien ne serait installé." in r.stderr
        return
    assert etapes[1:3] == ["Docker", "Python"], etapes
    assert ("Réseau requis : dépôts apt (ou miroir du LAN), PyPI, nodejs.org, registre npm, GitHub (Qdrant), "
            "Docker Hub et dépôts Debian (image sandbox).") in r.stdout, r.stdout
    assert ("4 manquant(s), apt-get update puis apt-get install --no-install-recommends docker.io docker-cli xz-utils "
            "build-essential") in r.stdout, r.stdout
    groupes_sudo = bool({"sudo", "admin", "wheel"} & set(subprocess.run(["id", "-nG"], capture_output=True,
                                                                        text=True).stdout.split()))
    assert r.returncode == (0 if groupes_sudo else 1), sortie
    assert ("sudo serait demandé au départ (jamais en --dry-run), indispensable pour : paquets apt ; sans lui, sautés : "
            "service et groupe docker.") in r.stdout
    assert groupes_sudo or "(ou sans le composant : --sandbox none --offline <paquet de cette version>)." in r.stderr


def test_dry_run_code_non_nul_et_raison_si_l_installation_s_arreterait(depot, faux_bin, tmp_path):
    r = _install(depot, faux_bin, _tous("socle").replace("git ", ""), "--dry-run", "--no-apt")
    assert r.returncode == 1 and not _actions(tmp_path)
    assert "l'installation réelle s'arrêterait" in r.stderr and "Prérequis système manquants (--no-apt)" in r.stderr
    sans = ("--dry-run", "--sandbox", "none", "--no-office", "--no-browser")
    paquet = _paquet_hors_ligne(tmp_path / "paquet")
    r = _install(depot, faux_bin, _tous("socle"), *sans, "--offline", str(paquet))
    assert r.returncode == 0, r.stderr
    assert "l'installation pourrait aller au bout ; rien n'a été modifié." in r.stdout and "Réseau requis" not in r.stdout
    assert re.search(r"^\s+1\. paquets apt \(groupes socle\) : tous présents, rien à installer$", r.stdout, re.M), r.stdout
    (paquet / "web/.vite/manifest.json").unlink()
    r = _install(depot, faux_bin, _tous("socle"), *sans, "--offline", str(paquet))
    assert r.returncode == 1 and f"Paquet hors ligne {paquet} incomplet, absents : web/.vite/manifest.json" in r.stderr


def test_sudo_sans_mot_de_passe_que_sudo_v_refuse(depot, faux_bin, tmp_path):
    # NOPASSWD dans sudoers.d et groupe sudo (images cloud) : sudo -v réclame un mot de passe (verifypw), sudo -n non.
    r = _install(depot, faux_bin, _tous("socle").replace("curl ", ""), "--sandbox", "none", "--no-browser",
                 "--no-office", FAUX_SUDO="verifypw", PYTHON_BIN="false")
    sortie = r.stdout + r.stderr
    assert "sudo refusé" not in sortie and _installs(tmp_path)[0] == ["curl"], sortie
    assert "sudo -n true" in _appels(tmp_path) and "sudo -v" not in _appels(tmp_path)


def test_apt_update_attend_le_verrou_des_listes(depot, faux_bin, tmp_path):
    r = _install(depot, faux_bin, _tous("socle").replace("curl ", ""), "--sandbox", "none", "--no-browser",
                 "--no-office", FAUX_SUDO="0", FAUX_APT_VERROU="2", PYTHON_BIN="false")
    sortie = r.stdout + r.stderr
    assert "Listes apt verrouillées (mise à jour automatique en cours ?) : attente, 5 min au plus…" in sortie, sortie
    apt = [a for a in _appels(tmp_path) if a.startswith(("apt-get", "sleep"))]
    assert [a.split(" -o ")[0] for a in apt[:6]] == ["apt-get -y -q", "sleep 10", "apt-get -y -q", "sleep 10",
                                                       "apt-get -y -q", "apt-get -y -q"], apt
    assert [a for a in apt if a.startswith("apt-get")][2].endswith(" update") and _installs(tmp_path)[0] == ["curl"]


def test_apt_update_en_echec_raison_reseau(depot, faux_bin, tmp_path):
    r = _install(depot, faux_bin, _tous("socle").replace("curl ", ""), FAUX_SUDO="0", FAUX_APT_UPDATE_RC="100",
                 FAUX_APT_DISPO="")                 # listes vides : rien de trouvable sans mise à jour
    sortie = r.stdout + r.stderr
    assert r.returncode == 1 and not _installs(tmp_path), sortie
    assert "apt-get update a échoué (réseau, miroir ou sources apt : voir ci-dessus)" in sortie
    assert "Absents des dépôts apt" not in sortie and not [a for a in _appels(tmp_path) if a.startswith("sleep")]
    assert f"\n    {COMMANDE} curl\n" in sortie and "Prérequis système manquants : apt-get a échoué." in sortie


@pytest.mark.parametrize("docker,images,attendu", [(False, "", "none"), (True, "", "none"), (True, "4f2a", "build")])
def test_reinstallation_garde_la_sandbox_en_place(depot, faux_bin, tmp_path, docker, images, attendu):
    # Comme l'assistant : sans image elpis/sandbox ni conteneur elpis-sb-*, --yes ne pose ni Docker ni image.
    (depot / "config.json").write_text("{}", encoding="utf-8")
    path = f"{faux_bin}:/usr/bin:/bin" if docker else _path_sans(tmp_path, faux_bin, "docker")
    r = _install(depot, faux_bin, _tous("socle"), "--dry-run", "--no-office", "--no-browser", PATH=path,
                 FAUX_DOCKER_INFO="0", FAUX_DOCKER_IMAGES=images)
    assert re.search(rf"^\s+sandbox\s+: {attendu}$", r.stdout, re.M), r.stdout
    assert ("sandbox" in re.search(r"prérequis apt\s+: .*", r.stdout)[0]) is (attendu == "build")


def test_install_verifie_les_groupes_des_composants_choisis(depot, faux_bin):
    r = _install(depot, faux_bin, _tous("socle", "navigateur", "construction-hote"), "--dry-run", "--sandbox", "build",
                 "--no-office", "--no-apt")
    assert r.returncode == 1, r.stderr
    assert re.search(r"prérequis apt\s+: vérifiés seulement, --no-apt \(socle sandbox navigateur construction-hote\)",
                     r.stdout), r.stdout
    assert "docker.io (ou docker-ce)\n    docker-cli (ou docker-ce-cli ou docker.io)\n    xz-utils" in r.stderr
    assert f"{COMMANDE} docker.io docker-cli xz-utils" in r.stderr
    assert "ou relancez sans le composant concerné : --sandbox none\n" in r.stderr


def test_install_sur_un_systeme_inconnu_ne_pose_que_le_socle(depot, faux_bin):
    r = _install(depot, faux_bin, _tous("socle"), "--dry-run", "--sandbox", "build", "--with-office", debian="11")
    assert ("seul le socle est installé ; installez l'équivalent des groupes sandbox apercus-office navigateur "
            "construction-hote") in r.stderr
    assert "Paquets système manquants" not in r.stderr and "paquets apt (groupes socle) : tous présents" in r.stdout
    r = _install(depot, faux_bin, _tous("socle"), "--dry-run", "--sandbox", "build", debian="12")
    assert "apt-get install --no-install-recommends docker.io docker-cli xz-utils" in r.stdout, r.stdout


def test_install_skip_system_ne_verifie_rien(depot, faux_bin, tmp_path):
    r = _install(depot, faux_bin, "", "--dry-run", "--skip-system")
    assert "Paquets système manquants" not in r.stderr and not _actions(tmp_path), r.stderr
    assert re.search(r"prérequis apt\s+: ni vérifiés ni installés \(--skip-system\)", r.stdout), r.stdout


@pytest.fixture
def racine(tmp_path):
    r = tmp_path / "racine"
    for d in ("deploy/node", "apps/core/dist", "venv/bin", "rag_app", "user_db/run"):
        (r / d).mkdir(parents=True)
    for f in ("elpis", "deploy/node/node.env", "deploy/prerequis-apt.sh", "deploy/prerequis-apt.txt"):
        shutil.copy2(REPO / f, r / f)
    (r / "venv/bin/python").symlink_to(sys.executable)
    (r / "config.json").write_text('{"backup": {"remote": {"enabled": true, "connector": "rsync"}}}', encoding="utf-8")
    # Le core répond pour config.json (sauvegarde distante par rsync) : exploitation.mjs lanceur.
    (r / "apps/core/dist/exploitation.mjs").write_text("", encoding="utf-8")
    _executable(r / "faux-node", '#!/bin/sh\n[ "$1" = -v ] && { echo v24.21.0; exit 0; }\n'
                                 'case "$*" in *"lanceur sauvegarde-ssh"*) echo oui ;; esac\nexit 0\n')
    return r


def _doctor(racine: Path, faux_bin: Path, installes: str, debian: str = "13") -> tuple[int, dict[str, str]]:
    env = {"PATH": f"{faux_bin}:{os.environ.get('PATH', '/usr/bin:/bin')}", "FAUX_DPKG": installes,
           "HOME": str(racine), "LANG": "C.UTF-8", "ELPIS_USER": getpass.getuser(),
           "ELPIS_NODE": str(racine / "faux-node"), "PREREQUIS_OS_RELEASE": _os_release(faux_bin, debian)}
    r = subprocess.run(["bash", str(racine / "elpis"), "doctor"], env=env, capture_output=True, text=True,
                       timeout=300, cwd=str(racine), stdin=subprocess.DEVNULL)
    sortie = r.stdout + r.stderr
    return r.returncode, {m[1]: m[0] for m in re.finditer(r"^.*paquets apt \(([a-z-]+).*$", sortie, re.M)}


def test_doctor_signale_les_paquets_absents(racine, faux_bin):
    code, lignes = _doctor(racine, faux_bin, _tous("socle", "sandbox", "navigateur").replace("curl ", ""))
    sortie = "\n".join(lignes.values())
    assert set(lignes) == set(GROUPES), sortie
    assert lignes["socle"].endswith(f"paquets apt (socle) : NON (manquants : curl ; {COMMANDE} curl)")
    assert "NON" not in lignes["sandbox"] and "NON" not in lignes["navigateur"]
    assert lignes["sauvegarde-distante"].endswith(
        f"paquets apt (sauvegarde-distante) : NON (manquants : openssh-client, rsync ; {COMMANDE} openssh-client rsync)")
    assert lignes["https"].endswith(f"paquets apt (https, facultatif) : absents : caddy ({COMMANDE} caddy)")
    assert code != 0


def test_doctor_verifie_tout_sur_debian_12_le_socle_seul_ailleurs(racine, faux_bin):
    _, lignes = _doctor(racine, faux_bin, _tous("socle", "navigateur").replace("t64", ""), debian="12")
    assert lignes["navigateur"].endswith("paquets apt (navigateur)"), lignes["navigateur"]
    assert "noms de Debian" not in "\n".join(lignes.values())
    _, lignes = _doctor(racine, faux_bin, _tous("socle"), debian="11")
    assert lignes["socle"].endswith("paquets apt (socle)")
    for groupe in GROUPES[1:]:
        assert lignes[groupe].endswith(f"paquets apt ({groupe}) : noms de Debian 12/13 et Ubuntu 24.04, non vérifiés "
                                       "sur ce système (deploy/prerequis-apt.txt)"), lignes[groupe]


def test_commandes_de_la_doc_conformes_au_fichier():
    texte = (REPO / "docs/operations.md").read_text(encoding="utf-8").replace("\\\n", " ")
    commandes = {}
    for m in re.finditer(rf"^# ([a-z0-9-]+) ?: .*\n{re.escape(COMMANDE)} (.+)$", texte, re.M):
        commandes[m[1]] = m[2].split()
    assert commandes == {g: [ligne[0] for ligne in lignes] for g, lignes in _groupes().items()}
