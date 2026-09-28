# SPDX-License-Identifier: MIT
"""
backend.services.llm_infill — Fill-In-the-Middle (FIM) code completion.

Single entry point: :func:`llm_infill` which calls llama-server's ``/infill``
endpoint for code-completion models (Qwen2.5-Coder, DeepSeek-Coder, Codestral,
etc.) that ship with FIM-aware prompting built into their GGUF.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from llm_core._llama_http import _llama_post


async def llm_infill(input_prefix: str, input_suffix: str, model: Optional[str] = None) -> Dict[str, Any]:
    """Call llama-server /infill endpoint for Fill-In-the-Middle code completion."""
    # Sampling depuis /props du modèle : les modèles de code (Qwen2.5-Coder,
    # DeepSeek-Coder, Codestral) shippent avec des valeurs calibrées pour le
    # FIM. Le profil "infill" se contente d'ajouter n_predict=256 (stop les
    # boucles infinies) — tout le reste vient du GGUF.
    from llm_core._llm_params import resolve_sampling
    sampling_params = await resolve_sampling(model_id=model, task="infill")

    body: Dict[str, Any] = {
        "input_prefix": input_prefix,
        "input_suffix": input_suffix,
        **sampling_params,
        # Stop tokens spécifiques au FIM : gardés en dur car ils dépendent du
        # format de prompt, pas des préférences de sampling. Ces tokens ne
        # sont pas exposés uniformément dans /props selon les builds.
        "stop": [
            "\n\n\n",              # triple blank line — always a hallucination signal
            "<|endoftext|>",       # model EOS token
            "<|fim_pad|>",         # FIM pad token (CodeLlama / DeepSeek etc.)
            "<|file_separator|>",  # some models use this
            "```",                 # markdown fence — shouldn't appear in raw code output
        ],
    }
    if model:
        body["model"] = model

    r = await _llama_post("/infill", body, timeout=60.0)
    if r and r.get("_status") == 200:
        content = r.get("content", "")
        if not content and "choices" in r:
            choices = r["choices"]
            if isinstance(choices, list) and len(choices) > 0:
                content = choices[0].get("text", "") or choices[0].get("content", "")
        return {"ok": True, "content": content, "model": r.get("model", model or "")}

    return {
        "ok": False,
        "error": (r or {}).get("error", "Endpoint /infill non disponible."),
        "hint": "Vérifiez que le modèle supporte FIM (Fill-In-the-Middle)."
    }
