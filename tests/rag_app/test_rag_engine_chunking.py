# SPDX-License-Identifier: MIT
"""tests/rag_app/test_rag_engine_chunking.py — découpage en chunks.

Couvre en particulier les GARDES DE TERMINAISON ajoutées : l'ancien
``_chunk_by_size`` bouclait à l'infini quand ``overlap >= size``, quand
``size <= 0``, ou quand un long token sans espace faisait reculer le
curseur via le repli sur frontière de mot ; ``_chunk_by_sentence`` rejouait
la même fenêtre quand l'overlap dépassait la taille du chunk.
"""
from __future__ import annotations

import json

import pytest

from rag_app import rag_engine as E


@pytest.fixture
def eng(tmp_path):
    cfg = {
        "collection": "col1",
        "qdrant_url": "http://q.test:6333",
        "embed_base_url": "http://emb.test",
        "embed_model": "bge-m3",
        "state_file": str(tmp_path / "state.json"),
        "global_method": "size",
        "global_chunk_size": 100,
        "global_chunk_overlap": 10,
        "global_max_chunk_size": 4000,
    }
    p = tmp_path / "rag_config.json"
    p.write_text(json.dumps(cfg), encoding="utf-8")
    engine = E.RAGEngine(str(p))
    yield engine
    engine.close()


# ─── _chunk_by_size : terminaison ────────────────────────────────────────────

def test_size_basique_couvre_tout(eng):
    text = ("mot " * 300).strip()          # 1199 chars
    chunks = eng._chunk_by_size(text, 200, 20)
    assert chunks
    assert chunks[0]["start"] == 0
    assert chunks[-1]["end"] == len(text)
    for c in chunks:
        assert c["text"] == text[c["start"]:c["end"]]
        assert len(c["text"]) <= 200


def test_size_overlap_superieur_a_size_termine(eng):
    text = "abcdef " * 200
    chunks = eng._chunk_by_size(text, 50, 500)   # overlap >> size
    assert chunks
    assert chunks[-1]["end"] == len(text)
    # progression stricte du curseur
    starts = [c["start"] for c in chunks]
    assert all(b > a for a, b in zip(starts, starts[1:]))


def test_size_zero_clampe(eng):
    text = "abcdef"
    chunks = eng._chunk_by_size(text, 0, 150)
    assert len(chunks) == len(text)          # clampé à size=1
    assert "".join(c["text"] for c in chunks) == text


def test_size_token_sans_espace_ne_recule_pas(eng):
    # Le repli sur frontière de mot ramenait ``end`` juste après « intro »
    # puis ``end - overlap`` faisait RECULER start → boucle infinie.
    text = "intro " + "x" * 5000 + " fin"
    chunks = eng._chunk_by_size(text, 1000, 150)
    assert chunks
    assert chunks[-1]["end"] == len(text)
    starts = [c["start"] for c in chunks]
    assert all(b > a for a, b in zip(starts, starts[1:]))


# ─── _chunk_by_sentence ─────────────────────────────────────────────────────

def test_sentence_normal(eng):
    text = "Première phrase. Deuxième phrase. Troisième phrase. Quatrième phrase."
    chunks = eng._chunk_by_sentence(text, 40, 10)
    assert chunks
    assert all(c["text"] for c in chunks)
    # tout le texte est représenté (le dernier chunk atteint la fin)
    assert chunks[-1]["end"] == len(text)


def test_sentence_overlap_geant_termine(eng):
    text = " ".join(f"Phrase numéro {i}." for i in range(50))
    chunks = eng._chunk_by_sentence(text, 30, 10_000)
    assert chunks
    assert len(chunks) <= 60   # borné : pas d'explosion de fenêtres rejouées


def test_sentence_sans_ponctuation_retombe_sur_size(eng):
    text = "a" * 250
    chunks = eng._chunk_by_sentence(text, 100, 10)
    assert len(chunks) >= 2    # fallback _chunk_by_size


# ─── markdown / delimiter / regex ───────────────────────────────────────────

def test_markdown_titres(eng):
    text = "# T1\ncorps 1\n## T2\ncorps 2\n### T3\ncorps 3"
    chunks = eng._chunk_by_markdown(text)
    assert len(chunks) == 3
    assert chunks[0]["text"].startswith("# T1")
    assert chunks[1]["text"].startswith("## T2")


def test_delimiter(eng):
    text = "def a():\n  pass\ndef b():\n  pass"
    chunks = eng._chunk_by_delimiter(text, "def")
    assert len(chunks) == 2
    assert all("def" in c["text"] or i == 0 for i, c in enumerate(chunks))


def test_regex_invalide_retombe_sur_size(eng):
    text = "mot " * 100
    chunks = eng._chunk_by_regex(text, "(((", 50, 5)
    assert chunks   # pas d'exception, fallback silencieux
    assert chunks[-1]["end"] == len(text.rstrip()) or chunks[-1]["end"] == len(text)


# ─── chunk_text : intégration ───────────────────────────────────────────────

def test_chunk_text_params_hostiles_terminent(eng):
    text = "mot " * 500
    out = eng.chunk_text(text, ".txt",
                         custom_params={"method": "size",
                                        "size": "50", "overlap": "5000"})
    assert out
    assert all(c["text"].strip() for c in out)


def test_chunk_text_size_negatif_ignore(eng):
    # « -5 » n'est pas .isdigit() → la taille par défaut (100) est gardée,
    # puis clampée ≥ 1 : aucun crash, découpage sain.
    out = eng.chunk_text("mot " * 200, ".txt",
                         custom_params={"method": "size",
                                        "size": "-5", "overlap": "10"})
    assert out
    assert all(len(c["text"]) <= 100 for c in out)


def test_chunk_text_subdivision_gmax_et_dedup(eng):
    eng.cfg["global_max_chunk_size"] = 100
    # un « raw chunk » unique de 350 chars → sous-découpé ≤ 100
    text = "x" * 350
    out = eng.chunk_text(text, ".txt", custom_params={"method": "size",
                                                      "size": "1000",
                                                      "overlap": "0"})
    assert all(len(c["text"]) <= 100 for c in out)
    # dédup : deux moitiés identiques ne produisent le chunk qu'une fois
    dup = eng.chunk_text("ABC ABC", ".txt",
                         custom_params={"method": "delimiter", "value": " "})
    texts = [c["text"] for c in dup]
    assert len(texts) == len(set(texts))


def test_chunk_text_regles_fichier_prioritaires(eng):
    eng.cfg["file_rules"] = {"doc/special.md": {"method": "delimiter", "value": "%%"}}
    eng.cfg["folder_rules"] = {"doc": {"method": "size", "size": 40, "overlap": 0}}
    eng.cfg["extension_rules"] = {".md": {"method": "markdown"}}
    text = "aaa %% bbb %% ccc"
    # file_rule gagne → delimiter %%
    out = eng.chunk_text(text, ".md", rel_path="doc/special.md")
    assert len(out) == 3
    # folder_rule pour un autre fichier du dossier → size 40
    out2 = eng.chunk_text("mot " * 40, ".md", rel_path="doc/autre.md")
    assert all(len(c["text"]) <= 40 for c in out2)
    # extension_rule pour un fichier hors dossier → markdown
    out3 = eng.chunk_text("# T\ncorps\n# T2\ncorps2", ".md", rel_path="racine.md")
    assert len(out3) == 2


def test_chunk_text_vide(eng):
    assert eng.chunk_text("", ".txt") == []
    assert eng.chunk_text(None, ".txt") == []
    assert eng.chunk_text(b"bytes bruts", ".txt")   # bytes décodés, pas de crash
