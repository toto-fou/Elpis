# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_flux_transport_2026_09_24.py — PR « flux et transport »
de l'audit du cœur du harnais (2026-09-24).

Constats couverts : 1, 1b, 3, 4, 4b, 7, 14, 15 et la clé du disjoncteur.
Aucun réseau : clients HTTP, Redis et routes de flux sont simulés.
"""
from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from types import SimpleNamespace

import httpx
import pytest

from llm_core import _chat_with_tools as W
from llm_core import _llm_params
from llm_core._llm_retry import (
    KIND_CONTEXT_OVERFLOW, KIND_FORBIDDEN, KIND_RATE_LIMITED,
    LLMFailure, ProviderError, llm_error_is_fatal, llm_error_kind,
    provider_message,
)
from llm_core._stream_tag_parser import ThinkTagSplitter
from llm_core.providers import anthropic as A
from llm_core.providers import openai_compat as _oai
from llm_core.providers.llamacpp import SseStreamResult, consume_llama_sse


# ── Faux transport ────────────────────────────────────────────────────────────
class _Resp:
    """Flux SSE factice ; ``cut`` lève une coupure de transport après les
    lignes (l'itérateur SSE meurt en route)."""

    def __init__(self, lines, status=200, cut=None):
        self._lines = lines
        self.status_code = status
        self._cut = cut

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_a):
        return False

    async def aiter_lines(self):
        for line in self._lines:
            yield line
        if self._cut is not None:
            raise self._cut

    async def aread(self):
        return b""

    async def aclose(self):
        pass


class _Client:
    def __init__(self, resp, posts=()):
        self._resp = resp
        self._posts = list(posts)
        self.n_stream = 0

    def stream(self, *_a, **_k):
        self.n_stream += 1
        return self._resp

    async def post(self, *_a, **_k):
        return self._posts.pop(0)


def _data(obj):
    return "data: " + json.dumps(obj, ensure_ascii=False)


def _tool(name):
    return {"type": "function", "function": {"name": name, "parameters": {}}}


@pytest.fixture
def transport(monkeypatch):
    async def _fake_sampling(*_a, **_k):
        return {}

    async def _no_pause(*_a, **_k):
        return None

    monkeypatch.setattr(_llm_params, "resolve_sampling", _fake_sampling)
    monkeypatch.setattr(W, "_llm_retry_pause", _no_pause)

    def _install(client):
        monkeypatch.setattr(_oai, "_get_llm_client", lambda *a, **k: client)
        return client

    return _install


# ── 1. Coupure silencieuse : aucune récupération depuis le raisonnement ──────
_THINK_CALL = ("Je vais écrire le fichier.\n<tool_call>\n<function=write_file>\n"
               "<parameter=path>\na.py\n</parameter>\n<parameter=content>\n"
               "def f(")


async def test_coupure_silencieuse_n_execute_pas_l_appel_du_raisonnement(transport):
    """Flux fermé SANS finish_reason, appel non fermé dans le think : il ne
    doit PAS être promu en tool_call (il serait exécuté amputé)."""
    transport(_Client(_Resp([
        _data({"choices": [{"delta": {"reasoning_content": _THINK_CALL}}]}),
    ])))
    out = await W._llama_chat_with_tools_stream(
        [{"role": "user", "content": "écris"}], [_tool("write_file")])
    ch = out["choices"][0]
    assert not ch["message"]["tool_calls"], "appel tronqué promu puis exécuté"
    assert ch["finish_reason"] == "length"
    assert out.get("partial") is True


async def test_la_recuperation_reste_active_sur_un_stop(transport):
    """Garde-fou : sur une fin PROPRE (``stop``), la récupération historique
    fonctionne toujours."""
    fermé = _THINK_CALL + "x): pass\n</parameter>\n</function>\n</tool_call>"
    transport(_Client(_Resp([
        _data({"choices": [{"delta": {"reasoning_content": fermé}}]}),
        _data({"choices": [{"delta": {}, "finish_reason": "stop"}]}),
    ])))
    out = await W._llama_chat_with_tools_stream(
        [{"role": "user", "content": "écris"}], [_tool("write_file")])
    ch = out["choices"][0]
    assert ch["finish_reason"] == "tool_calls"
    assert ch["message"]["tool_calls"][0]["function"]["name"] == "write_file"


# ── 1b. Repli sans outils après un 500 : ``length`` conservé ─────────────────
def _http(status, payload=None):
    req = httpx.Request("POST", "http://llm/v1/chat/completions")
    if payload is None:
        return httpx.Response(status, request=req)
    return httpx.Response(status, json=payload, request=req)


async def test_repli_500_sans_outils_propage_length(transport):
    texte = ("<tool_call>\n<function=write_file>\n<parameter=path>\na.py\n"
             "</parameter>\n<parameter=content>\ndef f(")
    transport(_Client(_Resp([], status=500), posts=[
        _http(500),                                   # étape 1 : échec
        _http(200, {"choices": [{"finish_reason": "length",
                                 "message": {"content": texte}}]}),
    ]))
    out = await W._llama_chat_with_tools_stream(
        [{"role": "user", "content": "écris"}], [_tool("write_file")])
    assert out["choices"][0]["finish_reason"] == "length", \
        "le vrai motif de fin est jeté : l'appel tronqué serait exécuté"


async def test_repli_500_sans_outils_prose_tronquee_reste_length(transport):
    transport(_Client(_Resp([], status=500), posts=[
        _http(500),
        _http(200, {"choices": [{"finish_reason": "length",
                                 "message": {"content": "Une réponse coup"}}]}),
    ]))
    out = await W._llama_chat_with_tools_stream(
        [{"role": "user", "content": "q"}], [_tool("read_file")])
    assert out["choices"][0]["finish_reason"] == "length"


# ── 7. Régression H2 : fragments d'arguments déjà émis → pas de retry ────────
async def test_coupure_pendant_les_arguments_ne_rejoue_pas_les_deltas(transport):
    deltas = []

    async def _on_delta(i, n, a):
        deltas.append((i, n, a))

    client = transport(_Client(_Resp([
        _data({"choices": [{"delta": {"tool_calls": [{
            "index": 0, "id": "c0",
            "function": {"name": "write_file",
                         "arguments": '{"path": "a.py", "content": "de'}}]}}]}),
    ], cut=httpx.ReadError("coupure"))))
    out = await W._llama_chat_with_tools_stream(
        [{"role": "user", "content": "écris"}], [_tool("write_file")],
        on_tool_call_delta=_on_delta)
    assert client.n_stream == 1, "un retry a rejoué les tool_call_delta"
    assert len(deltas) == 1
    ch = out["choices"][0]
    assert out.get("partial") is True and ch["finish_reason"] == "length"
    assert not ch["message"]["tool_calls"]


# ── 14. Partiel de transport : arrêt du moteur + texte de la reprise ─────────
async def test_partiel_de_transport_arrete_la_session(transport, monkeypatch):
    fired = []
    monkeypatch.setattr(W, "_fire_cancel_stream",
                        lambda *a, **k: fired.append(a))
    transport(_Client(_Resp([
        _data({"choices": [{"delta": {"content": "Bonjour"}}]}),
    ], cut=httpx.ReadError("coupure"))))
    out = await W._llama_chat_with_tools_stream(
        [{"role": "user", "content": "q"}], [_tool("read_file")])
    assert out.get("partial") is True
    assert fired, "la session nommée continuerait de générer sur le slot"


async def test_partiel_sur_erreur_du_fournisseur_n_arrete_rien(transport, monkeypatch):
    """Une erreur SSE du fournisseur n'a rien laissé tourner côté moteur."""
    fired = []
    monkeypatch.setattr(W, "_fire_cancel_stream",
                        lambda *a, **k: fired.append(a))
    transport(_Client(_Resp([
        _data({"choices": [{"delta": {"content": "Bonjour"}}]}),
        _data({"error": {"code": 500, "message": "boom"}}),
    ])))
    out = await W._llama_chat_with_tools_stream(
        [{"role": "user", "content": "q"}], [_tool("read_file")])
    assert out.get("partial") is True
    assert not fired


async def test_reprise_coupee_garde_le_texte_deja_affiche(monkeypatch):
    """La reprise meurt en route APRÈS avoir affiché du texte neuf : le
    partiel doit couvrir ce que l'écran a reçu."""
    from llm_core.providers import llama_stream as LS

    async def _lookup(*_a, **_k):
        return {"conv": {"total_bytes": 10, "is_done": False}}

    @asynccontextmanager
    async def _resume(*_a, **_k):
        yield _Resp([
            _data({"choices": [{"delta": {"content": "Bonjour"}}]}),
            _data({"choices": [{"delta": {"content": " le monde"}}]}),
        ], cut=httpx.ReadError("seconde coupure"))

    monkeypatch.setattr(LS, "lookup_streams", _lookup)
    monkeypatch.setattr(LS, "resume_request", _resume)
    previous = SseStreamResult()
    tampon = previous.content_parts
    tampon.append("Bonjour")
    shown = []

    async def _on_content(seg):
        shown.append(seg)

    res = await W._resume_cut_stream(
        None, SimpleNamespace(base_url="http://h:8080", is_default=True,
                              api_key=""), "conv", "m",
        httpx.ReadError("x"), req_id="r", user_id="u", previous=previous,
        is_cancelled=None, on_thinking_token=None,
        on_content_token=_on_content, stream_timeout=None)
    assert res is None
    assert "".join(shown) == " le monde"
    assert "".join(tampon) == "Bonjour le monde", \
        "le partiel est plus court que ce que l'utilisateur a lu"


def test_keep_resumed_text_ne_raccourcit_jamais():
    prev, fresh = SseStreamResult(), SseStreamResult()
    prev.content_parts.append("abcdef")
    fresh.content_parts.append("abc")
    W._keep_resumed_text(prev, fresh)
    assert prev.content() == "abcdef"


# ── 15a. Erreurs SSE en cours de flux : levées, typées, classables ──────────
async def _consume(lines):
    return await consume_llama_sse(
        _Resp(lines), tag_splitter=ThinkTagSplitter(), req_id="r", user_id="u")


async def test_ligne_error_llamacpp_devient_un_depassement_de_contexte():
    with pytest.raises(ProviderError) as ei:
        await _consume([
            'error: {"code": 400, "message": "the request exceeds the '
            'available context size, try increasing it", '
            '"type": "exceed_context_size_error"}',
        ])
    e = ei.value
    assert isinstance(e, httpx.HTTPStatusError)
    assert llm_error_kind(e) == KIND_CONTEXT_OVERFLOW
    assert llm_error_is_fatal(e)
    assert "exceeds the available context size" in provider_message(e)


async def test_data_error_sans_choices_429_est_un_debit_limite():
    with pytest.raises(ProviderError) as ei:
        await _consume([
            _data({"choices": [{"delta": {"content": "a"}}]}),
            _data({"error": {"message": "Rate limit reached",
                             "type": "rate_limit_error"}}),
        ])
    assert ei.value.response.status_code == 429
    assert llm_error_kind(ei.value) == KIND_RATE_LIMITED
    assert not llm_error_is_fatal(ei.value)


async def test_erreur_sse_ne_part_pas_en_retry_aveugle(transport):
    """Dépassement de contexte en cours de flux (0 token) : UNE tentative,
    et la famille remonte jusqu'à la boucle (compaction possible)."""
    client = transport(_Client(_Resp([
        _data({"error": {"code": 400, "type": "exceed_context_size_error",
                         "message": "the request exceeds the available "
                                    "context size"}}),
    ])))
    with pytest.raises(LLMFailure) as ei:
        await W._llama_chat_with_tools_stream(
            [{"role": "user", "content": "q"}], [_tool("read_file")])
    assert client.n_stream == 1
    assert ei.value.kind == KIND_CONTEXT_OVERFLOW


def test_une_erreur_sse_n_est_pas_un_refus_de_continue_final_message():
    from llm_core._chat_classic import _http_4xx
    from llm_core._llm_retry import provider_http_error
    assert not _http_4xx(provider_http_error(400, '{"error": "x"}'))


# ── 15b. Delta mixte reasoning_content + content ─────────────────────────────
async def test_delta_mixte_garde_le_raisonnement_et_la_reponse():
    r = await _consume([
        _data({"choices": [{"delta": {"reasoning_content": "je pense",
                                      "content": "Réponse"}}]}),
        _data({"choices": [{"delta": {"reasoning_content": "encore",
                                      "tool_calls": [{"index": 0, "id": "c",
                                                      "function": {"name": "f",
                                                                   "arguments": "{}"}}]},
                            "finish_reason": "tool_calls"}]}),
    ])
    assert r.thinking() == "je penseencore"
    assert r.content() == "Réponse"
    assert r.built_tool_calls()[0]["function"]["name"] == "f"


# ── 4. Anthropic : erreurs typées ────────────────────────────────────────────
_TGT = SimpleNamespace(base_url="https://api.anthropic.com", api_key="sk",
                       model="claude-sonnet-4-6")


class _AResp(_Resp):
    def __init__(self, lines=(), status=200, body=b""):
        super().__init__(list(lines), status=status)
        self._body = body

    async def aread(self):
        return self._body


def _anthropic(monkeypatch, resp):
    class _C:
        def stream(self, *_a, **_k):
            return resp
    monkeypatch.setattr(A, "_get_llm_client", lambda *a, **k: _C())


async def _a_tools():
    return await A.anthropic_chat_with_tools_stream(
        [{"role": "user", "content": "q"}], [_tool("f")], target=_TGT)


@pytest.mark.parametrize("status,body,kind", [
    (400, b'{"type":"error","error":{"type":"invalid_request_error",'
          b'"message":"prompt is too long: 250000 tokens > 200000 maximum"}}',
     KIND_CONTEXT_OVERFLOW),
    (429, b'{"type":"error","error":{"type":"rate_limit_error","message":"slow"}}',
     KIND_RATE_LIMITED),
    (529, b'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
     KIND_RATE_LIMITED),
    (401, b'{"type":"error","error":{"type":"authentication_error","message":"bad key"}}',
     KIND_FORBIDDEN),
])
async def test_anthropic_erreur_http_classee(monkeypatch, status, body, kind):
    _anthropic(monkeypatch, _AResp(status=status, body=body))
    with pytest.raises(httpx.HTTPStatusError) as ei:
        await _a_tools()
    assert llm_error_kind(ei.value) == kind
    assert provider_message(ei.value)


async def test_anthropic_erreur_sse_overloaded_est_un_debit_limite(monkeypatch):
    ev = {"type": "error", "error": {"type": "overloaded_error",
                                     "message": "Overloaded"}}
    _anthropic(monkeypatch, _AResp([f"event: error", _data(ev)]))
    with pytest.raises(httpx.HTTPStatusError) as ei:
        await _a_tools()
    assert ei.value.response.status_code == 529
    assert llm_error_kind(ei.value) == KIND_RATE_LIMITED
    assert not llm_error_is_fatal(ei.value)


# ── 4b. Anthropic : jamais de bloc texte vide ────────────────────────────────
def _blocs_texte(msgs):
    return [b for m in msgs for b in m["content"] if b.get("type") == "text"]


def test_anthropic_aucun_bloc_texte_vide_et_alternance_tenue():
    _, msgs = A.to_anthropic_messages([
        {"role": "system", "content": "s"},
        {"role": "user", "content": "bonjour"},
        {"role": "assistant", "content": "   "},          # vide : omis
        {"role": "user", "content": "tu es là ?"},
        {"role": "assistant", "content": None, "tool_calls": [
            {"id": "c0", "type": "function",
             "function": {"name": "f", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "c0", "content": "ok"},
        {"role": "user", "content": [{"type": "text", "text": " "}]},  # vide
        {"role": "assistant", "content": ""},
        {"role": "user", "content": "suite"},
    ])
    assert all(b["text"].strip() for b in _blocs_texte(msgs))
    roles = [m["role"] for m in msgs]
    assert all(a != b for a, b in zip(roles, roles[1:])), roles
    # Les deux user consécutifs sont fusionnés, dans l'ordre.
    assert [b["text"] for b in msgs[0]["content"]] == ["bonjour", "tu es là ?"]
    # tool_result en tête du user qui suit le tool_use.
    assert msgs[2]["content"][0]["type"] == "tool_result"
    assert msgs[2]["content"][-1] == {"type": "text", "text": "suite"}


# ── 3. Verrou Redis : le plafond « low » n'ignore jamais un autre modèle ────
class _FakeRedis:
    def __init__(self, script):
        self.script = list(script)
        self.acquire_args = []

    async def eval(self, lua, _n, _key, *args):
        from llm_core._scheduling import _locks as L
        if lua == L._LUA_ACQUIRE:
            self.acquire_args.append(args)
            return json.dumps(self.script.pop(0))
        return json.dumps({"ok": True})

    async def publish(self, *_a):
        return 0


async def _acquire_low(monkeypatch, script):
    from llm_core._scheduling import _concurrency as C
    from llm_core._scheduling import _locks as L
    monkeypatch.setattr(C, "LOW_WAIT_CAP_S", 0.0)
    lock = L.DistributedModelExclusivityLock(namespace="test")
    fake = _FakeRedis(script)
    lock._redis = fake

    async def _quick(timeout=None):
        await asyncio.sleep(0)
        return False

    lock._wait_wakeup = _quick
    async with lock.acquire_for("B", priority="low"):
        pass
    return fake


async def test_redis_low_attend_toujours_l_autre_modele(monkeypatch):
    """Plafond dépassé mais un AUTRE modèle tourne : on attend, et on ne
    passe qu'une fois INSCRIT par le script."""
    fake = await _acquire_low(monkeypatch, [
        {"acquired": False, "wait_for": "model"},
        {"acquired": False, "wait_for": "model"},
        {"acquired": True},
    ])
    assert len(fake.acquire_args) == 3, \
        "le plafond a laissé passer sans enregistrement dans active_locks"
    assert not fake.script


async def test_redis_low_plafond_leve_le_portail_puis_s_inscrit(monkeypatch):
    fake = await _acquire_low(monkeypatch, [
        {"acquired": False, "wait_for": "grace", "grace_remaining": 5},
        {"acquired": True},
    ])
    assert len(fake.acquire_args) == 2, "passage sans inscription"
    assert fake.acquire_args[0][-1] == "0"
    assert fake.acquire_args[1][-1] == "1", "le portail n'a pas été levé"


# ── Faible : clé du disjoncteur ──────────────────────────────────────────────
def test_cle_du_disjoncteur_resout_le_modele_effectif(monkeypatch):
    import shared_infra.config as cfg
    from llm_core._scheduling._engines import breaker_key
    monkeypatch.setattr(cfg, "LLAMA_MODEL", "qwen-defaut")
    assert breaker_key(None, None, SimpleNamespace(model=None)) == "qwen-defaut"
    assert breaker_key(None, None, SimpleNamespace(model="m1")) == "m1"
    assert breaker_key(None, "explicite") == "explicite"
