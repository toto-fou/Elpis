# SPDX-License-Identifier: MIT
"""tests/deploy/test_graphiques_installation_neuve_2026_11_23.py — un compte par service, installation neuve : user_db/run n'existe pas encore ; service install le pose au mode des données, puis crée le cache des graphiques, que l'hôte d'outils peut alors lire (graphiques des documents Office)."""
from __future__ import annotations

from tests.deploy import test_comptes_separes_2026_11_21 as _cs
from tests.deploy.test_comptes_separes_2026_11_21 import INSTALLE_SEPARE, _harnais, _mode

depot = _cs.depot


# Sans user_db/run : ni « absent : refusé » ni droits incomplets ; run/ traversable par le groupe des services, cache des graphiques à main, lu par le groupe.
def test_installation_neuve_pose_run_et_le_cache_des_graphiques(depot):
    (depot / "user_db/run").rmdir()
    r = _harnais(depot, INSTALLE_SEPARE)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "absent : refusé" not in r.stderr and "Droits du mode séparé incomplets" not in r.stderr, r.stderr
    assert _mode(depot / "user_db/run") == "2770" and _mode(depot / "user_db/run/charts") == "2750"


# Mise à niveau : un run/ que main a créé fermé (0700) est rouvert au groupe, son cache des graphiques compris.
def test_run_ferme_par_main_rouvert(depot):
    (depot / "user_db/run").chmod(0o700)
    (depot / "user_db/run/charts/alice").mkdir(parents=True, mode=0o750)
    r = _harnais(depot, INSTALLE_SEPARE)
    assert r.returncode == 0, r.stdout + r.stderr
    assert {p: _mode(depot / p) for p in ("user_db/run", "user_db/run/charts", "user_db/run/charts/alice")} == {
        "user_db/run": "2770", "user_db/run/charts": "2750", "user_db/run/charts/alice": "2750"}
