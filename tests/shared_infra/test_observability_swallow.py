# SPDX-License-Identifier: MIT
"""``swallow`` — compter sans rien changer.

Le contrat est strict : ce helper doit être un ``except Exception: pass``
rigoureusement équivalent, à la trace près. S'il modifiait le flot de contrôle,
appliquer l'instrumentation à 306 blocs deviendrait une refonte comportementale
de masse — exactement ce qu'on veut éviter.
"""
import asyncio
import logging

import pytest

from shared_infra.observability import tracing as obs


@pytest.fixture(autouse=True)
def clean():
    obs.reset()
    yield
    obs.reset()


# ── Équivalence stricte avec except Exception: pass ─────────────────────────

def test_l_exception_est_avalee():
    with obs.swallow("t.avale"):
        raise ValueError("boum")
    # on arrive ici : rien n'a remonté


def test_le_bloc_suivant_s_execute():
    marqueur = []
    with obs.swallow("t.suite"):
        raise RuntimeError("boum")
    marqueur.append(1)
    assert marqueur == [1]


def test_le_reste_du_bloc_est_saute_comme_avec_try():
    atteint = []
    with obs.swallow("t.saut"):
        raise RuntimeError("boum")
        atteint.append(1)      # noqa: F841 — inatteignable, c'est le propos
    assert atteint == []


def test_sans_exception_rien_n_est_compte():
    with obs.swallow("t.calme"):
        pass
    assert obs.snapshot() == []


# ── Ce qui ne doit PAS être avalé ───────────────────────────────────────────

def test_l_annulation_asyncio_remonte():
    """Avaler une CancelledError transformerait un arrêt propre en zombie."""
    with pytest.raises(asyncio.CancelledError):
        with obs.swallow("t.cancel"):
            raise asyncio.CancelledError()
    assert obs.snapshot() == [], "une annulation n'est pas une erreur à compter"


def test_keyboard_interrupt_remonte():
    with pytest.raises(KeyboardInterrupt):
        with obs.swallow("t.sigint"):
            raise KeyboardInterrupt()


def test_system_exit_remonte():
    with pytest.raises(SystemExit):
        with obs.swallow("t.exit"):
            raise SystemExit(1)


# ── Comptage ────────────────────────────────────────────────────────────────

def test_le_compteur_s_incremente_et_retient_la_derniere_erreur():
    for i in range(3):
        with obs.swallow("t.compte"):
            raise ValueError(f"essai {i}")
    row = obs.snapshot()[0]
    assert row["tag"] == "t.compte"
    assert row["n"] == 3
    assert row["last_type"] == "ValueError"
    assert row["last_msg"] == "essai 2"
    assert row["last_ts"] > 0


def test_le_palmares_est_trie_par_frequence():
    for _ in range(5):
        with obs.swallow("t.souvent"):
            raise ValueError()
    with obs.swallow("t.rare"):
        raise ValueError()
    assert [r["tag"] for r in obs.snapshot()] == ["t.souvent", "t.rare"]


def test_le_message_est_borne():
    with obs.swallow("t.long"):
        raise ValueError("x" * 5000)
    assert len(obs.snapshot()[0]["last_msg"]) <= 200


def test_le_nombre_de_tags_est_plafonne():
    """Un tag fabriqué dynamiquement ferait grossir le registre sans fin."""
    for i in range(obs._MAX_TAGS + 50):
        with obs.swallow(f"t.dynamique.{i}"):
            raise ValueError()
    tags = {r["tag"] for r in obs.snapshot()}
    assert len(tags) <= obs._MAX_TAGS + 1
    assert "__overflow__" in tags, "le dépassement doit rester visible"


def test_reset_vide_le_registre():
    with obs.swallow("t.x"):
        raise ValueError()
    obs.reset()
    assert obs.snapshot() == []


# ── Journalisation ──────────────────────────────────────────────────────────

def test_l_erreur_est_journalisee_avec_sa_pile(caplog):
    with caplog.at_level(logging.DEBUG, logger="uvicorn.error"):
        with obs.swallow("t.trace"):
            raise ValueError("visible")
    rec = [r for r in caplog.records if "t.trace" in r.getMessage()]
    assert rec, "le tag doit apparaître dans les logs"
    assert rec[0].exc_info is not None, "sans la pile, le tag ne sert à rien"


def test_le_niveau_est_reglable(caplog):
    with caplog.at_level(logging.WARNING, logger="uvicorn.error"):
        with obs.swallow("t.grave", level=logging.WARNING):
            raise ValueError()
    assert any("t.grave" in r.getMessage() for r in caplog.records)


# ── Robustesse du compteur lui-même ─────────────────────────────────────────

def test_un_compteur_en_panne_ne_casse_pas_le_chemin_observe(monkeypatch):
    """Une comptabilité qui casse ce qu'elle observe serait pire que rien."""
    def boom(*a, **k):
        raise RuntimeError("registre HS")
    monkeypatch.setattr(obs, "_lock", None)      # provoque un TypeError dans record
    with obs.swallow("t.robuste"):
        raise ValueError("erreur métier")
    # on arrive ici : ni l'erreur métier ni celle du registre n'ont remonté
