# SPDX-License-Identifier: MIT
"""Audit du cœur du harnais, 2e passe (2026-09-24) — non-régression.

Un test par défaut corrigé : requête Anthropic/OpenAI, ids d'appels, parsing
des appels en texte, relances, fenêtres de contexte, résultats MCP, exécution
d'un lot d'outils."""
import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest

from llm_core import _chat_with_tools as W
from llm_core._ctx_window import _from_known_family
from llm_core._llm_retry import llm_error_is_fatal, retry_after_seconds
from llm_core._stream_tag_parser import ThinkTagSplitter
from llm_core._tool_parsing import extract_tool_calls
from llm_core.engine.tool_exec import execute_tool_batch
from llm_core.providers import anthropic as A
from llm_core.providers import openai_compat as O
from llm_core.providers.llamacpp import consume_llama_sse


def _http_error(status, headers=None):
    req = httpx.Request("POST", "http://x/")
    resp = httpx.Response(status, headers=headers or {}, request=req)
    return httpx.HTTPStatusError("e", request=req, response=resp)


# ── Anthropic ────────────────────────────────────────────────────────────────
_HISTO_OUTILS = [
    {"role": "user", "content": "lis a.py"},
    {"role": "assistant", "content": None, "tool_calls": [
        {"id": "toolu_1", "type": "function",
         "function": {"name": "read_file", "arguments": '{"path": "a.py"}'}}]},
    {"role": "tool", "tool_call_id": "toolu_1", "name": "read_file", "content": "x = 1"},
    {"role": "user", "content": "et maintenant ?"},
]


def _types(body):
    return [b["type"] for m in body["messages"] for b in m["content"]]


def test_anthropic_sans_outils_rend_l_historique_d_outils_en_texte():
    target = SimpleNamespace(model="claude-opus-5", base_url="", api_key="k")
    body = A.build_body(target, _HISTO_OUTILS, tools_payload=None)
    assert "tools" not in body
    assert "tool_use" not in _types(body) and "tool_result" not in _types(body)
    txt = json.dumps(body["messages"], ensure_ascii=False)
    assert "read_file" in txt and "x = 1" in txt


def test_anthropic_avec_outils_garde_tool_use_et_tool_result():
    target = SimpleNamespace(model="claude-opus-5", base_url="", api_key="k")
    tools = [{"type": "function", "function": {"name": "read_file", "parameters": {}}}]
    body = A.build_body(target, _HISTO_OUTILS, tools_payload=tools)
    assert "tool_use" in _types(body) and "tool_result" in _types(body)


@pytest.mark.parametrize("model,attendu", [
    ("claude-opus-5", "adaptive"),
    ("claude-sonnet-4-6", "adaptive"),
    ("claude-fable-5-1", "adaptive"),
    ("mon-alias-maison", "adaptive"),
    ("claude-haiku-4-5", "enabled"),
    ("claude-haiku-4-5-20251001", "enabled"),
    ("claude-sonnet-4-20250514", "enabled"),
    ("claude-3-7-sonnet-latest", "enabled"),
    ("claude-3-5-haiku-latest", None),
])
def test_thinking_selon_le_modele(model, attendu):
    cfg = A.thinking_config(model, 16000)
    assert (cfg or {}).get("type") == attendu
    if attendu == "enabled":
        assert 1024 <= cfg["budget_tokens"] < 16000


def test_thinking_enabled_omis_si_max_tokens_trop_petit():
    assert A.thinking_config("claude-haiku-4-5", 1500) is None


def test_blocs_thinking_signes_rejoues_devant_les_tool_use():
    blocs = [{"type": "thinking", "thinking": "", "signature": "sig=="}]
    msgs = [dict(_HISTO_OUTILS[1], _anthropic_thinking=blocs), _HISTO_OUTILS[2]]
    _, out = A.to_anthropic_messages(msgs)
    assert out[0]["content"][0] == blocs[0]
    assert out[0]["content"][1]["type"] == "tool_use"


class _AResp:
    status_code = 200

    def __init__(self, events):
        self._ev = events

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_a):
        return False

    async def aiter_lines(self):
        for e in self._ev:
            yield "data: " + json.dumps(e)


async def test_flux_anthropic_capture_la_signature_du_raisonnement(monkeypatch):
    ev = [
        {"type": "message_start", "message": {"model": "claude-opus-5", "usage": {}}},
        {"type": "content_block_start", "index": 0,
         "content_block": {"type": "thinking", "thinking": ""}},
        {"type": "content_block_delta", "index": 0,
         "delta": {"type": "thinking_delta", "thinking": "je lis"}},
        {"type": "content_block_delta", "index": 0,
         "delta": {"type": "signature_delta", "signature": "SIG"}},
        {"type": "content_block_stop", "index": 0},
        {"type": "content_block_start", "index": 1,
         "content_block": {"type": "tool_use", "id": "toolu_9", "name": "read_file"}},
        {"type": "content_block_delta", "index": 1,
         "delta": {"type": "input_json_delta", "partial_json": '{"path":"a"}'}},
        {"type": "content_block_stop", "index": 1},
        {"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {}},
        {"type": "message_stop"},
    ]
    monkeypatch.setattr(A, "_get_llm_client",
                        lambda *_a: SimpleNamespace(stream=lambda *a, **k: _AResp(ev)))
    target = SimpleNamespace(model="claude-opus-5", base_url="", api_key="k")
    out = await A.anthropic_chat_with_tools_stream(
        [{"role": "user", "content": "go"}],
        [{"type": "function", "function": {"name": "read_file", "parameters": {}}}],
        target=target)
    msg = out["choices"][0]["message"]
    assert msg["_anthropic_thinking"] == [
        {"type": "thinking", "thinking": "je lis", "signature": "SIG"}]


# ── OpenAI : modèles de raisonnement ─────────────────────────────────────────
def test_modele_de_raisonnement_openai_max_completion_tokens_sans_temperature():
    target = SimpleNamespace(provider_type="openai", is_default=False,
                             model="gpt-5", base_url="https://api.openai.com/v1")
    p = {"model": "gpt-5", "messages": [], "max_tokens": 24, "temperature": 0.2}
    O.sanitize_payload(p, target)
    assert p.get("max_completion_tokens") == 24
    assert "max_tokens" not in p and "temperature" not in p


def test_modele_classique_openai_inchange():
    target = SimpleNamespace(provider_type="openai", is_default=False,
                             model="gpt-4o", base_url="https://api.openai.com/v1")
    p = {"model": "gpt-4o", "messages": [], "max_tokens": 24, "temperature": 0.2}
    O.sanitize_payload(p, target)
    assert p["max_tokens"] == 24 and p["temperature"] == 0.2


def test_max_completion_tokens_de_l_ui_transmis():
    assert O.remote_sampling({"max_completion_tokens": 100}).get(
        "max_completion_tokens") == 100
    assert "max_completion_tokens" not in O.remote_sampling({"max_completion_tokens": 0})


# ── Ids d'appels uniques ─────────────────────────────────────────────────────
def test_ids_positionnels_rendus_uniques_sur_l_historique():
    histo = [{"role": "assistant", "tool_calls": [{"id": "call_0"}, {"id": "call_1"}]}]
    tcs = [{"id": "call_0", "function": {"name": "write_file"}},
           {"id": "", "function": {"name": "x"}},
           {"id": "toolu_neuf", "function": {"name": "y"}}]
    out = W._unique_tool_call_ids(tcs, histo)
    ids = [t["id"] for t in out]
    assert ids[0] not in ("call_0", "call_1") and ids[1]
    assert ids[2] == "toolu_neuf"
    assert len(set(ids)) == 3
    assert tcs[0]["id"] == "call_0"   # l'entrée n'est pas mutée


def test_ids_en_double_dans_un_meme_lot():
    out = W._unique_tool_call_ids([{"id": "a"}, {"id": "a"}], [])
    assert out[0]["id"] == "a" and out[1]["id"] != "a"


# ── Flux SSE : arguments déjà objet ──────────────────────────────────────────
class _Resp:
    status_code = 200

    def __init__(self, lines):
        self._lines = lines

    async def aiter_lines(self):
        for line in self._lines:
            yield line


async def test_arguments_objet_serialises():
    chunk = {"choices": [{"index": 0, "delta": {"tool_calls": [
        {"index": 0, "id": "x", "function": {"name": "read_file",
                                              "arguments": {"path": "a.py"}}}]},
        "finish_reason": "tool_calls"}]}
    r = await consume_llama_sse(_Resp(["data: " + json.dumps(chunk)]),
                                tag_splitter=ThinkTagSplitter(), req_id="r", user_id="u")
    tc = r.built_tool_calls()
    assert json.loads(tc[0]["function"]["arguments"]) == {"path": "a.py"}


# ── Appels en texte (<function=…>) ───────────────────────────────────────────
def test_nom_d_outil_avec_tiret():
    out = extract_tool_calls(
        "<tool_call><function=resolve-library-id><parameter=library-name>react"
        "</parameter></function></tool_call>")
    assert out == [("resolve-library-id", {"library-name": "react"})]


def test_valeur_multiligne_garde_indentation_et_contenu():
    out = extract_tool_calls(
        "<tool_call><function=edit_file>"
        "<parameter=old_string>\n    x = 1\n</parameter>"
        "<parameter=content>\n\ndef f():\n    pass\n\n</parameter>"
        "<parameter=path> a.py </parameter>"
        "</function></tool_call>")
    args = out[0][1]
    assert args["old_string"] == "    x = 1"
    assert args["content"] == "\ndef f():\n    pass\n"
    assert args["path"] == "a.py"


# ── Relances ─────────────────────────────────────────────────────────────────
def test_retry_after_en_secondes_et_borne():
    assert retry_after_seconds(_http_error(429, {"retry-after": "20"})) == 20.0
    assert retry_after_seconds(_http_error(429, {"retry-after": "99999"})) == 60.0
    assert retry_after_seconds(_http_error(429, {"retry-after-ms": "1500"})) == 1.5
    assert retry_after_seconds(_http_error(429)) is None
    assert retry_after_seconds(RuntimeError("x")) is None


def test_retry_after_date_http():
    from email.utils import format_datetime
    import datetime as dt
    quand = dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=30)
    s = retry_after_seconds(_http_error(503, {"retry-after": format_datetime(quand, usegmt=True)}))
    assert s is not None and 25 <= s <= 31


async def test_retry_pause_respecte_retry_after(monkeypatch):
    from llm_core import _llm_retry as R
    dormis = []

    async def _sleep(s, _c):
        dormis.append(s)
    monkeypatch.setattr(R, "_cancel_aware_sleep", _sleep)
    monkeypatch.setattr(R, "current_target", lambda: SimpleNamespace(is_llamacpp=False),
                        raising=False)
    import llm_core._target as T
    monkeypatch.setattr(T, "current_target", lambda: SimpleNamespace(is_llamacpp=False))
    await R.retry_pause(_http_error(429, {"retry-after": "7"}), 0)
    assert dormis == [7.0]


async def test_503_avec_health_deja_ok_garde_le_backoff(monkeypatch):
    from llm_core import _llm_retry as R
    import llm_core._target as T
    dormis = []

    async def _sleep(s, _c):
        dormis.append(s)

    async def _pret(**_k):
        return True
    monkeypatch.setattr(R, "_cancel_aware_sleep", _sleep)
    monkeypatch.setattr(R, "wait_llama_ready", _pret)
    monkeypatch.setattr(R, "backoff_delay", lambda a: 0.42)
    monkeypatch.setattr(T, "current_target", lambda: SimpleNamespace(is_llamacpp=True))
    await R.retry_pause(_http_error(503), 1)
    assert dormis == [0.42]


def test_409_rejouable():
    assert not llm_error_is_fatal(_http_error(409))
    assert llm_error_is_fatal(_http_error(400))


# ── Fenêtres de contexte ─────────────────────────────────────────────────────
@pytest.mark.parametrize("model,win", [
    ("o1-mini", 128_000), ("o1-preview", 128_000), ("o1", 200_000),
    ("mon-modele-1m", 1_000_000), ("truc-200k", 200_000),
])
def test_fenetres_conservatrices(model, win):
    assert _from_known_family(model) == win


# ── Résultats MCP ────────────────────────────────────────────────────────────
def test_is_error_dict_multi_cles_classe_en_echec():
    from llm_core.engine.result_contract import result_is_error
    res = SimpleNamespace(isError=True, content=[SimpleNamespace(
        text='{"error": "Not Found", "status": 404}')])
    out = W.pick_tool_payload(res)
    assert out["ok"] is False and out["status"] == 404
    assert result_is_error(json.dumps(out))


def test_structured_content_seul():
    res = SimpleNamespace(isError=False, content=[], structuredContent={"items": [1]})
    assert W.pick_tool_payload(res) == {"items": [1]}


# ── Exécution d'un lot ───────────────────────────────────────────────────────
def _batch_kwargs(execute_single, snaps, is_cancelled=None):
    async def _snap():
        snaps.append(1)
    return dict(execute_single=execute_single, record_metric=lambda *a, **k: None,
                is_tool_failure=lambda r: False, on_event=None, username="u",
                chat_id="c", on_cancel_snapshot=_snap, iteration=0,
                is_cancelled=is_cancelled)


async def test_arguments_invalides_outil_non_execute():
    appels = []

    async def _exec(name, args, **_k):
        appels.append(name)
        return {"ok": True}
    res = await execute_tool_batch(
        [{"call_id": "c1", "tool_name": "todowrite", "final_args": {},
          "meta": None, "args_error": "arguments JSON invalides"}],
        **_batch_kwargs(_exec, []))
    assert appels == []
    assert json.loads(res[0])["ok"] is False


async def test_stop_pendant_la_telemetrie_prend_le_snapshot(monkeypatch):
    import llm_core.engine.tool_exec as TE
    stop = {"v": False}

    async def _exec(name, args, **_k):
        return {"ok": True}

    class _StopPool:
        """Pool de télémétrie (dédié depuis le 2026-09-26) : le Stop tombe
        pendant la mise en file de l'écriture."""
        def submit(self, fn, *a, **k):
            stop["v"] = True
            raise asyncio.CancelledError()
    monkeypatch.setattr(TE, "_telemetry_pool", lambda: _StopPool())
    snaps = []
    out = {}
    with pytest.raises(asyncio.CancelledError):
        await execute_tool_batch(
            [{"call_id": "c1", "tool_name": "write_file", "final_args": {}, "meta": None}],
            results_out=out, **_batch_kwargs(_exec, snaps, is_cancelled=lambda: stop["v"]))
    assert snaps == [1]
    assert 0 in out


# ── Fermante de raisonnement sans ouvrante ───────────────────────────────────
def test_fermante_orpheline_separe_raisonnement_et_reponse():
    from llm_core._chat_classic import _extract_thinking
    assert _extract_thinking("Je dois d'abord…</think>La réponse est 42.") == (
        "Je dois d'abord…", "La réponse est 42.")
    assert _extract_thinking("calcul<|/thinking|>42") == ("calcul", "42")


def test_fermante_citee_dans_du_code_non_touchee():
    from llm_core._chat_classic import _extract_thinking, split_orphan_think_close
    txt = "Fermez avec `</think>` en fin de bloc."
    assert split_orphan_think_close(txt) is None
    assert _extract_thinking(txt) == ("", txt)


def test_balises_completes_inchangees():
    from llm_core._chat_classic import _extract_thinking
    assert _extract_thinking("<think>a</think>b") == ("a", "b")


# ── Fenêtre déclarée : lue hors boucle, mémoïsée ─────────────────────────────
async def test_fenetre_declaree_memoisee_et_hors_boucle(monkeypatch):
    import threading
    from llm_core import _ctx_window as C
    C.invalidate_cache()
    appels = []

    def _lecture(cid):
        appels.append(threading.current_thread() is threading.main_thread())
        return 32_000
    monkeypatch.setattr(C, "_from_connector", _lecture)
    assert await C._declared_window("cx") == 32_000
    assert await C._declared_window("cx") == 32_000
    assert appels == [False]          # une seule lecture, dans un thread
    C.invalidate_cache()
    assert await C._declared_window("cx") == 32_000
    assert len(appels) == 2
    C.invalidate_cache()
