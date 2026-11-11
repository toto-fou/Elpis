# SPDX-License-Identifier: MIT
"""tests/deploy/test_audit_setup_2026_11_08.py — « ./elpis audit setup » rejoué sans root dans une arborescence factice (ELPIS_PREFIXE_SYSTEME), et ses fonctions voisines extraites du script."""
from __future__ import annotations

import getpass
import grp
import os
import pwd
import re
import shutil
import subprocess
import time
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
MOI = getpass.getuser()


def _existe(compte: str) -> bool:
    try:
        pwd.getpwnam(compte)
        return True
    except KeyError:
        return False


AUTRE = next((u for u in ("nobody", "daemon", "bin") if u != MOI and _existe(u)), None)


@pytest.fixture
def depot(tmp_path):
    r = tmp_path / "elpis"
    for d in ("deploy/node", "logs/audit", "user_db/run"):
        (r / d).mkdir(parents=True)
    for f in ("elpis", "deploy/node/node.env", "deploy/node/runtime.sh", "deploy/prerequis-apt.sh",
              "deploy/prerequis-apt.txt"):
        shutil.copy2(REPO / f, r / f)
    (tmp_path / "sys").mkdir()
    return r


def _sys(depot: Path) -> Path:
    return depot.parent / "sys"


def _env(depot: Path, **env: str) -> dict[str, str]:
    e = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(depot), "LANG": "C.UTF-8",
         "ELPIS_PREFIXE_SYSTEME": str(_sys(depot)), "ELPIS_USER": MOI, **env}
    return {k: v for k, v in e.items() if v != ""}


def _setup(depot: Path, **env: str) -> subprocess.CompletedProcess:
    return subprocess.run(["bash", str(depot / "elpis"), "audit", "setup"], env=_env(depot, **env),
                          capture_output=True, text=True, timeout=60, cwd=str(depot), stdin=subprocess.DEVNULL)


def _mode(p: Path) -> str:
    return oct(p.stat().st_mode & 0o7777)[2:]


def _fonctions(*noms: str) -> str:
    """Corps des fonctions NOMS du script, comme le charger.sh des essais en conteneur."""
    texte = (REPO / "elpis").read_text(encoding="utf-8").splitlines()
    sortie = []
    for nom in noms:
        debut = next(i for i, l in enumerate(texte) if l.startswith(f"{nom}() {{"))
        fin = debut if texte[debut].rstrip().endswith("}") and texte[debut].count("{") == texte[debut].count("}") \
            else next(i for i in range(debut + 1, len(texte)) if texte[i] == "}")
        sortie.extend(texte[debut:fin + 1])
    return "\n".join(sortie)


def _bash(depot: Path, fonctions: str, corps: str, **env: str) -> subprocess.CompletedProcess:
    tete = f"""set -uo pipefail
info() {{ printf '[elpis] %s\\n' "$*"; }}; ok() {{ printf '[ ok  ] %s\\n' "$*"; }}
warn() {{ printf '[warn ] %s\\n' "$*" >&2; }}; die() {{ printf '[err  ] %s\\n' "$*" >&2; exit 1; }}
SYS_PREFIXE="$ELPIS_PREFIXE_SYSTEME"; AUDIT_DIR_SYS="$SYS_PREFIXE/var/lib/elpis/audit"
AUDIT_KEY_SYS="$SYS_PREFIXE/etc/elpis/audit.key"; APPLOG_DIR_SYS="$SYS_PREFIXE/var/log/elpis"
GROUPE_JOURNAL=elpis-journal; GROUPE_CLE=elpis-cle; UNIT_PREFIX=elpis
ROOT={depot}; RUN_DIR="$ROOT/user_db/run"; LOG_DIR="$ROOT/logs"; SERVICES=(main); SERVICES_RETIRES=()
"""
    return subprocess.run(["bash", "-c", tete + fonctions + "\n" + corps], env=_env(depot, **env),
                          capture_output=True, text=True, timeout=60, cwd=str(depot), stdin=subprocess.DEVNULL)


def _unite(depot: Path, compte: str) -> None:
    d = _sys(depot) / "etc/systemd/system"
    d.mkdir(parents=True, exist_ok=True)
    (d / "elpis-main.service").write_text(f"[Service]\nUser={compte}\n", encoding="utf-8")


def test_premier_passage_dossiers_cle_et_fichiers_deplaces(depot):
    ancien = depot / "logs/audit/audit-2026-01-01.jsonl"
    ancien.write_text('{"v":1}\n', encoding="utf-8")
    r = _setup(depot)
    assert r.returncode == 0, r.stderr
    assert "Journal de sécurité en place" in r.stdout
    s = _sys(depot)
    assert {p: _mode(s / p) for p in ("var/lib/elpis", "var/lib/elpis/audit", "var/log/elpis", "etc/elpis",
                                      "etc/elpis/audit.key")} == {
        "var/lib/elpis": "755", "var/lib/elpis/audit": "2750", "var/log/elpis": "2750", "etc/elpis": "750",
        "etc/elpis/audit.key": "440"}
    assert re.fullmatch(r"[0-9a-f]{64}", (s / "etc/elpis/audit.key").read_text(encoding="utf-8"))
    deplace = s / "var/lib/elpis/audit/audit-2026-01-01.jsonl"
    assert not ancien.exists() and deplace.read_text(encoding="utf-8") == '{"v":1}\n'
    assert _mode(deplace) == "640"


def test_second_passage_garde_la_cle_et_reapplique_les_droits(depot):
    assert _setup(depot).returncode == 0
    s = _sys(depot)
    cle = (s / "etc/elpis/audit.key").read_text(encoding="utf-8")
    fichier = s / "var/lib/elpis/audit/audit-2026-01-01.jsonl"
    fichier.write_text("{}\n", encoding="utf-8")
    fichier.chmod(0o666)
    (s / "var/lib/elpis/audit").chmod(0o700)
    (s / "etc/elpis/audit.key").chmod(0o600)
    r = _setup(depot)
    assert r.returncode == 0, r.stderr
    assert (s / "etc/elpis/audit.key").read_text(encoding="utf-8") == cle
    assert [_mode(p) for p in (fichier, s / "var/lib/elpis/audit", s / "etc/elpis/audit.key")] == ["640", "2750", "440"]


def test_lien_vers_un_autre_dossier_refuse_sans_toucher_la_cible(depot, tmp_path):
    cible = tmp_path / "cible"
    cible.mkdir(mode=0o755)
    (_sys(depot) / "var/log").mkdir(parents=True)
    (_sys(depot) / "var/log/elpis").symlink_to(cible)
    r = _setup(depot)
    assert r.returncode != 0
    assert "lien symbolique" in r.stderr
    assert _mode(cible) == "755"


def test_cle_en_lien_refusee_sans_toucher_la_cible(depot, tmp_path):
    cible = tmp_path / "secret"
    cible.write_text("x" * 64, encoding="utf-8")
    cible.chmod(0o600)
    (_sys(depot) / "etc/elpis").mkdir(parents=True)
    (_sys(depot) / "etc/elpis/audit.key").symlink_to(cible)
    r = _setup(depot)
    assert r.returncode != 0
    assert "audit.key : lien symbolique" in r.stderr
    assert _mode(cible) == "600" and cible.read_text(encoding="utf-8") == "x" * 64


@pytest.mark.skipif(AUTRE is None, reason="aucun autre compte local")
def test_compte_divergent_des_unites_refuse(depot):
    _unite(depot, AUTRE)
    r = _setup(depot)
    assert r.returncode != 0
    assert f"Les services tournent sous {AUTRE}" in r.stderr
    assert not (_sys(depot) / "var/lib/elpis").exists()


def test_fichier_du_meme_jour_ajoute_sous_le_compte(depot):
    audit = _sys(depot) / "var/lib/elpis/audit"
    audit.mkdir(parents=True)
    (audit / "audit-2026-01-02.jsonl").write_text('{"seq":1}\n{"seq":2}', encoding="utf-8")
    (depot / "logs/audit/audit-2026-01-02.jsonl").write_text('{"seq":7}\n', encoding="utf-8")
    (depot / "logs/audit/audit-2026-01-01.jsonl").write_text('{"seq":5}\n', encoding="utf-8")
    r = _setup(depot)
    assert r.returncode == 0, r.stderr
    assert (audit / "audit-2026-01-02.jsonl").read_text(encoding="utf-8") == '{"seq":1}\n{"seq":2}\n{"seq":7}\n'
    assert (audit / "audit-2026-01-01.jsonl").read_text(encoding="utf-8") == '{"seq":5}\n'
    assert list((depot / "logs/audit").iterdir()) == []
    assert "1 fichier(s) d'audit de logs/audit ajouté(s)" in r.stdout


def test_services_en_marche_le_jour_et_la_veille_restent(depot):
    audit = _sys(depot) / "var/lib/elpis/audit"
    audit.mkdir(parents=True)
    jour = time.strftime("%Y-%m-%d", time.gmtime())
    for nom in (f"audit-{jour}.jsonl", "audit-2026-01-02.jsonl"):
        (audit / nom).write_text("{}\n", encoding="utf-8")
        (depot / "logs/audit" / nom).write_text('{"vieux":1}\n', encoding="utf-8")
    with subprocess.Popen(["sleep", "60"]) as p:
        (depot / "user_db/run/main.pid").write_text(str(p.pid), encoding="utf-8")
        try:
            r = _setup(depot)
        finally:
            p.kill()
    assert r.returncode == 0, r.stderr
    assert (depot / "logs/audit" / f"audit-{jour}.jsonl").exists()
    assert (audit / f"audit-{jour}.jsonl").read_text(encoding="utf-8") == "{}\n"
    assert (audit / "audit-2026-01-02.jsonl").read_text(encoding="utf-8") == '{}\n{"vieux":1}\n'
    assert "du jour et de la veille laissé(s)" in r.stderr


def test_journal_technique_remis_en_0640(depot):
    applog = _sys(depot) / "var/log/elpis"
    applog.mkdir(parents=True)
    for nom, mode in (("app.log.jsonl", 0o666), ("app.log.jsonl.1", 0o644)):
        (applog / nom).write_text("{}\n", encoding="utf-8")
        (applog / nom).chmod(mode)
    assert _setup(depot).returncode == 0
    assert [_mode(applog / n) for n in ("app.log.jsonl", "app.log.jsonl.1")] == ["640", "640"]


@pytest.mark.skipif(os.geteuid() != 0 or AUTRE is None, reason="chown d'un fichier d'un autre compte : root seulement")
def test_journal_technique_rendu_au_nouveau_compte(depot):
    applog = _sys(depot) / "var/log/elpis"
    applog.mkdir(parents=True)
    (applog / "app.log.jsonl").write_text("{}\n", encoding="utf-8")
    os.chown(applog / "app.log.jsonl", pwd.getpwnam(AUTRE).pw_uid, -1)
    r = _setup(depot, ELPIS_USER=AUTRE)
    assert pwd.getpwuid((applog / "app.log.jsonl").stat().st_uid).pw_name == AUTRE, r.stderr


def _cle_dans_un_dossier_ferme(depot: Path) -> None:
    d = _sys(depot) / "etc/elpis"
    d.mkdir(parents=True)
    (d / "audit.key").write_text("k" * 64, encoding="utf-8")
    (d / "audit.key").chmod(0o440)
    d.chmod(0o000)


def test_doctor_sous_le_compte_des_services_compte_la_cle_illisible(depot):
    _cle_dans_un_dossier_ferme(depot)
    try:
        r = _bash(depot, _fonctions("doctor_cle", "groupe_propre", "compte_lit"),
                  f'bad=0; doctor_cle {MOI}; echo "bad=$bad"')
    finally:
        (_sys(depot) / "etc/elpis").chmod(0o750)
    assert "bad=1" in r.stdout
    assert "illisible par le compte des services" in r.stderr


def test_doctor_session_sans_le_groupe_de_la_cle(depot, tmp_path):
    faux = tmp_path / "bin"
    faux.mkdir()
    (faux / "id").write_text('#!/bin/bash\n[ "$*" = -Gn ] && { echo autre-groupe; exit 0; }\nexec /usr/bin/id "$@"\n',
                             encoding="utf-8")
    (faux / "id").chmod(0o755)
    _cle_dans_un_dossier_ferme(depot)
    groupe = grp.getgrgid(os.getgid()).gr_name
    try:
        r = _bash(depot, _fonctions("doctor_cle", "groupe_propre", "compte_lit"),
                  f'bad=0; doctor_cle {MOI}; echo "bad=$bad"', PATH=f"{faux}:{os.environ.get('PATH', '/usr/bin:/bin')}")
    finally:
        (_sys(depot) / "etc/elpis").chmod(0o750)
    assert "bad=1" in r.stdout
    assert f"sans le groupe {groupe}" in r.stderr


@pytest.mark.parametrize("pid", ["1", "0", "-1", "12 13", "x", "1234567890"])
def test_pid_hors_bornes_jamais_signale(depot, pid):
    r = _bash(depot, _fonctions("pid_signalable", "compte_services"), f'pid_signalable "{pid}"; echo "rc=$?"')
    assert "rc=1" in r.stdout


def test_pid_d_un_processus_du_compte_signalable_hors_root(depot):
    r = _bash(depot, _fonctions("pid_signalable", "compte_services"), 'pid_signalable "$$"; echo "rc=$?"')
    assert "rc=0" in r.stdout


@pytest.mark.skipif(AUTRE is None, reason="aucun autre compte local")
@pytest.mark.parametrize("explicite", [False, True])
def test_service_install_garde_le_compte_des_unites(depot, explicite):
    _unite(depot, AUTRE)
    talons = """
id() { if [ "$#" -eq 1 ] && [ "$1" = -u ]; then echo 0; else command id "$@"; fi; }
systemctl() { :; }; usermod() { :; }; sudo() { :; }; getent() { return 1; }; chown() { :; }; install() { :; }
_render_units() { UNITS_WANTS=(); RAG_STORE=/x; RAG_CACHE=/x; }
audit_setup() { echo "audit_setup $1 | $2"; }; cmd_stop() { echo "cmd_stop $COMPTES_ARRET"; }
"""
    r = _bash(depot, _fonctions("cmd_service", "compte_services"), talons + "cmd_service install",
              SUDO_USER=MOI, ELPIS_USER=MOI if explicite else "")
    attendu = MOI if explicite else AUTRE
    assert f"audit_setup {attendu} | {AUTRE} " in r.stdout, r.stdout + r.stderr
    assert f"cmd_stop {AUTRE} " in r.stdout
    assert (f"Compte des services : {AUTRE} → {MOI}" in r.stdout) is explicite
