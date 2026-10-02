# SPDX-License-Identifier: MIT
"""tests/llm_core/test_diffs_chat_2026_09_26.py — audit « un diff dans tous
les cas » (2026-09-26), côté chat : liste ``files`` de l'event
``tool_result``, fusion par tour (``_fc_merge``) persistée sur le message,
vue MODÈLE compacte de ``files_changed``.
"""
from __future__ import annotations

# ── Event et fusion par tour ─────────────────────────────────────────────────

def test_event_files_write_et_commande():
    from llm_core.engine.tool_dispatch import _files_event_extra
    a, b = "a" * 64, "b" * 64
    ev = _files_event_extra('{"ok": true, "path": "/work/x.py", "old_sha256": "", '
                            '"new_sha256": "%s", "lines_added": 3, "lines_removed": 0}' % b)
    assert ev["files"] == [{"path": "/work/x.py", "change": "created", "before": None,
                            "after": b, "added": 3, "removed": 0}]
    ev = _files_event_extra('{"ok": true, "files_changed": [{"path": "/work/y", "change": '
                            '"modified", "old_sha256": "%s", "new_sha256": "%s"}]}' % (a, b))
    assert ev == {"files": [{"path": "/work/y", "change": "modified", "before": a, "after": b}]}
    noop = _files_event_extra('{"ok": true, "action": "noop", "path": "/work/x", '
                              '"old_sha256": "%s", "new_sha256": "%s"}' % (b, b))
    assert "files" not in noop


def test_fusion_par_tour():
    from chatbot_app.turn.history import _fc_merge
    a, b, c = "a" * 64, "b" * 64, "c" * 64
    acc = {}
    _fc_merge(acc, [{"path": "/work/f", "change": "modified", "before": a, "after": b,
                     "added": 1, "removed": 0}])
    _fc_merge(acc, [{"path": "/work/f", "change": "modified", "before": b, "after": c}])
    assert acc["/work/f"] == {"path": "/work/f", "change": "modified", "before": a, "after": c}
    _fc_merge(acc, [{"path": "/work/n", "change": "created", "before": None, "after": a}])
    _fc_merge(acc, [{"path": "/work/n", "change": "deleted", "before": a, "after": None}])
    assert "/work/n" not in acc
    _fc_merge(acc, [{"path": "../x", "change": "evil", "before": "zz"}])
    assert acc["../x"]["change"] == "modified" and acc["../x"]["before"] is None


def test_modele_voit_files_changed_compact():
    from llm_core.context.pruning import prepare_tool_result_for_model
    a = "a" * 64
    out = prepare_tool_result_for_model("execute_shell", (
        '{"ok": true, "stdout": "", "files_changed": [{"path": "/work/y", "change": "modified", '
        '"old_sha256": "%s", "new_sha256": "%s", "lines_added": 2, "lines_removed": 1}, '
        '{"path": "/work/b", "change": "moved", "from": "/work/a"}]}' % (a, a)))
    assert a not in out
    assert "/work/y (modified, +2/-1)" in out and "/work/b (moved, from /work/a)" in out
