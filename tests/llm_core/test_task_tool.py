# SPDX-License-Identifier: MIT
"""tests/llm_core/test_task_tool.py — outil builtin ``task`` (sous-agents).

Le handler ``task`` est un builtin plain-callable (comme les RAG tools) : pas
de FastMCP, testable avec un faux runner injecté à la place de
``run_chat_multi_mcp`` / ``run_chat_multi_mcp_v2``. Couvre :
- roster byte-stable dans la description ; schéma exposé ;
- erreurs (agent inconnu, prompt vide) → enveloppes err() ;
- couches de deny (task/todowrite partout) + surfaces par agent
  (allowed_tool_names, filter_categories) — y compris les frontières NÉGATIVES
  du casting de spécialistes : implement ne commite pas, verify n'écrit pas,
  pr ne modifie aucun fichier, aucun agent intégré n'hérite du parent ;
- héritage modèle + thinking_mode=False + cap d'itérations enfant ;
- sélection du runner selon le mode de scheduling (classic/optimized) ;
- enveloppes succès / vide / timeout / échec (compatibles is_tool_failure) ;
- CancelledError relancée (jamais avalée) ;
- séquence d'events task_step (running→done→final), aucun content_token relayé ;
- chat_id enfant synthétique ; rollup usage_sink.
"""
from __future__ import annotations

import asyncio
import json

import pytest

import llm_core._chat_with_tools as cwt
from llm_core.tools import task_tool
from llm_core.tools.task_tool import _AGENTS, build_task_builtin_tool, cancel_child


@pytest.fixture(autouse=True)
def _clean_task_registries(tmp_path, monkeypatch):
    """Les registres (reprise, annulation, actifs) sont module-level → purge
    avant/après chaque test pour l'isolation.

    Le store de reprise PARTAGÉ et le bus d'annulation écrivent dans ``/tmp``
    (cross-worker) : on les redirige vers le tmp du test, sinon la suite
    déposerait des fichiers dans le spool réel de la machine."""
    from llm_core.tools import _task_resume
    from shared_infra.runtime import cancel_bus
    monkeypatch.setattr(_task_resume, "STORE_DIR", tmp_path / "resume")
    monkeypatch.setattr(cancel_bus, "CANCEL_FILE", tmp_path / "cancel.jsonl")
    for _s in (task_tool._RESUME_STORE, task_tool._ACTIVE_CHILDREN, task_tool._CANCELLED_CHILDREN):
        _s.clear()
    yield
    for _s in (task_tool._RESUME_STORE, task_tool._ACTIVE_CHILDREN, task_tool._CANCELLED_CHILDREN):
        _s.clear()


# ─────────────────────────────────────────────────────────────────────────────
# Faux runner injectable
# ─────────────────────────────────────────────────────────────────────────────

class FakeRunner:
    """Remplace run_chat_multi_mcp(_v2). Capture les kwargs, joue un scénario."""

    def __init__(self, *, final_text="done", metrics=None, events=None,
                 raises=None, delay=0.0):
        self.final_text = final_text
        self.metrics = metrics or {"input_tokens": 10, "output_tokens": 20}
        self.events = events or []
        self.raises = raises
        self.delay = delay
        self.calls = []

    async def __call__(self, messages, **kwargs):
        self.calls.append({"messages": messages, **kwargs})
        on_event = kwargs.get("on_event")
        if on_event:
            for ev in self.events:
                await on_event(ev)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.raises:
            raise self.raises
        return self.final_text, [], self.metrics


class DeltaRunner(FakeRunner):
    """FakeRunner au CONTRAT RÉEL de ``tool_history`` : la boucle renvoie le
    DELTA du run (``_run_tool_history`` dans run_chat_multi_mcp — uniquement
    les tours de CE cycle), marqué ``tool_history_delta``. Sur une reprise,
    l'historique d'entrée n'est PAS re-contenu dans tool_history : le store
    de reprise concatène ``child_messages`` entier + delta expansé
    (cf. _store_resume_state). Chaque appel joue un cycle read_file (id c1,
    c2…) et snapshotte les messages d'entrée (assertions de taille fiables)."""

    def __init__(self, **kw):
        super().__init__(**kw)
        self._n = 0

    async def __call__(self, messages, **kwargs):
        self.calls.append({"messages": [dict(m) for m in messages], **kwargs})
        on_event = kwargs.get("on_event")
        if on_event:
            for ev in self.events:
                await on_event(ev)
        self._n += 1
        cid = f"c{self._n}"
        delta = [
            {"role": "assistant", "content": None, "tool_calls": [{
                "id": cid, "type": "function",
                "function": {"name": "read_file", "arguments": '{"path":"a.py"}'}}]},
            {"role": "tool", "tool_call_id": cid, "content": '{"ok": true}'},
        ]
        self.metrics = {"input_tokens": 10, "output_tokens": 5,
                        "tool_history": delta, "tool_history_delta": True}
        return self.final_text, [], self.metrics


def _patch_runner(monkeypatch, runner):
    """task_tool importe les runners depuis cwt à l'exécution du handler."""
    monkeypatch.setattr(cwt, "run_chat_multi_mcp", runner, raising=True)
    monkeypatch.setattr(cwt, "run_chat_multi_mcp_v2", runner, raising=True)


def _factory(monkeypatch, runner, *, scheduling_mode="classic", on_event=None,
             usage_sink=None, memory_enabled=False, parent_builtins=None,
             parent_configs=None, custom_agents=None, user_mcp_configs=None,
             user_id=None):
    _patch_runner(monkeypatch, runner)
    bt = build_task_builtin_tool(
        parent_mcp_configs=parent_configs if parent_configs is not None else [{"name": "loc", "command": "DEFAULT_LOCAL_PYTHON", "filter_categories": ["fs"]}],
        parent_builtin_tools=parent_builtins,
        username="u",
        chat_id="chatA",
        model="qwen-current",
        sampling_override={"temperature": 0.3},
        memory_enabled=memory_enabled,
        is_cancelled=lambda: False,
        on_event=on_event,
        scheduling_mode=scheduling_mode,
        usage_sink=usage_sink,
        custom_agents=custom_agents,
        user_mcp_configs=user_mcp_configs,
        user_id=user_id,
    )
    return bt["task"]["handler"], bt["task"]["definition"]


# ─────────────────────────────────────────────────────────────────────────────
# Description / schéma
# ─────────────────────────────────────────────────────────────────────────────

def test_description_lists_all_agents_bytestable():
    d1 = task_tool._build_definition()
    d2 = task_tool._build_definition()
    assert d1 == d2                                   # byte-stable (prefix KV)
    desc = d1["function"]["description"]
    for name in _AGENTS:
        assert f"- {name}:" in desc
    params = d1["function"]["parameters"]
    assert params["required"] == ["description", "prompt", "subagent_type"]
    assert params["properties"]["subagent_type"]["enum"] == list(_AGENTS)
    # Reprise : task_id exposé (optionnel) + documenté dans les notes.
    assert "task_id" in params["properties"]
    assert "task_id" not in params["required"]
    assert "task_id" in desc


# ─────────────────────────────────────────────────────────────────────────────
# Erreurs
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_unknown_agent_error(monkeypatch):
    handler, _ = _factory(monkeypatch, FakeRunner())
    out = json.loads(await handler({"subagent_type": "nope", "prompt": "x", "description": "d"}))
    assert out["ok"] is False and out["error"] == "unknown_agent"
    assert out["valid_choices"] == list(_AGENTS)


@pytest.mark.asyncio
async def test_empty_prompt_error(monkeypatch):
    handler, _ = _factory(monkeypatch, FakeRunner())
    out = json.loads(await handler({"subagent_type": "explore", "prompt": "  ", "description": "d"}))
    assert out["ok"] is False and out["error"] == "empty_prompt"


# ─────────────────────────────────────────────────────────────────────────────
# Couches de deny + surfaces par agent
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_explore_child_kwargs(monkeypatch):
    runner = FakeRunner()
    handler, _ = _factory(monkeypatch, runner)
    await handler({"subagent_type": "explore", "prompt": "find X", "description": "d"})
    kw = runner.calls[0]
    assert {"task", "todowrite"} <= set(kw["deny_tool_names"])
    # Modèle « chat aux toggles pré-cochés » : AUCUNE allowlist par outil, la
    # spécialisation vit dans les catégories (et la persona).
    assert kw["allowed_tool_names"] is None
    assert kw["model"] == "qwen-current"
    assert kw["thinking_mode"] is False
    assert kw["memory_enabled"] is False
    assert kw["sampling_override"]["max_tool_iterations"] == _AGENTS["explore"].max_iters
    # serveur local synthétique dédié (pas les configs parent)
    assert kw["mcp_configs"][0]["filter_categories"] == ["fs", "git"]
    assert kw["builtin_tools"] is None


@pytest.mark.asyncio
async def test_implement_child_kwargs(monkeypatch):
    runner = FakeRunner()
    handler, _ = _factory(monkeypatch, runner)
    await handler({"subagent_type": "implement", "prompt": "patch X", "description": "d"})
    kw = runner.calls[0]
    assert kw["allowed_tool_names"] is None       # catégories entières
    assert kw["mcp_configs"][0]["filter_categories"] == ["fs", "shell", "git"]
    assert kw["sampling_override"]["max_tool_iterations"] == _AGENTS["implement"].max_iters
    # « Écrire n'est pas publier » est désormais une consigne de PERSONA, pas
    # une amputation : l'agent a le toolset git complet et sa persona lui dit
    # de ne pas commiter (cf. test_persona_nomme_les_outils_quelle_sinterdit).


@pytest.mark.asyncio
async def test_verify_has_no_write_surface(monkeypatch):
    runner = FakeRunner()
    handler, _ = _factory(monkeypatch, runner)
    await handler({"subagent_type": "verify", "prompt": "run tests", "description": "d"})
    kw = runner.calls[0]
    assert kw["allowed_tool_names"] is None       # catégories entières
    assert kw["mcp_configs"][0]["filter_categories"] == ["shell", "fs", "git"]
    # « Il constate, il ne répare pas » est une consigne de PERSONA : l'agent a
    # les outils d'écriture (toolsets entiers) et sa persona les lui interdit
    # NOMMÉMENT — vérifié par test_persona_nomme_les_outils_quelle_sinterdit.


@pytest.mark.asyncio
async def test_pr_child_kwargs(monkeypatch):
    runner = FakeRunner()
    handler, _ = _factory(monkeypatch, runner)
    await handler({"subagent_type": "pr", "prompt": "ship it", "description": "d"})
    kw = runner.calls[0]
    assert kw["allowed_tool_names"] is None       # catégories entières
    assert kw["mcp_configs"][0]["filter_categories"] == ["git", "fs"]
    # pr soumet ce qui existe : sa persona lui interdit NOMMÉMENT write_file,
    # edit_file, git_write, git_abandon et git_action, qu'il possède pourtant.


@pytest.mark.asyncio
@pytest.mark.parametrize("agent", list(_AGENTS))
async def test_no_builtin_agent_inherits_parent_surface(monkeypatch, agent):
    """Garantie STRUCTURELLE du casting de spécialistes : chaque agent intégré
    tourne sur un serveur local synthétique borné, jamais sur la surface
    complète du chat parent (ce que faisait l'ancien ``general``, première
    cause de dérive des enfants)."""
    runner = FakeRunner()
    parent_cfgs = [{"name": "loc", "command": "DEFAULT_LOCAL_PYTHON", "filter_categories": None}]
    parent_builtins = {"rag_search": {"definition": {}, "handler": lambda a: "{}"}}
    handler, _ = _factory(monkeypatch, runner, memory_enabled=True,
                          parent_builtins=parent_builtins, parent_configs=parent_cfgs)
    await handler({"subagent_type": agent, "prompt": "p", "description": "d"})
    kw = runner.calls[0]
    assert kw["allowed_tool_names"] is None, f"{agent} : plus d'allowlist par outil"
    assert kw["mcp_configs"][0]["filter_categories"], f"{agent} : catégories requises"
    assert kw["mcp_configs"] is not parent_cfgs
    assert kw["builtin_tools"] is None          # ni RAG ni MCP externes du parent
    assert kw["memory_enabled"] is False        # pas de mémoire en sous-agent
    assert {"task", "todowrite", "ask_user"} <= set(kw["deny_tool_names"])
    assert not _AGENTS[agent].inherit_config


@pytest.mark.asyncio
async def test_web_child_kwargs(monkeypatch):
    runner = FakeRunner()
    handler, _ = _factory(monkeypatch, runner)
    await handler({"subagent_type": "web", "prompt": "research Y", "description": "d"})
    kw = runner.calls[0]
    assert kw["allowed_tool_names"] is None       # catégories entières
    assert kw["mcp_configs"][0]["filter_categories"] == ["browser", "fs"]
    assert {"task", "todowrite"} <= set(kw["deny_tool_names"])


# ─────────────────────────────────────────────────────────────────────────────
# Sélection du runner
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_scheduling_mode_selects_runner(monkeypatch):
    classic = FakeRunner(final_text="c")
    optimized = FakeRunner(final_text="o")
    # classic → run_chat_multi_mcp ; optimized → run_chat_multi_mcp_v2
    monkeypatch.setattr(cwt, "run_chat_multi_mcp", classic, raising=True)
    monkeypatch.setattr(cwt, "run_chat_multi_mcp_v2", optimized, raising=True)
    bt_c = build_task_builtin_tool(
        parent_mcp_configs=[], parent_builtin_tools=None, username="u", chat_id="c",
        model="m", sampling_override=None, memory_enabled=False,
        is_cancelled=None, on_event=None, scheduling_mode="classic", usage_sink=None)
    bt_o = build_task_builtin_tool(
        parent_mcp_configs=[], parent_builtin_tools=None, username="u", chat_id="c",
        model="m", sampling_override=None, memory_enabled=False,
        is_cancelled=None, on_event=None, scheduling_mode="optimized", usage_sink=None)
    out_c = await bt_c["task"]["handler"]({"subagent_type": "explore", "prompt": "p", "description": "d"})
    assert "c" in out_c and len(classic.calls) == 1 and len(optimized.calls) == 0
    out_o = await bt_o["task"]["handler"]({"subagent_type": "explore", "prompt": "p", "description": "d"})
    assert "o" in out_o and len(optimized.calls) == 1 and len(classic.calls) == 1


# ─────────────────────────────────────────────────────────────────────────────
# Enveloppes
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_success_envelope(monkeypatch):
    handler, _ = _factory(monkeypatch, FakeRunner(final_text="the answer"))
    out = await handler({"subagent_type": "explore", "prompt": "p", "description": "d"})
    assert out.startswith('<task id="') and 'state="completed"' in out
    assert "<task_result>\nthe answer\n</task_result>" in out


@pytest.mark.asyncio
async def test_empty_text_envelope(monkeypatch):
    handler, _ = _factory(monkeypatch, FakeRunner(final_text=""))
    out = await handler({"subagent_type": "explore", "prompt": "p", "description": "d"})
    assert "<task_result>\n\n</task_result>" in out


@pytest.mark.asyncio
async def test_timeout_envelope(monkeypatch):
    monkeypatch.setattr(task_tool, "TASK_CHILD_TIMEOUT_S", 0)   # borne quasi-nulle
    handler, _ = _factory(monkeypatch, FakeRunner(delay=0.2))
    out = json.loads(await handler({"subagent_type": "explore", "prompt": "p", "description": "d"}))
    assert out["error"] == "task_timeout"
    assert task_tool._result_is_tool_failure_safe(json.dumps(out)) is True


@pytest.mark.asyncio
async def test_failure_envelope(monkeypatch):
    handler, _ = _factory(monkeypatch, FakeRunner(raises=RuntimeError("boom")))
    out = json.loads(await handler({"subagent_type": "explore", "prompt": "p", "description": "d"}))
    assert out["error"] == "task_failed" and out.get("retryable") is True
    assert task_tool._result_is_tool_failure_safe(json.dumps(out)) is True


@pytest.mark.asyncio
async def test_erreur_llm_de_l_enfant_rendue_en_echec(monkeypatch):
    """(2026-09-21) La boucle RETOURNE ``ended_with_error`` au lieu de lever :
    l'enfant mort sur une erreur LLM n'est plus rendu « completed »."""
    runner = FakeRunner(final_text="début de rapp",
                        metrics={"input_tokens": 1, "output_tokens": 1,
                                 "ended_with_error": True})
    handler, _ = _factory(monkeypatch, runner)
    out = json.loads(await handler({"subagent_type": "explore", "prompt": "p", "description": "d"}))
    assert out["error"] == "task_failed" and out.get("retryable") is True
    assert out["partial_report"] == "début de rapp"
    assert task_tool._result_is_tool_failure_safe(json.dumps(out)) is True


@pytest.mark.asyncio
async def test_cancellation_propagates(monkeypatch):
    events = []
    async def _on_event(ev): events.append(ev)
    handler, _ = _factory(monkeypatch, FakeRunner(raises=asyncio.CancelledError()),
                          on_event=_on_event)
    with pytest.raises(asyncio.CancelledError):
        await handler({"subagent_type": "explore", "prompt": "p", "description": "d"})
    # un task_step final "cancelled" est tout de même émis avant de relancer
    finals = [e for e in events if e.get("status") == "final"]
    assert finals and finals[-1]["state"] == "cancelled"


# ─────────────────────────────────────────────────────────────────────────────
# Relais d'événements
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_event_relay_only_task_steps(monkeypatch):
    """Compteur = MÊME mécanisme que la jauge parent (« réel seul ») : recalé
    sur les kv_cache enfant (used = prompt_tokens réels serveur) ; le cumul
    comptable ``iteration.tokens_used`` (quadratique) est IGNORÉ."""
    child_events = [
        {"type": "iteration", "n": 1, "tokens_used": 999999, "context_tokens": 0},
        {"type": "content_token", "text": "noise"},
        {"type": "kv_cache", "used": 350, "total": 32768, "pct": 1},
        {"type": "tool_call", "name": "read_file", "args": {"path": "a.py"}},
        {"type": "tool_result", "name": "read_file", "result": '{"ok": true}'},
        {"type": "kv_cache", "used": 980, "total": 32768, "pct": 3},
        {"type": "iteration", "n": 2, "tokens_used": 999999, "context_tokens": 1200},
        {"type": "thinking_token", "text": "hmm"},
        {"type": "tool_call", "name": "list_files", "args": {"path": "src"}},
        {"type": "tool_result", "name": "list_files", "result": '{"ok": false, "error": "x"}'},
    ]
    seen = []
    async def _on_event(ev): seen.append(ev)
    handler, _ = _factory(monkeypatch, FakeRunner(events=child_events, metrics={"input_tokens": 5, "output_tokens": 7}),
                          on_event=_on_event)
    await handler({"subagent_type": "explore", "prompt": "p", "description": "d"})
    # AUCUN content_token / thinking_token relayé
    assert all(e["type"] == "task_step" for e in seen)
    # kv_cache → ticks portant l'occupation RÉELLE ; tokens_used jamais utilisé,
    # et context_tokens ignoré dès qu'un kv_cache a été vu.
    ticks = [e for e in seen if e.get("status") == "tick"]
    assert [t["tokens"] for t in ticks] == [350, 980]
    assert all(t["tokens"] != 999999 for t in ticks)
    running = [e for e in seen if e.get("status") == "running"]
    assert [e["tool"] for e in running] == ["read_file", "list_files"]
    assert [e["step"] for e in running] == [1, 2]        # compteur croissant
    assert running[0]["tokens"] == 350                   # dernier réel au moment du call
    assert running[1]["tokens"] == 980
    dones = [e for e in seen if e.get("status") in ("done", "error")]
    assert dones[0]["status"] == "done" and dones[1]["status"] == "error"
    final = [e for e in seen if e.get("status") == "final"][-1]
    assert final["state"] == "completed" and final["steps_total"] == 2
    assert final["context_tokens"] == 980                # occupation réelle finale
    assert final["input_tokens"] == 5 and final["output_tokens"] == 7


@pytest.mark.asyncio
async def test_token_counter_remote_fallback(monkeypatch):
    """Sans kv_cache (cible distante, pas de n_ctx local) : repli sur
    ``iteration.context_tokens`` = prompt+completion RÉELS du dernier appel —
    jamais sur le cumul comptable ``tokens_used``."""
    child_events = [
        {"type": "iteration", "n": 1, "tokens_used": 999999, "context_tokens": 0},
        {"type": "iteration", "n": 2, "tokens_used": 999999, "context_tokens": 640},
        {"type": "iteration", "n": 3, "tokens_used": 999999, "context_tokens": 1510},
    ]
    seen = []
    async def _on_event(ev): seen.append(ev)
    handler, _ = _factory(monkeypatch, FakeRunner(events=child_events), on_event=_on_event)
    await handler({"subagent_type": "explore", "prompt": "p", "description": "d"})
    ticks = [e for e in seen if e.get("status") == "tick"]
    assert [t["tokens"] for t in ticks] == [640, 1510]   # context_tokens=0 → pas de tick
    final = [e for e in seen if e.get("status") == "final"][-1]
    assert final["context_tokens"] == 1510


# ─────────────────────────────────────────────────────────────────────────────
# chat_id synthétique + rollup usage
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_child_chat_id_synthetic(monkeypatch):
    runner = FakeRunner()
    handler, _ = _factory(monkeypatch, runner)
    await handler({"subagent_type": "explore", "prompt": "p", "description": "d"})
    cid = runner.calls[0]["chat_id"]
    assert cid != "chatA" and cid.startswith("chatA#task-")


# ─────────────────────────────────────────────────────────────────────────────
# Annulation PAR-ENFANT (endpoint task-cancel → cancel_child)
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_child_only_cancel_returns_envelope(monkeypatch):
    """cancel_child sur CET enfant → le handler rend une enveloppe
    ``task_cancelled`` (le tour parent SURVIT — pas de CancelledError)."""
    class _CancellingRunner(FakeRunner):
        async def __call__(self, messages, **kwargs):
            self.calls.append({"messages": messages, **kwargs})
            # Simule la boucle enfant qui voit le flag ciblé : le child_id est
            # le suffixe du chat_id synthétique.
            child_id = kwargs["chat_id"].split("#task-")[-1]
            assert cancel_child("u", child_id) is True   # actif au moment du flag
            assert kwargs["is_cancelled"]()              # composite le voit
            raise asyncio.CancelledError()

    events = []
    async def _on_event(ev): events.append(ev)
    handler, _ = _factory(monkeypatch, _CancellingRunner(), on_event=_on_event)
    out = json.loads(await handler({"subagent_type": "explore", "prompt": "p", "description": "d"}))
    assert out["error"] == "task_cancelled"
    finals = [e for e in events if e.get("status") == "final"]
    assert finals and finals[-1]["state"] == "cancelled"
    # Registres nettoyés (pas de fuite du flag vers un futur enfant).
    assert not task_tool._ACTIVE_CHILDREN and not task_tool._CANCELLED_CHILDREN


@pytest.mark.asyncio
async def test_parent_cancel_still_propagates(monkeypatch):
    """Stop du CHAT (is_cancelled parent) → CancelledError propagée même si un
    flag enfant traîne : le chemin d'annulation global reste intact."""
    class _ParentCancelRunner(FakeRunner):
        async def __call__(self, messages, **kwargs):
            child_id = kwargs["chat_id"].split("#task-")[-1]
            cancel_child("u", child_id)
            raise asyncio.CancelledError()

    _patch_runner(monkeypatch, _ParentCancelRunner())
    bt = build_task_builtin_tool(
        parent_mcp_configs=[], parent_builtin_tools=None, username="u", chat_id="chatA",
        model="m", sampling_override=None, memory_enabled=False,
        is_cancelled=lambda: True,           # ← le PARENT est annulé
        on_event=None, scheduling_mode="classic", usage_sink=None)
    with pytest.raises(asyncio.CancelledError):
        await bt["task"]["handler"]({"subagent_type": "explore", "prompt": "p", "description": "d"})
    assert not task_tool._ACTIVE_CHILDREN and not task_tool._CANCELLED_CHILDREN


# ─────────────────────────────────────────────────────────────────────────────
# Profondeur de récursion (TASK_SUBAGENT_DEPTH, modèle OpenCode v1.18.3)
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_depth_default_denies_recursion(monkeypatch):
    """Défaut N=1 : l'enfant ne voit JAMAIS le builtin task (deny + absent)."""
    runner = FakeRunner()
    handler, _ = _factory(monkeypatch, runner)
    await handler({"subagent_type": "explore", "prompt": "p", "description": "d"})
    kw = runner.calls[0]
    assert "task" in kw["deny_tool_names"]
    assert not (kw["builtin_tools"] or {})


@pytest.mark.asyncio
async def test_depth_2_injects_nested_task(monkeypatch):
    """N=2 : l'enfant (profondeur 1) reçoit le builtin task (deny levé) ; le
    record du run porte depth pour l'indentation UI."""
    monkeypatch.setattr(task_tool, "TASK_SUBAGENT_DEPTH", 2)
    runner = FakeRunner()
    sink = {}
    handler, _ = _factory(monkeypatch, runner, usage_sink=sink)
    await handler({"subagent_type": "explore", "prompt": "p", "description": "d"})
    kw = runner.calls[0]
    assert "task" not in kw["deny_tool_names"]           # récursion autorisée
    assert "todowrite" in kw["deny_tool_names"]          # todo toujours interdit
    nested = (kw["builtin_tools"] or {}).get("task")
    assert nested and callable(nested["handler"])        # builtin imbriqué présent
    assert sink["runs"][0]["depth"] == 0                 # run direct du chat


# ─────────────────────────────────────────────────────────────────────────────
# Reprise ``task_id``
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_resume_continues_same_child(monkeypatch):
    """Run 1 → store ; run 2 avec task_id → MÊMES messages (persona + tours
    expansés + rapport) + nouvelle mission ; enveloppe à id STABLE. Le runner
    reproduit le contrat RÉEL : tool_history DELTA du run, que le store
    concatène à child_messages sans perdre le tour 1."""
    runner = DeltaRunner(final_text="rapport A")
    sink = {}
    handler, _ = _factory(monkeypatch, runner, usage_sink=sink)
    out1 = await handler({"subagent_type": "explore", "prompt": "mission 1", "description": "d"})
    tid = out1.split('id="')[1].split('"')[0]
    assert (u_key := ("u", tid)) in task_tool._RESUME_STORE

    runner.final_text = "rapport B"
    out2 = await handler({"subagent_type": "explore", "prompt": "mission 2",
                          "description": "d", "task_id": tid})
    assert f'id="{tid}"' in out2 and "rapport B" in out2
    msgs2 = runner.calls[1]["messages"]
    roles = [m["role"] for m in msgs2]
    assert roles == ["system", "user", "assistant", "tool", "assistant", "user"]
    assert msgs2[1]["content"] == "mission 1"
    assert msgs2[2].get("tool_calls")                     # tour expansé
    assert msgs2[4]["content"] == "rapport A"             # rapport précédent
    assert msgs2[5]["content"] == "mission 2"
    # Le record marque la reprise ; le store est REMIS À JOUR (rapport B
    # inclus) SANS duplication du tour 1 malgré la tool_history cumulative.
    assert sink["runs"][1]["resumed"] is True
    stored = task_tool._RESUME_STORE[u_key]["messages"]
    assert [m["role"] for m in stored] == [
        "system", "user", "assistant", "tool", "assistant",
        "user", "assistant", "tool", "assistant"]
    assert stored[-1]["content"] == "rapport B"


@pytest.mark.asyncio
async def test_resume_lisible_depuis_un_autre_worker(monkeypatch):
    """Le tour qui rejoue ``task_id`` est une NOUVELLE requête HTTP, donc un
    worker arbitraire sous gunicorn. Avant le store partagé, il répondait
    ``unknown_task_id`` — alors que l'enveloppe venait de proposer cette
    reprise au modèle. On simule l'autre worker en vidant le cache mémoire."""
    from llm_core.tools import _task_resume

    runner = DeltaRunner(final_text="rapport A")
    handler, _ = _factory(monkeypatch, runner)
    out1 = await handler({"subagent_type": "explore", "prompt": "mission 1", "description": "d"})
    tid = out1.split('id="')[1].split('"')[0]

    # Le run a bien atterri dans le store PARTAGÉ…
    assert _task_resume.get("u", tid, 3600) is not None
    task_tool._RESUME_STORE.clear()          # …et l'autre worker n'a rien en mémoire.

    runner.final_text = "rapport B"
    out2 = await handler({"subagent_type": "explore", "prompt": "mission 2",
                          "description": "d", "task_id": tid})

    assert "unknown_task_id" not in out2
    assert f'id="{tid}"' in out2 and "rapport B" in out2
    msgs2 = runner.calls[1]["messages"]
    assert msgs2[1]["content"] == "mission 1"       # le travail du run 1 est là
    assert msgs2[-1]["content"] == "mission 2"


@pytest.mark.asyncio
async def test_resume_pas_de_duplication_multi_cycles(monkeypatch):
    """Régression 2026-07-18 (relue au contrat delta 2026-07-27) : les
    reprises successives ne dupliquent RIEN et ne PERDENT rien — croissance
    LINÉAIRE du prompt enfant (2, 6, 10 messages), le tool_call du run 1
    apparaît UNE fois, store sans doublon."""
    from collections import Counter
    runner = DeltaRunner(final_text="rapport 1")
    handler, _ = _factory(monkeypatch, runner)
    out1 = await handler({"subagent_type": "explore", "prompt": "m1", "description": "d"})
    tid = out1.split('id="')[1].split('"')[0]
    runner.final_text = "rapport 2"
    await handler({"subagent_type": "explore", "prompt": "m2", "description": "d", "task_id": tid})
    runner.final_text = "rapport 3"
    await handler({"subagent_type": "explore", "prompt": "m3", "description": "d", "task_id": tid})

    assert [len(c["messages"]) for c in runner.calls] == [2, 6, 10]
    msgs3 = runner.calls[2]["messages"]
    assert sum(1 for m in msgs3
               if m.get("role") == "assistant" and m.get("tool_calls")
               and m["tool_calls"][0]["id"] == "c1") == 1
    stored = task_tool._RESUME_STORE[("u", tid)]["messages"]
    assert len(stored) == 13          # [sys, u1] + 3 × (a, t, rapport) + u2 + u3
    cnt = Counter(json.dumps(m, sort_keys=True) for m in stored)
    assert max(cnt.values()) == 1     # aucun message dupliqué


@pytest.mark.asyncio
async def test_resume_unknown_task_id(monkeypatch):
    handler, _ = _factory(monkeypatch, FakeRunner())
    out = json.loads(await handler({"subagent_type": "explore", "prompt": "p",
                                    "description": "d", "task_id": "t9-doesnotexist"}))
    assert out["error"] == "unknown_task_id"


@pytest.mark.asyncio
async def test_resume_ttl_expiry(monkeypatch):
    """TTL écoulé → l'entrée est purgée, la reprise échoue proprement."""
    runner = FakeRunner(final_text="rapport")
    handler, _ = _factory(monkeypatch, runner)
    out1 = await handler({"subagent_type": "explore", "prompt": "m1", "description": "d"})
    tid = out1.split('id="')[1].split('"')[0]
    monkeypatch.setattr(task_tool, "TASK_RESUME_TTL_S", -1)   # tout est expiré
    out2 = json.loads(await handler({"subagent_type": "explore", "prompt": "m2",
                                     "description": "d", "task_id": tid}))
    assert out2["error"] == "unknown_task_id"
    assert not task_tool._RESUME_STORE


@pytest.mark.asyncio
async def test_spawned_event_carries_id_and_depth(monkeypatch):
    """L'event `spawned` part AVANT le run (le bouton ✕ a un id dès t0)."""
    events = []
    async def _on_event(ev): events.append(ev)
    handler, _ = _factory(monkeypatch, FakeRunner(), on_event=_on_event)
    await handler({"subagent_type": "explore", "prompt": "p", "description": "d"})
    assert events[0]["status"] == "spawned"
    assert events[0]["child_id"] and events[0]["depth"] == 0 and events[0]["resumed"] is False


@pytest.mark.asyncio
async def test_usage_sink_rollup(monkeypatch):
    sink = {}
    handler, _ = _factory(monkeypatch, FakeRunner(metrics={"input_tokens": 100, "output_tokens": 50}),
                          usage_sink=sink)
    await handler({"subagent_type": "explore", "prompt": "p", "description": "d"})
    await handler({"subagent_type": "web", "prompt": "q", "description": "d"})
    assert sink["tasks"] == 2
    assert sink["input_tokens"] == 200 and sink["output_tokens"] == 100
    # Records des runs (persistés en task_runs sur le message assistant).
    assert [r["agent"] for r in sink["runs"]] == ["explore", "web"]
    assert all(r["state"] == "completed" for r in sink["runs"])
    assert all(r["input_tokens"] == 100 and r["output_tokens"] == 50 for r in sink["runs"])


@pytest.mark.asyncio
async def test_usage_sink_run_record_transcript(monkeypatch):
    """Le record d'un run porte le transcript accumulé (tool_call → running,
    tool_result → done/error) — c'est lui qui réhydrate la carte agent."""
    child_events = [
        {"type": "tool_call", "name": "read_file", "args": {"path": "a.py"}},
        {"type": "tool_result", "name": "read_file", "result": '{"ok": true}'},
        {"type": "tool_call", "name": "list_files", "args": {"path": "src"}},
        {"type": "tool_result", "name": "list_files", "result": '{"ok": false, "error": "x"}'},
    ]
    sink = {}
    handler, _ = _factory(monkeypatch, FakeRunner(events=child_events), usage_sink=sink)
    await handler({"subagent_type": "explore", "prompt": "p", "description": "ma mission"})
    run = sink["runs"][0]
    assert run["label"] == "ma mission" and run["steps_total"] == 2
    assert [(t["tool"], t["status"]) for t in run["tools"]] == [
        ("read_file", "done"), ("list_files", "error")]
    assert run["tools"][0]["args_preview"].startswith('{"path"')
    assert "context_tokens" in run    # occupation réelle finale persistée


# ─────────────────────────────────────────────────────────────────────────────
# Fiabilité 2026-07-18 : reprise après interruption, GC cancel, chaîne chat_id
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_timeout_resume_keeps_partial_work(monkeypatch):
    """Timeout avec travail partiel : l'enveloppe porte task_id + next_action
    de reprise, le store contient l'historique live reconstruit (appariement
    assistant↔tool par ids synthétiques), et la reprise le rejoue.

    Timeout COURT mais non nul : à 0, wait_for annule le runner avant même
    qu'il ne démarre — aucun event, donc aucun travail partiel à conserver
    (c'est le cas du test suivant)."""
    monkeypatch.setattr(task_tool, "TASK_CHILD_TIMEOUT_S", 0.05)
    events = [
        {"type": "tool_call", "name": "read_file", "args": {"path": "a.py"}},
        {"type": "tool_result", "name": "read_file",
         "result": '{"ok": true, "content": "AAA"}'},
    ]
    runner = FakeRunner(delay=0.2, events=events)
    handler, _ = _factory(monkeypatch, runner)
    out = json.loads(await handler({"subagent_type": "explore", "prompt": "m1",
                                    "description": "d"}))
    assert out["error"] == "task_timeout"
    tid = out["task_id"]
    assert "resume" in out["next_action"]
    stored = task_tool._RESUME_STORE[("u", tid)]["messages"]
    assert [m["role"] for m in stored] == ["system", "user", "assistant", "tool"]
    assert stored[2]["tool_calls"][0]["function"]["name"] == "read_file"
    assert stored[3]["tool_call_id"] == stored[2]["tool_calls"][0]["id"]
    assert "AAA" in stored[3]["content"]

    # Reprise : plus de timeout → le run 2 démarre sur l'historique partiel.
    monkeypatch.setattr(task_tool, "TASK_CHILD_TIMEOUT_S", 30)
    runner.delay = 0.0
    runner.events = []
    runner.final_text = "rapport final"
    out2 = await handler({"subagent_type": "explore", "prompt": "continue",
                          "description": "d", "task_id": tid})
    assert f'id="{tid}"' in out2 and "rapport final" in out2
    msgs2 = runner.calls[1]["messages"]
    assert [m["role"] for m in msgs2] == ["system", "user", "assistant", "tool", "user"]
    assert msgs2[4]["content"] == "continue"


@pytest.mark.asyncio
async def test_resume_batch_parallele_apparie_par_call_id(monkeypatch):
    """Batch PARALLÈLE du même outil : chaque résultat est apparié à SON appel.

    Trois ``read_file`` partent ensemble (même ``name``, ``call_id`` distincts)
    et leurs résultats reviennent DANS LE DÉSORDRE — cas réel : le plus petit
    fichier répond en premier. L'appariement par nom en FIFO donnait alors le
    contenu de c.py à l'appel sur a.py ; à la reprise, le modèle relisait
    « j'ai lu a.py » avec le contenu de c.py. Seul ``call_id`` distingue les
    appels (cf. _chat_with_tools : les events tool_call/tool_result le portent).
    """
    monkeypatch.setattr(task_tool, "TASK_CHILD_TIMEOUT_S", 0.05)
    events = [
        {"type": "tool_call", "name": "read_file", "call_id": "c_a", "args": {"path": "a.py"}},
        {"type": "tool_call", "name": "read_file", "call_id": "c_b", "args": {"path": "b.py"}},
        {"type": "tool_call", "name": "read_file", "call_id": "c_c", "args": {"path": "c.py"}},
        # Résultats hors ordre : c, puis a, puis b.
        {"type": "tool_result", "name": "read_file", "call_id": "c_c",
         "result": '{"ok": true, "content": "CCC"}'},
        {"type": "tool_result", "name": "read_file", "call_id": "c_a",
         "result": '{"ok": true, "content": "AAA"}'},
        {"type": "tool_result", "name": "read_file", "call_id": "c_b",
         "result": '{"ok": true, "content": "BBB"}'},
    ]
    handler, _ = _factory(monkeypatch, FakeRunner(delay=0.2, events=events))
    out = json.loads(await handler({"subagent_type": "explore", "prompt": "m1",
                                    "description": "d"}))
    assert out["error"] == "task_timeout"
    stored = task_tool._RESUME_STORE[("u", out["task_id"])]["messages"]

    # Chaque appel assistant porte un id ; le message tool qui le référence
    # doit contenir le CONTENU du fichier demandé par CET appel.
    by_id = {tc["id"]: json.loads(tc["function"]["arguments"])["path"]
             for m in stored if m.get("tool_calls") for tc in m["tool_calls"]}
    paired = {by_id[m["tool_call_id"]]: m["content"]
              for m in stored if m.get("role") == "tool"}
    assert "AAA" in paired["a.py"], paired
    assert "BBB" in paired["b.py"], paired
    assert "CCC" in paired["c.py"], paired

    # AUDIT 2026-08-23 — la FORME, que ce test ne vérifiait pas : le
    # collecteur live appendait un assistant PAR appel puis les résultats
    # dans l'ordre d'ARRIVÉE, ce qui donnait trois assistants CONSÉCUTIFS
    # avec des appels pendants, puis des réponses hors position. llama.cpp
    # refuse cette forme en 400 : la reprise échouait en « Le modèle a refusé
    # la requête » et le travail partiel qu'on voulait sauver était perdu.
    # Contrat : un assistant à tool_calls est suivi IMMÉDIATEMENT des ``tool``
    # de ses ids, dans l'ordre.
    for _i, _m in enumerate(stored):
        if _m.get("role") != "assistant" or not _m.get("tool_calls"):
            continue
        _ids = [tc["id"] for tc in _m["tool_calls"]]
        _suite = stored[_i + 1:_i + 1 + len(_ids)]
        assert [s.get("role") for s in _suite] == ["tool"] * len(_ids), \
            f"appels pendants après l'assistant #{_i} : {[s.get('role') for s in _suite]}"
        assert [s.get("tool_call_id") for s in _suite] == _ids, \
            "les résultats ne suivent pas l'ordre des tool_calls"
    assert sum(1 for m in stored if m.get("tool_calls")) == 1, \
        "le lot parallèle doit tenir dans UN seul message assistant"


@pytest.mark.asyncio
async def test_timeout_sans_travail_partiel_pas_de_task_id(monkeypatch):
    """Timeout avant le moindre tool call : pas de task_id trompeur dans
    l'enveloppe, rien au store."""
    monkeypatch.setattr(task_tool, "TASK_CHILD_TIMEOUT_S", 0)
    handler, _ = _factory(monkeypatch, FakeRunner(delay=0.2))
    out = json.loads(await handler({"subagent_type": "explore", "prompt": "p",
                                    "description": "d"}))
    assert out["error"] == "task_timeout"
    assert "task_id" not in out
    assert not task_tool._RESUME_STORE


def test_cancel_child_inactif_ne_fuit_pas():
    """cancel_child d'un enfant inconnu/déjà fini sur ce worker → False et
    AUCUN flag posé (avant : flag orphelin jamais nettoyé — le set ne se
    purge qu'en fin de run)."""
    assert cancel_child("u", "t9-ghost") is False
    assert not task_tool._CANCELLED_CHILDREN


@pytest.mark.asyncio
async def test_nested_child_chat_id_chain(monkeypatch):
    """depth ≥ 2 : le petit-enfant hérite du chat_id SYNTHÉTIQUE de l'enfant
    (…#task-x#task-y) — la chaîne porte la profondeur réelle, pas un
    aplatissement sur le parent originel."""
    monkeypatch.setattr(task_tool, "TASK_SUBAGENT_DEPTH", 2)
    runner = FakeRunner()
    handler, _ = _factory(monkeypatch, runner)
    await handler({"subagent_type": "explore", "prompt": "p", "description": "d"})
    child_chat = runner.calls[0]["chat_id"]
    assert child_chat.startswith("chatA#task-")
    nested = (runner.calls[0]["builtin_tools"] or {})["task"]["handler"]
    await nested({"subagent_type": "explore", "prompt": "pp", "description": "dd"})
    grand_chat = runner.calls[1]["chat_id"]
    assert grand_chat.startswith(child_chat + "#task-")


@pytest.mark.asyncio
async def test_parent_stop_records_cancelled_run(monkeypatch):
    """Stop parent pendant un enfant : le record (state=cancelled) est poussé
    dans usage_sink AVANT la propagation (la route persiste le partiel avec
    task_runs → la ligne agent survit au rechargement), et le travail partiel
    est stocké pour reprise — paires COMPLÈTES seulement (l'appel encore en
    vol, sans résultat, est écarté du replay)."""
    sink = {}
    events = [
        {"type": "tool_call", "name": "read_file", "args": {"path": "a.py"}},
        {"type": "tool_result", "name": "read_file",
         "result": '{"ok": true, "content": "AAA"}'},
        {"type": "tool_call", "name": "code", "args": {"pattern": "x"}},  # en vol
    ]
    handler, _ = _factory(monkeypatch,
                          FakeRunner(raises=asyncio.CancelledError(), events=events),
                          usage_sink=sink)
    with pytest.raises(asyncio.CancelledError):
        await handler({"subagent_type": "explore", "prompt": "p", "description": "d"})
    run = sink["runs"][0]
    assert run["state"] == "cancelled" and run["id"]
    stored = task_tool._RESUME_STORE[("u", run["id"])]["messages"]
    assert [m["role"] for m in stored] == ["system", "user", "assistant", "tool"]
    assert stored[2]["tool_calls"][0]["function"]["name"] == "read_file"


def test_budgets_agents_branches_sur_la_config():
    """Les max_iters du registre viennent des constantes TASK_MAX_ITERS_*
    (surfacées dans shared_infra/config.py — plus de littéraux en dur)."""
    from llm_core import _constants as C
    assert _AGENTS["explore"].max_iters == C.TASK_MAX_ITERS_EXPLORE
    assert _AGENTS["implement"].max_iters == C.TASK_MAX_ITERS_IMPLEMENT
    assert _AGENTS["verify"].max_iters == C.TASK_MAX_ITERS_VERIFY
    assert _AGENTS["web"].max_iters == C.TASK_MAX_ITERS_WEB
    assert _AGENTS["pr"].max_iters == C.TASK_MAX_ITERS_PR


# ─────────────────────────────────────────────────────────────────────────────
# Agents CUSTOM (settings_json.custom_agents → extra du registre)
# ─────────────────────────────────────────────────────────────────────────────

_CUSTOM = [{
    "name": "docs-writer",
    "description": "writes repo documentation",
    "prompt": "You are a docs writer sub-agent.",
    "tool_categories": ["fs", "git"],
}]


def test_definition_bytestable_without_customs(monkeypatch):
    """Sans customs (None ou []), la définition de la factory est byte-identique
    au zéro-arg — prefix KV inter-users préservé (régression clé)."""
    runner = FakeRunner()
    _, d_none = _factory(monkeypatch, runner)
    _, d_empty = _factory(monkeypatch, runner, custom_agents=[])
    d_zero = task_tool._build_definition()
    assert json.dumps(d_none, sort_keys=True) == json.dumps(d_zero, sort_keys=True)
    assert json.dumps(d_empty, sort_keys=True) == json.dumps(d_zero, sort_keys=True)


def test_custom_agent_extends_enum_and_roster(monkeypatch):
    runner = FakeRunner()
    _, d1 = _factory(monkeypatch, runner, custom_agents=_CUSTOM)
    _, d2 = _factory(monkeypatch, runner, custom_agents=_CUSTOM)
    # stable PAR USER d'un tour à l'autre (ordre stocké, jamais trié)
    assert json.dumps(d1, sort_keys=True) == json.dumps(d2, sort_keys=True)
    params = d1["function"]["parameters"]
    assert params["properties"]["subagent_type"]["enum"] == list(_AGENTS) + ["docs-writer"]
    assert "- docs-writer: writes repo documentation" in d1["function"]["description"]


@pytest.mark.asyncio
async def test_custom_agent_child_kwargs(monkeypatch):
    """Un agent custom = persona inline + serveur synthétique scopé aux
    catégories choisies + deny de base + budget des agents custom."""
    runner = FakeRunner()
    handler, _ = _factory(monkeypatch, runner, memory_enabled=True, custom_agents=_CUSTOM)
    res = await handler({"subagent_type": "docs-writer", "prompt": "write docs", "description": "d"})
    assert '<task id="' in res and 'state="completed"' in res
    kw = runner.calls[0]
    head = kw["messages"][0]
    assert head["role"] == "system"
    assert head["content"].startswith("You are a docs writer sub-agent.")
    assert "<task_env>" in head["content"]
    assert kw["mcp_configs"][0]["command"] == "DEFAULT_LOCAL_PYTHON"
    assert kw["mcp_configs"][0]["filter_categories"] == ["fs", "git"]
    assert kw["allowed_tool_names"] is None
    assert {"task", "todowrite"} <= set(kw["deny_tool_names"])
    assert kw["memory_enabled"] is False               # jamais d'écriture mémoire
    assert kw["builtin_tools"] is None                 # pas de RAG hérité
    assert kw["sampling_override"]["max_tool_iterations"] == task_tool.TASK_MAX_ITERS_CUSTOM


@pytest.mark.asyncio
async def test_unknown_agent_valid_choices_include_customs(monkeypatch):
    handler, _ = _factory(monkeypatch, FakeRunner(), custom_agents=_CUSTOM)
    out = json.loads(await handler({"subagent_type": "nope", "prompt": "x", "description": "d"}))
    assert out["ok"] is False and out["error"] == "unknown_agent"
    assert out["valid_choices"] == list(_AGENTS) + ["docs-writer"]


def test_custom_agents_invalid_entries_skipped(monkeypatch):
    """_specs_from_custom est DÉFENSIF : blob legacy → skip silencieux, jamais
    bloquant. Seule la 1re occurrence valide d'un nom est gardée. Un nom
    RÉSERVÉ fait exception : il est renommé (cf.
    test_custom_agent_with_reserved_name_is_renamed_not_rejected), jamais
    skippé — sinon l'agent disparaît sans que l'utilisateur le sache."""
    bad = [
        {"name": "task", "prompt": "x"},                 # réservé → RENOMMÉ
        {"name": "Bad Name!", "prompt": "x"},            # regex KO
        {"name": "dup", "prompt": "x"},
        {"name": "dup", "prompt": "y"},                  # doublon
        "junk",                                          # non-dict
        {"name": "noprompt", "prompt": "   "},           # prompt vide
    ]
    _, d = _factory(monkeypatch, FakeRunner(), custom_agents=bad)
    enum = d["function"]["parameters"]["properties"]["subagent_type"]["enum"]
    assert enum == list(_AGENTS) + ["task-custom", "dup"]
    # Un nom INTÉGRÉ n'est plus renommé ni refusé : c'est une surcharge en
    # place (cf. test_builtin_override_*), donc l'enum ne grandit pas.
    _, d2 = _factory(monkeypatch, FakeRunner(),
                     custom_agents=[{"name": "explore", "prompt": "x"}])
    assert d2["function"]["parameters"]["properties"]["subagent_type"]["enum"] == list(_AGENTS)


def test_validate_custom_agents_normalizes_and_rejects():
    from llm_core.tools.task_tool import validate_custom_agents
    ok = validate_custom_agents([{
        "name": "  Docs-Writer ",
        "description": " writes\nthe   docs ",
        "prompt": "  P  ",
        "tool_categories": ["FS", "git", "fs"],
        "mcp_server_ids": [" srv_a ", "srv_b", "srv_a"],
    }])
    assert ok == [{"name": "docs-writer", "description": "writes the docs",
                   "prompt": "P", "tool_categories": ["fs", "git"],
                   "mcp_server_ids": ["srv_a", "srv_b"]}]
    assert validate_custom_agents(ok) == ok               # idempotent (re-PUT du blob)
    assert validate_custom_agents(None) == []
    # Entrée legacy SANS la clé mcp_server_ids → normalisée avec [].
    legacy = validate_custom_agents([{"name": "old", "prompt": "x"}])
    assert legacy[0]["mcp_server_ids"] == []
    for bad in (
        "not-a-list",
        [{"name": "a b", "prompt": "x"}],                 # regex KO
        [{"name": "ok", "prompt": ""}],                   # prompt vide
        [{"name": "ok", "prompt": "x" * (task_tool.CUSTOM_PROMPT_MAX + 1)}],
        [{"name": "ok", "prompt": "x", "tool_categories": "fs"}],
        [{"name": "ok", "prompt": "x", "mcp_server_ids": "srv_a"}],       # non-liste
        [{"name": "ok", "prompt": "x",
          "mcp_server_ids": [f"s{i}" for i in range(task_tool.CUSTOM_MCP_MAX + 1)]}],
        [{"name": f"a{i}", "prompt": "x"} for i in range(task_tool.CUSTOM_AGENTS_MAX + 1)],
        [{"name": "ok", "prompt": "x"}, {"name": "ok", "prompt": "y"}],   # doublon
    ):
        with pytest.raises(ValueError):
            validate_custom_agents(bad)
    # …mais PAS une valeur qui ne se saisit pas au formulaire (slug de
    # catégorie, id de serveur) : elle est SAUTÉE. Refuser faisait échouer le
    # PUT sur le blob entier — donc plus aucun réglage enregistrable — pour une
    # valeur que l'utilisateur ne pouvait même pas retirer depuis le panneau
    # (un id absent de la liste des serveurs n'a pas de case à décocher).
    junk = validate_custom_agents([{
        "name": "ok", "prompt": "x",
        "tool_categories": ["git", "pas un slug"],
        "mcp_server_ids": ["srv_a", "", "z" * 65],
    }])
    assert junk[0]["tool_categories"] == ["git"]
    assert junk[0]["mcp_server_ids"] == ["srv_a"]


def test_custom_agent_with_reserved_name_is_renamed_not_rejected():
    """Un nom RÉSERVÉ est renommé, jamais refusé.

    Le casting intégré bouge (2026-08-04 : ``implement``/``verify``/``pr``
    ajoutés). Un agent custom déjà stocké sous l'un de ces noms — libre la
    veille — faisait échouer le PUT sur le blob ENTIER : le panneau Paramètres
    re-poste tout à chaque « Enregistrer », donc plus AUCUN réglage n'était
    enregistrable, et l'agent était silencieusement inerte au runtime.

    Le formulaire client refuse déjà un nom réservé saisi à la main, donc ce
    chemin ne sert qu'aux données déjà en base."""
    from llm_core.tools.task_tool import _specs_from_custom, validate_custom_agents

    # Depuis 2026-09-11 les noms des INTÉGRÉS ne sont plus réservés (ils se
    # surchargent) : seul ``task`` l'est encore, et c'est lui qu'on renomme.
    legacy = [
        {"name": "task", "description": "mon agent PR", "prompt": "P",
         "tool_categories": ["git"]},
        {"name": "docs", "prompt": "D"},
    ]
    out = validate_custom_agents(legacy)
    names = [a["name"] for a in out]
    assert names[0] not in task_tool.RESERVED_AGENT_NAMES and names[0].startswith("task-")
    assert names[1] == "docs"
    # Le contenu SUIT le renommage — on ne perd ni le prompt ni le périmètre.
    assert out[0]["prompt"] == "P" and out[0]["tool_categories"] == ["git"]
    assert validate_custom_agents(out) == out                    # idempotent
    # Runtime : renommé AUSSI (l'agent reste utilisable sans passer par les
    # Paramètres), et sur le MÊME nom que la validation → pas de divergence.
    assert list(_specs_from_custom(legacy)) == names

    # Le renommage ne vole pas le nom d'un agent présent plus loin dans la liste.
    collide = validate_custom_agents([
        {"name": "task", "prompt": "P"},
        {"name": "task-custom", "prompt": "Q"},
    ])
    assert len({a["name"] for a in collide}) == 2
    assert "task-custom" in {a["name"] for a in collide}


@pytest.mark.asyncio
async def test_custom_agent_resolves_mcp_servers(monkeypatch):
    """mcp_server_ids résolus dans la liste COMPLÈTE de l'utilisateur : l'enfant
    reçoit le serveur local synthétique + les serveurs choisis (id inconnu
    inerte, ordre de la liste utilisateur préservé). Les builtins n'y touchent
    jamais."""
    servers = [
        {"id": "srv_a", "type": "sse", "name": "Confluence", "url": "http://a"},
        {"id": "srv_b", "type": "sse", "name": "Jira", "url": "http://b"},
    ]
    customs = [{"name": "docs-writer", "description": "d", "prompt": "P.",
                "tool_categories": ["fs"], "mcp_server_ids": ["srv_b", "nope"]}]
    runner = FakeRunner()
    handler, _ = _factory(monkeypatch, runner, custom_agents=customs,
                          user_mcp_configs=servers)
    await handler({"subagent_type": "docs-writer", "prompt": "p", "description": "d"})
    cfgs = runner.calls[0]["mcp_configs"]
    assert cfgs[0]["command"] == "DEFAULT_LOCAL_PYTHON"
    assert cfgs[0]["filter_categories"] == ["fs"]
    assert [c.get("id") for c in cfgs[1:]] == ["srv_b"]   # résolu, 'nope' inerte
    # Builtin explore : jamais de serveurs utilisateur, même liste fournie.
    runner2 = FakeRunner()
    handler2, _ = _factory(monkeypatch, runner2, custom_agents=customs,
                           user_mcp_configs=servers)
    await handler2({"subagent_type": "explore", "prompt": "p", "description": "d"})
    cfgs2 = runner2.calls[0]["mcp_configs"]
    assert len(cfgs2) == 1 and cfgs2[0]["command"] == "DEFAULT_LOCAL_PYTHON"


@pytest.mark.asyncio
async def test_custom_agents_propagate_to_nested_factory(monkeypatch):
    """Récursion N=2 : la factory imbriquée reçoit les MÊMES customs — un
    enfant de profondeur 1 garde le roster étendu."""
    monkeypatch.setattr(task_tool, "TASK_SUBAGENT_DEPTH", 2)
    runner = FakeRunner()
    handler, _ = _factory(monkeypatch, runner, custom_agents=_CUSTOM)
    await handler({"subagent_type": "docs-writer", "prompt": "p", "description": "d"})
    kw = runner.calls[0]
    nested = (kw["builtin_tools"] or {}).get("task")
    assert nested and callable(nested["handler"])
    enum = nested["definition"]["function"]["parameters"]["properties"]["subagent_type"]["enum"]
    assert "docs-writer" in enum


@pytest.mark.asyncio
async def test_resume_after_custom_agent_removed(monkeypatch):
    """Reprise task_id d'un agent custom SUPPRIMÉ des settings entre-temps :
    le record stocké prime (agent=docs-writer) mais la map effective ne le
    connaît plus → enveloppe unknown_agent propre."""
    runner = FakeRunner(final_text="first report")
    handler, _ = _factory(monkeypatch, runner, custom_agents=_CUSTOM)
    res = await handler({"subagent_type": "docs-writer", "prompt": "p", "description": "d"})
    tid = res.split('id="')[1].split('"')[0]
    assert ("u", tid) in task_tool._RESUME_STORE
    handler2, _ = _factory(monkeypatch, FakeRunner(), custom_agents=[])
    out = json.loads(await handler2({"subagent_type": "explore", "prompt": "again",
                                     "description": "d", "task_id": tid}))
    assert out["ok"] is False and out["error"] == "unknown_agent"
    assert out["valid_choices"] == list(_AGENTS)


# ─────────────────────────────────────────────────────────────────────────────
# Compteur « étape N/M » — homogénéité numérateur/dénominateur (2026-07-29)
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_step_counter_counts_turns_not_calls(monkeypatch):
    """``step`` (numérateur) et ``max_steps`` (dénominateur) comptent la MÊME
    chose : des TOURS. Avant, ``step`` était incrémenté par ``tool_call`` —
    donc les appels PARALLÈLES d'un même tour comptaient chacun et les appels
    en ÉCHEC aussi, pendant que ``max_steps`` restait un budget d'itérations.
    L'UI pouvait afficher « étape 63/40 ». ``calls`` porte désormais, à part,
    le compte d'appels."""
    child_events = [
        # Tour 1 : TROIS appels en parallèle, dont un qui échoue.
        {"type": "iteration", "n": 1, "max": 25, "context_tokens": 100},
        {"type": "tool_call", "name": "read_file", "args": {"path": "a.py"}},
        {"type": "tool_call", "name": "read_file", "args": {"path": "b.py"}},
        {"type": "tool_call", "name": "grep", "args": {"q": "x"}},
        {"type": "tool_result", "name": "read_file", "result": '{"ok": true}'},
        {"type": "tool_result", "name": "read_file", "result": '{"ok": true}'},
        {"type": "tool_result", "name": "grep", "result": '{"ok": false, "error": "boom"}'},
        # Tour 2 : un seul appel.
        {"type": "iteration", "n": 2, "max": 25, "context_tokens": 200},
        {"type": "tool_call", "name": "list_files", "args": {"path": "src"}},
        {"type": "tool_result", "name": "list_files", "result": '{"ok": true}'},
    ]
    seen = []
    async def _on_event(ev): seen.append(ev)
    handler, _ = _factory(monkeypatch, FakeRunner(events=child_events), on_event=_on_event)
    await handler({"subagent_type": "explore", "prompt": "p", "description": "d"})

    running = [e for e in seen if e.get("status") == "running"]
    assert [e["tool"] for e in running] == ["read_file", "read_file", "grep", "list_files"]
    # Le tour 1 reste l'étape 1 pour ses 3 appels ; le tour 2 est l'étape 2.
    assert [e["step"] for e in running] == [1, 1, 1, 2]
    # Le compte d'APPELS reste disponible, séparément.
    assert [e["calls"] for e in running] == [1, 2, 3, 4]
    # Dénominateur : budget d'itérations de l'enfant, homogène au numérateur.
    assert {e["max_steps"] for e in running} == {25}
    assert all(e["step"] <= e["max_steps"] for e in seen if e.get("max_steps"))

    # done/error : même unité que running (avant : n° du dernier appel démarré,
    # qui faisait bondir « étape N » à chaque résultat d'appel parallèle).
    dones = [e for e in seen if e.get("status") in ("done", "error")]
    assert [e["step"] for e in dones] == [1, 1, 1, 2]
    # Le total final compte bien les APPELS (rendu « N appel(s) » côté UI).
    final = [e for e in seen if e.get("status") == "final"][-1]
    assert final["steps_total"] == 4


@pytest.mark.asyncio
async def test_step_counter_uses_child_budget_from_event(monkeypatch):
    """``max_steps`` suit le budget ANNONCÉ par l'enfant (event ``iteration``)
    plutôt qu'une constante figée : un override de ``max_tool_iterations``
    doit se refléter dans la barre de progression."""
    child_events = [
        {"type": "iteration", "n": 1, "max": 300, "context_tokens": 10},
        {"type": "tool_call", "name": "read_file", "args": {}},
        {"type": "tool_result", "name": "read_file", "result": '{"ok": true}'},
    ]
    seen = []
    async def _on_event(ev): seen.append(ev)
    handler, _ = _factory(monkeypatch, FakeRunner(events=child_events), on_event=_on_event)
    await handler({"subagent_type": "explore", "prompt": "p", "description": "d"})
    running = [e for e in seen if e.get("status") == "running"]
    assert running and running[0]["max_steps"] == 300


@pytest.mark.asyncio
async def test_step_counter_without_iteration_events(monkeypatch):
    """Enfant qui n'émettrait aucun event ``iteration`` (runner exotique) :
    le compteur reste borné et cohérent — jamais 0 ni au-dessus du budget."""
    child_events = [
        {"type": "tool_call", "name": "read_file", "args": {}},
        {"type": "tool_result", "name": "read_file", "result": '{"ok": true}'},
    ]
    seen = []
    async def _on_event(ev): seen.append(ev)
    handler, _ = _factory(monkeypatch, FakeRunner(events=child_events), on_event=_on_event)
    await handler({"subagent_type": "explore", "prompt": "p", "description": "d"})
    running = [e for e in seen if e.get("status") == "running"]
    assert running and running[0]["step"] == 1
    assert running[0]["step"] <= running[0]["max_steps"]


# ─────────────────────────────────────────────────────────────────────────────
# Index des skills : seulement pour un enfant qui détient la catégorie ``skill``
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_agent_avec_categorie_skill_recoit_lindex(monkeypatch):
    """``skill_get`` sans index, c'est un outil qu'on ne peut appeler qu'en
    devinant un nom : la route de chat injecte l'index, la boucle non — donc
    un agent custom qui coche « Skills » repartait avec trois outils morts."""
    import llm_core._system_prompts as sp
    monkeypatch.setattr(sp, "build_skills_index_block",
                        lambda uid: f"# Skills (known procedures)\nuid={uid}")
    runner = FakeRunner()
    customs = [{"name": "proc", "prompt": "P.", "tool_categories": ["skill", "fs"]}]
    handler, _ = _factory(monkeypatch, runner, custom_agents=customs, user_id=42)
    await handler({"subagent_type": "proc", "prompt": "go", "description": "d"})
    head = runner.calls[0]["messages"][0]["content"]
    assert head.startswith("P.")                     # la persona reste en tête
    assert "# Skills (known procedures)" in head and "uid=42" in head


@pytest.mark.asyncio
async def test_pas_dindex_skills_sans_la_categorie(monkeypatch):
    """Aucun agent intégré n'a la catégorie ``skill`` : ils ne paient pas
    l'index. Même chose si l'appelant ne fournit pas de ``user_id``."""
    import llm_core._system_prompts as sp
    monkeypatch.setattr(sp, "build_skills_index_block",
                        lambda uid: "# Skills (known procedures)\nX")
    runner = FakeRunner()
    handler, _ = _factory(monkeypatch, runner, user_id=42)
    await handler({"subagent_type": "explore", "prompt": "go", "description": "d"})
    assert "# Skills" not in runner.calls[0]["messages"][0]["content"]

    runner2 = FakeRunner()
    customs = [{"name": "proc", "prompt": "P.", "tool_categories": ["skill"]}]
    handler2, _ = _factory(monkeypatch, runner2, custom_agents=customs, user_id=None)
    await handler2({"subagent_type": "proc", "prompt": "go", "description": "d"})
    assert "# Skills" not in runner2.calls[0]["messages"][0]["content"]


# ─────────────────────────────────────────────────────────────────────────────
# AUDIT 2026-08-30 — la réponse finale ne doit JAMAIS partir deux fois
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_reponse_finale_pas_dupliquee_dans_le_deroule(monkeypatch):
    """Le texte final part comme ``result``, PAS aussi en entrée de déroulé.

    Régression vécue : la modale « œil » affichait la réponse de l'agent deux
    fois — une fois dans le bloc « Résultat » (``result``, entier) et une fois
    en dernière ligne du déroulé (``transcript``, tronqué à 1500 c). La cause
    était un « filet déroulé » qui recopiait ``final_text`` dans le tampon de
    narration quand le runner n'avait streamé aucun ``content_token`` — filet
    écrit AVANT que le bloc « Résultat » n'existe, donc devenu un doublon.
    """
    steps = []
    sink = {}

    async def on_event(ev):
        if ev.get("type") == "task_step":
            steps.append(ev)

    runner = FakeRunner(final_text="LA REPONSE FINALE DE L AGENT")
    handler, _ = _factory(monkeypatch, runner, on_event=on_event, usage_sink=sink)
    await handler({"subagent_type": "explore", "prompt": "p", "description": "d"})

    final = [s for s in steps if s.get("status") == "final"]
    assert len(final) == 1
    assert final[0]["result"] == "LA REPONSE FINALE DE L AGENT"
    # Le déroulé ne doit contenir AUCUNE entrée reprenant ce texte.
    textes = [e.get("text", "") for e in (final[0].get("transcript") or [])]
    assert not any("LA REPONSE FINALE DE L AGENT" in t for t in textes), \
        f"réponse finale dupliquée dans le déroulé : {textes!r}"
    # Idem dans le record persisté (réhydratation de la carte au reload).
    run = sink["runs"][0]
    assert run["result"] == "LA REPONSE FINALE DE L AGENT"
    assert not any("LA REPONSE FINALE DE L AGENT" in (e.get("text") or "")
                   for e in (run.get("transcript") or []))


@pytest.mark.asyncio
async def test_narration_intermediaire_reste_dans_le_deroule(monkeypatch):
    """Contre-épreuve : ce qui a VRAIMENT été narré pendant le run reste dans
    le déroulé. Le correctif ne doit pas vider la modale de sa substance."""
    steps = []

    async def on_event(ev):
        if ev.get("type") == "task_step":
            steps.append(ev)

    events = [
        {"type": "content_token", "text": "je cherche dans le dépôt…"},
        {"type": "tool_call", "name": "read_file", "args": {"path": "a.py"}},
        {"type": "tool_result", "name": "read_file", "result": '{"ok": true}'},
    ]
    runner = FakeRunner(final_text="conclusion", events=events)
    handler, _ = _factory(monkeypatch, runner, on_event=on_event)
    await handler({"subagent_type": "explore", "prompt": "p", "description": "d"})

    final = [s for s in steps if s.get("status") == "final"][0]
    textes = " ".join(e.get("text", "") for e in (final.get("transcript") or []))
    assert "je cherche dans le dépôt" in textes

@pytest.mark.asyncio
async def test_reponse_finale_streamee_pas_dupliquee(monkeypatch):
    """Cas RÉEL : l'enfant STREAME sa réponse finale en content_token.

    Le premier correctif ne couvrait que le runner SANS stream. Or dans le cas
    nominal la réponse finale arrive en ``content_token`` après le dernier
    appel d'outil : elle s'accumulait dans le tampon de narration, et le flush
    de fin de run la déposait en dernière entrée du déroulé — pendant que
    ``result`` la portait déjà. La modale affichait alors, dans cet ordre :
    la réponse, la liste des outils, puis la réponse une SECONDE fois.
    """
    steps = []

    async def on_event(ev):
        if ev.get("type") == "task_step":
            steps.append(ev)

    events = [
        {"type": "content_token", "text": "je regarde le dépôt…"},
        {"type": "tool_call", "name": "read_file", "args": {"path": "a.py"}},
        {"type": "tool_result", "name": "read_file", "result": '{"ok": true}'},
        # ── réponse finale STREAMÉE, après le dernier outil ──
        {"type": "content_token", "text": "Voici mon rapport : "},
        {"type": "content_token", "text": "tout est en ordre."},
    ]
    runner = FakeRunner(final_text="Voici mon rapport : tout est en ordre.",
                        events=events)
    handler, _ = _factory(monkeypatch, runner, on_event=on_event)
    await handler({"subagent_type": "explore", "prompt": "p", "description": "d"})

    final = [s for s in steps if s.get("status") == "final"][0]
    textes = [e.get("text", "") for e in (final.get("transcript") or [])]
    assert final["result"] == "Voici mon rapport : tout est en ordre."
    # UNE seule sortie : le déroulé garde la narration, pas la réponse finale.
    assert any("je regarde le dépôt" in t for t in textes), \
        f"la narration intermédiaire a disparu : {textes!r}"
    assert not any("tout est en ordre" in t for t in textes), \
        f"réponse finale dupliquée dans le déroulé : {textes!r}"


# ─────────────────────────────────────────────────────────────────────────────
#  Banque d'agents (2026-09-11) : les intégrés sont des MODÈLES surchargeables
# ─────────────────────────────────────────────────────────────────────────────
def test_builtin_override_only_stores_deltas():
    """Une surcharge ne porte que ses écarts ; sans écart, elle n'est pas
    écrite du tout (= réinitialisée). Le prompt d'un intégré est OPTIONNEL."""
    from llm_core.tools.task_tool import validate_custom_agents
    out = validate_custom_agents([
        {"name": "verify", "prompt": "", "tool_categories": ["shell"], "enabled": True},
        {"name": "explore", "prompt": "", "tool_categories": [], "mcp_server_ids": []},
        {"name": "pr", "enabled": False},
        {"name": "web", "prompt": "My own web persona.", "max_iters": 12},
    ])
    assert [a["name"] for a in out] == ["verify", "pr", "web"]      # explore : rien à écrire
    assert out[0] == {"name": "verify", "description": "", "prompt": "",
                      "tool_categories": ["shell"], "mcp_server_ids": []}
    assert out[1] == {"name": "pr", "description": "", "prompt": "",
                      "tool_categories": [], "mcp_server_ids": [], "enabled": False}
    assert out[2]["prompt"] == "My own web persona." and out[2]["max_iters"] == 12
    assert validate_custom_agents(out) == out                      # idempotent


@pytest.mark.asyncio
async def test_builtin_override_changes_child_kwargs(monkeypatch):
    """La surcharge s'applique champ par champ : prompt, catégories, budget,
    serveurs MCP ; ce qui n'est pas surchargé reste celui du modèle."""
    servers = [{"id": "srv_b", "type": "sse", "name": "Jira", "url": "http://b"}]
    runner = FakeRunner()
    handler, d = _factory(monkeypatch, runner, user_mcp_configs=servers, custom_agents=[
        {"name": "verify", "prompt": "You are my verifier.",
         "tool_categories": ["shell"], "mcp_server_ids": ["srv_b"], "max_iters": 7,
         "description": "runs MY tests"},
    ])
    # Roster : en place, même position, description surchargée.
    enum = d["function"]["parameters"]["properties"]["subagent_type"]["enum"]
    assert enum == list(_AGENTS)
    assert "- verify: runs MY tests" in d["function"]["description"]
    await handler({"subagent_type": "verify", "prompt": "p", "description": "d"})
    kw = runner.calls[0]
    assert kw["messages"][0]["content"].startswith("You are my verifier.")
    assert kw["mcp_configs"][0]["filter_categories"] == ["shell"]
    assert [c.get("id") for c in kw["mcp_configs"][1:]] == ["srv_b"]
    assert kw["sampling_override"]["max_tool_iterations"] == 7


@pytest.mark.asyncio
async def test_builtin_override_empty_fields_fall_back_to_template(monkeypatch):
    """Prompt vide → persona LIVRÉE (qui suit ses mises à jour) ; catégories
    vides → celles du modèle ; budget absent → celui du modèle."""
    runner = FakeRunner()
    handler, _ = _factory(monkeypatch, runner,
                          custom_agents=[{"name": "explore", "description": "mine"}])
    await handler({"subagent_type": "explore", "prompt": "p", "description": "d"})
    kw = runner.calls[0]
    from llm_core.tools.task_tool import load_agent_persona
    livree = load_agent_persona(_AGENTS["explore"].persona_stem)
    assert livree and kw["messages"][0]["content"].startswith(livree[:40])
    assert kw["mcp_configs"][0]["filter_categories"] == _AGENTS["explore"].filter_categories
    assert kw["sampling_override"]["max_tool_iterations"] == _AGENTS["explore"].max_iters


@pytest.mark.asyncio
async def test_disabled_builtin_leaves_roster_and_enum(monkeypatch):
    runner = FakeRunner()
    handler, d = _factory(monkeypatch, runner, custom_agents=[
        {"name": "pr", "enabled": False},
        {"name": "docs-writer", "prompt": "D.", "enabled": False},
        {"name": "notes", "prompt": "N."},
    ])
    enum = d["function"]["parameters"]["properties"]["subagent_type"]["enum"]
    assert enum == [n for n in _AGENTS if n != "pr"] + ["notes"]
    assert "- pr:" not in d["function"]["description"]
    out = json.loads(await handler({"subagent_type": "pr", "prompt": "x", "description": "d"}))
    assert out["error"] == "unknown_agent" and "pr" not in out["valid_choices"]


def test_banque_entierement_desactivee_pas_doutil_task(monkeypatch):
    """Tous les agents désactivés : l'enum de ``subagent_type`` serait VIDE, ce
    que la grammaire llama.cpp rend impossible (``()``) → erreur de parseur.
    L'outil n'est donc pas exposé du tout (2026-09-21)."""
    from llm_core.tools.task_tool import has_active_agents
    tout_coupe = [{"name": n, "enabled": False} for n in _AGENTS] + [
        {"name": "notes", "prompt": "N.", "enabled": False}]
    _patch_runner(monkeypatch, FakeRunner())
    bt = build_task_builtin_tool(
        parent_mcp_configs=[], parent_builtin_tools=None, username="u",
        chat_id="chatA", model="m", sampling_override=None, memory_enabled=False,
        is_cancelled=lambda: False, on_event=None, scheduling_mode="classic",
        custom_agents=tout_coupe)
    assert bt == {}
    assert has_active_agents(tout_coupe) is False
    # Un seul agent réactivé suffit à rendre l'outil.
    assert has_active_agents(tout_coupe[:-1] + [{"name": "notes", "prompt": "N."}]) is True
    assert has_active_agents(None) is True


def test_definition_bytestable_with_empty_overrides(monkeypatch):
    """Une liste d'entrées qui ne surchargent rien ne change pas la définition."""
    _, d = _factory(monkeypatch, FakeRunner(), custom_agents=[{"name": "explore"}])
    assert json.dumps(d, sort_keys=True) == json.dumps(task_tool._build_definition(), sort_keys=True)


def test_agent_templates_expose_the_shipped_persona():
    from llm_core.tools.task_tool import agent_templates
    tpl = agent_templates()
    assert [t["name"] for t in tpl] == list(_AGENTS)
    for t in tpl:
        assert t["prompt"].startswith("# Role"), t["name"]
        assert t["tool_categories"] and t["max_iters"] > 0 and t["summary"]


# ─────────────────────────────────────────────────────────────────────────────
# AUDIT 2026-09-24 (point 10) — arrêt sur une borne du harnais ≠ « completed »
# ─────────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_arret_sur_borne_du_harnais_rendu_incomplete(monkeypatch):
    """Un enfant stoppé par sa limite d'itérations (ou budget de temps,
    anti-boucle, contexte saturé) rendait ``state="completed"`` avec un
    message destiné à l'humain. Il doit rendre un état DISTINCT, avec
    ``task_id`` + ``next_action`` de reprise et le texte en ``partial_report``,
    et le travail doit être reprenable."""
    events = []
    async def _on_event(ev): events.append(ev)
    runner = DeltaRunner(final_text="J'ai atteint la limite d'itérations…")
    _orig = runner.__call__

    async def _limite(messages, **kwargs):
        res = await _orig(messages, **kwargs)
        runner.metrics.update({"tool_limit_reached": True,
                               "tool_limit_stop_reason": "steps"})
        return res
    handler, _ = _factory(monkeypatch, _limite, on_event=_on_event)
    raw = await handler({"subagent_type": "explore", "prompt": "p", "description": "d"})
    assert 'state="completed"' not in raw
    out = json.loads(raw)
    assert out["error"] == "task_incomplete"
    assert out["stop_reason"] == "steps"
    assert out["partial_report"].startswith("J'ai atteint la limite")
    assert out["task_id"] and "resume" in out["next_action"]
    finals = [e for e in events if e.get("status") == "final"]
    assert finals and finals[-1]["state"] == "incomplete"
    # Reprenable : le record existe, avec le delta du run.
    rec = task_tool._RESUME_STORE[("u", out["task_id"])]
    assert any(m.get("role") == "tool" for m in rec["messages"])


@pytest.mark.asyncio
async def test_arret_sur_borne_sans_travail_pas_de_task_id(monkeypatch):
    """Sans travail partiel reprenable, pas de consigne de reprise."""
    runner = FakeRunner(final_text="",
                        metrics={"input_tokens": 1, "output_tokens": 1,
                                 "tool_limit_reached": True,
                                 "tool_limit_stop_reason": "wallclock"})
    handler, _ = _factory(monkeypatch, runner)
    out = json.loads(await handler({"subagent_type": "explore", "prompt": "p", "description": "d"}))
    assert out["error"] == "task_incomplete" and out["stop_reason"] == "wallclock"
    assert "task_id" not in out and "next_action" not in out
