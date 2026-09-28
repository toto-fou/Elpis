# SPDX-License-Identifier: MIT
"""Le harnais de charge doit rester en état de marche.

Un outil de mesure qu'on ne lance qu'à la main pourrit en silence : le jour où
on en a besoin, il ne démarre plus. Ces tests-là sont **rapides** et ne lancent
aucun serveur — ils vérifient la mécanique de mesure, pas la charge elle-même.

La campagne complète, elle, se lance à la main :

    venv/bin/python tests/load/run.py --scenario connexion
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tests.load import budgets, metrics, scenarios  # noqa: E402


# ── Percentiles ─────────────────────────────────────────────────────────────

def test_percentile_sur_une_serie_connue():
    v = list(range(1, 101))                     # 1..100, déjà trié
    assert metrics.percentile(v, 0.50) == pytest.approx(50.5)
    assert metrics.percentile(v, 0.95) == pytest.approx(95.05)
    assert metrics.percentile(v, 0.99) == pytest.approx(99.01)


def test_percentile_sur_une_serie_degeneree():
    assert metrics.percentile([], 0.5) != metrics.percentile([], 0.5)   # NaN
    assert metrics.percentile([7.0], 0.99) == 7.0


# ── Classement des échecs ───────────────────────────────────────────────────

@pytest.mark.parametrize("exc,statut,corps,attendu", [
    (None, 200, "", "statut inattendu : 200"),
    (None, 500, "", "500 (erreur serveur)"),
    (None, 500, "sqlite3.OperationalError: database is locked",
     "SQLite : database is locked (contention d'écriture)"),
    (None, 409, "", "409 (conflit : verrou de présence)"),
    (None, 503, "", "503 (service indisponible / arrêt en cours)"),
    (TimeoutError("trop long"), None, "", "délai dépassé (le serveur n'a pas répondu)"),
    (ConnectionResetError("reset"), None, "",
     "connexion refusée/coupée (backlog plein ou worker mort)"),
])
def test_les_echecs_sont_ranges_par_cause(exc, statut, corps, attendu):
    assert metrics.classer_echec(exc, statut, corps) == attendu


def test_database_is_locked_prime_sur_le_code_http():
    """C'est la cause qui doit remonter, pas le symptôme : « 500 » ne se
    corrige pas au même endroit que la contention d'écriture."""
    assert "database is locked" in metrics.classer_echec(
        None, 500, "Internal Server Error: database is locked")


# ── Séries et campagne ──────────────────────────────────────────────────────

def test_une_serie_compte_ses_echecs():
    import time
    s = metrics.Serie("essai")
    for statut in (200, 200, 500, 404):
        s.ajouter(time.perf_counter(), statut)
    assert s.total == 4 and s.nb_echecs == 2
    assert s.resume(1.0)["taux_echec_pct"] == 50.0


def test_la_derive_ignore_la_montee_en_charge():
    """Le point le plus important du module : mesurer la dérive de bout en
    bout ferait crier à la fuite à chaque campagne."""
    c = metrics.Campagne("essai")
    # Montée brutale puis plateau — le profil réel d'une mise en régime.
    for t, rss in ((0, 400), (1, 500), (2, 540), (3, 541), (4, 541), (5, 542)):
        c.sondes.append({"t": t, "rss_mo": rss, "fds": 100, "threads": 20,
                         "db_mo": 1.0, "wal_mo": 0.5, "cpu_pct": 50.0})
    # Coupure au milieu des 6 échantillons → l'index 3 (541 Mo) sépare les
    # deux moitiés : montée 400 → 541, régime établi 541 → 542.
    assert c.montee_en_charge()["rss_mo"] == pytest.approx(141.0)
    assert c.derive_ressources()["rss_mo"] == pytest.approx(1.0)


def test_le_premier_echantillon_de_cpu_est_ecarte():
    """``cpu_percent`` sans intervalle rend 0 au premier appel : le garder
    tirerait la médiane vers le bas."""
    c = metrics.Campagne("essai")
    c.sondes.append({"t": 0, "cpu_pct": 0.0})
    for t in range(1, 6):
        c.sondes.append({"t": t, "cpu_pct": 60.0})
    assert c.cpu() == {"median_pct": 60.0, "max_pct": 60.0}


# ── Budgets ─────────────────────────────────────────────────────────────────

def _campagne(nom_serie: str, latences: list[float], **kw) -> metrics.Campagne:
    c = metrics.Campagne("essai")
    s = c.serie(nom_serie)
    s.latences_ms = latences
    for famille, n in (kw.get("echecs") or {}).items():
        s.echecs[famille] = n
    c.fin = c.debut + 10.0
    return c


def test_un_temoin_serein_tient_les_budgets():
    v = budgets.evaluer(_campagne("témoin /api/me-lite", [10.0] * 100))
    assert v["depassements"] == []


def test_un_temoin_gele_fait_echouer_la_campagne():
    """Le cas réel : PBKDF2 sur la boucle d'événements."""
    v = budgets.evaluer(_campagne("témoin /api/me-lite", [1392.0] * 100))
    assert v["depassements"], "un témoin à 1,4 s doit faire échouer la campagne"
    assert "subi la charge" in v["depassements"][0]


def test_une_famille_interdite_invalide_meme_a_faible_taux():
    c = _campagne("PUT save-messages", [10.0] * 1000,
                  echecs={"SQLite : database is locked (contention d'écriture)": 1})
    v = budgets.evaluer(c)
    assert any("database is locked" in m for m in v["depassements"]), \
        "une seule contention d'écriture doit suffire à lever le drapeau"


def test_une_fuite_de_descripteurs_est_signalee():
    c = _campagne("lecture", [10.0] * 10)
    for t in range(6):
        c.sondes.append({"t": t, "rss_mo": 400, "fds": 100 + t * 30,
                         "threads": 20, "db_mo": 1.0, "wal_mo": 0.5})
    v = budgets.evaluer(c)
    assert any("descripteurs" in m for m in v["depassements"])


# ── Cohérence du harnais ────────────────────────────────────────────────────

def test_tous_les_scenarios_sont_appelables():
    import inspect
    for nom, fonction in scenarios.SCENARIOS.items():
        assert inspect.iscoroutinefunction(fonction), nom
        params = inspect.signature(fonction).parameters
        assert "duree" in params, f"{nom} doit accepter --duree"
        assert "utilisateurs" in params or "abonnes" in params, nom


def test_le_readme_documente_chaque_scenario():
    readme = (Path(__file__).parent / "README.md").read_text(encoding="utf-8")
    for nom in scenarios.SCENARIOS:
        assert f"`{nom}`" in readme, f"scénario « {nom} » absent du README"
