# SPDX-License-Identifier: MIT
"""tests/llm_core/test_compact_retry_helper.py — relance compacte partagée.

``_handle_truncated_tool_call`` remplace deux blocs copiés-collés (chemin
natif + chemin legacy texte) : tool_call coupé par ``finish=length`` → pas
d'exécution, pas de persistance des tool_calls cassés, texte conservé,
consigne « relance compacte » injectée, event ``info`` émis.
"""
from __future__ import annotations

import pytest

from llm_core._chat_with_tools import _handle_truncated_tool_call


@pytest.mark.asyncio
@pytest.mark.parametrize("channel", ["natif", "texte"])
async def test_texte_conserve_et_consigne_injectee(channel):
    events, msgs = [], []

    async def on_event(ev):
        events.append(ev)

    await _handle_truncated_tool_call(
        on_event, msgs, "texte déjà produit", 3, channel=channel,
    )
    # Texte gardé (PAS les tool_calls) + consigne de relance compacte.
    assert msgs[0] == {"role": "assistant", "content": "texte déjà produit"}
    assert msgs[1]["role"] == "user" and "compact" in msgs[1]["content"]
    assert [e["type"] for e in events] == ["info"]


@pytest.mark.asyncio
async def test_sans_texte_pas_de_message_assistant():
    msgs = []

    async def on_event(ev):
        pass

    await _handle_truncated_tool_call(on_event, msgs, "", 1, channel="natif")
    assert len(msgs) == 1 and msgs[0]["role"] == "user"
