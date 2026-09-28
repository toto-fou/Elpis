# SPDX-License-Identifier: MIT
"""
llm_core.providers.openai_compat — Transport OpenAI-compatible paramétré.

Couvre le llama-server local ET les fournisseurs OpenAI-compatibles (OpenAI,
Mistral, Groq, OpenRouter, DeepSeek, vLLM…). Le code de streaming reste celui
de ``_chat_classic`` / ``_chat_with_tools`` ; ce module fournit juste :

  - ``endpoint(target)``        → (client, url chat-completions, en-têtes)
  - ``models_url(target)``      → URL ``/models`` (découverte)
  - ``sanitize_payload(...)``   → retire les champs llama-only pour un
                                  fournisseur distant (sinon 400 côté cloud)

INVARIANT rétro-compat : pour la cible PAR DÉFAUT (llama.cpp intégré),
``endpoint`` renvoie ``LLAMA_URL`` + client partagé + aucun en-tête, et
``sanitize_payload`` est un no-op → comportement strictement identique.
"""
from __future__ import annotations

import re
from typing import Any, Dict, Tuple

import httpx

from shared_infra.config import LLAMA_URL
from llm_core._client import _get_llm_client
from llm_core._target import LlmTarget

# Fournisseurs « locaux » qui acceptent les extensions llama.cpp dans le body.
# Seul llama.cpp les comprend toutes (id_slot, cache_prompt, n_cache_reuse,
# timings_per_token, thinking_budget_tokens, samplers dry_*, top_k, min_p…).
_LLAMA_NATIVE_PROVIDERS = {"llamacpp"}

# Champs standard de l'API OpenAI chat/completions — seuls conservés quand on
# parle à un fournisseur non-llama.cpp (whitelist = robuste : tout sampler ou
# extension propriétaire llama.cpp est retiré).
OPENAI_STD_FIELDS = frozenset({
    "model", "messages", "stream", "stream_options",
    "temperature", "top_p", "max_tokens", "max_completion_tokens",
    "stop", "tools", "tool_choice", "user",
    "presence_penalty", "frequency_penalty", "seed", "n",
    "response_format", "logprobs", "top_logprobs", "logit_bias",
})


def _is_llama_native(target: LlmTarget) -> bool:
    # Dialecte llama.cpp = type du fournisseur SEUL (PAS ``is_default``) : un
    # moteur LOCAL vLLM/générique (is_default=True) n'est PAS llama-natif et doit
    # être assaini, sinon les champs llama-only (id_slot, cache_prompt, top_k…)
    # partent vers un serveur qui les rejette. Le défaut llama.cpp a
    # provider_type="llamacpp" ⇒ comportement inchangé.
    return target.provider_type in _LLAMA_NATIVE_PROVIDERS


def _join(base: str, suffix: str) -> str:
    base = (base or "").strip().rstrip("/")
    if base.endswith(suffix):
        return base
    return base + suffix


def chat_completions_url(target: LlmTarget) -> str:
    """URL POST chat/completions pour cette cible."""
    if target.is_default or not target.base_url:
        return LLAMA_URL
    return _join(target.base_url, "/chat/completions")


def models_url(target: LlmTarget) -> str:
    """URL GET /models (découverte) pour cette cible."""
    if target.is_default or not target.base_url:
        from urllib.parse import urlparse
        p = urlparse(LLAMA_URL)
        return f"{p.scheme}://{p.netloc}/v1/models"
    base = (target.base_url or "").strip().rstrip("/")
    if base.endswith("/chat/completions"):
        base = base[: -len("/chat/completions")]
    return base.rstrip("/") + "/models"


def headers(target: LlmTarget) -> Dict[str, str]:
    """En-têtes d'auth (Bearer) pour un fournisseur distant ; vide pour le local."""
    h: Dict[str, str] = {}
    if not target.is_default and target.api_key:
        h["Authorization"] = f"Bearer {target.api_key}"
    return h


def endpoint(target: LlmTarget) -> Tuple[httpx.AsyncClient, str, Dict[str, str]]:
    """(client, url chat-completions, en-têtes) pour la cible."""
    base = "" if target.is_default else target.base_url
    return _get_llm_client(base or None), chat_completions_url(target), headers(target)


# Sampling OpenAI-standard transmis tel quel à un fournisseur distant. On NE
# dérive PAS le sampling du /props LOCAL pour une cible distante (mauvais serveur
# + latence). On se limite aux clés acceptées par les clouds OpenAI-compatibles.
_REMOTE_SAMPLING_KEYS = (
    "temperature", "top_p", "max_tokens", "max_completion_tokens",
    "stop", "presence_penalty", "frequency_penalty", "seed",
)


def remote_sampling(sampling_override: Any) -> Dict[str, Any]:
    """Sous-ensemble OpenAI-standard de l'override UI, pour une cible distante.

    AUDIT 2026-08-23 — les VALEURS sont désormais validées.

    Sur cible locale, l'override traverse ``_sanitize_override`` (qui jette
    toute valeur hors bornes) puis ``clamp_generation_budget`` (qui remplace un
    ``max_tokens`` non positif par le cap effectif). Sur cible distante, cette
    fonction remplaçait TOUT le pipeline en recopiant six clés du dict BRUT :
    aucune borne, aucun clamp, et ``sanitize_payload`` ne filtre ensuite que
    les NOMS de champs. La validation existait donc pour le moteur qui la
    tolère et manquait pour ceux qui la refusent.

    Chemin utilisateur le plus court : le champ max_tokens du panneau Sampling
    porte le placeholder « illimité » ; qui y tape ``0`` ne voit rien en local
    (la sémantique « 0 = illimité » est propre à llama.cpp) — puis CHAQUE
    message échoue en 400 le jour où il bascule sur un connecteur cloud, avec
    une erreur générique et un réglage coupable invisible. Le retour au moteur
    local « répare » le problème, ce qui oriente le diagnostic vers le
    connecteur.
    """
    out: Dict[str, Any] = {}
    if not isinstance(sampling_override, dict):
        return out
    try:
        from llm_core._llm_params import _sanitize_override
        _propre = _sanitize_override(sampling_override) or {}
    except Exception:                                           # noqa: BLE001
        _propre = {}
    for k in _REMOTE_SAMPLING_KEYS:
        # ``stop`` n'est pas dans ALLOWED_SAMPLING_KEYS (asymétrie inverse :
        # il fonctionne en distant et est muet en local) → on le prend du
        # dict d'origine, c'est une liste/chaîne libre sans bornes à vérifier.
        # ``max_completion_tokens`` non plus (absent d'ALLOWED_SAMPLING_KEYS :
        # sans ce repli il n'était JAMAIS transmis) ; sa valeur est vérifiée
        # juste en dessous.
        v = _propre.get(k) if k in _propre else (
            sampling_override.get(k) if k in ("stop", "max_completion_tokens") else None)
        if v is None:
            continue
        # ``-1``/``0`` = « illimité » n'existe chez AUCUN fournisseur
        # OpenAI-compatible : on retire plutôt que d'envoyer un refus certain.
        if k in ("max_tokens", "max_completion_tokens", "n_predict"):
            try:
                if int(v) <= 0:
                    continue
            except (TypeError, ValueError):
                continue
        out[k] = v
    return out


def sanitize_payload(payload: Dict[str, Any], target: LlmTarget) -> Dict[str, Any]:
    """Mute ``payload`` en place : retire les champs llama-only pour un
    fournisseur distant non-llama.cpp. No-op pour le local. Retourne le payload."""
    if _is_llama_native(target):
        return payload
    for k in list(payload.keys()):
        if k not in OPENAI_STD_FIELDS:
            payload.pop(k, None)
    # OpenAI moderne attend ``max_completion_tokens`` ; on garde ``max_tokens``
    # qui reste accepté par la majorité (Mistral/Groq/OpenRouter/DeepSeek/vLLM).
    # AUDIT 2026-09-24 (2e passe) — SAUF les modèles de raisonnement OpenAI
    # (o1/o3/o4…, gpt-5) : ``max_tokens`` y est refusé (400 « use
    # 'max_completion_tokens' »), tout comme un sampling non défaut. Le titre
    # du chat (``max_tokens: 24``) et le réglage global de température
    # faisaient échouer chaque requête vers ces modèles.
    if is_openai_reasoning_model(payload.get("model") or target.model):
        if "max_tokens" in payload:
            _mt = payload.pop("max_tokens")
            payload.setdefault("max_completion_tokens", _mt)
        for k in _REASONING_REJECTED_SAMPLING:
            payload.pop(k, None)
    return payload


# Sampling refusé par les modèles de raisonnement OpenAI (seule la valeur par
# défaut est admise : autant ne rien envoyer).
_REASONING_REJECTED_SAMPLING = (
    "temperature", "top_p", "presence_penalty", "frequency_penalty",
    "logprobs", "top_logprobs", "logit_bias",
)
_OPENAI_REASONING_RE = re.compile(r"^(?:[\w.-]+/)?(?:o\d+(?:$|-)|gpt-5(?!-chat))", re.I)


def is_openai_reasoning_model(model: Any) -> bool:
    """o1/o3/o4-mini/gpt-5… (préfixe ``openai/`` des routeurs toléré) ;
    ``gpt-5-chat-*`` n'est PAS un modèle de raisonnement."""
    return bool(model) and bool(_OPENAI_REASONING_RE.match(str(model).strip()))
