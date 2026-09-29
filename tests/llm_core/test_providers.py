# SPDX-License-Identifier: MIT
"""
Connecteurs LLM — adaptateurs de transport.

Couvre : assainissement du payload OpenAI-compatible (retrait des champs
llama-only pour un cloud), résolution d'endpoint, traduction NATIVE Anthropic
(messages/outils/headers/body) et parsing du flux SSE Anthropic vers les
callbacks existants, plus la découverte de modèles. Aucun réseau (client mocké).
"""
from __future__ import annotations

import json

import pytest

from llm_core import _target as T
from llm_core.providers import anthropic as A, discovery as D, openai_compat as OAI


# ── Fake httpx client (stream + get) ──────────────────────────────────────────
class _Resp:
    def __init__(self, lines=None, status=200, payload=None):
        self._lines = lines or []
        self.status_code = status
        self._payload = payload or {}

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_a):
        return False

    async def aiter_lines(self):
        for l in self._lines:
            yield l

    async def aclose(self):
        pass

    async def aread(self):
        return b""

    def json(self):
        return self._payload


class _Client:
    def __init__(self, lines=None, get_resp=None):
        self._lines = lines
        self._get_resp = get_resp
        self.captured = {}

    def stream(self, method, url, json=None, headers=None):  # noqa: A002
        self.captured = {"url": url, "json": json, "headers": headers}
        return _Resp(self._lines)

    async def get(self, url, headers=None, timeout=None):
        self.captured = {"url": url, "headers": headers}
        return self._get_resp


def _sse(*objs):
    out = []
    for o in objs:
        out += [f"event: {o['type']}", "data: " + json.dumps(o), ""]
    return out


# ── openai_compat : sanitize + endpoints ──────────────────────────────────────
def test_sanitize_default_is_noop():
    p = {"model": "m", "id_slot": 3, "top_k": 40, "timings_per_token": True,
         "temperature": 0.2, "max_tokens": 50}
    OAI.sanitize_payload(p, T.default_target())
    assert p["id_slot"] == 3 and p["top_k"] == 40 and p["timings_per_token"] is True


def test_sanitize_remote_strips_llama_only():
    t = T.LlmTarget(wire="openai", provider_type="openai",
                    base_url="https://api.openai.com/v1", is_default=False)
    p = {"model": "m", "messages": [], "id_slot": 3, "cache_prompt": True,
         "top_k": 40, "dry_multiplier": 1.0, "timings_per_token": True,
         "thinking_budget_tokens": 9, "temperature": 0.2, "max_tokens": 50,
         "tools": [], "stream": True}
    OAI.sanitize_payload(p, t)
    for gone in ("id_slot", "cache_prompt", "top_k", "dry_multiplier",
                 "timings_per_token", "thinking_budget_tokens"):
        assert gone not in p, gone
    assert p["temperature"] == 0.2 and p["max_tokens"] == 50 and p["model"] == "m"


def test_sanitize_llamacpp_provider_keeps_fields():
    t = T.LlmTarget(wire="openai", provider_type="llamacpp",
                    base_url="http://x:8080/v1", is_default=False)
    p = {"id_slot": 1, "cache_prompt": True}
    OAI.sanitize_payload(p, t)
    assert p["id_slot"] == 1 and p["cache_prompt"] is True


def test_sanitize_local_nonllamacpp_strips_llama_only():
    # Moteur LOCAL mais PAS llama.cpp (is_default=True, provider_type='vllm') :
    # doit être assaini comme un distant — sinon les champs llama-only partent
    # vers un vLLM local qui les rejette.
    t = T.LlmTarget(wire="openai", provider_type="vllm", base_url="", is_default=True)
    p = {"model": "m", "messages": [], "id_slot": 3, "cache_prompt": True,
         "top_k": 40, "timings_per_token": True, "temperature": 0.2, "max_tokens": 50}
    OAI.sanitize_payload(p, t)
    for gone in ("id_slot", "cache_prompt", "top_k", "timings_per_token"):
        assert gone not in p, gone
    assert p["temperature"] == 0.2 and p["model"] == "m"


def test_is_local_llamacpp_property():
    assert T.LlmTarget(is_default=True,  provider_type="llamacpp").is_local_llamacpp is True
    assert T.LlmTarget(is_default=True,  provider_type="vllm").is_local_llamacpp is False
    assert T.LlmTarget(is_default=True,  provider_type="generic").is_local_llamacpp is False
    assert T.LlmTarget(is_default=False, provider_type="llamacpp").is_local_llamacpp is False


def test_endpoints():
    t = T.LlmTarget(wire="openai", provider_type="mistral",
                    base_url="https://api.mistral.ai/v1", api_key="sk", is_default=False)
    assert OAI.chat_completions_url(t) == "https://api.mistral.ai/v1/chat/completions"
    assert OAI.models_url(t) == "https://api.mistral.ai/v1/models"
    assert OAI.headers(t)["Authorization"] == "Bearer sk"
    # défaut : pas d'en-tête, URL = LLAMA_URL
    from shared_infra.config import LLAMA_URL
    assert OAI.chat_completions_url(T.default_target()) == LLAMA_URL
    assert OAI.headers(T.default_target()) == {}


# ── Anthropic : traduction pure ───────────────────────────────────────────────
def test_to_anthropic_messages_system_tooluse_toolresult():
    sysp, msgs = A.to_anthropic_messages([
        {"role": "system", "content": "be terse"},
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "ok",
         "tool_calls": [{"id": "c0", "type": "function",
                         "function": {"name": "f", "arguments": '{"a":1}'}}]},
        {"role": "tool", "tool_call_id": "c0", "content": "42"},
    ])
    assert sysp == "be terse"
    assert msgs[0]["role"] == "user"
    asst = msgs[1]
    assert asst["role"] == "assistant"
    tu = [b for b in asst["content"] if b["type"] == "tool_use"][0]
    assert tu["id"] == "c0" and tu["name"] == "f" and tu["input"] == {"a": 1}
    tr = msgs[2]
    assert tr["role"] == "user" and tr["content"][0]["type"] == "tool_result"
    assert tr["content"][0]["tool_use_id"] == "c0"


def test_to_anthropic_messages_multimodal_image():
    _, msgs = A.to_anthropic_messages([{"role": "user", "content": [
        {"type": "text", "text": "look"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,QUJD"}},
    ]}])
    blocks = msgs[0]["content"]
    assert blocks[0] == {"type": "text", "text": "look"}
    assert blocks[1]["type"] == "image" and blocks[1]["source"]["type"] == "base64"
    assert blocks[1]["source"]["media_type"] == "image/png" and blocks[1]["source"]["data"] == "QUJD"


def test_to_anthropic_tools_and_body_no_sampling():
    t = T.LlmTarget(wire="anthropic", provider_type="anthropic",
                    base_url="https://api.anthropic.com", api_key="sk-x",
                    model="claude-sonnet-4-6", is_default=False)
    tools = A.to_anthropic_tools([{"type": "function", "function": {
        "name": "g", "description": "d", "parameters": {"type": "object"}}}])
    assert tools[0]["name"] == "g" and tools[0]["input_schema"] == {"type": "object"}
    body = A.build_body(t, [{"role": "user", "content": "hi"}],
                        tools_payload=None, thinking_mode=True)
    assert body["model"] == "claude-sonnet-4-6"
    assert body["max_tokens"] > 0 and body["stream"] is True
    assert "temperature" not in body and "top_p" not in body  # évite 400 opus-4.7+/fable
    assert body["thinking"] == {"type": "adaptive", "display": "summarized"}
    h = A.build_headers(t)
    assert h["x-api-key"] == "sk-x" and h["anthropic-version"] == "2023-06-01"
    assert A.messages_url(t) == "https://api.anthropic.com/v1/messages"


def test_build_body_default_model_fallback():
    t = T.LlmTarget(wire="anthropic", provider_type="anthropic",
                    base_url="https://api.anthropic.com", is_default=False)
    body = A.build_body(t, [{"role": "user", "content": "x"}])
    assert body["model"] == A.DEFAULT_ANTHROPIC_MODEL


def test_build_body_no_thinking_on_tools_path():
    """thinking + outils : l'API Anthropic exige le replay des blocs ``thinking``
    (avec signature) avant un ``tool_use``. On ne les capture/rejoue pas, donc
    ``build_body`` NE DOIT PAS injecter ``thinking`` quand des outils sont
    présents — sinon 400 dès la 2e itération de la boucle agentique."""
    t = T.LlmTarget(wire="anthropic", provider_type="anthropic",
                    base_url="https://api.anthropic.com", api_key="sk",
                    model="claude-sonnet-4-6", is_default=False)
    tools = [{"type": "function", "function": {
        "name": "g", "parameters": {"type": "object"}}}]
    body = A.build_body(t, [{"role": "user", "content": "hi"}],
                        tools_payload=tools, thinking_mode=True)
    assert "thinking" not in body          # omis sur le chemin outils
    assert body["tools"][0]["name"] == "g"  # outils bien présents
    # Sans outils, le thinking reste actif (chemin classic).
    body2 = A.build_body(t, [{"role": "user", "content": "hi"}],
                         tools_payload=None, thinking_mode=True)
    assert body2["thinking"] == {"type": "adaptive", "display": "summarized"}


# ── Anthropic : parsing SSE → callbacks ───────────────────────────────────────
_TGT = T.LlmTarget(wire="anthropic", provider_type="anthropic",
                   base_url="https://api.anthropic.com", api_key="sk",
                   model="claude-sonnet-4-6", is_default=False)


async def test_anthropic_classic_stream(monkeypatch):
    lines = _sse(
        {"type": "message_start", "message": {"model": "claude-sonnet-4-6", "usage": {"input_tokens": 12}}},
        {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking"}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "hmm"}},
        {"type": "content_block_stop", "index": 0},
        {"type": "content_block_start", "index": 1, "content_block": {"type": "text"}},
        {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "Hello"}},
        {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": " world"}},
        {"type": "content_block_stop", "index": 1},
        {"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 5}},
        {"type": "message_stop"})
    monkeypatch.setattr(A, "_get_llm_client", lambda *a, **k: _Client(lines=lines))
    C, TH = [], []

    async def oc(t): C.append(t)
    async def ot(t): TH.append(t)

    th, ct, meta = await A.anthropic_chat_stream(
        [{"role": "user", "content": "hi"}], target=_TGT, thinking_mode=True,
        on_content_token=oc, on_thinking_token=ot)
    assert ct == "Hello world" and th == "hmm"
    assert "".join(C) == "Hello world" and "".join(TH) == "hmm"
    # L'usage réel (message_start/message_delta) reste la source du contexte.
    assert meta["usage"]["prompt_tokens"] == 12 and meta["usage"]["completion_tokens"] == 5
    assert meta["model"] == "claude-sonnet-4-6"


async def test_anthropic_tools_stream_reconstructs_calls(monkeypatch):
    lines = _sse(
        {"type": "message_start", "message": {"model": "claude-sonnet-4-6", "usage": {"input_tokens": 8}}},
        {"type": "content_block_start", "index": 0,
         "content_block": {"type": "tool_use", "id": "toolu_1", "name": "get_weather"}},
        {"type": "content_block_delta", "index": 0,
         "delta": {"type": "input_json_delta", "partial_json": '{"city":'}},
        {"type": "content_block_delta", "index": 0,
         "delta": {"type": "input_json_delta", "partial_json": '"Paris"}'}},
        {"type": "content_block_stop", "index": 0},
        {"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 7}},
        {"type": "message_stop"})
    monkeypatch.setattr(A, "_get_llm_client", lambda *a, **k: _Client(lines=lines))
    deltas = []

    async def otd(i, n, a): deltas.append((i, n, a))

    out = await A.anthropic_chat_with_tools_stream(
        [{"role": "user", "content": "weather?"}],
        [{"type": "function", "function": {"name": "get_weather", "parameters": {"type": "object"}}}],
        target=_TGT, on_tool_call_delta=otd)
    assert out["choices"][0]["finish_reason"] == "tool_calls"
    tc = out["choices"][0]["message"]["tool_calls"][0]
    assert tc["function"]["name"] == "get_weather"
    assert json.loads(tc["function"]["arguments"]) == {"city": "Paris"}
    assert any(d[2] for d in deltas)  # fragments d'arguments streamés


async def test_anthropic_tool_use_coupe_par_max_tokens_remonte_length(monkeypatch):
    """(2026-09-21) Un tool_use coupé par ``max_tokens`` porte un JSON
    incomplet : il doit remonter en « length » (la boucle le relance plus
    compact) — jamais en « tool_calls » exécuté avec ``{}``."""
    lines = _sse(
        {"type": "message_start", "message": {"model": "claude-sonnet-4-6", "usage": {"input_tokens": 8}}},
        {"type": "content_block_start", "index": 0,
         "content_block": {"type": "tool_use", "id": "toolu_1", "name": "write_file"}},
        {"type": "content_block_delta", "index": 0,
         "delta": {"type": "input_json_delta", "partial_json": '{"path": "a.py", "content": "def f('}},
        {"type": "content_block_stop", "index": 0},
        {"type": "message_delta", "delta": {"stop_reason": "max_tokens"}, "usage": {"output_tokens": 8192}},
        {"type": "message_stop"})
    monkeypatch.setattr(A, "_get_llm_client", lambda *a, **k: _Client(lines=lines))
    out = await A.anthropic_chat_with_tools_stream(
        [{"role": "user", "content": "écris"}],
        [{"type": "function", "function": {"name": "write_file", "parameters": {"type": "object"}}}],
        target=_TGT)
    assert out["choices"][0]["finish_reason"] == "length"


def test_finish_length_prime_sur_tool_calls():
    assert A._finish_from_stop_reason("max_tokens", has_tool_calls=True) == "length"
    assert A._finish_from_stop_reason("tool_use", has_tool_calls=True) == "tool_calls"
    assert A._finish_from_stop_reason("end_turn", has_tool_calls=False) == "stop"


async def test_anthropic_http_error_classic_returns_error_tuple(monkeypatch):
    class _C:
        def stream(self, *a, **k):
            return _Resp(status=401)   # 4xx → l'adaptateur lève puis renvoie un tuple d'erreur
    monkeypatch.setattr(A, "_get_llm_client", lambda *a, **k: _C())
    th, ct, meta = await A.anthropic_chat_stream(
        [{"role": "user", "content": "hi"}], target=_TGT)
    assert th == "" and meta.get("error") is True and "Erreur" in ct


# ── Découverte de modèles ─────────────────────────────────────────────────────
async def test_fetch_models_openai_ok(monkeypatch):
    row = {"wire": "openai", "provider_type": "openai",
           "base_url": "https://api.openai.com/v1", "api_key": "sk"}
    client = _Client(get_resp=_Resp(status=200, payload={"data": [{"id": "gpt-x"}, {"id": "gpt-y"}]}))
    monkeypatch.setattr(D, "_get_llm_client", lambda *a, **k: client)
    res = await D.fetch_models(row)
    assert res["ok"] and res["models"] == ["gpt-x", "gpt-y"]
    assert "openai.com" in client.captured["url"] and client.captured["headers"]["Authorization"] == "Bearer sk"


async def test_fetch_models_anthropic_401_falls_back_to_catalog(monkeypatch):
    row = {"wire": "anthropic", "provider_type": "anthropic",
           "base_url": "https://api.anthropic.com", "api_key": "bad"}
    monkeypatch.setattr(D, "_get_llm_client",
                        lambda *a, **k: _Client(get_resp=_Resp(status=401, payload={})))
    res = await D.fetch_models(row)
    assert res["ok"] is False and res["fallback"] == "catalog"
    assert "claude-sonnet-4-6" in res["models"]


async def test_fetch_models_manual_fallback(monkeypatch):
    row = {"wire": "openai", "provider_type": "generic", "base_url": "http://x/v1",
           "api_key": "", "models_json": "local-a, local-b"}
    monkeypatch.setattr(D, "_get_llm_client",
                        lambda *a, **k: _Client(get_resp=_Resp(status=500, payload={})))
    res = await D.fetch_models(row)
    assert res["ok"] and res["fallback"] == "manual" and res["models"] == ["local-a", "local-b"]


async def test_test_connector_401_not_ok(monkeypatch):
    row = {"wire": "openai", "provider_type": "openai", "base_url": "https://api.openai.com/v1", "api_key": "bad"}
    monkeypatch.setattr(D, "_get_llm_client",
                        lambda *a, **k: _Client(get_resp=_Resp(status=401, payload={})))
    res = await D.test_connector(row)
    assert res["ok"] is False and res["status"] == 401 and "hint" in res


# ── resolve_llm_target : chemin par défaut (sans DB) ──────────────────────────
def test_resolve_default_when_no_connector():
    t = T.resolve_llm_target("guest", None, "some-model")
    assert t.is_default and t.wire == "openai" and t.model == "some-model"


# ── Cible distante : aucun appel propre au llama-server local ─────────────────
def test_remote_sampling_only_openai_standard_keys():
    out = OAI.remote_sampling({"temperature": 0.5, "top_p": 0.9, "top_k": 40,
                               "min_p": 0.05, "max_tokens": 100, "repeat_penalty": 1.1})
    assert out == {"temperature": 0.5, "top_p": 0.9, "max_tokens": 100}  # samplers llama exclus
    assert OAI.remote_sampling(None) == {}


async def test_remote_target_skips_local_prep(monkeypatch):
    """Pour une cible distante, llama_chat_stream_tokens NE doit PAS appeler
    resolve_sampling (/props local) ni injecter les champs llama-only."""
    from llm_core import _chat_classic, _llm_params
    from llm_core._target import use_llm_target

    async def _boom(*a, **k):
        raise AssertionError("resolve_sampling appelé pour une cible distante !")
    monkeypatch.setattr(_llm_params, "resolve_sampling", _boom)

    lines = ['data: {"choices":[{"delta":{"content":"ok"}}]}',
             'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
             'data: [DONE]']
    client = _Client(lines=lines)
    monkeypatch.setattr(OAI, "_get_llm_client", lambda *a, **k: client)

    tgt = T.LlmTarget(wire="openai", provider_type="openai",
                      base_url="http://127.0.0.1:1/v1", api_key="sk", model="gpt-x", is_default=False)
    with use_llm_target(tgt):
        th, ct, meta = await _chat_classic.llama_chat_stream_tokens(
            [{"role": "user", "content": "hi"}], chat_id=None)
    assert ct == "ok"
    body = client.captured["json"]
    for f in ("id_slot", "cache_prompt", "n_cache_reuse", "timings_per_token",
              "chat_template_kwargs", "thinking_budget_tokens"):
        assert f not in body, f
    assert client.captured["url"].endswith("/v1/chat/completions")
    assert client.captured["headers"].get("Authorization") == "Bearer sk"


async def test_remote_llamacpp_keeps_payload_optimizations(monkeypatch):
    """Un connecteur llama.cpp DISTANT garde les extensions de payload (KV reuse)
    ET, depuis le 2026-09-16, les mécanismes du serveur : sampling lu sur SON
    ``/props``, sondes envoyées à SA racine — jamais au ``LLAMA_URL`` local
    (l'ancien contrat « on saute tout » laissait un connecteur llama.cpp sans
    fenêtre réelle ni épinglage de slot)."""
    from llm_core import _chat_classic, _llama_http as LH, _llm_params
    from llm_core._target import use_llm_target
    from llm_core.engines import current_engine
    from shared_infra.config import LLAMA_URL

    vus = {"sampling_engine": None, "urls": []}
    async def _spy(*a, **k):
        vus["sampling_engine"] = current_engine().key
        return {}
    monkeypatch.setattr(_llm_params, "resolve_sampling", _spy)

    class _Admin:
        async def get(self, url, **k):
            vus["urls"].append(url)
            class _R:
                status_code = 404
                text = ""
                def json(self_inner):
                    return {}
            return _R()
    monkeypatch.setattr(LH, "_get_admin_client", lambda: _Admin())

    lines = ['data: {"choices":[{"delta":{"content":"ok"}}]}',
             'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
             'data: [DONE]']
    client = _Client(lines=lines)
    monkeypatch.setattr(OAI, "_get_llm_client", lambda *a, **k: client)

    tgt = T.LlmTarget(wire="openai", provider_type="llamacpp",
                      base_url="http://other-llama:8080/v1", api_key="", model="qwen",
                      connector_id=7, is_default=False)
    with use_llm_target(tgt):
        await _chat_classic.llama_chat_stream_tokens(
            [{"role": "user", "content": "hi"}], chat_id=None, thinking_mode=True)
    body = client.captured["json"]
    assert vus["sampling_engine"] == "conn:7"          # sampling du serveur du connecteur
    for f in ("cache_prompt", "n_cache_reuse", "timings_per_token", "chat_template_kwargs"):
        assert f in body, f                            # optimisations llama.cpp gardées
    local_root = LLAMA_URL.split("/v1/")[0]
    assert vus["urls"], "aucune sonde : les mécanismes du serveur ont été sautés"
    assert all(u.startswith("http://other-llama:8080") for u in vus["urls"]), vus["urls"]
    assert not any(u.startswith(local_root) for u in vus["urls"])


async def test_local_vllm_skips_local_prep_and_sanitizes(monkeypatch):
    """Moteur LOCAL vLLM (is_default=True, provider_type='vllm') : parle
    OpenAI-standard — PAS d'appel /props local (resolve_sampling), aucun champ
    llama-only dans le body, URL = LLAMA_URL local, aucun en-tête d'auth."""
    from llm_core import _chat_classic, _llm_params
    from llm_core._target import use_llm_target
    from shared_infra.config import LLAMA_URL

    async def _boom(*a, **k):
        raise AssertionError("resolve_sampling appelé pour un moteur local non-llamacpp !")
    monkeypatch.setattr(_llm_params, "resolve_sampling", _boom)

    lines = ['data: {"choices":[{"delta":{"content":"ok"}}]}',
             'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
             'data: [DONE]']
    client = _Client(lines=lines)
    monkeypatch.setattr(OAI, "_get_llm_client", lambda *a, **k: client)

    tgt = T.LlmTarget(wire="openai", provider_type="vllm", base_url="",
                      api_key="", model="qwen", is_default=True)
    with use_llm_target(tgt):
        th, ct, meta = await _chat_classic.llama_chat_stream_tokens(
            [{"role": "user", "content": "hi"}], chat_id=None, thinking_mode=True)
    assert ct == "ok"
    body = client.captured["json"]
    for f in ("id_slot", "cache_prompt", "n_cache_reuse", "timings_per_token",
              "chat_template_kwargs", "thinking_budget_tokens"):
        assert f not in body, f
    assert client.captured["url"] == LLAMA_URL                  # moteur local → LLAMA_URL
    assert "Authorization" not in client.captured["headers"]    # local = pas d'auth
