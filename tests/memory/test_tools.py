# SPDX-License-Identifier: MIT
"""Tests des tools MCP `memory` et `session_search` (closures dans register)."""
from __future__ import annotations

import pytest


# ── Faux MCP : capture les closures @mcp.tool sans dépendre de fastmcp ──
class FakeMCP:
    def __init__(self):
        self.tools = {}

    def tool(self, **kw):
        def deco(fn):
            self.tools[fn.__name__] = fn
            return fn
        return deco

    def resource(self, *a, **kw):
        return lambda fn: fn

    def prompt(self, *a, **kw):
        return lambda fn: fn


class FakeRC:
    def __init__(self, meta):
        self.meta = meta


class FakeCtx:
    def __init__(self, **meta):
        self.request_context = FakeRC(meta)

    async def info(self, *a, **k):
        pass

    async def debug(self, *a, **k):
        pass


@pytest.fixture
def memory_tool(tmp_path):
    from llm_core.tools import memory_tools
    m = FakeMCP()
    memory_tools.register(m, tmp_path)
    return m.tools["memory"], tmp_path


async def test_memory_add_and_persist(memory_tool):
    memory, root = memory_tool
    ctx = FakeCtx(username="alice", chat_id="c1")
    r = await memory(ctx, action="add", store="memory", content="projet utilise sqlite")
    assert r.ok and r.id and r.op and "1 entry" in r.usage
    f = root / "alice" / "memory" / "MEMORY.md"
    assert f.exists() and "sqlite" in f.read_text()


async def test_memory_user_store_separate_file(memory_tool):
    memory, root = memory_tool
    ctx = FakeCtx(username="alice", chat_id="c1")
    await memory(ctx, action="add", store="user", content="prefere le francais")
    assert (root / "alice" / "memory" / "USER.md").exists()


async def test_memory_replace_and_remove(memory_tool):
    memory, root = memory_tool
    ctx = FakeCtx(username="bob", chat_id="c1")
    await memory(ctx, action="add", store="memory", content="fact one")
    await memory(ctx, action="add", store="memory", content="fact two")
    r = await memory(ctx, action="replace", store="memory", target="one", content="fact ONE edited")
    assert r.ok
    r2 = await memory(ctx, action="remove", store="memory", target="two")
    assert r2.ok and "1 entry" in r2.usage and r2.id == ""


async def test_memory_old_text_alias_still_works(memory_tool):
    # Alias déprécié conservé UN cycle : les historiques en vol contiennent
    # encore des appels old_text — ils doivent rester exécutables.
    memory, _ = memory_tool
    ctx = FakeCtx(username="bob2", chat_id="c1")
    await memory(ctx, action="add", store="memory", content="fait alias")
    r = await memory(ctx, action="remove", store="memory", old_text="alias")
    assert r.ok and "0 entries" in r.usage


async def test_memory_target_by_id_cycle(memory_tool):
    memory, _ = memory_tool
    ctx = FakeCtx(username="ida", chat_id="c1")
    r1 = await memory(ctx, action="add", store="memory", content="preference durable A")
    await memory(ctx, action="add", store="memory", content="note projet B")
    # Le succès donne l'id de l'entrée écrite : cible sûre pour la suite.
    eid = r1.id
    r2 = await memory(ctx, action="replace", store="memory",
                      target=f"[{eid}]", content="preference durable A v2")
    assert r2.ok and r2.id and r2.id != eid
    from llm_core.memory import compute_entry_id
    assert r2.id == compute_entry_id("preference durable A v2")
    r3 = await memory(ctx, action="remove", store="memory", target=r2.id)
    assert r3.ok and "1 entry" in r3.usage


async def test_memory_replace_requires_target(memory_tool):
    memory, _ = memory_tool
    ctx = FakeCtx(username="bob", chat_id="c1")
    r = await memory(ctx, action="replace", store="memory", content="x", target=None)
    assert not r.ok and "target" in (r.error or "")
    assert (r.fix or "")            # geste correctif présent


async def test_memory_bad_action_is_error_not_add(memory_tool):
    memory, root = memory_tool
    ctx = FakeCtx(username="bob3", chat_id="c1")
    r = await memory(ctx, action="memorize", store="memory", content="parasite")
    assert not r.ok and r.error == "bad_action"
    # rien n'a été écrit
    assert not (root / "bob3" / "memory" / "MEMORY.md").exists()


async def test_memory_over_limit_errors(memory_tool, monkeypatch):
    memory, _ = memory_tool
    from llm_core.tools import memory_tools
    monkeypatch.setattr(memory_tools, "_memory_limits", lambda: (20, 20))
    ctx = FakeCtx(username="carol", chat_id="c1")
    assert (await memory(ctx, action="add", store="memory", content="123456789012345")).ok
    r = await memory(ctx, action="add", store="memory", content="way too long to fit here")
    assert not r.ok and r.error == "over_limit"
    assert "limit" in (r.message or "")
    assert "rewrite" in (r.fix or "")            # le fix pointe la consolidation


async def test_memory_no_match_gives_closest_and_guided_entries(memory_tool):
    memory, _ = memory_tool
    ctx = FakeCtx(username="nina", chat_id="c1")
    await memory(ctx, action="add", store="memory",
                 content="l'utilisateur préfère des réponses concises et directes")
    r = await memory(ctx, action="replace", store="memory",
                     target="préfère les réponse concise",  # paraphrase
                     content="x")
    assert not r.ok and r.error == "no_match"
    assert r.closest and r.closest.startswith("[")
    assert "Likely candidate" in (r.fix or "")
    # entries compactes "[id] (Nc) extrait"
    assert r.entries and all(e.startswith("[") and "c) " in e for e in r.entries)


async def test_memory_entries_are_truncated_in_results(memory_tool):
    memory, _ = memory_tool
    ctx = FakeCtx(username="zoe", chat_id="c1")
    long = "un fait tres long " * 30                       # ~540 chars
    await memory(ctx, action="add", store="memory", content=long)
    await memory(ctx, action="add", store="memory", content="court")
    # Les entrées ne reviennent qu'en ÉCHEC (ici cible introuvable), en extraits.
    r = await memory(ctx, action="remove", store="memory", target="[ffff]")
    assert not r.ok and r.error == "no_match"
    assert all(len(e) <= 100 for e in r.entries)           # extrait ≤ 60c + id/(Nc)
    assert any("(539c)" in e or "(540c)" in e for e in r.entries)


async def test_memory_rewrite_consolidates(memory_tool):
    memory, root = memory_tool
    ctx = FakeCtx(username="rita", chat_id="c1")
    await memory(ctx, action="add", store="memory", content="fait un")
    await memory(ctx, action="add", store="memory", content="fait deux")
    r = await memory(ctx, action="rewrite", store="memory",
                     content="synthese des faits\n---\nnote restante")
    assert r.ok and "2 entries" in r.usage
    raw = (root / "rita" / "memory" / "MEMORY.md").read_text()
    assert "synthese des faits" in raw and "fait un" not in raw


async def test_memory_rewrite_requires_content(memory_tool):
    memory, _ = memory_tool
    ctx = FakeCtx(username="rita", chat_id="c1")
    r = await memory(ctx, action="rewrite", store="memory", content="   ")
    assert not r.ok and r.error == "content_required"


async def test_memory_store_busy_is_retryable_envelope(memory_tool, monkeypatch):
    memory, _ = memory_tool
    from llm_core.memory import StoreBusyError
    from llm_core.memory._markdown_store import MarkdownStore
    monkeypatch.setattr(MarkdownStore, "add",
                        lambda self, content: (_ for _ in ()).throw(
                            StoreBusyError("verrou occupé")))
    ctx = FakeCtx(username="zoe", chat_id="c1")
    r = await memory(ctx, action="add", store="memory", content="x")
    assert not r.ok and r.error == "store_busy"
    assert getattr(r, "retryable", False) is True


# (2026-09-11, P2 — A4) ``memory_scope`` n'était posé par aucun appelant :
# lecture retirée, la portée est celle du compte. Le test de routage par
# ``meta['memory_scope']`` disparaît avec le code mort qu'il exerçait.


@pytest.fixture
def search_tool(tmp_path, monkeypatch):
    from shared_infra.db import _connection as _legacy
    monkeypatch.setattr(_legacy, "DB_PATH", str(tmp_path / "test.db"))
    from shared_infra.memory import store as memory_store
    with _legacy.db_conn() as conn:
        conn.execute("CREATE TABLE IF NOT EXISTS users ("
                     "id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL)")
        conn.execute("INSERT INTO users(id, username) VALUES(1, 'alice')")
        conn.commit()
    memory_store.init_memory_db()
    memory_store.session_index_message(user_id=1, app="chat", session_id="c1",
                                       scope_key="", role="user",
                                       content="discussion sur kubernetes hier")
    from llm_core.tools import memory_tools
    m = FakeMCP()
    memory_tools.register(m, tmp_path)
    return m.tools["session_search"]


async def test_session_search_finds_message(search_tool):
    ctx = FakeCtx(username="alice", chat_id="c2")
    r = await search_tool(ctx, query="kubernetes", limit=10)
    assert r.ok and r.count == 1
    m = r.matches[0]
    assert "«kubernetes»" in m.excerpt           # extrait FTS5, mot trouvé marqué
    assert m.role == "user" and len(m.date) == 10


async def test_session_search_empty_query(search_tool):
    ctx = FakeCtx(username="alice", chat_id="c2")
    r = await search_tool(ctx, query="   ", limit=10)
    assert not r.ok


async def test_session_search_unknown_user(search_tool):
    ctx = FakeCtx(username="nobody", chat_id="c2")
    r = await search_tool(ctx, query="kubernetes", limit=10)
    assert r.ok and r.count == 0
