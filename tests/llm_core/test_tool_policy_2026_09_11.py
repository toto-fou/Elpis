# SPDX-License-Identifier: MIT
"""P2 (2026-09-11) — la politique d'exécution voyage dans ``meta.policy`` des
outils (timeout, sérialisation, rejeu, élagage, rôles exclus) ; le harnais la
lit à la connexion et n'a plus besoin de listes par NOM (qui restent des
replis pour les serveurs externes et un registre vide)."""
from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from llm_core import _mcp_categories as C


class _T:
    def __init__(self, name, policy=None, cat="fs", desc="d"):
        self.name = name
        self.description = desc
        self.meta = {"category": {"name": cat}}
        if policy is not None:
            self.meta["policy"] = policy


@pytest.fixture
def registry(tmp_path, monkeypatch):
    """Registre isolé (cache disque dans tmp) et remis à zéro."""
    monkeypatch.setattr(C, "_CACHE_PATH", tmp_path / "cache.json")
    monkeypatch.setattr(C, "_registry", None)
    monkeypatch.setattr(C, "_disk_cache", {"at": 0.0, "reg": None})
    yield C
    monkeypatch.setattr(C, "_registry", None)


# ── Extraction + registre ────────────────────────────────────────────────────

def test_ingest_enregistre_la_politique_et_la_persiste(registry, tmp_path):
    C.ingest_tools([_T("slow_x", {"timeout_s": "42", "serial": 1, "prune": "Head_Tail",
                                 "deny_for": ["Routine", "subagent"], "junk": 1}),
                    _T("read_y")])
    assert C.tool_policy("slow_x") == {"timeout_s": 42.0, "serial": True, "prune": "head_tail",
                                       "deny_for": ["routine", "subagent"]}
    assert C.tool_policy("read_y") == {} and C.tool_policy("inconnu") == {}
    cached = json.loads((tmp_path / "cache.json").read_text(encoding="utf-8"))
    assert cached["tool_policy"]["slow_x"]["timeout_s"] == 42.0


def test_les_outils_reels_portent_leur_politique():
    import os
    os.environ.setdefault("LOCAL_MCP_TRANSPORT", "stdio")
    import server.local_mcp_server as S
    # idempotent par famille : complète ce qu'un test précédent a pu enregistrer
    tools = asyncio.run(S.register_all_tools().list_tools())
    pol = {t.name: (t.meta or {}).get("policy") or {} for t in tools}
    assert pol["execute_shell"]["timeout_s"] == 610.0 and pol["execute_shell"]["serial"] is False \
        and pol["execute_shell"]["replay_safe"] is False and pol["execute_shell"]["prune"] == "head_tail"
    assert pol["write_file"]["serial"] is True and pol["write_file"]["prune"] == "diff"
    assert pol["read_file"] == {}
    assert all(pol[n]["serial"] for n in pol if n.startswith(("git_", "pw_", "desktop_")))
    assert pol["pw_wait"]["timeout_s"] == 330.0 and pol["desktop_shell"]["timeout_s"] == 610.0
    assert pol["desktop_act"]["prune"] == "desktop"
    assert pol["todowrite"]["deny_for"] == ["subagent"]
    assert pol["ask_user"]["deny_for"] == ["routine", "subagent"]
    assert pol["memory"]["serial"] is True and pol["session_search"] == {}


# ── Consommateurs : politique d'abord, repli ensuite ────────────────────────

def test_timeout_depuis_la_politique_puis_repli(registry):
    from llm_core import _chat_with_tools as cwt
    C.ingest_tools([_T("slow_x", {"timeout_s": 42}), _T("execute_shell", {"timeout_s": 900})])
    assert cwt._tool_timeout_s("slow_x") == 42.0
    assert cwt._tool_timeout_s("execute_shell") == 900.0          # protocole > repli 610
    assert cwt._tool_timeout_s("pw_wait") == 330.0                # repli par nom (pas de politique ingérée)
    assert cwt._tool_timeout_s("zz_inconnu") == float(cwt.LLAMA_TOOL_TIMEOUT_S)


def test_serialisation_depuis_la_politique_puis_prefixes(registry):
    from llm_core._tool_traits import tool_traits
    C.ingest_tools([_T("zz_write", {"serial": True}), _T("git_query", {"serial": False})])
    assert tool_traits("zz_write").serial is True
    assert tool_traits("git_query").serial is False                  # la politique prime sur le préfixe git_
    assert tool_traits("git_commit").serial is True                  # repli préfixe (pas de politique)
    assert tool_traits("zz_read").serial is False


def test_rejeu_depuis_la_politique(registry):
    from llm_core._tool_traits import tool_traits
    C.ingest_tools([_T("zz_mut", {"serial": True}), _T("zz_idem", {"replay_safe": True}),
                    _T("run_x", {"replay_safe": True})])
    assert tool_traits("zz_mut").replay_safe is False
    assert tool_traits("zz_idem").replay_safe is True
    assert tool_traits("run_x").replay_safe is True                       # politique > heuristique de nom
    assert tool_traits("execute_shell").replay_safe is False              # repli heuristique
    assert tool_traits("read_file").replay_safe is True


def test_elagage_depuis_la_politique(registry):
    from llm_core.context.pruning import emit_cap_chars, prepare_tool_result_for_model
    C.ingest_tools([_T("zz_build", {"prune": "head_tail"})])
    cap = emit_cap_chars(4096, None)
    big = "HEAD-" + ("x" * (cap * 2)) + "-TAIL"
    out = prepare_tool_result_for_model("zz_build", big, ctx_tokens=4096, model_id=None)
    assert out.startswith("HEAD-") and out.rstrip().endswith("-TAIL") or "tail preserved" in out
    out2 = prepare_tool_result_for_model("zz_other", big, ctx_tokens=4096, model_id=None)
    assert "-TAIL" not in out2                                    # coupe tête seule sans politique


def test_roles_exclus_depuis_la_politique_avec_repli(registry):
    assert C.tools_denied_for("subagent", fallback={"todowrite", "ask_user"}) == {"todowrite", "ask_user"}
    # registre vivant SANS politique (serveur antérieur / tiers) → repli aussi
    C.ingest_tools([_T("todowrite", cat="task"), _T("zz_ok")])
    assert C.tools_denied_for("subagent", fallback={"todowrite", "ask_user"}) == {"todowrite", "ask_user"}
    C.ingest_tools([_T("todowrite", {"deny_for": ["subagent"]}, cat="task"),
                    _T("ask_user", {"deny_for": ["routine", "subagent"]}, cat="skill"),
                    _T("zz_ok")])
    assert C.tools_denied_for("subagent", fallback={"jamais"}) == {"todowrite", "ask_user"}
    assert C.tools_denied_for("routine", fallback={"jamais"}) == {"ask_user"}
    from shared_infra.scheduling.routines_scheduler import _denied_for_routine
    assert _denied_for_routine() == {"ask_user"}


def test_sous_agent_retire_task_et_les_outils_deny_for(registry):
    src = open("llm_core/tools/task_tool.py", encoding="utf-8").read()
    assert 'child_deny = {"task"} | _denied_for("subagent", fallback=_DENY_BASE)' in src


# ── Injection du méta : un seul helper pour les deux canaux ─────────────────

def test_build_call_meta_unique():
    from llm_core._chat_with_tools import _build_call_meta
    assert _build_call_meta(is_local=False, username="u", chat_id="c", live_shell=True,
                            call_id="1", run_log_tok="r") is None
    m = _build_call_meta(is_local=True, username="u", chat_id="c", live_shell=True,
                         call_id="1", run_log_tok="r")
    assert m == {"username": "u", "chat_id": "c", "live_shell": "1", "call_id": "1", "log_token": "r:1"}
    src = open("llm_core/_chat_with_tools.py", encoding="utf-8").read()
    assert src.count("_build_call_meta(") == 3                    # définition + natif + legacy
    assert 'call_meta = {"username": username}' not in src


# ── Fragments de prompt déclarés par le manifeste ───────────────────────────

def test_fragments_declares_par_le_manifeste(tmp_path, monkeypatch):
    from llm_core import _system_prompts as SP
    from shared_infra.mcp import manifest as M
    d = tmp_path / "sp"; d.mkdir()
    (d / "FRAGMENT_TOOLS.md").write_text("TOOLS", encoding="utf-8")
    (d / "FRAGMENT_WEB.md").write_text("WEB", encoding="utf-8")
    (d / "FRAGMENT_WEB_CUSTOM.md").write_text("WEB-CUSTOM", encoding="utf-8")
    (d / "FRAGMENT_METEO.md").write_text("METEO", encoding="utf-8")
    monkeypatch.setattr(SP, "_SYSTEM_P_DIR", d)
    SP._FRAGMENT_CACHE.clear()
    assert SP.build_capability_block(["browser"]) == "TOOLS\n\nWEB"
    doc = {"mcpServers": {"elpis-tools": {"type": "http", "url": "http://127.0.0.1:8765/mcp",
           "x-elpis": {"role": "toolhost", "prompt_fragments": {"browser": "FRAGMENT_WEB_CUSTOM",
                                                                "meteo": "FRAGMENT_METEO",
                                                                "evil": "../secret"}}}}}
    p = tmp_path / "mcp.json"; p.write_text(json.dumps(doc), encoding="utf-8")
    monkeypatch.setenv("APP_MCP_MANIFEST", str(p)); M.reload()
    try:
        assert SP.build_capability_block(["browser"]) == "TOOLS\n\nWEB-CUSTOM"
        assert SP.build_capability_block(["meteo"]) == "METEO"      # catégorie nouvelle, étage contenu
        assert SP.build_capability_block(["evil"]) is None           # stem hors dossier ignoré
    finally:
        M.reload()


# ── A14 : familles par jeton client ─────────────────────────────────────────

def test_familles_par_jeton_client(monkeypatch):
    from shared_infra.config import _parse_client_token_families, _parse_client_tokens
    assert _parse_client_tokens("t1:alice:git+browser, t2:bob", None) == {"t1": "alice", "t2": "bob"}
    assert _parse_client_token_families("t1:alice:git+browser, t2:bob", None) == {"t1": ["git", "browser"]}
    assert _parse_client_tokens(None, {"t3": "carol:desktop"}) == {"t3": "carol"}
    assert _parse_client_token_families(None, {"t3": "carol:desktop", "t4": "dan"}) == {"t3": ["desktop"]}
    import os
    os.environ.setdefault("LOCAL_MCP_TRANSPORT", "stdio")
    import server.local_mcp_server as S
    import shared_infra.config as cfg
    monkeypatch.setattr(cfg, "LOCAL_MCP_CLIENT_TOKEN_FAMILIES", {"t1": ["git", "browser"]})
    table = S.build_token_table("svc", {"t1": "alice", "t2": "bob"})
    assert table["t1"]["families"] == ["git", "browser"] and "families" not in table["t2"]
    import fastmcp.server.dependencies as deps
    monkeypatch.setattr(deps, "get_access_token", lambda: SimpleNamespace(
        claims={"username": "alice", "trusted_meta": False, "families": ["git", "browser"]}))
    hidden = S.hidden_families_for_current_client()
    assert "fs" in hidden and "desktop" in hidden and "git" not in hidden and "browser" not in hidden


# ── A26 : une seule racine sandbox ──────────────────────────────────────────

def test_mcp_sandbox_root_propage_app_sandbox_dir(tmp_path, monkeypatch):
    import os
    os.environ.setdefault("LOCAL_MCP_TRANSPORT", "stdio")
    import server.local_mcp_server as S
    monkeypatch.setenv("MCP_SANDBOX_ROOT", str(tmp_path / "sb"))
    monkeypatch.setenv("APP_SANDBOX_DIR", "/ailleurs")
    root = S._resolve_sandbox_root()
    assert root == (tmp_path / "sb").resolve()
    assert os.environ["APP_SANDBOX_DIR"] == str(root)


# ── A4 : memory_scope retiré ────────────────────────────────────────────────

def test_memory_scope_retire():
    src = open("llm_core/tools/memory_tools.py", encoding="utf-8").read()
    assert "_memory_scope(" not in src and 'getter("memory_scope")' not in src
