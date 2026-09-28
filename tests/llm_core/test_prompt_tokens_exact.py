# SPDX-License-Identifier: MIT
"""tests/llm_core/test_prompt_tokens_exact.py

Comptage EXACT du prompt via ``/apply-template`` + ``/tokenize add_special``
(``count_rendered_prompt_tokens_exact``). C'est le fix du biais des compteurs :
le comptage par message rate la structure du chat template (tokens spéciaux,
prompt de génération, embedding des tools, BOS) → sous-compte system+tools.

``_llama_post`` est monkeypatché → aucun réseau. Un faux serveur rend le prompt
via /apply-template et le tokenise via /tokenize (len + BOS si add_special).
"""
from __future__ import annotations

import pytest

from llm_core import _llama_http


@pytest.fixture(autouse=True)
def _clear_tok_cache():
    _llama_http._TOKENIZE_CACHE.clear()
    yield
    _llama_http._TOKENIZE_CACHE.clear()


def _fake_server(monkeypatch, *, apply_template_ok=True, seen=None):
    """Installe un faux ``_llama_post`` : /apply-template rend un prompt, /tokenize
    renvoie len(content) (+1 pour le BOS si add_special)."""
    async def fake_post(path, body, timeout=5.0, **_kw):
        if seen is not None:
            seen.append((path, body))
        if path == "/apply-template":
            if not apply_template_ok:
                return {"_status": 404}
            # Rendu = concat des rôles + contents, façon template (peu importe
            # la forme exacte : ce qui compte est que le RENDU inclut plus que
            # le texte brut par message).
            msgs = body.get("messages", [])
            rendered = "<|im_start|>".join(
                f"{m.get('role','')}:{m.get('content','')}" for m in msgs
            )
            if body.get("tools"):
                rendered += "<tools>" + str(body["tools"])
            return {"_status": 200, "prompt": rendered}
        if path == "/tokenize":
            content = body.get("content", "")
            n = len(content) + (1 if body.get("add_special") else 0)
            return {"_status": 200, "tokens": list(range(n))}
        return {"_status": 404}

    monkeypatch.setattr(_llama_http, "_llama_post", fake_post)


async def test_rendered_exact_posts_apply_template_then_tokenizes_with_add_special(monkeypatch):
    seen = []
    _fake_server(monkeypatch, seen=seen)
    msgs = [{"role": "system", "content": "SYS"}, {"role": "user", "content": "hi"}]
    n = await _llama_http.count_rendered_prompt_tokens_exact(msgs)

    # /apply-template appelé, puis /tokenize AVEC add_special (le BOS +1).
    paths = [p for p, _ in seen]
    assert paths == ["/apply-template", "/tokenize"]
    tok_body = seen[1][1]
    assert tok_body.get("add_special") is True
    rendered = "system:SYS<|im_start|>user:hi"
    assert n == len(rendered) + 1  # +1 = BOS


async def test_rendered_exact_beats_per_message_estimate(monkeypatch):
    """Le compte exact (structure du template incluse) doit DÉPASSER la simple
    somme des textes bruts par message — c'est exactement le biais corrigé."""
    _fake_server(monkeypatch)
    msgs = [{"role": "system", "content": "S"}, {"role": "user", "content": "u"}]
    exact = await _llama_http.count_rendered_prompt_tokens_exact(msgs)
    naive = len("system\nS") + len("user\nu")  # ~ ancienne approche par message
    assert exact > 0
    assert exact >= naive  # inclut délimiteurs de template + BOS


async def test_falls_back_to_none_when_apply_template_absent(monkeypatch):
    _fake_server(monkeypatch, apply_template_ok=False)
    msgs = [{"role": "user", "content": "hi"}]
    assert await _llama_http.count_rendered_prompt_tokens_exact(msgs) is None


async def test_empty_messages_returns_zero(monkeypatch):
    _fake_server(monkeypatch)
    assert await _llama_http.count_rendered_prompt_tokens_exact([]) == 0


async def test_tools_included_in_render(monkeypatch):
    _fake_server(monkeypatch)
    msgs = [{"role": "user", "content": "x"}]
    tools = [{"type": "function", "function": {"name": "grep"}}]
    with_tools = await _llama_http.count_rendered_prompt_tokens_exact(msgs, tools)
    without = await _llama_http.count_rendered_prompt_tokens_exact(msgs)
    assert with_tools > without  # le schéma des tools compte dans le prompt


async def test_multimodal_flattened_for_template(monkeypatch):
    """Un content multimodal (liste) ne doit pas casser /apply-template : les
    blocs image sont retirés (forfait ajouté ailleurs), le texte est conservé."""
    seen = []
    _fake_server(monkeypatch, seen=seen)
    msgs = [{
        "role": "user",
        "content": [
            {"type": "text", "text": "abc"},
            {"type": "image_url", "image_url": {"url": "data:..."}},
        ],
    }]
    n = await _llama_http.count_rendered_prompt_tokens_exact(msgs)
    # le message envoyé à /apply-template a un content STRING (texte aplati)
    sent_msgs = seen[0][1]["messages"]
    assert sent_msgs[0]["content"] == "abc"
    assert n > 0


async def test_count_tokens_for_messages_prefers_exact(monkeypatch):
    """La porte de compression (count_tokens_for_messages) utilise le compte
    exact quand /apply-template répond."""
    _fake_server(monkeypatch)
    msgs = [{"role": "user", "content": "hello"}]
    total = await _llama_http.count_tokens_for_messages(msgs)
    rendered = "user:hello"
    assert total == len(rendered) + 1  # BOS ; PAS l'ancien len("user\nhello")+4


def test_approx_prompt_tokens_compte_tool_calls_et_images():
    """Repli de la pré-porte de compression : l'approximation doit voir les
    tool_calls (le gros d'un historique agentique) et les images — sinon la
    porte s'ouvrirait trop tard sur les runs outillés quand aucune mesure
    réelle (usage serveur) n'est encore disponible."""
    from llm_core.context.tokens import (
        IMAGE_TOKEN_COST,
        approx_prompt_tokens,
        est_tokens_message,
    )

    # tool_calls : name + arguments comptés (pas seulement content).
    msgs_tc = [{"role": "assistant", "content": None, "tool_calls": [
        {"id": "1", "type": "function",
         "function": {"name": "write_file", "arguments": "a" * 400}}]}]
    with_args = approx_prompt_tokens(msgs_tc)
    without = approx_prompt_tokens([{"role": "assistant", "content": None}])
    assert with_args > without, "les arguments des tool_calls DOIVENT compter"

    # Multimodal : forfait image inclus.
    msgs_img = [{"role": "user", "content": [
        {"type": "text", "text": "t" * 20},
        {"type": "image_url", "image_url": {"url": "u"}}]}]
    assert approx_prompt_tokens(msgs_img) >= IMAGE_TOKEN_COST

    # extra_fixed (schéma tools pré-compté) additif.
    base = approx_prompt_tokens(msgs_img)
    assert approx_prompt_tokens(msgs_img, extra_fixed=57) == base + 57

    # Cohérence avec l'estimateur par message (même base 3.3).
    assert base == sum(est_tokens_message(m) for m in msgs_img)
