# SPDX-License-Identifier: MIT
"""tests/llm_core/test_mcp_serveur_injoignable_2026_09_04.py

RÉGRESSION COUVERTE — « le modèle ne voit pas les outils externes ».

Quand un serveur MCP externe (Jenkins, wiki.js, bibliothèque partagée…) ne
répond pas, ``_collect_mcp_tools`` continue le tour avec les serveurs qui, eux,
ont répondu. Mais il l'annonçait par un événement ``type: "error"`` — or côté
front, ``error`` est TERMINAL : il marque le message ``isError``, coupe
``isStreaming`` et annule les flux d'édition en cours (cf.
``frontend/js/app-chat.js``, branche ``data.type === 'error'``). Un seul serveur
injoignable sabordait donc l'affichage de tout le tour, sans jamais dire que le
reste avait fonctionné — et sans que rien n'indique lequel manquait.

L'événement est désormais un ``warning`` (bandeau 12 s, tour préservé). Le cas
VRAIMENT fatal — aucun serveur connecté et aucun builtin — reste un
``RuntimeError``, donc une vraie erreur de tour.
"""
from __future__ import annotations

import asyncio

import pytest

from llm_core import _chat_with_tools as C


class _Outil:
    """Forme minimale d'un outil MCP telle que la lit ``mcp_tool_to_openai``."""

    def __init__(self, name: str):
        self.name = name
        self.description = name
        self.inputSchema = {"type": "object", "properties": {}}
        self.annotations = None


LOCAUX = [_Outil("read_file"), _Outil("todowrite")]
EXTERNES = [_Outil("jenkins_build"), _Outil("jenkins_status")]

CFG_LOCAL = {"type": "stdio", "name": "Outils Locaux",
             "command": "DEFAULT_LOCAL_PYTHON", "filter_categories": ["fs"]}
CFG_EXT = {"type": "sse", "name": "Jenkins", "url": "http://jenkins.invalide/sse"}


def _pool(reponses):
    """``get_or_connect`` simulé : ``reponses[nom]`` = outils, ou une exception."""
    async def _fake(cfg, resolve_client_fn=None):
        r = reponses[cfg["name"]]
        if isinstance(r, BaseException):
            raise r
        return object(), r
    return _fake


def _collecte(monkeypatch, cfgs, reponses):
    monkeypatch.setattr(C.mcp_pool, "get_or_connect", _pool(reponses))
    events: list = []

    async def _on_event(e):
        events.append(e)

    res = asyncio.run(C._collect_mcp_tools(cfgs, None, _on_event, memory_enabled=False))
    return res, events


def test_un_serveur_injoignable_est_un_avertissement_pas_une_erreur(monkeypatch):
    (tmap, payload, _h, connectes), events = _collecte(
        monkeypatch, [CFG_LOCAL, CFG_EXT],
        {"Outils Locaux": LOCAUX, "Jenkins": ConnectionError("connection refused")})

    types = [e["type"] for e in events]
    assert "error" not in types, (
        "un échec PARTIEL ne doit pas produire d'événement terminal : le front "
        "marquerait tout le message en erreur alors que le tour continue")
    assert "warning" in types

    warn = next(e for e in events if e["type"] == "warning")
    assert "Jenkins" in warn["text"]                     # QUEL serveur manque
    assert "connection refused" in warn["text"]          # POURQUOI

    # …et le tour garde bien les outils du serveur qui a répondu.
    assert "read_file" in tmap
    assert connectes == ["Outils Locaux (fs)"]


def test_les_serveurs_sains_survivent_a_la_panne_d_un_autre(monkeypatch):
    """Deux externes, un seul en panne : l'autre doit rester utilisable."""
    autre = dict(CFG_EXT, name="wiki.js", url="http://wiki.invalide/sse")
    (tmap, payload, _h, connectes), events = _collecte(
        monkeypatch, [CFG_EXT, autre],
        {"Jenkins": TimeoutError("timed out"), "wiki.js": EXTERNES})

    assert sorted(t["function"]["name"] for t in payload) == ["jenkins_build", "jenkins_status"]
    assert connectes == ["wiki.js"]
    assert [e["type"] for e in events] == ["warning"]


def test_aucun_serveur_joignable_reste_une_vraie_erreur(monkeypatch):
    """Le cas fatal doit le rester : sans AUCUN outil, le tour est impossible."""
    monkeypatch.setattr(C.mcp_pool, "get_or_connect",
                        _pool({"Jenkins": ConnectionError("refused")}))
    with pytest.raises(RuntimeError, match="Jenkins"):
        asyncio.run(C._collect_mcp_tools([CFG_EXT], None, None, memory_enabled=False))


def test_un_externe_sans_categorie_reste_visible_du_modele(monkeypatch):
    """Non-régression du cas nominal : un serveur externe n'a pas de
    ``filter_categories`` ; le filtre par catégories ne doit donc PAS s'y
    appliquer, et le gating par mots-clés doit rester ouvert (les outils
    externes tombent dans la catégorie « other », qui n'est pas gatée)."""
    (tmap, payload, _h, connectes), _events = _collecte(
        monkeypatch, [CFG_LOCAL, CFG_EXT],
        {"Outils Locaux": LOCAUX, "Jenkins": EXTERNES})

    noms = sorted(t["function"]["name"] for t in payload)
    assert "jenkins_build" in noms and "jenkins_status" in noms
    # Le filtre local reste appliqué (``fs`` cochée → read_file ; todowrite est
    # une catégorie CACHÉE, toujours dispo).
    assert "read_file" in noms
    assert tmap["jenkins_build"]["name"] == "Jenkins"
