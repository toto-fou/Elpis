# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_boucle_outils_audit_2026_09_24.py — boucle d'outils
(``_run_chat_multi_mcp_impl``), correctifs de l'audit du cœur du 2026-09-24.

  5.  une auto-reprise consommée est RESTITUÉE aux relances (hoquet, réponse
      sans ``choices``) ; la voie d'erreur garde la prose déjà affichée ;
  6.  le retry « hoquet » écarte les pannes déterministes ; l'aplatissement
      est réservé aux refus de requête, à l'itération 0 comme ailleurs ;
      l'aplatissement garde les marques ``_ephemeral``/``_task_anchor`` ;
  9.  jamais de balisage d'appel d'outil BRUT rendu comme réponse ;
  12. les points d'annulation hors ``try`` snapshotent la tool_history ;
  13. la sortie d'erreur expose l'occupation réelle (jauge) ;
  16. le rappel todo ne crée pas deux ``user`` consécutifs ;
  17. noms d'outils dédoublonnés (MCP×MCP, builtin×MCP) ;
  +   faibles : file MCP saturée = échec, mur d'horloge sans itération
      productive, raisonnement non dupliqué, synthèse coupée, repli
      ``tool_limit`` limité au run.

Aucun réseau : le flux LLM et les sondes sont monkeypatchés.
"""
from __future__ import annotations

import asyncio
import json

import httpx
import pytest

import llm_core.engine.llm_turn as _llm_turn
import llm_core.engine.run_exit as _run_exit
from llm_core import _chat_with_tools as _cwt, _mcp_pool, _model_info
from llm_core.engine import tool_catalog as _tool_catalog, tool_dispatch as _tool_dispatch
from shared_infra.observability import usage_ctx as _usage_ctx

# ── Environnement commun ────────────────────────────────────────────────────

async def _anoop(*_a, **_k):
    return None


async def _avision(*_a, **_k):
    return False


async def _actx(*_a, **_k):
    return 8192


class _T:
    is_local_llamacpp = True
    is_llamacpp = True


def _patch_env(monkeypatch, *, fast_sleep=True):
    monkeypatch.setattr(_cwt, "verify_llm_availability", _anoop)
    monkeypatch.setattr(_cwt, "_model_supports_vision", _avision)
    monkeypatch.setattr(_model_info, "get_model_context_size", _actx)
    if fast_sleep:
        _vrai_sleep = asyncio.sleep

        async def _sleep_rapide(_d, *a, **k):
            await _vrai_sleep(0)
        monkeypatch.setattr(_cwt.asyncio, "sleep", _sleep_rapide)


def _patch_native_resume(monkeypatch):
    monkeypatch.setattr("llm_core._target.current_target", lambda: _T())
    monkeypatch.setattr("llm_core._llm_params.continue_final_support",
                        lambda _m: True)


def _msg(content, finish="stop", tool_calls=None, pt=4, ct=2, **extra):
    m = {"role": "assistant", "content": content, "tool_calls": tool_calls}
    m.update(extra)
    return {"choices": [{"finish_reason": finish, "message": m}],
            "usage": {"prompt_tokens": pt, "completion_tokens": ct}, "timings": {}}


def _tool_round(name="noop", cid="c1", content="", pt=3):
    return _msg(content, finish="tool_calls", pt=pt, ct=1, tool_calls=[
        {"id": cid, "type": "function",
         "function": {"name": name, "arguments": "{}"}}])


def _builtin(name="noop", result=None):
    async def _h(_args):
        return json.dumps(result if result is not None else {"ok": True})
    return {name: {
        "definition": {"type": "function", "function": {
            "name": name, "description": "test",
            "parameters": {"type": "object", "properties": {}}}},
        "handler": _h,
    }}


def _http_err(code, body=""):
    req = httpx.Request("POST", "http://llm.invalide/v1/chat/completions")
    resp = httpx.Response(code, request=req, text=body)
    return httpx.HTTPStatusError(f"HTTP {code}", request=req, response=resp)


def _capture():
    seen: list = []

    async def on_event(ev):
        seen.append(ev)
    return seen, on_event


async def _run(monkeypatch, fake_stream, *, messages=None, builtins=None, **kw):
    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", fake_stream)
    events, on_event = _capture()
    final, _ev, metrics = await _cwt.run_chat_multi_mcp(
        messages or [{"role": "user", "content": "go"}],
        mcp_configs=[], builtin_tools=builtins or {}, username="u",
        on_event=on_event, **kw)
    return final, events, metrics


def _flatten_infos(events):
    return [e for e in events if e.get("type") == "info"
            and "incompatible" in (e.get("text") or "")]


def _hiccups(events):
    return [e for e in events if e.get("type") == "info"
            and "Hoquet" in (e.get("text") or "")]


# ══════════════════════════════════════════════════════════════════════════
# 5. Auto-reprise restituée aux relances
# ══════════════════════════════════════════════════════════════════════════

async def test_reprise_de_redaction_survit_au_hoquet(monkeypatch):
    """AVANT : la demande de reprise était vidée avant l'appel ; le 503 qui
    suivait relançait SANS elle — le modèle réécrivait tout et la partie 1
    n'arrivait jamais dans la réponse rendue."""
    _patch_env(monkeypatch)
    _patch_native_resume(monkeypatch)
    seen: list = []

    async def _fake(messages, tools_payload, **kw):
        seen.append(kw.get("resume_content"))
        n = len(seen)
        if n == 1:
            return _msg("Le rapport se découpe en trois ", finish="length", pt=10, ct=5)
        if n == 2:
            raise _http_err(503, "loading model")
        return _msg("parties distinctes.")

    final, events, metrics = await _run(monkeypatch, _fake)
    assert seen == [None, "Le rapport se découpe en trois ",
                    "Le rapport se découpe en trois "]
    assert final == "Le rapport se découpe en trois parties distinctes."
    assert _hiccups(events)


async def test_reprise_de_redaction_survit_a_la_reponse_vide(monkeypatch):
    _patch_env(monkeypatch)
    _patch_native_resume(monkeypatch)
    seen: list = []

    async def _fake(messages, tools_payload, **kw):
        seen.append(kw.get("resume_content"))
        n = len(seen)
        if n == 1:
            return _msg("Début ", finish="length", pt=10, ct=5)
        if n == 2:
            return {"choices": [], "usage": {}, "timings": {}}
        return _msg("et fin.")

    final, _events, _metrics = await _run(monkeypatch, _fake)
    assert seen[2] == "Début "
    assert final == "Début et fin."


async def test_voie_d_erreur_garde_la_prose_deja_affichee(monkeypatch):
    """AVANT : ``_partial_text`` ne portait que le segment de l'appel en
    échec — la prose d'avant la coupure, déjà affichée, disparaissait."""
    _patch_env(monkeypatch)
    _patch_native_resume(monkeypatch)
    seq = {"n": 0}

    async def _fake(messages, tools_payload, on_content_token=None, **kw):
        seq["n"] += 1
        if seq["n"] == 1:
            return _msg("Partie un, ", finish="length", pt=10, ct=5)
        if on_content_token:
            await on_content_token("partie deux")
        raise RuntimeError("flux coupé")

    final, _events, metrics = await _run(monkeypatch, _fake)
    assert metrics.get("ended_with_error") is True
    assert final == "Partie un, partie deux"
    assert metrics.get("truncated") is True


# ══════════════════════════════════════════════════════════════════════════
# 6. Hoquet vs panne déterministe ; aplatissement réservé aux refus
# ══════════════════════════════════════════════════════════════════════════

@pytest.mark.parametrize("err", [
    _http_err(401, '{"error": {"message": "invalid api key"}}'),
    _http_err(429, '{"error": {"code": "insufficient_quota", '
                   '"message": "You exceeded your current quota"}}'),
])
async def test_panne_deterministe_pas_de_hoquet(monkeypatch, err):
    """AVANT : 401 ou quota rejoués trois fois (12 s) à iter>0."""
    _patch_env(monkeypatch)
    seq = {"n": 0}

    async def _fake(messages, tools_payload, **kw):
        seq["n"] += 1
        if seq["n"] == 1:
            return _tool_round()
        raise err

    final, events, metrics = await _run(monkeypatch, _fake, builtins=_builtin())
    assert seq["n"] == 2
    assert not _hiccups(events)
    assert not _flatten_infos(events)
    assert metrics.get("ended_with_error") is True


async def test_depassement_non_compactable_pas_de_hoquet(monkeypatch):
    _patch_env(monkeypatch)
    import llm_core.conversation_compressor as _cc

    async def _no_compress(msgs, **_k):
        return msgs, {"compressed": False}
    monkeypatch.setattr(_cc, "maybe_compress_conversation", _no_compress)
    seq = {"n": 0}

    async def _fake(messages, tools_payload, **kw):
        seq["n"] += 1
        if seq["n"] == 1:
            return _tool_round()
        raise _http_err(400, '{"error": {"message": "the request exceeds the '
                             'available context size"}}')

    final, events, metrics = await _run(monkeypatch, _fake, builtins=_builtin())
    assert seq["n"] == 2
    assert not _hiccups(events) and not _flatten_infos(events)
    assert metrics.get("ended_with_error") is True


async def test_iter0_transitoire_hoquet_sans_aplatissement(monkeypatch):
    """AVANT : à l'itération 0, un simple timeout aplatissait l'historique
    (faux « historique incompatible », cache KV perdu)."""
    _patch_env(monkeypatch)
    seen: list = []

    async def _fake(messages, tools_payload, **kw):
        seen.append([dict(m) for m in messages])
        if len(seen) == 1:
            raise httpx.ReadTimeout("lent")
        return _msg("ok")

    history = [
        {"role": "user", "content": "q1"},
        {"role": "assistant", "content": None, "tool_calls": [
            {"id": "h1", "type": "function",
             "function": {"name": "noop", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "h1", "content": "{\"ok\": true}"},
        {"role": "assistant", "content": "fait"},
        {"role": "user", "content": "go"},
    ]
    final, events, _metrics = await _run(monkeypatch, _fake, messages=history,
                                         builtins=_builtin())
    assert final == "ok"
    assert len(_hiccups(events)) == 1
    assert not _flatten_infos(events)
    # La relance porte l'historique STRUCTURÉ (pas aplati).
    assert any(m.get("role") == "tool" for m in seen[1])


async def test_iter0_refus_de_requete_aplatit_encore_puis_s_arrete(monkeypatch):
    """Comportement gardé : un 400 à l'itération 0 aplatit l'historique une
    fois ; le second 400 (déterministe) n'est pas rejoué en hoquet."""
    _patch_env(monkeypatch)
    seq = {"n": 0}

    async def _fake(messages, tools_payload, **kw):
        seq["n"] += 1
        raise _http_err(400, '{"error": {"message": "bad template"}}')

    final, events, metrics = await _run(monkeypatch, _fake)
    assert seq["n"] == 2
    assert len(_flatten_infos(events)) == 1
    assert not _hiccups(events)
    assert metrics.get("ended_with_error") is True


async def test_iter_n_refus_de_requete_hoquets_puis_aplatissement(monkeypatch):
    """C5 gardé : à iter>0, un 400 passe par les hoquets, PUIS l'aplatissement."""
    _patch_env(monkeypatch)
    seq = {"n": 0}

    async def _fake(messages, tools_payload, **kw):
        seq["n"] += 1
        if seq["n"] == 1:
            return _tool_round()
        raise _http_err(400, '{"error": {"message": "bad template"}}')

    final, events, metrics = await _run(monkeypatch, _fake, builtins=_builtin())
    assert len(_hiccups(events)) == 3
    assert len(_flatten_infos(events)) == 1
    assert seq["n"] == 1 + 1 + 3 + 1


def test_aplatissement_garde_les_marques():
    out = _llm_turn._flatten_tool_messages([
        {"role": "system", "content": "socle"},
        {"role": "user", "content": "ancre ré-épinglée",
         "_ephemeral": True, "_task_anchor": True},
        {"role": "assistant", "content": None, "tool_calls": [
            {"id": "c1", "type": "function",
             "function": {"name": "read_file", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "contenu"},
        {"role": "assistant", "content": "lu"},
        {"role": "user", "content": "<harness_status>", "_ephemeral": True},
    ])
    users = [m for m in out if m["role"] == "user"]
    assert users[0].get("_ephemeral") and users[0].get("_task_anchor")
    # Observation d'outil aplatie : éphémère (pas un tour, pas l'énoncé).
    assert users[1].get("_ephemeral") and "contenu" in users[1]["content"]
    assert users[2].get("_ephemeral")
    from llm_core.context.pruning import task_anchor_index
    assert out[task_anchor_index(out)]["content"] == "ancre ré-épinglée"


def test_aplatissement_fusion_avec_un_vrai_user_n_est_pas_ephemere():
    out = _llm_turn._flatten_tool_messages([
        {"role": "assistant", "content": None, "tool_calls": [
            {"id": "c1", "type": "function",
             "function": {"name": "f", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "r"},
        {"role": "user", "content": "vraie demande"},
    ])
    assert out[-1]["role"] == "user"
    assert "vraie demande" in out[-1]["content"]
    assert not out[-1].get("_ephemeral")


# ══════════════════════════════════════════════════════════════════════════
# 9. Jamais de balisage brut rendu
# ══════════════════════════════════════════════════════════════════════════

async def test_reponse_reduite_a_du_balisage_jamais_rendue_brute(monkeypatch):
    _patch_env(monkeypatch)
    brut = '<tool_call>\n{"name": "outil_inconnu", "arguments": {"x": \n</tool_call>'

    async def _fake(messages, tools_payload, **kw):
        return _msg(brut)

    final, _events, _metrics = await _run(monkeypatch, _fake, builtins=_builtin())
    assert "<tool_call>" not in final
    assert final == _run_exit._MARKUP_ONLY_REPLY


# ══════════════════════════════════════════════════════════════════════════
# 12. Points d'annulation : snapshot de la tool_history, une seule fois
# ══════════════════════════════════════════════════════════════════════════

def _snapshots(events):
    return [e for e in events if e.get("type") == "tool_history_partial"]


async def test_stop_pendant_le_backoff_de_reponse_vide(monkeypatch):
    _patch_env(monkeypatch, fast_sleep=False)
    _vrai_sleep = asyncio.sleep

    async def _sleep(d, *a, **k):
        if d:
            raise asyncio.CancelledError()
        await _vrai_sleep(0)
    monkeypatch.setattr(_cwt.asyncio, "sleep", _sleep)
    seq = {"n": 0}

    async def _fake(messages, tools_payload, **kw):
        seq["n"] += 1
        if seq["n"] == 1:
            return _tool_round()
        return {"choices": [], "usage": {}, "timings": {}}

    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", _fake)
    events, on_event = _capture()
    with pytest.raises(asyncio.CancelledError):
        await _cwt.run_chat_multi_mcp(
            [{"role": "user", "content": "go"}], mcp_configs=[],
            builtin_tools=_builtin(), username="u", on_event=on_event)
    snaps = _snapshots(events)
    assert len(snaps) == 1
    assert any(m.get("role") == "tool" for m in snaps[0]["tool_history"])


async def test_stop_pendant_l_elagage_de_fin_de_tour(monkeypatch):
    _patch_env(monkeypatch)
    seq = {"n": 0}

    async def _fake(messages, tools_payload, **kw):
        seq["n"] += 1
        return _tool_round() if seq["n"] == 1 else _msg("fini")

    async def _cancel(*_a, **_k):
        # Seule la passe de FIN DE TOUR est visée (l'élagage intra-run vit
        # dans le ``try`` de l'appel LLM, qui a son propre filet).
        if seq["n"] >= 2:
            raise asyncio.CancelledError()
        return []
    from llm_core.context import pruning as _pruning
    monkeypatch.setattr(_pruning, "select_prune_keys", _cancel)
    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", _fake)
    events, on_event = _capture()
    with pytest.raises(asyncio.CancelledError):
        await _cwt.run_chat_multi_mcp(
            [{"role": "user", "content": "go"}], mcp_configs=[],
            builtin_tools=_builtin(), username="u", on_event=on_event)
    assert len(_snapshots(events)) == 1


# ══════════════════════════════════════════════════════════════════════════
# 13. Sortie d'erreur : occupation réelle pour la jauge
# ══════════════════════════════════════════════════════════════════════════

async def test_sortie_d_erreur_expose_l_occupation_reelle(monkeypatch):
    _patch_env(monkeypatch)
    seq = {"n": 0}

    async def _fake(messages, tools_payload, **kw):
        seq["n"] += 1
        if seq["n"] == 1:
            return _tool_round(pt=1500)
        raise _http_err(403, "forbidden")

    _final, _events, metrics = await _run(monkeypatch, _fake, builtins=_builtin())
    assert metrics["ended_with_error"] is True
    assert metrics["last_prompt_tokens"] == 1500
    assert metrics["submitted_input_tokens"] == metrics["input_tokens"]
    assert "model" in metrics and metrics["iterations"] == 1
    from chatbot_app.turn.execution import _kv_gauge_used_tokens
    assert _kv_gauge_used_tokens(metrics) == 1500


# ══════════════════════════════════════════════════════════════════════════
# 16. Rappel todo : pas deux ``user`` consécutifs
# ══════════════════════════════════════════════════════════════════════════

async def test_rappel_todo_fusionne_dans_le_dernier_user(monkeypatch):
    _patch_env(monkeypatch)
    monkeypatch.setattr(_cwt, "_todo_status_reminder",
                        lambda _u, _c: "<todo_status>1 open</todo_status>")
    seen: list = []

    async def _fake(messages, tools_payload, **kw):
        seen.append([dict(m) for m in messages])
        return _msg("ok")

    user_msg = {"role": "user", "content": "Continue le travail."}
    await _run(monkeypatch, _fake, messages=[user_msg],
               builtins=_builtin("todowrite"), chat_id="c1")
    first = seen[0]
    roles = [m["role"] for m in first]
    assert all(not (a == b == "user") for a, b in zip(roles, roles[1:])), roles
    assert first[0]["role"] == "system"
    assert "Continue le travail." in first[-1]["content"]
    assert "<todo_status>" in first[-1]["content"]
    # Le dict de l'appelant (persisté par la route) n'est pas touché.
    assert user_msg == {"role": "user", "content": "Continue le travail."}


# ══════════════════════════════════════════════════════════════════════════
# 17. Noms d'outils dédoublonnés
# ══════════════════════════════════════════════════════════════════════════

class _Outil:
    def __init__(self, name, desc=""):
        self.name = name
        self.description = desc or name
        self.inputSchema = {"type": "object", "properties": {}}
        self.annotations = None


def test_noms_d_outils_dedoublonnes(monkeypatch):
    reponses = {
        "A": [_Outil("search", "de A"), _Outil("lire")],
        "B": [_Outil("search", "de B"), _Outil("rag_query")],
    }

    async def _fake(cfg, resolve_client_fn=None):
        return object(), reponses[cfg["name"]]
    monkeypatch.setattr(_mcp_pool.mcp_pool, "get_or_connect", _fake)
    cfgs = [{"type": "sse", "name": "A", "url": "http://a.invalide/sse"},
            {"type": "sse", "name": "B", "url": "http://b.invalide/sse"}]
    bt = _builtin("rag_query")
    tmap, payload, handlers, _srv = asyncio.run(
        _tool_catalog._collect_mcp_tools(cfgs, bt, None, memory_enabled=False))
    names = [t["function"]["name"] for t in payload]
    assert sorted(names) == ["lire", "rag_query", "search"]
    # MCP×MCP : premier arrivé gagne, routage cohérent avec le schéma annoncé.
    assert tmap["search"]["name"] == "A"
    assert next(t for t in payload
                if t["function"]["name"] == "search")["function"]["description"] == "de A"
    # builtin×MCP : le builtin prévaut (c'est lui que l'exécution route).
    assert "rag_query" not in tmap and "rag_query" in handlers
    assert next(t for t in payload
                if t["function"]["name"] == "rag_query") is bt["rag_query"]["definition"]


# ══════════════════════════════════════════════════════════════════════════
# Faibles
# ══════════════════════════════════════════════════════════════════════════

async def test_file_mcp_saturee_est_un_echec(monkeypatch):
    from llm_core._mcp_pool import MCPQueueSaturated
    from llm_core.engine.result_contract import result_is_error

    async def _sature(*_a, **_k):
        raise MCPQueueSaturated("file pleine")
    monkeypatch.setattr(_mcp_pool.mcp_pool, "call_tool", _sature)
    res = await _tool_dispatch._execute_single_tool_call(
        "outil", {}, {"outil": {"name": "srv"}}, {})
    assert json.loads(res)["ok"] is False
    assert result_is_error(res)


async def test_mur_d_horloge_borne_un_run_sans_iteration_productive(monkeypatch):
    """AVANT : ``effective_iter > 0`` exigé — un run 100 % en échec n'était
    jamais borné par le temps (seulement par le cap dur)."""
    _patch_env(monkeypatch)
    import shared_infra.config as cfg
    monkeypatch.setattr(cfg, "LLAMA_TOOL_LOOP_MAX_S", 0.01, raising=False)
    seq = {"n": 0}

    async def _fake(messages, tools_payload, **kw):
        seq["n"] += 1
        await asyncio.get_running_loop().run_in_executor(None, lambda: __import__("time").sleep(0.02))
        return _tool_round(cid=f"c{seq['n']}")

    _final, events, metrics = await _run(
        monkeypatch, _fake, builtins=_builtin(result={"ok": False, "error": "ko"}),
        sampling_override={"max_tool_iterations": 50})
    assert metrics.get("tool_limit_stop_reason") == "wallclock"
    assert seq["n"] <= 3


async def test_raisonnement_non_duplique(monkeypatch):
    _patch_env(monkeypatch)

    async def _fake(messages, tools_payload, on_thinking_token=None, **kw):
        if on_thinking_token:
            await on_thinking_token("  Je  réfléchis\nà la question.  ")
        return _msg("Réponse.", reasoning_content="Je réfléchis à la question.")

    final, _events, metrics = await _run(monkeypatch, _fake)
    assert final == "Réponse."
    assert metrics["thinking"].count("réfléchis") == 1


async def _run_to_limit(monkeypatch, wrap_reply, *, history=None, round_content=""):
    _patch_env(monkeypatch)
    calls = {"tools": 0}

    async def _fake(messages, tools_payload, **kw):
        # Le tour de synthèse se reconnaît à sa consigne [SYSTEM] (il reçoit
        # désormais les MÊMES outils que les itérations, AUDIT 2026-09-25).
        _last = messages[-1].get("content") if messages else ""
        _consignes = set(_run_exit._WRAPUP_BY_KIND.values()) | {_run_exit._MAX_STEPS_WRAPUP}
        if not (isinstance(_last, str) and _last in _consignes):
            calls["tools"] += 1
            return _tool_round(cid=f"c{calls['tools']}", content=round_content)
        if isinstance(wrap_reply, BaseException):
            raise wrap_reply
        return wrap_reply

    return await _run(monkeypatch, _fake, messages=history, builtins=_builtin(),
                      sampling_override={"max_tool_iterations": 2})


async def test_synthese_coupee_marquee_truncated(monkeypatch):
    wrap = _msg("Synthèse interrom", finish="length", pt=50, ct=9)
    wrap["usage"]["cache_read_input_tokens"] = 7
    final, _events, metrics = await _run_to_limit(monkeypatch, wrap)
    assert final == "Synthèse interrom"
    assert metrics["max_steps_wrapup"] is True
    assert metrics.get("truncated") is True


async def test_synthese_complete_pas_truncated(monkeypatch):
    final, _events, metrics = await _run_to_limit(monkeypatch, _msg("Synthèse."))
    assert final == "Synthèse."
    assert not metrics.get("truncated")


async def test_synthese_cumule_le_cache(monkeypatch):
    seen: dict = {}

    def _rec(**kw):
        seen.update(kw)
    monkeypatch.setattr(_usage_ctx, "record_turn_usage", _rec)
    wrap = _msg("Synthèse.", pt=50, ct=9)
    wrap["usage"]["cache_read_input_tokens"] = 7
    wrap["usage"]["cache_creation_input_tokens"] = 3
    await _run_to_limit(monkeypatch, wrap)
    assert {k: seen["usage"][k] for k in ("cache_read_input_tokens",
                                          "cache_creation_input_tokens")} == {
        "cache_read_input_tokens": 7, "cache_creation_input_tokens": 3}
    # Part outils de l'entrée (2026-10-03) : cumulée aussi sur la synthèse,
    # bornée par l'entrée réelle.
    assert 0 < seen["usage"]["tool_input_tokens"] <= seen["input_tokens"]


async def test_repli_tool_limit_ne_reprend_pas_l_ancienne_reponse(monkeypatch):
    """Défaut connu n° 1 (parcours prompt 2026-09-22) : synthèse vide, run
    100 % tool_calls → le repli rendait la réponse du TOUR PRÉCÉDENT."""
    history = [{"role": "user", "content": "q1"},
               {"role": "assistant", "content": "ANCIENNE RÉPONSE"},
               {"role": "user", "content": "go"}]
    final, _events, metrics = await _run_to_limit(
        monkeypatch, _msg(""), history=history)
    assert metrics["tool_limit_reached"] is True
    assert "ANCIENNE RÉPONSE" not in final
    assert final.strip()          # filet déterministe, jamais de bulle vide


async def test_repli_tool_limit_tolere_un_content_liste(monkeypatch):
    """AVANT : un ``content`` en liste de blocs (tour précédent multimodal)
    atteint par le repli levait AttributeError sur ``.strip()``."""
    history = [{"role": "user", "content": "q1"},
               {"role": "assistant",
                "content": [{"type": "text", "text": "ANCIENNE RÉPONSE"}]},
               {"role": "user", "content": "go"}]
    final, _events, metrics = await _run_to_limit(
        monkeypatch, RuntimeError("synthèse en échec"), history=history)
    assert metrics["tool_limit_reached"] is True
    assert isinstance(final, str) and "ANCIENNE" not in final


def test_content_text_tolere_les_formes():
    from llm_core.engine.run import _content_text
    assert _content_text([{"type": "text", "text": "a"}, "b",
                          {"type": "image_url"}]) == "ab"
    assert _content_text(None) == ""
    assert _content_text("x") == "x"
