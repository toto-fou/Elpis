# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_thinking_hors_contexte.py — Un long raisonnement ne pèse
PAS sur le contexte de travail (2026-08-17).

Le raisonnement est éphémère : la boucle outils ne garde jamais
``reasoning_content`` dans ``working_messages`` et ``save_chat`` strippe
``thinking``. Il ne peut donc rien occuper au tour suivant.

Deux endroits le comptaient quand même, et tous deux le SANCTIONNAIENT :
- l'occupation du contexte valait ``prompt_tokens + completion_tokens`` — un
  raisonnement de 20 k tokens déclenchait une compaction pour une occupation
  qui n'existait pas (et la part visible de la complétion était en prime
  comptée deux fois, puisque le message assistant est ajouté APRÈS la mesure) ;
- l'auto-reprise refusait quand ``prompt + thinking cumulé`` frôlait le n_ctx,
  alors que le prompt d'un segment de reprise CONTIENT déjà ce raisonnement :
  le mur tombait vers la moitié de la fenêtre réelle.
"""
from __future__ import annotations

from typing import Any, Dict, List

import pytest

import llm_core._chat_with_tools as _cwt
from tests.llm_core.ctx_scale_harness import (
    compression_cfg,
    hermetic_at_scale,
    patch_fake_tokenize,
    sse_final_scaled,
    sse_tool_call_scaled,
)
from tests.llm_core.goldens_harness import builtin_tools

CTX = 32_768
# n_ctx − cap de génération (0.4·n_ctx = 13 107) − buffer (0.10·n_ctx = 3 276).
USABLE = CTX - 13_107 - 3_276          # 16 385

PROMPT_TOK = 12_000                    # sous ``usable`` : aucune compaction due
THINK_TOK = 20_000                     # ...sauf si on ajoutait la complétion.


def _real_ctx_spy(monkeypatch) -> List[Any]:
    """Capture le ``real_ctx_tokens`` reçu par le pipeline de réduction à
    chaque itération — c'est l'occupation que la boucle croit avoir."""
    seen: List[Any] = []
    _orig = _cwt._fit_context

    async def _spy(working_messages, **kw):
        seen.append(kw.get("real_ctx_tokens"))
        return await _orig(working_messages, **kw)

    monkeypatch.setattr(_cwt, "_fit_context", _spy)
    return seen


@pytest.mark.asyncio
async def test_un_long_raisonnement_ne_declenche_pas_la_compaction(monkeypatch):
    compression_cfg(monkeypatch, COMPRESSION_ENABLED=True,
                    COMPACTION_BUFFER_TOKENS=0)
    patch_fake_tokenize(monkeypatch)
    scripts = [
        # Itération 1 : appel d'outil précédé d'un TRÈS long raisonnement.
        sse_tool_call_scaled("zeta_echo", '{"msg": "salut"}',
                             prompt_tokens=PROMPT_TOK,
                             completion_tokens=THINK_TOK),
        sse_final_scaled("Terminé.", prompt_tokens=PROMPT_TOK),
    ]
    hermetic_at_scale(monkeypatch, scripts, CTX)
    seen = _real_ctx_spy(monkeypatch)
    events: List[Dict[str, Any]] = []

    async def _cb(evt):
        events.append(evt)

    msgs = [{"role": "user", "content": "Utilise zeta_echo puis conclus."}]
    final, _ev, metrics = await _cwt.run_chat_multi_mcp(
        msgs, mcp_configs=[], builtin_tools=builtin_tools(),
        username="t", chat_id="c-think", model="m", memory_enabled=False,
        on_event=_cb)

    assert final.strip() == "Terminé."
    # L'occupation retenue est le PROMPT seul. Avec la complétion, elle valait
    # 32 000 — au-delà de ``usable`` — et la compaction partait.
    mesures = [v for v in seen if v]
    assert mesures, "aucune mesure réelle n'a atteint le pipeline de réduction"
    assert all(v == PROMPT_TOK for v in mesures), mesures
    assert PROMPT_TOK < USABLE < PROMPT_TOK + THINK_TOK   # le piège d'origine
    assert not [e for e in events if e.get("type") == "compression_start"]
    # La conversation n'a rien perdu : aucun tour n'a été remplacé par un résumé.
    assert not [e for e in events if e.get("type") == "compression_state"]


@pytest.mark.asyncio
async def test_la_reflexion_reste_comptee_dans_les_metriques(monkeypatch):
    """Ne pas peser sur le contexte ≠ ne pas être facturée : les compteurs de
    sortie doivent rester complets (non-régression de la séparation
    entrée/réflexion/réponse)."""
    compression_cfg(monkeypatch, COMPRESSION_ENABLED=False)
    patch_fake_tokenize(monkeypatch)
    scripts = [
        sse_tool_call_scaled("zeta_echo", '{"msg": "salut"}',
                             prompt_tokens=PROMPT_TOK,
                             completion_tokens=THINK_TOK),
        sse_final_scaled("Terminé.", prompt_tokens=PROMPT_TOK),
    ]
    hermetic_at_scale(monkeypatch, scripts, CTX)
    _final, _ev, metrics = await _cwt.run_chat_multi_mcp(
        [{"role": "user", "content": "go"}], mcp_configs=[],
        builtin_tools=builtin_tools(), username="t", chat_id="c-metrics",
        model="m", memory_enabled=False)

    assert metrics["output_tokens"] == THINK_TOK + 8
    assert metrics["input_tokens"] == 2 * PROMPT_TOK
