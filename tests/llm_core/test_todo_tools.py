# SPDX-License-Identifier: MIT
"""tests/llm_core/test_todo_tools.py — outil ``todowrite`` (modèle OpenCode).

Couvre : coercition du schéma souple (statuts/priorités inconnus, strings,
entrées vides, cap 50), persistance ``chats.meta_json["todos"]`` (replace-all,
liste vide valide, chat inconnu → False, seed via ``get_chat``), résultat de
l'outil (count/remaining/persisted), et l'event UX ``todo_updated`` émis par
la harness ``execute_tool_batch`` (les DEUX canaux passent par elle).
"""
from __future__ import annotations

import json

import pytest

from llm_core.tools.todo_tools import MAX_TODOS, _coerce


# ── _coerce : schéma souple, jamais d'erreur dure ────────────────────────────

def test_coerce_normalise_et_tolere():
    out = _coerce([
        {"content": "step 1", "status": "IN-PROGRESS", "priority": "HIGH"},
        {"content": "", "status": "pending"},          # vide → droppé
        "plain string",                                  # string → todo pending
        {"content": "step 2", "status": "weird", "priority": "urgent"},
        {"content": "x" * 500},                          # contenu capé 300
        42,                                              # non-dict/str → droppé
    ])
    assert out[0] == {"content": "step 1", "status": "in_progress", "priority": "high"}
    assert out[1] == {"content": "plain string", "status": "pending", "priority": "medium"}
    assert out[2]["status"] == "pending" and out[2]["priority"] == "medium"
    assert len(out[3]["content"]) == 300
    assert len(out) == 4


def test_coerce_cap_50():
    out = _coerce([{"content": f"t{i}"} for i in range(80)])
    assert len(out) == MAX_TODOS


# ── Persistance meta_json (pattern fixture de test_chat_tools_meta) ─────────

@pytest.fixture()
def C(tmp_path, monkeypatch):
    import shared_infra.db._connection as legacy
    monkeypatch.setattr(legacy, "DB_PATH", str(tmp_path / "app.db"))
    from shared_infra.db._connection import db_conn
    with db_conn() as conn:
        conn.execute(
            "CREATE TABLE chats (id TEXT PRIMARY KEY, user_id INTEGER, title TEXT, "
            "messages_json TEXT, updated_at REAL, archived INTEGER DEFAULT 0, "
            "meta_json TEXT NOT NULL DEFAULT '{}')"
        )
        conn.execute(
            "INSERT INTO chats (id, user_id, title, messages_json, updated_at, meta_json) "
            "VALUES ('c1', 7, 't', '[]', 1.0, '{\"tools\": [\"fs\"]}')"
        )
        conn.commit()
    import shared_infra.chat.store as chats
    return chats


def test_set_chat_todos_roundtrip_et_merge(C):
    todos = [{"content": "a", "status": "in_progress", "priority": "high"},
             {"content": "b", "status": "pending", "priority": "medium"}]
    assert C.set_chat_todos(7, "c1", todos) is True
    got = C.get_chat(7, "c1")
    assert got["todos"] == todos
    # merge non destructif : les toggles d'outils du chat survivent.
    assert got["tools"] == ["fs"]
    # replace-all : liste vide = état valide (tout effacé).
    assert C.set_chat_todos(7, "c1", []) is True
    assert C.get_chat(7, "c1")["todos"] == []


def test_set_chat_todos_chat_inconnu(C):
    assert C.set_chat_todos(7, "nope", [{"content": "x"}]) is False


# ── Outil enregistré : résultat + persistance best-effort ───────────────────

class _StubMCP:
    def __init__(self):
        self.tools = {}

    def tool(self, **_kw):
        def deco(fn):
            self.tools[fn.__name__] = fn
            return fn
        return deco


async def test_todowrite_result_shape_sans_chat():
    from llm_core.tools import todo_tools
    mcp = _StubMCP()
    todo_tools.register(mcp)
    fn = mcp.tools["todowrite"]
    res = await fn(todos=[{"content": "a", "status": "in_progress"},
                          {"content": "b", "status": "completed"},
                          {"content": "c", "status": "cancelled"}], ctx=None)
    d = res.model_dump()
    assert d["ok"] is True and d["total"] == 3 and d["done"] == 1
    assert d["remaining"] == 1              # in_progress seul (completed/cancelled exclus)
    assert d["in_progress"] == "a"
    assert d["checklist"] == "1. [in_progress] a\n2. [completed] b\n3. [cancelled] c"
    assert d["persisted"] is False          # pas de chat_id résolu (ctx None)
    assert [t["status"] for t in d["todos"]] == ["in_progress", "completed", "cancelled"]


# ── Event UX todo_updated via la harness partagée ────────────────────────────

async def test_execute_tool_batch_emet_todo_updated():
    from llm_core.engine.tool_exec import execute_tool_batch

    payload = {"ok": True, "count": 1, "remaining": 1, "persisted": True,
               "todos": [{"content": "a", "status": "in_progress", "priority": "medium"}]}

    async def _exec_single(name, args, meta=None, **_cbs):
        return json.dumps(payload)

    events = []

    async def _on_event(ev):
        events.append(ev)

    async def _snap():
        pass

    results = await execute_tool_batch(
        [{"call_id": "1", "tool_name": "todowrite",
          "final_args": {"todos": payload["todos"]}, "meta": None}],
        execute_single=_exec_single,
        record_metric=lambda *a, **k: None,
        is_tool_failure=lambda r: False,
        on_event=_on_event,
        username="u", chat_id="c1",
        on_cancel_snapshot=_snap,
        iteration=0,
    )
    assert results[0]
    todo_evs = [e for e in events if e.get("type") == "todo_updated"]
    assert len(todo_evs) == 1
    assert todo_evs[0]["todos"] == payload["todos"]
    assert todo_evs[0]["remaining"] == 1


# ── Catégorie ``task`` CACHÉE (modèle OpenCode) ──────────────────────────────
# La todo-list n'est pas un toggle : absente du panneau (hidden exclut de
# GET /api/mcp/categories) et incluse D'OFFICE par _collect_mcp_tools
# (allowed_set = filter_categories | hidden) dès qu'un serveur est connecté.

def test_categorie_task_cachee():
    from llm_core.tools.todo_tools import CATEGORY
    from llm_core._mcp_categories import _normalize_descriptor
    assert CATEGORY["hidden"] is True
    # Les deux chemins de résolution (meta expédié / fallback statique).
    assert _normalize_descriptor("task", CATEGORY)["hidden"] is True
    assert _normalize_descriptor("task", None)["hidden"] is True


async def test_collect_mcp_tools_task_toujours_inclus(monkeypatch):
    """filter_categories=["fs"] (le user n'a coché QUE Fichiers) → todowrite
    (catégorie cachée ``task``) est quand même exposé au modèle ; une
    catégorie visible non cochée (chart) reste filtrée."""
    import llm_core._chat_with_tools as _cwt
    import llm_core._mcp_categories as _cats

    _cat_map = {"read_file": "fs", "todowrite": "task", "create_chart": "chart"}
    monkeypatch.setattr(_cats, "categorize", lambda n: _cat_map.get(n, "other"))
    monkeypatch.setattr(_cats, "get_hidden_categories", lambda: ["task", "help"])
    monkeypatch.setattr(_cats, "manifest_source", lambda: "live")

    class _Pool:
        async def get_or_connect(self, cfg, resolve_client_fn=None):
            return object(), [
                {"name": "read_file", "description": "", "inputSchema": {"type": "object"}},
                {"name": "todowrite", "description": "", "inputSchema": {"type": "object"}},
                {"name": "create_chart", "description": "", "inputSchema": {"type": "object"}},
            ]

    monkeypatch.setattr(_cwt, "mcp_pool", _Pool())

    _map, tools_payload, _handlers, _names = await _cwt._collect_mcp_tools(
        [{"type": "stdio", "name": "Outils", "command": "DEFAULT_LOCAL_PYTHON",
          "filter_categories": ["fs"]}],
        None, None,
    )
    exposed = {t["function"]["name"] for t in tools_payload}
    assert "read_file" in exposed          # catégorie cochée
    assert "todowrite" in exposed          # cachée → toujours incluse
    assert "create_chart" not in exposed   # visible non cochée → filtrée


async def test_collect_mcp_tools_deny_layer(monkeypatch):
    """``deny_tool_names`` retire un outil même s'il est dans une catégorie
    CACHÉE (todowrite/task) ou builtin — contrairement à allowed_tool_names.
    Utilisé par le moteur de sous-agents pour isoler un enfant."""
    import llm_core._chat_with_tools as _cwt
    import llm_core._mcp_categories as _cats

    _cat_map = {"read_file": "fs", "todowrite": "task"}
    monkeypatch.setattr(_cats, "categorize", lambda n: _cat_map.get(n, "other"))
    monkeypatch.setattr(_cats, "get_hidden_categories", lambda: ["task", "help"])
    monkeypatch.setattr(_cats, "manifest_source", lambda: "live")

    class _Pool:
        async def get_or_connect(self, cfg, resolve_client_fn=None):
            return object(), [
                {"name": "read_file", "description": "", "inputSchema": {"type": "object"}},
                {"name": "todowrite", "description": "", "inputSchema": {"type": "object"}},
            ]

    monkeypatch.setattr(_cwt, "mcp_pool", _Pool())

    _builtins = {"task": {"definition": {"type": "function", "function": {"name": "task"}}, "handler": lambda a: "{}"}}
    cfgs = [{"type": "stdio", "name": "Outils", "command": "DEFAULT_LOCAL_PYTHON", "filter_categories": ["fs"]}]

    # Sans deny : todowrite (caché) + task (builtin) présents.
    _m, payload, handlers, _n = await _cwt._collect_mcp_tools(cfgs, _builtins, None)
    exposed = {t["function"]["name"] for t in payload}
    assert {"read_file", "todowrite", "task"} <= exposed

    # Avec deny : todowrite ET le builtin task disparaissent, read_file reste.
    _m, payload, handlers, _n = await _cwt._collect_mcp_tools(
        cfgs, _builtins, None, deny_tool_names={"task", "todowrite"})
    exposed = {t["function"]["name"] for t in payload}
    assert "read_file" in exposed
    assert "todowrite" not in exposed
    assert "task" not in exposed and "task" not in handlers


def test_todowrite_ctx_est_un_context_type():
    """Pin du contrat d'injection FastMCP : ``ctx`` doit être ANNOTÉ Context
    (un ``ctx=None`` non typé devient un paramètre ordinaire jamais rempli →
    identité username/chat_id perdue → persisted:false systématique — bug
    trouvé au live E2E 2026-07-12)."""
    import inspect
    from llm_core.tools import todo_tools
    mcp = _StubMCP()
    todo_tools.register(mcp)
    ann = inspect.signature(mcp.tools["todowrite"]).parameters["ctx"].annotation
    assert "Context" in str(ann)
