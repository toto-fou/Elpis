# SPDX-License-Identifier: MIT
"""tests/deploy/test_installeur_racine_2026_11_22.py — troisième relecture, côté installeur : journal jamais au travers d'un lien ni dans un dossier des services, mot de passe de la base locale lu par descripteur et jamais dans le texte SQL, ni assistant ni base des services sous root ; chaque attaque rejouée, rien ne se passe."""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

from tests.deploy.test_comptes_separes_2026_11_21 import MOI, _mode
from tests.deploy.test_racine_terminal_2026_11_22 import CLE_SSH, DROITS

REPO = Path(__file__).resolve().parents[2]


def _fonctions_install(unites: Path, *noms: str) -> str:
    """Fonctions de install.sh (unités systemd lues dans UNITES)."""
    texte = (REPO / "install.sh").read_text(encoding="utf-8").replace("/etc/systemd/system", str(unites)).splitlines()
    sortie = []
    for nom in noms:
        debut = next(i for i, l in enumerate(texte) if l.startswith(f"{nom}() {{"))
        fin = debut if texte[debut].rstrip().endswith("}") else next(i for i in range(debut + 1, len(texte)) if texte[i] == "}")
        sortie.extend(texte[debut:fin + 1])
    return "\n".join(sortie)


def _separes(unites: Path) -> None:
    unites.mkdir(exist_ok=True)
    (unites / "elpis-main.service").write_text('[Service]\nEnvironment="ELPIS_COMPTES=separes"\n', encoding="utf-8")


# 1 — logs/install.log mené par un lien vers authorized_keys, nom de fichier à fins de ligne : ni ligne ajoutée, ni journal suivi.
def test_1_journal_d_installation_jamais_dans_un_dossier_des_services(tmp_path):
    racine, unites, victime = tmp_path / "elpis", tmp_path / "unites", tmp_path / "authorized_keys"
    (racine / "logs").mkdir(parents=True)
    victime.write_text("ssh-ed25519 AAAA operateur\n", encoding="utf-8")
    (racine / "logs/install.log").symlink_to(victime)
    corps = _fonctions_install(unites, "_propre", "warn", "unites_separees", "journal_install")
    lancer = f'{corps}\nROOT="{racine}"\nf="$(journal_install)" || exit 3\nprintf "%s\\n" "$f"\nwarn "$1 : lien, laissé" 2>> "$f"'
    nom = f"{racine}/logs/audit/audit-\n{CLE_SSH}\n.jsonl"
    for separe in (True, False):
        if separe:
            _separes(unites)
        else:
            shutil.rmtree(unites)
        r = subprocess.run(["bash", "-c", lancer, "x", nom], capture_output=True, text=True, timeout=60)
        assert r.returncode == 0 and r.stdout.strip() == f"{racine}/.install.log", r.stdout + r.stderr
        assert victime.read_text(encoding="utf-8") == "ssh-ed25519 AAAA operateur\n"
        lignes = (racine / ".install.log").read_text(encoding="utf-8").splitlines()
        assert not [l for l in lignes if l.startswith("ssh-ed25519")] and _mode(racine / ".install.log") == "600"
    # Fichier du journal remplacé par un lien : refusé lui aussi, rien d'écrit nulle part.
    (racine / ".install.log").unlink()
    (racine / ".install.log").symlink_to(victime)
    r = subprocess.run(["bash", "-c", lancer, "x", nom], capture_output=True, text=True, timeout=60)
    assert r.returncode == 3 and "Journal de l'installation désactivé" in r.stderr
    assert victime.read_text(encoding="utf-8") == "ssh-ed25519 AAAA operateur\n"


# 3 — mot de passe de la base : lien posé dans user_db, contenu injecté dans ALTER ROLE ; jamais suivi, jamais interpolé.
def test_3_mot_de_passe_de_la_base_par_descripteur(tmp_path):
    db, victime = tmp_path / "user_db", tmp_path / "victime"
    db.mkdir()
    victime.write_text("intact", encoding="utf-8")
    victime.chmod(0o644)
    (db / ".db_password").symlink_to(victime)
    r = subprocess.run([*DROITS, "mdp-base", str(db), ".db_password", MOI], capture_output=True, text=True, timeout=60)
    assert r.returncode == 1 and r.stdout == "" and _mode(victime) == "644"
    assert victime.read_text(encoding="utf-8") == "intact"
    (db / ".db_password").unlink()
    (db / ".db_password").write_text("x'; COPY (SELECT 1) TO PROGRAM 'id > /tmp/pwned'; --\n", encoding="utf-8")
    r = subprocess.run([*DROITS, "mdp-base", str(db), ".db_password", MOI], capture_output=True, text=True, timeout=60)
    assert r.returncode == 1 and r.stdout == "" and "non conforme" in r.stderr
    (db / ".db_password").unlink()
    r = subprocess.run([*DROITS, "mdp-base", str(db), ".db_password", MOI], capture_output=True, text=True, timeout=60)
    assert r.returncode == 0 and re.fullmatch(r"[0-9a-f]{48}\n", r.stdout) and _mode(db / ".db_password") == "600"
    again = subprocess.run([*DROITS, "mdp-base", str(db), ".db_password", MOI], capture_output=True, text=True, timeout=60)
    assert again.stdout == r.stdout


def test_3_role_de_la_base_sans_mot_de_passe_dans_le_texte_sql(tmp_path):
    racine, unites = tmp_path / "elpis", tmp_path / "unites"
    (racine / "deploy").mkdir(parents=True)
    shutil.copy2(REPO / "deploy/droits.py", racine / "deploy/droits.py")
    vu = tmp_path / "sql"
    corps = _fonctions_install(unites, "db_password", "provision_postgres")
    talons = (f'have() {{ return 0; }}; info() {{ :; }}; ok() {{ :; }}; note_warn() {{ :; }}; systemctl() {{ :; }}; SUDO=""\n'
              f'as_user() {{ cat >> "{vu}"; }}; prerequis_commande() {{ :; }}\nROOT="{racine}"; APP_USER="{MOI}"\n')
    lancer = talons + corps + '\nprovision_postgres; echo "rc=$? ${DB_ERR:-}"'
    r = subprocess.run(["bash", "-c", lancer], capture_output=True, text=True, timeout=60, env={"PATH": os.environ["PATH"]})
    assert "rc=0" in r.stdout, r.stdout + r.stderr
    sql = vu.read_text(encoding="utf-8")
    pw = (racine / "user_db/.db_password").read_text(encoding="utf-8").strip()
    assert f"\\set pw {pw}\n" in sql and "PASSWORD :'pw'" in sql and f"'{pw}'" not in sql
    vu.unlink()
    (racine / "user_db/.db_password").write_text("a'; DROP ROLE postgres; --\n", encoding="utf-8")
    r = subprocess.run(["bash", "-c", lancer], capture_output=True, text=True, timeout=60, env={"PATH": os.environ["PATH"]})
    assert "rc=1 mot de passe de user_db/.db_password refusé" in r.stdout and not vu.exists(), r.stdout + r.stderr
    # Sous root et un compte par service, l'assistant (qui lit config.json, écrit par la console) ne tourne pas.
    texte = (REPO / "install.sh").read_text(encoding="utf-8")
    garde = texte.index('if [ "$(id -u)" -eq 0 ] && unites_separees && [ "$INTERACTIVE" -eq 1 ] && [ "$PLAIN" -eq 0 ]; then\n    PLAIN=1')
    assert garde < texte.index("\n    run_wizard\n    case $? in")


# 4 — installeur sous root : conseils du moteur par ./elpis configure (sous la console), config.json lu borné.
def test_4_installeur_sans_lecture_libre_de_config_json(tmp_path):
    texte = (REPO / "install.sh").read_text(encoding="utf-8")
    assert 'conseils="$(bash "$ROOT/elpis" configure --conseils-moteur 2>/dev/null)"' in texte
    assert "json.load(open(" not in texte
    racine = tmp_path / "elpis"
    racine.mkdir()
    os.mkfifo(racine / "config.json")
    corps = _fonctions_install(tmp_path / "unites", "conf_json")
    r = subprocess.run(["bash", "-c", f'{corps}\nROOT="{racine}"\nconf_json \'print(conf())\'; echo "rc=$?"'],
                       capture_output=True, text=True, timeout=60)
    assert "rc=1" in r.stdout and "ValueError" in r.stderr


def test_5_base_sqlite_des_services_jamais_ouverte_par_root(tmp_path, monkeypatch):
    import importlib.util
    spec = importlib.util.spec_from_file_location("elpis_configure_separe", REPO / "deploy/configure.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    base = tmp_path / "app.db"
    base.write_bytes(b"SQLite format 3\x00")
    monkeypatch.setenv("ELPIS_PREFIXE_SYSTEME", str(tmp_path / "sys"))
    monkeypatch.setattr(mod.os, "geteuid", lambda: 0)
    monkeypatch.setattr(mod, "ROOT", tmp_path)
    assert mod.base_sqlite_sure(base) is True
    unites = tmp_path / "sys/etc/systemd/system"
    unites.mkdir(parents=True)
    (unites / "elpis-admin.service").write_text('[Service]\nEnvironment="ELPIS_COMPTES=separes"\n', encoding="utf-8")
    assert mod.base_sqlite_sure(base) is False and mod._sqlite_has_data(base) is False
