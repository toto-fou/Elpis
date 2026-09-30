# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_thinking_reconcile.py

Couvre le correctif « réponse finale piégée dans le bloc thinking » :

  • reconcile_thinking_content  — règle UNIFIÉE de réconciliation (pure).
  • _extract_thinking           — balises fermées / unicode / <think> non fermé
                                  (dont le sous-cas « intro courte + réponse coincée »).
  • ThinkTagSplitter            — invariant : </think> scindé sur 2 chunks reste détecté.
  • Intégration chemin CLASSIC  — <think> non fermé / reasoning_content-only ⇒ la
                                  réponse est promue en content + meta thinking_promoted.
  • Intégration chemin OUTILS   — réponse aspirée dans le thinking ⇒ promue dans la
                                  bulle, thinking vidé (anti double-affichage), event
                                  thinking_content="" émis.

Aucun réseau : stream LLM + helpers availability/vision/ctx monkeypatchés.
"""
from __future__ import annotations

import pytest

from llm_core import _chat_classic as _ccl, _chat_with_tools as _cwt, _llm_params
from llm_core._chat_classic import _extract_thinking
from llm_core._stream_tag_parser import ThinkTagSplitter
from llm_core._thinking_reconcile import reconcile_thinking_content
from llm_core.providers import openai_compat as _oai


# ════════════════════════════════════════════════════════════════════════════
#  reconcile_thinking_content — la règle pure
# ════════════════════════════════════════════════════════════════════════════
def test_reconcile_keeps_content_when_present():
    # Cas normal : une réponse visible existe → on ne déplace JAMAIS le reasoning.
    assert reconcile_thinking_content("raisonnement", "réponse") == ("raisonnement", "réponse")


def test_reconcile_promotes_when_content_empty():
    # Réponse aspirée dans le thinking (content vide) → promotion intégrale.
    assert reconcile_thinking_content("La vraie réponse.", "") == ("", "La vraie réponse.")


def test_reconcile_promote_ignored_with_tool_calls():
    # Un content vide est NORMAL quand le tour produit des appels d'outil :
    # on n'inhibe la promotion (le modèle répondra au tour suivant).
    assert reconcile_thinking_content("plan d'action", "", had_tool_calls=True) == ("plan d'action", "")


def test_reconcile_appends_short_content_with_unclosed_think():
    # Intro creuse + vraie réponse coincée dans un <think> non fermé.
    thinking = "X" * 200
    th, ct = reconcile_thinking_content(thinking, "ok", in_think=True)
    assert ct.startswith("ok")
    assert ct.endswith(thinking)
    assert th == thinking          # le thinking reste visible — rien n'est perdu


def test_reconcile_no_append_when_tag_was_closed():
    # Même forme, mais la balise a été FERMÉE (in_think=False) : une réponse
    # légitimement courte avec un long raisonnement ne doit PAS être polluée.
    thinking = "X" * 200
    assert reconcile_thinking_content(thinking, "42", in_think=False) == (thinking, "42")


def test_reconcile_both_empty():
    assert reconcile_thinking_content("", "") == ("", "")


def test_reconcile_promote_inhibited_on_length():
    # Coupure par le plafond EN PLEIN raisonnement : PAS une réponse — la
    # promotion est inhibée (l'appelant arme truncated_in_think).
    th, ct = reconcile_thinking_content("raisonnement coupé", "", finish="length")
    assert (th, ct) == ("raisonnement coupé", "")


def test_reconcile_append_inhibited_on_length():
    # Même exception pour la branche APPEND : un <think> non fermé issu d'une
    # coupure est du raisonnement tronqué — le recopier dans la bulle est la
    # variante « graduelle » du bug « le thinking déborde dans le chat ».
    thinking = "X" * 200
    th, ct = reconcile_thinking_content(thinking, "ok", in_think=True,
                                        finish="length")
    assert (th, ct) == (thinking, "ok")


# ════════════════════════════════════════════════════════════════════════════
#  _extract_thinking — extraction post-stream
# ════════════════════════════════════════════════════════════════════════════
def test_extract_closed_tags():
    th, clean = _extract_thinking("avant <think>raisonnement</think> après")
    assert th == "raisonnement"
    assert "raisonnement" not in clean
    assert "avant" in clean and "après" in clean


def test_extract_unicode_variant():
    th, clean = _extract_thinking("<|thinking|>réflexion<|/thinking|>réponse")
    assert th == "réflexion"
    assert clean == "réponse"


def test_extract_unclosed_orphan_prefix_kept_as_content():
    # Préfixe trivial (<20) → balise orpheline strippée, tout reste en content.
    th, clean = _extract_thinking("ok<think>la suite reste visible")
    assert th == ""
    assert "la suite reste visible" in clean


def test_extract_unclosed_substantial_prefix_legacy_split():
    # Préfixe substantiel + suffixe comparable → comportement legacy : préfixe =
    # réponse, suffixe = raisonnement tronqué.
    prefix = "Voici la réponse complète à ta question importante."  # >80 chars
    th, clean = _extract_thinking(prefix + "<think>court raisonnement")
    assert clean == prefix
    assert th == "court raisonnement"


def test_extract_unclosed_short_prefix_dominating_suffix_promoted():
    # CORRECTIF Cas 3a : intro COURTE (≤80) + suffixe qui la DOMINE (≥3×) →
    # la vraie réponse est dans le suffixe, on garde TOUT en content (sinon elle
    # disparaîtrait dans le panneau thinking).
    suffix = "La réponse réelle et détaillée tient ici, bien plus longue que l'intro. " * 3
    th, clean = _extract_thinking("Bien sûr : " + "<think>" + suffix)
    assert th == ""
    assert "réponse réelle" in clean


def test_extract_no_tags():
    assert _extract_thinking("juste du texte") == ("", "juste du texte")


def test_extract_truncated_routes_suffix_to_thinking():
    # ``truncated=True`` (finish=length) : le suffixe d'un <think> non fermé
    # est du raisonnement tronqué — les promotions anti-bulle-vide 3a/3b sont
    # inhibées, quel que soit le rapport de tailles.
    suffix = "raisonnement bien plus long que l'intro, coupé net par le cap. " * 3
    th, clean = _extract_thinking("Bien sûr : " + "<think>" + suffix,
                                  truncated=True)
    assert th.startswith("raisonnement")
    assert clean == "Bien sûr :"
    # 3b (préfixe trivial) : idem, le suffixe part en thinking.
    th2, clean2 = _extract_thinking("<think>pensées coupées", truncated=True)
    assert th2 == "pensées coupées" and clean2 == ""


def test_extract_truncated_closed_tags_unchanged():
    # Un bloc FERMÉ n'est pas affecté par le flag (cas 1 prioritaire).
    th, clean = _extract_thinking("avant <think>r</think> après", truncated=True)
    assert th == "r" and "avant" in clean


# ════════════════════════════════════════════════════════════════════════════
#  ThinkTagSplitter — </think> scindé sur une frontière de chunk
# ════════════════════════════════════════════════════════════════════════════
def _drain(splitter, chunks):
    th, ct = [], []
    for c in chunks:
        for kind, text in splitter.feed(c):
            (th if kind == "thinking" else ct).append(text)
    for kind, text in splitter.flush():
        (th if kind == "thinking" else ct).append(text)
    return "".join(th), "".join(ct)


def test_splitter_close_tag_split_across_chunks():
    # </think> arrive en deux morceaux : "...</thi" + "nk>réponse".
    sp = ThinkTagSplitter()
    th, ct = _drain(sp, ["<think>raisonnement</thi", "nk>la réponse visible"])
    assert th == "raisonnement"
    assert ct == "la réponse visible"
    assert sp.in_think is False


def test_splitter_unclosed_leaves_in_think():
    # <think> jamais fermé → tout reste en thinking, in_think=True à la fin.
    sp = ThinkTagSplitter()
    th, ct = _drain(sp, ["<think>tout est ", "du raisonnement"])
    assert th == "tout est du raisonnement"
    assert ct == ""
    assert sp.in_think is True


# ════════════════════════════════════════════════════════════════════════════
#  Intégration — chemin CLASSIC (llama_chat_stream_tokens)
# ════════════════════════════════════════════════════════════════════════════
class _FakeResp:
    status_code = 200

    def __init__(self, lines):
        self._lines = lines

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_a):
        return False

    async def aiter_lines(self):
        for line in self._lines:
            yield line

    async def aclose(self):
        pass


class _FakeClient:
    def __init__(self, lines):
        self._lines = lines

    def stream(self, _method, _url, json=None, headers=None):  # noqa: A002
        return _FakeResp(self._lines)


@pytest.fixture(autouse=True)
def _no_sampling(monkeypatch):
    async def _fake_sampling(*_a, **_k):
        return {}
    monkeypatch.setattr(_llm_params, "resolve_sampling", _fake_sampling)


async def test_classic_unclosed_think_promotes_to_content(monkeypatch):
    # <think> ouvert puis la VRAIE réponse, jamais refermé : sans recovery, la
    # bulle serait vide et le bloc serait re-titré « Réponse ». On promeut.
    lines = [
        'data: {"choices":[{"delta":{"content":"<think>"}}]}',
        'data: {"choices":[{"delta":{"content":"La vraie reponse est 42."}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],'
        '"usage":{"prompt_tokens":5,"completion_tokens":6}}',
        "data: [DONE]",
    ]
    monkeypatch.setattr(_oai, "_get_llm_client", lambda *a, **k: _FakeClient(lines))

    thinking, content, meta = await _ccl.llama_chat_stream_tokens(
        [{"role": "user", "content": "?"}],
    )
    assert content == "La vraie reponse est 42."
    assert thinking == ""
    assert meta.get("thinking_promoted") is True


async def test_classic_reasoning_content_only_promotes(monkeypatch):
    # Tout passe par le canal natif reasoning_content, AUCUN content : le splitter
    # <think> n'est jamais engagé (in_think reste False) → la recovery doit
    # PROMOUVOIR malgré tout (corrige le contournement du filet legacy).
    lines = [
        'data: {"choices":[{"delta":{"reasoning_content":"Apres reflexion, la reponse finale."}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],'
        '"usage":{"prompt_tokens":5,"completion_tokens":6}}',
        "data: [DONE]",
    ]
    monkeypatch.setattr(_oai, "_get_llm_client", lambda *a, **k: _FakeClient(lines))

    thinking, content, meta = await _ccl.llama_chat_stream_tokens(
        [{"role": "user", "content": "?"}],
    )
    assert content == "Apres reflexion, la reponse finale."
    assert thinking == ""
    assert meta.get("thinking_promoted") is True


async def test_classic_normal_response_not_promoted(monkeypatch):
    # Cas sain : <think> fermé + réponse visible → rien n'est promu/déplacé.
    lines = [
        'data: {"choices":[{"delta":{"content":"<think>raisonnement</think>"}}]}',
        'data: {"choices":[{"delta":{"content":"Reponse visible."}}]}',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
        "data: [DONE]",
    ]
    monkeypatch.setattr(_oai, "_get_llm_client", lambda *a, **k: _FakeClient(lines))

    thinking, content, meta = await _ccl.llama_chat_stream_tokens(
        [{"role": "user", "content": "?"}],
    )
    assert content == "Reponse visible."
    assert thinking == "raisonnement"
    assert meta.get("thinking_promoted") is False


# ════════════════════════════════════════════════════════════════════════════
#  Intégration — chemin OUTILS (run_chat_multi_mcp)
# ════════════════════════════════════════════════════════════════════════════
async def _anoop(*_a, **_k):
    return None


async def _avision(*_a, **_k):
    return False


async def _actx(*_a, **_k):
    return 0


def _patch_tools_env(monkeypatch):
    monkeypatch.setattr(_cwt, "verify_llm_availability", _anoop)
    monkeypatch.setattr(_cwt, "_model_supports_vision", _avision)
    monkeypatch.setattr(_cwt, "get_model_context_size", _actx)


async def test_tools_answer_trapped_in_thinking_promoted(monkeypatch):
    _patch_tools_env(monkeypatch)

    # Le stream interne émet la réponse dans le canal THINKING (on_thinking_token)
    # et ne renvoie AUCUN content — reproduit un <think> non fermé en mode outils.
    async def _fake_stream(messages, tools_payload, **kw):
        on_t = kw.get("on_thinking_token")
        if on_t:
            await on_t("Voici la vraie reponse coincee dans le thinking.")
        return {
            "choices": [{
                "finish_reason": "stop",
                "message": {"role": "assistant", "content": None, "tool_calls": None},
            }],
            "usage": {"prompt_tokens": 7, "completion_tokens": 9},
            "timings": {},
        }

    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", _fake_stream)

    events = []

    async def _on_event(ev):
        events.append(ev)

    final, _ev, metrics = await _cwt.run_chat_multi_mcp(
        [{"role": "user", "content": "?"}],
        mcp_configs=[], builtin_tools=None, username="u", on_event=_on_event,
    )

    # Réponse promue dans la bulle …
    assert "coincee" in final
    # … thinking vidé pour la persistance/méta (pas de double affichage) …
    assert (metrics.get("thinking") or "") == ""
    # … et un thinking_content="" a été émis pour effacer le bloc live.
    assert any(e.get("type") == "thinking_content" and e.get("text") == "" for e in events)


async def test_tools_normal_response_unchanged(monkeypatch):
    _patch_tools_env(monkeypatch)

    async def _fake_stream(messages, tools_payload, **kw):
        return {
            "choices": [{
                "finish_reason": "stop",
                "message": {"role": "assistant", "content": "Reponse complete.",
                            "tool_calls": None},
            }],
            "usage": {}, "timings": {},
        }

    monkeypatch.setattr(_cwt, "_llama_chat_with_tools_stream", _fake_stream)

    final, _ev, _metrics = await _cwt.run_chat_multi_mcp(
        [{"role": "user", "content": "?"}],
        mcp_configs=[], builtin_tools=None, username="u",
    )
    assert final.strip() == "Reponse complete."
