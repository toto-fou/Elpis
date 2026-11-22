# SPDX-License-Identifier: MIT
"""tests/deploy/test_racine_filtre_2026_11_22.py — quatrième relecture : filtre en une passe (rien de retiré ne se recolle) toujours appliqué aux sorties d'un compte, tube et pseudo-terminal compris, configure de l'installeur sur le terminal, config.json et journaux lus par root sans lien ni attente ; chaque attaque rejouée, rien ne se passe."""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
from pathlib import Path

import pytest

from tests.deploy import test_comptes_separes_2026_11_21 as _cs
from tests.deploy.test_comptes_separes_2026_11_21 import _executable, _harnais, _sys, _unite

depot = _cs.depot
REPO = Path(__file__).resolve().parents[2]
FILTRE = ["python3", "-I", str(REPO / "deploy/droits.py"), "filtre"]


# A — paires imbriquées (C1 en UTF-8 ou brut, ESC, OSC) : rien ne se recolle en séquence.
@pytest.mark.parametrize("entree", [b"A\xc2\xc2\x9b\x9b2JB\n", b"X\xc2\xc2\x9d\x9d0;PWNED\xc2\xc2\x9c\x9cY\n",
                                    b"A\x9b2JB\n", b"A\x1b\x1b[2JB\x1b[\x1b[2JC\x1b]\x1b]52;c;QQ==\x07D\n",
                                    b"\x01\xc2\x02\x9b2J\x1b\x01[2J\n", b"\xc2\x9d" + b"8;;http://x\xc2\x9c" * 2 + b"\n"])
def test_a_filtre_en_une_passe(entree):
    sortie = subprocess.run(FILTRE, input=entree, capture_output=True, timeout=30).stdout
    assert re.sub(rb"\x1b\[[0-9;]*m", b"", sortie).count(b"\x1b") == 0, sortie
    assert not re.search(rb"\xc2[\x80-\x9f]", sortie) and not re.search(rb"(?<![\xc2-\xf4])[\x80-\x9f]", sortie), sortie


def test_a_filtre_garde_le_texte_et_les_couleurs():
    texte = "é Ā 日本 🎉\tfin\r\n\x1b[1;32mvert\x1b[0m\n".encode()
    assert subprocess.run(FILTRE, input=texte, capture_output=True, timeout=30).stdout == texte
    # Écran de l'assistant (pseudo-terminal) : CSI gardées, chaînes et C1 retirées.
    tui = subprocess.run([*FILTRE, "--tui"], input=b"\x1b[2J\x1b[H\x1b]52;c;QQ==\x07\xc2\x9b2J\x1b7ok\n",
                         capture_output=True, timeout=30).stdout
    assert tui == b"\x1b[2J\x1b[H\x1b7ok\n"


# B — sorties d'un compte filtrées même vers un tube (journal de l'installeur), pseudo-terminal de configure filtré.
ENFANT = "#!/bin/bash\nprintf 'clair \\033]52;c;QQ==\\007 \\033[2J \\302\\302\\233\\2332J fin\\n'\n"
RUNUSER = '#!/bin/bash\nwhile [ "$1" != -- ]; do shift; done; shift\nexec "$@"\n'


def test_b_sorties_d_un_compte_filtrees_vers_un_tube(depot, tmp_path):
    faux = tmp_path / "bin"
    faux.mkdir()
    _executable(faux / "runuser", RUNUSER)
    enfant = _executable(tmp_path / "enfant", ENFANT)
    path = f"{faux}:{os.environ.get('PATH', '/usr/bin:/bin')}"
    # Entrée fermée : la commande tourne quand même.
    r = _harnais(depot, f'_hors_terminal runuser -u x -- "{enfant}" 0<&-; echo "rc=$?"', talons="", PATH=path)
    assert "clair" in r.stdout and "fin" in r.stdout and "rc=0" in r.stdout, r.stdout + r.stderr
    assert "\x1b" not in r.stdout and "52;c" not in r.stdout and "\xc2" not in r.stdout
    texte = (REPO / "install.sh").read_text(encoding="utf-8")
    assert 'exec > >(python3 -I "$ROOT/deploy/droits.py" filtre | tee -a "$JOURNAL_INSTALL") 2>&1' in texte
    # Pseudo-terminal de sudo ./elpis configure : relayé par le filtre --tui.
    _unite(depot, "main", "elpis-main", "separes")
    talons = ('id() { [ "$*" = -u ] && echo 0 || command id "$@"; }\ncharger_env_sur() { ENV_CHARGE=1; }\n'
              f'eval "$(declare -f env_console | sed \'1s/^env_console/env_console_vrai/\')"\n'
              f'env_console() {{ env_console_vrai | sed "s#^PATH=#PATH={faux}:#"; }}\n')
    r = _harnais(depot, f'app_console --terminal "{enfant}"', talons=talons, PATH=path)
    assert "clair" in r.stdout and "\x1b[2J" in r.stdout and "52;c" not in r.stdout and "\xc2" not in r.stdout, r.stdout


# C — configure lancé par l'installeur interactif : sur le terminal (questions), pas sur le tube du journal.
def test_c_configure_de_l_installeur_sur_le_terminal():
    texte = (REPO / "install.sh").read_text(encoding="utf-8")
    assert '"$ROOT/elpis" configure "${cfg_args[@]}" </dev/tty >/dev/tty 2>&1 ||' in texte
    assert "questions et réponses à l'écran seulement, hors du journal" in texte
    assert ".install.log" in (REPO / ".gitignore").read_text(encoding="utf-8").splitlines()


# Mineurs — config.json mené vers un périphérique ou une FIFO (agit à l'ouverture) : jamais ouvert ; journaux lus sous root bornés ; PID par service.
def _ouvert_par(lancer, fifo: Path, temoin: Path) -> bool:
    ecrivain = subprocess.Popen(["bash", "-c", f'echo x > "{fifo}" && touch "{temoin}"'])
    try:
        lancer()
        time.sleep(0.5)
        return temoin.exists()
    finally:
        ecrivain.kill()
        ecrivain.wait()


def test_conf_json_jamais_ouvert_au_travers_d_un_lien(depot, tmp_path):
    conf = _sys(depot) / "etc/elpis/config"
    conf.mkdir(parents=True)
    fifo, temoin = tmp_path / "peripherique", tmp_path / "ouvert"
    os.mkfifo(fifo)
    corps = 'conf_json \'try: print(conf(sys.argv[1]))\nexcept Exception as e: print("refus", type(e).__name__)\' "$ROOT/config.json"'
    (depot / "config.json").unlink()
    (depot / "config.json").symlink_to(fifo)
    r = []
    assert not _ouvert_par(lambda: r.append(_harnais(depot, corps, talons='app_cmd() { "$@"; }', FAUX_UID="1000")), fifo, temoin)
    assert r[0].stdout.strip() == "refus ValueError", r[0].stdout + r[0].stderr
    (depot / "config.json").unlink()
    (depot / "config.json").symlink_to(conf / "config.json")
    (conf / "config.json").symlink_to(fifo)
    r = []
    assert not _ouvert_par(lambda: r.append(_harnais(depot, corps, talons='app_cmd() { "$@"; }', FAUX_UID="1000")), fifo, temoin)
    assert r[0].stdout.strip() == "refus OSError", r[0].stdout + r[0].stderr
    # L'installeur lit de même (lien de service install seulement, fichier final sans lien).
    texte = (REPO / "install.sh").read_text(encoding="utf-8")
    assert 'os.readlink(p) != "/etc/elpis/config/config.json"' in texte and "os.O_NOFOLLOW | os.O_NONBLOCK" in texte



def test_conf_json_lit_une_grande_configuration_entiere(depot):
    # Une configuration de plus de 4 Mio (images intégrées) se lit entière ; au-delà de 64 Mio, refus.
    grand = {"executors": {"allow_sudo": False}, "remplissage": "x" * (5 << 20)}
    (depot / "config.json").write_text(json.dumps(grand), encoding="utf-8")
    corps = 'conf_json \'print((conf(sys.argv[1]).get("executors") or {}).get("allow_sudo"))\' "$ROOT/config.json"'
    r = _harnais(depot, corps, talons='app_cmd() { "$@"; }', FAUX_UID="1000")
    assert r.stdout.strip() == "False", r.stdout + r.stderr
    texte = (REPO / "install.sh").read_text(encoding="utf-8")
    assert "st.st_size > 64 << 20" in texte and "os.read(fd, 4 << 20)" not in texte

def test_journaux_sous_root_bornes_et_filtres(depot):
    logs = depot / "logs"
    os.mkfifo(logs / "rag.log")
    (logs / "main.log").write_text("".join(f"l{i}\n" for i in range(80)) + "\x1b]52;c;QQ==\x07fin\n", encoding="utf-8")
    talons = 'systemd_active() { return 1; }\nid() { [ "$*" = -u ] && echo 0 || command id "$@"; }'
    r = _harnais(depot, "cmd_logs", talons=talons)
    assert "l29" not in r.stdout and "l79" in r.stdout and "fin" in r.stdout and "\x1b]" not in r.stdout, r.stdout
    assert "rag.log : absent, lien ou fichier spécial" in r.stderr
    # Un seul compte, sans sudo : comme avant (tail).
    r = _harnais(depot, "cmd_logs main", talons="systemd_active() { return 1; }", FAUX_UID="1000")
    assert "\x1b]52" in r.stdout
