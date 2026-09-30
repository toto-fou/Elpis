# SPDX-License-Identifier: MIT
"""tests/llm_core/test_ctx_scale_e2e_loop.py — boucle COMPLÈTE
``run_chat_multi_mcp`` hermétique aux échelles 256k / 1M (2026-07-28).

Les « vrais échanges internes » : le FakeClient capture chaque payload
réellement envoyé (itération par itération), ``fit_spy`` capture les
décisions du pipeline de réduction, ``on_event`` capture les events. Couvre :
- (a) régime confortable à 256k : payload intact, un seul system, tools
  triés, ``max_tokens`` clampé via la SECONDE résolution n_ctx
  (build_llama_payload), fast-path dès la première mesure réelle ;
- (b) saturation par tool_results préchargés : budget dur pendant le run,
  marques d'élagage émises en fin de tour (``prune_state``), marqueur plein
  rendu au tour suivant (M4) ;
- (c) pré-porte → compression en plein run : la requête INTERNE du résumeur
  est le 2e payload capturé, l'état (round=1) est émis, la tête système du
  payload suivant porte socle + [COMPRESSED_SUMMARY_V1] ;
- (e) à 1M, ``LLAMA_MAX_MSGS`` borne l'envoi en NOMBRE de messages bien
  avant le budget tokens (~860k) — comportement documenté ici ;
- cap d'émission appliqué au résultat d'un handler builtin (150k chars) ;
- le canal d'observation prod ``LLAMA_WATCH`` (NDJSON) expose ces échanges.

Aucun réseau : ``hermetic_at_scale`` (goldens_harness + patch d'échelle) ;
la compression est explicitement désactivée partout sauf au scénario (c).
"""
from __future__ import annotations

import json

import pytest

import llm_core._chat_with_tools as _cwt
from tests.llm_core.ctx_scale_harness import (
    CTX_1M,
    CTX_256K,
    blob,
    compression_cfg,
    expected,
    fit_spy,
    hermetic_at_scale,
    patch_fake_tokenize,
    scale_param,
    shell_round,
    sse_final_scaled,
    sse_tool_call_scaled,
    tool_contents,
)
from tests.llm_core.goldens_harness import builtin_tools, sse_final

SOCLE = "SOCLE ÉCHELLE — identité de test stable, ne pas reformuler."


@pytest.fixture(autouse=True)
def _clear_ctx_cache():
    """Le cache n_ctx (TTL monotonic) est GLOBAL par process : purge avant et
    après chaque test pour qu'aucune échelle ne fuie vers un autre test."""
    import llm_core._model_info as mi
    mi._cached_context_size.clear()
    mi._cached_context_size_ts.clear()
    yield
    mi._cached_context_size.clear()
    mi._cached_context_size_ts.clear()


async def _run(monkeypatch, scripts, ctx, *, messages=None, builtin=None):
    fake = hermetic_at_scale(monkeypatch, scripts, ctx)
    events: list = []

    async def _cb(evt):
        events.append(evt)

    msgs = messages or [
        {"role": "system", "content": SOCLE},
        {"role": "user", "content": "Utilise l'outil zeta_echo puis conclus."},
    ]
    final, _ev, metrics = await _cwt.run_chat_multi_mcp(
        msgs, mcp_configs=[], builtin_tools=builtin or builtin_tools(),
        username="scale", chat_id="scale-chat", model="scale-model",
        memory_enabled=False, on_event=_cb)
    return fake, events, final, metrics


# ── (a) Régime confortable : payload intact + fast-path ─────────────────────

async def test_e2e_256k_sous_le_seuil_payload_intact_et_fastpath(monkeypatch):
    E = expected(CTX_256K)
    compression_cfg(monkeypatch, COMPRESSION_ENABLED=False)
    spy = fit_spy(monkeypatch)
    fake, events, final, metrics = await _run(monkeypatch, [
        sse_tool_call_scaled("zeta_echo", '{"msg": "ping"}', "e1",
                             prompt_tokens=120_000),
        sse_final_scaled("Terminé.", prompt_tokens=121_000),
    ], CTX_256K)

    assert final == "Terminé." and len(fake.payloads) == 2
    assert not [e for e in events if str(e.get("type", "")).startswith("compression")]

    # Décisions internes : iter 0 sans mesure réelle → chemin exact ;
    # iter 1 : réel 120 015 + delta minuscule ≪ bord 182 715 → fast-path.
    assert len(spy) == 2
    assert spy[0]["fastpath"] is False and spy[0]["dropped"] == 0
    assert spy[1]["fastpath"] is True and spy[1]["pruned_new"] == 0

    p1, p2 = fake.payloads
    # Clamp de génération via la 2e résolution n_ctx (build_llama_payload).
    assert p1["max_tokens"] == E["gen_cap"] == 16_384
    assert p2["max_tokens"] == E["gen_cap"]
    # Un seul system (coalesce), socle dedans, tête byte-stable inter-itérations.
    sys2 = [m for m in p2["messages"] if m["role"] == "system"]
    assert len(sys2) == 1 and SOCLE in sys2[0]["content"]
    assert p1["messages"][0] == p2["messages"][0]
    # Tools triés, identiques aux deux itérations.
    names = [t["function"]["name"] for t in p1["tools"]]
    assert names == sorted(names)
    assert names == [t["function"]["name"] for t in p2["tools"]]
    # Le tool result du handler part INTÉGRAL (largement sous le cap 55 050).
    tools_msgs = [m for m in p2["messages"] if m["role"] == "tool"]
    assert len(tools_msgs) == 1
    assert json.loads(tools_msgs[0]["content"])["ok"] is True
    assert "truncated" not in tools_msgs[0]["content"]
    # Paire assistant(tool_calls) + tool appariée.
    roles = [m["role"] for m in p2["messages"]]
    ia = roles.index("assistant")
    assert roles[ia:ia + 2] == ["assistant", "tool"]
    # La jauge est recalée sur l'usage RÉEL, avec le n_ctx patché en total.
    kv = [e for e in events if e.get("type") == "kv_cache"]
    assert [e["used"] for e in kv] == [120_000, 121_000]
    assert all(e["total"] == CTX_256K for e in kv)


# ── (b) Saturation préchargée : élagage INTRA-RUN, puis marques persistées ──

async def test_e2e_256k_saturation_elagage_intra_run(monkeypatch):
    """Audit 2026-08-01 (P0-1) : l'élagage opère PENDANT le run.

    Avant, la sélection n'avait lieu qu'en FIN de tour et n'était rendue qu'au
    tour SUIVANT : pendant le run, seul le budget dur tenait la ligne — en
    JETANT les messages les plus anciens. Sur un run long c'est le pire des
    deux mondes (on perd des tours entiers, irrécupérables, alors qu'effacer
    une sortie d'outil suffisait et reste rattrapable par session_search).

    Sur un historique saturant (24 sorties de 30k chars ≈ 218k tokens estimés
    > budget 214 959) on attend désormais :
    - l'élagage intra-run marque les vieilles sorties DÈS la 1re itération →
      la vue envoyée porte le marqueur plein, et le budget dur n'a plus rien
      à jeter (``dropped == 0``) ;
    - ``working_messages`` reste intact (marques = vue dérivée) ;
    - les clés partent quand même en ``prune_state`` pour être PERSISTÉES —
      sinon le contexte regagné serait reperdu au tour suivant ;
    - au tour SUIVANT, le rendu de la route donne le même résultat (recette
      d'élagage partagée) → envoi léger, zéro drop, tête stable."""
    from llm_core.context.pruning import PRUNE_CLEARED_MARKER, _prune_key
    E = expected(CTX_256K)
    compression_cfg(monkeypatch, COMPRESSION_ENABLED=False)
    spy = fit_spy(monkeypatch)

    chars = 30_000
    preload = [{"role": "system", "content": SOCLE},
               {"role": "user", "content": "reprends la longue tache"}]
    for i in range(24):
        preload += shell_round(i, chars)

    fake, events, final, metrics = await _run(monkeypatch, [
        sse_tool_call_scaled("zeta_echo", '{"msg": "a"}', "e1",
                             prompt_tokens=150_000),
        sse_final_scaled("Fini.", prompt_tokens=152_000),
    ], CTX_256K, messages=preload)

    assert final == "Fini." and len(fake.payloads) == 2

    # Élagage intra-run : la vue tient SANS que le budget dur jette un message.
    assert spy[0]["dropped"] == 0, \
        "l'élagage intra-run doit suffire — plus besoin de jeter des messages"
    c0 = tool_contents(fake.payloads[0]["messages"])
    assert all("tool history compaction" not in (c or "") for c in c0.values()), \
        "les vagues par itération n'existent plus"
    assert c0.get("c0") == PRUNE_CLEARED_MARKER, \
        "les plus anciennes sorties sont EFFACÉES (pas le message entier)"
    assert len(c0["c23"]) == chars, "les récents partent pleins"

    # Marques émises pour PERSISTANCE (union intra-run + passe finale) :
    # candidates hors 2 derniers tours et hors fenêtre protégée
    # ~52 428 tk ≈ 5 sorties de ~9 100 tk.
    # 17 (et non 18 comme du temps de la seule passe fin-de-tour) : la
    # sélection intra-run s'évalue AVANT que le tour n'ajoute son propre
    # cycle d'outil, donc la fenêtre « 2 derniers tours » couvre un cran de
    # plus. La passe finale re-regarde ensuite, mais le gain restant (c17 seul,
    # ~9 100 tk) est sous le plancher ``prune.min_tokens`` (20 000) : elle ne
    # s'acte pas — élaguer moins que le plancher coûterait un re-prefill KV
    # pour un gain négligeable.
    prune_evs = [e for e in events if e.get("type") == "prune_state"]
    assert len(prune_evs) == 1, "un seul lot de marques par tour"
    keys = set(prune_evs[0]["keys"])
    marked_ids = {m["tool_call_id"] for m in preload
                  if m.get("role") == "tool" and _prune_key(m) in keys}
    assert marked_ids == {f"c{i}" for i in range(17)}, marked_ids
    # Ce sont bien les marques DÉJÀ appliquées pendant le run qui sont
    # persistées (cohérence vue envoyée ↔ état sauvegardé).
    assert {k for k, v in c0.items() if v == PRUNE_CLEARED_MARKER} == marked_ids
    # working_messages n'a jamais été muté : contenus pleins en entrée.
    assert all(len(m["content"]) == chars for m in preload
               if m.get("role") == "tool")

    # ── Tour suivant : la route rend les marques → envoi léger et stable ──
    import llm_core._model_info as mi
    mi._cached_context_size.clear(); mi._cached_context_size_ts.clear()
    marked_view = []
    for m in preload:
        if m.get("role") == "tool" and _prune_key(m) in keys:
            marked_view.append({**m, "content": PRUNE_CLEARED_MARKER})
        else:
            marked_view.append(m)
    spy2 = fit_spy(monkeypatch)
    fake2, events2, final2, _m2 = await _run(monkeypatch, [
        sse_final_scaled("ok", prompt_tokens=60_000),
    ], CTX_256K, messages=marked_view)
    assert spy2[-1]["dropped"] == 0, \
        "avec les marques rendues, l'envoi tient sans drop du budget dur"
    c1 = tool_contents(fake2.payloads[0]["messages"])
    assert sum(1 for c in c1.values() if c == PRUNE_CLEARED_MARKER) == 17
    assert len(c1["c23"]) == chars


# ── (c) Règle unique → compression scriptée en plein run ───────────────────

async def test_e2e_256k_regle_unique_ouvre_compression_scriptee(monkeypatch):
    E = expected(CTX_256K)
    compression_cfg(monkeypatch)
    patch_fake_tokenize(monkeypatch)
    spy = fit_spy(monkeypatch)

    preload = [{"role": "system", "content": SOCLE}]
    for i in range(4):
        preload.append({"role": "user", "content": f"question {i} " + "q" * 400})
        preload.append({"role": "assistant", "content": f"reponse {i} " + "r" * 400})
    preload.append({"role": "user", "content": "continue le travail outillé"})

    fake, events, final, metrics = await _run(monkeypatch, [
        # iter 0 : usage réel 230 015 ≥ usable 225 760 (règle unique M3).
        sse_tool_call_scaled("zeta_echo", '{"msg": "avant"}', "e1",
                             prompt_tokens=230_000),
        # 2e appel LLM = le RÉSUMEUR (llama_chat via le même FakeClient).
        sse_final("<context>resume E2E scripte — faits conserves.</context>"),
        # iter 1 : la boucle repart sur le contexte compressé.
        sse_final_scaled("Terminé après compression.", prompt_tokens=90_000),
    ], CTX_256K, messages=preload)

    assert final == "Terminé après compression."
    assert len(fake.payloads) == 3, \
        "3 échanges attendus : boucle, résumeur INTERNE, boucle post-compression"

    # Payload 1 = la requête interne du résumeur : chemin classic (sans
    # tools), system = prompt du compresseur, user = conversation sérialisée.
    p_sum = fake.payloads[1]
    assert "tools" not in p_sum
    roles = [m["role"] for m in p_sum["messages"]]
    assert roles == ["system", "user"]
    assert "question 0" in p_sum["messages"][1]["content"], \
        "les tours à compresser sont sérialisés dans le prompt du résumeur"

    # Events : start → state (round 1, persistance) → done (stats).
    types = [e.get("type") for e in events]
    i_start = types.index("compression_start")
    i_state = types.index("compression_state")
    i_done = types.index("compression_done")
    assert i_start < i_state < i_done
    state_evt = events[i_state]
    assert state_evt["round"] == 1 and state_evt["turns_compressed"] > 0
    assert "resume E2E scripte" in state_evt["summary_xml"]
    done_evt = events[i_done]
    assert done_evt["stats"]["compressed"] is True

    # Payload 2 : tête système UNIQUE portant socle ET résumé (rien d'avalé).
    p2 = fake.payloads[2]
    sys_msgs = [m for m in p2["messages"] if m["role"] == "system"]
    assert len(sys_msgs) == 1
    head = sys_msgs[0]["content"]
    assert SOCLE in head and "[COMPRESSED_SUMMARY_V1]" in head
    assert "resume E2E scripte" in head
    assert "question 0" not in [m.get("content") for m in p2["messages"]], \
        "les tours couverts ont été remplacés par le résumé"

    # Post-compression : la mesure réelle est invalidée → pas de fast-path.
    assert spy[0]["fastpath"] is False and spy[1]["fastpath"] is False

    # tool_history = DELTA propre du run (le travail outillé, rien du contrôle).
    assert metrics.get("tool_history_delta") is True
    hist = metrics["tool_history"]
    assert {h["role"] for h in hist} <= {"assistant", "tool"}
    assert any(h.get("tool_calls") for h in hist)
    assert all("[COMPRESSED_SUMMARY_V1]" not in str(h.get("content") or "")
               for h in hist)


# ── (e) 1M : plus de clamp en nombre de messages — tout l'historique part ───

async def test_e2e_1M_sans_clamp_tout_l_historique_part(monkeypatch):
    """Le clamp ``LLAMA_MAX_MSGS`` est RETIRÉ (2026-07-28) : 521 messages
    courts à 1M de contexte (≈26k tokens ≪ budget 859 833) partent TOUS au
    modèle — plus d'amnésie silencieuse en nombre de messages ; la seule
    borne est le budget en tokens."""
    compression_cfg(monkeypatch, COMPRESSION_ENABLED=False)
    spy = fit_spy(monkeypatch)

    preload = [{"role": "system", "content": SOCLE}]
    for i in range(260):
        preload.append({"role": "user", "content": f"q{i}"})
        preload.append({"role": "assistant", "content": f"r{i}"})
    preload.append({"role": "user", "content": "conclus maintenant"})

    fake, events, final, metrics = await _run(monkeypatch, [
        sse_final_scaled("ok", prompt_tokens=10_000),
    ], CTX_1M, messages=preload)

    # Le budget dur n'a rien retiré, et l'envoi n'est plus clampé au compte.
    assert spy[0]["dropped"] == 0 and "over_budget" not in spy[0]
    sent = fake.payloads[0]["messages"]
    assert len(sent) == len(preload), \
        "tout l'historique doit partir (plus de clamp LLAMA_MAX_MSGS)"
    assert sent[0]["role"] == "system"
    assert sent[-1]["content"] == "conclus maintenant"
    assert "q0" in [m.get("content") for m in sent], \
        "le début de la conversation n'est plus amputé"


# ── Cap d'émission appliqué au résultat d'un handler ────────────────────────

@scale_param
async def test_e2e_emit_cap_borne_le_handler(ctx, monkeypatch):
    E = expected(ctx)
    compression_cfg(monkeypatch, COMPRESSION_ENABLED=False)

    def _dump(_args):
        return blob(150_000, "mega")

    builtin = {"mega_dump": {
        "definition": {"type": "function", "function": {
            "name": "mega_dump",
            "description": "Renvoie 150k chars (test cap d'émission).",
            "parameters": {"type": "object", "properties": {}},
        }},
        "handler": _dump,
    }}
    fake, events, final, metrics = await _run(monkeypatch, [
        sse_tool_call_scaled("mega_dump", "{}", "m1", prompt_tokens=10_000),
        sse_final_scaled("ok", prompt_tokens=12_000),
    ], ctx, builtin=builtin)

    sent = tool_contents(fake.payloads[1]["messages"])["m1"]
    cap = E["emit_cap"]
    # Outil générique → coupe tête-seule exacte au cap d'émission.
    assert sent == blob(150_000, "mega")[:cap] + \
        f"\n…[result truncated, {150_000 - cap} chars omitted]"
    assert sent.startswith("<<HEAD mega>>")


# ── Observabilité : LLAMA_WATCH expose les échanges internes ────────────────

async def test_e2e_watch_ndjson_expose_les_echanges(monkeypatch, tmp_path):
    compression_cfg(monkeypatch, COMPRESSION_ENABLED=False)
    watch_dir = tmp_path / "watch"
    monkeypatch.setenv("LLAMA_WATCH", "1")
    monkeypatch.setenv("LLAMA_WATCH_DIR", str(watch_dir))

    fake, events, final, metrics = await _run(monkeypatch, [
        sse_tool_call_scaled("zeta_echo", '{"msg": "w"}', "w1",
                             prompt_tokens=120_000),
        sse_final_scaled("vu", prompt_tokens=121_000),
    ], CTX_256K)

    files = list(watch_dir.glob("*.ndjson"))
    assert len(files) == 1, "un NDJSON par process/jour"
    records = [json.loads(line) for line in
               files[0].read_text(encoding="utf-8").splitlines() if line]
    calls = [r for r in records if r.get("kind") == "llm_call"]
    assert len(calls) == 2, "une entrée par appel LLM"
    assert [c["usage"]["prompt_tokens"] for c in calls] == [120_000, 121_000]
    for c in calls:
        assert "fit" in c and "fastpath" in c["fit"], \
            "les stats du fit font partie de la trace"
        assert all({"i", "role"} <= set(m) for m in c["msgs"]), \
            "le prompt assemblé est décrit message par message"
