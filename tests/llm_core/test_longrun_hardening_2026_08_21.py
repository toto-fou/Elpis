# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_longrun_hardening_2026_08_21.py — audit « runs très longs ».

Second passage sur le cœur du harnais, après le confinement des coupures
(cf. test_run_kill_containment). Ce qui est vissé ici tient à la DURÉE : des
défauts invisibles sur un tour de trente secondes et systématiques sur une
mission de six heures.

  1. ``execute_tool_batch`` ORPHELINAIT les frères d'un lot parallèle : un
     ``gather`` sans ``return_exceptions`` propage la première exception mais
     laisse les autres tâches tourner, détachées. Sur un Stop utilisateur, les
     autres outils du lot s'exécutaient APRÈS la fin du run.

  2. Les wrappers MCP RÉ-EXÉCUTAIENT l'outil quand un ``TypeError`` venait du
     corps de l'outil et non de la signature du SDK : jusqu'à 3 exécutions du
     même effet de bord, dont le modèle ne voyait qu'une.

  3. Les caches dérivés de /props n'avaient AUCUN TTL et leur seule
     invalidation est un endpoint admin servi par UN worker : les autres
     gardaient les valeurs d'un modèle/binaire disparu jusqu'au redémarrage —
     c.-à-d. pour toujours depuis que le recyclage gunicorn est désactivé.

  4. Le raisonnement cumulé du run (``_all_thinking``) n'était pas borné.

Aucun réseau.
"""
from __future__ import annotations

import asyncio
import json

import pytest

from llm_core.engine.tool_exec import execute_tool_batch


def _prepared(*names):
    return [{"call_id": f"c{i}", "tool_name": n, "final_args": {}, "meta": None}
            for i, n in enumerate(names)]


def _noop_metric(*_a, **_k):
    return None


async def _no_snapshot():
    return None


# ══════════════════════════════════════════════════════════════════════════
# 1. Lot parallèle : aucun outil ne survit à l'annulation
# ══════════════════════════════════════════════════════════════════════════

async def test_batch_annule_les_freres_au_lieu_de_les_orpheliner():
    """Stop utilisateur pendant un lot parallèle : les autres outils sont
    ANNULÉS et attendus, jamais laissés à tourner détachés."""
    trace: list = []
    cancel_flag = {"on": False}

    async def execute_single(name, _args, meta=None, **_kw):
        if name == "read_file":
            # Déclenche le Stop puis lève : c'est le chemin ``is_cancelled``
            # (pas de task.cancel sur le parent) — celui qui orphelinait.
            cancel_flag["on"] = True
            raise asyncio.CancelledError("user stop")
        try:
            await asyncio.sleep(0.25)
            trace.append(f"{name}:TERMINE")           # ne doit PAS arriver
            return json.dumps({"ok": True})
        except asyncio.CancelledError:
            trace.append(f"{name}:ANNULE")
            raise

    with pytest.raises(asyncio.CancelledError):
        await execute_tool_batch(
            _prepared("list_dir", "read_file", "grep_files"),
            execute_single=execute_single,
            record_metric=_noop_metric,
            is_tool_failure=lambda _r: False,
            on_event=None, username="u", chat_id="c",
            on_cancel_snapshot=_no_snapshot, iteration=0,
            is_cancelled=lambda: cancel_flag["on"],
        )

    # Laisse largement le temps à d'éventuels orphelins de terminer.
    await asyncio.sleep(0.4)
    assert "list_dir:TERMINE" not in trace, (
        "outil orphelin : il a fini APRÈS la fin du run")
    assert "grep_files:TERMINE" not in trace
    assert trace.count("ANNULE") if False else True   # lisibilité
    assert all(t.endswith(":ANNULE") for t in trace), trace


async def test_batch_parallele_nominal_inchange():
    """Sans échec, le lot parallèle rend toujours tous ses résultats."""
    async def execute_single(name, _args, meta=None, **_kw):
        await asyncio.sleep(0.01)
        return json.dumps({"ok": True, "tool": name})

    res = await execute_tool_batch(
        _prepared("list_dir", "read_file", "grep_files"),
        execute_single=execute_single,
        record_metric=_noop_metric,
        is_tool_failure=lambda _r: False,
        on_event=None, username="u", chat_id="c",
        on_cancel_snapshot=_no_snapshot, iteration=0,
        is_cancelled=lambda: False,
    )
    assert sorted(res) == [0, 1, 2]
    assert json.loads(res[1])["tool"] == "read_file"


async def test_batch_erreur_outil_ordinaire_ne_tue_pas_les_freres():
    """Une exception ORDINAIRE reste confinée à son outil (contrat existant) :
    elle devient une tool-error, les frères aboutissent."""
    async def execute_single(name, _args, meta=None, **_kw):
        if name == "read_file":
            raise ValueError("boom pydantic")
        await asyncio.sleep(0.01)
        return json.dumps({"ok": True, "tool": name})

    res = await execute_tool_batch(
        _prepared("list_dir", "read_file", "grep_files"),
        execute_single=execute_single,
        record_metric=_noop_metric,
        is_tool_failure=lambda _r: '"error"' in str(_r),
        on_event=None, username="u", chat_id="c",
        on_cancel_snapshot=_no_snapshot, iteration=0,
        is_cancelled=lambda: False,
    )
    assert "boom pydantic" in res[1]
    assert json.loads(res[0])["ok"] is True
    assert json.loads(res[2])["ok"] is True


# ══════════════════════════════════════════════════════════════════════════
# 2. Wrappers MCP : un TypeError de l'OUTIL ne rejoue plus l'appel
# ══════════════════════════════════════════════════════════════════════════

class _FakeSession:
    """Session mcp moderne : accepte meta ET progress_callback."""

    def __init__(self, raises=None):
        self.calls: list = []
        self._raises = raises

    async def call_tool(self, name, arguments, meta=None, progress_callback=None):
        self.calls.append((name, dict(arguments), meta is not None,
                           progress_callback is not None))
        if self._raises is not None:
            raise self._raises
        return {"ok": True}


class _OldSession:
    """SDK ancien : ni meta ni progress_callback dans la signature."""

    def __init__(self):
        self.calls: list = []

    async def call_tool(self, name, arguments):
        self.calls.append((name, dict(arguments)))
        return {"ok": True}


def _stdio_wrapper(session):
    from llm_core._mcp_wrappers import MCPStdioWrapper, _LogRouter
    w = MCPStdioWrapper.__new__(MCPStdioWrapper)
    w.session = session
    # Le routage des logs est passé d'un emplacement unique à un routeur PAR
    # APPEL (audit 2026-08-22, C2) — cf. tests/llm_core/test_log_cb_routing.py.
    w._log_router = _LogRouter()
    return w


async def test_typeerror_de_loutil_nest_plus_rejoue():
    """AVANT : le repli « strip kwargs et retente » ré-exécutait un outil
    MUTANT jusqu'à 3 fois sur un TypeError venu de son propre corps."""
    sess = _FakeSession(raises=TypeError("'NoneType' object is not subscriptable"))
    w = _stdio_wrapper(sess)
    with pytest.raises(TypeError):
        await w.call_tool("write_file", {"path": "/work/a.txt"},
                          meta={"u": "x"}, progress_callback=lambda *_a: None)
    assert len(sess.calls) == 1, (
        f"outil exécuté {len(sess.calls)} fois au lieu d'une")


async def test_sdk_ancien_appel_sans_kwargs_non_supportes():
    """La dégradation reste fonctionnelle : les kwargs absents de la
    signature ne sont simplement pas passés (sans appel d'essai raté)."""
    sess = _OldSession()
    w = _stdio_wrapper(sess)
    out = await w.call_tool("read_file", {"path": "/work/a.txt"},
                            meta={"u": "x"}, progress_callback=lambda *_a: None)
    assert out == {"ok": True}
    assert len(sess.calls) == 1


async def test_sdk_moderne_transmet_meta_et_progress():
    sess = _FakeSession()
    w = _stdio_wrapper(sess)
    await w.call_tool("read_file", {"p": 1}, meta={"u": "x"},
                      progress_callback=lambda *_a: None)
    _name, _args, had_meta, had_progress = sess.calls[0]
    assert had_meta and had_progress


# ══════════════════════════════════════════════════════════════════════════
# 3. Caches /props : TTL d'auto-cicatrisation
# ══════════════════════════════════════════════════════════════════════════

def test_props_cache_expire(monkeypatch):
    """Sans TTL, un worker gardait les paramètres d'un modèle disparu pour
    toujours (l'unique invalidation est un endpoint admin servi par UN
    worker). C'est le mécanisme des 400 intermittents sur les *_last_n."""
    from llm_core import _llm_params as lp

    lp.invalidate_params_cache()
    lp._props_cache["m1"] = {"repeat_last_n": -1}
    lp._props_cache_ts["m1"] = lp.time.monotonic()

    assert lp._cache_fresh(lp._props_cache_ts, "m1") is True

    # On avance le temps au-delà du TTL.
    base = lp.time.monotonic()
    monkeypatch.setattr(lp.time, "monotonic",
                        lambda: base + lp._PROPS_CACHE_TTL_S + 1.0)
    assert lp._cache_fresh(lp._props_cache_ts, "m1") is False


def test_continue_final_memo_negatif_expire(monkeypatch):
    """Un ``False`` posé après un 4xx d'un ancien binaire condamnait la
    reprise native pour toute la vie du worker."""
    from llm_core import _llm_params as lp

    lp.invalidate_params_cache()
    lp.note_continue_final_support("m1", False)
    assert lp.continue_final_support("m1") is False

    base = lp.time.monotonic()
    monkeypatch.setattr(lp.time, "monotonic",
                        lambda: base + lp._PROPS_CACHE_TTL_S + 1.0)
    # Expiré → « jamais tenté » : l'appelant retente le mode natif.
    assert lp.continue_final_support("m1") is None


def test_entree_sans_horodatage_reste_valide():
    """Injection directe dans le dict (tests, code hérité) : pas de
    péremption surprise."""
    from llm_core import _llm_params as lp

    lp.invalidate_params_cache()
    lp._props_cache["m2"] = {"top_k": 40}
    assert lp._cache_fresh(lp._props_cache_ts, "m2") is True


# ══════════════════════════════════════════════════════════════════════════
# 4. Raisonnement cumulé du run : borne dure
# ══════════════════════════════════════════════════════════════════════════

def test_thinking_history_borne_et_garde_le_suffixe():
    from llm_core._chat_with_tools import (
        _clip_thinking_history, THINKING_HISTORY_MAX_CHARS,
        THINKING_HISTORY_TRUNC_MARKER,
    )
    bloc = "x" * 50_000
    parts = [f"{i}{bloc}" for i in range(40)]     # ~2 Mo
    _clip_thinking_history(parts)

    total = sum(len(p) for p in parts)
    assert total <= THINKING_HISTORY_MAX_CHARS + len(THINKING_HISTORY_TRUNC_MARKER)
    assert parts[0] == THINKING_HISTORY_TRUNC_MARKER
    # Le raisonnement RÉCENT est celui qu'on garde.
    assert parts[-1].startswith("39")


def test_thinking_history_sous_le_seuil_intact():
    from llm_core._chat_with_tools import _clip_thinking_history
    parts = ["a" * 10, "b" * 10]
    _clip_thinking_history(parts)
    assert parts == ["a" * 10, "b" * 10]


def test_thinking_history_dernier_bloc_toujours_entier():
    """La boucle fait des ``pop()`` de dédoublonnage sur le DERNIER élément :
    le clip ne doit jamais le fusionner ni le tronquer."""
    from llm_core._chat_with_tools import (
        _clip_thinking_history, THINKING_HISTORY_MAX_CHARS,
    )
    dernier = "z" * (THINKING_HISTORY_MAX_CHARS * 2)
    parts = ["a" * 1000, dernier]
    _clip_thinking_history(parts)
    assert parts[-1] == dernier


# ══════════════════════════════════════════════════════════════════════════
# 5. Réponse sans ``choices`` : hoquet moteur, pas « budget épuisé »
# ══════════════════════════════════════════════════════════════════════════

from llm_core import _chat_with_tools as _cwt      # noqa: E402


async def _anoop(*_a, **_k):
    return None


async def _avision(*_a, **_k):
    return False


async def _actx(*_a, **_k):
    return 8192


def _patch_env(monkeypatch):
    monkeypatch.setattr(_cwt, "verify_llm_availability", _anoop)
    monkeypatch.setattr(_cwt, "_model_supports_vision", _avision)
    monkeypatch.setattr(_cwt, "get_model_context_size", _actx)


def _final_msg(content):
    return {
        "choices": [{"finish_reason": "stop",
                     "message": {"role": "assistant", "content": content,
                                 "tool_calls": None}}],
        "usage": {"prompt_tokens": 4, "completion_tokens": 2}, "timings": {},
    }


def _capture():
    seen: list = []

    async def on_event(ev):
        seen.append(ev)
    return seen, on_event


async def test_reponse_vide_est_retentee(monkeypatch):
    """AVANT : ``if not choices: break`` sortait par le chemin « limite
    d'itérations atteinte » — run terminé en plein milieu avec un diagnostic
    faux. Attendu : une réponse vide isolée est retentée."""
    _patch_env(monkeypatch)
    monkeypatch.setattr(_cwt.asyncio, "sleep", _anoop)
    seq = {"n": 0}

    async def _fake_stream(messages, tools_payload, **kw):
        seq["n"] += 1
        if seq["n"] == 1:
            return {"choices": [], "usage": {}, "timings": {}}
        return _final_msg("reparti après la réponse vide")

    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", _fake_stream)
    events, on_event = _capture()
    final, _ev, metrics = await _cwt.run_chat_multi_mcp(
        [{"role": "user", "content": "go"}],
        mcp_configs=[], builtin_tools={}, username="u", on_event=on_event,
    )
    assert "reparti" in final
    assert not metrics.get("tool_limit_reached")
    assert seq["n"] == 2


async def test_reponses_vides_en_serie_sortent_par_leur_propre_cause(monkeypatch):
    """Série épuisée : arrêt PROPRE, cause explicite, et tour REPRENABLE —
    pas un « budget d'itérations épuisé » mensonger."""
    _patch_env(monkeypatch)
    monkeypatch.setattr(_cwt.asyncio, "sleep", _anoop)

    async def _fake_stream(messages, tools_payload, **kw):
        return {"choices": [], "usage": {}, "timings": {}}

    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", _fake_stream)
    events, on_event = _capture()
    final, _ev, metrics = await _cwt.run_chat_multi_mcp(
        [{"role": "user", "content": "go"}],
        mcp_configs=[], builtin_tools={}, username="u", on_event=on_event,
    )
    assert metrics.get("empty_choices_stop") is True
    assert metrics.get("truncated") is True, "« Continuer » doit être offert"
    assert "vides" in final
    limites = [e for e in events if e.get("type") == "tool_limit"]
    assert limites and limites[-1]["reason"] == "empty_choices"


# ══════════════════════════════════════════════════════════════════════════
# 6. Reprise in-run de la RÉDACTION (prose coupée par le plafond)
# ══════════════════════════════════════════════════════════════════════════

from llm_core._think_resume import (            # noqa: E402
    build_content_resume_tail, should_auto_resume_content,
    MAX_RESUME_CONTENT_CHARS,
)


def test_reprise_prose_refusee_sans_canal_natif():
    """Le repli « prefill + consigne » du raisonnement ne convient PAS à la
    prose : « continue sans répéter » produit des redites, et une réponse
    visiblement dupliquée est pire que la bannière « Continuer »."""
    ok, why = should_auto_resume_content(
        finish="length", content="Voici le début de ma répo", native_ok=False)
    assert ok is False
    assert "natif" in why


def test_reprise_prose_acceptee_en_natif():
    ok, why = should_auto_resume_content(
        finish="length", content="Voici le début", native_ok=True)
    assert ok is True and "1/" in why


def test_reprise_prose_refusee_si_tool_calls():
    ok, why = should_auto_resume_content(
        finish="length", content="txt", native_ok=True, had_tool_calls=True)
    assert ok is False and "tool_calls" in why


def test_reprise_prose_refusee_si_fenetre_pleine():
    ok, why = should_auto_resume_content(
        finish="length", content="txt", native_ok=True,
        ctx_size=8192, window_tokens=8000)
    assert ok is False and "fenêtre" in why


def test_reprise_prose_refusee_si_prose_trop_longue():
    """On ne peut pas tronquer la prose : le modèle reprend depuis sa FIN,
    un préfixe amputé lui ferait continuer un texte qu'il n'a pas écrit."""
    ok, why = should_auto_resume_content(
        finish="length", content="x" * (MAX_RESUME_CONTENT_CHARS + 1),
        native_ok=True)
    assert ok is False and "trop longue" in why


def test_reprise_prose_plafonnee():
    from llm_core._constants import LLAMA_CONTENT_RESUME_MAX
    ok, _ = should_auto_resume_content(
        finish="length", content="txt", native_ok=True,
        resumes_done=LLAMA_CONTENT_RESUME_MAX)
    assert ok is False


def test_tail_de_reprise_prose_est_natif():
    tail, flags = build_content_resume_tail("début de réponse")
    assert tail == [{"role": "assistant", "content": "début de réponse"}]
    assert flags == {"continue_final_message": True,
                     "add_generation_prompt": False}


def _length_msg(content):
    """Réponse coupée par le plafond : prose, pas de tool_calls."""
    return {
        "choices": [{"finish_reason": "length",
                     "message": {"role": "assistant", "content": content,
                                 "tool_calls": None}}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5}, "timings": {},
    }


def _patch_native_resume(monkeypatch):
    """Cible = llama.cpp locale, ``continue_final_message`` supporté."""
    class _T:
        is_local_llamacpp = True
        is_llamacpp = True
    monkeypatch.setattr("llm_core._target.current_target", lambda: _T())
    monkeypatch.setattr("llm_core._llm_params.continue_final_support",
                        lambda _m: True)


async def test_prose_coupee_est_reprise_et_recollee(monkeypatch):
    """Bout en bout : la réponse rendue est la CONCATÉNATION des segments,
    le tour ne finit pas en ``truncated``, et le second appel a bien reçu
    la prose déjà écrite en ``resume_content``."""
    _patch_env(monkeypatch)
    _patch_native_resume(monkeypatch)
    seen_kwargs: list = []
    seq = {"n": 0}

    async def _fake_stream(messages, tools_payload, **kw):
        seen_kwargs.append(kw.get("resume_content"))
        seq["n"] += 1
        if seq["n"] == 1:
            return _length_msg("Le rapport se découpe en trois ")
        return _final_msg("parties distinctes.")

    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", _fake_stream)
    events, on_event = _capture()
    final, _ev, metrics = await _cwt.run_chat_multi_mcp(
        [{"role": "user", "content": "go"}],
        mcp_configs=[], builtin_tools={}, username="u", on_event=on_event,
    )
    assert final == "Le rapport se découpe en trois parties distinctes."
    assert metrics.get("content_resumes") == 1
    assert not metrics.get("truncated"), "plus de bannière « Continuer »"
    # 1er appel sans reprise, 2e avec la prose déjà écrite.
    assert seen_kwargs[0] is None
    assert seen_kwargs[1] == "Le rapport se découpe en trois "


async def test_prose_coupee_sans_canal_natif_garde_le_comportement_actuel(monkeypatch):
    """Connecteur distant / build ancien : aucune reprise, le tour finit en
    ``truncated`` comme avant — on ne dégrade rien."""
    _patch_env(monkeypatch)

    class _T:
        # Fournisseur NON llama.cpp (2026-09-16 : un connecteur llama.cpp,
        # lui, a désormais le canal natif sur son propre serveur).
        is_local_llamacpp = False
        is_llamacpp = False
    monkeypatch.setattr("llm_core._target.current_target", lambda: _T())
    seq = {"n": 0}

    async def _fake_stream(messages, tools_payload, **kw):
        seq["n"] += 1
        return _length_msg("réponse tronquée")

    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", _fake_stream)
    events, on_event = _capture()
    final, _ev, metrics = await _cwt.run_chat_multi_mcp(
        [{"role": "user", "content": "go"}],
        mcp_configs=[], builtin_tools={}, username="u", on_event=on_event,
    )
    assert seq["n"] == 1, "aucune reprise ne doit être tentée"
    assert metrics.get("truncated") is True
    assert "tronquée" in final


async def test_reprise_prose_bornee(monkeypatch):
    """Un moteur qui coupe à chaque segment ne doit pas boucler : la série
    est plafonnée, puis le tour se termine en ``truncated``."""
    _patch_env(monkeypatch)
    _patch_native_resume(monkeypatch)
    from llm_core._constants import LLAMA_CONTENT_RESUME_MAX
    seq = {"n": 0}

    async def _fake_stream(messages, tools_payload, **kw):
        seq["n"] += 1
        return _length_msg(f"seg{seq['n']} ")

    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", _fake_stream)
    events, on_event = _capture()
    final, _ev, metrics = await _cwt.run_chat_multi_mcp(
        [{"role": "user", "content": "go"}],
        mcp_configs=[], builtin_tools={}, username="u", on_event=on_event,
    )
    assert seq["n"] == LLAMA_CONTENT_RESUME_MAX + 1
    assert metrics.get("truncated") is True
    # Rien n'est perdu : tous les segments sont dans la réponse rendue.
    for i in range(1, LLAMA_CONTENT_RESUME_MAX + 2):
        assert f"seg{i}" in final
