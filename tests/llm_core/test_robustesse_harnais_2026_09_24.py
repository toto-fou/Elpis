# SPDX-License-Identifier: MIT
"""Passe robustesse/propreté du harnais (2026-09-24) — non-régression."""
import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest


# ── Façade : un symbole ne masque plus un sous-module ────────────────────────
def test_import_du_sous_module_client_rend_un_module():
    import importlib

    import llm_core
    m = importlib.import_module("llm_core._client")
    assert llm_core._client is m and hasattr(m, "_get_llm_client")


# ── Budget dur : clés du harnais conservées, doublons écartés ────────────────
def test_sanitize_garde_les_blocs_thinking_et_les_marques():
    from llm_core.context.pruning import sanitize_message_history
    blocs = [{"type": "thinking", "thinking": "", "signature": "S"}]
    msgs = [
        {"role": "user", "content": "go"},
        {"role": "assistant", "content": None, "_anthropic_thinking": blocs,
         "reasoning_content": "je lis",
         "tool_calls": [{"id": "a", "type": "function",
                         "function": {"name": "read_file", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "a", "name": "read_file",
         "content": "x", "_prune_key": "k1"},
    ]
    out = sanitize_message_history(msgs)
    asst = next(m for m in out if m["role"] == "assistant")
    tool = next(m for m in out if m["role"] == "tool")
    assert asst["_anthropic_thinking"] == blocs
    assert asst["reasoning_content"] == "je lis"
    assert tool["_prune_key"] == "k1" and tool["name"] == "read_file"


def test_sanitize_ecarte_un_resultat_en_double():
    from llm_core.context.pruning import sanitize_message_history
    msgs = [
        {"role": "user", "content": "go"},
        {"role": "assistant", "content": None, "tool_calls": [
            {"id": "a", "type": "function", "function": {"name": "f", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "a", "content": "1"},
        {"role": "assistant", "content": None, "tool_calls": [
            {"type": "function", "function": {"name": "g", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "a", "content": "doublon"},
        {"role": "tool", "content": "2"},
    ]
    out = sanitize_message_history(msgs)
    contenus = [m["content"] for m in out if m["role"] == "tool"]
    assert "doublon" not in contenus and contenus == ["1", "2"]


# ── Registre des fichiers : chemin complet dans la clé ───────────────────────
def test_ledger_chemins_avec_espaces_distincts():
    from llm_core.context.compression.serializer import merge_ledger_lines
    a = "- write_file docs/My File.md (12 chars, ok)"
    b = "- write_file docs/My Notes.md (40 chars, ok)"
    assert merge_ledger_lines([a], [b]) == [a, b]
    c = "- write_file docs/My File.md (99 chars, ok)"
    assert merge_ledger_lines([a, b], [c]) == [c, b]   # remplacée sur place


# ── Routeur de logs MCP : jeton effectif rendu ───────────────────────────────
def test_log_router_collision_rend_le_jeton_effectif():
    from llm_core._mcp_wrappers import _LogRouter
    r = _LogRouter()
    t1 = r.register("call-1", "execute_shell", None)
    t2 = r.register("call-1", "execute_shell", None)
    assert t1 == "call-1" and t2 != "call-1"
    r.unregister(t2)
    assert "call-1" in r._calls and t2 not in r._calls


# ── Trame desktop distante : bonne signature ─────────────────────────────────
async def test_prefetch_desktop_frame_rapatrie(monkeypatch):
    from llm_core import _chat_with_tools as W
    vus = []

    async def _ensure(uid, path, url):
        vus.append(url)
    monkeypatch.setattr(W, "_ensure_local_asset", _ensure)
    tok = "a" * 32
    monkeypatch.setattr(W, "_extract_desktop_frame",
                        lambda name, args, res: {"token": tok})
    await W._prefetch_desktop_frame(7, "desktop_observe", json.dumps({"frame_token": tok}))
    assert vus == [f"/api/desktop/frame/{tok}"]


# ── Flux : texte et appel d'outil dans le même delta ─────────────────────────
class _Resp:
    status_code = 200

    def __init__(self, lines):
        self._lines = lines

    async def aiter_lines(self):
        for line in self._lines:
            yield line


async def test_texte_du_meme_delta_que_tool_calls_garde():
    from llm_core._stream_tag_parser import ThinkTagSplitter
    from llm_core.providers.llamacpp import consume_llama_sse
    chunk = {"choices": [{"index": 0, "delta": {
        "content": "Je lis le fichier.",
        "tool_calls": [{"index": 0, "id": "x", "function": {
            "name": "read_file", "arguments": "{}"}}]}}]}
    r = await consume_llama_sse(_Resp(["data: " + json.dumps(chunk)]),
                                tag_splitter=ThinkTagSplitter(), req_id="r", user_id="u")
    assert r.content() == "Je lis le fichier."
    assert r.built_tool_calls()[0]["function"]["name"] == "read_file"


# ── Anthropic chemin classique : relance, message lisible ────────────────────
async def test_anthropic_classique_relance_un_529(monkeypatch):
    from llm_core import _llm_retry as R
    from llm_core.providers import anthropic as A
    appels = []

    async def _consume(target, body, **k):
        appels.append(1)
        if len(appels) == 1:
            raise R.provider_http_error(529, '{"type":"error"}')
        return {"content": "ok", "thinking": "", "tool_calls": [], "thinking_blocks": [],
                "usage": {}, "stop_reason": "end_turn", "model": "m"}

    async def _pause(*a, **k):
        return None
    monkeypatch.setattr(A, "_consume_stream", _consume)
    monkeypatch.setattr(R, "retry_pause", _pause)
    target = SimpleNamespace(model="claude-opus-5", base_url="", api_key="k")
    _t, content, meta = await A.anthropic_chat_stream(
        [{"role": "user", "content": "x"}], target=target)
    assert content == "ok" and len(appels) == 2 and not meta.get("error")


async def test_anthropic_classique_erreur_fatale_lisible(monkeypatch):
    from llm_core import _llm_retry as R
    from llm_core.providers import anthropic as A

    async def _consume(target, body, **k):
        raise R.provider_http_error(401, '{"error":{"type":"authentication_error"}}')
    monkeypatch.setattr(A, "_consume_stream", _consume)
    target = SimpleNamespace(model="claude-opus-5", base_url="", api_key="k")
    _t, content, meta = await A.anthropic_chat_stream(
        [{"role": "user", "content": "x"}], target=target)
    assert meta.get("error") and content.startswith("⚠ Erreur LLM")
    assert '{"error"' not in content


def test_retry_after_conserve_par_provider_http_error():
    from llm_core._llm_retry import provider_http_error, retry_after_seconds
    e = provider_http_error(429, "x", headers={"retry-after": "4"})
    assert retry_after_seconds(e) == 4.0


# ── Découverte Anthropic : racine d'API ──────────────────────────────────────
@pytest.mark.parametrize("base", ["", "https://api.anthropic.com",
                                  "https://api.anthropic.com/v1",
                                  "https://api.anthropic.com/v1/messages"])
def test_api_root_et_messages_url(base):
    from llm_core.providers.anthropic import api_root, messages_url
    t = SimpleNamespace(base_url=base)
    assert api_root(t) == "https://api.anthropic.com"
    assert messages_url(t) == "https://api.anthropic.com/v1/messages"


# ── Oubli d'un connecteur supprimé ───────────────────────────────────────────
async def test_forget_annule_la_tache_d_abonnement():
    from llm_core._scheduling import _engines as E
    task = asyncio.create_task(asyncio.sleep(3600))
    E._REGISTRY["conn:999"] = (None, SimpleNamespace(_sub_task=task), None)
    E.forget_connector(999)
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert "conn:999" not in E._REGISTRY and task.cancelled()


# ── Préflight : erreur de transport typée ────────────────────────────────────
async def test_preflight_leve_une_erreur_de_transport(monkeypatch):
    import llm_core._target as T
    from llm_core import _health as H
    from llm_core._llm_retry import KIND_UNREACHABLE, llm_error_kind

    class _C:
        async def get(self, *a, **k):
            raise httpx.ConnectError("refus")
    monkeypatch.setattr(T, "current_target", lambda: None)
    monkeypatch.setattr(H, "_get_llm_client", lambda *a: _C())
    H._preflight_ok_at.clear()
    with pytest.raises(httpx.ConnectError) as ei:
        await H.verify_llm_availability()
    assert llm_error_kind(ei.value) == KIND_UNREACHABLE
