# SPDX-License-Identifier: MIT
"""tests/deploy/test_racine_terminal_2026_11_22.py — troisième relecture, côté ./elpis : noms à fins de ligne, terminal de root jamais confié et ptrace limité, sortie du core vérifiée, lectures de root bornées, motifs en locale C ; chaque attaque rejouée, rien ne se passe."""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from tests.deploy import test_comptes_separes_2026_11_21 as _cs
from tests.deploy.test_comptes_separes_2026_11_21 import (
    INSTALLE_SEPARE,
    MOI,
    TALONS,
    _executable,
    _harnais,
    _sys,
    _trace,
    _unite,
)

depot = _cs.depot
REPO = Path(__file__).resolve().parents[2]
CLE_SSH = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGVYQUxQTEVLRVlCQVNFNjRDSEFSU0FMTE9LT0tPSw attaquant"
DROITS = [sys.executable, "-I", str(REPO / "deploy/droits.py")]


# 1 — nom de fichier à fins de ligne (lien de logs/audit, fichier de run/chat_runs) : une seule ligne à l'écran et au journal.
def test_1_noms_a_fins_de_ligne_sur_une_seule_ligne(depot, tmp_path):
    nom = f"audit-\n{CLE_SSH}\n\x1b]52;c;QQ==\x07.jsonl"
    r = _harnais(depot, 'warn "$NOM : lien symbolique ou fichier spécial, laissé (à vérifier)."; info "$NOM"', talons="", NOM=nom)
    assert len(r.stderr.splitlines()) == 1 and len(r.stdout.splitlines()) == 1, r.stderr
    assert CLE_SSH in r.stderr and "\x1b]52" not in r.stderr + r.stdout and "\x07" not in r.stderr
    # deploy/droits.py : fichier à deux liens physiques sous run/chat_runs, au nom choisi par main.
    d = tmp_path / "chat_runs"
    d.mkdir()
    (d / f"x\n{CLE_SSH}").write_text("x", encoding="utf-8")
    os.link(d / f"x\n{CLE_SSH}", tmp_path / "second")
    r = subprocess.run([*DROITS, "arbre", str(d), "-", "g+rw", "-"], capture_output=True, text=True, timeout=60)
    assert "plusieurs liens physiques" in r.stderr and not [l for l in r.stderr.splitlines() if l.startswith("ssh-ed25519")]


# 2 — enfants de root sous un compte : ni son terminal (TIOCSTI, /dev/tty) ni ses descripteurs ; ptrace limité ; sortie du core non crue.
SONDE = r'''#!/bin/bash
# runuser factice : note ce qu'il reçoit de root (terminal ou non), puis la commande après « -- », sous ce compte.
if [ -n "${VU:-}" ]; then
    { [ -t 0 ] && echo "entree:terminal" || echo "entree:autre"
      [ -t 1 ] && echo "sortie:terminal" || echo "sortie:autre"
      ( exec 3</dev/tty ) 2>/dev/null && echo "tty:ouvert" || echo "tty:aucun"; } >> "$VU.r"
fi
while [ "$1" != -- ]; do shift; done; shift
exec "$@"
'''
ENFANT = r'''#!/bin/bash
{ [ -t 0 ] && echo "entree:terminal" || echo "entree:autre"
  [ -t 1 ] && echo "sortie:terminal" || echo "sortie:autre"
  ( exec 3</dev/tty ) 2>/dev/null && echo "tty:ouvert" || echo "tty:aucun"
  echo "umask:$(umask)"; } > "$VU"
printf 'clair \033]52;c;QQ==\007fin\n'
'''


@pytest.mark.skipif(shutil.which("script") is None or shutil.which("setsid") is None, reason="script ou setsid absents")
def test_2_enfants_de_root_sans_son_terminal(depot, tmp_path):
    _unite(depot, "main", "elpis-main", "separes")
    faux = tmp_path / "bin"
    faux.mkdir()
    _executable(faux / "runuser", SONDE)
    enfant = _executable(tmp_path / "enfant", ENFANT)
    texte = (depot / "elpis").read_text(encoding="utf-8")
    talons = ('id() { [ "$*" = -u ] && echo 0 || command id "$@"; }\ncharger_env_sur() { ENV_CHARGE=1; }\n'
              # PATH construit par env_console : le runuser factice d'abord (le vrai demande root).
              f'eval "$(declare -f env_console | sed \'1s/^env_console/env_console_vrai/\')"\n'
              f'env_console() {{ env_console_vrai | sed "s#^PATH=#PATH={faux}:#"; }}\n')
    attendu = {"entree:autre", "sortie:autre", "tty:aucun"}
    for i, corps in enumerate((f'app_console --env "VU=$VU" "{enfant}"', f'en_compte {MOI} "{enfant}"',
                               f'chemin_refuse {MOI} x "{enfant}"; compte_lit {MOI} "{enfant}"')):
        vu = tmp_path / f"vu{i}"
        h = depot / f"harnais-{i}"
        h.write_text(texte[:texte.rindex('\ncase "${1:-}" in\n')] + "\n" + talons + "\n" + corps + "\n", encoding="utf-8")
        env = {**_cs._env(depot), "PATH": f"{faux}:{os.environ.get('PATH', '/usr/bin:/bin')}", "VU": str(vu)}
        r = subprocess.run(["script", "-qec", f"bash {h}", "/dev/null"], env=env, capture_output=True, text=True,
                           timeout=60, stdin=subprocess.DEVNULL)
        if i < 2:
            assert vu.exists(), (corps, r.stdout, r.stderr)
            assert attendu <= set(vu.read_text(encoding="utf-8").split()), (corps, vu.read_text(encoding="utf-8"))
            assert "clair fin" in r.stdout and "]52" not in r.stdout, r.stdout
        else:
            notes = Path(f"{vu}.r").read_text(encoding="utf-8").split()
            assert len(notes) == 6 and set(notes) == attendu, notes
    assert "umask:0007" in (tmp_path / "vu0").read_text(encoding="utf-8")


def test_2_ptrace_limite_aux_descendants(depot):
    yama = _sys(depot) / "proc/sys/kernel/yama"
    yama.mkdir(parents=True)
    conf = _sys(depot) / "etc/sysctl.d/05-elpis-ptrace.conf"
    conf.parent.mkdir(parents=True)
    _cs._unite_bloc4(depot)
    _cs._etat(depot)
    (yama / "ptrace_scope").write_text("0\n", encoding="utf-8")
    r = _harnais(depot, INSTALLE_SEPARE)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "kernel.yama.ptrace_scope = 1" in conf.read_text(encoding="utf-8")
    assert f"sysctl -q -p {conf}" in _trace(depot)
    # Plus strict déjà (2) : jamais abaissé ; retiré au retrait des services.
    conf.unlink()
    (yama / "ptrace_scope").write_text("2\n", encoding="utf-8")
    assert _harnais(depot, INSTALLE_SEPARE).returncode == 0 and not conf.exists()
    conf.write_text("kernel.yama.ptrace_scope = 1\n", encoding="utf-8")
    r = _harnais(depot, "unit_dir=$SYS_PREFIXE/etc/systemd/system; ptrace_restreint retire")
    assert not conf.exists(), r.stderr
    (yama / "ptrace_scope").write_text("0\n", encoding="utf-8")
    _unite(depot, "main", "elpis-main", "separes")
    r = _harnais(depot, "bad=0; doctor_comptes; echo bad=$bad", talons=TALONS + "chemins_separes() { CHEMINS_FIXES=(x=y); }\n"
                 "avertir_chemins_config() { :; }\n")
    assert "ptrace non limité" in r.stderr, r.stderr


FAUX_NODE_UNITE = r'''#!/bin/bash
[ "$1" = -v ] && { echo v24.21.0; exit 0; }
case "$*" in *"lanceur unite-base"*) echo debug-shell.service ;; *"lanceur ecoute"*) echo 127.0.0.1 ;; esac
exit 0
'''


def test_2_unite_de_la_base_hors_de_la_liste_refusee(depot):
    depot.parent.chmod(0o711)
    node = _executable(depot / "faux-node", FAUX_NODE_UNITE)
    (depot / "apps/core/dist/exploitation.mjs").write_text("", encoding="utf-8")
    (depot / "rag_app/qdrant").mkdir(exist_ok=True)
    _executable(depot / "rag_app/qdrant/qdrant", "#!/bin/sh\nexit 0\n")
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(depot), "LANG": "C.UTF-8", "ELPIS_USER": MOI,
           "ELPIS_NODE": str(node)}
    r = subprocess.run(["bash", str(depot / "elpis"), "service", "print"], env=env, capture_output=True, text=True,
                       timeout=120, cwd=str(depot), stdin=subprocess.DEVNULL)
    assert r.returncode != 0 and "debug-shell" not in r.stdout and "Unité de la base" in r.stderr, r.stdout + r.stderr


# 4 — lectures de root hors de app_console : config.json mené vers une FIFO ou /dev/zero, conseils du moteur.
def test_4_config_json_vers_une_fifo_ou_dev_zero_sans_effet(depot):
    conf = _sys(depot) / "etc/elpis/config"
    conf.mkdir(parents=True)
    (depot / "config.json").unlink()
    (depot / "config.json").symlink_to(conf / "config.json")
    os.mkfifo(conf / "config.json")
    corps = ("conf_json 'try: print(conf(sys.argv[1]))\nexcept Exception as e: print(\"refus\", type(e).__name__)' "
             '"$ROOT/config.json"')
    r = _harnais(depot, corps, talons="app_cmd() { \"$@\"; }", FAUX_UID="1000")
    assert r.stdout.strip() == "refus ValueError", r.stdout + r.stderr
    (conf / "config.json").unlink()
    (conf / "config.json").symlink_to("/dev/zero")
    r = _harnais(depot, corps, talons="app_cmd() { \"$@\"; }", FAUX_UID="1000")
    assert r.stdout.strip() == "refus OSError", r.stdout + r.stderr
    # Sous root et un compte par service : par la console (app_console), jamais sous root.
    _unite(depot, "main", "elpis-main", "separes")
    r = _harnais(depot, corps, talons='id() { [ "$*" = -u ] && echo 0 || command id "$@"; }\napp_console() { echo "console $1 $2 $3"; }')
    assert r.stdout.startswith("console timeout 20 "), r.stdout + r.stderr
    assert "json.load(open(" not in (REPO / "elpis").read_text(encoding="utf-8")


def test_4_fichier_pid_fifo_sans_attente_sous_root(depot):
    run = depot / "user_db/run"
    os.mkfifo(run / "main.pid")
    r = _harnais(depot, 'pid_of main; echo "rc=$?"', talons='id() { [ "$*" = -u ] && echo 0 || command id "$@"; }')
    assert r.stdout.strip() == "rc=1", r.stdout + r.stderr
    (run / "main.pid").unlink()
    (run / "main.pid").write_text(f"{os.getpid()}\n", encoding="utf-8")
    r = _harnais(depot, 'pid_of main', talons='id() { [ "$*" = -u ] && echo 0 || command id "$@"; }')
    assert r.stdout.strip() == str(os.getpid())


# 5 — mineurs : motifs en locale C, commande d'unité absolue, signal jamais au groupe sous root, flux filtrés, base SQLite des services.
def test_5_motifs_en_locale_c_et_commande_absolue(depot):
    texte = (REPO / "elpis").read_text(encoding="utf-8")
    assert [l for l in texte.splitlines() if "=~" in l] == ["motif() { local LC_ALL=C; [[ $1 =~ $2 ]]; }"]
    r = _harnais(depot, "motif 'é' '^[A-Za-z]$' && echo oui || echo non; motif 'Ａ' '^[A-Za-z]+$' && echo oui || echo non",
                 talons="", LANG="C.UTF-8", LC_ALL="C.UTF-8")
    assert r.stdout.split() == ["non", "non"]
    fonctions = _fonctions_elpis("_render_units", "_rendre_gabarit", "_ecritures_du_service", "_protection_home",
                                 "_chemin_unite", "_valeur_unite", "_mot_unite", "_env_unite_sure", "_chemins_hors_depot",
                                 "_nettoyer_rendu", "_compte_unite", "_umask_unite", "_env_comptes", "motif")
    talons = """
info() { printf '[elpis] %s\\n' "$*"; }; warn() { printf '[warn ] %s\\n' "$*" >&2; }; die() { printf '[err  ] %s\\n' "$*" >&2; exit 1; }
load_runtime() { :; }; need_core() { :; }; _db_local_unit() { :; }; _https_enabled() { return 1; }
svc_available() { :; }; chemin_etat_sur() { :; }; base_sure() { printf '%s\\n' "$1"; }
svc_spec() { SPEC_DIR="$ROOT"; SPEC_CMD=(+/bin/sh -c id); SPEC_ENV=(); }
core_cmd() { :; }; lanceur() { :; }
SERVICES=(main); VAULT_KEY_SYS=/etc/elpis/vault.key; AUDIT_KEY_SYS=/etc/elpis/audit.key; CONFIG_SYS=/etc/elpis/config
SANDBOX_DIR=/srv/bacs; RAG_STORE=/srv/rag; RAG_CACHE=/srv/rag-cache; CHART_DIR=/srv/g; AUDIT_DIR_SYS=/a; APPLOG_DIR_SYS=/l; NODE=/n
"""
    sortie = depot.parent / "unites-plus"
    sortie.mkdir()
    r = subprocess.run(["bash", "-c", f"set -uo pipefail\nROOT={depot}; RUN_DIR=$ROOT/user_db/run; LOG_DIR=$ROOT/logs; UNIT_PREFIX=elpis\n"
                        + fonctions + talons + f'_render_units "{sortie}" {MOI}'], capture_output=True, text=True, timeout=60,
                       env={"PATH": os.environ["PATH"], "LANG": "C.UTF-8"}, cwd=str(depot))
    assert r.returncode != 0 and "chemin absolu attendu" in r.stderr and list(sortie.iterdir()) == [], r.stderr


def _fonctions_elpis(*noms: str) -> str:
    texte = (REPO / "elpis").read_text(encoding="utf-8").splitlines()
    sortie = []
    for nom in noms:
        debut = next(i for i, l in enumerate(texte) if l.startswith(f"{nom}() {{"))
        fin = debut if texte[debut].rstrip().endswith("}") and texte[debut].count("{") <= texte[debut].count("}") \
            else next(i for i in range(debut + 1, len(texte)) if texte[i] == "}")
        sortie.extend(texte[debut:fin + 1])
    return "\n".join(sortie) + "\n"


def test_5_signal_jamais_au_groupe_sous_root_et_flux_filtres(depot):
    talons = 'kill() { echo "kill $*"; }\nid() { [ "$*" = -u ] && echo "${FAUX_UID:-0}" || command id "$@"; }'
    assert _harnais(depot, "signaler TERM 4242", talons=talons).stdout.strip() == "kill -s TERM 4242"
    assert _harnais(depot, "signaler TERM 4242", talons=talons, FAUX_UID="1000").stdout.strip() == "kill -s TERM -- -4242"
    (depot / "logs/main.log").write_text("ligne \x1b[1;32mverte\x1b[0m \x1b]52;c;QQ==\x07\x1b[2Jfin\x7f\n", encoding="utf-8")
    r = _harnais(depot, "cmd_logs main", talons='systemd_active() { return 1; }\nid() { [ "$*" = -u ] && echo 0 || command id "$@"; }')
    assert "ligne \x1b[1;32mverte\x1b[0m fin?" in r.stdout and "]52" not in r.stdout and "\x1b[2J" not in r.stdout, r.stdout
