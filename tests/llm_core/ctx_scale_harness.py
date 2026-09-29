# SPDX-License-Identifier: MIT
"""tests/llm_core/ctx_scale_harness.py — harnais partagé des tests d'échelle
de contexte 256k / 1M (2026-07-28).

Objectif : exercer la tuyauterie COMPLÈTE de gestion de contexte (emit cap →
élagage monotone → budget dur → pré-porte → compression → payload) avec des
conversations synthétiques volumineuses, à ``n_ctx = 262144`` et ``1048576``,
et observer les VRAIS échanges internes (payloads capturés itération par
itération, events, stats ``fit_context``).

Fournit :
- ``expected(ctx)`` : les constantes dérivées (emit cap, seuils de vague,
  réserve, budget prompt, pré-porte…) recalculées depuis la source unique
  (``BUDGET`` / ``effective_generation_cap``) — les tests consomment ce dict,
  seul le test de calibration les visse aux littéraux (``LITERALS``) ;
- fabriques de conversations : ``blob``/``shell_round``/``echo_round``/
  ``desktop_round``/``diff_round``/``image_user``/``build_conversation`` ;
- patchs d'échelle : ``patch_scale`` (les TROIS liaisons de
  ``get_model_context_size``), ``hermetic_at_scale`` (goldens_harness +
  échelle), ``patch_fake_tokenize`` (chemin compresseur), ``compression_cfg``
  (config déterministe + reload disque neutralisé + FTS neutralisée),
  ``fit_spy`` (fenêtre sur les décisions internes de la boucle) ;
- scripts SSE à usage piloté : ``sse_tool_call_scaled``/``sse_final_scaled``
  (les helpers goldens figent prompt_tokens=120/150 — on ne les touche pas,
  zéro churn des goldens).

Aucun réseau : tout point de sortie est monkeypatché (cf. goldens_harness).
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

import pytest

from llm_core.context.tokens import CHARS_PER_TOKEN, approx_prompt_tokens
from tests.llm_core.goldens_harness import FakeClient, patch_hermetic

# ── Échelles ────────────────────────────────────────────────────────────────

CTX_256K = 262_144
CTX_1M = 1_048_576
SCALES = (CTX_256K, CTX_1M)
SCALE_IDS = ("256k", "1M")

# Décorateur partagé : chaque test paramétré tourne aux deux échelles.
scale_param = pytest.mark.parametrize("ctx", SCALES, ids=SCALE_IDS)

# ── Constantes dérivées (source unique) + littéraux de calibration ──────────

# Littéraux ATTENDUS aux deux échelles (calculés à la main depuis les formules
# de budget.py / pruning.py / gate.py / _constants.py). Le test de calibration
# compare ``expected(ctx)`` à cette table : si ``context_config.json`` retune
# un ratio, c'est LUI qui échoue en le disant — les autres tests, eux,
# consomment ``expected()`` et suivent le tuning.
LITERALS: Dict[int, Dict[str, Any]] = {
    CTX_256K: {
        "emit_cap":              51_902,      # T0 : clamp(2400, 0.06·ctx, 25000) tk × ratio 3.3
        # M4 : élagage fin de tour en TOKENS (llm.prune.*) — décision user :
        # fenêtre protégée = 20 % du n_ctx TOTAL ; gain min = min(20k, 10 %).
        "prune_protect_tokens":  52_428,      # int(0.20 × ctx)
        "prune_min_tokens":      20_000,      # min(20 000, int(0.10 × ctx))
        "gen_cap":               16_384,      # min(16384, max(2048, int(0.4·ctx)))
        "gen_cap_thinking":      24_576,
        "reserve":               47_185,      # max(3072, int(0.18·ctx), gen_cap)
        "prompt_budget":         214_959,     # ctx − réserve (tools=0)
        "fastpath_edge":         182_715,     # int(prompt_budget × 0.85)
        "usable":                225_760,     # ctx − gen_cap − buffer auto 20k (M3)
    },
    CTX_1M: {
        "emit_cap":              82_500,      # T0 : plafond 25 000 tk × ratio 3.3
        "prune_protect_tokens":  209_715,     # int(0.20 × ctx)
        "prune_min_tokens":      20_000,
        "gen_cap":               16_384,
        "gen_cap_thinking":      24_576,
        "reserve":               188_743,
        "prompt_budget":         859_833,
        "fastpath_edge":         730_858,
        "usable":                1_012_192,
    },
}


def expected(ctx: int) -> Dict[str, Any]:
    """Constantes dérivées pour ``ctx``, recalculées depuis la SOURCE UNIQUE
    (aucun littéral ici — la table ``LITERALS`` ne sert qu'au doc-test de
    calibration)."""
    from llm_core._constants import effective_generation_cap
    from llm_core.context.budget import BUDGET
    from llm_core.context.pruning import _FASTPATH_MARGIN, emit_cap_chars

    gen_cap = effective_generation_cap(False, ctx)
    prompt_budget = BUDGET.prompt_budget(ctx, gen_cap)
    return {
        "emit_cap":              emit_cap_chars(ctx),
        # M4 : dérivations AUTO de llm.prune.* (config 0 → auto).
        "prune_protect_tokens":  int(ctx * 0.20),
        "prune_min_tokens":      min(20_000, int(ctx * 0.10)),
        "gen_cap":               gen_cap,
        "gen_cap_thinking":      effective_generation_cap(True, ctx),
        "reserve":               BUDGET.reserve_tokens(ctx, gen_cap),
        "prompt_budget":         prompt_budget,
        "fastpath_edge":         int(prompt_budget * _FASTPATH_MARGIN),
        # M3 : fenêtre utilisable de la règle unique d'overflow
        # (buffer auto = min(20k, 10 %·ctx) quand la config vaut 0).
        "usable":                ctx - gen_cap - min(20_000, int(ctx * 0.10)),
    }


# ── Fabriques de contenus / conversations ───────────────────────────────────

def blob(n_chars: int, label: str) -> str:
    """Texte déterministe d'EXACTEMENT ``n_chars`` caractères, avec
    sentinelles ``<<HEAD label>>`` en tête et ``<<TAIL label exit=0>>`` en
    toute fin — permet de vérifier qu'une coupe tête+queue préserve les DEUX
    bouts (et qu'une coupe tête-seule préserve la tête)."""
    head = f"<<HEAD {label}>>\n"
    tail = f"\n<<TAIL {label} exit=0>>"
    filler_len = n_chars - len(head) - len(tail)
    assert filler_len >= 0, f"blob trop court pour les sentinelles : {n_chars}"
    line = f"{label} sortie ligne deterministe " + "x" * 60 + "\n"
    filler = (line * (filler_len // len(line) + 1))[:filler_len]
    return head + filler + tail


def _tc(call_id: str, name: str, args: Dict[str, Any]) -> Dict[str, Any]:
    return {"id": call_id, "type": "function",
            "function": {"name": name,
                         "arguments": json.dumps(args, ensure_ascii=False)}}


def shell_round(i: int, n_chars: int = 30_000) -> List[Dict[str, Any]]:
    """Paire assistant(tool_calls execute_shell) + tool result volumineux —
    le gros du volume d'une conversation agentique réelle."""
    cid = f"c{i}"
    return [
        {"role": "assistant", "content": None,
         "tool_calls": [_tc(cid, "execute_shell", {"command": f"./step_{i}.sh"})]},
        {"role": "tool", "tool_call_id": cid, "content": blob(n_chars, f"shell{i}")},
    ]


def echo_round(i: int) -> List[Dict[str, Any]]:
    """Petit round outillé (~200 chars de résultat)."""
    cid = f"c{i}"
    return [
        {"role": "assistant", "content": None,
         "tool_calls": [_tc(cid, "zeta_echo", {"msg": f"ping-{i}"})]},
        {"role": "tool", "tool_call_id": cid,
         "content": json.dumps({"ok": True, "echo": f"ping-{i}",
                                "note": "petit resultat outil " + "y" * 120})},
    ]


def desktop_round(i: int, n_elements: int = 150) -> List[Dict[str, Any]]:
    """Perception desktop : clé ``elements`` volumineuse + champs de frame
    (``frame_token``/``img_w``…) que ``compact_desktop_elements`` droppe."""
    cid = f"c{i}"
    els = [{"id": k, "label": f"bouton {k}", "role": "button",
            "center": [10 * k, 20 + k], "box": [10 * k, 20, 80, 24],
            "confidence": 0.93, "source": "uia", "depth": 4}
           for k in range(n_elements)]
    content = json.dumps({"elements": els, "frame_token": f"tok{i}",
                          "img_w": 1920, "img_h": 1080, "sig": "shash"},
                         ensure_ascii=False)
    return [
        {"role": "assistant", "content": None,
         "tool_calls": [_tc(cid, "desktop_observe", {})]},
        {"role": "tool", "tool_call_id": cid, "content": content},
    ]


def diff_round(i: int, diff_lines: int = 300) -> List[Dict[str, Any]]:
    """Résultat write_file avec ``diff`` complet (strippé côté modèle par
    ``_strip_model_diff``, stats conservées)."""
    cid = f"c{i}"
    diff = "".join(f"+ligne ajoutee {k} du diff module {i}\n" for k in range(diff_lines))
    content = json.dumps({"ok": True, "path": f"src/mod_{i}.py", "diff": diff,
                          "lines_added": diff_lines, "lines_removed": 3},
                         ensure_ascii=False)
    return [
        {"role": "assistant", "content": None,
         "tool_calls": [_tc(cid, "write_file",
                            {"path": f"src/mod_{i}.py", "content": "..."})]},
        {"role": "tool", "tool_call_id": cid, "content": content},
    ]


def image_user(i: int) -> Dict[str, Any]:
    """Message user multimodal : un bloc texte + une image data-URI courte."""
    return {"role": "user", "content": [
        {"type": "text", "text": f"capture d'ecran {i}"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,QUJDREVG"}},
    ]}


def build_conversation(
    target_tokens: int,
    *,
    tool_chars: int = 30_000,
    mix: tuple = ("shell", "echo", "shell", "diff"),
) -> List[Dict[str, Any]]:
    """system + user + rounds outillés cyclés jusqu'à
    ``approx_prompt_tokens(msgs) ≥ target_tokens`` (autorité 3.3 — la même
    que la tuyauterie testée). Le dernier blob est ajusté pour atterrir
    juste au-dessus de la cible (~±1 %)."""
    msgs: List[Dict[str, Any]] = [
        {"role": "system", "content": "Socle de test — echelle contexte."},
        {"role": "user", "content": "Demarre la longue tache outillee."},
    ]
    i = 0
    while True:
        cur = approx_prompt_tokens(msgs)
        if cur >= target_tokens:
            break
        remaining = target_tokens - cur
        if remaining * CHARS_PER_TOKEN < tool_chars + 500:
            # Dernier round : blob calibré sur les tokens restants.
            msgs += shell_round(i, max(600, int(remaining * CHARS_PER_TOKEN)))
        else:
            kind = mix[i % len(mix)]
            if kind == "shell":
                msgs += shell_round(i, tool_chars)
            elif kind == "echo":
                msgs += echo_round(i)
            elif kind == "desktop":
                msgs += desktop_round(i)
            else:
                msgs += diff_round(i)
        i += 1
    return msgs


# ── Patchs d'échelle ────────────────────────────────────────────────────────

def patch_scale(monkeypatch, ctx: int) -> None:
    """Fait résoudre ``n_ctx = ctx`` PARTOUT, sans réseau.

    Trois liaisons distinctes (vérifiées dans le code) :
      1. ``_chat_with_tools.get_model_context_size`` — import module-level,
         pilote pruning/compression/emit-cap de la boucle ;
      2. ``_model_info.get_model_context_size`` — résolu à l'appel par
         ``build_llama_payload`` (clamp de génération, import local) ;
      3. ``llm_core.get_model_context_size`` — copie de façade figée à
         l'import, résolue à l'appel par le compresseur (budget sérialiseur).
    + purge du cache global ``_cached_context_size`` (TTL monotonic)."""
    import llm_core
    import llm_core._chat_with_tools as _cwt
    import llm_core._model_info as _mi

    async def _actx(*_a, **_k):
        return ctx

    monkeypatch.setattr(_cwt, "get_model_context_size", _actx)
    monkeypatch.setattr(_mi, "get_model_context_size", _actx)
    monkeypatch.setattr(llm_core, "get_model_context_size", _actx, raising=False)
    _mi._cached_context_size.clear()
    _mi._cached_context_size_ts.clear()


def reset_measured_ratio(monkeypatch=None) -> None:
    """Ramène le ratio chars/token MESURÉ à l'amorce froide (3.3) — l'état
    est un dict module-level qui survivrait d'un test à l'autre."""
    import llm_core.context.tokens as _tok
    _tok._measured_ratio.clear()


def freeze_measured_ratio(monkeypatch) -> None:
    """Gel du ratio à l'amorce pour un run hermétique : les usages SSE
    scriptés (prompt_tokens arbitraires vs contenus minuscules) produiraient
    un ratio absurde → matérialisations non déterministes."""
    import llm_core.context.tokens as _tok
    _tok._measured_ratio.clear()
    monkeypatch.setattr(_tok, "note_real_usage", lambda *a, **k: None)


def hermetic_at_scale(monkeypatch, scripts: List[List[str]], ctx: int) -> FakeClient:
    """``patch_hermetic`` (qui patche n_ctx → 0) PUIS surcharge d'échelle.
    Ratio mesuré GELÉ à l'amorce (déterminisme des coupes matérialisées)."""
    fake = patch_hermetic(monkeypatch, scripts)
    patch_scale(monkeypatch, ctx)
    freeze_measured_ratio(monkeypatch)
    return fake


def patch_fake_tokenize(monkeypatch) -> List[int]:
    """/tokenize déterministe pour le CHEMIN COMPRESSEUR : ``count_tokens_for_
    messages`` (stats avant/après) → ~chars//3 avec compteur d'appels, et
    ``context.tokens.count_tokens_exact`` → None (la sélection PARTIELLE
    exacte retombe sur l'estimation par message, déterministe). Obligatoire
    sur tout test qui touche à la compression — sinon round-trips HTTP."""
    import llm_core._llama_http as lh
    import llm_core.context.tokens as _tok
    calls: List[int] = []

    async def _none(*_a, **_k):
        return None

    monkeypatch.setattr(_tok, "count_tokens_exact", _none)

    async def _count(messages, model_id=None, timeout=None):
        calls.append(len(messages))
        total = 0
        for m in messages:
            c = m.get("content") or ""
            if isinstance(c, str):
                total += len(c)
        return max(1, total // 3)

    monkeypatch.setattr(lh, "count_tokens_for_messages", _count)
    return calls


def compression_cfg(monkeypatch, **overrides):
    """Config compression déterministe (pattern ``compr_cfg`` de
    test_compression_state.py) : ``reload_compression_config_from_disk``
    neutralisé EN PREMIER (sinon il ré-écrase les monkeypatchs à CHAQUE
    ``maybe_compress``), valeurs figées, indexation FTS neutralisée (aucune
    écriture DB). Surcharges par kwargs (``COMPRESSION_ENABLED=False``…)."""
    import llm_core.conversation_compressor as cc
    from shared_infra import config as cfg

    monkeypatch.setattr(cfg, "reload_compression_config_from_disk",
                        lambda force=False: False)
    values = dict(
        COMPRESSION_ENABLED=True,
        COMPRESSION_KEEP_RECENT=2,
        COMPRESSION_KEEP_BRIDGE=1,
        COMPRESSION_EXTERNAL_MODEL="",
        COMPRESSION_ENDPOINT_URL="",
        COMPRESSION_ENDPOINT_MODEL="",
        COMPRESSION_ENDPOINT_TIMEOUT_SEC=30,
        COMPRESSION_MAX_PER_CHAT=5,
        COMPACTION_BUFFER_TOKENS=0,
        COMPACTION_PARTIAL_TARGET_RATIO=0.6,
    )
    values.update(overrides)
    for k, v in values.items():
        monkeypatch.setattr(cfg, k, v, raising=False)
    monkeypatch.setattr(cc, "_index_covered_turns_fts", lambda *a, **k: None)
    return cfg


def fit_spy(monkeypatch) -> List[Dict[str, Any]]:
    """Enroule ``_cwt._fit_context`` : un snapshot PAR ITÉRATION des
    décisions internes de la boucle — ``fastpath``/``dropped``/``over_*``
    (stats_out) + delta du memo d'élagage + tailles entrée/sortie."""
    import llm_core._chat_with_tools as _cwt
    calls: List[Dict[str, Any]] = []
    _orig = _cwt._fit_context

    async def _spy(working_messages, **kw):
        memo = kw.get("prune_memo")
        m0 = len(memo) if isinstance(memo, dict) else 0
        out = await _orig(working_messages, **kw)
        m1 = len(memo) if isinstance(memo, dict) else 0
        stats = kw.get("stats_out")
        snap: Dict[str, Any] = {"n_in": len(working_messages), "n_out": len(out),
                                "pruned_new": m1 - m0, "pruned_memo": m1}
        if isinstance(stats, dict):
            snap.update(stats)
        calls.append(snap)
        return out

    monkeypatch.setattr(_cwt, "_fit_context", _spy)
    return calls


# ── Scripts SSE à usage piloté ──────────────────────────────────────────────

def sse_tool_call_scaled(
    name: str, arguments: str, call_id: str = "call_1", *,
    prompt_tokens: int, completion_tokens: int = 15,
) -> List[str]:
    """Comme ``goldens_harness.sse_tool_call`` mais avec ``prompt_tokens``
    pilotable — c'est lui qui alimente ``_last_real_ctx_tok`` (fast-path du
    budget dur, unités réelles de la pré-porte)."""
    delta = {"choices": [{"delta": {"tool_calls": [{
        "index": 0, "id": call_id, "type": "function",
        "function": {"name": name, "arguments": arguments},
    }]}}]}
    fin = {"choices": [{"delta": {}, "finish_reason": "tool_calls"}],
           "usage": {"prompt_tokens": prompt_tokens,
                     "completion_tokens": completion_tokens},
           "timings": {"prompt_n": prompt_tokens}}
    return [f"data: {json.dumps(delta)}", f"data: {json.dumps(fin)}", "data: [DONE]"]


def sse_final_scaled(
    text: str, *, prompt_tokens: int, finish: str = "stop",
    completion_tokens: int = 8,
) -> List[str]:
    """Réponse texte finale avec ``usage.prompt_tokens`` pilotable."""
    mid = len(text) // 2
    c1 = {"choices": [{"delta": {"content": text[:mid]}}]}
    c2 = {"choices": [{"delta": {"content": text[mid:]}}]}
    fin = {"choices": [{"delta": {}, "finish_reason": finish}],
           "usage": {"prompt_tokens": prompt_tokens,
                     "completion_tokens": completion_tokens},
           "timings": {"prompt_n": prompt_tokens}}
    return [f"data: {json.dumps(c1)}", f"data: {json.dumps(c2)}",
            f"data: {json.dumps(fin)}", "data: [DONE]"]


# ── Divers ──────────────────────────────────────────────────────────────────

async def fake_summarizer(prompt, user_id="t", model_override=None):
    """LLM de résumé factice au format ANCRÉ (M5) pour
    ``maybe_compress_conversation`` (signature minimale — ``compress()``
    détecte l'absence de ``sampling_override``)."""
    return ("## Goal\nresume synthetique deterministe des tours anciens.\n\n"
            "## Critical Context\n- chemins, ids et valeurs conserves",
            {"model": "fake-compressor"})


def tool_contents(messages: List[Dict[str, Any]]) -> Dict[str, str]:
    """``{tool_call_id: content}`` des messages ``role:tool`` (comparaisons
    byte-à-byte entre payloads sans dumper des Mo dans les asserts)."""
    return {m.get("tool_call_id"): m.get("content")
            for m in messages if isinstance(m, dict) and m.get("role") == "tool"}
