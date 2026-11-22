# SPDX-License-Identifier: MIT
"""tests/deploy/test_racine_repli_2026_11_22.py — quatrième relecture : repli sur un compte jamais forcé par un service (services arrêtés et ptrace limité avant les sondes, refus une fois un compte par service en place), PID d'un service vers son seul compte ; chaque attaque rejouée, rien ne se passe."""
from __future__ import annotations

from pathlib import Path

from tests.deploy import test_comptes_separes_2026_11_21 as _cs
from tests.deploy.test_comptes_separes_2026_11_21 import INSTALLE_SEPARE, MOI, _harnais, _sys, _trace, _unite

depot = _cs.depot


def _separe_en_place(depot: Path) -> None:
    for s in ("main", "admin", "toolhost"):
        _unite(depot, s, f"elpis-{s}", "separes")
    with (_sys(depot) / "etc/passwd").open("a", encoding="utf-8") as f:
        f.write("elpis-main:x:990:990::/nonexistent:/usr/sbin/nologin\n")


# D — main tue la sonde lancée sous son compte : jamais de repli silencieux une fois un compte par service en place.
def test_d_sonde_tuee_refus_et_services_remis(depot):
    _separe_en_place(depot)
    _cs._etat(depot)
    r = _harnais(depot, INSTALLE_SEPARE, FAUX_REFUS=str(depot / "elpis"))
    assert r.returncode != 0 and "Un compte par service est en place" in r.stderr, r.stdout + r.stderr
    t = _trace(depot)
    assert not [l for l in t if l.startswith("render")] and "systemctl start elpis.target" in t
    # Services arrêtés et ptrace limité avant la première commande lancée sous un compte des services.
    premier = next(i for i, l in enumerate(t) if l.startswith("runuser"))
    assert t.index("systemctl stop elpis.target elpis-*.service") < premier


def test_d_premiere_installation_garde_le_repli_avertit(depot):
    _cs._unite_bloc4(depot)
    r = _harnais(depot, INSTALLE_SEPARE, FAUX_REFUS=str(depot / "elpis"))
    assert r.returncode == 0 and "Services sous un seul compte (repli)" in r.stderr, r.stdout + r.stderr
    t = _trace(depot)
    assert f"render repli {MOI}" in t and t.index("systemctl stop elpis.target elpis-*.service") < t.index(f"render repli {MOI}")


def test_d_ptrace_limite_avant_la_premiere_sonde(depot):
    yama = _sys(depot) / "proc/sys/kernel/yama"
    yama.mkdir(parents=True)
    (yama / "ptrace_scope").write_text("0\n", encoding="utf-8")
    (_sys(depot) / "etc/sysctl.d").mkdir(parents=True)
    _separe_en_place(depot)
    _cs._etat(depot)
    assert _harnais(depot, INSTALLE_SEPARE).returncode == 0
    t = _trace(depot)
    sysctl = next(i for i, l in enumerate(t) if l.startswith("sysctl -q -p"))
    assert sysctl < next(i for i, l in enumerate(t) if l.startswith("runuser"))


# PID d'un service sous un compte par service : seulement un processus de son compte (et des comptes quittés pendant service install).
def test_pid_d_un_service_vers_son_seul_compte(depot):
    _separe_en_place(depot)
    talons = 'id() { [ "$*" = -u ] && echo 0 || command id "$@"; }'
    r = _harnais(depot, 'pid_signalable "$$" main && echo oui || echo non', talons=talons)
    assert r.stdout.strip() == "non", r.stdout + r.stderr
    r = _harnais(depot, 'COMPTES_ARRET="$MOI" pid_signalable "$$" main && echo oui || echo non', talons=talons)
    assert r.stdout.strip() == "oui"
