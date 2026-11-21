# SPDX-License-Identifier: MIT
"""tests/deploy/test_racine_sans_code_2026_11_22.py — un compte par service, côté root : valeurs des unités validées, droits posés par descripteur services arrêtés, aucun code de l'application sous root ; chaque attaque des relectures rejouée, rien ne se passe."""
from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest

from tests.deploy import test_comptes_separes_2026_11_21 as _cs
from tests.deploy.test_comptes_separes_2026_11_21 import (
    INSTALLE_SEPARE,
    MOI,
    TALONS,
    _droits,
    _etat,
    _executable,
    _harnais,
    _mode,
    _sys,
    _trace,
    _unite,
    _unite_bloc4,
)

depot = _cs.depot

REPO = Path(__file__).resolve().parents[2]
INJECTION = '/srv/x"\nExecStartPre=+/bin/sh -c "id > /root/pwned"\nEnvironment="Y='


def _print(depot: Path, node: str, **env: str) -> subprocess.CompletedProcess:
    """« ./elpis service print » avec un faux Node (FAUX_NODE : son script)."""
    n = _executable(depot / "faux-node", node)
    (depot / "rag_app/qdrant").mkdir(exist_ok=True)
    _executable(depot / "rag_app/qdrant/qdrant", "#!/bin/sh\nexit 0\n")
    e = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(depot), "LANG": "C.UTF-8", "ELPIS_USER": MOI,
         "ELPIS_NODE": str(n), **env}
    return subprocess.run(["bash", str(depot / "elpis"), "service", "print"], env=e, capture_output=True, text=True,
                          timeout=120, cwd=str(depot), stdin=subprocess.DEVNULL)


FAUX_NODE = r'''#!/bin/bash
[ "$1" = -v ] && { echo v24.21.0; exit 0; }
shift
case "$1 $2" in
  "config SANDBOX_DIR") printf '%s\n' "$FAUX_SANDBOX" ;;
  "config DB_PATH") printf '%s\n' "$ELPIS_RACINE/user_db/app.db" ;;
  config*) exit 2 ;;
  *) exit 0 ;;
esac
'''


# B1 — une valeur de config.json à fins de ligne ne devient jamais une ligne d'unité (ExecStartPre=+ sous root).
def test_b1_valeur_injectee_dans_une_unite_refusee(depot):
    (depot / "apps/core/dist/exploitation.mjs").write_text("", encoding="utf-8")
    depot.parent.chmod(0o700)
    r = _print(depot, FAUX_NODE, FAUX_SANDBOX=INJECTION)
    assert r.returncode != 0 and "ExecStartPre" not in r.stdout, r.stdout
    assert "refusé pour une unité systemd" in r.stderr and "rien n'est installé" in r.stderr
    # Sous un compte par service, la même valeur venue de l'environnement est refusée de même.
    depot.parent.chmod(0o711)
    r = _print(depot, FAUX_NODE, APP_SANDBOX_DIR=INJECTION)
    assert r.returncode != 0 and "ExecStartPre" not in r.stdout and "refusé pour une unité systemd" in r.stderr
    r = _print(depot, FAUX_NODE, ADMIN_PUBLIC_URL='http://h/"\nExecStartPre=+/bin/true')
    assert r.returncode != 0 and "ExecStartPre" not in r.stdout


def test_b1_gabarit_rendu_en_une_passe(depot):
    corps = ('declare -A GAB=([BASE]="/srv/@ENV@" [ENV]=$\'Environment="A=1"\\nExecStartPre=+/bin/true\')\n'
             'printf \'X=@BASE@/a\\n@ENV@\\n\' > "$ROOT/g"; _rendre_gabarit "$ROOT/g"')
    r = _harnais(depot, corps, talons="")
    assert r.stdout.splitlines()[0] == "X=/srv/@ENV@/a", r.stdout + r.stderr


# B2 — un lien intermédiaire posé pendant l'arrêt (gestionnaire de SIGTERM de main) n'est jamais suivi par root.
def test_b2_lien_intermediaire_pose_a_l_arret_jamais_suivi(depot):
    _unite_bloc4(depot)
    _etat(depot)
    victime = depot.parent / "victime-etc/system"
    victime.mkdir(parents=True)
    (victime / "sshd.service").write_text("[Service]\n", encoding="utf-8")
    (victime / "sshd.service").chmod(0o644)
    victime.chmod(0o755)
    (depot / "user_db/a/system").mkdir(parents=True)
    (depot / "config.json").write_text(json.dumps({"app": {"sandbox_dir": f"{depot}/user_db/a/system"}}), encoding="utf-8")
    talons = TALONS.replace('cmd_stop() { trace cmd_stop "$COMPTES_ARRET"; }',
                            'cmd_stop() { trace cmd_stop; rm -rf "$ROOT/user_db/a"; ln -s "%s" "$ROOT/user_db/a"; }'
                            % victime.parent)
    r = _harnais(depot, INSTALLE_SEPARE, talons)
    assert r.returncode == 0, r.stdout + r.stderr
    assert (depot / "user_db/a").is_symlink()
    assert {p.name: _mode(p) for p in (victime, victime / "sshd.service")} == {"system": "755", "sshd.service": "644"}
    assert _mode(depot / "user_sandboxes") == "2770"


def test_b2_droits_par_descripteur_lien_et_parent_ouvert_refuses(tmp_path):
    victime = tmp_path / "victime"
    (victime / "system").mkdir(parents=True)
    (victime / "system").chmod(0o755)
    (victime / "system/f").write_text("v", encoding="utf-8")
    (victime / "system/f").chmod(0o644)
    gere = tmp_path / "gere"
    gere.mkdir()
    (gere / "a").symlink_to(victime)
    for args in (("arbre", f"{gere}/a/system", "-", "g+rwX", "g+rwXs"),
                 ("dossier", f"{gere}/a/system", "2770", MOI, "-"),
                 ("fichiers", f"{gere}/a/system", "-", "-", "0666", "f")):
        r = _droits(*args)
        assert r.returncode == 1 and "lien symbolique" in r.stderr, (args, r.stderr)
    assert _mode(victime / "system") == "755" and _mode(victime / "system/f") == "644"
    # Parent d'un dossier traité modifiable par un compte des services : refusé (le test se tient pour ce compte).
    (gere / "d").mkdir()
    (gere / "d/f").write_text("x", encoding="utf-8")
    (gere / "d/f").chmod(0o600)
    r = subprocess.run([sys.executable, "-I", str(REPO / "deploy/droits.py"), "arbre", str(gere / "d"), "-", "g+rw", "-"],
                       capture_output=True, text=True, timeout=60, env={**os.environ, "ELPIS_DROITS_SERVICES": MOI})
    assert r.returncode == 1 and "modifiable par un compte des services" in r.stderr and _mode(gere / "d/f") == "600"


# I1 — sauvegarde et commandes du core sous root : jamais root, toujours le compte de la console, chemins fixés.
NODE_JOURNAL = r'''#!/bin/bash
[ "$1" = -v ] && { echo v24.21.0; exit 0; }
printf '%s|%s|%s|%s\n' "$USER" "${ELPIS_SAUVEGARDE_SUR_SORTIE:-}" "${MCP_SERVERS_DIR:-}" "$*" >> "$JOURNAL_NODE"
case "$2" in backup) printf 'ZIPDONNEES'; exit 3 ;; esac
exit 0
'''


def test_i1_sauvegarde_et_core_sous_la_console_jamais_sous_root(depot):
    for s in ("main", "admin", "toolhost"):
        _unite(depot, s, f"elpis-{s}", "separes")
    journal = depot.parent / "journal-node"
    node = _executable(depot / "faux-node", NODE_JOURNAL)
    (depot / "apps/core/dist/exploitation.mjs").write_text("", encoding="utf-8")
    (depot / "config.json").write_text(json.dumps({"mcp": {"servers_dir": "/etc/nologin"}}), encoding="utf-8")
    (depot / ".env").write_text(f"JOURNAL_NODE={journal}\nELPIS_NODE={node}\n", encoding="utf-8")
    (depot / ".env").chmod(0o600)
    talons = TALONS + 'need_exploitation() { :; }\nnode_bin() { echo "$ELPIS_NODE"; }\n'
    r = _harnais(depot, 'cmd_backup full; echo "rc=$?"; core_cmd config SANDBOX_DIR', talons)
    assert "rc=3" in r.stdout, r.stdout + r.stderr
    archives = list((depot / "backups").glob("backup_complet_*_incomplet.zip"))
    assert len(archives) == 1 and archives[0].read_bytes() == b"ZIPDONNEES" and _mode(archives[0]) == "600"
    lignes = journal.read_text(encoding="utf-8").splitlines()
    assert len(lignes) == 2 and all(l.startswith("elpis-admin|") for l in lignes), lignes
    assert lignes[0].split("|")[1] == "1" and lignes[0].split("|")[2] == f"{depot.parent}/mcp_custom_servers"
    assert [l for l in _trace(depot) if l.startswith("runuser -u elpis-admin -- ")]
    assert not [l for l in _trace(depot) if "=" in l.split(" -- ", 1)[-1].split(" ")[0]], _trace(depot)


def test_i1_demarrage_a_la_main_refuse_sous_root(depot):
    _unite(depot, "main", "elpis-main", "separes")
    for corps in ("cmd_start", "refuser_racine_separee restart; echo continue"):
        r = _harnais(depot, corps)
        assert r.returncode != 0 and "jamais à la main sous root" in r.stderr and "continue" not in r.stdout


def test_i1_env_modifiable_par_d_autres_refuse(depot):
    _unite_bloc4(depot)
    (depot / ".env").write_text("APP_SANDBOX_DIR=/etc\n", encoding="utf-8")
    (depot / ".env").chmod(0o666)
    r = _harnais(depot, INSTALLE_SEPARE)
    assert r.returncode != 0 and ".env refusé" in r.stderr and not [l for l in _trace(depot) if l.startswith("render")]


# I2 — dossiers de .env qui se chevauchent : refusés, ni secrets ni autorité ni journaux privés ouverts au groupe.
@pytest.mark.parametrize("env", ["RAG_STORE_DIR={r}/user_db", "RAG_STORE_DIR={r}/user_db/browser-relay-ca",
                                 "RAG_STORE_DIR={r}/user_db/run/chat_runs", "APP_SANDBOX_DIR={r}/user_db",
                                 "APP_SANDBOX_DIR={r}/user_db/run/chat_runs"])
def test_i2_dossiers_qui_se_chevauchent_refuses(depot, env):
    _unite_bloc4(depot)
    _etat(depot)
    (depot / ".env").write_text(env.format(r=depot) + "\n", encoding="utf-8")
    (depot / ".env").chmod(0o600)
    r = _harnais(depot, INSTALLE_SEPARE)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "refusé" in r.stderr and ("chevauche" in r.stderr or "réservé" in r.stderr), r.stderr
    attendus = {"user_db/.session_secret": "640", "user_db/browser-relay-ca/ca.key": "600",
                "user_db/run/chat_runs": "700", "user_db/run/chat_runs/tour.json": "600", "user_db": "2771"}
    assert {p: _mode(depot / p) for p in attendus} == attendus


def test_i2_chemins_de_config_json_sans_effet_sous_un_compte_par_service(depot):
    _unite_bloc4(depot)
    _etat(depot)
    (depot / "config.json").write_text(json.dumps({"rag": {"store_dir": f"{depot}/user_db"}}), encoding="utf-8")
    r = _harnais(depot, INSTALLE_SEPARE)
    assert r.returncode == 0, r.stdout + r.stderr
    assert {p: _mode(depot / p) for p in ("user_db/.session_secret", "user_db/browser-relay-ca/ca.key")} == {
        "user_db/.session_secret": "640", "user_db/browser-relay-ca/ca.key": "600"}


# Mineurs — jeton du RAG de l'opérateur seul, --prive et entrées des seuls comptes admis, install.sh hors des dossiers des services.
def test_jeton_du_rag_repris_de_l_operateur_seul(tmp_path):
    src, cible = tmp_path / "user_db", tmp_path / "etc"
    src.mkdir()
    cible.mkdir()
    (src / ".rag_service_token").write_text("jeton-operateur\n", encoding="utf-8")
    (src / ".rag_service_token").chmod(0o600)
    autre = next((u for u in ("nobody", "daemon", "bin") if u != MOI), "nobody")
    r = _droits("reprendre", str(src), ".rag_service_token", autre, str(cible / "rag.token"))
    assert r.returncode == 2 and "ignoré" in r.stderr and not (cible / "rag.token").exists()
    assert (src / ".rag_service_token").exists()
    r = _droits("reprendre", str(src), ".rag_service_token", MOI, str(cible / "rag.token"))
    assert r.returncode == 0 and (cible / "rag.token").read_text(encoding="utf-8") == "jeton-operateur\n"
    assert not (src / ".rag_service_token").exists() and _mode(cible / "rag.token") == "600"


def test_prive_et_comptes_seules_les_entrees_des_comptes_admis(tmp_path):
    d = tmp_path / "d"
    (d / "p").mkdir(parents=True)
    (d / "p/f").write_text("x", encoding="utf-8")
    (d / "p/f").chmod(0o660)
    autre = next((u for u in ("nobody", "daemon", "bin") if u != MOI), "nobody")
    assert _droits("arbre", str(d), "-", "-", "-", "--prive", f"{autre}:{d}/p", "--comptes", autre).returncode == 0
    assert _mode(d / "p/f") == "660"
    assert _droits("arbre", str(d), "-", "-", "-", "--prive", f"{MOI}:{d}/p", "--comptes", MOI).returncode == 0
    assert _mode(d / "p/f") == "600"


def test_installeur_sans_chown_dans_les_dossiers_des_services(tmp_path):
    unites, faux, racine = tmp_path / "unites", tmp_path / "bin", tmp_path / "elpis"
    for d in (unites, faux, racine / "system_prompts/sous", racine / "skills/s", racine / "backups", racine / "apps/core"):
        d.mkdir(parents=True)
    _executable(faux / "chown", '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$JOURNAL"\n')
    texte = (REPO / "install.sh").read_text(encoding="utf-8").replace("/etc/systemd/system", str(unites)).splitlines()
    sortie = []
    for nom in ("unites_separees", "chown_depot"):
        debut = next(i for i, l in enumerate(texte) if l.startswith(f"{nom}() {{"))
        fin = debut if texte[debut].rstrip().endswith("}") else next(i for i in range(debut + 1, len(texte)) if texte[i] == "}")
        sortie.extend(texte[debut:fin + 1])
    (unites / "elpis-main.service").write_text('[Service]\nEnvironment="ELPIS_COMPTES=separes"\n', encoding="utf-8")
    journal = tmp_path / "journal"
    subprocess.run(["bash", "-c", "\n".join(sortie) + f'\nROOT="{racine}"; APP_USER="{MOI}"; chown_depot'],
                   env={"PATH": f"{faux}:{os.environ.get('PATH', '/usr/bin:/bin')}", "JOURNAL": str(journal)},
                   capture_output=True, text=True, timeout=60)
    vus = journal.read_text(encoding="utf-8")
    assert f"{racine}/apps/core" in vus and not re.search(r"/(system_prompts|skills|backups)(/|\s|$)", vus), vus


def test_droits_sans_franchir_de_point_de_montage_ni_lien_de_fichier(tmp_path):
    d = tmp_path / "d"
    d.mkdir()
    cible = tmp_path / "cible"
    cible.write_text("c", encoding="utf-8")
    cible.chmod(0o600)
    (d / "lien").symlink_to(cible)
    assert _droits("arbre", str(d), "-", "g+rw", "-").returncode == 0 and _mode(cible) == "600"
    assert stat.S_ISLNK(os.lstat(d / "lien").st_mode)
