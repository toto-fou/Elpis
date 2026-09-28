# SPDX-License-Identifier: MIT
"""tests/llm_core/test_tool_exec.py — harness d'exécution partagée (Phase 4).

``execute_tool_batch`` remplace les deux copies verbatim (canal natif +
legacy) de l'ordonnancement d'outils. Couvre :
- ordre : outils mutants (serial-prefix) exécutés un par un, outils sûrs
  batchés en parallèle, tous présents dans le résultat indexé ;
- annulation : CancelledError déclenche le snapshot puis se propage ;
- échec d'un outil isolé → enveloppe {"error"} (le gather ne casse pas) ;
- callbacks progress/log câblés quand ``emit_progress_log`` (le legacy en
  bénéficie désormais) ;
- métriques : statut error|ok classé via ``is_tool_failure``.
"""
from __future__ import annotations

import asyncio
import json

import pytest

from llm_core.engine.tool_exec import execute_tool_batch


def _prep(name, args=None, call_id="c"):
    return {"call_id": call_id, "tool_name": name, "final_args": args or {}, "meta": None}


async def _noop_snapshot():
    pass


def _base_kwargs(**over):
    d = dict(
        record_metric=lambda *a, **k: None,
        is_tool_failure=lambda r: False,
        on_event=None,
        username="u",
        chat_id="c1",
        on_cancel_snapshot=_noop_snapshot,
        iteration=0,
        emit_progress_log=False,
    )
    d.update(over)
    return d


@pytest.mark.asyncio
async def test_resultats_indexes_dans_l_ordre():
    async def _exec(name, args, *, meta=None, **kw):
        return json.dumps({"ok": True, "name": name})

    prepared = [_prep("read_file", call_id="a"), _prep("grep_search", call_id="b")]
    res = await execute_tool_batch(prepared, execute_single=_exec, **_base_kwargs())
    assert set(res.keys()) == {0, 1}
    assert json.loads(res[0])["name"] == "read_file"


@pytest.mark.asyncio
async def test_outils_mutants_serialises():
    """Deux write_file (serial-prefix) ne doivent JAMAIS tourner en parallèle
    (barrière de synchro : effets de bord FS). On le prouve par un compteur de
    concurrence."""
    live = {"cur": 0, "max": 0}

    async def _exec(name, args, *, meta=None, **kw):
        live["cur"] += 1
        live["max"] = max(live["max"], live["cur"])
        await asyncio.sleep(0.02)
        live["cur"] -= 1
        return json.dumps({"ok": True})

    prepared = [_prep("write_file", call_id=str(i)) for i in range(3)]
    await execute_tool_batch(prepared, execute_single=_exec, **_base_kwargs())
    assert live["max"] == 1                      # jamais 2 en vol


@pytest.mark.asyncio
async def test_outils_surs_batches_en_parallele():
    live = {"cur": 0, "max": 0}

    async def _exec(name, args, *, meta=None, **kw):
        live["cur"] += 1
        live["max"] = max(live["max"], live["cur"])
        await asyncio.sleep(0.02)
        live["cur"] -= 1
        return json.dumps({"ok": True})

    prepared = [_prep("read_file", call_id=str(i)) for i in range(3)]
    await execute_tool_batch(prepared, execute_single=_exec, **_base_kwargs())
    assert live["max"] >= 2                       # au moins 2 concurrents


@pytest.mark.asyncio
async def test_annulation_declenche_snapshot_et_propage():
    # Annulation RÉELLE (Stop utilisateur : flag ``is_cancelled`` armé) —
    # depuis l'audit cœur 2026-08-21, un CancelledError sans ce contexte est
    # traité comme une FUITE de cancel-scope MCP (tool-error, le run
    # continue) : cf. test_annulation_fuyante_contenue ci-dessous.
    snap = {"n": 0}

    async def _snap():
        snap["n"] += 1

    async def _exec(name, args, *, meta=None, **kw):
        raise asyncio.CancelledError()

    with pytest.raises(asyncio.CancelledError):
        await execute_tool_batch(
            [_prep("write_file")], execute_single=_exec,
            is_cancelled=lambda: True,
            **_base_kwargs(on_cancel_snapshot=_snap))
    assert snap["n"] == 1


@pytest.mark.asyncio
async def test_annulation_fuyante_contenue():
    # CancelledError FUI d'un cancel-scope anyio (aucun Stop utilisateur) :
    # converti en tool-error, pas de snapshot, pas de propagation.
    snap = {"n": 0}

    async def _snap():
        snap["n"] += 1

    async def _exec(name, args, *, meta=None, **kw):
        raise asyncio.CancelledError()

    res = await execute_tool_batch(
        [_prep("write_file")], execute_single=_exec,
        is_cancelled=lambda: False,
        **_base_kwargs(on_cancel_snapshot=_snap))
    assert snap["n"] == 0
    assert "error" in json.loads(res[0])


@pytest.mark.asyncio
async def test_echec_isole_enveloppe_erreur():
    async def _exec(name, args, *, meta=None, **kw):
        raise RuntimeError("boom")

    res = await execute_tool_batch([_prep("read_file")], execute_single=_exec,
                                   **_base_kwargs())
    assert json.loads(res[0])["error"].startswith("boom")


@pytest.mark.asyncio
async def test_callbacks_progress_log_cables_si_active():
    seen = {"progress": False, "log": False}

    async def _exec(name, args, *, meta=None, progress_callback=None, log_callback=None):
        assert progress_callback is not None and log_callback is not None
        seen["progress"] = seen["log"] = True
        return json.dumps({"ok": True})

    await execute_tool_batch([_prep("read_file")], execute_single=_exec,
                             **_base_kwargs(emit_progress_log=True))
    assert seen["progress"] and seen["log"]


@pytest.mark.asyncio
async def test_metrics_statut_via_is_tool_failure():
    recorded = []

    async def _exec(name, args, *, meta=None, **kw):
        return json.dumps({"ok": False, "error": "denied"})

    await execute_tool_batch(
        [_prep("write_file")], execute_single=_exec,
        **_base_kwargs(is_tool_failure=lambda r: True,
                       record_metric=lambda *a, **k: recorded.append(a)))
    assert recorded and recorded[0][3] == "error"   # (user, chat, tool, status)
