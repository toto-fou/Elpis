# SPDX-License-Identifier: MIT
"""tests/llm_core/test_ctx_scale_anomaly_fixes.py — régressions des 3
anomalies de gestion de contexte corrigées le 2026-07-28 (trouvées par les
sondes d'échelle 256k/1M).

1. ORPHELIN APRÈS CLAMP : ``_clamp_messages`` (appliqué au point d'envoi,
   APRÈS la sanitisation du pipeline) coupait « les derniers non-system » et
   pouvait tomber en pleine paire tool_call ↔ result → ``role:tool`` orphelin
   en tête d'envoi → 500 Jinja sur template strict, en boucle. Fix : re-
   ``sanitize_message_history`` quand le clamp a coupé (les deux chemins).
2. BANDE MORTE PRÉ-PORTE : pré-porte ouverte (réel ≥ ctx·pct·0.85) mais porte
   exacte fermée (tours < seuils) → chaque itération payait un /tokenize
   FULL-history pour un ``threshold_not_reached`` silencieux (le cooldown ne
   comptait que les vraies tentatives). Fix : porte TOURS gratuite avant tout
   comptage dans ``maybe_compress_conversation`` + ancrage du cooldown
   hybride sur ``threshold_not_reached`` côté boucle.
3. NO_TOKEN_GAIN SANS BACKOFF : un chat incompressible re-payait le résumeur
   (LLM bloquant) toutes les ~3 itérations indéfiniment (le cap
   COMPRESSION_MAX_PER_CHAT ne compte que les succès). Fix : chaque échec
   consécutif DOUBLE le cooldown effectif (cap ×8), reset au succès.

Aucun réseau : harnais hermétique d'échelle (cf. ctx_scale_harness).
"""
from __future__ import annotations

import json

import pytest

import llm_core._chat_with_tools as _cwt
from tests.llm_core.ctx_scale_harness import (
    CTX_1M,
    CTX_256K,
    compression_cfg,
    hermetic_at_scale,
    patch_fake_tokenize,
    sse_final_scaled,
    sse_tool_call_scaled,
)
from tests.llm_core.goldens_harness import builtin_tools, sse_final


@pytest.fixture(autouse=True)
def _clear_ctx_cache():
    import llm_core._model_info as mi
    mi._cached_context_size.clear()
    mi._cached_context_size_ts.clear()
    yield
    mi._cached_context_size.clear()
    mi._cached_context_size_ts.clear()


async def _run(monkeypatch, scripts, ctx, *, messages):
    fake = hermetic_at_scale(monkeypatch, scripts, ctx)
    events: list = []

    async def _cb(evt):
        events.append(evt)

    final, _ev, metrics = await _cwt.run_chat_multi_mcp(
        list(messages), mcp_configs=[], builtin_tools=builtin_tools(),
        username="fix", chat_id=None, model="fix-model",
        memory_enabled=False, on_event=_cb)
    return fake, events, final, metrics


def _tc(i, pt):
    return sse_tool_call_scaled("zeta_echo", json.dumps({"msg": f"m{i}"}),
                                f"e{i}", prompt_tokens=pt)


# ── 1. Clamp LLAMA_MAX_MSGS RETIRÉ : historique complet, jamais d'orphelin ──

async def test_sans_clamp_historique_complet_et_apparie(monkeypatch):
    """Le clamp en NOMBRE de messages orphelinait un ``role:tool`` quand la
    coupe tombait en pleine paire (500 Jinja sur template strict). Depuis le
    2026-07-28 le clamp est RETIRÉ : 302 messages appariés partent TOUS, et
    l'envoi ne contient jamais de tool orphelin."""
    compression_cfg(monkeypatch, COMPRESSION_ENABLED=False)

    msgs = [{"role": "system", "content": "socle"},
            {"role": "user", "content": "reprends"}]
    for i in range(150):
        msgs.append({"role": "assistant", "content": None,
                     "tool_calls": [{"id": f"c{i}", "type": "function",
                                     "function": {"name": "execute_shell",
                                                  "arguments": json.dumps({"command": f"s{i}"})}}]})
        msgs.append({"role": "tool", "tool_call_id": f"c{i}",
                     "content": f"resultat {i} " + "x" * 700})

    fake, _events, final, _m = await _run(
        monkeypatch, [sse_final_scaled("ok", prompt_tokens=50_000)],
        CTX_1M, messages=msgs)

    sent = fake.payloads[0]["messages"]
    assert len(sent) == len(msgs), \
        "l'historique complet doit partir (plus de clamp en nombre de messages)"
    assert sent[0]["role"] == "system"
    open_ids: set = set()
    for m in sent:
        if m.get("role") == "assistant":
            for tc in (m.get("tool_calls") or []):
                open_ids.add(tc.get("id"))
        elif m.get("role") == "tool":
            assert m.get("tool_call_id") in open_ids, (
                f"tool orphelin {m.get('tool_call_id')} dans l'envoi — "
                "500 Jinja garanti sur template strict")


# ── 2. Bande morte : UN comptage exact maximum, puis ancrage ────────────────

async def test_bande_morte_un_seul_comptage_puis_ancrage(monkeypatch):
    """Estimation au ratio ≥ usable mais comptage EXACT en dessous : la
    boucle paye UN sweep /tokenize (confirmation) puis ancre l'occupation
    exacte comme pseudo-mesure — plus jamais un comptage par itération
    (l'anomalie d'origine : 8 sweeps pour 8 itérations)."""
    import llm_core._llama_http as lh
    compression_cfg(monkeypatch)
    patch_fake_tokenize(monkeypatch)
    calls: list = []

    # Exact PLUS PETIT que l'estimation (chars//4 < chars/3.3) : la porte
    # estimée ouvre à l'itération 0 (aucune mesure réelle), l'exacte referme.
    async def _count(messages, model_id=None, timeout=None):
        calls.append(len(messages))
        total = sum(len(m.get("content") or "") for m in messages
                    if isinstance(m.get("content"), str))
        return max(1, total // 4)

    monkeypatch.setattr(lh, "count_tokens_for_messages", _count)

    # 12 tours, ~840k chars : estimation ≈ 254k ≥ usable 225 760 ;
    # exact //4 ≈ 210k < usable.
    msgs = [{"role": "system", "content": "socle"}]
    for i in range(6):
        msgs.append({"role": "user", "content": f"question {i} " + "q" * 70_000})
        msgs.append({"role": "assistant", "content": f"reponse {i} " + "r" * 70_000})
    msgs.append({"role": "user", "content": "continue"})

    scripts = [_tc(i, 10_000 + i) for i in range(4)] \
        + [sse_final_scaled("fini", prompt_tokens=10_010)]
    fake, events, final, _m = await _run(monkeypatch, scripts, CTX_256K,
                                         messages=msgs)

    assert len(fake.payloads) == 5
    assert len(calls) == 1, (
        f"{len(calls)} sweeps /tokenize — la confirmation doit être payée UNE "
        "fois puis ancrée (avant le fix : un sweep par itération)")
    assert not [e for e in events
                if str(e.get("type", "")).startswith("compression")]


# ── 3. Backoff des tentatives échouées (no_token_gain) ──────────────────────

async def test_backoff_double_le_cooldown_apres_echec(monkeypatch):
    """Résumé obèse → rollback no_token_gain à chaque tentative. Sans
    backoff, la règle unique (occupation ≥ usable, inchangée après rollback)
    re-payerait le résumeur à CHAQUE itération. Avec : itération 1
    (streak→1, prochaine ≥ +6) puis itération 7 — 2 appels sur tout le run,
    le suivant attendrait +12."""
    compression_cfg(monkeypatch)
    patch_fake_tokenize(monkeypatch)
    OBESE = sse_final("<context>" + "z" * 300_000 + "</context>")

    msgs = [{"role": "system", "content": "socle"}]
    for i in range(5):
        msgs.append({"role": "user", "content": f"question {i} " + "q" * 100})
        msgs.append({"role": "assistant", "content": f"reponse {i} " + "r" * 100})
    msgs.append({"role": "user", "content": "continue"})

    scripts = [
        _tc(0, 230_000),
        OBESE,                                   # tentative 1 → rollback
        _tc(1, 231_000), _tc(2, 232_000), _tc(3, 233_000),
        _tc(4, 234_000), _tc(5, 235_000), _tc(6, 236_000),
        OBESE,                                   # tentative 2 : PAS avant iter 7
        sse_final_scaled("fini", prompt_tokens=240_000),
    ]
    fake, events, final, _m = await _run(monkeypatch, scripts, CTX_256K,
                                         messages=msgs)

    assert final == "fini." or final == "fini", final
    assert len(fake.payloads) == len(scripts), \
        "le déroulé attendu (tentatives aux iters 1 et 7) ne s'est pas produit"
    dones = [e for e in events if e.get("type") == "compression_done"]
    assert len(dones) == 2, \
        f"{len(dones)} tentatives — le backoff doit en éliminer une sur trois"
    assert all(d["stats"].get("reason") == "no_token_gain" for d in dones)
    assert not [e for e in events if e.get("type") == "compression_state"], \
        "aucun état persisté sur des rollbacks"
