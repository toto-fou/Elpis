# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_ctx_gauge_remote_gating.py

Jauge de contexte — RÉEL SEUL (usage serveur de fin de requête).

La jauge n'émet AUCUN pré-vol estimé : un unique event ``kv_cache`` par appel
LLM, construit depuis ``usage.prompt_tokens`` réel. Elle n'a de sens que pour
le llama.cpp LOCAL (n_ctx réel via /props). Pour une cible DISTANTE (connecteur
cloud/vLLM), le /props LOCAL donnerait un n_ctx FAUX → le chemin outils doit,
comme le chemin classic, NE PAS émettre d'events ``kv_cache``.
"""
from __future__ import annotations

import pytest

import llm_core._chat_with_tools as _cwt
import llm_core._target as _tgt
from llm_core import _model_info


async def _anoop(*_a, **_k):
    return None


async def _avision(*_a, **_k):
    return False


class _FakeTarget:
    def __init__(self, local: bool):
        # ``local=False`` = fournisseur NON llama.cpp (fenêtre inconnue ⇒ jauge
        # masquée) ; un connecteur llama.cpp a désormais sa jauge (2026-09-16).
        self.is_local_llamacpp = local
        self.is_llamacpp = local


async def _run_collect_kv(monkeypatch, *, local: bool):
    monkeypatch.setattr(_cwt, "verify_llm_availability", _anoop)
    monkeypatch.setattr(_cwt, "_model_supports_vision", _avision)

    async def _ctx(*_a, **_k):
        return 32000

    monkeypatch.setattr(_model_info, "get_model_context_size", _ctx)
    monkeypatch.setattr(_tgt, "current_target", lambda: _FakeTarget(local))

    async def _fake_stream(messages, tools_payload, **kw):
        return {
            "choices": [{
                "finish_reason": "stop",
                "message": {"role": "assistant", "content": "salut", "tool_calls": None},
            }],
            "usage": {"prompt_tokens": 5000, "completion_tokens": 2},
            "timings": {},
        }

    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", _fake_stream)

    seen = []

    async def _on_event(ev):
        seen.append(ev)

    await _cwt.run_chat_multi_mcp(
        [{"role": "user", "content": "x"}],
        mcp_configs=[], builtin_tools=None, username="u", on_event=_on_event,
    )
    return [e for e in seen if isinstance(e, dict) and e.get("type") == "kv_cache"]


async def test_gauge_emitted_for_local_llamacpp(monkeypatch):
    kv = await _run_collect_kv(monkeypatch, local=True)
    assert kv, "llama.cpp local : la jauge (events kv_cache, tokens réels) doit être émise"
    # Le total est le n_ctx réel ; le 'used' est le prompt RÉEL du serveur
    # (usage.prompt_tokens du fake stream), pas une estimation.
    assert all(e.get("total") == 32000 for e in kv)
    assert [e.get("used") for e in kv] == [5000]
    # Plus d'event pré-vol : un SEUL kv_cache par appel LLM, sans phase ni est.
    assert all("phase" not in e and "est" not in e for e in kv)


async def test_gauge_suppressed_for_remote_target(monkeypatch):
    kv = await _run_collect_kv(monkeypatch, local=False)
    assert kv == [], (
        "cible distante : AUCUN event kv_cache — sinon la jauge afficherait un "
        "n_ctx local faux + des « tokens » dérivés des caractères"
    )
