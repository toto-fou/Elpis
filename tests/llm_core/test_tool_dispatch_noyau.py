# SPDX-License-Identifier: MIT
"""tests/llm_core/test_tool_dispatch_noyau.py — le noyau d'exécution des
appels d'outils, testé à son interface (``llm_core.engine.tool_dispatch``).

``run_tool_batch`` est commun aux deux canaux (natif et texte) : lot en série
ou en parallèle selon les traits de l'outil, résultats rendus dans l'ordre du
modèle, échec d'outil qui laisse l'itération non productive, lot en cours posé
pour l'instantané d'annulation. ``TruncationGuard`` compte les appels coupés
par la limite de génération et rend la cause réelle de l'arrêt ;
``CycleGuard`` repère une action de bureau rejouée sans effet. Les deux canaux
de bout en bout restent couverts par ``test_boucle_chemins_critiques`` et les
goldens ``boucle_*``.
"""
from __future__ import annotations

import asyncio
import json
import threading
import time

import pytest

from llm_core.engine.live_text import LiveText
from llm_core.engine.run import LoopDeps, RunContext, RunRecord
from llm_core.engine.tool_dispatch import (
    _CYCLE_DECAY_ITERS,
    _CYCLE_HARDSTOP_MAX,
    _TRUNC_STREAK_MAX,
    NATIF,
    TEXTE,
    CycleGuard,
    TruncationGuard,
    classify_text_reply,
    run_tool_batch,
)


def _ctx(handlers, on_event, **kw):
    base = dict(
        on_event=on_event, username="u", model="m", chat_id="c", user_id=None,
        sampling_override=None, thinking_mode=False, is_cancelled=None,
        compression_enabled=None, compaction_max_rounds=None,
        inline_semaphore=False, priority="high", live_shell=False,
        start_time=0.0, model_has_vision=False, chat_key_suffix="c",
        run_log_tok="t", tools_payload=[], tool_cfg_map={},
        builtin_handlers=handlers, tools_payload_chars=0, max_iter=10,
        effective_iter_budget=10, hard_iter_cap=20)
    base.update(kw)
    return RunContext(**base)


def _deps():
    async def _stream(*a, **k):                     # jamais appelé par le lot
        raise AssertionError("pas d'appel LLM dans un lot d'outils")
    return LoopDeps(stream=_stream, record_metric=lambda *a, **k: None)


def _prep(*appels):
    return [{"call_id": f"c{i}", "tool_name": nom, "final_args": args, "meta": None}
            for i, (nom, args) in enumerate(appels)]


async def _lot(handlers, appels, channel=NATIF, **kw):
    vus = []

    async def on_event(ev):
        vus.append(ev)

    ctx = _ctx(handlers, on_event, **kw)
    rec = RunRecord()
    wm = [{"role": "user", "content": "go"}]
    prepared = _prep(*appels)
    out = await run_tool_batch(channel, ctx, rec, _deps(), wm, prepared,
                               iteration=0, cycle=CycleGuard())
    return out, rec, wm, vus, prepared


async def test_lot_en_serie_rend_les_resultats_dans_l_ordre_du_modele():
    ordre = []

    def _marque(args):
        ordre.append(args["x"])
        return json.dumps({"ok": True, "x": args["x"]})

    out, rec, wm, vus, prepared = await _lot(
        {"sandbox_marque": _marque},
        [("sandbox_marque", {"x": "a"}), ("sandbox_marque", {"x": "b"})])
    assert out.had_success is True and out.cycle_hard_stopped is False
    assert ordre == ["a", "b"]                      # outil mutant : un par un
    assert [m["tool_call_id"] for m in wm if m.get("role") == "tool"] == ["c0", "c1"]
    types = [e["type"] for e in vus if e["type"] in ("tool_call", "tool_result")]
    assert types == ["tool_call", "tool_call", "tool_result", "tool_result"]
    # Lot en cours posé pour l'instantané d'annulation, jamais vidé ensuite.
    assert rec.batch_prepared is prepared
    assert sorted(rec.batch_partial) == [0, 1]
    assert [m["role"] for m in rec.run_tool_history] == ["tool", "tool"]


async def test_lot_parallele_pour_les_outils_surs():
    # Deux appels qui ne passent la barrière qu'ENSEMBLE : en série, le
    # premier attendrait le second jusqu'à l'échec de la barrière.
    barriere = threading.Barrier(2, timeout=5)

    def _attend(args):
        barriere.wait()
        return json.dumps({"ok": True, "n": args["n"]})

    t0 = time.monotonic()
    out, _rec, wm, _vus, _p = await _lot(
        {"lit_ensemble": _attend},
        [("lit_ensemble", {"n": 1}), ("lit_ensemble", {"n": 2})])
    assert out.had_success is True
    assert time.monotonic() - t0 < 5
    contenus = [json.loads(m["content"]) for m in wm if m.get("role") == "tool"]
    assert [c["n"] for c in contenus] == [1, 2]     # ordre du modèle conservé


async def test_echec_d_outil_laisse_l_iteration_non_productive():
    def _casse(args):
        raise RuntimeError("panne de l'outil")

    out, _rec, wm, vus, _p = await _lot({"casse": _casse}, [("casse", {})])
    assert out.had_success is False
    (res,) = [e for e in vus if e["type"] == "tool_result"]
    assert "panne de l'outil" in res["result"]
    (tool_msg,) = [m for m in wm if m.get("role") == "tool"]
    assert "panne de l'outil" in tool_msg["content"]


async def test_annulation_avant_le_lot_rien_ne_tourne():
    appels = []

    def _outil(args):
        appels.append(args)
        return json.dumps({"ok": True})

    vus = []

    async def on_event(ev):
        vus.append(ev)

    ctx = _ctx({"outil": _outil}, on_event, is_cancelled=lambda: True)
    with pytest.raises(asyncio.CancelledError):
        await run_tool_batch(NATIF, ctx, RunRecord(), _deps(), [], _prep(("outil", {})),
                             iteration=0, cycle=CycleGuard())
    assert appels == [] and not [e for e in vus if e["type"] == "tool_call"]


async def test_appel_tronque_rend_la_cause_reelle_de_l_arret():
    async def on_event(ev):
        pass

    ctx = _ctx({}, on_event)
    plein = {"prompt_tokens": 990, "completion_tokens": 20}     # ≈ n_ctx
    marge = {"prompt_tokens": 100, "completion_tokens": 20}     # plafond de sortie

    for usage, cause in ((plein, "ctx_saturated"), (marge, "gen_cap")):
        rec = RunRecord(ctx_size=1000)
        wm = []
        trunc = TruncationGuard()
        arrets = [await trunc.cut("natif", ctx, rec, wm, usage=usage,
                                  iter_clean="début", iteration=i)
                  for i in range(_TRUNC_STREAK_MAX)]
        assert arrets == [False] * (_TRUNC_STREAK_MAX - 1) + [True]
        assert trunc.stop == cause
        # Le texte produit rejoint l'historique, jamais l'appel tronqué ; une
        # relance compacte éphémère suit chaque coupe.
        assert all("tool_calls" not in m for m in wm)
        assert [m["content"] for m in rec.run_tool_history] == ["début"] * _TRUNC_STREAK_MAX

    trunc = TruncationGuard(streak=2, ctx_full=True)
    trunc.reset()
    assert (trunc.streak, trunc.ctx_full, trunc.stop) == (0, False, None)


def test_garde_anti_boucle_desktop():
    cycle = CycleGuard()
    assert cycle.observe("read_file", {"path": "x"}, "sig") is None
    assert cycle.observe("desktop_observe", {}, "sig") is None    # observer n'est pas boucler
    vus = [cycle.observe("desktop_act", {"op": "click", "id": 3}, "meme-ecran")
           for _ in range(3)]
    assert vus[:2] == [None, None] and vus[2] is not None
    assert cycle.detections == 1 and not cycle.hard_stop_due
    cycle.detections = _CYCLE_HARDSTOP_MAX
    assert cycle.hard_stop_due
    for _ in range(_CYCLE_DECAY_ITERS):
        cycle.on_productive()
    assert (cycle.detections, cycle.clean_streak) == (0, 0)


def test_les_canaux_ne_different_que_par_leur_specification():
    assert (NATIF.vision, NATIF.fallback_wrapper) == (True, False)
    assert (TEXTE.vision, TEXTE.fallback_wrapper) == (False, True)
    assert (NATIF.name, TEXTE.name) == ("natif", "texte")
    assert "id/auto_id/label" in NATIF.cycle_nudge
    assert "id/auto_id/label" not in TEXTE.cycle_nudge


def test_appel_texte_vers_un_outil_inconnu_est_purge():
    async def on_event(ev):
        pass

    ctx = _ctx({"connu": lambda a: "{}"}, on_event)
    live = LiveText(on_event)
    live.parts.append('{"name": "inconnu", "arguments": {}}')
    reply = classify_text_reply(ctx, live, '{"name": "inconnu", "arguments": {}}', 0)
    assert reply.calls is None
    assert (reply.raw_text, reply.iter_clean, live.parts) == ("", "", [])

    live = LiveText(on_event)
    reply = classify_text_reply(ctx, live, '{"name": "connu", "arguments": {"a": 1}}', 0)
    assert reply.calls == [("connu", {"a": 1})]
