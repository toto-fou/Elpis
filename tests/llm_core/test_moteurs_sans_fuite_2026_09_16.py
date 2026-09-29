# SPDX-License-Identifier: MIT
"""
tests/llm_core/test_moteurs_sans_fuite_2026_09_16.py — deux serveurs llama.cpp,
MÊMES noms de modèles : un tour destiné au second ne touche jamais le premier.

Reproduction du 2026-09-16 (faux llama-server en mode routeur, app isolée) : un
tour sur le connecteur « Serveur 2 » envoyait au serveur INTÉGRÉ trois
``POST /tokenize`` et un ``GET /props?model=`` portant le nom du modèle
distant. Sur un routeur llama.cpp, une requête qui NOMME un modèle le charge
(autoload) — l'intégré faisait monter le modèle homonyme et évinçait le sien :
c'était le « retour automatique au serveur local ».

Ce qui est verrouillé ici, au niveau du transport (``httpx.AsyncClient.send``
intercepté : TOUT appel HTTP est vu, quel que soit le client qui l'émet) :
  1. chemin classique et chemin outils : AUCUNE requête nommant un modèle vers
     l'intégré ; les sondes propres au moteur partent vers le SERVEUR 2, avec
     son en-tête d'authentification ;
  2. les caches par modèle sont indexés par serveur (même nom, deux valeurs) ;
  3. l'ordonnanceur d'un connecteur llama.cpp est le sien, pas celui de
     l'intégré ;
  4. la file d'attente d'un tour sur le serveur 2 lit l'inventaire du serveur 2.
"""
from __future__ import annotations

import json
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from llm_core._target import LlmTarget, use_llm_target
from shared_infra.config import LLAMA_URL

_BUILTIN = urlparse(LLAMA_URL).netloc
_SERVEUR2 = "serveur2.test:8080"
_MODELE = "qwen-x"


def _cible_serveur2() -> LlmTarget:
    return LlmTarget(wire="openai", provider_type="llamacpp",
                     base_url=f"http://{_SERVEUR2}/v1", api_key="cle-s2",
                     model=_MODELE, connector_id=42, is_default=False)


class _Trafic:
    """Faux réseau : répond comme un llama-server routeur, note tout."""

    def __init__(self):
        self.vues: list = []

    def _modele_de(self, request: httpx.Request):
        q = parse_qs(urlparse(str(request.url)).query)
        if q.get("model"):
            return q["model"][0]
        try:
            body = json.loads(request.content or b"{}")
            return body.get("model") if isinstance(body, dict) else None
        except Exception:
            return None

    async def send(self, client, request, **kw):
        u = urlparse(str(request.url))
        self.vues.append({"host": u.netloc, "path": u.path,
                          "model": self._modele_de(request),
                          "auth": request.headers.get("authorization")})
        path = u.path
        if path.endswith("/chat/completions"):
            corps = (
                'data: {"choices":[{"delta":{"content":"ok"},"index":0}]}\n\n'
                'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}],'
                '"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n'
                "data: [DONE]\n\n")
            return httpx.Response(200, headers={"content-type": "text/event-stream"},
                                  content=corps.encode(), request=request)
        if path == "/props":
            if self._modele_de(request):
                data = {"default_generation_settings": {"n_ctx": 32768,
                                                        "params": {"temperature": 0.6}},
                        "total_slots": 2, "build_info": "b10545"}
            else:
                data = {"role": "router", "max_instances": 1, "build_info": "b10545"}
            return httpx.Response(200, json=data, request=request)
        if path in ("/v1/models", "/models"):
            return httpx.Response(200, json={"data": [
                {"id": _MODELE, "status": {"value": "loaded"}}]}, request=request)
        if path == "/tokenize":
            return httpx.Response(200, json={"tokens": [1, 2, 3]}, request=request)
        if path == "/apply-template":
            return httpx.Response(200, json={"prompt": "p"}, request=request)
        if path == "/slots":
            return httpx.Response(200, json=[{"id": 0, "is_processing": False},
                                             {"id": 1, "is_processing": False}],
                                  request=request)
        return httpx.Response(404, json={}, request=request)

    def vers_integre_avec_modele(self):
        return [v for v in self.vues if v["host"] == _BUILTIN and v["model"]]

    def vers_serveur2(self):
        return [v for v in self.vues if v["host"] == _SERVEUR2]


@pytest.fixture()
def trafic(monkeypatch):
    t = _Trafic()

    async def _send(self, request, **kw):
        return await t.send(self, request, **kw)

    monkeypatch.setattr(httpx.AsyncClient, "send", _send)
    # Caches process-wide : partir d'un état neutre pour les deux serveurs.
    from llm_core import _llama_http, _llm_params, _model_info
    from llm_core.providers import llama_caps, llama_models
    _llama_http._TOKENIZE_CACHE.clear()
    _model_info.invalidate_all_model_caches()
    _llm_params.invalidate_params_cache()
    llama_caps.invalidate()
    llama_models.invalidate_statuses()
    yield t
    _model_info.invalidate_all_model_caches()
    _llm_params.invalidate_params_cache()
    llama_caps.invalidate()


# ── 1. Chemin classique ─────────────────────────────────────────────────────
async def test_chemin_classique_ne_touche_pas_lintegre(trafic):
    from llm_core import _chat_classic
    with use_llm_target(_cible_serveur2()):
        await _chat_classic.llama_chat_stream_tokens(
            [{"role": "user", "content": "bonjour"}], chat_id="c1",
            thinking_mode=False)
    assert trafic.vers_integre_avec_modele() == [], trafic.vues
    s2 = trafic.vers_serveur2()
    assert any(v["path"].endswith("/chat/completions") for v in s2)
    # Mécanismes du serveur appliqués au serveur 2 lui-même (sampling /props).
    assert any(v["path"] == "/props" for v in s2), s2
    assert all(v["auth"] == "Bearer cle-s2" for v in s2), s2


# ── 2. Chemin outils (boucle agentique complète) ────────────────────────────
async def test_chemin_outils_ne_touche_pas_lintegre(trafic, monkeypatch):
    from llm_core import _chat_with_tools as W

    events: list = []

    async def _on(ev):
        events.append(ev)

    with use_llm_target(_cible_serveur2()):
        final, _ev, _metrics = await W.run_chat_multi_mcp(
            [{"role": "system", "content": "s"},
             {"role": "user", "content": "résume " + "x " * 400}],
            mcp_configs=[], builtin_tools={}, username="u", on_event=_on,
            model=_MODELE, chat_id="c2")
    fuites = trafic.vers_integre_avec_modele()
    assert fuites == [], (
        "un tour destiné au serveur 2 nomme un modèle au serveur intégré — sur "
        f"un routeur llama.cpp, il le CHARGE : {fuites}")
    s2 = trafic.vers_serveur2()
    assert any(v["path"].endswith("/chat/completions") for v in s2)
    assert all(v["auth"] == "Bearer cle-s2" for v in s2), s2


# ── 3. Caches indexés par serveur ───────────────────────────────────────────
async def test_meme_nom_de_modele_deux_fenetres(trafic, monkeypatch):
    from llm_core import _model_info
    from llm_core.engines import builtin_engine, engine_for_target, use_engine

    async def _get(path, timeout=5.0, *, engine=None):
        from llm_core.engines import current_engine
        eng = engine or current_engine()
        n = 8192 if eng.is_builtin else 65536
        return {"default_generation_settings": {"n_ctx": n}}

    monkeypatch.setattr(_model_info, "_llama_get", _get)

    async def _suffix():
        return ""

    monkeypatch.setattr(_model_info, "_autoload_suffix", _suffix)
    with use_engine(builtin_engine()):
        assert await _model_info.get_model_context_size(_MODELE) == 8192
    with use_engine(engine_for_target(_cible_serveur2())):
        assert await _model_info.get_model_context_size(_MODELE) == 65536
    # La clé de l'intégré est INCHANGÉE (compat) ; le serveur 2 est préfixé.
    assert _model_info._cached_context_size[_MODELE] == 8192
    assert _model_info._cached_context_size[f"conn:42|{_MODELE}"] == 65536


async def test_un_fournisseur_non_llamacpp_ne_recoit_aucune_sonde(trafic):
    from llm_core import _llama_http, _model_info
    cloud = LlmTarget(wire="openai", provider_type="openai",
                      base_url="https://api.openai.test/v1", api_key="k",
                      model="gpt-x", connector_id=7, is_default=False)
    with use_llm_target(cloud):
        assert await _llama_http.count_tokens_exact("bonjour", "gpt-x") is None
        assert await _model_info.get_model_context_size("gpt-x") == 0
    assert trafic.vues == []


# ── 4. Ordonnanceur propre au serveur ───────────────────────────────────────
def test_ordonnanceur_dedie_au_connecteur_llamacpp():
    from llm_core._scheduling._concurrency import LLM_SEMAPHORE
    from llm_core._scheduling._engines import scheduling_for
    from llm_core._scheduling._locks import MODEL_EXCLUSIVITY
    from llm_core.engines import builtin_engine, engine_for_target

    assert scheduling_for(builtin_engine()) == (MODEL_EXCLUSIVITY, LLM_SEMAPHORE)
    excl, sem = scheduling_for(engine_for_target(_cible_serveur2()))
    assert excl is not MODEL_EXCLUSIVITY and sem is not LLM_SEMAPHORE
    assert sem.engine_key == "conn:42"
    assert excl.REDIS_KEY.endswith(":conn:42")
    # Même serveur ⇒ même paire (pas un gestionnaire par appel).
    assert scheduling_for(engine_for_target(_cible_serveur2())) == (excl, sem)


async def test_le_semaphore_de_lintegre_ignore_un_tour_du_serveur2():
    """Un site d'appel oublié qui acquiert encore ``LLM_SEMAPHORE`` pendant un
    tour sur le serveur 2 ne doit pas occuper un slot de l'intégré."""
    from llm_core._scheduling._concurrency import LLMConcurrencyManager
    integre = LLMConcurrencyManager(1, 1)
    with use_llm_target(_cible_serveur2()):
        async with integre.acquire_for(_MODELE):
            assert integre._active == {}


# ── 5. File d'attente du serveur visé ───────────────────────────────────────
async def test_la_file_lit_linventaire_du_serveur2(trafic):
    from llm_core._queue import get_queue_status_for_async
    with use_llm_target(_cible_serveur2()):
        st = await get_queue_status_for_async(_MODELE)
    assert st.get("kind") == "ready", st
    assert trafic.vers_integre_avec_modele() == []
    assert not [v for v in trafic.vues if v["host"] == _BUILTIN
                and v["path"] in ("/v1/models", "/models")], trafic.vues
