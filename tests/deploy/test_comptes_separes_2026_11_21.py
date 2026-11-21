# SPDX-License-Identifier: MIT
"""tests/deploy/test_comptes_separes_2026_11_21.py — un compte par service : modes (séparé, unique, repli), comptes et groupes, droits posés sans suivre de lien, unités rendues, doctor ; « service install » joué sans root sur une base de comptes factice."""
from __future__ import annotations

import getpass
import grp
import os
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
MOI = getpass.getuser()
GROUPE = grp.getgrgid(os.getgid()).gr_name
DOCKER = any(g.gr_name == "docker" for g in grp.getgrall())

# Base de comptes factice (group, passwd de $SYS_PREFIXE/etc) et commandes système simulées, tracées dans $FAUX/trace.
TALONS = r"""
FAUX="$SYS_PREFIXE/etc"
trace() { printf '%s\n' "$*" >> "$FAUX/trace"; }
getent() { [ -f "$FAUX/$1" ] || return 2; if [ $# -ge 2 ]; then grep -E "^$2:" "$FAUX/$1"; else cat "$FAUX/$1"; fi; }
_groupe_de_gid() { awk -F: -v g="$1" '$3 == g { print $1 }' "$FAUX/group"; }
id() {
    local o="" l
    case "${1:-}" in -u|-un|-gn|-nG|-Gn) o="$1"; shift ;; esac
    if [ $# -eq 0 ]; then case "$o" in -u) echo "${FAUX_UID:-0}" ;; -un) echo root ;; *) command id $o ;; esac; return; fi
    l="$(grep -E "^$1:" "$FAUX/passwd")" || return 1
    case "$o" in
        -u) cut -d: -f3 <<< "$l" ;;
        -gn) _groupe_de_gid "$(cut -d: -f4 <<< "$l")" ;;
        -nG) { _groupe_de_gid "$(cut -d: -f4 <<< "$l")"
               awk -F: -v u="$1" '{ n = split($4, m, ","); for (i = 1; i <= n; i++) if (m[i] == u) print $1 }' "$FAUX/group"; } | paste -sd' ' ;;
        *) echo "uid=$(cut -d: -f3 <<< "$l")($1)" ;;
    esac
}
useradd() {
    trace useradd "$@"; local g="" h="" s=""
    while [ $# -gt 1 ]; do case "$1" in --gid) g="$2"; shift 2 ;; --home-dir) h="$2"; shift 2 ;; --shell) s="$2"; shift 2 ;; *) shift ;; esac; done
    echo "$1:x:$((900 + $(wc -l < "$FAUX/passwd"))):$(awk -F: -v g="$g" '$1 == g { print $3 }' "$FAUX/group")::$h:$s" >> "$FAUX/passwd"
}
groupadd() { trace groupadd "$@"; echo "${*: -1}:x:$((800 + $(wc -l < "$FAUX/group"))):" >> "$FAUX/group"; }
_membres() { awk -F: -v OFS=: -v g="$1" -v m="$2" '$1 == g { $4 = m } { print }' "$FAUX/group" > "$FAUX/g.tmp" && mv "$FAUX/g.tmp" "$FAUX/group"; }
gpasswd() { trace gpasswd "$@"; [ "$1" = -M ] && _membres "$3" "$2"; }
usermod() {
    trace usermod "$@"
    case "$1" in
        -aG) _membres "$2" "$(awk -F: -v g="$2" -v u="$3" '$1 == g { print ($4 == "" ? u : $4 "," u) }' "$FAUX/group")" ;;
        -g) awk -F: -v OFS=: -v u="$3" -v g="$(awk -F: -v g="$2" '$1 == g { print $3 }' "$FAUX/group")" '$1 == u { $4 = g } { print }' \
                "$FAUX/passwd" > "$FAUX/p.tmp" && mv "$FAUX/p.tmp" "$FAUX/passwd" ;;
    esac
}
runuser() {
    trace runuser "$@"; while [ "$1" != -- ]; do shift; done; shift
    case " $* " in *" ${FAUX_REFUS:-//} "*) return 1 ;; esac
    "$@"
}
chown() { trace chown "$@"; }; systemctl() { trace systemctl "$@"; }; systemd-tmpfiles() { trace systemd-tmpfiles "$@"; }
install() { trace install "$@"; }; sudo() { :; }
load_runtime() { SANDBOX_DIR="$ROOT/user_sandboxes"; RAG_STORE="$ROOT/user_db/rag"; RAG_CACHE="$ROOT/user_db/rag-cache"; CHART_DIR="$ROOT/user_db/run/charts"; NODE=/bin/true; }
need_core() { :; }
_render_units() {
    trace render "$MODE_COMPTES" "$2"; UNITS_WANTS=(); BASE_DONNEES="$ROOT/user_db"; ECRITURES=""
    printf '[Service]\nUser=%s\nEnvironment="ELPIS_COMPTES=%s"\n' "$([ "$MODE_COMPTES" = separes ] && echo elpis-main || echo "$2")" "$MODE_COMPTES" \
        > "$SYS_PREFIXE/etc/systemd/system/elpis-main.service"
}
audit_setup() { trace audit_setup "$1" "$MODE_COMPTES"; mkdir -p "$SYS_PREFIXE/etc/elpis"; }
ranger_secrets() { trace ranger_secrets "$@"; }
cmd_stop() { trace cmd_stop "$COMPTES_ARRET"; }
# Dossiers créés ici appartiennent au compte des essais : il tient le rôle de root pour dossier_sur.
eval "$(declare -f dossier_sur | sed '1s/^dossier_sur/dossier_sur_vrai/')"
dossier_sur() { dossier_sur_vrai "$1" "$2" "$3" "$4" "${5:-} $MOI"; }
"""


@pytest.fixture
def depot(tmp_ouvert):
    r = tmp_ouvert / "elpis"
    for d in ("deploy/node", "apps/core/dist", "apps/toolhost/dist", "venv/bin", "rag_app", "user_db/run", "logs"):
        (r / d).mkdir(parents=True)
    for f in ("elpis", "deploy/node/node.env", "deploy/node/runtime.sh", "deploy/node/relance.sh", "deploy/prerequis-apt.sh",
              "deploy/prerequis-apt.txt", "deploy/droits.py"):
        shutil.copy2(REPO / f, r / f)
    shutil.copytree(REPO / "deploy/systemd", r / "deploy/systemd")
    (r / "venv/bin/python").symlink_to(sys.executable)
    _executable(r / "venv/bin/uvicorn", "#!/bin/sh\nexit 0\n")
    (r / "config.json").write_text("{}", encoding="utf-8")
    for f in ("apps/core/dist/main.mjs", "apps/toolhost/dist/main.mjs"):
        (r / f).write_text("", encoding="utf-8")
    etc = tmp_ouvert / "sys/etc"
    (etc / "systemd/system").mkdir(parents=True)
    (tmp_ouvert / "sys/var/lib").mkdir(parents=True)
    (etc / "group").write_text(f"root:x:0:\n{GROUPE}:x:{os.getgid()}:\ndocker:x:115:\nsyslog:x:110:\n", encoding="utf-8")
    (etc / "passwd").write_text(f"root:x:0:0::/root:/bin/bash\n{MOI}:x:{os.getuid()}:{os.getgid()}::/nonexistent-{MOI}:/bin/bash\n",
                                encoding="utf-8")
    (etc / "trace").write_text("", encoding="utf-8")
    return r


def _executable(chemin: Path, texte: str) -> Path:
    chemin.write_text(texte, encoding="utf-8")
    chemin.chmod(0o755)
    return chemin


def _sys(depot: Path) -> Path:
    return depot.parent / "sys"


def _env(depot: Path, **env: str) -> dict[str, str]:
    e = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(depot), "LANG": "C.UTF-8", "MOI": MOI,
         "ELPIS_PREFIXE_SYSTEME": str(_sys(depot)), "SUDO_USER": MOI, **env}
    return {k: v for k, v in e.items() if v != ""}


def _harnais(depot: Path, corps: str, talons: str = TALONS, **env: str) -> subprocess.CompletedProcess:
    """Le script entier sans son aiguillage final (variables et fonctions telles quelles), puis TALONS et CORPS."""
    texte = (depot / "elpis").read_text(encoding="utf-8")
    texte = texte[:texte.rindex('\ncase "${1:-}" in\n')]
    h = depot / "harnais"
    h.write_text(texte + "\n" + talons + "\n" + corps + "\n", encoding="utf-8")
    return subprocess.run(["bash", str(h)], env=_env(depot, **env), capture_output=True, text=True, timeout=120,
                          cwd=str(depot), stdin=subprocess.DEVNULL)


def _trace(depot: Path) -> list[str]:
    return (_sys(depot) / "etc/trace").read_text(encoding="utf-8").splitlines()


def _mode(p: Path) -> str:
    return oct(p.stat().st_mode & 0o7777)[2:]


def _unite_bloc4(depot: Path) -> None:
    (_sys(depot) / "etc/systemd/system/elpis-main.service").write_text(f"[Service]\nUser={MOI}\n", encoding="utf-8")


def _etat(depot: Path) -> None:
    """Installation d'un compte unique (bloc 4) : secrets 0600, bac avec son /work et son dossier d'agent, un lien piège."""
    db = depot / "user_db"
    for nom in ("app.db", ".session_secret", ".vault.key", ".local_mcp_token", ".backup_ssh_key", ".backup_known_hosts",
                ".db_password"):
        (db / nom).write_text("x", encoding="utf-8")
        (db / nom).chmod(0o600)
    (db / ".rag_service_token").write_text("r" * 43 + "\n", encoding="utf-8")
    (db / ".rag_service_token").chmod(0o600)
    (db / "rag/source").mkdir(parents=True)
    (db / "rag/source/texte.txt").write_text("t", encoding="utf-8")
    (db / "rag/source/texte.txt").chmod(0o600)
    (db / "browser-relay-ca").mkdir(mode=0o700)
    (db / "browser-relay-ca/ca.key").write_text("k", encoding="utf-8")
    (db / "browser-relay-ca/ca.key").chmod(0o600)
    cible = depot.parent / "cible"
    cible.write_text("secret de l'hôte", encoding="utf-8")
    cible.chmod(0o644)
    (db / "lien").symlink_to(cible)
    bac = depot / "user_sandboxes/alice"
    (bac / "work/projet").mkdir(parents=True)
    (bac / "work/projet/f").write_text("w", encoding="utf-8")
    (bac / "work/projet/f").chmod(0o600)
    (bac / ".elpis-agent").mkdir()
    (bac / ".elpis-agent").chmod(0o1777)
    bac.chmod(0o700)
    (bac / "skills").mkdir()
    (bac / "skills/s.md").write_text("s", encoding="utf-8")
    (bac / "skills/s.md").chmod(0o644)
    (depot / "user_sandboxes").chmod(0o700)
    (depot / "mcp.json").write_text("{}", encoding="utf-8")
    (depot / "mcp.json").chmod(0o600)
    (db / "run/chat_runs").mkdir(parents=True)
    (db / "run/chat_runs").chmod(0o2770)
    (db / "run/chat_runs/tour.json").write_text("{}", encoding="utf-8")
    (db / "run/chat_runs/tour.json").chmod(0o660)
    (depot / "backups").mkdir()
    (depot / "backups").chmod(0o2770)
    (depot / "backups/backup_complet.zip").write_text("z", encoding="utf-8")
    (depot / "backups/backup_complet.zip").chmod(0o660)


INSTALLE_SEPARE = 'dossier_ferme() { return 1; }\nMOI="$MOI"\ncmd_service install'


def test_installation_separee_comptes_groupes_et_droits(depot):
    _unite_bloc4(depot)
    _etat(depot)
    r = _harnais(depot, INSTALLE_SEPARE)
    assert r.returncode == 0, r.stdout + r.stderr
    t = _trace(depot)
    for g in ("elpis-donnees", "elpis-cle", "elpis-journal", "elpis-rag"):
        assert f"groupadd --system {g}" in t
    for s, maison in (("main", "/nonexistent"), ("admin", "/nonexistent"), ("toolhost", "/var/lib/elpis-toolhost")):
        assert (f"useradd --system --gid elpis-donnees --home-dir {maison} --no-create-home --shell /usr/sbin/nologin "
                f"elpis-{s}") in t
        assert f"usermod -aG elpis-journal elpis-{s}" in t
    assert "useradd --system --gid elpis-rag --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin elpis-rag" in t
    assert "gpasswd -M elpis-admin,elpis-main elpis-cle" in t and "gpasswd -M elpis-admin,elpis-main elpis-rag" in t
    assert f"usermod -aG elpis-donnees {MOI}" in t
    assert not any(l.startswith("usermod -aG docker") for l in t), t
    assert f"render separes {MOI}" in t and "audit_setup elpis-main separes" in t
    assert any(l.startswith("runuser -u elpis-main -- test -r ") for l in t)
    assert "systemctl restart elpis.target" in t
    assert "un compte par service (opérateur" in r.stdout
    db = depot / "user_db"
    attendus = {"user_db": "2771", "user_db/app.db": "660", "user_db/.session_secret": "640", "user_db/.vault.key": "640",
                "user_db/.local_mcp_token": "640", "user_db/.db_password": "640", "user_db/.backup_ssh_key": "640",
                "user_db/.backup_known_hosts": "660", "backups/backup_complet.zip": "600", "user_db/run/chat_runs": "700",
                "user_db/run/chat_runs/tour.json": "600",
                "user_db/browser-relay-ca": "700", "user_db/browser-relay-ca/ca.key": "600", "user_sandboxes": "2770",
                "user_sandboxes/alice": "2770", "user_sandboxes/alice/skills/s.md": "664",
                "user_sandboxes/alice/work/projet/f": "600", "user_sandboxes/alice/.elpis-agent": "1777", "logs": "2770",
                "backups": "700", "mcp.json": "640", "config.json": "640", "user_db/rag": "2770",
                "user_db/rag/source": "2770", "user_db/rag/source/texte.txt": "660"}
    assert {p: _mode(depot / p) for p in attendus} == attendus
    assert _mode(depot.parent / "cible") == "644" and (db / "lien").is_symlink()
    conf = _sys(depot) / "etc/elpis/config"
    assert (depot / "config.json").is_symlink() and os.readlink(depot / "config.json") == str(conf / "config.json")
    assert _mode(conf) == "2750" and _mode(conf / "config.json") == "640"
    jeton = _sys(depot) / "etc/elpis/rag.token"
    assert f"ranger_secrets {jeton} elpis-admin" in t and not (db / ".rag_service_token").exists()
    assert jeton.read_text(encoding="utf-8") == "r" * 43 + "\n" and _mode(jeton) == "440"
    secret = (db / ".session_secret").read_text(encoding="utf-8")
    assert re.fullmatch(r"ELPIS_[0-9a-f]{64}", secret), secret
    assert _mode(_sys(depot) / "var/lib/elpis-toolhost") == "700"
    assert re.search(r"^elpis-cle:x:\d+:elpis-admin,elpis-main$", (_sys(depot) / "etc/group").read_text(), re.M)


def test_reinstallation_separee_ne_change_rien(depot):
    _unite_bloc4(depot)
    _etat(depot)
    assert _harnais(depot, INSTALLE_SEPARE).returncode == 0
    contenu = [depot / p for p in ("user_db/app.db", "user_db/.session_secret", "user_db/browser-relay-ca/ca.key",
                                   "user_sandboxes/alice/skills/s.md", "mcp.json", "user_db/rag/source/texte.txt")]
    contenu.append(_sys(depot) / "etc/elpis/rag.token")
    avant = {p: p.stat().st_ctime_ns for p in contenu}
    (_sys(depot) / "etc/trace").write_text("", encoding="utf-8")
    r = _harnais(depot, INSTALLE_SEPARE)
    assert r.returncode == 0, r.stdout + r.stderr
    assert not [l for l in _trace(depot) if l.split()[0] in ("useradd", "groupadd", "gpasswd", "usermod")], _trace(depot)
    assert {p: p.stat().st_ctime_ns for p in contenu} == avant
    assert _mode(depot / "user_db") == "2771" and _mode(depot / "user_db/.session_secret") == "640"


def test_racine_fermee_repli_sous_le_compte_unique(depot):
    _unite_bloc4(depot)
    depot.parent.chmod(0o700)
    r = _harnais(depot, 'MOI="$MOI"\ncmd_service install')
    assert r.returncode == 0, r.stdout + r.stderr
    assert "Un compte par service impossible" in r.stderr and "/opt/elpis" in r.stderr
    t = _trace(depot)
    assert f"render repli {MOI}" in t and f"audit_setup {MOI} repli" in t
    assert not [l for l in t if l.startswith(("useradd", "groupadd"))]
    assert (f"usermod -aG docker {MOI}" in t) and "Le groupe docker équivaut à root" in r.stderr
    assert "compte unique : repli" in r.stdout


def test_code_illisible_par_les_comptes_repli(depot):
    _unite_bloc4(depot)
    r = _harnais(depot, INSTALLE_SEPARE, FAUX_REFUS=str(depot / "elpis"))
    assert r.returncode == 0, r.stdout + r.stderr
    assert f"Un compte par service impossible : {depot}/elpis n'est pas accessible aux autres comptes" in r.stderr
    assert f"render repli {MOI}" in _trace(depot)


def test_compte_unique_choisi_sans_avertissement(depot):
    _unite_bloc4(depot)
    r = _harnais(depot, INSTALLE_SEPARE, ELPIS_COMPTE_UNIQUE="1")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "impossible" not in r.stderr
    t = _trace(depot)
    assert f"render unique {MOI}" in t and not [l for l in t if l.startswith("useradd")]
    assert {p: _mode(depot / p) for p in ("user_db", "logs", "user_sandboxes")} == {"user_db": "700", "logs": "700", "user_sandboxes": "700"}
    conf = _sys(depot) / "etc/elpis/config"
    assert (depot / "config.json").is_symlink() and _mode(conf) == "700" and _mode(conf / "config.json") == "600"
    assert f"install -d -m 700 -o {MOI} {depot}/backups" not in t
    assert f"ranger_secrets {depot}/user_db/.rag_service_token {MOI}" in t


def test_config_deja_rangee_puis_fichier_remis_a_sa_place(depot):
    _unite_bloc4(depot)
    (depot / "config.json.bak").write_text("{}", encoding="utf-8")
    assert _harnais(depot, INSTALLE_SEPARE).returncode == 0
    conf = _sys(depot) / "etc/elpis/config"
    assert (conf / "config.json.bak").is_file() and not (depot / "config.json.bak").exists() and _mode(conf / "config.json.bak") == "600"
    inode = (conf / "config.json").stat().st_ino
    r = _harnais(depot, INSTALLE_SEPARE)
    assert r.returncode == 0 and "lien" not in r.stderr and (conf / "config.json").stat().st_ino == inode
    (depot / "config.json").unlink()
    (depot / "config.json").write_text('{"modifie": true}', encoding="utf-8")
    r = _harnais(depot, INSTALLE_SEPARE)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "a remplacé son lien (modifié en place, il l'emporte)" in r.stderr
    assert (depot / "config.json").is_symlink() and (conf / "config.json").read_text() == '{"modifie": true}'


def test_jeton_du_rag_ecrivable_par_d_autres_ignore(depot):
    _unite_bloc4(depot)
    _etat(depot)
    (depot / "user_db/.rag_service_token").chmod(0o620)
    r = _harnais(depot, INSTALLE_SEPARE)
    assert r.returncode == 0, r.stdout + r.stderr
    assert f"{depot}/user_db/.rag_service_token ignoré (à {MOI}, en 620" in r.stderr
    assert (_sys(depot) / "etc/elpis/rag.token").read_text(encoding="utf-8") != "r" * 43 + "\n"


def test_secret_de_session_garde_si_donne_par_l_environnement(depot):
    _unite_bloc4(depot)
    _etat(depot)
    assert _harnais(depot, INSTALLE_SEPARE, APP_SESSION_SECRET="s" * 48).returncode == 0
    assert (depot / "user_db/.session_secret").read_text(encoding="utf-8") == "x"


def test_config_jamais_deplacee_dans_un_lien(depot):
    _unite_bloc4(depot)
    conf, autre = _sys(depot) / "etc/elpis/config", depot.parent / "autre"
    conf.mkdir(parents=True)
    autre.mkdir()
    (conf / "config.json.bak").symlink_to(autre)
    (depot / "config.json.bak").write_text("{}", encoding="utf-8")
    r = _harnais(depot, INSTALLE_SEPARE)
    assert r.returncode == 0, r.stdout + r.stderr
    assert list(autre.iterdir()) == [] and not (conf / "config.json.bak").is_symlink() and _mode(conf / "config.json.bak") == "600"


FAUX_CONFIGURE = """import json, os, sys
with open(os.environ["JOURNAL"], "a", encoding="utf-8") as f:
    f.write(" ".join(sys.argv[1:]) + "\\n")
if os.environ.get("CODE"):
    sys.exit(int(os.environ["CODE"]))
print(json.dumps({"app.session_secret": "s" * 48, "app.encryption_key": "cle", "rag.service_token": "jeton"}))
"""


def test_secrets_de_config_ecrits_par_root_sans_lien_suivi(depot):
    (depot / "deploy/configure.py").write_text(FAUX_CONFIGURE, encoding="utf-8")
    (depot / "config.json.bak").write_text('{"app": {"session_secret": "ancien"}}', encoding="utf-8")
    journal, cible, etc = depot.parent / "journal", depot.parent / "cible", _sys(depot) / "etc/elpis"
    etc.mkdir(parents=True)
    cible.write_text("hôte", encoding="utf-8")
    corps = (f'PY="{sys.executable}"; MODE_COMPTES=separes; BASE_DONNEES="$ROOT/user_db"\n'
             f'ranger_secrets "{etc}/rag.token" elpis-admin; echo "rc=$?"')
    talons = TALONS.replace('ranger_secrets() { trace ranger_secrets "$@"; }\n', "")
    r = _harnais(depot, corps, talons, JOURNAL=str(journal))
    assert "rc=0" in r.stdout, r.stderr
    db = depot / "user_db"
    assert {f: (db / f).read_text(encoding="utf-8") for f in (".session_secret", ".encryption_key")} == {
        ".session_secret": "s" * 48 + "\n", ".encryption_key": "cle\n"}
    assert (etc / "rag.token").read_text(encoding="utf-8") == "jeton\n" and _mode(db / ".encryption_key") == "600"
    assert journal.read_text(encoding="utf-8").splitlines() == ["--ranger-secrets --sortie -"]
    assert any(l.startswith("runuser -u elpis-admin -- ") for l in _trace(depot)) and not (depot / "config.json.bak").exists()
    (db / ".encryption_key").unlink()
    (db / ".encryption_key").symlink_to(cible)
    journal.unlink()
    r = _harnais(depot, corps, talons, JOURNAL=str(journal))
    assert "rc=1" in r.stdout and "secrets laissés dans config.json" in r.stderr and not journal.exists()
    assert cible.read_text(encoding="utf-8") == "hôte"
    (db / ".encryption_key").unlink()
    r = _harnais(depot, corps, talons, JOURNAL=str(journal), CODE="2")
    assert "rc=1" in r.stdout and "code 2" in r.stderr and not (db / ".encryption_key").exists()


def test_lien_de_config_illisible_message_clair(depot):
    (depot / "config.json").unlink()
    (depot / "config.json").symlink_to(depot.parent / "absent/config.json")
    r = _harnais(depot, "charger_instance", talons="")
    assert r.returncode != 0 and "config.json illisible pour ce compte" in r.stderr and "elpis-donnees" in r.stderr


def test_dossier_ferme_premier_dossier_sans_traversee(tmp_path):
    ferme = tmp_path / "ferme"
    (ferme / "ouvert").mkdir(parents=True)
    ferme.chmod(0o700)
    (ferme / "ouvert").chmod(0o755)
    try:
        r = _harnais_simple(f'dossier_ferme "{ferme}/ouvert"; echo "rc=$?"; dossier_ferme /usr/bin; echo "rc=$?"')
    finally:
        ferme.chmod(0o755)
    assert r.stdout.splitlines() == [str(ferme), "rc=0", "rc=1"]


def _harnais_simple(corps: str) -> subprocess.CompletedProcess:
    texte = (REPO / "elpis").read_text(encoding="utf-8").splitlines()
    noms = [m[1] for l in texte if (m := re.match(r"^([a-z_]+)\(\) \{", l))]
    sortie = []
    for nom in noms:
        debut = next(i for i, l in enumerate(texte) if l.startswith(f"{nom}() {{"))
        fin = debut if texte[debut].rstrip().endswith("}") and texte[debut].count("{") == texte[debut].count("}") \
            else next(i for i in range(debut + 1, len(texte)) if texte[i] == "}")
        sortie.extend(texte[debut:fin + 1])
    return subprocess.run(["bash", "-c", "set -uo pipefail\n" + "\n".join(sortie) + "\n" + corps], capture_output=True,
                          text=True, timeout=60, env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8"})


@pytest.mark.parametrize("comptes,membres,primaire,attendu", [
    ("elpis-main elpis-admin", "elpis-admin,elpis-main", "", 0),
    ("elpis-main elpis-admin", "elpis-admin,elpis-main,intrus", "", 1),
    ("elpis-main elpis-admin", "elpis-main", "intrus", 1),
    ("seul", "", "", 0),
])
def test_groupe_propre_a_plusieurs_comptes(depot, comptes, membres, primaire, attendu):
    etc = _sys(depot) / "etc"
    with (etc / "group").open("a", encoding="utf-8") as f:
        f.write(f"elpis-cle:x:984:{membres}\n")
    if primaire:
        with (etc / "passwd").open("a", encoding="utf-8") as f:
            f.write(f"{primaire}:x:1500:984::/nonexistent:/usr/sbin/nologin\n")
    r = _harnais(depot, f'groupe_propre elpis-cle "{comptes}"; echo "rc=$?"')
    assert f"rc={attendu}" in r.stdout, r.stdout + r.stderr


def _unite(depot: Path, service: str, compte: str, mode: str | None) -> None:
    ligne = f'Environment="ELPIS_COMPTES={mode}"\n' if mode else ""
    (_sys(depot) / f"etc/systemd/system/elpis-{service}.service").write_text(f"[Service]\nUser={compte}\n{ligne}", encoding="utf-8")


def test_comptes_et_mode_des_unites_installees(depot):
    r = _harnais(depot, 'echo "[$(compte_services)] [$(mode_installe)]"')
    assert "[] []" in r.stdout
    for s in ("main", "admin", "toolhost"):
        _unite(depot, s, f"elpis-{s}", "separes")
    _unite(depot, "rag", MOI, None)
    r = _harnais(depot, 'echo "[$(compte_services)] [$(mode_installe)] [$(compte_unique)]"')
    assert f"[elpis-main elpis-admin elpis-toolhost {MOI}] [separes] []" in r.stdout
    _unite_bloc4(depot)
    r = _harnais(depot, 'echo "[$(mode_installe)] [$(compte_unique)]"')
    assert f"[ancien] [{MOI}" in r.stdout


@pytest.mark.parametrize("mode,niveau,texte,bad", [
    ("separes", "[ ok  ]", "comptes des services : un par service (elpis-main, elpis-admin, elpis-toolhost)", None),
    ("unique", "[elpis]", "un seul compte, choisi (ELPIS_COMPTE_UNIQUE=1)", 0),
    ("repli", "[warn ]", "un seul compte (repli", 1),
    (None, "[warn ]", "unités d'avant les comptes séparés) : sudo ./elpis service install", 1),
])
def test_doctor_mode_des_comptes(depot, mode, niveau, texte, bad):
    _unite(depot, "main", "elpis-main" if mode == "separes" else MOI, mode)
    r = _harnais(depot, 'core_cmd() { :; }; bad=0; doctor_comptes; echo "bad=$bad"', talons="")
    sortie = r.stdout + r.stderr
    assert any(niveau in l and texte in l for l in sortie.splitlines()), sortie
    if mode == "repli":
        assert "/opt/elpis" in sortie and "docs/operations.md" in sortie
    if bad is not None:
        assert f"bad={bad}" in r.stdout
    else:
        assert "droits : " in r.stderr and "attendu 2771 root elpis-donnees" in r.stderr


def test_doctor_cles_du_mode_separe(depot):
    for s in ("main", "admin", "toolhost"):
        _unite(depot, s, f"elpis-{s}", "separes")
    etc = _sys(depot) / "etc/elpis"
    etc.mkdir()
    for nom in ("audit.key", "vault.key"):
        (etc / nom).write_text("k" * 64, encoding="utf-8")
        (etc / nom).chmod(0o440)
    talons = ('compte_lit() { echo "lit $1 $2" >> "$SYS_PREFIXE/lus"; return 0; }\n'
              'groupe_propre() { echo "propre $1 [$2]" >> "$SYS_PREFIXE/lus"; return 0; }\nvault_core() { :; }\n'
              f'stat() {{ case "$*" in *" -- "*.key) echo "440 root {GROUPE}" ;; *) command stat "$@" ;; esac; }}')
    r = _harnais(depot, 'bad=0; doctor_cle "elpis-main elpis-admin elpis-toolhost" syslog; doctor_coffre; echo "bad=$bad"',
                 talons=talons)
    vus = (_sys(depot) / "lus").read_text(encoding="utf-8").splitlines()
    assert f"propre {GROUPE} [elpis-main elpis-admin elpis-toolhost syslog]" in vus
    assert f"propre {GROUPE} [elpis-main elpis-admin]" in vus
    for c in ("elpis-main", "elpis-admin", "elpis-toolhost"):
        assert f"lit {c} {etc}/audit.key" in vus
    assert f"lit elpis-toolhost {etc}/vault.key" not in vus and f"lit elpis-admin {etc}/vault.key" in vus
    assert "bad=0" in r.stdout, r.stdout + r.stderr


def test_doctor_sauvegardes_privees_au_mode_seul(depot):
    _unite(depot, "main", "elpis-main", "separes")
    corps = 'core_cmd() { :; }; bad=0; doctor_comptes; echo "bad=$bad"'
    (depot / "backups").mkdir()
    (depot / "backups").chmod(0o700)
    r = _harnais(depot, corps, talons="")
    assert f"{depot}/backups" not in r.stderr, r.stderr
    (depot / "backups").chmod(0o2770)
    r = _harnais(depot, corps, talons="")
    assert f"droits : {depot}/backups en 2770 " in r.stderr and "(attendu 700 : sudo ./elpis service install)" in r.stderr


def test_vault_core_sous_la_console_en_mode_separe(depot):
    _unite(depot, "main", "elpis-main", "separes")
    r = _harnais(depot, 'NODE=/bin/node; vault_core vault status',
                 talons='id() { [ "$*" = -u ] && echo 0 || command id "$@"; }\nrunuser() { echo "runuser $*"; }')
    assert "runuser -u elpis-admin -- env " in r.stdout and "ELPIS_GROUPE_DONNEES=elpis-donnees" in r.stdout, r.stderr


def test_audit_setup_du_mode_separe(depot, tmp_path):
    for s in ("main", "admin", "toolhost"):
        _unite(depot, s, f"elpis-{s}", "separes")
    audit = _sys(depot) / "var/lib/elpis/audit"
    audit.mkdir(parents=True)
    (audit / "audit-2026-01-01.jsonl").write_text("{}\n", encoding="utf-8")
    (audit / "audit-2026-01-01.jsonl").chmod(0o640)
    faux = tmp_path / "bin"
    faux.mkdir()
    _executable(faux / "id", '#!/bin/bash\n[ "$*" = "-u elpis-main" ] && { echo 999; exit 0; }\nexec /usr/bin/id "$@"\n')
    r = subprocess.run(["bash", str(depot / "elpis"), "audit", "setup"], capture_output=True, text=True, timeout=60,
                       env=_env(depot, PATH=f"{faux}:{os.environ.get('PATH', '/usr/bin:/bin')}"), cwd=str(depot),
                       stdin=subprocess.DEVNULL)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "Journal de sécurité en place (un compte par service)." in r.stdout
    s = _sys(depot)
    assert {p: _mode(s / p) for p in ("var/lib/elpis/audit", "var/log/elpis", "etc/elpis", "etc/elpis/audit.key",
                                      "var/lib/elpis/audit/audit-2026-01-01.jsonl")} == {
        "var/lib/elpis/audit": "2770", "var/log/elpis": "2770", "etc/elpis": "751", "etc/elpis/audit.key": "440",
        "var/lib/elpis/audit/audit-2026-01-01.jsonl": "660"}


def _unites(depot: Path, **env: str) -> dict[str, str]:
    node = _executable(depot / "faux-node", '#!/bin/sh\n[ "$1" = -v ] && { echo v24.21.0; exit 0; }\nexit 0\n')
    (depot / "rag_app/qdrant").mkdir(exist_ok=True)
    _executable(depot / "rag_app/qdrant/qdrant", "#!/bin/sh\nexit 0\n")
    e = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(depot), "LANG": "C.UTF-8", "ELPIS_USER": MOI,
         "ELPIS_NODE": str(node), **env}
    r = subprocess.run(["bash", str(depot / "elpis"), "service", "print"], env={k: v for k, v in e.items() if v != ""},
                       capture_output=True, text=True, timeout=120, cwd=str(depot), stdin=subprocess.DEVNULL)
    assert r.returncode == 0, r.stderr
    return {m[1]: m[2] for m in re.finditer(r"^### (\S+)\n(.*?)(?=^### |\Z)", r.stdout, re.S | re.M)}


def test_unites_du_mode_separe(depot):
    u = _unites(depot)
    for s in ("main", "admin", "toolhost"):
        lignes = u[f"elpis-{s}.service"].splitlines()
        assert f"User=elpis-{s}" in lignes and "UMask=0007" in lignes, s
        assert ('Environment="ELPIS_GROUPE_CLE=elpis-cle"' in lignes) is (s != "toolhost"), s
        assert 'Environment="ELPIS_COMPTES=separes"' in lignes and 'Environment="ELPIS_GROUPE_DONNEES=elpis-donnees"' in lignes
        assert ("SupplementaryGroups=docker" in lignes) is (s == "toolhost" and DOCKER), s
    for s in ("main", "admin"):
        lignes = u[f"elpis-{s}.service"].splitlines()
        assert "ReadWritePaths=/run/elpis" in lignes and not any(l.startswith("ReadOnlyPaths=") for l in lignes), s
        for d in ("user_db", "logs", "system_prompts", "skills", "user_skins", "user_skills", "user_sandboxes"):
            assert f"ReadWritePaths=-{depot}/{d}" in lignes, (s, d)
        assert f"ReadWritePaths=-{depot}/backups" not in lignes, s
        assert ("ReadWritePaths=-/etc/elpis/config" in lignes) is (s == "admin"), s
        assert not any(l in (f"ReadWritePaths={depot}", f"ReadWritePaths=-{depot}") for l in lignes), s
    for s in ("rag", "qdrant"):
        lignes = u[f"elpis-{s}.service"].splitlines()
        assert "UMask=0077" in lignes and not any("ELPIS_COMPTES" in l or "GROUPE_DONNEES" in l for l in lignes), s
    rag = u["elpis-rag.service"].splitlines()
    assert {"User=elpis-rag", "CacheDirectory=elpis-rag", 'Environment="RAG_CACHE_DIR=/var/cache/elpis-rag"',
            'Environment="RAG_SERVICE_TOKEN_FILE=/etc/elpis/rag.token"'} <= set(rag)
    assert not any(l.startswith("ReadWritePaths") for l in rag) and not any("RestrictSUIDSGID" in l or "DynamicUser" in l for l in rag)
    assert u["tmpfiles.d/elpis.conf"].strip().splitlines()[-1] == "d /run/elpis 2770 root elpis-donnees -"
    assert f"InaccessiblePaths=-{depot}/user_db/.session_secret -{depot}/user_db/.encryption_key" \
        in u["elpis-toolhost.service"].splitlines()


def test_unites_du_compte_unique_choisi(depot):
    u = _unites(depot, ELPIS_COMPTE_UNIQUE="1")
    for s, umask in (("main", "0027"), ("admin", "0027"), ("toolhost", "0022"), ("rag", "0027"), ("qdrant", "0077")):
        lignes = u[f"elpis-{s}.service"].splitlines()
        assert f"User={MOI}" in lignes and f"UMask={umask}" in lignes, s
        assert not any("SupplementaryGroups" in l or "ELPIS_GROUPE_" in l for l in lignes), s
        assert ('Environment="ELPIS_COMPTES=unique"' in lignes) is (s in ("main", "admin", "toolhost")), s
    assert u["tmpfiles.d/elpis.conf"].strip().splitlines()[-1] == f"d /run/elpis 0700 {MOI} {GROUPE} -"


def test_navigateurs_des_bacs_donnes_a_l_hote_d_outils(depot):
    (depot / "browser-service/node_modules").mkdir(parents=True)
    u = _unites(depot, PLAYWRIGHT_BROWSERS_PATH="/srv/navigateurs")
    assert 'Environment="PLAYWRIGHT_BROWSERS_PATH=/srv/navigateurs"' in u["elpis-toolhost.service"].splitlines()
    assert "PLAYWRIGHT" not in u["elpis-main.service"]


def _cache_playwright(depot: Path) -> Path:
    """Service navigateur installé, cache de Playwright dans la maison de l'opérateur (programme 0700, marqueur 0600)."""
    (depot / "browser-service/node_modules").mkdir(parents=True)
    maison = depot.parent / "maison"
    cache = maison / ".cache/ms-playwright"
    shell = cache / "chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell"
    shell.parent.mkdir(parents=True)
    _executable(shell, "#!/bin/sh\n").chmod(0o700)
    (cache / "chromium_headless_shell-1255/INSTALLATION_COMPLETE").write_text("", encoding="utf-8")
    (cache / "chromium_headless_shell-1255/INSTALLATION_COMPLETE").chmod(0o600)
    (cache / ".links").mkdir()
    passwd = _sys(depot) / "etc/passwd"
    passwd.write_text(passwd.read_text(encoding="utf-8").replace(f"/nonexistent-{MOI}", str(maison)), encoding="utf-8")
    return cache


def test_navigateurs_hors_de_portee_copies_pour_l_hote_d_outils(depot):
    _unite_bloc4(depot)
    cache = _cache_playwright(depot)
    copie = _sys(depot) / "var/lib/elpis-toolhost/ms-playwright"
    corps = INSTALLE_SEPARE + '\necho "nav=$(_navigateurs "$MOI")"'
    r = _harnais(depot, corps, FAUX_REFUS=str(cache))
    assert r.returncode == 0, r.stdout + r.stderr
    assert f"render separes {MOI}" in _trace(depot) and f"nav={copie}" in r.stdout
    assert f"Navigateurs de Playwright copiés dans {copie}" in r.stdout
    shell = "chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell"
    marqueur = "chromium_headless_shell-1255/INSTALLATION_COMPLETE"
    assert {p: _mode(copie / p) for p in (".", ".links", "chromium_headless_shell-1255", shell, marqueur)} == {
        ".": "755", ".links": "755", "chromium_headless_shell-1255": "755", shell: "755", marqueur: "644"}
    assert any(l.startswith("chown -R elpis-toolhost:elpis-donnees -- ") for l in _trace(depot))
    assert not [p for p in (_sys(depot) / "var/lib").iterdir() if p.name.startswith(".")]
    avant = (copie / shell).stat().st_ctime_ns
    r = _harnais(depot, corps, FAUX_REFUS=str(cache))
    assert "copiés" not in r.stdout and f"nav={copie}" in r.stdout and (copie / shell).stat().st_ctime_ns == avant
    (cache / "ffmpeg-1011").mkdir()
    r = _harnais(depot, corps, FAUX_REFUS=str(cache))
    assert "copiés" in r.stdout and (copie / "ffmpeg-1011").is_dir() and (copie / shell).is_file()
    r = _harnais(depot, corps)
    assert f"nav={cache}" in r.stdout and "copiés" not in r.stdout
    r = _harnais(depot, corps, FAUX_REFUS=str(cache), PLAYWRIGHT_BROWSERS_PATH=str(cache))
    assert r.returncode == 0 and f"nav={cache}" in r.stdout and "copiés" not in r.stdout
    assert f"PLAYWRIGHT_BROWSERS_PATH ({cache}) hors de portée de elpis-toolhost" in r.stderr


def test_dossiers_d_etat_acceptes_ou_refuses_pour_root(depot):
    hors, maison, srv = depot.parent / "hors", depot.parent / "maison", depot.parent / "srv"
    for d in (hors, maison, srv, _sys(depot) / "etc/elpis/config"):
        d.mkdir(parents=True)
    (depot.parent / "lien").symlink_to(hors)
    passwd = _sys(depot) / "etc/passwd"
    passwd.write_text(passwd.read_text(encoding="utf-8").replace(f"/nonexistent-{MOI}", str(maison)), encoding="utf-8")
    attendus = {f"{depot}": "non", f"{depot}/deploy": "non", f"{depot}/user_db/rag": "oui", f"{depot}/logs": "oui",
                f"{depot.parent}": "non", "/": "non", f"{maison}": "non", f"{_sys(depot)}/etc/elpis/config": "non",
                f"{depot}/user_db/../deploy": "non", f"{depot.parent}/lien": "non", f"{hors}": "non",
                f"{depot.parent}/absent": "non", f"{depot.parent}/mcp_custom_servers": "oui", f"{srv}": "oui"}
    corps = (f'stat() {{ if [ "$*" = "-c %U:%G -- {srv}" ]; then echo root:elpis-donnees; else command stat "$@"; fi; }}\n'
             + "".join(f'dossier_etat_sur "{c}" && echo "oui {c}" || echo "non {c}"\n' for c in attendus)
             + f'dossier_etat_sur "{depot}/deploy" || true\nCOMPTE_ETAT="$MOI"; dossier_etat_sur "{hors}/" && echo "unique oui"')
    r = _harnais(depot, corps)
    assert {l.split(" ", 1)[1]: l.split(" ", 1)[0] for l in r.stdout.splitlines() if l[:4] in ("oui ", "non ")} == attendus
    assert "unique oui" in r.stdout and r.stderr.count(f"Dossier {depot}/deploy refusé (dans le dépôt") == 1, r.stderr


def test_ecritures_des_unites_sans_dossier_refuse(depot):
    corps = ('MODE_COMPTES=separes; SANDBOX_DIR="$ROOT/user_sandboxes"; RAG_STORE="$ROOT/user_db/rag"; CHART_DIR="$ROOT/user_db/run/charts"\n'
             '_ecritures_du_service main "$(printf \'main admin\\t%s\' "$ROOT/deploy")"')
    lignes = _harnais(depot, corps).stdout.splitlines()
    assert f"ReadWritePaths=-{depot}/user_sandboxes" in lignes and not any(f"{depot}/deploy" in l for l in lignes), lignes


def test_chemins_de_config_hors_des_dossiers_surs_sans_effet_sous_root(depot):
    _unite_bloc4(depot)
    _etat(depot)
    victime = depot.parent / "victime"
    victime.mkdir()
    victime.chmod(0o755)
    (victime / "f").write_text("v", encoding="utf-8")
    (victime / "f").chmod(0o644)
    (victime / ".encryption_key").symlink_to(depot.parent / "cible")
    avant = {d: _mode(d) for d in (depot / "deploy", depot / "deploy/node", victime, victime / "f")}
    rendu = ('_render_units() { trace render "$MODE_COMPTES" "$2"; UNITS_WANTS=(); BASE_DONNEES=""\n'
             f"""    ECRITURES="$(printf 'main admin\t%s\nmain admin\t%s' "$ROOT/deploy" "{victime}")"\n"""
             """    printf '[Service]\nUser=elpis-main\nEnvironment="ELPIS_COMPTES=separes"\n' > "$SYS_PREFIXE/etc/systemd/system/elpis-main.service"; }\n""")
    r = _harnais(depot, INSTALLE_SEPARE.replace("cmd_service install", rendu + "cmd_service install"))
    assert r.returncode == 0, r.stdout + r.stderr
    assert {d: _mode(d) for d in avant} == avant
    assert (depot.parent / "cible").read_text(encoding="utf-8") == "secret de l'hôte" and not (victime / ".session_secret").exists()
    assert f"Dossier {depot}/deploy refusé (dans le dépôt" in r.stderr and f"Dossier {victime} refusé (à {MOI}" in r.stderr


def test_base_de_confiance_d_app_db_path_ou_de_user_db(depot):
    corps = ('base_sure "$ROOT/user_db"; echo "[1]"; base_sure /ailleurs; echo "[2]"; APP_DB_PATH=/ailleurs/app.db; base_sure /ailleurs\n'
             'echo "[3]"; APP_DB_PATH=donnees/app.db; base_sure "$ROOT/donnees"')
    r = _harnais(depot, corps, talons="")
    assert r.stdout.split() == [f"{depot}/user_db", "[1]", "[2]", "/ailleurs", "[3]", f"{depot}/donnees"], r.stderr
    assert "Base de config.json (/ailleurs) non confirmée par APP_DB_PATH" in r.stderr


def test_retour_au_compte_unique_rend_les_dossiers_d_etat(depot):
    _unite_bloc4(depot)
    _etat(depot)
    assert _harnais(depot, INSTALLE_SEPARE).returncode == 0
    r = _harnais(depot, INSTALLE_SEPARE, ELPIS_COMPTE_UNIQUE="1")
    assert r.returncode == 0, r.stdout + r.stderr
    attendus = {"user_db": "700", "user_db/rag": "700", "user_db/.session_secret": "600",
                "user_sandboxes": "700", "user_sandboxes/alice": "770", "user_sandboxes/alice/.elpis-agent": "1777",
                "user_sandboxes/alice/work/projet/f": "600", "logs": "700", "user_db/run/chat_runs": "700"}
    assert {p: _mode(depot / p) for p in attendus} == attendus


def test_installeur_garde_les_dossiers_d_etat_sous_des_unites_separees(tmp_path):
    unites, faux, racine = tmp_path / "unites", tmp_path / "bin", tmp_path / "elpis"
    for d in (unites, faux, racine / "user_db/run", racine / "logs", racine / "user_skins", racine / "user_sandboxes/alice/work",
              racine / "apps/core"):
        d.mkdir(parents=True)
    _executable(faux / "chown", '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$JOURNAL"\n')
    texte = (REPO / "install.sh").read_text(encoding="utf-8").replace("/etc/systemd/system", str(unites)).splitlines()
    sortie = []
    for nom in ("unites_separees", "chown_depot"):
        debut = next(i for i, l in enumerate(texte) if l.startswith(f"{nom}() {{"))
        fin = debut if texte[debut].rstrip().endswith("}") else next(i for i in range(debut + 1, len(texte)) if texte[i] == "}")
        sortie.extend(texte[debut:fin + 1])
    journal = tmp_path / "journal"
    env = {"PATH": f"{faux}:{os.environ.get('PATH', '/usr/bin:/bin')}", "JOURNAL": str(journal)}
    lancer = lambda: subprocess.run(["bash", "-c", "\n".join(sortie) + f'\nROOT="{racine}"; APP_USER="{MOI}"; chown_depot'],  # noqa: E731
                                    env=env, capture_output=True, text=True, timeout=60)
    lancer()
    vus = journal.read_text(encoding="utf-8")
    assert f"-h {MOI}: " in vus and f"{racine}/user_db/run" in vus and f"{MOI}: {racine}/user_sandboxes" in vus
    journal.unlink()
    (unites / "elpis-main.service").write_text('[Service]\nEnvironment="ELPIS_COMPTES=separes"\n', encoding="utf-8")
    lancer()
    vus = journal.read_text(encoding="utf-8")
    assert f"-h {MOI} " in vus and f"{racine}/apps/core" in vus and f"{MOI}:" not in vus
    assert not any(d in vus for d in ("/user_db", "/logs", "/user_skins", "/user_sandboxes")), vus


def test_sauvegarde_et_mise_a_jour_sous_root_en_mode_separe(depot):
    _unite(depot, "main", "elpis-main", "separes")
    talons = TALONS + """
charger_env() { :; }; charger_instance() { :; }; need_exploitation() { :; }; poser_droits() { echo "droits $*"; }
core_cmd() { echo "core $*"; mkdir -p "$ROOT/backups"; : > "$ROOT/backups/backup_full.zip"; return 3; }
"""
    r = _harnais(depot, "cmd_backup full", talons=talons, FAUX_UID="1000")
    assert r.returncode != 0 and "lancez sudo ./elpis backup full" in r.stderr and "core " not in r.stdout
    r = _harnais(depot, 'cmd_backup full; echo "rc=$?"', talons=talons)
    assert "core backup full" in r.stdout and "rc=3" in r.stdout, r.stderr
    assert f"droits arbre {depot}/backups {GROUPE} go-rwx go-rwxs --proprio {MOI} --comptes root" in r.stdout
    maj = talons + 'git() { case "$*" in *pull*) return 1 ;; esac; }\nsudo() { echo "sudo $*"; }\nload_runtime() { :; }\n'
    r = _harnais(depot, "cmd_upgrade", talons=maj, FAUX_UID="1000")
    assert f"sudo {depot}/elpis backup full" in r.stdout and "core " not in r.stdout, r.stdout + r.stderr


def test_compte_de_service_existant_hors_comptes_systeme_refuse(depot):
    _unite_bloc4(depot)
    passwd = _sys(depot) / "etc/passwd"
    passwd.write_text(passwd.read_text(encoding="utf-8") + "elpis-admin:x:1500:1500::/srv/admin:/bin/bash\n", encoding="utf-8")
    r = _harnais(depot, INSTALLE_SEPARE)
    assert r.returncode != 0 and "elpis-admin existe déjà sans être un compte système sans shell" in r.stderr
    assert not [l for l in _trace(depot) if l.startswith("render")]


def test_apercu_des_unites_en_repli_comme_l_installation(depot):
    depot.parent.chmod(0o700)
    lignes = _unites(depot)["elpis-main.service"].splitlines()
    assert f"User={MOI}" in lignes and 'Environment="ELPIS_COMPTES=repli"' in lignes


def _droits(*args: str, entree: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-I", str(REPO / "deploy/droits.py"), *args], capture_output=True, text=True,
                          timeout=60, input=entree)


@pytest.mark.parametrize("spec,mode,dossier,attendu", [
    ("g+rwX,o-rwx", 0o600, False, 0o660), ("g+rwX,o-rwx", 0o755, False, 0o770), ("g+rwXs,o-rwx", 0o700, True, 0o2770),
    ("g+rwX", 0o644, False, 0o664), ("u+rwX,g+rX,g-w,o-rwx", 0o664, False, 0o640), ("0640", 0o777, False, 0o640),
    ("-", 0o600, False, 0o600), ("g+s", 0o644, False, 0o644),
])
def test_droits_modes_symboliques(spec, mode, dossier, attendu):
    sys.path.insert(0, str(REPO / "deploy"))
    try:
        import droits
    finally:
        sys.path.pop(0)
    assert droits.modes(spec, mode, dossier) == attendu


def test_droits_sans_lien_suivi_ni_lien_physique_ni_sauf(tmp_path):
    d = tmp_path / "d"
    (d / "sous/work").mkdir(parents=True)
    (d / "f").write_text("f", encoding="utf-8")
    (d / "f").chmod(0o600)
    (d / "sous/work/w").write_text("w", encoding="utf-8")
    (d / "sous/work/w").chmod(0o600)
    cible = tmp_path / "cible"
    cible.write_text("c", encoding="utf-8")
    cible.chmod(0o600)
    (d / "lien").symlink_to(cible)
    (d / "double").write_text("x", encoding="utf-8")
    (d / "double").chmod(0o600)
    os.link(d / "double", tmp_path / "double2")
    r = _droits("arbre", str(d), GROUPE, "g+rwX,o-rwx", "g+rwXs,o-rwx", "--sauf", "work")
    assert r.returncode == 1 and "plusieurs liens physiques" in r.stderr
    assert {p: _mode(d / p) for p in ("f", "sous", "sous/work", "sous/work/w", "double")} == {
        "f": "660", "sous": "2770", "sous/work": _mode(d / "sous/work"), "sous/work/w": "600", "double": "600"}
    assert _mode(cible) == "600"
    avant = (d / "f").stat().st_ctime_ns
    os.unlink(tmp_path / "double2")
    assert _droits("arbre", str(d), GROUPE, "g+rwX,o-rwx", "g+rwXs,o-rwx", "--sauf", "work").returncode == 0
    assert (d / "f").stat().st_ctime_ns == avant


def test_droits_secret_cree_garde_remplace_refuse(tmp_path):
    assert _droits("secret", str(tmp_path), ".s").returncode == 0
    texte = (tmp_path / ".s").read_text(encoding="ascii")
    assert re.fullmatch(r"ELPIS_[0-9a-f]{64}", texte) and _mode(tmp_path / ".s") == "600"
    assert _droits("secret", str(tmp_path), ".s").returncode == 0 and (tmp_path / ".s").read_text() == texte
    (tmp_path / ".court").write_text("court", encoding="utf-8")
    assert _droits("secret", str(tmp_path), ".court").returncode == 0 and len((tmp_path / ".court").read_text()) == 70
    cible = tmp_path / "cible"
    cible.write_text("c", encoding="utf-8")
    (tmp_path / ".lien").symlink_to(cible)
    r = _droits("secret", str(tmp_path), ".lien")
    assert r.returncode == 1 and "lien ou fichier spécial" in r.stderr and cible.read_text() == "c"


def test_droits_retirent_setuid_et_setgid_des_fichiers(tmp_path):
    (tmp_path / "f").write_text("x", encoding="utf-8")
    os.chmod(tmp_path / "f", 0o6755)
    assert _droits("arbre", str(tmp_path), "-", "g+w", "-").returncode == 0
    assert _mode(tmp_path / "f") == "775"


def test_droits_ranger_ecrit_les_secrets_sans_suivre_de_lien(tmp_path):
    base, cible = tmp_path / "base", tmp_path / "cible"
    base.mkdir()
    cible.write_text("hôte", encoding="utf-8")
    (base / ".encryption_key").symlink_to(cible)
    valeurs = '{"app.session_secret": "%s", "app.encryption_key": "cle", "rag.service_token": "jeton", "autre": "x"}' % ("s" * 48)
    r = _droits("ranger", str(base), str(tmp_path / "rag.token"), entree=valeurs)
    assert r.returncode == 1 and "lien ou fichier spécial" in r.stderr and cible.read_text(encoding="utf-8") == "hôte"
    assert (base / ".session_secret").read_text(encoding="utf-8") == "s" * 48 + "\n" and _mode(base / ".session_secret") == "600"
    assert (tmp_path / "rag.token").read_text(encoding="utf-8") == "jeton\n" and sorted(os.listdir(base)) == [".encryption_key", ".session_secret"]
    avant = (base / ".session_secret").stat().st_ctime_ns
    (base / ".encryption_key").unlink()
    assert _droits("ranger", str(base), str(tmp_path / "rag.token"), entree=valeurs).returncode == 0
    assert (base / ".session_secret").stat().st_ctime_ns == avant and (base / ".encryption_key").read_text(encoding="utf-8") == "cle\n"


def test_droits_fichiers_par_motif_et_comptes(tmp_path):
    (tmp_path / "a.jsonl").write_text("a", encoding="utf-8")
    (tmp_path / "b.txt").write_text("b", encoding="utf-8")
    (tmp_path / "b.txt").chmod(0o600)
    (tmp_path / "sous.jsonl").mkdir(mode=0o700)
    assert _droits("fichiers", str(tmp_path), "-", GROUPE, "0660", "*.jsonl").returncode == 0
    assert [_mode(tmp_path / n) for n in ("a.jsonl", "b.txt", "sous.jsonl")] == ["660", "600", "700"]
    assert _droits("fichiers", str(tmp_path / "absent"), "-", GROUPE, "0660", "*").returncode == 0
    (tmp_path / "e").mkdir()
    (tmp_path / "e/x").write_text("x", encoding="utf-8")
    (tmp_path / "e/x").chmod(0o600)
    assert _droits("arbre", str(tmp_path / "e"), GROUPE, "g+rw", "-", "--comptes", "personne-ici").returncode == 0
    assert _mode(tmp_path / "e/x") == "600"
    assert _droits("arbre", str(tmp_path / "e"), GROUPE, "g+rw", "-", "--comptes", MOI).returncode == 0
    assert _mode(tmp_path / "e/x") == "660"


def test_installeur_sans_compte_unique_ni_docker_pour_les_services(tmp_path):
    unites = tmp_path / "unites"
    unites.mkdir()
    texte = (REPO / "install.sh").read_text(encoding="utf-8").replace("/etc/systemd/system", str(unites)).splitlines()
    sortie = []
    for nom in ("unites_separees", "compte_des_unites", "docker_au_compte"):
        debut = next(i for i, l in enumerate(texte) if l.startswith(f"{nom}() {{"))
        fin = debut if texte[debut].rstrip().endswith("}") else next(i for i in range(debut + 1, len(texte)) if texte[i] == "}")
        sortie.extend(texte[debut:fin + 1])
    script = "\n".join(sortie) + ('\nsystemctl() { return 1; }\necho "[$(compte_des_unites)]"\n'
                                  'AFTER=service; docker_au_compte; echo "service=$?"; AFTER=start; docker_au_compte; echo "start=$?"')
    lancer = lambda: subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=60,  # noqa: E731
                                    env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")})
    (unites / "elpis-main.service").write_text(f"[Service]\nUser={MOI}\n", encoding="utf-8")
    r = lancer()
    assert r.stdout.splitlines() == [f"[{MOI}]", "service=1", "start=0"], r.stderr
    (unites / "elpis-main.service").write_text('[Service]\nUser=elpis-main\nEnvironment="ELPIS_COMPTES=separes"\n',
                                               encoding="utf-8")
    assert lancer().stdout.splitlines()[0] == "[]"
