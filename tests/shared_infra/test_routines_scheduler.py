# SPDX-License-Identifier: MIT
"""
tests/shared_infra/test_routines_scheduler.py — admission/lancement + exécuteur.

On teste l'unité ``launch_run`` (admission cap → task / skip) et les gardes de
``execute_routine_run`` (user supprimé, exception journalisée), sans appel LLM
réel (stubs). ``asyncio_mode=auto`` → les tests async tournent directement.
"""
from __future__ import annotations

import asyncio
import contextlib

import pytest

import shared_infra.scheduling.routines_scheduler as S


_ROUTINE = {"id": 1, "owner_user_id": 1, "model": None, "system_prompt": "",
            "task_prompt": "do it", "mcp_snapshot": [], "thinking_mode": False,
            "enabled": True}


async def test_launch_run_cap_skip(monkeypatch):
    calls = {}
    monkeypatch.setattr(S, "admit_and_insert_run", lambda *a, **k: None)
    monkeypatch.setattr(S, "insert_skipped_run",
                        lambda rid, uid, **k: calls.setdefault("skip", (rid, uid, k)))
    # ne doit jamais exécuter
    async def _boom(*a, **k):
        raise AssertionError("execute_routine_run ne doit pas être appelé")
    monkeypatch.setattr(S, "execute_routine_run", _boom)

    out = await S.launch_run(_ROUTINE, trigger="schedule")
    assert out is None
    assert "skip" in calls


async def test_launch_run_success_spawns_task(monkeypatch):
    monkeypatch.setattr(S, "admit_and_insert_run", lambda *a, **k: 77)
    ran = {}
    async def _exec(routine, run_id, context=None, chain_depth=0, trigger="schedule"):
        ran["run_id"] = run_id
        ran["context"] = context
        ran["depth"] = chain_depth
        ran["trigger"] = trigger
    monkeypatch.setattr(S, "execute_routine_run", _exec)

    out = await S.launch_run(_ROUTINE, trigger="manual")
    assert out == 77
    await asyncio.sleep(0.05)   # laisse la task tourner
    assert ran.get("run_id") == 77
    # Le déclencheur descend jusqu'à l'exécuteur : c'est lui qui étiquette la
    # conso du run (« routine » vs « webhook ») dans le registre d'usage.
    assert ran.get("trigger") == "manual"


async def test_executor_user_deleted(monkeypatch):
    import shared_infra.db as db
    monkeypatch.setattr("shared_infra.accounts.users.get_username_by_id", lambda uid: None)
    marks = {}
    monkeypatch.setattr(S, "mark_run_error",
                        lambda run_id, **k: marks.setdefault("err", (run_id, k)))
    monkeypatch.setattr(S, "mark_run_ok",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("pas ok")))

    await S.execute_routine_run(dict(_ROUTINE), 5)
    assert marks["err"][0] == 5
    assert "introuvable" in marks["err"][1]["error"]


async def test_executor_reglages_illisibles_echec_explicite(monkeypatch):
    """(2026-09-21, M4) Des réglages illisibles faisaient tourner le run avec
    ``{}`` (sans secrets, mémoire ni agents) et il pouvait finir « ok »."""
    monkeypatch.setattr("shared_infra.accounts.users.get_username_by_id", lambda uid: "alice")
    monkeypatch.setattr(S, "get_routine_internal", lambda rid: dict(_ROUTINE))
    appels = []

    def _illisible(uid):
        appels.append(uid)
        raise RuntimeError("database is locked")
    monkeypatch.setattr("shared_infra.accounts.users.get_user_settings", _illisible)
    marks = {}
    monkeypatch.setattr(S, "mark_run_error",
                        lambda run_id, **k: marks.setdefault("err", (run_id, k)))
    monkeypatch.setattr(S, "mark_run_ok",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("pas ok")))

    async def _vite(_d):
        return None
    monkeypatch.setattr(S.asyncio, "sleep", _vite)
    await S.execute_routine_run(dict(_ROUTINE), 7)
    assert len(appels) == 3                       # deux relectures
    assert marks["err"][0] == 7 and "illisibles" in marks["err"][1]["error"]


async def test_executor_happy_path(monkeypatch):
    import shared_infra.db as db
    monkeypatch.setattr("shared_infra.accounts.users.get_username_by_id", lambda uid: "alice")
    monkeypatch.setattr("shared_infra.accounts.users.get_user_settings", lambda uid: {})
    monkeypatch.setattr(S, "get_routine_internal", lambda rid: dict(_ROUTINE))

    import llm_core
    monkeypatch.setattr(llm_core, "resolve_scheduling_mode", lambda: "classic")

    @contextlib.asynccontextmanager
    async def _fake_guard(model, use_mcp_path, priority="high"):
        assert priority == "low"          # les routines cèdent le pas
        yield

    async def _fake_run(messages, **kwargs):
        assert kwargs.get("priority") == "low"
        assert kwargs.get("on_event") is None
        return ("résultat de la tâche", [], {"input_tokens": 4, "output_tokens": 9,
                                              "tool_limit_reached": False})

    monkeypatch.setattr(llm_core, "llm_scheduling_guard", _fake_guard)
    monkeypatch.setattr(llm_core, "run_chat_multi_mcp", _fake_run)

    captured = {}
    monkeypatch.setattr(S, "mark_run_ok",
                        lambda run_id, **k: captured.setdefault("ok", (run_id, k)))
    monkeypatch.setattr(S, "mark_run_error",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("pas d'erreur")))
    monkeypatch.setattr(S, "heartbeat_run", lambda rid: True)
    # Capture la notif (et évite d'écrire dans la VRAIE DB depuis les tests).
    notifs = []
    monkeypatch.setattr(S, "_emit_run_notification",
                        lambda uid, rid, name, *, ok, detail: notifs.append((uid, rid, ok)))

    await S.execute_routine_run(dict(_ROUTINE), 9)
    assert captured["ok"][0] == 9
    assert captured["ok"][1]["output_tokens"] == 9
    assert "résultat" in captured["ok"][1]["summary"]
    assert notifs == [(1, 1, True)]   # transition 'running'→'ok' → notif émise


def _patch_happy_llm(monkeypatch, captured_messages):
    """Stubs communs du chemin heureux : guard + run qui capture ``messages``."""
    import llm_core
    monkeypatch.setattr(llm_core, "resolve_scheduling_mode", lambda: "classic")

    @contextlib.asynccontextmanager
    async def _fake_guard(model, use_mcp_path, priority="high"):
        yield

    async def _fake_run(messages, **kwargs):
        captured_messages.extend(messages)
        return ("ok", [], {"input_tokens": 1, "output_tokens": 1,
                           "tool_limit_reached": False})

    monkeypatch.setattr(llm_core, "llm_scheduling_guard", _fake_guard)
    monkeypatch.setattr(llm_core, "run_chat_multi_mcp", _fake_run)
    monkeypatch.setattr(S, "heartbeat_run", lambda rid: True)
    monkeypatch.setattr(S, "mark_run_ok", lambda run_id, **k: True)
    monkeypatch.setattr(S, "mark_run_error",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("pas d'erreur")))
    monkeypatch.setattr(S, "_emit_run_notification", lambda *a, **k: None)


async def test_executor_injects_attached_skills(monkeypatch):
    """Routine avec skills : le bloc construit est APPENDU au system prompt."""
    import shared_infra.db as db
    monkeypatch.setattr("shared_infra.accounts.users.get_username_by_id", lambda uid: "alice")
    monkeypatch.setattr("shared_infra.accounts.users.get_user_settings", lambda uid: {})
    routine = dict(_ROUTINE, system_prompt="SYS-BASE", skills=["jenkins/deploy"])
    monkeypatch.setattr(S, "get_routine_internal", lambda rid: dict(routine))

    import llm_core._system_prompts as sp
    seen = {}

    def _fake_block(uid, ids):
        seen["args"] = (uid, list(ids))
        return "# Skills (procédures à appliquer)\n\nBLOC-SKILL"
    monkeypatch.setattr(sp, "build_attached_skills_block", _fake_block)

    msgs = []
    _patch_happy_llm(monkeypatch, msgs)
    await S.execute_routine_run(dict(routine), 31)

    assert seen["args"] == (1, ["jenkins/deploy"])
    assert msgs[0]["role"] == "system"
    assert "SYS-BASE" in msgs[0]["content"] and "BLOC-SKILL" in msgs[0]["content"]
    assert msgs[0]["content"].index("SYS-BASE") < msgs[0]["content"].index("BLOC-SKILL")
    assert msgs[1] == {"role": "user", "content": "do it"}


async def test_executor_skills_without_system_prompt(monkeypatch):
    """Pas de system prompt : le bloc skills DEVIENT le message système."""
    import shared_infra.db as db
    monkeypatch.setattr("shared_infra.accounts.users.get_username_by_id", lambda uid: "alice")
    monkeypatch.setattr("shared_infra.accounts.users.get_user_settings", lambda uid: {})
    routine = dict(_ROUTINE, skills=["veille"])
    monkeypatch.setattr(S, "get_routine_internal", lambda rid: dict(routine))

    import llm_core._system_prompts as sp
    monkeypatch.setattr(sp, "build_attached_skills_block",
                        lambda uid, ids: "BLOC-SEUL")

    msgs = []
    _patch_happy_llm(monkeypatch, msgs)
    await S.execute_routine_run(dict(routine), 32)

    assert msgs[0] == {"role": "system", "content": "BLOC-SEUL"}
    assert msgs[1]["role"] == "user"


async def test_executor_skills_block_failure_is_best_effort(monkeypatch):
    """Construction du bloc en échec → le run continue SANS skills (pas d'erreur)."""
    import shared_infra.db as db
    monkeypatch.setattr("shared_infra.accounts.users.get_username_by_id", lambda uid: "alice")
    monkeypatch.setattr("shared_infra.accounts.users.get_user_settings", lambda uid: {})
    routine = dict(_ROUTINE, skills=["veille"])
    monkeypatch.setattr(S, "get_routine_internal", lambda rid: dict(routine))

    import llm_core._system_prompts as sp

    def _boom(uid, ids):
        raise RuntimeError("disque illisible")
    monkeypatch.setattr(sp, "build_attached_skills_block", _boom)

    msgs = []
    _patch_happy_llm(monkeypatch, msgs)
    await S.execute_routine_run(dict(routine), 33)

    # Pas de message système injecté ; le run est allé au bout.
    assert msgs[0]["role"] == "user" and msgs[0]["content"] == "do it"


async def test_executor_no_skills_no_block_call(monkeypatch):
    """Sans skills, on ne tente même pas la construction du bloc."""
    import shared_infra.db as db
    monkeypatch.setattr("shared_infra.accounts.users.get_username_by_id", lambda uid: "alice")
    monkeypatch.setattr("shared_infra.accounts.users.get_user_settings", lambda uid: {})
    monkeypatch.setattr(S, "get_routine_internal", lambda rid: dict(_ROUTINE))

    import llm_core._system_prompts as sp
    monkeypatch.setattr(sp, "build_attached_skills_block",
                        lambda *a: (_ for _ in ()).throw(AssertionError("ne doit pas être appelé")))

    msgs = []
    _patch_happy_llm(monkeypatch, msgs)
    await S.execute_routine_run(dict(_ROUTINE), 34)
    assert msgs[0]["role"] == "user"


async def test_executor_summary_strips_thinking(monkeypatch):
    """Thinking actif : la boucle peut renvoyer le texte brut AVEC <think>…
    (contenu visible vide côté streaming). Le journal ne doit garder que la
    partie visible — sinon markup illisible tronqué à 4000 dans l'UI."""
    import shared_infra.db as db
    monkeypatch.setattr("shared_infra.accounts.users.get_username_by_id", lambda uid: "alice")
    monkeypatch.setattr("shared_infra.accounts.users.get_user_settings", lambda uid: {})
    routine = dict(_ROUTINE, thinking_mode=True)
    monkeypatch.setattr(S, "get_routine_internal", lambda rid: dict(routine))

    import llm_core
    monkeypatch.setattr(llm_core, "resolve_scheduling_mode", lambda: "classic")

    @contextlib.asynccontextmanager
    async def _fake_guard(model, use_mcp_path, priority="high"):
        yield

    async def _fake_run(messages, **kwargs):
        return ("<think>long raisonnement interne…</think>La réponse utile.",
                [], {"input_tokens": 1, "output_tokens": 1, "tool_limit_reached": False})

    monkeypatch.setattr(llm_core, "llm_scheduling_guard", _fake_guard)
    monkeypatch.setattr(llm_core, "run_chat_multi_mcp", _fake_run)
    monkeypatch.setattr(S, "heartbeat_run", lambda rid: True)
    monkeypatch.setattr(S, "_emit_run_notification", lambda *a, **k: None)

    captured = {}
    monkeypatch.setattr(S, "mark_run_ok",
                        lambda run_id, **k: captured.setdefault("ok", (run_id, k)) or True)
    monkeypatch.setattr(S, "mark_run_error",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("pas d'erreur")))

    await S.execute_routine_run(dict(routine), 41)
    assert captured["ok"][1]["summary"] == "La réponse utile."


async def test_executor_summary_pure_thinking_empty(monkeypatch):
    """Réponse 100 % raisonnement (aucun contenu visible) → summary vide
    (l'UI affiche son état « aucune réponse enregistrée »)."""
    import shared_infra.db as db
    monkeypatch.setattr("shared_infra.accounts.users.get_username_by_id", lambda uid: "alice")
    monkeypatch.setattr("shared_infra.accounts.users.get_user_settings", lambda uid: {})
    routine = dict(_ROUTINE, thinking_mode=True)
    monkeypatch.setattr(S, "get_routine_internal", lambda rid: dict(routine))

    import llm_core
    monkeypatch.setattr(llm_core, "resolve_scheduling_mode", lambda: "classic")

    @contextlib.asynccontextmanager
    async def _fake_guard(model, use_mcp_path, priority="high"):
        yield

    async def _fake_run(messages, **kwargs):
        return ("<think>que du raisonnement, pas de réponse</think>",
                [], {"input_tokens": 1, "output_tokens": 1, "tool_limit_reached": False})

    monkeypatch.setattr(llm_core, "llm_scheduling_guard", _fake_guard)
    monkeypatch.setattr(llm_core, "run_chat_multi_mcp", _fake_run)
    monkeypatch.setattr(S, "heartbeat_run", lambda rid: True)
    monkeypatch.setattr(S, "_emit_run_notification", lambda *a, **k: None)

    captured = {}
    monkeypatch.setattr(S, "mark_run_ok",
                        lambda run_id, **k: captured.setdefault("ok", (run_id, k)) or True)
    monkeypatch.setattr(S, "mark_run_error",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("pas d'erreur")))

    await S.execute_routine_run(dict(routine), 42)
    assert captured["ok"][1]["summary"] == ""


async def test_executor_exception_journaled(monkeypatch):
    import shared_infra.db as db
    monkeypatch.setattr("shared_infra.accounts.users.get_username_by_id", lambda uid: "alice")
    monkeypatch.setattr("shared_infra.accounts.users.get_user_settings", lambda uid: {})
    monkeypatch.setattr(S, "get_routine_internal", lambda rid: dict(_ROUTINE))

    import llm_core
    monkeypatch.setattr(llm_core, "resolve_scheduling_mode", lambda: "classic")

    @contextlib.asynccontextmanager
    async def _fake_guard(model, use_mcp_path, priority="high"):
        yield

    async def _boom(*a, **k):
        raise RuntimeError("llama down")

    monkeypatch.setattr(llm_core, "llm_scheduling_guard", _fake_guard)
    monkeypatch.setattr(llm_core, "run_chat_multi_mcp", _boom)
    monkeypatch.setattr(S, "heartbeat_run", lambda rid: True)

    marks = {}
    monkeypatch.setattr(S, "mark_run_error",
                        lambda run_id, **k: marks.setdefault("err", (run_id, k)))
    notifs = []
    monkeypatch.setattr(S, "_emit_run_notification",
                        lambda uid, rid, name, *, ok, detail: notifs.append((uid, rid, ok)))
    await S.execute_routine_run(dict(_ROUTINE), 11)
    assert marks["err"][0] == 11
    assert "llama down" in marks["err"][1]["error"]
    assert notifs == [(1, 1, False)]  # transition effectuée ICI → notif d'échec


async def test_executor_no_notif_when_already_finalized(monkeypatch):
    """Si mark_run_error ne transitionne PAS (run déjà 'ok'/'orphaned'), aucune
    notification ne doit partir — sinon on contredit le journal (ex. exception
    pendant l'émission de la notif OK au shutdown → fausse notif « en échec »)."""
    import shared_infra.db as db
    monkeypatch.setattr("shared_infra.accounts.users.get_username_by_id", lambda uid: "alice")
    monkeypatch.setattr("shared_infra.accounts.users.get_user_settings", lambda uid: {})
    monkeypatch.setattr(S, "get_routine_internal", lambda rid: dict(_ROUTINE))

    import llm_core
    monkeypatch.setattr(llm_core, "resolve_scheduling_mode", lambda: "classic")

    @contextlib.asynccontextmanager
    async def _fake_guard(model, use_mcp_path, priority="high"):
        yield

    async def _boom(*a, **k):
        raise RuntimeError("transport fermé")

    monkeypatch.setattr(llm_core, "llm_scheduling_guard", _fake_guard)
    monkeypatch.setattr(llm_core, "run_chat_multi_mcp", _boom)
    monkeypatch.setattr(S, "heartbeat_run", lambda rid: True)
    monkeypatch.setattr(S, "mark_run_error", lambda run_id, **k: False)  # déjà finalisé

    notifs = []
    monkeypatch.setattr(S, "_emit_run_notification",
                        lambda *a, **k: notifs.append((a, k)))
    await S.execute_routine_run(dict(_ROUTINE), 12)
    assert notifs == []


async def test_executor_cancelled_no_notification(monkeypatch):
    """Chemin shutdown : un run ANNULÉ (drain) journalise « annulé » et n'émet
    JAMAIS de notification — c'est le cœur du fix « mêmes notifs à chaque
    redémarrage »."""
    import shared_infra.db as db
    monkeypatch.setattr("shared_infra.accounts.users.get_username_by_id", lambda uid: "alice")
    monkeypatch.setattr("shared_infra.accounts.users.get_user_settings", lambda uid: {})
    monkeypatch.setattr(S, "get_routine_internal", lambda rid: dict(_ROUTINE))

    import llm_core
    monkeypatch.setattr(llm_core, "resolve_scheduling_mode", lambda: "classic")

    @contextlib.asynccontextmanager
    async def _fake_guard(model, use_mcp_path, priority="high"):
        yield

    started = asyncio.Event()

    async def _hang(*a, **k):
        started.set()
        await asyncio.Event().wait()   # bloque jusqu'au cancel

    monkeypatch.setattr(llm_core, "llm_scheduling_guard", _fake_guard)
    monkeypatch.setattr(llm_core, "run_chat_multi_mcp", _hang)
    monkeypatch.setattr(S, "heartbeat_run", lambda rid: True)

    marks = {}
    monkeypatch.setattr(S, "mark_run_error",
                        lambda run_id, **k: marks.setdefault("err", (run_id, k)))
    notifs = []
    monkeypatch.setattr(S, "_emit_run_notification",
                        lambda *a, **k: notifs.append((a, k)))

    task = asyncio.get_running_loop().create_task(S.execute_routine_run(dict(_ROUTINE), 21))
    await asyncio.wait_for(started.wait(), 2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert marks["err"][0] == 21
    assert "annulé" in marks["err"][1]["error"]
    assert notifs == []


async def test_executor_user_stop_marks_cancelled(monkeypatch):
    """Stop UTILISATEUR (bouton Arrêter) : flag posé sous la clé synthétique
    ``run_chat_key`` + CancelledError → ``mark_run_cancelled`` (statut terminal
    dédié — pas « Échec » rouge pour un geste délibéré), aucune notification,
    task ENREGISTRÉE dans le registre pendant le run (annulation dure) puis
    purgée avec le flag (pas de fuite _cancelled_chats)."""
    import shared_infra.db as db
    monkeypatch.setattr("shared_infra.accounts.users.get_username_by_id", lambda uid: "alice")
    monkeypatch.setattr("shared_infra.accounts.users.get_user_settings", lambda uid: {})
    monkeypatch.setattr(S, "get_routine_internal", lambda rid: dict(_ROUTINE))

    import llm_core
    monkeypatch.setattr(llm_core, "resolve_scheduling_mode", lambda: "classic")

    @contextlib.asynccontextmanager
    async def _fake_guard(model, use_mcp_path, priority="high"):
        yield

    import shared_infra.routes._state as st
    monkeypatch.setattr(st, "_publish_cancel", lambda *a, **k: None)  # pas de bus
    key = S.run_chat_key(1, 42)
    seen = {}

    async def _fake_run(messages, **kwargs):
        # Pendant le run, la task est trouvable sous la clé — c'est ce qui
        # permet au tailer cancel_bus de faire task.cancel() cross-worker.
        seen["registered"] = st.get_active_chat_task(1, key) is asyncio.current_task()
        st.mark_chat_cancelled(1, key)      # le Stop arrive pendant le run
        raise asyncio.CancelledError("User cancelled")

    monkeypatch.setattr(llm_core, "llm_scheduling_guard", _fake_guard)
    monkeypatch.setattr(llm_core, "run_chat_multi_mcp", _fake_run)
    monkeypatch.setattr(S, "heartbeat_run", lambda rid: True)

    marks = {}
    monkeypatch.setattr(S, "mark_run_cancelled",
                        lambda run_id, **k: bool(marks.setdefault("cancelled", run_id)))
    monkeypatch.setattr(S, "mark_run_error",
                        lambda *a, **k: (_ for _ in ()).throw(
                            AssertionError("stop user ≠ status 'error'")))
    monkeypatch.setattr(S, "_emit_run_notification",
                        lambda *a, **k: (_ for _ in ()).throw(
                            AssertionError("pas de notif pour un stop")))

    with pytest.raises(asyncio.CancelledError):
        await S.execute_routine_run(dict(_ROUTINE), 42)
    assert marks.get("cancelled") == 42
    assert seen.get("registered") is True
    # finally : registre ET flag purgés.
    assert st.get_active_chat_task(1, key) is None
    assert st.is_chat_cancelled(1, key) is False


async def test_fire_chained_routines(monkeypatch):
    """Enchaînement à la Jenkins : condition (ok/error/always), cloisonnement
    par owner, contexte amont joint, profondeur max → run 'skipped'."""
    downstream = [
        {"id": 21, "owner_user_id": 1, "name": "B-ok", "trigger_after_on": "ok"},
        {"id": 22, "owner_user_id": 1, "name": "B-err", "trigger_after_on": "error"},
        {"id": 23, "owner_user_id": 1, "name": "B-always", "trigger_after_on": "always"},
        {"id": 24, "owner_user_id": 2, "name": "intrus", "trigger_after_on": "ok"},
    ]
    monkeypatch.setattr(S, "list_chained_routines", lambda rid: list(downstream))
    launched = []

    async def _fake_launch(routine, *, trigger, context=None, chain_depth=0):
        launched.append({"id": routine["id"], "trigger": trigger,
                         "context": context, "depth": chain_depth})
        return 500 + routine["id"]

    monkeypatch.setattr(S, "launch_run", _fake_launch)
    upstream = {"id": 7, "owner_user_id": 1, "name": "A"}

    await S._fire_chained_routines(upstream, 99, status="ok",
                                   summary="tout est vert", chain_depth=0)
    assert sorted(x["id"] for x in launched) == [21, 23]   # ok + always ; owner 2 exclu
    assert all(x["trigger"] == "chain" and x["depth"] == 1 for x in launched)
    assert "routine amont : A (run #99)" in launched[0]["context"]
    assert "tout est vert" in launched[0]["context"]

    launched.clear()
    await S._fire_chained_routines(upstream, 100, status="error", chain_depth=0)
    assert sorted(x["id"] for x in launched) == [22, 23]   # error + always

    # Profondeur max : rien ne part, un run 'skipped' est journalisé par aval.
    launched.clear()
    skipped = []
    monkeypatch.setattr(S, "insert_skipped_run",
                        lambda rid, uid, **k: skipped.append((rid, k.get("reason"))))
    await S._fire_chained_routines(upstream, 101, status="ok",
                                   chain_depth=S.CHAIN_MAX_DEPTH)
    assert launched == []
    assert [s[0] for s in skipped] == [21, 23]
    assert all("profondeur" in s[1] for s in skipped)


async def test_executor_fires_chain_on_ok(monkeypatch):
    """Le chemin heureux de l'exécuteur propage l'enchaînement (status=ok,
    chain_depth transmis)."""
    import shared_infra.db as db
    monkeypatch.setattr("shared_infra.accounts.users.get_username_by_id", lambda uid: "alice")
    monkeypatch.setattr("shared_infra.accounts.users.get_user_settings", lambda uid: {})
    monkeypatch.setattr(S, "get_routine_internal", lambda rid: dict(_ROUTINE))
    captured_msgs = []
    _patch_happy_llm(monkeypatch, captured_msgs)
    fired = []

    async def _fake_fire(routine, run_id, *, status, summary="", chain_depth=0):
        fired.append({"run_id": run_id, "status": status, "depth": chain_depth})

    monkeypatch.setattr(S, "_fire_chained_routines", _fake_fire)
    await S.execute_routine_run(dict(_ROUTINE), 33, chain_depth=2)
    assert fired == [{"run_id": 33, "status": "ok", "depth": 2}]


async def test_drain_running_runs_cancels_and_waits():
    """drain_running_runs annule les runs actifs et attend leur fin (le
    done_callback posé par launch_run purge _running_tasks)."""
    S._running_tasks.clear()
    cancelled = {}

    async def _run():
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled["yes"] = True
            raise

    t = asyncio.get_running_loop().create_task(_run())
    S._running_tasks[101] = t
    t.add_done_callback(lambda _t: S._running_tasks.pop(101, None))
    await asyncio.sleep(0.01)

    n = await S.drain_running_runs(timeout=2)
    assert n == 1
    assert cancelled.get("yes") is True
    assert not S._running_tasks
    assert await S.drain_running_runs() == 0   # vide → no-op


async def test_evaluate_due_skips_when_llm_down(monkeypatch):
    """Health-gate : LLM injoignable (fenêtre de boot VM) → 'skipped' journalisé,
    PAS de run lancé (donc pas de notif « en échec » à chaque redémarrage)."""
    monkeypatch.setattr(S, "claim_minute_fire", lambda rid, mk: True)

    async def _down():
        return False
    monkeypatch.setattr(S, "_llm_reachable", _down)

    skips, launched = [], []
    monkeypatch.setattr(S, "insert_skipped_run",
                        lambda rid, uid, **k: skips.append((rid, uid, k)) or 1)

    async def _launch(r, *, trigger):
        launched.append((r["id"], trigger))
    monkeypatch.setattr(S, "launch_run", _launch)

    from datetime import datetime as _dt
    r = dict(_ROUTINE)
    r["cron_expr"] = "* * * * *"
    await S._evaluate_due_routines([r], _dt.now(), "2026-06-12T10:00")
    assert len(skips) == 1 and skips[0][0] == 1
    assert "LLM injoignable" in skips[0][2]["reason"]
    assert launched == []


async def test_evaluate_due_launches_when_llm_up(monkeypatch):
    monkeypatch.setattr(S, "claim_minute_fire", lambda rid, mk: True)

    async def _up():
        return True
    monkeypatch.setattr(S, "_llm_reachable", _up)

    skips, launched = [], []
    monkeypatch.setattr(S, "insert_skipped_run",
                        lambda rid, uid, **k: skips.append((rid, uid, k)) or 1)

    async def _launch(r, *, trigger):
        launched.append((r["id"], trigger))
    monkeypatch.setattr(S, "launch_run", _launch)

    from datetime import datetime as _dt
    r = dict(_ROUTINE)
    r["cron_expr"] = "* * * * *"
    await S._evaluate_due_routines([r], _dt.now(), "2026-06-12T10:01")
    assert launched == [(1, "schedule")]
    assert skips == []


# ── Reprise auto bornée sur échec transitoire (fiabilité) ─────────────────────
def _patch_executor_env(monkeypatch):
    """Mocks communs DB/notif/heartbeat pour piloter execute_routine_run."""
    import shared_infra.db as db
    monkeypatch.setattr("shared_infra.accounts.users.get_username_by_id", lambda uid: "alice")
    monkeypatch.setattr("shared_infra.accounts.users.get_user_settings", lambda uid: {})
    monkeypatch.setattr(S, "get_routine_internal", lambda rid: dict(_ROUTINE))
    monkeypatch.setattr(S, "heartbeat_run", lambda rid: True)

    import llm_core
    monkeypatch.setattr(llm_core, "resolve_scheduling_mode", lambda: "classic")

    @contextlib.asynccontextmanager
    async def _fake_guard(model, use_mcp_path, priority="high"):
        yield
    monkeypatch.setattr(llm_core, "llm_scheduling_guard", _fake_guard)
    return llm_core


async def test_executor_retries_transient_failure_then_succeeds(monkeypatch):
    # 1re tentative : exception transitoire (LLM injoignable). 2e : succès.
    # Le run doit finir 'ok' — la reprise auto a rattrapé la coupure.
    monkeypatch.setattr(S, "RUN_RETRY_BACKOFF_S", 0.0)   # pas d'attente en test
    monkeypatch.setattr(S, "RUN_MAX_ATTEMPTS", 2)
    llm_core = _patch_executor_env(monkeypatch)

    calls = {"n": 0}

    async def _flaky_run(messages, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("LLM inaccessible après 2 tentatives")
        return ("ok après reprise", [], {"input_tokens": 1, "output_tokens": 2})

    monkeypatch.setattr(llm_core, "run_chat_multi_mcp", _flaky_run)

    ok = {}
    monkeypatch.setattr(S, "mark_run_ok", lambda run_id, **k: ok.setdefault("run", run_id) or True)
    monkeypatch.setattr(S, "mark_run_error",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("ne doit pas marquer error")))
    monkeypatch.setattr(S, "_emit_run_notification", lambda *a, **k: None)

    await S.execute_routine_run(dict(_ROUTINE), 42)
    assert calls["n"] == 2          # une reprise a bien eu lieu
    assert ok["run"] == 42


async def test_executor_gives_up_after_max_attempts(monkeypatch):
    # Échec persistant : après RUN_MAX_ATTEMPTS, on journalise l'erreur (1 fois)
    # et on émet la notif d'échec.
    monkeypatch.setattr(S, "RUN_RETRY_BACKOFF_S", 0.0)
    monkeypatch.setattr(S, "RUN_MAX_ATTEMPTS", 2)
    llm_core = _patch_executor_env(monkeypatch)

    calls = {"n": 0}

    async def _always_fail(messages, **kwargs):
        calls["n"] += 1
        raise RuntimeError("backend HS")

    monkeypatch.setattr(llm_core, "run_chat_multi_mcp", _always_fail)

    errors, notifs = [], []
    monkeypatch.setattr(S, "mark_run_ok",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("pas de succès")))
    monkeypatch.setattr(S, "mark_run_error", lambda run_id, **k: errors.append(run_id) or True)
    monkeypatch.setattr(S, "_emit_run_notification",
                        lambda uid, rid, name, *, ok, detail: notifs.append(ok))

    await S.execute_routine_run(dict(_ROUTINE), 7)
    assert calls["n"] == 2          # 1 essai + 1 reprise, puis abandon
    assert errors == [7]            # erreur journalisée UNE fois
    assert notifs == [False]        # notif d'échec émise


async def test_retry_user_stop_marks_cancelled_no_chain(monkeypatch):
    """Régression (audit 2026-08-04) : stop UTILISATEUR entre un échec
    transitoire et la reprise (fenêtre du backoff) → 'cancelled', pas 'error' —
    et surtout AUCUNE chaîne aval déclenchée, aucune notif d'échec. Avant, le
    ``raise`` de la boucle de reprise relançait l'exception ORDINAIRE →
    ``except Exception`` → mark_run_error + _fire_chained_routines(error)."""
    monkeypatch.setattr(S, "RUN_RETRY_BACKOFF_S", 0.0)
    monkeypatch.setattr(S, "RUN_MAX_ATTEMPTS", 3)
    llm_core = _patch_executor_env(monkeypatch)

    import shared_infra.routes._state as st
    monkeypatch.setattr(st, "_publish_cancel", lambda *a, **k: None)  # pas de bus

    async def _fail_with_stop(messages, **kwargs):
        # Le Stop arrive PENDANT la 1re tentative, qui échoue en 5xx transitoire.
        st.mark_chat_cancelled(1, S.run_chat_key(1, 42))
        raise RuntimeError("5xx transitoire")

    monkeypatch.setattr(llm_core, "run_chat_multi_mcp", _fail_with_stop)

    cancelled, chained = [], []
    monkeypatch.setattr(S, "mark_run_cancelled",
                        lambda run_id, **k: cancelled.append(run_id) or True)
    monkeypatch.setattr(S, "mark_run_error",
                        lambda *a, **k: (_ for _ in ()).throw(
                            AssertionError("stop user ≠ status 'error'")))
    monkeypatch.setattr(S, "_emit_run_notification",
                        lambda *a, **k: (_ for _ in ()).throw(
                            AssertionError("pas de notif pour un stop")))

    async def _no_chain(*a, **k):
        chained.append(a)
    monkeypatch.setattr(S, "_fire_chained_routines", _no_chain)

    with contextlib.suppress(asyncio.CancelledError):
        await S.execute_routine_run(dict(_ROUTINE), 42)
    assert cancelled == [42]
    assert chained == []


# ── Fichiers produits par un run ────────────────────────────────────────────
# Le journal ne portait que du texte : pour retrouver ce qu'une routine avait
# ÉCRIT il fallait ouvrir l'éditeur et deviner. La 2e valeur de retour de la
# boucle d'outils consigne désormais les mutations de fichiers ; le scheduler
# les persiste sur le run.

def test_files_written_keeps_order_and_drops_failures():
    events = [
        {"type": "tool_result", "name": "write_file", "path": "/work/rapport.md", "ok": True},
        {"type": "tool_result", "name": "write_file", "path": "/work/raté.md",    "ok": False},
        {"type": "tool_result", "name": "edit_file",  "path": "/work/rapport.md", "ok": True},
        {"type": "tool_result", "name": "read_file",  "ok": True},          # sans path
        {"type": "tool_call",   "name": "write_file", "path": "/work/x.md"},  # pas un résultat
        {"type": "tool_result", "name": "edit_file",  "path": "/work/notes.md", "ok": True},
    ]
    # ordre d'écriture conservé, doublon fusionné, échec écarté
    assert S._files_written(events) == ["/work/rapport.md", "/work/notes.md"]


def test_files_written_tolerates_garbage():
    assert S._files_written(None) == []
    assert S._files_written([]) == []
    assert S._files_written(["pas un dict", {"type": "tool_result", "path": 42}]) == []


async def test_executor_persists_produced_files(monkeypatch):
    llm_core = _patch_executor_env(monkeypatch)

    async def _run(messages, **kwargs):
        # la boucle NE reçoit PAS d'on_event en headless (cf. _files_written) :
        # les mutations ne peuvent venir que de la valeur de retour.
        assert kwargs.get("on_event") is None
        return ("fait", [
            {"type": "tool_result", "name": "write_file", "path": "/work/out.csv", "ok": True},
        ], {"input_tokens": 3, "output_tokens": 4})

    monkeypatch.setattr(llm_core, "run_chat_multi_mcp", _run)

    seen = {}
    monkeypatch.setattr(S, "mark_run_ok",
                        lambda run_id, **k: seen.update(k) or True)
    monkeypatch.setattr(S, "_emit_run_notification", lambda *a, **k: None)

    await S.execute_routine_run(dict(_ROUTINE), 5)
    assert seen["files"] == ["/work/out.csv"]


# ── Sous-agents : opt-in PAR ROUTINE (2026-08-07) ───────────────────────────

def _agents_env(monkeypatch, captured_kwargs):
    """Chemin heureux + capture des kwargs passés au runner."""
    import llm_core
    import shared_infra.db as db
    monkeypatch.setattr("shared_infra.accounts.users.get_username_by_id", lambda uid: "alice")
    monkeypatch.setattr("shared_infra.accounts.users.get_user_settings", lambda uid: {})
    monkeypatch.setattr(llm_core, "resolve_scheduling_mode", lambda: "classic")

    @contextlib.asynccontextmanager
    async def _fake_guard(model, use_mcp_path, priority="high"):
        yield

    async def _fake_run(messages, **kwargs):
        captured_kwargs.update(kwargs)
        return ("ok", [], {"input_tokens": 3, "output_tokens": 5,
                           "tool_limit_reached": False})

    monkeypatch.setattr(llm_core, "llm_scheduling_guard", _fake_guard)
    monkeypatch.setattr(llm_core, "run_chat_multi_mcp", _fake_run)
    monkeypatch.setattr(S, "heartbeat_run", lambda rid: True)
    monkeypatch.setattr(S, "mark_run_error",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("pas d'erreur")))
    monkeypatch.setattr(S, "_emit_run_notification", lambda *a, **k: None)


async def test_routine_sans_optin_na_pas_loutil_task(monkeypatch):
    """Défaut : un run headless ne délègue pas. L'outil ``task`` n'existe même
    pas dans sa surface — pas de capacité annoncée puis refusée."""
    kw = {}
    _agents_env(monkeypatch, kw)
    routine = dict(_ROUTINE, agents_enabled=False)
    monkeypatch.setattr(S, "get_routine_internal", lambda rid: dict(routine))
    monkeypatch.setattr(S, "mark_run_ok", lambda run_id, **k: True)

    await S.execute_routine_run(dict(routine), 11)
    assert kw.get("builtin_tools") is None


async def test_routine_avec_optin_recoit_loutil_task(monkeypatch):
    """Opt-in coché dans l'onglet Agents → le builtin ``task`` est câblé, avec
    le ``is_cancelled`` de la routine (stopper le run tue aussi ses enfants)."""
    kw = {}
    _agents_env(monkeypatch, kw)
    routine = dict(_ROUTINE, agents_enabled=True)
    monkeypatch.setattr(S, "get_routine_internal", lambda rid: dict(routine))
    monkeypatch.setattr(S, "mark_run_ok", lambda run_id, **k: True)

    await S.execute_routine_run(dict(routine), 12)
    bt = kw.get("builtin_tools") or {}
    assert "task" in bt and callable(bt["task"]["handler"])
    # Le roster annoncé au modèle est bien celui du casting intégré.
    from llm_core.tools.task_tool import _AGENTS
    enum = bt["task"]["definition"]["function"]["parameters"]["properties"]["subagent_type"]["enum"]
    assert enum == list(_AGENTS)


async def test_interrupteur_maitre_coupe_les_agents_de_routine(monkeypatch):
    """``AGENTS_ENABLED`` (instance) prime sur l'opt-in de la routine."""
    kw = {}
    _agents_env(monkeypatch, kw)
    import shared_infra.config as cfg
    monkeypatch.setattr(cfg, "AGENTS_ENABLED", False)
    routine = dict(_ROUTINE, agents_enabled=True)
    monkeypatch.setattr(S, "get_routine_internal", lambda rid: dict(routine))
    monkeypatch.setattr(S, "mark_run_ok", lambda run_id, **k: True)

    await S.execute_routine_run(dict(routine), 13)
    assert kw.get("builtin_tools") is None


async def test_tokens_des_sous_agents_comptes_dans_le_journal(monkeypatch):
    """Les enfants ont leurs PROPRES appels LLM : sans rollup, le journal
    n'affichait que le coût de l'orchestrateur."""
    kw = {}
    _agents_env(monkeypatch, kw)
    routine = dict(_ROUTINE, agents_enabled=True)
    monkeypatch.setattr(S, "get_routine_internal", lambda rid: dict(routine))
    captured = {}
    monkeypatch.setattr(S, "mark_run_ok",
                        lambda run_id, **k: captured.setdefault("ok", k) or True)

    # Le runner stubé simule un enfant qui a consommé, via le sink du builtin.
    import llm_core
    async def _run_with_child(messages, **kwargs):
        bt = kwargs.get("builtin_tools") or {}
        assert "task" in bt
        S_sink = _sink_of(bt["task"]["handler"])
        S_sink["input_tokens"] = S_sink.get("input_tokens", 0) + 100
        S_sink["output_tokens"] = S_sink.get("output_tokens", 0) + 40
        return ("ok", [], {"input_tokens": 3, "output_tokens": 5,
                           "tool_limit_reached": False})

    monkeypatch.setattr(llm_core, "run_chat_multi_mcp", _run_with_child)
    await S.execute_routine_run(dict(routine), 14)
    assert captured["ok"]["input_tokens"] == 103
    assert captured["ok"]["output_tokens"] == 45


def _closure_of(handler):
    """Les variables capturées par la closure du handler ``task``."""
    return dict(zip(handler.__code__.co_freevars,
                    (c.cell_contents for c in (handler.__closure__ or ()))))


def _sink_of(handler):
    """Le ``usage_sink`` capturé par la closure du handler ``task``."""
    return _closure_of(handler)["usage_sink"]


async def test_mode_de_scheduling_resolu_une_seule_fois(monkeypatch):
    """Le mode DOIT être le même pour le runner du parent et pour l'enfant.

    ``resolve_scheduling_mode`` lit la config VIVANTE : deux appels peuvent
    différer si un admin bascule le mode entre les deux. Le parent tiendrait
    alors le sémaphore pour tout le run (classic) pendant que l'enfant croirait
    devoir l'acquérir (optimized) → deadlock à LLAMA_MAX_CONCURRENCY=1 jusqu'au
    timeout de 30 min de l'enfant. Un seul appel, une seule vérité."""
    import llm_core
    kw = {}
    _agents_env(monkeypatch, kw)
    # Bascule à CHAQUE appel : si le code en fait deux, ils divergent.
    seq = iter(["classic", "optimized", "classic", "optimized"])
    calls = {"n": 0}

    def _flapping():
        calls["n"] += 1
        return next(seq)

    monkeypatch.setattr(llm_core, "resolve_scheduling_mode", _flapping)
    routine = dict(_ROUTINE, agents_enabled=True)
    monkeypatch.setattr(S, "get_routine_internal", lambda rid: dict(routine))
    monkeypatch.setattr(S, "mark_run_ok", lambda run_id, **k: True)

    await S.execute_routine_run(dict(routine), 15)
    assert calls["n"] == 1, "le mode doit être résolu UNE fois par run"
    child_mode = _closure_of((kw["builtin_tools"] or {})["task"]["handler"])["scheduling_mode"]
    assert child_mode == "classic"        # celui du runner effectivement choisi


async def test_ask_user_est_denie_dans_un_run_headless(monkeypatch):
    """``ask_user`` promet au modèle que la réponse arrive « dans le prochain
    message user » et lui dit de finir son tour tout de suite. Une routine n'a
    ni panneau ni message suivant : la capacité est structurellement morte, et
    l'exposer faisait terminer le run sur une question posée dans le vide.
    Même raison que le deny chez les sous-agents (``_DENY_BASE``)."""
    kw = {}
    _agents_env(monkeypatch, kw)
    monkeypatch.setattr(S, "get_routine_internal", lambda rid: dict(_ROUTINE))
    monkeypatch.setattr(S, "mark_run_ok", lambda run_id, **k: True)

    await S.execute_routine_run(dict(_ROUTINE), 16)
    assert "ask_user" in (kw.get("deny_tool_names") or set())


# ─────────────────────────────────────────────────────────────────────────────
#  Politique de notification PAR ROUTINE (2026-09-08) vue depuis l'exécuteur :
#  ``notify_on`` décide si ``_emit_run_notification`` est appelée du tout.
# ─────────────────────────────────────────────────────────────────────────────
def _patch_boom_llm(monkeypatch):
    import llm_core
    monkeypatch.setattr(llm_core, "resolve_scheduling_mode", lambda: "classic")

    @contextlib.asynccontextmanager
    async def _fake_guard(model, use_mcp_path, priority="high"):
        yield

    async def _boom(*a, **k):
        raise RuntimeError("llama down")

    monkeypatch.setattr(llm_core, "llm_scheduling_guard", _fake_guard)
    monkeypatch.setattr(llm_core, "run_chat_multi_mcp", _boom)
    monkeypatch.setattr(S, "heartbeat_run", lambda rid: True)
    monkeypatch.setattr(S, "mark_run_error", lambda run_id, **k: True)
    monkeypatch.setattr(S, "mark_run_ok",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("pas de succès")))


async def test_executor_notify_on_none_never_notifies(monkeypatch):
    monkeypatch.setattr("shared_infra.accounts.users.get_username_by_id", lambda uid: "alice")
    monkeypatch.setattr("shared_infra.accounts.users.get_user_settings", lambda uid: {})
    r = {**_ROUTINE, "notify_on": "none"}
    monkeypatch.setattr(S, "get_routine_internal", lambda rid: dict(r))
    _patch_happy_llm(monkeypatch, [])
    notifs = []
    monkeypatch.setattr(S, "_emit_run_notification",
                        lambda uid, rid, name, *, ok, detail: notifs.append(ok))
    await S.execute_routine_run(dict(r), 31)
    assert notifs == []
    # …y compris sur un échec.
    _patch_boom_llm(monkeypatch)
    await S.execute_routine_run(dict(r), 32)
    assert notifs == []


async def test_executor_notify_on_error_skips_success_reports_failure(monkeypatch):
    monkeypatch.setattr("shared_infra.accounts.users.get_username_by_id", lambda uid: "alice")
    monkeypatch.setattr("shared_infra.accounts.users.get_user_settings", lambda uid: {})
    r = {**_ROUTINE, "notify_on": "error"}
    monkeypatch.setattr(S, "get_routine_internal", lambda rid: dict(r))
    _patch_happy_llm(monkeypatch, [])
    notifs = []
    monkeypatch.setattr(S, "_emit_run_notification",
                        lambda uid, rid, name, *, ok, detail: notifs.append((rid, ok)))
    await S.execute_routine_run(dict(r), 33)
    assert notifs == []                                   # succès : silence
    _patch_boom_llm(monkeypatch)
    await S.execute_routine_run(dict(r), 34)
    assert notifs == [(1, False)]                         # échec : notifié


async def test_executor_notify_keep_prunes_after_emit(monkeypatch):
    """``notify_keep`` > 0 → purge par routine APRÈS l'émission (jamais avant :
    la nouvelle notif fait partie des X gardées)."""
    monkeypatch.setattr("shared_infra.accounts.users.get_username_by_id", lambda uid: "alice")
    monkeypatch.setattr("shared_infra.accounts.users.get_user_settings", lambda uid: {})
    r = {**_ROUTINE, "notify_keep": 3}
    monkeypatch.setattr(S, "get_routine_internal", lambda rid: dict(r))
    _patch_happy_llm(monkeypatch, [])
    order = []
    monkeypatch.setattr(S, "_emit_run_notification",
                        lambda uid, rid, name, *, ok, detail: order.append("emit"))
    import shared_infra.notifications.store as notif_store
    monkeypatch.setattr(notif_store, "prune_ref_notifications",
                        lambda uid, rt, rid, keep: order.append(("prune", uid, rt, rid, keep)) or 0)
    await S.execute_routine_run(dict(r), 35)
    assert order == ["emit", ("prune", 1, "routine", 1, 3)]
