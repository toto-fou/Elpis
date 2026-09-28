# SPDX-License-Identifier: MIT
"""tests/rag_app/test_contextual.py — Contextual Retrieval (opt-in).

Gating de la feature, troncature tête+queue du document pour le prompt,
combinaison contexte+chunk, et surtout le DISJONCTEUR : un LLM mort ne
coûte plus le timeout complet sur chaque chunk du document — après
``_MAX_CONSECUTIVE_FAILURES`` échecs d'affilée, le reste du lot dégrade
immédiatement en préfixe statique.
"""
from __future__ import annotations

import pytest

from rag_app import contextual as C


def _cfg(**over):
    base = {"contextual": {"enabled": True, "url": "http://llm.test",
                           "model": "qwen", "timeout": 5}}
    base["contextual"].update(over)
    return base


# ─── gating ─────────────────────────────────────────────────────────────────

def test_is_enabled_exige_url_et_modele():
    assert C.is_enabled({}) is False
    assert C.is_enabled(_cfg()) is True
    assert C.is_enabled(_cfg(url="")) is False
    assert C.is_enabled(_cfg(model="")) is False
    assert C.is_enabled({"contextual": {"enabled": False, "url": "http://x",
                                        "model": "m"}}) is False


def test_desactive_renvoie_none_alignes():
    out = C.generate_contexts_for_doc("doc", ["c1", "c2"], {})
    assert out == [None, None]
    assert C.generate_contexts_for_doc("doc", [], _cfg()) == []


# ─── prompt ─────────────────────────────────────────────────────────────────

def test_truncate_doc_conserve_tete_et_queue():
    doc = "DEBUT " + "x" * 50_000 + " FIN"
    out = C._truncate_doc(doc, 10_000)
    assert out.startswith("DEBUT")
    assert out.endswith("FIN")
    assert "tronqué" in out
    assert len(out) <= 10_100


def test_truncate_doc_court_inchange():
    assert C._truncate_doc("petit doc", 100) == "petit doc"


def test_build_prompt_contient_doc_et_chunk():
    p = C._build_prompt("le document", "le chunk", 1000)
    assert "<document>" in p and "le document" in p
    assert "<chunk>" in p and "le chunk" in p


def test_combine():
    assert C.combine(None, "chunk") == "chunk"
    assert C.combine("", "chunk") == "chunk"
    assert C.combine("contexte", "chunk") == "contexte\n\nchunk"


# ─── disjoncteur ────────────────────────────────────────────────────────────

def test_disjoncteur_stoppe_apres_echecs_consecutifs(monkeypatch):
    calls = {"n": 0}

    def dead_llm(prompt, section, client=None):
        calls["n"] += 1
        return None

    monkeypatch.setattr(C, "_call_llm", dead_llm)
    chunks = [f"chunk {i}" for i in range(10)]
    out = C.generate_contexts_for_doc("doc", chunks, _cfg())
    assert out == [None] * 10                      # sortie alignée
    assert calls["n"] == C._MAX_CONSECUTIVE_FAILURES   # 3 appels, pas 10


def test_disjoncteur_reset_apres_succes(monkeypatch):
    # 2 échecs, 1 succès (reset), puis 3 échecs → disjonction au 6e appel.
    script = [None, None, "ctx", None, None, None, "jamais-appelé"]
    calls = {"n": 0}

    def flaky_llm(prompt, section, client=None):
        out = script[calls["n"]]
        calls["n"] += 1
        return out

    monkeypatch.setattr(C, "_call_llm", flaky_llm)
    chunks = [f"chunk {i}" for i in range(8)]
    out = C.generate_contexts_for_doc("doc", chunks, _cfg())
    assert calls["n"] == 6
    assert out[2] == "ctx"
    assert out[3:] == [None] * 5


def test_tous_succes_pas_de_disjonction(monkeypatch):
    monkeypatch.setattr(C, "_call_llm",
                        lambda prompt, section, client=None: "contexte")
    out = C.generate_contexts_for_doc("doc", ["a", "b", "c"], _cfg())
    assert out == ["contexte"] * 3


def test_health_check_sans_config():
    res = C.health_check({})
    assert res["ok"] is False
    assert res["configured"] is False
