# SPDX-License-Identifier: MIT
"""tests/deploy/test_doctor_isolation_bac_2026_11_18.py — « ./elpis doctor » : isolation des bacs (script de démarrage, réseau, Docker, noyau, sudo), fonction extraite du script et jouée avec un faux docker."""
from __future__ import annotations

import json
import os
import stat
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
CONFORME = "bridge|false|false|br-elpis-sb"


def _fonction() -> str:
    texte = (REPO / "elpis").read_text(encoding="utf-8").splitlines()
    debut = next(i for i, l in enumerate(texte) if l.startswith("doctor_isolation_bac() {"))
    fin = next(i for i in range(debut + 1, len(texte)) if texte[i] == "}")
    return "\n".join(texte[debut:fin + 1])


def _jouer(tmp_path: Path, *, demarrage=True, config=None, secu="name=seccomp", reseau=CONFORME, version="27.1.1",
           swap="true", docker_ko=False):
    racine = tmp_path / "racine"
    (racine / "sandbox-agent").mkdir(parents=True, exist_ok=True)
    if demarrage:
        (racine / "sandbox-agent/demarrage.sh").write_text("#!/bin/sh\n", encoding="utf-8")
    if config is not None:
        (racine / "config.json").write_text(config if isinstance(config, str) else json.dumps(config), encoding="utf-8")
    faux = tmp_path / "bin"
    faux.mkdir(exist_ok=True)
    docker = faux / "docker"
    docker.write_text(f"""#!/bin/sh
case "$*" in
  *SecurityOptions*) [ "{int(docker_ko)}" = 1 ] && exit 1; echo '{secu}' ;;
  "network inspect"*) [ -n '{reseau}' ] && echo '{reseau}' || exit 1 ;;
  "version"*) echo '{version}' ;;
  *SwapLimit*) echo '{swap}' ;;
  *) exit 1 ;;
esac
""", encoding="utf-8")
    docker.chmod(docker.stat().st_mode | stat.S_IXUSR)
    tete = """set -uo pipefail
info() { printf '[elpis] %s\\n' "$*"; }; ok() { printf '[ ok  ] %s\\n' "$*"; }
warn() { printf '[warn ] %s\\n' "$*" >&2; }
app_cmd() { "$@"; }
"""
    script = f'{tete}ROOT={racine}; bad=0\n{_fonction()}\ndoctor_isolation_bac; echo "bad=$bad"'
    env = {"PATH": f"{faux}:{os.environ.get('PATH', '/usr/bin:/bin')}", "LANG": "C.UTF-8", "HOME": str(tmp_path)}
    r = subprocess.run(["bash", "-c", script], env=env, capture_output=True, text=True, timeout=60,
                       stdin=subprocess.DEVNULL)
    bad = int(r.stdout.rsplit("bad=", 1)[1])
    return bad, r.stdout, r.stderr


def test_script_de_demarrage_present_ou_absent(tmp_path):
    bad, out, err = _jouer(tmp_path, demarrage=True, docker_ko=True)
    assert (bad, "script de démarrage des bacs présent" in out) == (0, True)
    bad, out, err = _jouer(tmp_path / "b", demarrage=False, docker_ko=True)
    assert bad == 1 and "script de démarrage des bacs absent" in err


def test_docker_illisible_s_arrete_sans_autre_verdict(tmp_path):
    bad, out, err = _jouer(tmp_path, docker_ko=True)
    assert bad == 0 and "isolation des bacs" not in out and "sudo" not in out + err


def test_reseau_des_bacs_absent_ou_non_conforme(tmp_path):
    bad, out, err = _jouer(tmp_path, reseau="")
    assert bad == 0 and "réseau des bacs : créé au premier bac" in out
    bad, out, err = _jouer(tmp_path / "b", reseau="bridge|true|true|docker0")
    assert bad >= 1 and "réseau Docker elpis-sandbox non conforme (bridge|true|true|docker0)" in err
    bad, out, err = _jouer(tmp_path / "c")
    assert "réseau des bacs : pont dédié, trafic entre bacs coupé" in out


@pytest.mark.parametrize("version,compte", [("25.0.5", 1), ("26.0.0", 0), ("27.1.1", 0), ("28.0.1", 0), ("", 0), ("x.y", 0)])
def test_version_de_docker(tmp_path, version, compte):
    bad, out, err = _jouer(tmp_path, reseau="", version=version)
    assert bad == compte
    assert ("la coupure entre bacs demande Docker 26" in err) == (compte == 1)


def test_limite_de_swap_du_noyau(tmp_path):
    _, _, err = _jouer(tmp_path, reseau="", swap="false")
    assert "noyau sans limite du swap" in err
    _, _, err = _jouer(tmp_path / "b", reseau="", swap="true")
    assert "noyau sans limite du swap" not in err


@pytest.mark.parametrize("secu,config,renforcee", [
    ("name=seccomp", {}, False),
    ("name=seccomp name=userns", {}, True),
    ("name=seccomp name=rootless", {}, True),
    ("name=seccomp", {"executors": {"runtime": "runsc"}}, True),
    ("name=seccomp", {"executors": {"runtime": "kata-runtime"}}, True),
    ("name=seccomp", {"executors": {"runtime": ""}}, False),
])
def test_isolation_renforcee_ou_non(tmp_path, secu, config, renforcee):
    bad, out, err = _jouer(tmp_path, reseau="", secu=secu, config=config)
    assert ("isolation des bacs : renforcée" in out) == renforcee
    assert ("ni userns-remap, ni Docker rootless, ni gVisor" in out) == (not renforcee)
    assert bad == 0


@pytest.mark.parametrize("config,attendu", [
    (None, "sudo permis"),
    ({}, "sudo permis"),
    ({"executors": {}}, "sudo permis"),
    ({"executors": {"allow_sudo": True}}, "sudo permis"),
    ({"executors": {"allow_sudo": False}}, "bacs durcis : sudo refusé"),
    ({"executors": {"allow_sudo": "false"}}, "bacs durcis : sudo refusé"),
    ({"executors": {"allow_sudo": None}}, "bacs durcis : sudo refusé"),
    ("{pas du json", "executors.allow_sudo non lu"),
])
def test_sudo_permis_refuse_ou_illisible(tmp_path, config, attendu):
    bad, out, err = _jouer(tmp_path, reseau="", config=config)
    assert attendu in out + err
    assert bad == 0
    assert sum(m in out + err for m in ("sudo permis", "bacs durcis", "non lu")) == 1


def _profil(pid, mode, **extra):
    return {"id": pid, "name": pid, "mode": mode, **extra}


@pytest.mark.parametrize("profils,cites", [
    ([], ""),
    ([_profil("isolated", "none"), _profil("lan", "allowlist_ip", ips=["192.0.2.1"])], ""),
    ([_profil("libre", "bridge")], "libre"),
    ([_profil("libre", "bridge"), _profil("b", "bridge", block_lan=False)], "libre b"),
    ([_profil("garde", "bridge", block_metadata=True)], ""),
    ([_profil("garde", "bridge", block_host=True), _profil("libre", "bridge")], "libre"),
    ([_profil("vrai", "bridge", block_lan="oui")], ""),
    ([_profil("vrai", "bridge", block_lan=1)], ""),
    ([_profil("faux", "bridge", block_lan=0, block_host="")], "faux"),
])
def test_profils_ouverts_sans_protection_listes(tmp_path, profils, cites):
    bad, out, err = _jouer(tmp_path, reseau="", config={"executors": {"network_profiles": profils}})
    assert bad == 0
    if cites:
        assert f"profils réseau ouverts sans protection ({cites})" in out
    else:
        assert "profils réseau ouverts sans protection" not in out


def test_profils_illisibles_ou_mal_formes_sans_conseil(tmp_path):
    for config in ("{pas du json", {"executors": {"network_profiles": "abc"}}, {"executors": {"network_profiles": ["x", 5]}}):
        bad, out, err = _jouer(tmp_path / str(abs(hash(str(config)))), reseau="", config=config)
        assert bad == 0 and "profils réseau ouverts sans protection" not in out
