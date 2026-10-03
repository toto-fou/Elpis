# SPDX-License-Identifier: MIT
"""Description enrichie : le modèle du chat réécrit la demande avant le moteur.

Le prompt système vit dans ``system_prompts/IMAGE_PROMPT_ENHANCE.md`` (éditable
en console, relu à chaud) ; la constante ci-dessous est le repli si le fichier
manque. Best-effort STRICT : une panne, un délai ou une sortie douteuse rendent
``None`` et la demande part telle quelle — enrichir ne doit jamais empêcher de
générer.

L'appel passe par la cible LLM courante (contextvar posé par l'appelant avec
``use_llm_target``) : même modèle, même connecteur que le chat.
"""
from __future__ import annotations

import asyncio
import logging
import re
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger("uvicorn.error")

PROMPT_NAME = "IMAGE_PROMPT_ENHANCE"
_FALLBACK = (
    "You rewrite a user's image request into one prompt for a text-to-image diffusion "
    "model. Output ONLY the prompt, in English, one paragraph, at most 120 words. Keep "
    "every element the user asked for; add concrete visual detail (setting, lighting, "
    "composition, medium, mood). Text to render stays verbatim inside double quotes."
)
_TIMEOUT_SEC = 60.0
_MAX_CHARS = 1500
_THINK = re.compile(r"<think>[\s\S]*?</think>", re.I)

LlmCall = Callable[[List[Dict[str, str]]], Awaitable[str]]


def system_prompt() -> str:
    from llm_core._system_prompts import _load_fragment
    return _load_fragment(PROMPT_NAME) or _FALLBACK


def clean(output: str, original: str) -> Optional[str]:
    """Sortie du modèle → prompt utilisable, ou ``None`` si douteuse."""
    t = _THINK.sub("", output or "").strip()
    if "<think" in t.lower():
        return None
    t = re.sub(r"^(prompt|here is[^:]*|voici[^:]*)\s*:\s*", "", t, flags=re.I).strip()
    t = t.strip("`").strip()
    if len(t) >= 2 and t[0] == t[-1] and t[0] in "\"'«":
        t = t[1:-1].strip()
    t = " ".join(t.split())
    if len(t) < max(8, min(len(original), 20) // 2):
        return None
    return t[:_MAX_CHARS]


async def enhance_prompt(prompt: str, *, model: Optional[str], chat_id: str = "",
                         llm_call: Optional[LlmCall] = None) -> Tuple[Optional[str], str]:
    """``(prompt enrichi | None, raison)``. ``llm_call`` : couture de test."""
    if llm_call is None:
        from llm_core import llama_chat_stream_tokens  # type: ignore[attr-defined]

        async def _appel(msgs: List[Dict[str, str]]) -> str:
            _t, content, _meta = await llama_chat_stream_tokens(
                msgs, user_id="image_prompt", model_override=model, thinking_mode=False,
                sampling_override={"temperature": 0.5, "max_tokens": 400}, chat_id=chat_id)
            return content
        llm_call = _appel
    msgs = [{"role": "system", "content": system_prompt()},
            {"role": "user", "content": prompt[:4000]}]
    try:
        from shared_infra.observability.usage_ctx import usage_scope
        with usage_scope("image_prompt", origin_id=str(chat_id or "")):
            out: Any = await asyncio.wait_for(llm_call(msgs), timeout=_TIMEOUT_SEC)
    except asyncio.TimeoutError:
        return None, "délai dépassé"
    except asyncio.CancelledError:
        raise
    except Exception as exc:                                    # noqa: BLE001
        logger.info("[image] enrichissement impossible : %s: %s", type(exc).__name__,
                    str(exc)[:160])
        return None, "modèle indisponible"
    cleaned = clean(str(out or ""), prompt)
    if not cleaned:
        return None, "réponse inutilisable"
    return cleaned, ""
