# SPDX-License-Identifier: MIT
"""
tests/load/budgets.py — les seuils qui font échouer une campagne.

Un harnais qui affiche des chiffres sans jamais dire « non » ne protège de
rien : on finit par le lire en diagonale. Les budgets ci-dessous transforment
la campagne en garde-fou.

Ils portent sur des propriétés **structurelles**, pas sur des chronos absolus :
la machine de mesure varie, la propriété non. « Le témoin ne doit pas subir la
charge des autres » reste vrai sur une VM lente comme sur un serveur rapide,
alors que « p99 < 40 ms » ne veut rien dire sans préciser sur quoi.
"""
from __future__ import annotations

from typing import Any

from .metrics import Campagne

#: Ce que le témoin — un utilisateur qui ne fait rien de lourd — a le droit de
#: subir pendant qu'une charge tourne. C'est le budget le plus important du
#: fichier : il exprime « la charge des uns ne doit pas devenir la latence des
#: autres ». Généreux volontairement (une VM 4 cœurs partagée), mais très en
#: dessous des ~900 ms qu'on observait quand PBKDF2 tournait sur la boucle.
TEMOIN_P99_MS = 400.0
TEMOIN_MAX_MS = 2000.0

#: Aucun geste ne doit échouer, hors familles explicitement attendues.
TAUX_ECHEC_MAX_PCT = 0.5

#: Familles d'échec qui invalident la campagne quoi qu'il arrive : elles
#: signalent un défaut, jamais une simple lenteur.
FAMILLES_INTERDITES = (
    "SQLite : database is locked (contention d'écriture)",
    "délai dépassé (le serveur n'a pas répondu)",
    "connexion refusée/coupée (backlog plein ou worker mort)",
)

#: Dérive de ressources tolérée **en régime établi** (seconde moitié du
#: scénario). La montée en charge, elle, n'est pas budgétée : elle est
#: normale et se compte en dizaines de mégaoctets — la budgéter reviendrait
#: à crier à la fuite à chaque campagne.
DERIVE_FDS_MAX = 40
DERIVE_THREADS_MAX = 15
DERIVE_RSS_MO_MAX = 60.0


def evaluer(campagne: Campagne) -> dict[str, Any]:
    """Confronte une campagne à ses budgets. Ne lève jamais : rend un verdict."""
    depassements: list[str] = []
    d = campagne.json()

    for serie in d["series"]:
        temoin = serie["nom"].startswith("témoin")
        if temoin:
            if serie["p99_ms"] > TEMOIN_P99_MS:
                depassements.append(
                    f"le témoin a subi la charge : p99 {serie['p99_ms']} ms "
                    f"(budget {TEMOIN_P99_MS:.0f} ms) — un geste anodin a attendu "
                    "pendant que d'autres travaillaient")
            if serie["max_ms"] > TEMOIN_MAX_MS:
                depassements.append(
                    f"le témoin a été gelé jusqu'à {serie['max_ms']} ms "
                    f"(budget {TEMOIN_MAX_MS:.0f} ms)")
        if serie["taux_echec_pct"] > TAUX_ECHEC_MAX_PCT:
            depassements.append(
                f"« {serie['nom']} » : {serie['taux_echec_pct']} % d'échecs "
                f"(budget {TAUX_ECHEC_MAX_PCT} %) — {serie['familles']}")
        for famille in serie["familles"]:
            if famille in FAMILLES_INTERDITES:
                depassements.append(
                    f"« {serie['nom']} » : {serie['familles'][famille]} × {famille}")

    derive = d.get("derive") or {}
    if derive.get("fds", 0) > DERIVE_FDS_MAX:
        depassements.append(f"fuite probable de descripteurs : {derive['fds']:+g} "
                            f"pendant le scénario (budget {DERIVE_FDS_MAX})")
    if derive.get("threads", 0) > DERIVE_THREADS_MAX:
        depassements.append(f"fuite probable de threads : {derive['threads']:+g} "
                            f"(budget {DERIVE_THREADS_MAX})")
    if derive.get("rss_mo", 0) > DERIVE_RSS_MO_MAX:
        depassements.append(f"mémoire en croissance continue : {derive['rss_mo']:+g} Mo "
                            f"(budget {DERIVE_RSS_MO_MAX} Mo)")

    return {"scenario": d["scenario"], "depassements": depassements}


def rendre_verdict(verdict: dict[str, Any]) -> str:
    if not verdict["depassements"]:
        return "  ✓ budgets tenus"
    return "\n".join(["  ✗ budgets dépassés :"]
                     + [f"      • {m}" for m in verdict["depassements"]])
