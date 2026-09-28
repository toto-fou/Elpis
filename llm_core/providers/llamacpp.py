# SPDX-License-Identifier: MIT
"""llm_core.providers.llamacpp — étages PARTAGÉS des deux moteurs de streaming.

``_llama_chat_with_tools_stream`` (canal outils, retourne un dict OpenAI) et
``llama_chat_stream_tokens`` (chat classique, retourne un tuple
``(thinking, content, meta)``) étaient des JUMEAUX à ~85 % byte-identiques.
La dérive entre les deux a déjà mordu (le clamp de génération manquait
côté classic — bug C2b historique). Ce module extrait les deux blocs
byte-identiques, où la divergence est la plus dangereuse :

- ``build_llama_payload`` : construction du corps de requête (skeleton +
  KV-cache + clamp de génération + chat_template_kwargs + slot pinning). Les
  paramètres KV-cache / slot sont critiques pour le prefix-cache — les
  laisser en double invitait exactement le genre de dérive qui invalide le
  cache. Chaque appelant ajoute ENSUITE ses extras : ``tools[]`` (canal
  outils) ou ``thinking_budget_tokens`` (canal classic).

- ``consume_llama_sse`` : la boucle de parse SSE + flush de fin. Identique
  des deux côtés à l'accumulation des ``tool_calls`` près — que le consumer
  fait TOUJOURS (dict vide quand le modèle n'en émet pas, inoffensif pour le
  chat classique). Le POST-traitement (forme de retour, récupération du
  reasoning, capture debug) reste propre à chaque fonction.

Les deux fonctions gardent leur signature et leur contrat de retour : aucun
appelant à migrer.
"""
from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from llm_core._constants import (
    LLAMA_FORCE_IDLE_SLOT,
    apply_kv_cache_params,
)

logger = logging.getLogger("uvicorn.error")


# ═════════════════════════════════════════════════════════════════════════════
#  FILET DE FORME — les deux refus que llama-server oppose AVANT toute
#  génération (vérifiés contre b10545 le 2026-08-22, en rejouant les payloads
#  réels d'un run mort en production)
# ═════════════════════════════════════════════════════════════════════════════
#
#   HTTP 500  server_error: While executing CallExpression …
#             raise_exception('No user query found in messages.')
#       → le gabarit (famille ChatML/Qwen3) balaie l'historique À L'ENVERS à la
#         recherche d'un ``user`` qui ne soit pas un ``<tool_response>`` ; s'il
#         n'en trouve aucun il LÈVE. Une boucle agentique n'a qu'un seul
#         ``user`` pour cinquante cycles d'outils : nos étages de réduction
#         peuvent le faire sortir de la fenêtre.
#
#   HTTP 400  invalid_request_error: Cannot have 2 or more assistant messages
#             at the end of the list.
#       → un assistant FINAL est traité comme un « prefill » à continuer, et le
#         serveur n'en accepte qu'un. Producteurs possibles chez nous : le
#         filet d'aplatissement (corrigé à la source) et une queue de reprise
#         (``_think_resume``) posée derrière un historique qui finit déjà par
#         un assistant.
#
# Les deux sont des NO-OP sur un historique normal — donc zéro octet déplacé,
# préfixe KV intact. Ils vivent ici parce que c'est le point de passage UNIQUE
# des deux moteurs (outils et classic) et de toutes les variantes de reprise :
# un correctif posé plus haut ne couvre pas la queue de reprise, qui est
# ajoutée APRÈS la vue d'envoi.

_STRICT_TEMPLATE_ANCHOR = (
    "[SYSTEM] Mission in progress — the original request was summarized into "
    "the context above. Continue from there."
)


def _ensure_user_query(msgs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Garantit au moins un ``role:user`` dès qu'il y a un échange."""
    if any(isinstance(m, dict) and m.get("role") == "user" for m in msgs):
        return msgs
    if not any(isinstance(m, dict) and m.get("role") in ("assistant", "tool")
               for m in msgs):
        return msgs
    at = 0
    for m in msgs:
        if isinstance(m, dict) and m.get("role") == "system":
            at += 1
        else:
            break
    logger.warning(
        "[llama_payload] aucun message user dans %d messages — ancre de tâche "
        "posée en position %d (sinon 500 « No user query found in messages »)",
        len(msgs), at,
    )
    out = list(msgs)
    out.insert(at, {"role": "user", "content": _STRICT_TEMPLATE_ANCHOR})
    return out


def _coalesce_trailing_assistants(msgs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Fusionne les ``assistant`` CONSÉCUTIFS en fin de liste en un seul.

    Les clés du DERNIER message sont conservées (``reasoning_content`` d'une
    reprise native comprise) ; seuls les contenus texte sont concaténés dans
    l'ordre. La forme « un seul assistant final » est celle du prefill que le
    serveur attend, donc la reprise survit à la fusion.

    ⚠ Un seul effet de bord, sur une forme déjà cassée : la fusion rend le
    ``content`` du dernier message non vide, donc l'ARMEMENT AUTOMATIQUE de
    ``continue_final_message`` (plus bas) ne se déclenche pas. Les vraies
    reprises posent ce drapeau explicitement (``_think_resume`` le retourne
    dans ses flags), et la reprise manuelle « Continuer » arrive derrière un
    ``user`` — donc sans fusion. Le cas résiduel perd l'armement mais garde
    le run en vie, là où le serveur refusait tout.
    """
    n = len(msgs)
    i = n
    while i > 0:
        m = msgs[i - 1]
        if not (isinstance(m, dict) and m.get("role") == "assistant"):
            break
        i -= 1
    if n - i < 2:
        return msgs
    tail = msgs[i:]

    def _text(m: Dict[str, Any]) -> str:
        c = m.get("content")
        if isinstance(c, list):
            return "\n".join(b.get("text", "") for b in c
                             if isinstance(b, dict) and isinstance(b.get("text"), str))
        return "" if c is None else str(c)

    merged = dict(tail[-1])
    parts = [t for t in (_text(m).strip() for m in tail) if t]
    merged["content"] = "\n\n".join(parts)
    logger.warning(
        "[llama_payload] %d messages assistant consécutifs en fin de liste — "
        "fusionnés (sinon 400 « Cannot have 2 or more assistant messages at "
        "the end of the list »)", len(tail),
    )
    return msgs[:i] + [merged]


async def build_llama_payload(
    msgs: List[Dict[str, Any]],
    *,
    target_model: str,
    user_id: str,
    sampling_params: Dict[str, Any],
    llama_native: bool,
    local_llamacpp: bool,
    thinking_mode: bool,
    chat_id: Optional[str],
    reasoning_effort: Optional[str] = None,
    preserve_reasoning: Optional[bool] = None,
    slot_avoid_own: bool = False,
) -> Dict[str, Any]:
    """Corps de requête COMMUN aux deux moteurs (byte-identique historiquement).

    Skeleton (model/messages/user/stream/stream_options + sampling) ; puis,
    pour toute cible llama.cpp (``llama_native``) : KV-cache + timings par
    token + chat_template_kwargs ; pour un serveur llama.cpp INTERROGEABLE
    (``local_llamacpp`` — nom historique : depuis le 2026-09-16 il vaut pour
    l'intégré ET pour un connecteur llama.cpp, les sondes suivant le serveur de
    la cible, cf. ``llm_core.engines``) : clamp de génération adaptatif au
    n_ctx + slot pinning + kwargs de template détectés sur SON /props. L'appelant ajoute
    ``tools[]`` ou ``thinking_budget_tokens`` sur le dict retourné (l'ordre des
    clés est indifférent : JSON).
    """
    # Filet de FORME (cf. bloc au-dessus) : no-op sur un historique normal.
    msgs = _coalesce_trailing_assistants(_ensure_user_query(msgs))

    payload: Dict[str, Any] = {
        "model":    target_model,
        "messages": msgs,
        "user":     str(user_id),
        "stream":   True,
        "stream_options": {"include_usage": True},
        **sampling_params,
    }

    # KV cache reuse (source unique : _constants.apply_kv_cache_params) +
    # timings_per_token (timings capturés pour les métriques — prompt_ms,
    # débit ; la jauge de contexte, elle, lit ``usage`` en fin de flux).
    # Extensions llama.cpp → toute cible llama.cpp.
    if llama_native:
        apply_kv_cache_params(payload)
        payload["timings_per_token"] = True
        # Progression du pré-remplissage + ping SSE pendant le silence. Les
        # deux sont IGNORÉS sans erreur par un build qui ne les connaît pas
        # (champ inconnu = ignoré, vérifié en live sur b10545) : aucun risque
        # de refus. Le bénéfice du doute leur revient donc — seul un build
        # LU et trop ancien les retire (cf. ``llama_caps``, ``_not_older``).
        from shared_infra.config import (
            LLAMA_RETURN_PROGRESS as _RET_PROG,
            LLAMA_SSE_PING_INTERVAL_S as _PING_S,
        )
        from llm_core.providers.llama_caps import engine_caps as _eng_caps
        _caps = await _eng_caps()
        if _RET_PROG and _caps.payload_return_progress:
            payload["return_progress"] = True
        if _PING_S and _PING_S > 0 and _caps.payload_sse_ping:
            payload["sse_ping_interval"] = int(_PING_S)
        # Arme le contrôle temps réel du raisonnement. Coût : un sampler créé
        # à la demande. Sans cet armement, POST /v1/chat/completions/control
        # n'a aucune prise sur la génération — et c'est la seule prise
        # existante sur le chemin OUTILS.
        if thinking_mode:
            from shared_infra.config import (
                LLAMA_REASONING_CONTROL as _REA_CTL,
            )
            if _REA_CTL and _caps.payload_reasoning_control:
                payload["reasoning_control"] = True

    # max_tokens cap défensif adaptatif au n_ctx PAR SLOT (source UNIQUE :
    # clamp_generation_budget). Sans lui, prompt+génération > n_ctx →
    # finish=length en plein tour → réponse/JSON tronqué.
    # Mode thinking + LLAMA_THINKING_OUTPUT_UNCAPPED (défaut) : aucun
    # max_tokens envoyé — un long raisonnement n'est plus coupé par le cap
    # (cf. rationale dans shared_infra/config.py) ; un override explicite de
    # l'UI reste respecté (et clampé) par la même fonction.
    if local_llamacpp:
        from llm_core._constants import (
            LLAMA_THINKING_OUTPUT_UNCAPPED,
            clamp_generation_budget,
        )
        from llm_core._model_info import get_model_context_size
        try:
            _gen_ctx = await get_model_context_size(target_model)
        except Exception:
            _gen_ctx = 0
        clamp_generation_budget(
            payload, sampling_params, thinking_mode,
            ctx_size=(_gen_ctx or None),
            uncap_output=bool(thinking_mode and LLAMA_THINKING_OUTPUT_UNCAPPED),
        )

    # chat_template_kwargs.enable_thinking : force le ON/OFF template-level
    # (les modèles thinking défautent à True → budget=0/toggle off inopérant
    # sans ça). Extension llama.cpp.
    if llama_native:
        payload["chat_template_kwargs"] = {"enable_thinking": bool(thinking_mode)}
        # reasoning_effort (Qwen3.8…) : kwarg de template UNIQUEMENT — llama.cpp
        # jette le champ OpenAI top-level du même nom. Injection gardée par la
        # détection serveur (le chat_template du modèle doit citer la valeur) :
        # le sampling_override client est GLOBAL au navigateur, une valeur
        # mémorisée ne doit jamais atteindre un autre modèle — le template
        # officiel Qwen3.8 lève une exception Jinja sur valeur inconnue.
        # Détection sur le /props du serveur de la CIBLE (intégré ou connecteur).
        if reasoning_effort and local_llamacpp:
            from llm_core._llm_params import get_reasoning_effort_values
            try:
                _efforts = await get_reasoning_effort_values(target_model)
            except Exception:
                _efforts = []
            if reasoning_effort in _efforts:
                payload["chat_template_kwargs"]["reasoning_effort"] = reasoning_effort

        # preserve_reasoning (Qwen3.8, GLM-4.x…) : kwarg de template qui garde
        # le <think> des tours PASSÉS dans le prompt re-rendu (llama.cpp le
        # traduit en preserve_thinking/clear_thinking/… côté Jinja). Comme
        # reasoning_effort : injecté SEULEMENT si le serveur confirme la
        # capacité sur CE modèle (/props.chat_template_caps) — l'override
        # client est GLOBAL au navigateur, une valeur mémorisée ne doit jamais
        # atteindre un modèle qui ne la comprend pas. None (défaut) = aucun
        # kwarg → le template garde son propre défaut.
        # ⚠ Change les BYTES du prompt : basculer en cours de conversation
        #    invalide le préfixe KV dès le 1er message assistant (re-préfill
        #    ponctuel). À réglage STABLE, le cache de préfixe est intact.
        if preserve_reasoning is not None and local_llamacpp:
            from llm_core._llm_params import get_preserve_reasoning_support
            try:
                _pr_ok = await get_preserve_reasoning_support(target_model)
            except Exception:
                _pr_ok = False
            if _pr_ok:
                payload["chat_template_kwargs"]["preserve_reasoning"] = bool(preserve_reasoning)

    # Reprise NATIVE (``continue_final_message``, builds llama.cpp récents) :
    # si le DERNIER message est un assistant « en cours » (``reasoning_content``
    # présent, ``content`` vide), le serveur doit re-rendre ce message NON
    # fermé — la génération reprend À L'INTÉRIEUR du bloc think, token-exacte
    # et compatible KV-cache — et ne pas ajouter de generation prompt.
    # Producteurs de cette forme : _think_resume (auto-reprise in-run) et
    # _expand_history_for_llm (« Continuer » manuel sur ``resume_thinking``).
    # Centralisé ICI pour que les deux moteurs ET la route partagent le même
    # armement des flags. Cible non-llama : champs retirés par sanitize_payload.
    if llama_native and msgs:
        _last = msgs[-1]
        if (isinstance(_last, dict) and _last.get("role") == "assistant"
                and _last.get("reasoning_content")
                and not (_last.get("content") or "").strip()):
            payload["continue_final_message"] = True
            payload["add_generation_prompt"] = False

    # Slot pinning : interroge /slots du serveur llama.cpp de la CIBLE.
    if local_llamacpp:
        from llm_core._constants import resolve_slot_id_async
        # ``slot_avoid_own`` : requête annexe (titre) tenue HORS du slot du
        # chat, pour ne pas en évincer le KV (OPTIM 2026-09-26).
        _slot = (await resolve_slot_id_async(chat_id, avoid_own=True)
                 if slot_avoid_own else await resolve_slot_id_async(chat_id))
        if _slot >= 0:
            payload["id_slot"] = _slot
        elif LLAMA_FORCE_IDLE_SLOT:
            # -1 = n'importe quel slot idle (round-robin au lieu de similarité
            # de prompt, qui sérialise les users sur le même slot).
            payload["id_slot"] = -1

    return payload


# Type d'erreur → code HTTP équivalent, quand l'événement n'en porte pas :
# c'est le code qui décide « retenter ou non » (``llm_error_is_fatal``).
_SSE_ERROR_STATUS = {
    "exceed_context_size_error": 400,
    "invalid_request_error": 400,
    "authentication_error": 401,
    "permission_error": 403,
    "not_found_error": 404,
    "rate_limit_error": 429,
    "rate_limit_exceeded": 429,
    "insufficient_quota": 429,
    "overloaded_error": 529,
    "unavailable_error": 503,
}


def _sse_error(err: Any) -> Exception:
    """Événement d'erreur SSE → ``ProviderError`` (httpx.HTTPStatusError).

    Le corps est reconstruit sous la forme ``{"error": {...}}`` : c'est ce
    que ``provider_message`` sait lire, et ce que ``llm_error_kind`` scrute
    (motifs « contexte dépassé », « overloaded »…)."""
    from llm_core._llm_retry import provider_http_error
    if not isinstance(err, dict):
        err = {"message": str(err or "erreur de flux")}
    status = 0
    _code = err.get("code")
    if isinstance(_code, int) and 400 <= _code <= 599:
        status = _code
    elif isinstance(_code, str) and _code.isdigit() and 400 <= int(_code) <= 599:
        status = int(_code)
    if not status:
        status = (_SSE_ERROR_STATUS.get(str(err.get("type") or ""))
                  or _SSE_ERROR_STATUS.get(str(_code or ""))
                  or 500)
    body = json.dumps({"error": err}, ensure_ascii=False)
    msg = str(err.get("message") or err.get("type") or "erreur de flux")
    return provider_http_error(
        status, body, message=f"erreur du fournisseur en cours de flux "
                              f"({status}) : {msg[:300]}")


@dataclass
class SseStreamResult:
    """Sortie brute de ``consume_llama_sse`` — chaque fonction en dérive sa
    propre forme de retour (dict outils vs tuple classic)."""
    content_parts: List[str] = field(default_factory=list)
    thinking_parts: List[str] = field(default_factory=list)
    tool_calls_acc: Dict[int, Dict] = field(default_factory=dict)
    usage: Dict[str, Any] = field(default_factory=dict)
    timings: Dict[str, Any] = field(default_factory=dict)
    finish_reason: Optional[str] = None
    in_think: bool = False
    stream_pre_emitted_thinking: bool = False
    # Observabilité de la garde anti-écho : volume de <think> tardif REROUTÉ
    # en content (peut masquer un raisonnement résiduel — log 1× par flux).
    rerouted_think_chars: int = 0
    rerouted_think_warned: bool = False
    # ``id`` de la complétion, tel que llama-server le répète dans chaque
    # chunk. C'est la CLÉ du contrôle temps réel (POST
    # /v1/chat/completions/control) : sans lui on ne peut qu'abattre le flux.
    completion_id: Optional[str] = None
    # Dernier ``prompt_progress`` reçu : {total, cache, processed, time_ms}.
    # ``cache/total`` = taux de réutilisation du préfixe KV RÉEL, la seule
    # mesure directe de ce que nos efforts de byte-stabilité produisent.
    prompt_progress: Dict[str, Any] = field(default_factory=dict)

    def content(self) -> str:
        return "".join(self.content_parts)

    def thinking(self) -> str:
        return "".join(self.thinking_parts)

    def built_tool_calls(self) -> List[Dict[str, Any]]:
        """Assemble les ``tool_calls`` accumulés (deltas SSE → structure
        OpenAI). Vide si le modèle n'en a pas émis (chat classique)."""
        out: List[Dict[str, Any]] = []
        for i in sorted(self.tool_calls_acc):
            acc = self.tool_calls_acc[i]
            out.append({
                "id":       acc["id"] or f"call_{i}",
                "type":     "function",
                "function": {
                    "name":      acc["function"]["name"],
                    "arguments": "".join(acc["function"]["arguments_parts"]),
                },
            })
        return out


async def consume_llama_sse(
    resp: Any,
    *,
    tag_splitter: Any,
    req_id: str,
    user_id: str,
    is_cancelled: Optional[Callable[[], bool]] = None,
    on_thinking_token: Optional[Callable] = None,
    on_content_token: Optional[Callable] = None,
    on_tool_call_delta: Optional[Callable] = None,
    on_prompt_progress: Optional[Callable] = None,
    sink: Optional["SseStreamResult"] = None,
) -> SseStreamResult:
    """Consomme le flux SSE de llama-server / OpenAI-compat et route les tokens.

    Boucle byte-identique aux deux moteurs :
    - annulation mid-stream (ferme CE flux, pas le client partagé) ;
    - capture usage / timings / slot assigné (l'``usage`` du chunk final est
      la SOURCE de la jauge de contexte : réel, lu en fin de requête) ;
    - ``reasoning_content`` natif → thinking (+ flag anti-rebascule) ;
    - accumulation des ``tool_calls`` (deltas) — TOUJOURS (dict vide si aucun,
      inoffensif pour le chat classique) + ``on_tool_call_delta`` (pré-stream
      UI) ;
    - ``content`` routé thinking/content via ``ThinkTagSplitter`` (détection de
      balises à cheval sur une frontière de chunk) ;
    - flush des octets retenus en fin de flux.

    Le ``tag_splitter`` (ThinkTagSplitter) est fourni par l'appelant : son état
    ``in_think`` survit à travers les chunks et est relu en post-traitement.

    ``sink`` (optionnel) : ``SseStreamResult`` FOURNI par l'appelant, rempli en
    place au fil du flux. L'appelant qui en garde une référence voit donc le
    partiel MÊME si le flux lève en cours de route (erreur transport httpx) —
    indispensable au garde anti-duplication : sur retry, les tokens déjà émis
    via ``on_*_token`` ne doivent pas être ré-émis. Sans sink (défaut), un objet
    frais est créé et n'est visible qu'au retour normal.
    """
    r = sink if sink is not None else SseStreamResult()
    _slot_logged = False

    async for raw_line in resp.aiter_lines():
        # Cancel mid-stream (PRIORITÉ MAX) : resp.aclose() ferme CE flux HTTP ;
        # llama-server détecte le disconnect et arrête. Ne PAS fermer le client
        # partagé (il sert aux autres users).
        if is_cancelled and is_cancelled():
            logger.info("[LLM_REQ %s] CANCEL mid-stream → fermeture stream", req_id)
            try:
                await resp.aclose()
            except Exception:
                pass
            raise asyncio.CancelledError("User cancelled mid-stream")
        raw_line = raw_line.strip()
        if not raw_line or raw_line == "data: [DONE]":
            continue
        # Événement d'erreur SSE (``error: {...}`` — forme llama.cpp) : ligne
        # hors ``data:``, que le ``json.loads`` ci-dessous rejetait en silence.
        _err_line = raw_line.startswith("error:")
        if _err_line:
            raw_line = raw_line[6:].strip()
        elif raw_line.startswith("data:"):
            raw_line = raw_line[5:].strip()
        try:
            chunk = json.loads(raw_line)
        except Exception:
            if _err_line:
                raise _sse_error(raw_line)
            continue
        # AUDIT 2026-09-24 (n° 15a) — une erreur du fournisseur EN COURS de
        # flux (``error: {...}``, ou ``data: {"error": …}`` sans ``choices``)
        # était avalée : le flux finissait « à 0 token », rejoué
        # ``LLAMA_RETRIES`` fois, et le message du fournisseur (contexte
        # dépassé, quota…) était perdu. On la lève en erreur TYPÉE, que
        # ``llm_error_kind`` classe comme un refus HTTP.
        if _err_line:
            raise _sse_error(chunk.get("error", chunk)
                             if isinstance(chunk, dict) else chunk)
        if not isinstance(chunk, dict):
            continue
        if chunk.get("error") and not chunk.get("choices"):
            raise _sse_error(chunk["error"])

        if chunk.get("usage"):
            r.usage = chunk["usage"]
        if chunk.get("timings"):
            r.timings = chunk["timings"]
        if not r.completion_id and chunk.get("id"):
            r.completion_id = str(chunk["id"])
        # Progression du PRÉ-REMPLISSAGE (``return_progress``) : arrive AVANT
        # le premier token, pendant la phase où le flux est autrement muet.
        _pp = chunk.get("prompt_progress")
        if isinstance(_pp, dict) and _pp:
            r.prompt_progress = _pp
            if on_prompt_progress:
                try:
                    await on_prompt_progress(_pp)
                except Exception:
                    pass
            continue

        # Capture le slot assigné (diagnostic multi-user).
        if not _slot_logged:
            _assigned_slot = chunk.get("id_slot")
            if _assigned_slot is None:
                _assigned_slot = (chunk.get("choices") or [{}])[0].get("id_slot")
            if _assigned_slot is not None:
                logger.info("[LLM_REQ %s] SLOT=%s assigné (user=%r)",
                            req_id, _assigned_slot, user_id)
                _slot_logged = True

        choices = chunk.get("choices") or []
        if not choices:
            continue
        choice = choices[0]
        # finish_reason capturé AVANT tout ``continue`` sur delta vide :
        # llama.cpp le pose souvent sur un chunk final à delta vide.
        if choice.get("finish_reason"):
            r.finish_reason = choice["finish_reason"]
        delta = choice.get("delta") or {}

        # reasoning_content natif (QwQ, DeepSeek-R1…) : TOUJOURS du thinking,
        # quels que soient les <think> vus plus tard dans content (le flag
        # évite de rebasculer en think-mode et de perdre la réponse).
        # AUDIT 2026-09-24 (n° 15b) — plus de ``continue`` ici : un analyseur
        # vLLM pose ``reasoning_content`` ET ``content`` (ou ``tool_calls``)
        # dans le MÊME delta au passage de ``</think>``, et la seconde partie
        # était jetée. Le raisonnement passe d'abord, le reste suit.
        rc = delta.get("reasoning_content")
        if rc:
            r.stream_pre_emitted_thinking = True
            r.thinking_parts.append(rc)
            if on_thinking_token:
                await on_thinking_token(rc)

        # tool_calls deltas — accumulation (inoffensive si aucun) + pré-stream UI.
        tc_deltas = delta.get("tool_calls")
        if tc_deltas:
            for tcd in tc_deltas:
                i = tcd.get("index", 0)
                if i not in r.tool_calls_acc:
                    r.tool_calls_acc[i] = {
                        "id": tcd.get("id", f"call_{i}"),
                        "type": "function",
                        "function": {"name": "", "arguments_parts": []},
                    }
                acc = r.tool_calls_acc[i]
                if tcd.get("id"):
                    acc["id"] = tcd["id"]
                fn = tcd.get("function") or {}
                _name_delta = fn.get("name") or ""
                _args_delta = fn.get("arguments") or ""
                # Arguments déjà OBJET (certains serveurs OpenAI-compatibles) :
                # sérialisés, sinon ``"".join`` levait TypeError et l'appel
                # était perdu en « tronqué » (audit 2026-09-24, 2e passe).
                if not isinstance(_args_delta, str):
                    _args_delta = json.dumps(_args_delta, ensure_ascii=False)
                if _name_delta:
                    acc["function"]["name"] += _name_delta
                if _args_delta:
                    acc["function"]["arguments_parts"].append(_args_delta)
                # Pré-streaming UI : le front décode progressivement pour
                # afficher write_file/edit_file avant l'exécution. Best-effort.
                if on_tool_call_delta and (_name_delta or _args_delta):
                    try:
                        await on_tool_call_delta(i, _name_delta, _args_delta)
                    except Exception:
                        pass
            # Pas de ``continue`` : une passerelle peut poser du texte ET le
            # premier fragment d'appel dans le MÊME delta (même défaut que le
            # n° 15b pour ``reasoning_content``) ; ``content`` absent → la
            # branche suivante sort d'elle-même.

        # content texte avec détection robuste <think>/</think> via le splitter
        # (buffer les octets de préfixe de balise à cheval sur les chunks SSE).
        ct = delta.get("content")
        if not ct:
            continue
        for kind, segment in tag_splitter.feed(ct):
            if kind == "thinking" and r.stream_pre_emitted_thinking:
                # Le modèle se répète (reasoning déjà émis nativement) → content.
                # Garde volontairement COLLANTE (anti-duplication éprouvée) ;
                # on trace quand elle reroute un bloc substantiel — signature
                # d'un raisonnement résiduel pris pour une réponse.
                r.rerouted_think_chars += len(segment)
                if r.rerouted_think_chars >= 200 and not r.rerouted_think_warned:
                    r.rerouted_think_warned = True
                    logger.warning(
                        "[LLM_REQ %s] garde anti-écho : bloc <think> tardif "
                        "rerouté en content (≥200 chars cumulés) — possible "
                        "raisonnement résiduel affiché en réponse.", req_id,
                    )
                r.content_parts.append(segment)
                if on_content_token:
                    await on_content_token(segment)
            elif kind == "thinking":
                r.thinking_parts.append(segment)
                if on_thinking_token:
                    await on_thinking_token(segment)
            else:
                r.content_parts.append(segment)
                if on_content_token:
                    await on_content_token(segment)
        r.in_think = tag_splitter.in_think

    # Flush des octets de préfixe de balise retenus en fin de flux.
    for kind, segment in tag_splitter.flush():
        if kind == "thinking":
            r.thinking_parts.append(segment)
            if on_thinking_token:
                await on_thinking_token(segment)
        else:
            r.content_parts.append(segment)
            if on_content_token:
                await on_content_token(segment)
    r.in_think = tag_splitter.in_think
    return r
