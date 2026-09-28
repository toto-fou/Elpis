# SPDX-License-Identifier: MIT
"""tests/llm_core/test_rag_inline_position.py — position d'insertion du RAG inline.

Régression : le contexte RAG était PRÉFIXÉ en position 0 → identité enterrée
après le texte documentaire au coalesce d'envoi + prefix-cache de TOUT le bloc
système invalidé à chaque tour (texte RAG re-requêté, donc volatil). Désormais
inséré APRÈS le run system de tête (socle [+ résumé de compression]) : socle
stable → résumé stable par round → RAG volatil en dernier.
"""
from __future__ import annotations

import llm_core._rag as rag


def _wire(monkeypatch, context_text="CTX_RAG"):
    monkeypatch.setattr(rag, "is_configured", lambda: True)
    monkeypatch.setattr(rag, "call_tool",
                        lambda name, payload: {"used": True,
                                               "context_text": context_text,
                                               "sources": [{"id": 1}]})
    monkeypatch.setattr(rag, "log_metric", lambda *a, **k: None)


def test_rag_insere_apres_le_bloc_system(monkeypatch):
    _wire(monkeypatch)
    msgs = [{"role": "system", "content": "SOCLE"},
            {"role": "system", "content": "RESUME"},
            {"role": "user", "content": "question ?"}]
    out, meta = rag.apply_rag(msgs)
    assert meta["used"] is True
    assert [m["role"] for m in out] == ["system", "system", "system", "user"]
    assert out[0]["content"] == "SOCLE"
    assert out[1]["content"] == "RESUME"
    assert out[2]["content"] == "CTX_RAG"      # RAG en DERNIER des system
    # Liste d'origine non mutée (copie insérée).
    assert len(msgs) == 3 and msgs[0]["content"] == "SOCLE"


def test_rag_sans_system_insere_en_tete(monkeypatch):
    _wire(monkeypatch)
    msgs = [{"role": "user", "content": "question ?"}]
    out, _ = rag.apply_rag(msgs)
    assert out[0] == {"role": "system", "content": "CTX_RAG"}
    assert out[1]["role"] == "user"


def test_rag_echec_service_messages_inchanges(monkeypatch):
    monkeypatch.setattr(rag, "is_configured", lambda: True)
    monkeypatch.setattr(rag, "log_metric", lambda *a, **k: None)

    def _boom(name, payload):
        raise rag.RagServiceError("down")

    monkeypatch.setattr(rag, "call_tool", _boom)
    msgs = [{"role": "system", "content": "S"}, {"role": "user", "content": "q"}]
    out, meta = rag.apply_rag(msgs)
    assert out is msgs
    assert meta["used"] is False
