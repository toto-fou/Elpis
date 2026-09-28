# SPDX-License-Identifier: MIT
"""
backend.services._metrics — LLM call metrics derivation.

Single public function: :func:`calculate_metrics` derives read/write token
throughput from llama-server's ``timings`` + ``usage`` blocks.

Kept under a private (``_``-prefixed) module name so ``calculate_metrics``
(the exported symbol) doesn't collide with the submodule path — consistent
with the convention used for ``_infill.py``.
"""
from __future__ import annotations

from typing import Any, Dict

from shared_infra.config import LLAMA_MODEL


def calculate_metrics(meta: Dict[str, Any], total_duration: float) -> Dict[str, Any]:
    timings = meta.get("timings", {})
    usage = meta.get("usage", {})
    prompt_tokens = usage.get("prompt_tokens", 0)
    completion_tokens = usage.get("completion_tokens", 0)

    read_speed = 0.0
    if "prompt_per_token_ms" in timings and timings["prompt_per_token_ms"] > 0:
        read_speed = 1000 / timings["prompt_per_token_ms"]
    elif "prompt_ms" in timings and "prompt_n" in timings and timings["prompt_ms"] > 0:
        read_speed = timings["prompt_n"] / (timings["prompt_ms"] / 1000.0)

    write_speed = 0.0
    if "predicted_per_token_ms" in timings and timings["predicted_per_token_ms"] > 0:
        write_speed = 1000 / timings["predicted_per_token_ms"]
    elif "predicted_ms" in timings and "predicted_n" in timings and timings["predicted_ms"] > 0:
        write_speed = timings["predicted_n"] / (timings["predicted_ms"] / 1000.0)

    if write_speed == 0 and total_duration > 0 and completion_tokens > 0:
        write_speed = completion_tokens / total_duration

    # Décomposition de la SORTIE : le raisonnement est un sous-ensemble de
    # ``completion_tokens`` (aucun backend ne les sépare — cf. _think_tokens),
    # et il n'est jamais re-soumis au tour suivant. On expose donc les deux
    # moitiés côte à côte plutôt qu'un seul total dans lequel la part de
    # réflexion — souvent majoritaire sur un modèle thinking — était noyée.
    if meta.get("thinking_tokens") is None:
        # Chemins qui ne mesurent pas eux-mêmes (forced_tool, open_tools) :
        # on prend au moins ce que le backend déclare, quand il le déclare.
        from llm_core._think_tokens import native_reasoning_tokens
        think_tokens = native_reasoning_tokens(usage) or 0
    else:
        think_tokens = int(meta.get("thinking_tokens") or 0)
    if think_tokens < 0:
        think_tokens = 0
    if completion_tokens:
        think_tokens = min(think_tokens, int(completion_tokens))

    out = {
        "duration":       round(total_duration, 2),
        "input_tokens":   prompt_tokens,
        "output_tokens":  completion_tokens,
        # Réflexion vs réponse (appels d'outils compris) — somme = output.
        "thinking_tokens": think_tokens,
        "response_tokens": max(0, int(completion_tokens) - think_tokens),
        # Le comptage exact (déclaré par le backend ou /tokenize local) n'est
        # pas toujours possible : les vues doivent pouvoir le dire (« ≈ »).
        "thinking_tokens_estimated": bool(meta.get("thinking_tokens_estimated")),
        "read_tps":       round(read_speed, 1),
        "write_tps":      round(write_speed, 1),
        "model":          meta.get("model", LLAMA_MODEL),
        "thinking":       meta.get("thinking", ""),
        # Troncature de génération (plafond de tokens atteint) : passe-plat
        # depuis ``meta`` pour que la route puisse armer le bouton
        # « Continuer ». Défaut sûr quand l'appelant ne le fournit pas.
        "finish_reason":  meta.get("finish_reason", ""),
        "truncated":      bool(meta.get("truncated", False)),
        # Coupure par le plafond EN PLEIN raisonnement (content vide, thinking
        # tronqué) : pas de promotion en réponse — la route le signale au front
        # (« Continuer » repart avec le raisonnement en prefill).
        "truncated_in_think": bool(meta.get("truncated_in_think", False)),
    }
    # Passe-plats additifs (chemin classic) : nombre d'auto-reprises in-run du
    # raisonnement et budget de réflexion réellement envoyé — observabilité.
    if meta.get("think_resumes"):
        out["think_resumes"] = int(meta["think_resumes"])
    if meta.get("thinking_budget_effective") is not None:
        out["thinking_budget_effective"] = int(meta["thinking_budget_effective"])
    # Connecteur Anthropic : décomposition du cache prompt (normalisée par
    # _normalize_usage, sinon jetée ici). ``input_tokens`` Anthropic ne compte
    # que les tokens NEUFS — sans ces champs, une requête à 90 % de cache
    # paraissait quasi gratuite et le ROI du cache restait invisible.
    for _k in ("cache_read_input_tokens", "cache_creation_input_tokens"):
        _v = usage.get(_k)
        if isinstance(_v, (int, float)) and _v > 0:
            out[_k] = int(_v)
    return out
