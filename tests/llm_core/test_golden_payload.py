# SPDX-License-Identifier: MIT
"""tests/llm_core/test_golden_payload.py — payload LLM byte-stable (Phase 0).

LE contrat du refactor : le JSON exact envoyé au serveur LLM par la chaîne
complète ``run_chat_multi_mcp`` (assemblage socle + fragments + fold + budget
+ tri des tools + clamps) ne doit pas dériver pendant les phases 1→7.

Invariants durs vérifiés en plus des snapshots :
- **prefix-cache KV** : la tête système du payload est BYTE-IDENTIQUE entre
  l'itération N et N+1 d'un même tour (sinon llama.cpp re-prefill 1-3 s) ;
- **tri déterministe** de ``tools`` (même sérialisation d'un tour à l'autre) ;
- le chemin tools n'injecte PAS ``payload["thinking"]`` (incompatibilité
  llama.cpp thinking+tools) ;
- un porteur de résumé ``[COMPRESSED_SUMMARY_V1]`` survit à l'assemblage
  (fold + coalesce) sans avaler le socle ni être avalé.

Régénération volontaire : ``GOLDEN_UPDATE=1 venv/bin/pytest …`` — le diff
des .json est la review.
"""
from __future__ import annotations

import json

import pytest

import llm_core._chat_with_tools as _cwt
from llm_core import _chat_classic as _ccl
from llm_core import _llm_params
from llm_core.providers import openai_compat as _oai

from tests.llm_core.goldens_harness import (
    FakeClient,
    assert_matches_golden,
    builtin_tools,
    patch_hermetic,
    sse_final,
    sse_tool_call,
)

SOCLE = "SOCLE GOLDEN — identité de test stable, ne pas reformuler."


async def _run(monkeypatch, scripts, *, messages=None, thinking=False):
    fake = patch_hermetic(monkeypatch, scripts)
    msgs = messages or [
        {"role": "system", "content": SOCLE},
        {"role": "user", "content": "Utilise l'outil zeta_echo puis conclus."},
    ]
    final, events, metrics = await _cwt.run_chat_multi_mcp(
        msgs,
        mcp_configs=[],
        builtin_tools=builtin_tools(),
        username="golden",
        chat_id="golden-chat",
        model="golden-model",
        memory_enabled=False,
        thinking_mode=thinking,
    )
    return fake, final, events, metrics


# ── S1 : tour natif à 2 itérations (tool_call → réponse) ────────────────────

async def test_payload_natif_2_iterations(monkeypatch):
    fake, final, _ev, metrics = await _run(monkeypatch, [
        sse_tool_call("zeta_echo", '{"msg": "ping"}'),
        sse_final("Voilà, c'est fait."),
    ])
    assert final == "Voilà, c'est fait."
    assert metrics.get("finish_reason") == "stop"
    assert len(fake.payloads) == 2

    p1, p2 = fake.payloads

    # Invariant prefix-cache : tête système BYTE-identique entre itérations.
    assert p1["messages"][0]["role"] == "system"
    assert json.dumps(p1["messages"][0], ensure_ascii=False, sort_keys=True) \
        == json.dumps(p2["messages"][0], ensure_ascii=False, sort_keys=True)
    # Le socle fourni est dans la tête (fold : socle + fragments fusionnés).
    assert SOCLE in p1["messages"][0]["content"]

    # Tri déterministe des tools, identique aux deux itérations.
    names1 = [t["function"]["name"] for t in p1["tools"]]
    names2 = [t["function"]["name"] for t in p2["tools"]]
    assert names1 == sorted(names1) and names1 == names2

    # L'itération 2 voit l'appel d'outil apparié (assistant+tool à la suite).
    roles2 = [m["role"] for m in p2["messages"]]
    ia = roles2.index("assistant")
    assert roles2[ia:ia + 2] == ["assistant", "tool"]
    assert p2["messages"][ia]["tool_calls"][0]["function"]["name"] == "zeta_echo"

    assert_matches_golden("payload_native_2iter", fake.payloads)


# ── S2 : thinking_mode avec tools → pas de payload["thinking"] ──────────────

async def test_payload_thinking_avec_tools(monkeypatch):
    fake, _f, _e, _m = await _run(
        monkeypatch, [sse_final("Réponse réfléchie.")], thinking=True,
    )
    p = fake.payloads[0]
    # Incompatibilité llama.cpp : thinking structuré + tools → 400. Le chemin
    # tools ne doit JAMAIS poser payload["thinking"].
    assert "thinking" not in p
    assert_matches_golden("payload_thinking_tools", fake.payloads)


# ── S3 : porteur de résumé de compression → survit à fold + coalesce ────────

async def test_payload_porteur_resume_compression(monkeypatch):
    from llm_core.conversation_compressor import (
        _SUMMARY_MARKER_END,
        _SUMMARY_MARKER_START,
        build_state_system_message,
    )
    carrier = build_state_system_message(
        "<context>résumé antérieur : projet golden.</context>",
        round_no=1, covered_turns=4,
    )
    msgs = [
        {"role": "system", "content": SOCLE},
        carrier,
        {"role": "user", "content": "Continue le travail."},
    ]
    fake, _f, _e, _m = await _run(
        monkeypatch, [sse_final("Je continue.")], messages=msgs,
    )
    p = fake.payloads[0]
    # Un seul system après coalesce (contrainte Jinja single-system)…
    sys_msgs = [m for m in p["messages"] if m["role"] == "system"]
    assert len(sys_msgs) == 1
    # …qui contient LE socle ET le résumé (rien d'avalé).
    body = sys_msgs[0]["content"]
    assert SOCLE in body
    assert _SUMMARY_MARKER_START in body and _SUMMARY_MARKER_END in body
    assert "résumé antérieur" in body
    assert_matches_golden("payload_compression_carrier", fake.payloads)


# ── S5 : catégorie fichier active → runtime_context + fragments foldés ──────

async def test_payload_fold_fragments_et_runtime_context(monkeypatch):
    """Exercice RÉEL de l'assemblage opérationnel (le code que la Phase 2
    déplacera dans context/assembly.py) : catégorie ``fs`` active →
    <runtime_context> + bloc de capacités (FRAGMENT_TOOLS…) FUSIONNÉS dans
    l'unique message système de tête, socle en premier, byte-stables entre
    itérations."""
    import llm_core._mcp_categories as _cats

    monkeypatch.setattr(
        _cats, "categorize",
        lambda n: {"golden_fs_tool": "fs"}.get(n, "other"),
    )

    def _ok(_args):
        return json.dumps({"ok": True})

    builtin = {
        "golden_fs_tool": {
            "definition": {"type": "function", "function": {
                "name": "golden_fs_tool",
                "description": "Outil fichier de test golden.",
                "parameters": {"type": "object", "properties": {}},
            }},
            "handler": _ok,
        },
    }
    fake = patch_hermetic(monkeypatch, [
        sse_tool_call("golden_fs_tool", "{}"),
        sse_final("Fini."),
    ])
    final, _ev, _m = await _cwt.run_chat_multi_mcp(
        [{"role": "system", "content": SOCLE},
         {"role": "user", "content": "liste le dossier"}],
        mcp_configs=[], builtin_tools=builtin,
        username="golden", chat_id="golden-chat", model="golden-model",
        memory_enabled=False,
    )
    assert final == "Fini."
    p1, p2 = fake.payloads
    head1 = p1["messages"][0]["content"]
    # Socle d'abord, puis contexte opérationnel fusionné (PAS de 2e system).
    assert head1.startswith(SOCLE)
    assert "<runtime_context>" in head1
    assert sum(1 for m in p1["messages"] if m["role"] == "system") == 1
    # Byte-stabilité inter-itérations de la tête enrichie.
    assert head1 == p2["messages"][0]["content"]
    assert_matches_golden("payload_fold_fs", fake.payloads)


# ── S4 : chemin classic (sans outils) ───────────────────────────────────────

async def test_payload_classic(monkeypatch):
    async def _asampling(*_a, **_k):
        return {}

    monkeypatch.setattr(_llm_params, "resolve_sampling", _asampling)
    fake = FakeClient([sse_final("Bonjour !")])
    monkeypatch.setattr(_oai, "_get_llm_client", lambda *a, **k: fake)

    thinking, content, meta = await _ccl.llama_chat_stream_tokens([
        {"role": "system", "content": SOCLE},
        {"role": "user", "content": "salut"},
    ])
    assert content == "Bonjour !"
    assert len(fake.payloads) == 1
    assert "tools" not in fake.payloads[0]
    assert_matches_golden("payload_classic", fake.payloads)
