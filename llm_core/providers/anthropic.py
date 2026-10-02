# SPDX-License-Identifier: MIT
"""
llm_core.providers.anthropic — Adaptateur NATIF de l'API Messages d'Anthropic.

Anthropic n'est PAS OpenAI-compatible : endpoint ``POST /v1/messages``,
en-tête ``x-api-key`` + ``anthropic-version``, format de messages et de
streaming (SSE) propres, ``thinking`` adaptatif. Ce module :

  1. traduit les messages/outils OpenAI ⇄ Anthropic (fonctions PURES, testées) ;
  2. ouvre le flux SSE Anthropic et le normalise vers les MÊMES callbacks que
     le chemin OpenAI (``on_content_token`` / ``on_thinking_token`` /
     ``on_tool_call_delta``), de sorte que les boucles de chat existantes
     restent inchangées.

Deux points d'entrée, alignés sur les deux fonctions du backend :
  - ``anthropic_chat_stream``            → ``(thinking, content, meta)`` (classic)
  - ``anthropic_chat_with_tools_stream`` → dict OpenAI non-streaming (tools)
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

from llm_core._client import _get_llm_client
from llm_core._llm_retry import provider_http_error
from llm_core._target import LlmTarget

logger = logging.getLogger("uvicorn.error")

ANTHROPIC_VERSION = "2023-06-01"
DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6"
_DEFAULT_MAX_TOKENS_CHAT = 8192
_DEFAULT_MAX_TOKENS_THINKING = 16000
_MAX_TOKENS_CEILING = 64000
# Budget de raisonnement des modèles antérieurs à 4.6 (``budget_tokens``).
_DEFAULT_THINKING_BUDGET = 10000

# Type d'un événement ``error`` du flux → code HTTP que l'API aurait rendu
# (https://docs.anthropic.com/en/api/errors). C'est ce code que la taxonomie
# de ``_llm_retry`` lit pour choisir la conduite.
_STREAM_ERROR_STATUS = {
    "invalid_request_error": 400,
    "authentication_error": 401,
    "billing_error": 402,
    "permission_error": 403,
    "not_found_error": 404,
    "request_too_large": 413,
    "rate_limit_error": 429,
    "api_error": 500,
    "timeout_error": 504,
    "overloaded_error": 529,
}


def api_root(target: LlmTarget) -> str:
    """Racine de l'API (sans ``/v1`` ni ``/v1/messages``) — base commune de
    ``messages_url`` et de la découverte des modèles."""
    base = (target.base_url or "https://api.anthropic.com").strip().rstrip("/")
    for suffix in ("/v1/messages", "/v1"):
        if base.endswith(suffix):
            return base[: -len(suffix)]
    return base


def messages_url(target: LlmTarget) -> str:
    return api_root(target) + "/v1/messages"


def build_headers(target: LlmTarget) -> Dict[str, str]:
    return {
        "x-api-key": target.api_key or "",
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
    }


# ── Traduction OpenAI → Anthropic (PURE) ──────────────────────────────────────
def _parse_data_url(url: str):
    """``data:image/png;base64,XXXX`` → (media_type, b64) ; sinon None."""
    if not isinstance(url, str) or not url.startswith("data:"):
        return None
    try:
        head, b64 = url.split(",", 1)
        media = head[5:].split(";", 1)[0] or "image/png"
        return media, b64
    except Exception:
        return None


def _content_to_anthropic_blocks(content: Any) -> List[Dict[str, Any]]:
    """Convertit un ``content`` OpenAI (str ou liste multimodale) en blocs Anthropic."""
    if content is None:
        return []
    # Texte vide OU fait d'espaces seulement : jamais de bloc — l'API le
    # refuse (400 « text content blocks must contain non-whitespace text »).
    if isinstance(content, str):
        return [{"type": "text", "text": content}] if content.strip() else []
    blocks: List[Dict[str, Any]] = []
    if isinstance(content, list):
        for part in content:
            if not isinstance(part, dict):
                if isinstance(part, str) and part.strip():
                    blocks.append({"type": "text", "text": part})
                continue
            ptype = part.get("type")
            if ptype == "text":
                txt = part.get("text") or ""
                if txt.strip():
                    blocks.append({"type": "text", "text": txt})
            elif ptype == "image_url":
                url = ((part.get("image_url") or {}).get("url")) or ""
                parsed = _parse_data_url(url)
                if parsed:
                    media, b64 = parsed
                    blocks.append({"type": "image", "source": {
                        "type": "base64", "media_type": media, "data": b64}})
                elif url:
                    blocks.append({"type": "image", "source": {"type": "url", "url": url}})
    return blocks


def to_anthropic_messages(messages: List[Dict[str, Any]], *,
                          with_tools: bool = True) -> Tuple[str, List[Dict[str, Any]]]:
    """(system concaténé, messages Anthropic). PURE — testable.

    - ``system``     → extrait en top-level ``system``.
    - ``assistant``  → blocs text + ``tool_use`` (depuis ``tool_calls``).
    - ``tool``       → message ``user`` avec un bloc ``tool_result``.

    Aucun bloc texte vide n'est envoyé (``{"type": "text", "text": ""}`` →
    400) : un message sans contenu utile (assistant sans texte ni appel, user
    vide) est OMIS. L'omission pouvant rapprocher deux messages du même rôle,
    les rôles consécutifs identiques sont ensuite FUSIONNÉS en un seul message
    (l'API exige l'alternance user/assistant), les ``tool_result`` en tête du
    user.

    - ``with_tools=False`` (requête SANS ``tools[]``) : les appels et résultats
      passés sont rendus en TEXTE. L'API refuse toute requête qui contient un
      ``tool_use``/``tool_result`` sans déclarer d'outils (400 « Requests
      which include tool_use or tool_result blocks must define tools ») :
      tour de synthèse, chemin classique d'un chat qui a utilisé des outils.
    - Un assistant qui porte ``_anthropic_thinking`` (blocs ``thinking``
      signés capturés au tour précédent) les REJOUE tels quels devant ses
      ``tool_use`` : les modèles qui réfléchissent sans paramètre ``thinking``
      (Opus 5, Fable 5.x…) exigent ce rejeu dans la boucle d'outils."""
    system_parts: List[str] = []
    out: List[Dict[str, Any]] = []
    for m in messages or []:
        role = m.get("role")
        if role == "system":
            c = m.get("content")
            if isinstance(c, str) and c:
                system_parts.append(c)
            elif isinstance(c, list):
                for blk in _content_to_anthropic_blocks(c):
                    if blk.get("type") == "text":
                        system_parts.append(blk["text"])
            continue
        if role == "tool" and not with_tools:
            _res = m.get("content")
            if not isinstance(_res, str):
                _res = json.dumps(_res, ensure_ascii=False)
            if (_res or "").strip():
                out.append({"role": "user", "content": [{
                    "type": "text",
                    "text": f"[résultat d'outil {m.get('name') or ''}]\n{_res}".strip()}]})
            continue
        if role == "tool":
            out.append({"role": "user", "content": [{
                "type": "tool_result",
                "tool_use_id": m.get("tool_call_id") or m.get("id") or "",
                "content": m.get("content") if isinstance(m.get("content"), str)
                           else json.dumps(m.get("content"), ensure_ascii=False),
            }]})
            continue
        if role == "assistant":
            blocks = _content_to_anthropic_blocks(m.get("content"))
            _think = m.get("_anthropic_thinking") if with_tools else None
            if isinstance(_think, list) and m.get("tool_calls"):
                blocks = [dict(b) for b in _think if isinstance(b, dict)] + blocks
            for tc in (m.get("tool_calls") or []):
                fn = tc.get("function") or {}
                args = fn.get("arguments")
                if isinstance(args, str):
                    try:
                        args = json.loads(args) if args.strip() else {}
                    except Exception:
                        args = {"_raw": args}
                if not with_tools:
                    blocks.append({"type": "text", "text": (
                        f"[appel d'outil {fn.get('name') or ''}] "
                        f"{json.dumps(args, ensure_ascii=False)}")})
                    continue
                blocks.append({
                    "type": "tool_use",
                    "id": tc.get("id") or "",
                    "name": fn.get("name") or "",
                    "input": args if isinstance(args, dict) else {},
                })
            if blocks:
                out.append({"role": "assistant", "content": blocks})
            continue
        # user (et tout autre rôle traité comme user)
        blocks = _content_to_anthropic_blocks(m.get("content"))
        if blocks:
            out.append({"role": "user", "content": blocks})
    return "\n\n".join([s for s in system_parts if s]).strip(), _merge_same_roles(out)


def _merge_same_roles(msgs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Fusionne les messages CONSÉCUTIFS de même rôle (alternance stricte).
    Dans un user fusionné, les ``tool_result`` passent devant le texte : ils
    doivent suivre immédiatement le ``tool_use`` qui les appelle."""
    out: List[Dict[str, Any]] = []
    for m in msgs:
        if out and out[-1]["role"] == m["role"]:
            out[-1] = {"role": m["role"],
                       "content": list(out[-1]["content"]) + list(m["content"])}
        else:
            out.append(m)
    for m in out:
        if m["role"] == "user":
            _res = [b for b in m["content"] if b.get("type") == "tool_result"]
            if _res:
                m["content"] = _res + [b for b in m["content"]
                                       if b.get("type") != "tool_result"]
    return out


def to_anthropic_tools(tools_payload: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """OpenAI ``tools[]`` → schéma d'outils Anthropic. PURE — testable."""
    out: List[Dict[str, Any]] = []
    for t in tools_payload or []:
        fn = t.get("function") or t
        name = fn.get("name")
        if not name:
            continue
        out.append({
            "name": name,
            "description": fn.get("description") or "",
            "input_schema": fn.get("parameters") or {"type": "object", "properties": {}},
        })
    return out


def _resolve_max_tokens(sampling_override: Optional[Dict[str, Any]], thinking_mode: bool) -> int:
    if isinstance(sampling_override, dict):
        for k in ("max_tokens", "max_completion_tokens"):
            v = sampling_override.get(k)
            if isinstance(v, (int, float)) and v > 0:
                return min(int(v), _MAX_TOKENS_CEILING)
    base = _DEFAULT_MAX_TOKENS_THINKING if thinking_mode else _DEFAULT_MAX_TOKENS_CHAT
    return min(base, _MAX_TOKENS_CEILING)


def build_body(target: LlmTarget, messages: List[Dict[str, Any]], *,
               tools_payload: Optional[List[Dict[str, Any]]] = None,
               sampling_override: Optional[Dict[str, Any]] = None,
               thinking_mode: bool = False, model: Optional[str] = None,
               stream: bool = True) -> Dict[str, Any]:
    """Corps de requête ``/v1/messages``. PURE — testable.

    Sampling : on NE passe PAS ``temperature``/``top_p``/``top_k`` par défaut —
    ils sont rejetés (400) par opus-4.7+/fable. On laisse le modèle défauter
    (recommandation Anthropic : piloter par le prompt)."""
    a_tools = to_anthropic_tools(tools_payload)
    system, a_msgs = to_anthropic_messages(messages, with_tools=bool(a_tools))
    body: Dict[str, Any] = {
        "model": (model or target.model or DEFAULT_ANTHROPIC_MODEL),
        "messages": a_msgs,
        "max_tokens": _resolve_max_tokens(sampling_override, thinking_mode),
        "stream": stream,
    }
    if system:
        body["system"] = system
    if a_tools:
        body["tools"] = a_tools
    # ⚠ thinking + outils : l'API Anthropic EXIGE que les blocs ``thinking`` (avec
    # leur ``signature``) précédant un ``tool_use`` soient renvoyés TELS QUELS au
    # tour suivant. Ils sont capturés et rejoués DANS le run
    # (``_anthropic_thinking``), mais l'historique persisté est stocké en
    # forme OpenAI (thinking strippé) → activer ``thinking`` sur le
    # chemin outils ferait un 400 dès la 2e itération de la boucle agentique
    # (bloc thinking requis absent). On l'omet donc quand des outils sont
    # présents — exactement le choix du chemin outils llama.cpp
    # (cf. ``engine.llm_stream._llama_chat_with_tools_stream``), où le modèle
    # pense via son propre chat_template.
    if thinking_mode and not a_tools:
        _cfg = thinking_config(body["model"], body["max_tokens"])
        if _cfg:
            body["thinking"] = _cfg
    return body


_CLAUDE_VERSION_RE = re.compile(r"claude-(?:opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?!\d)")
_CLAUDE_LEGACY_RE = re.compile(r"claude-(\d+)(?:-(\d))?-(?:opus|sonnet|haiku)")


def _claude_version(model: str) -> Optional[Tuple[int, int]]:
    """(majeur, mineur) d'un id Claude, ``None`` si inconnu (alias maison).
    ``claude-haiku-4-5-20251001`` → (4, 5) ; ``claude-sonnet-4-20250514`` →
    (4, 0) ; ``claude-3-7-sonnet-latest`` → (3, 7)."""
    m = _CLAUDE_VERSION_RE.search(model or "") or _CLAUDE_LEGACY_RE.search(model or "")
    if not m:
        return None
    return int(m.group(1)), int(m.group(2) or 0)


def thinking_config(model: str, max_tokens: int) -> Optional[Dict[str, Any]]:
    """Paramètre ``thinking`` adapté au modèle. PURE — testable.

    ``adaptive`` n'existe qu'à partir des modèles 4.6 : Haiku 4.5,
    Sonnet/Opus 4.5 et antérieurs exigent
    ``{"type": "enabled", "budget_tokens": N}`` (1024 ≤ N < max_tokens) et
    répondent 400 à ``adaptive``. Avant 3.7 :
    pas de raisonnement du tout. Id inconnu : ``adaptive`` (modèle récent
    derrière un alias)."""
    ver = _claude_version(model)
    if ver is None or ver >= (4, 6):
        # display=summarized → on reçoit des thinking_delta lisibles (sinon vides).
        return {"type": "adaptive", "display": "summarized"}
    if ver < (3, 7):
        return None
    budget = min(_DEFAULT_THINKING_BUDGET, int(max_tokens) - 1024)
    if budget < 1024:
        return None
    return {"type": "enabled", "budget_tokens": budget}


# ── Parsing SSE Anthropic → événements normalisés ─────────────────────────────
async def _iter_sse(resp) -> "Any":
    """Itère les objets ``data:`` JSON d'un flux SSE Anthropic."""
    async for raw in resp.aiter_lines():
        line = (raw or "").strip()
        if not line or line.startswith("event:") or line.startswith(":"):
            continue
        if line.startswith("data:"):
            line = line[5:].strip()
        if not line or line == "[DONE]":
            continue
        try:
            yield json.loads(line)
        except Exception:
            continue


async def _consume_stream(
    target: LlmTarget, body: Dict[str, Any], *,
    on_content_token: Optional[Callable[[str], Awaitable[None]]],
    on_thinking_token: Optional[Callable[[str], Awaitable[None]]],
    on_tool_call_delta: Optional[Callable] = None,
    is_cancelled: Optional[Callable[[], bool]] = None,
) -> Dict[str, Any]:
    """Ouvre le flux ``/v1/messages`` et le consomme.

    Retourne un dict brut : {content, thinking, tool_calls(OpenAI), usage,
    stop_reason, model}."""
    client = _get_llm_client((target.base_url or "https://api.anthropic.com"))
    url = messages_url(target)
    headers = build_headers(target)

    content_parts: List[str] = []
    thinking_parts: List[str] = []
    # Blocs ``thinking``/``redacted_thinking`` COMPLETS (texte + signature),
    # à rejouer tels quels devant les ``tool_use`` au tour suivant.
    thinking_blocks: List[Dict[str, Any]] = []
    blocks: Dict[int, Dict[str, Any]] = {}   # index → {type, tool:{id,name,buf,oai_index}}
    tool_calls: List[Dict[str, Any]] = []
    # Arguments d'un tool_use illisibles (JSON incomplet) : l'appel est
    # TRONQUÉ — jamais exécuté avec ``{}`` à la place (cf. finish « length »).
    truncated_args = False
    usage: Dict[str, Any] = {}
    stop_reason: str = ""
    model_used: str = body.get("model", "")
    _next_oai_tool_idx = 0

    async with client.stream("POST", url, json=body, headers=headers) as resp:
        if resp.status_code >= 400:
            # Erreur TYPÉE (``httpx.HTTPStatusError`` portant code et corps),
            # jamais une ``RuntimeError`` nue : ``llm_error_kind`` la classerait
            # UNKNOWN — pas de compaction sur « prompt is too long », pas de
            # backoff sur 429/529, un 401 pris pour un historique empoisonné.
            txt = (await resp.aread()).decode("utf-8", "replace")
            raise provider_http_error(
                resp.status_code, txt, url=url, headers=getattr(resp, "headers", None),
                message=f"Anthropic {resp.status_code}: {txt[:500]}")
        async for ev in _iter_sse(resp):
            if is_cancelled and is_cancelled():
                try:
                    await resp.aclose()
                except Exception:
                    pass
                raise asyncio.CancelledError("User cancelled mid-stream")
            etype = ev.get("type")
            if etype == "message_start":
                msg = ev.get("message") or {}
                model_used = msg.get("model") or model_used
                u = msg.get("usage") or {}
                if u:
                    usage.update(u)
            elif etype == "content_block_start":
                idx = ev.get("index", 0)
                cb = ev.get("content_block") or {}
                btype = cb.get("type")
                if btype == "tool_use":
                    oai_idx = _next_oai_tool_idx
                    _next_oai_tool_idx += 1
                    blocks[idx] = {"type": "tool_use", "tool": {
                        "id": cb.get("id") or f"call_{oai_idx}",
                        "name": cb.get("name") or "",
                        "buf": "", "oai_index": oai_idx,
                    }}
                    if on_tool_call_delta:
                        try:
                            await on_tool_call_delta(oai_idx, cb.get("name") or "", "")
                        except Exception:
                            pass
                elif btype == "thinking":
                    blocks[idx] = {"type": "thinking", "block": {
                        "type": "thinking", "thinking": cb.get("thinking") or "",
                        "signature": cb.get("signature") or ""}}
                elif btype == "redacted_thinking":
                    blocks[idx] = {"type": "redacted_thinking", "block": dict(cb)}
                else:
                    blocks[idx] = {"type": btype}
            elif etype == "content_block_delta":
                idx = ev.get("index", 0)
                delta = ev.get("delta") or {}
                dtype = delta.get("type")
                if dtype == "text_delta":
                    txt = delta.get("text") or ""
                    if txt:
                        content_parts.append(txt)
                        if on_content_token:
                            await on_content_token(txt)
                elif dtype == "thinking_delta":
                    th = delta.get("thinking") or ""
                    _tb = blocks.get(idx)
                    if th and _tb and _tb.get("type") == "thinking":
                        _tb["block"]["thinking"] += th
                    if th:
                        thinking_parts.append(th)
                        if on_thinking_token:
                            await on_thinking_token(th)
                elif dtype == "signature_delta":
                    _tb = blocks.get(idx)
                    if _tb and _tb.get("type") == "thinking":
                        _tb["block"]["signature"] += delta.get("signature") or ""
                elif dtype == "input_json_delta":
                    frag = delta.get("partial_json") or ""
                    blk = blocks.get(idx)
                    if blk and blk.get("type") == "tool_use":
                        blk["tool"]["buf"] += frag
                        if on_tool_call_delta and frag:
                            try:
                                await on_tool_call_delta(blk["tool"]["oai_index"], "", frag)
                            except Exception:
                                pass
            elif etype == "content_block_stop":
                idx = ev.get("index", 0)
                blk = blocks.get(idx)
                if blk and blk.get("type") in ("thinking", "redacted_thinking"):
                    thinking_blocks.append(blk["block"])
                if blk and blk.get("type") == "tool_use":
                    t = blk["tool"]
                    args = t["buf"].strip() or "{}"
                    try:
                        json.loads(args)
                    except Exception:
                        truncated_args = True
                        args = "{}"
                    tool_calls.append({
                        "id": t["id"], "type": "function",
                        "function": {"name": t["name"], "arguments": args},
                    })
            elif etype == "message_delta":
                d = ev.get("delta") or {}
                if d.get("stop_reason"):
                    stop_reason = d["stop_reason"]
                u = ev.get("usage") or {}
                if u:
                    usage.update(u)
            elif etype == "error":
                # Erreur EN COURS de flux (la réponse était un 200) : même
                # forme typée, code déduit du type (``overloaded_error`` → 529,
                # classé « débit limité » : patienter puis relancer).
                err = ev.get("error") or {}
                if not isinstance(err, dict):
                    err = {"message": str(err)}
                _code = _STREAM_ERROR_STATUS.get(str(err.get("type") or ""), 500)
                raise provider_http_error(
                    _code, json.dumps(ev, ensure_ascii=False), url=url,
                    message=(f"Anthropic stream error ({err.get('type') or _code}): "
                             f"{err.get('message') or err}"))
            elif etype == "message_stop":
                break

    # Appel abouti : versé à l'exécution courante (Anthropic ne donne pas de
    # ``timings`` : seul le nombre d'appels est compté).
    try:
        from shared_infra.observability.runs import current_run
        _run = current_run()
        if _run is not None:
            _run.add_llm_call(None)
    except Exception:                                           # noqa: BLE001
        pass
    return {
        "content": "".join(content_parts).strip(),
        "thinking": "".join(thinking_parts).strip(),
        "tool_calls": tool_calls,
        "thinking_blocks": thinking_blocks,
        "usage": _normalize_usage(usage),
        # Coupe par le plafond OU arguments illisibles : même traitement.
        "stop_reason": "max_tokens" if (truncated_args and tool_calls) else stop_reason,
        "model": model_used,
    }


def _normalize_usage(u: Dict[str, Any]) -> Dict[str, Any]:
    """Usage Anthropic → forme OpenAI (prompt/completion/total)."""
    pin = int(u.get("input_tokens") or 0)
    pout = int(u.get("output_tokens") or 0)
    return {
        "prompt_tokens": pin,
        "completion_tokens": pout,
        "total_tokens": pin + pout,
        "cache_read_input_tokens": int(u.get("cache_read_input_tokens") or 0),
        "cache_creation_input_tokens": int(u.get("cache_creation_input_tokens") or 0),
    }


def _finish_from_stop_reason(stop_reason, *, has_tool_calls: bool) -> str:
    """Traduit le ``stop_reason`` Anthropic en ``finish_reason`` OpenAI.

    Recette UNIQUE des deux points d'entrée de cet adaptateur (classic et
    outils) : sans ``finish_reason``, le chemin sans outils n'armerait jamais
    « Continuer » sur une réponse coupée par le plafond.
    """
    # « length » AVANT « tool_calls » : un tool_use coupé par ``max_tokens``
    # porte un JSON incomplet. Remonté en « tool_calls », il serait exécuté
    # avec ``{}`` et la garde de troncature de la boucle (finish « length » +
    # tool_calls → relance plus compacte) ne serait jamais atteinte.
    if stop_reason == "max_tokens":
        return "length"
    if has_tool_calls:
        return "tool_calls"
    return "stop" if stop_reason else ""


# ── Points d'entrée alignés sur le backend ────────────────────────────────────
async def anthropic_chat_stream(
    messages: List[Dict[str, Any]], *, target: LlmTarget, model: Optional[str] = None,
    on_thinking_token: Optional[Callable] = None, on_content_token: Optional[Callable] = None,
    thinking_mode: bool = False, is_cancelled: Optional[Callable[[], bool]] = None,
    sampling_override: Optional[Dict[str, Any]] = None, chat_id: Optional[str] = None,
) -> Tuple[str, str, Dict[str, Any]]:
    """Chemin classic. Retourne ``(thinking, content, meta)`` — même contrat que
    ``llama_chat_stream_tokens``."""
    body = build_body(target, messages, tools_payload=None,
                      sampling_override=sampling_override, thinking_mode=thinking_mode,
                      model=model, stream=True)
    # Relances : ce chemin court-circuite la boucle de
    # ``llama_chat_stream_tokens`` — sans elles, un 429/529 « overloaded »
    # échouerait au premier essai, sans backoff, avec le JSON brut du
    # fournisseur dans la bulle. On relance tant que RIEN n'a été streamé (une
    # relance après des tokens les dupliquerait à l'écran) et que l'erreur
    # n'est pas définitive ; le message final passe par la taxonomie commune.
    from llm_core._llm_retry import (
        KIND_UNKNOWN,
        llm_error_is_fatal,
        llm_error_kind,
        llm_error_user_message,
        note_llm_success,
        retry_pause,
    )
    from shared_infra.config import LLAMA_RETRIES
    _streamed = [False]

    def _mark(cb):
        if cb is None:
            return None

        async def _w(tok):
            _streamed[0] = True
            await cb(tok)
        return _w
    _on_content, _on_thinking = _mark(on_content_token), _mark(on_thinking_token)
    attempt = 0
    while True:
        try:
            res = await _consume_stream(
                target, body, on_content_token=_on_content,
                on_thinking_token=_on_thinking, is_cancelled=is_cancelled,
            )
            note_llm_success()
            break
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.warning("[anthropic] échec stream (essai %d) : %s",
                           attempt + 1, str(e)[:200])
            # Erreur NON classée (ni HTTP typé ni transport) : pas de relance
            # à l'aveugle — elle pourrait être définitive.
            if (attempt < int(LLAMA_RETRIES) and not _streamed[0]
                    and not llm_error_is_fatal(e)
                    and llm_error_kind(e) != KIND_UNKNOWN
                    and not (is_cancelled and is_cancelled())):
                await retry_pause(e, attempt, is_cancelled=is_cancelled,
                                  label="anthropic_classic")
                attempt += 1
                continue
            return "", f"⚠ Erreur LLM : {llm_error_user_message(e)}", {
                "usage": {}, "timings": {}, "error": True}
    # ``meta`` porte les quatre champs que le chemin llama.cpp pose
    # systématiquement : ``finish_reason``, ``truncated``,
    # ``truncated_in_think`` et ``thinking_tokens``. En aval,
    # ``calculate_metrics`` applique des défauts sûrs (``truncated=False``) et
    # la route n'arme ``isTruncated`` que là-dessus : sans eux, une réponse
    # Claude coupée par ``max_tokens`` (8192 par défaut) arriverait tronquée en
    # pleine phrase, SANS bouton « Continuer » ni le moindre indicateur. La
    # traduction est partagée avec le point d'entrée OUTILS
    # (``_finish_from_stop_reason``) : les deux entrées ne doivent pas diverger.
    _fr = _finish_from_stop_reason(res["stop_reason"], has_tool_calls=False)
    meta = {
        "usage": res["usage"], "timings": {},
        "model": res["model"], "thinking": res["thinking"],
        "finish_reason": _fr,
        "truncated": _fr == "length",
        "truncated_in_think": bool(_fr == "length" and not res["content"]
                                   and res["thinking"]),
    }
    # Sans ``thinking_tokens``, ``calculate_metrics`` retombe sur
    # ``native_reasoning_tokens(usage)`` — que ``_normalize_usage`` ne produit
    # jamais : toute la réflexion de Claude serait comptée comme « réponse ».
    try:
        from llm_core._think_tokens import measure_thinking_tokens
        _tt, _est = await measure_thinking_tokens(
            res["thinking"] or "", model_id=(model or None),
            usage=res["usage"],
            output_tokens=(res["usage"] or {}).get("completion_tokens", 0))
        meta["thinking_tokens"] = _tt
        meta["thinking_tokens_estimated"] = _est
    except Exception:                                           # noqa: BLE001
        pass
    return res["thinking"], res["content"], meta


async def anthropic_chat_with_tools_stream(
    messages: List[Dict[str, Any]], tools_payload: List[Dict[str, Any]], *,
    target: LlmTarget, model: Optional[str] = None,
    on_thinking_token: Optional[Callable] = None, on_content_token: Optional[Callable] = None,
    on_tool_call_delta: Optional[Callable] = None, is_cancelled: Optional[Callable[[], bool]] = None,
    sampling_override: Optional[Dict[str, Any]] = None, thinking_mode: bool = False,
    chat_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Chemin tools. Retourne un dict OpenAI non-streaming (``choices``/``usage``)."""
    body = build_body(target, messages, tools_payload=tools_payload,
                      sampling_override=sampling_override, thinking_mode=thinking_mode,
                      model=model, stream=True)
    res = await _consume_stream(
        target, body, on_content_token=on_content_token,
        on_thinking_token=on_thinking_token, on_tool_call_delta=on_tool_call_delta,
        is_cancelled=is_cancelled,
    )
    message: Dict[str, Any] = {"role": "assistant", "content": res["content"] or None}
    if res["thinking"]:
        message["reasoning_content"] = res["thinking"]
    if res["tool_calls"]:
        message["tool_calls"] = res["tool_calls"]
        if res.get("thinking_blocks"):
            # Clé INTERNE : la boucle la recopie sur son message assistant,
            # ``to_anthropic_messages`` la rejoue, les autres fournisseurs ne
            # la voient jamais (``strip_internal_keys``).
            message["_anthropic_thinking"] = res["thinking_blocks"]
    finish = _finish_from_stop_reason(res["stop_reason"],
                                      has_tool_calls=bool(res["tool_calls"]))
    return {
        "choices": [{"index": 0, "message": message, "finish_reason": finish}],
        "usage": res["usage"],
        "model": res["model"],
    }
