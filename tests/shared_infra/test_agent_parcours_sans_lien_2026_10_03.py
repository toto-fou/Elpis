# SPDX-License-Identifier: MIT
"""Parcours de l'agent (listage, relevé avant / après une commande, ``du``) :
un dossier — ou l'un de ses parents — remplacé par un lien ENTRE son relevé
et son ouverture n'est pas parcouru. La bascule est provoquée au moment
exact où le parcours ouvre le dossier, quelle que soit la façon dont il
l'ouvre (``os.open`` ou ``os.scandir`` sur le chemin)."""
from __future__ import annotations

import os
import shutil

import pytest

from shared_infra.sandbox.agent import server as S

SECRET = "SECRET-HORS-DE-WORK" * 1000               # 19 000 octets


def _piege(tmp_path, monkeypatch, sous: str):
    """``work/d/<sous>`` réel, ``hote/<sous>/secret.txt`` hors de la racine ;
    à l'ouverture de ``work/d/<sous>``, ``work/d`` devient un lien vers
    ``hote``. Sans ``sous``, c'est le dossier ouvert lui-même qui bascule
    (refusé par ``O_NOFOLLOW``) ; avec, c'est son PARENT (refusé par la
    comparaison d'inode : ``O_NOFOLLOW`` ne regarde que le dernier composant)."""
    work = tmp_path / "work"
    (work / "d" / sous).mkdir(parents=True)
    (work / "d" / sous / "leurre.txt").write_text("x\n")
    hote = tmp_path / "hote"
    (hote / sous).mkdir(parents=True)
    (hote / sous / "secret.txt").write_text(SECRET)
    cible = str(work / "d" / sous) if sous else str(work / "d")
    basculee = []
    vrai_open, vrai_scandir = os.open, os.scandir

    def basculer(p):
        if p == cible and not basculee:
            basculee.append(True)                     # avant : rmtree rouvre le dossier
            shutil.rmtree(work / "d")
            os.symlink(hote, work / "d")

    def ouvrir(p, *a, **k):
        basculer(p)
        return vrai_open(p, *a, **k)

    def scandir(p="."):
        basculer(p)
        return vrai_scandir(p)
    monkeypatch.setattr(S.os, "open", ouvrir)
    monkeypatch.setattr(S.os, "scandir", scandir)
    return S.Agent(str(work)), basculee


@pytest.fixture(params=["dossier", "parent"])
def piege(request, tmp_path, monkeypatch):
    return _piege(tmp_path, monkeypatch, "" if request.param == "dossier" else "sous")


def test_listage(piege):
    agent, basculee = piege
    vus = [e for e in agent.lister("", 10, 1000, True, (), 30.0) if "path" in e]
    assert basculee, "le dossier n'a pas été ouvert"
    assert "secret.txt" not in str(vus), vus
    fin = list(agent.lister("", 10, 1000, True, (), 30.0))[-1]
    assert fin["done"]


def test_releve_avant_apres_commande(piege):
    agent, basculee = piege
    vus, _complet = agent._parcourir(frozenset(), 1000, 30.0)
    assert basculee, "le dossier n'a pas été ouvert"
    assert not [r for r in vus if "secret.txt" in r], vus


def test_taille(piege):
    agent, basculee = piege
    r = agent._taille(agent.racine, 30.0)
    assert basculee, "le dossier n'a pas été ouvert"
    assert r["bytes"] < len(SECRET), r              # le secret n'est pas compté
