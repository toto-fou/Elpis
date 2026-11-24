# SPDX-License-Identifier: MIT
"""tests/deploy/test_doctor_comptes_separes_2026_11_24.py — doctor avec un compte par service : config.json lu sous sudo (unité de la console), Docker et navigateurs de l'hôte d'outils signalés non vérifiables sous l'opérateur au lieu d'être en défaut, aucun contrôle de Docker tiré d'un `docker info` injoignable."""
from __future__ import annotations

import re

from tests.deploy import test_comptes_separes_2026_11_21 as _cs
from tests.deploy.test_comptes_separes_2026_11_21 import _harnais, _sys

depot = _cs.depot
SANS_COULEUR = re.compile(r"\x1b\[[0-9;]*m")
CHECK = ('bad=0; check() { local lib="$1" conseil="$2"; shift 2; if "$@" >/dev/null 2>&1; then ok "$lib"; '
         'else warn "$lib : NON ($conseil)"; bad=$((bad+1)); fi; }\n')


# Sous sudo, le code de lecture tourne dans l'unité transitoire de la console, à l'environnement neuf : le lien attendu lui est passé.
def test_config_lue_sous_root_dans_l_unite_de_la_console(depot):
    conf = _sys(depot) / "etc/elpis/config"
    conf.mkdir(parents=True)
    (conf / "config.json").write_text('{"executors": {"allow_sudo": false}}', encoding="utf-8")
    (depot / "config.json").unlink()
    (depot / "config.json").symlink_to(conf / "config.json")
    corps = (f'CONFIG_SYS="{conf}"; racine_separee() {{ return 0; }}; app_console() {{ env -i PATH="$PATH" "$@"; }}\n'
             'conf_json \'print((conf(sys.argv[1]).get("executors") or {}).get("allow_sudo"))\' "$ROOT/config.json"')
    r = _harnais(depot, corps)
    assert r.stdout.strip() == "False", r.stdout + r.stderr


# Sans démon joignable, `docker info --format` rend 0 et des valeurs vides (version) ou nulles (SwapLimit) : les contrôles tirés de Docker s'arrêtent, sans fausse alerte ; joignable sans options de sécurité, ils ont lieu.
def test_isolation_sans_docker_joignable(depot):
    (depot / "sandbox-agent").mkdir()
    (depot / "sandbox-agent/demarrage.sh").write_text("", encoding="utf-8")
    corps = ('bad=0; docker() { case " $* " in *ServerVersion*|*SecurityOptions*) echo; return 0 ;; *" --format "*) echo false; return 0 ;; *) return 1 ;; esac; }\n'
             'doctor_isolation_bac; echo "bad=$bad"')
    r = _harnais(depot, corps)
    assert "swap" not in r.stderr and "non conforme" not in r.stderr and "bad=0" in r.stdout, r.stdout + r.stderr
    r = _harnais(depot, corps.replace("*ServerVersion*|*SecurityOptions*) echo;", "*ServerVersion*) echo 27.1.1; return 0 ;; *SecurityOptions*) echo;"))
    assert "swap des conteneurs" in r.stderr, r.stdout + r.stderr


# Opérateur sans accès à Docker sous un compte par service : non vérifiable, pas en défaut, sauf service Docker arrêté ; en compte unique ou sous root, toujours vérifié.
def test_docker_sous_l_operateur_non_verifiable(depot):
    corps = (CHECK + 'mode_installe() { echo separes; }; docker() { return 1; }\n'
             'systemctl() { [ "$*" = "is-active --quiet docker" ]; }\ndoctor_docker; echo "bad=$bad"')
    r = _harnais(depot, corps, FAUX_UID="1000")
    assert "non vérifiables par ce compte (doctor avec sudo)" in r.stdout and "bad=0" in r.stdout, r.stdout + r.stderr
    r = _harnais(depot, corps.replace('[ "$*" = "is-active --quiet docker" ]', "return 3"), FAUX_UID="1000")
    assert "Docker : NON (service arrêté" in r.stderr and "bad=1" in r.stdout and "non vérifiables" not in r.stdout, r.stdout + r.stderr
    r = _harnais(depot, corps.replace("echo separes", "echo unique"), FAUX_UID="1000")
    assert "Docker joignable : NON" in r.stderr and "bad=2" in r.stdout, r.stdout + r.stderr
    r = _harnais(depot, corps, FAUX_UID="0")
    assert "Docker joignable : NON" in r.stderr and "bad=2" in r.stdout, r.stdout + r.stderr


# Navigateurs des bacs : ceux que lit l'hôte d'outils (son unité), jamais le cache de root ; hors de portée de l'opérateur, non vérifiables.
def test_navigateurs_de_l_hote_d_outils(depot, tmp_path):
    for d in ("browser-service/node_modules", "browser-service/dist"):
        (depot / d).mkdir(parents=True)
    (depot / "browser-service/dist/main.mjs").write_text("", encoding="utf-8")
    pw = tmp_path / "toolhost/ms-playwright"
    shell = pw / "chromium_headless_shell-1/chrome-headless-shell-linux64/chrome-headless-shell"
    shell.parent.mkdir(parents=True)
    shell.write_text("", encoding="utf-8")
    corps = (CHECK + 'mode_installe() { echo separes; }; conf_json() { echo 200; }\n'
             f'systemctl() {{ [ "$1 $2 $3" = "show -p Environment" ] && echo "A=1 PLAYWRIGHT_BROWSERS_PATH={pw}"; }}\n'
             'doctor_navigateur_bac')
    r = _harnais(depot, corps, FAUX_UID="0")
    assert f"[ ok  ] navigateur dans le bac : headless shell de Chromium ({pw})" in SANS_COULEUR.sub("", r.stdout), r.stdout + r.stderr
    (tmp_path / "toolhost").chmod(0o000)
    try:
        r = _harnais(depot, corps, FAUX_UID="1000")
    finally:
        (tmp_path / "toolhost").chmod(0o755)
    assert f"navigateurs de l'hôte d'outils ({pw}) non vérifiables par ce compte" in r.stdout, r.stdout + r.stderr
    assert "headless shell de Chromium" not in r.stdout + r.stderr


# Sous sudo hors d'un compte par service (compte unique), les navigateurs du propriétaire du dépôt, jamais le cache de root.
def test_navigateurs_sous_sudo_en_compte_unique(depot):
    for d in ("browser-service/node_modules", "browser-service/dist"):
        (depot / d).mkdir(parents=True)
    corps = (CHECK + 'mode_installe() { echo unique; }; conf_json() { echo 200; }\n'
             '_navigateurs() { echo "/srv/navigateurs-de-$1"; }\ndoctor_navigateur_bac')
    r = _harnais(depot, corps, FAUX_UID="0")
    proprio = depot.owner()
    assert f"headless shell de Chromium (/srv/navigateurs-de-{proprio})" in r.stdout + r.stderr, r.stdout + r.stderr
