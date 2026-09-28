# SPDX-License-Identifier: MIT
"""Recyclage des workers : espacé, et jamais déclenché par accident.

``max_requests`` compte des **requêtes HTTP**, pas des gestes d'utilisateur —
et l'application sert elle-même ses fichiers statiques : ``index.html`` charge
57 sous-ressources, ``admin.html`` 38. À 2000, un worker se recyclait toutes
les ~30 ouvertures de page, c'est-à-dire avant même d'avoir atteint son régime.

Mesuré par tests/load (24 utilisateurs en lecture, 3 workers, 42 s) :

    | | 2000 | 50 000 |
    |---|---|---|
    | requêtes perdues | 9 | 0 |
    | débit | 74,8 req/s | 109,2 req/s |
    | ``GET /`` p99 | 450,9 ms | 207,6 ms |
    | recyclages | 6 | 0 |

Le piège que ces tests verrouillent : gunicorn calcule, **par worker**,
``max_requests + randint(0, jitter)``. Un jitter résiduel sur un plafond nul
ferait donc recycler au bout d'une seule requête — soit exactement l'inverse
de ce que demande « recyclage désactivé ».
"""
from __future__ import annotations

import re
import runpy
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
_SERVER_DIR = ROOT / "server"

_CONFS = [
    ("gunicorn_conf.py", "APP_MAX_REQUESTS"),
    ("gunicorn_admin_conf.py", "ADMIN_MAX_REQUESTS"),
]


def _conf(nom: str) -> dict:
    return runpy.run_path(str(_SERVER_DIR / nom))


@pytest.fixture(autouse=True)
def _env_propre(monkeypatch, tmp_path):
    for cle in ("APP_MAX_REQUESTS", "ADMIN_MAX_REQUESTS", "APP_WORKERS", "BIND"):
        monkeypatch.delenv(cle, raising=False)
    # Config absente → les confs retombent en accès direct, ce qui nous
    # convient : seul ``max_requests`` nous intéresse ici.
    monkeypatch.setenv("APP_CONFIG_PATH", str(tmp_path / "absente.json"))


def test_le_recyclage_est_desactive_sur_la_conf_applicative():
    """AUDIT long-run 2026-08-21 — la conf APPLICATIVE ne recycle plus du tout.

    Un recyclage qui tombe pendant une mission d'agent de plusieurs heures
    l'annule au bout du drain de 300 s (``uvicorn_worker.GRACEFUL_SHUTDOWN_S``)
    : partiel + « Continuer » en plein travail, l'exact contraire de la règle
    « recyclage invisible ». La campagne de charge n'a montré aucune fuite par
    requête — le filet était devenu purement précautionnel, son coût ne
    l'était pas. Ré-activable par ``APP_MAX_REQUESTS``."""
    g = _conf("gunicorn_conf.py")
    assert g["max_requests"] == 0
    assert g["max_requests_jitter"] == 0, \
        "jitter résiduel sur un plafond nul : recyclage après une requête"


def test_le_seuil_admin_laisse_le_worker_atteindre_son_regime():
    """La conf ADMIN garde son filet : trafic rare, pas de mission longue."""
    g = _conf("gunicorn_admin_conf.py")
    assert g["max_requests"] >= 20_000, (
        "seuil trop bas : à 60 requêtes par ouverture de page, le worker se "
        "recycle avant d'avoir chauffé")


@pytest.mark.parametrize("conf,env", _CONFS)
def test_le_seuil_reste_haut_quand_on_le_reactive(conf, env, monkeypatch):
    """Ré-activer le filet ne doit pas ramener un seuil bas par accident."""
    monkeypatch.setenv(env, "50000")
    assert _conf(conf)["max_requests"] >= 20_000


@pytest.mark.parametrize("conf,env", _CONFS)
def test_le_seuil_est_reglable(conf, env, monkeypatch):
    monkeypatch.setenv(env, "12345")
    assert _conf(conf)["max_requests"] == 12345


@pytest.mark.parametrize("conf,env", _CONFS)
def test_recyclage_desactivable_sans_effet_de_bord(conf, env, monkeypatch):
    """⚠ Le piège : gunicorn tire ``max_requests + randint(0, jitter)``.
    Avec un plafond à 0 et un jitter non nul, le worker recyclerait au bout
    d'une requête."""
    monkeypatch.setenv(env, "0")
    g = _conf(conf)
    assert g["max_requests"] == 0
    assert g["max_requests_jitter"] == 0, \
        "jitter résiduel sur un plafond nul : recyclage après une requête"


@pytest.mark.parametrize("conf,env", _CONFS)
def test_une_valeur_negative_ne_produit_pas_un_plafond_absurde(conf, env, monkeypatch):
    monkeypatch.setenv(env, "-5")
    g = _conf(conf)
    assert g["max_requests"] == 0 and g["max_requests_jitter"] == 0


@pytest.mark.parametrize("conf,env", _CONFS)
def test_le_jitter_reste_inferieur_au_plafond(conf, env, monkeypatch):
    monkeypatch.setenv(env, "1000")
    g = _conf(conf)
    assert 0 < g["max_requests_jitter"] < g["max_requests"]


# ── Nombre de workers ───────────────────────────────────────────────────────

def test_le_nombre_de_workers_est_surchargeable(monkeypatch):
    """Le calcul par défaut suppose un service limité par le CPU. La mesure dit
    l'inverse (58 % de CPU, débit décroissant au-delà de 16 utilisateurs : c'est
    le GIL qui sature). L'arbitrage débit/mémoire appartient à l'exploitant —
    encore faut-il qu'il ait un levier."""
    monkeypatch.setenv("APP_WORKERS", "6")
    assert _conf("gunicorn_conf.py")["workers"] == 6


@pytest.mark.parametrize("valeur", ["", "0", "-2", "beaucoup", "3.5"])
def test_une_surcharge_invalide_laisse_le_defaut(valeur, monkeypatch):
    monkeypatch.delenv("APP_WORKERS", raising=False)
    defaut = _conf("gunicorn_conf.py")["workers"]
    monkeypatch.setenv("APP_WORKERS", valeur)
    assert _conf("gunicorn_conf.py")["workers"] == defaut


def test_le_chiffre_des_sous_ressources_est_toujours_vrai():
    """Le raisonnement repose sur « une page = des dizaines de requêtes ».
    Si le front changeait radicalement, il faudrait revoir le seuil — ce test
    est là pour le signaler, pas pour figer un nombre exact."""
    html = (ROOT / "frontend" / "index.html").read_text(encoding="utf-8")
    sous_ressources = (len(re.findall(r'<script[^>]+src="', html))
                       + len(re.findall(r'<link[^>]+href="', html)))
    assert sous_ressources > 20, (
        f"seulement {sous_ressources} sous-ressources : le raisonnement qui "
        "justifie max_requests=50000 mérite d'être revérifié")
