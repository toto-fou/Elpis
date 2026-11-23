# SPDX-License-Identifier: MIT
"""tests/deploy/test_graphiques_installation_neuve_2026_11_23.py — un compte par service, installation neuve : user_db/run n'existe pas encore ; service install le pose au mode des données, puis crée le cache des graphiques, que l'hôte d'outils peut alors lire (graphiques des documents Office)."""
from __future__ import annotations

from tests.deploy import test_comptes_separes_2026_11_21 as _cs
from tests.deploy.test_comptes_separes_2026_11_21 import INSTALLE_SEPARE, TALONS, TRACE_DROITS, _harnais, _mode, _trace

depot = _cs.depot


# Sans user_db/run : ni « absent : refusé » ni droits incomplets ; run/ traversable par le groupe des services, cache des graphiques à main, lu par le groupe.
def test_installation_neuve_pose_run_et_le_cache_des_graphiques(depot):
    (depot / "user_db/run").rmdir()
    r = _harnais(depot, INSTALLE_SEPARE)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "absent : refusé" not in r.stderr and "Droits du mode séparé incomplets" not in r.stderr, r.stderr
    assert _mode(depot / "user_db/run") == "2770" and _mode(depot / "user_db/run/charts") == "2750"


# Ordre des étapes de root : user_db/run posé (2770, à root) avant le cache des graphiques, même quand il existe déjà.
def test_run_pose_avant_le_cache_des_graphiques(depot):
    r = _harnais(depot, INSTALLE_SEPARE, TALONS + TRACE_DROITS)
    assert r.returncode == 0, r.stdout + r.stderr
    t = _trace(depot)
    run = [i for i, l in enumerate(t) if l.startswith(f"droits dossier {depot}/user_db/run 2770 root ")]
    charts = [i for i, l in enumerate(t) if l.startswith(f"droits dossier {depot}/user_db/run/charts 2750 ")]
    assert run and charts and run[0] < charts[0], t
