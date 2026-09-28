# SPDX-License-Identifier: MIT
"""tests/shared_infra/test_niveau_log_applicatif_2026_08_22.py — les
``logger.info`` applicatifs atteignent enfin le journal.

Le trou comblé
--------------
``access_logging.configure`` branche son handler sur le logger RACINE, mais
personne ne réglait le niveau de celui-ci : il restait à ``WARNING``. Tout
module qui n'emprunte pas ``uvicorn.error`` (les 15 qui font
``getLogger(__name__)``, plus ``elpis.compressor``) voyait donc ses INFO
écartés AVANT le handler. Constaté sur les journaux de production :
79 enregistrements WARNING du compresseur, **zéro INFO, jamais** — « compression
triggered », « compression OK : X → Y tokens » et « compression bloquée : cap
atteint » n'existaient nulle part. C'est ce qui rendait une compaction
invisible pour qui enquête.

Le niveau est posé sur les RACINES applicatives et non sur le logger racine :
les bibliothèques tierces (httpx, asyncio…) doivent rester silencieuses, sans
quoi le journal devient illisible et l'écriture coûte à chaque requête.
"""
from __future__ import annotations

import logging

import pytest

from shared_infra.observability import access_logging

# Loggers réellement présents dans le code et qui tombaient dans le trou.
_ATTENDUS_INFO = (
    "elpis.compressor",                 # compaction
    "llm_core.tools.task_tool",         # sous-agents
    "llm_core.tools._task_resume",
    "shared_infra.scheduling.routes_webhooks",
    "shared_infra.notifications.push",
)

_TIERS = ("httpx", "httpcore", "asyncio", "urllib3")


@pytest.fixture(autouse=True)
def niveaux_restaures():
    """Ces réglages sont GLOBAUX au process : on les rend tels quels."""
    noms = access_logging._APP_LOGGER_ROOTS + _ATTENDUS_INFO + _TIERS
    avant = {n: logging.getLogger(n).level for n in noms}
    racine = logging.getLogger().level
    yield
    for n, lvl in avant.items():
        logging.getLogger(n).setLevel(lvl)
    logging.getLogger().setLevel(racine)


def test_les_loggers_applicatifs_laissent_passer_info(monkeypatch):
    monkeypatch.delenv("APP_LOG_LEVEL", raising=False)
    for n in _ATTENDUS_INFO:
        logging.getLogger(n).setLevel(logging.NOTSET)
    access_logging._apply_app_log_level()
    for n in _ATTENDUS_INFO:
        assert logging.getLogger(n).isEnabledFor(logging.INFO), (
            f"{n} : ses INFO seraient encore écartés avant le handler — "
            f"c'est le cas qui rendait les compactions invisibles")


def test_les_bibliotheques_tierces_restent_a_warning(monkeypatch):
    monkeypatch.delenv("APP_LOG_LEVEL", raising=False)
    for n in _TIERS:
        logging.getLogger(n).setLevel(logging.NOTSET)
    logging.getLogger().setLevel(logging.WARNING)
    access_logging._apply_app_log_level()
    for n in _TIERS:
        assert not logging.getLogger(n).isEnabledFor(logging.INFO), (
            f"{n} inonderait le journal : le niveau doit être posé sur les "
            f"racines applicatives, pas sur le logger racine")


def test_le_logger_racine_nest_pas_touche(monkeypatch):
    monkeypatch.delenv("APP_LOG_LEVEL", raising=False)
    logging.getLogger().setLevel(logging.ERROR)
    access_logging._apply_app_log_level()
    assert logging.getLogger().level == logging.ERROR


def test_le_niveau_est_reglable_par_lenvironnement(monkeypatch):
    monkeypatch.setenv("APP_LOG_LEVEL", "WARNING")
    access_logging._apply_app_log_level()
    assert not logging.getLogger("elpis.compressor").isEnabledFor(logging.INFO)

    monkeypatch.setenv("APP_LOG_LEVEL", "n'importe quoi")
    access_logging._apply_app_log_level()
    assert logging.getLogger("elpis.compressor").isEnabledFor(logging.INFO), (
        "une valeur illisible doit retomber sur INFO, jamais faire taire "
        "l'application")


def test_configure_pose_le_niveau_meme_au_second_appel(monkeypatch):
    """``configure`` retourne tôt quand le handler est déjà branché (cas du
    rechargement) : le niveau doit tout de même être (re)posé."""
    monkeypatch.delenv("APP_LOG_LEVEL", raising=False)
    access_logging.configure("main")          # peut brancher le handler
    # On dérègle la RACINE applicative (c'est elle que ``configure`` pose ;
    # un niveau posé sur un logger enfant, lui, primerait à juste titre).
    logging.getLogger("elpis").setLevel(logging.WARNING)
    logging.getLogger("elpis.compressor").setLevel(logging.NOTSET)
    access_logging.configure("main")          # retour anticipé attendu
    assert logging.getLogger("elpis.compressor").isEnabledFor(logging.INFO)
