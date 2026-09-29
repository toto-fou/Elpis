# SPDX-License-Identifier: MIT
"""
backend.services._chat_classic — Plain-text chat (no tools), with streaming
and thinking-tag handling.

What lives here
---------------
- ``_extract_thinking(content)``     — split a final assistant message into
                                        ``(thinking_text, visible_text)``,
                                        handling several legacy tag forms
                                        (``<think>``, channel-style
                                        ``analysis|final``, prefix lines).
- ``_clamp_messages(msgs, n)``       — drop oldest non-system messages while
                                        preserving the system head (debug
                                        probes only — the chat paths send the
                                        FULL history since 2026-07-28).
- ``_dump(obj)``                     — best-effort serialisation helper used
                                        by the streaming/non-streaming paths
                                        when echoing tool/llama responses.
- ``llama_chat_stream_tokens(...)``  — main streaming path. Streams thinking
                                        and content tokens through
                                        ``on_thinking_token`` / ``on_content_token``
                                        callbacks. Uses a ``ThinkTagSplitter``
                                        to robustly route reasoning even when
                                        ``<think>`` is split across SSE chunks.
- ``llama_chat(...)``                — non-streaming wrapper around
                                        ``llama_chat_stream_tokens`` (collects
                                        all tokens, returns the final string).

Module-level constants come from ``backend.config`` (``LLAMA_URL``,
``LLAMA_RETRIES``, ``LLAMA_MODEL``)
and from ``_constants`` (``LLAMA_FORCE_IDLE_SLOT``, ``LLAMA_THINKING_BUDGET_TOKENS``).
"""
from __future__ import annotations

import logging
import re
import time
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

# These two constants are computed defensively in ``_legacy`` against
# ``backend.config``; we re-import them through the module so any future
# update to the defaults stays a single-source-of-truth change.
from llm_core._constants import (
    LLAMA_FORCE_IDLE_SLOT,
    LLAMA_THINKING_BUDGET_TOKENS,
)
from llm_core._llm_retry import (
    llm_error_detail as _llm_error_detail,
    llm_error_is_fatal as _llm_error_is_fatal,
    llm_error_user_message as _llm_error_user_message,
    retry_pause as _llm_retry_pause,
)
from llm_core._stream_tag_parser import ThinkTagSplitter
from llm_core._think_tokens import measure_thinking_tokens
from shared_infra.config import (
    LLAMA_MODEL,
    LLAMA_RETRIES,
)
from shared_infra.observability.tracing import swallow
from shared_infra.observability.usage_ctx import record_turn_usage

logger = logging.getLogger("uvicorn.error")


# ── Stop sequences communes ──────────────────────────────────────────────────
# Ces séquences sont injectées par défaut dans les appels tool-call forcés
# (décisions structurées) pour couper le blabla post-JSON. Elles couvrent les
# patterns de "nouveau tour" que les modèles ont tendance à émettre quand
# le grammar relâche.
#
# IMPORTANT : ces patterns ne doivent JAMAIS apparaître dans une réponse
# légitime (JSON de tool_call, synthèse Markdown, code, etc.). Si un
# utilisateur découvre un cas de fausse coupure, ajoute un filtre ici ou
# override via le param ``stop_sequences`` du caller.
# AUDIT 2026-08-23 — CODE MORT retiré (~550 lignes, 37 % du fichier).
#
#  • ``run_chat_with_forced_tool`` (+ son helper ``_build_forced_tool_metrics``)
#    et ``run_chat_with_open_tools`` : zéro appelant, zéro importeur, zéro test
#    dans tout le dépôt — accès dynamiques compris — et non réexportées par
#    ``llm_core/__init__.py``. Elles portaient de surcroît deux branches
#    structurellement inatteignables (``payload.get("stop")`` est toujours None :
#    ``stop`` ne fait pas partie d'``ALLOWED_SAMPLING_KEYS``, il ne peut donc
#    jamais sortir de ``resolve_sampling``).
#  • le décorateur ``llm_retry`` et son import ``tenacity`` : aucun ``@llm_retry``
#    n'existait. Le retry réel vit dans ``llm_core._llm_retry``, module distinct.
#  • ``_default_stops`` / ``_DEFAULT_STOP_SEQUENCES_TUPLE`` : lus UNIQUEMENT par
#    les deux fonctions mortes.
#
# ⚠ CONSÉQUENCE À CONNAÎTRE — le réglage à froid ``model_profiles.default.stop``
#   était donc DÉJÀ inerte : aucune requête n'emportait de ``stop``. La
#   suppression ne change rien à l'exécution, elle rend le fait VISIBLE. Le
#   fichier de configuration l'annonce « Câblé » — la note y a été corrigée.
#   Pour le rebrancher un jour, le point d'envoi réel est
#   ``providers/llamacpp.build_llama_payload``.





_ORPHAN_CLOSE_RE = re.compile(r'</think>|<\|/thinking\|>', re.IGNORECASE)


def split_orphan_think_close(content: str):
    """``(raisonnement, réponse)`` si ``content`` porte une fermante de
    raisonnement SANS ouvrante (cf. Cas 4 de ``_extract_thinking``), sinon
    ``None``. PURE."""
    if not content:
        return None
    m = _ORPHAN_CLOSE_RE.search(content)
    if m is None:
        return None
    if re.search(r'<think>|<\|thinking\|>', content, re.IGNORECASE):
        return None
    before = content[:m.start()]
    # Balise CITÉE (bloc ou span de code : une réponse qui parle de ces
    # balises) : ce n'est pas une fin de raisonnement.
    if before.count("```") % 2 == 1 or before.count("`") % 2 == 1:
        return None
    return before.strip(), content[m.end():].strip()


def _extract_thinking(content: str, *, truncated: bool = False):
    # ``truncated=True`` : le texte vient d'une génération coupée par le
    # plafond (finish=length). Un ``<think>`` jamais refermé y est alors du
    # RAISONNEMENT TRONQUÉ, pas une « réponse coincée » : les promotions
    # anti-bulle-vide des sous-cas 3a-inverse/3b (tout renvoyer en content)
    # sont inhibées — sinon le raisonnement s'affiche en markdown dans la
    # bulle (bug « le thinking déborde dans le chat »).
    # Cas 1 : balises standard <think>...</think>
    m = re.search(r'<think>(.*?)</think>', content, re.DOTALL | re.IGNORECASE)
    if m:
        thinking = m.group(1).strip()
        clean = re.sub(r'<think>.*?</think>', '', content, flags=re.DOTALL | re.IGNORECASE).strip()
        return thinking, clean

    # Cas 2 : balises Unicode alternatives (certains builds llama.cpp)
    m = re.search(r'<\|thinking\|>(.*?)<\|/thinking\|>', content, re.DOTALL | re.IGNORECASE)
    if m:
        thinking = m.group(1).strip()
        clean = re.sub(
            r'<\|thinking\|>.*?<\|/thinking\|>', '', content,
            flags=re.DOTALL | re.IGNORECASE
        ).strip()
        return thinking, clean

    # Cas 3 : balise <think> ouverte sans fermeture
    # Deux sous-cas :
    #  3a) Préfixe avant <think> substantiel (>= 20 caractères de contenu
    #      réel) → le modèle a commencé sa réponse puis entamé un thinking
    #      tronqué par budget/finish=length. On garde le préfixe comme
    #      réponse et le reste comme thinking tronqué (comportement legacy).
    #  3b) Préfixe vide ou trivial → le <think> est orphelin en tête, soit
    #      bavé par le modèle, soit fragmenté entre chunks SSE et donc non
    #      détecté en streaming. Considérer tout le suffixe comme "thinking"
    #      ferait disparaître la réponse vers le panneau thinking et laisser
    #      la bulle assistant vide. On strippe juste la balise orpheline et
    #      on renvoie l'intégralité comme contenu (pas de thinking séparé).
    m = re.search(r'<think>', content, re.IGNORECASE)
    if m:
        prefix = content[:m.start()].strip()
        suffix = content[m.end():].strip()
        if truncated:
            # Coupure par plafond : le suffixe est du raisonnement tronqué,
            # quel que soit le rapport de tailles — router en thinking.
            return suffix, prefix
        if len(prefix) >= 20:
            # Sous-cas 3a : <think> ouvert APRÈS un préfixe substantiel, jamais
            # refermé. Par défaut on considère le préfixe comme la réponse et le
            # suffixe comme du raisonnement tronqué (typiquement finish=length en
            # plein <think>). MAIS si un préfixe COURT (≤ 80 car.) est suivi d'un
            # suffixe qui le DOMINE (≥ 3×), c'est presque sûrement l'inverse : une
            # brève intro (« Voici la réponse : ») puis la VRAIE réponse coincée
            # dans un <think> non fermé. La router en thinking la ferait
            # disparaître de la bulle → on garde tout en content. Cohérent avec
            # reconcile_thinking_content (cf. _thinking_reconcile).
            if len(prefix) <= 80 and len(suffix) >= 3 * len(prefix):
                return "", (prefix + "\n\n" + suffix).strip()
            return suffix, prefix
        # Sous-cas 3b : <think> orphelin → strip la balise, garde tout comme content
        cleaned = (prefix + " " + suffix).strip() if prefix else suffix
        return "", cleaned

    # Cas 4 (audit 2026-09-24, 2e passe) : FERMANTE sans ouvrante. Le gabarit
    # a déjà ouvert ``<think>`` dans le prompt (Qwen3-Thinking, DeepSeek-R1)
    # et le serveur ne sépare pas le raisonnement (``--reasoning-format
    # none``) : le flux commence en plein raisonnement et seule ``</think>``
    # arrive. Tout ce qui la précède est du raisonnement (même règle que
    # l'analyseur deepseek_r1 de vLLM) ; avant, balise et raisonnement
    # restaient dans la bulle ET en base.
    _orph = split_orphan_think_close(content)
    if _orph is not None:
        return _orph
    return "", content

    return "", content

def _coalesce_system_messages(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Fusionne TOUS les messages ``system`` en UN SEUL, placé EN TÊTE.

    Beaucoup de chat templates RÉCENTS (Qwen3.5, etc.) lèvent une exception jinja
    « System message must be at the beginning » (→ **HTTP 400**) dès qu'un 2e
    message ``system`` apparaît — même IMMÉDIATEMENT après le 1er — ou qu'un
    ``system`` n'est pas en position 0. Or l'app injecte légitimement plusieurs
    blocs ``system`` : socle/identité, ``runtime_context`` + fragments de capacité
    (ajoutés quand des outils fs/shell/git sont actifs — d'où le 400 reproduit sur
    un prompt « fs tools + shell »), résumé de compression. On les concatène
    (ordre préservé, séparés par '\\n\\n') en UN seul ``system`` en tête ; le reste
    de la conversation suit inchangé.

    No-op quand la liste est déjà conforme (0 ``system``, ou exactement 1 en
    position 0) → préserve le prefix-cache byte-pour-byte dans le cas courant."""
    sys_positions = [i for i, m in enumerate(messages)
                     if isinstance(m, dict) and m.get("role") == "system"]
    if not sys_positions or (len(sys_positions) == 1 and sys_positions[0] == 0):
        return messages

    def _as_text(c: Any) -> str:
        if isinstance(c, str):
            return c
        if isinstance(c, list):
            return "\n".join(
                b.get("text", "") for b in c
                if isinstance(b, dict) and isinstance(b.get("text"), str)
            )
        return "" if c is None else str(c)

    sys_text = "\n\n".join(
        t for t in (_as_text(messages[i].get("content")) for i in sys_positions)
        if t and t.strip()
    )
    out: List[Dict[str, Any]] = []
    if sys_text:
        out.append({"role": "system", "content": sys_text})
    out.extend(
        m for m in messages
        if not (isinstance(m, dict) and m.get("role") == "system")
    )
    return out


def _clamp_messages(messages: List[Dict[str, str]], max_msgs: int) -> List[Dict[str, str]]:
    if not messages:
        return []
    if len(messages) <= max_msgs:
        return messages
    # BUG FIX — préserver TOUS les messages system, où qu'ils soient dans la
    # liste (pas seulement le bloc EN TÊTE). Avant, seuls les system de tête
    # allaient dans ``sys_head`` ; un system inséré EN MILIEU de conversation —
    # typiquement le **résumé de compression** (``[COMPRESSED_SUMMARY_V1]``,
    # qui condense justement tous les vieux tours), ou l'AX memory — tombait
    # dans ``rest`` et pouvait être supprimé par la troncature ``rest[-keep:]``.
    # On perdait alors l'information la plus précieuse de la conversation.
    # Désormais : tous les system sont gardés (dans leur ordre d'origine), et
    # le budget restant est rempli par les messages non-system les + récents.
    system_idx = [i for i, m in enumerate(messages) if m.get("role") == "system"]
    n_system = len(system_idx)
    # Cas pathologique : plus de system que le budget → on garde les + récents
    # (l'ancien code renvoyait sys_head[:max_msgs], donc les + anciens ; les
    # plus récents — résumé/AX — sont plus utiles, on inverse ce choix).
    if n_system >= max_msgs:
        return [messages[i] for i in system_idx[-max_msgs:]]
    keep = max_msgs - n_system
    non_system_idx = [i for i, m in enumerate(messages) if m.get("role") != "system"]
    keep_idx = set(non_system_idx[-keep:]) if keep > 0 else set()
    # Reconstruit dans l'ordre chronologique d'origine. Indexation par
    # position (pas par identité) → robuste si un même dict apparaît 2 fois.
    return [
        m for i, m in enumerate(messages)
        if m.get("role") == "system" or i in keep_idx
    ]

def _send_view(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Vue d'ENVOI : coalesce single-system, SANS clamp en nombre de messages.

    Le clamp ``LLAMA_MAX_MSGS`` (retiré 2026-07-28) amputait silencieusement
    les vieux messages — et sa coupe « derniers non-system » pouvait orpheliner
    un ``role:tool`` en pleine paire (500 Jinja sur template strict). La seule
    borne est désormais le budget en TOKENS ; si le prompt dépasse malgré tout
    la fenêtre, le serveur répond « contexte dépassé » → message utilisateur
    clair (KIND_CONTEXT_OVERFLOW) au lieu d'une amnésie silencieuse."""
    return _coalesce_system_messages(list(messages))


def _http_4xx(err: Exception) -> bool:
    """True si ``err`` est un refus HTTP 4xx « définitif » (hors 408/429).

    Sert à distinguer « le serveur ne CONNAÎT pas cette requête »
    (``continue_final_message`` sur un build ancien → repli prefill) d'une
    panne transitoire (retry) ou d'un vrai plantage (abandon)."""
    try:
        import httpx

        # Un refus arrivé DANS un flux 200 (événement d'erreur SSE) prouve au
        # contraire que la requête a été ACCEPTÉE : ce n'est jamais le refus
        # de ``continue_final_message`` (AUDIT 2026-09-24, n° 15).
        from llm_core._llm_retry import ProviderError
        if isinstance(err, ProviderError):
            return False
        if isinstance(err, httpx.HTTPStatusError):
            sc = err.response.status_code
            return 400 <= sc < 500 and sc not in (408, 429)
    except Exception:
        pass
    return False


async def llama_chat_stream_tokens(
    messages: List[Dict[str, str]],
    user_id: str = "guest",
    model_override: str = None,
    on_thinking_token: Optional[Callable[[str], Awaitable[None]]] = None,
    on_content_token: Optional[Callable[[str], Awaitable[None]]] = None,
    thinking_mode: bool = False,
    is_cancelled: Optional[Callable[[], bool]] = None,
    sampling_override: Optional[Dict[str, Any]] = None,
    chat_id: Optional[str] = None,
    slot_avoid_own: bool = False,
) -> Tuple[str, str, Dict[str, Any]]:
    # Un seul ``system`` en tête (templates stricts type Qwen3.5 → 400 sinon).
    msgs = _send_view(messages)
    from llm_core._target import current_target
    _target = current_target()
    # ``_llama_native`` : la cible parle le DIALECTE llama.cpp (intégré llama.cpp OU
    # connecteur llamacpp distant) → extensions de payload propres à llama.cpp
    # (cache_prompt, timings_per_token, chat_template_kwargs…). Basé sur le TYPE seul :
    # un moteur LOCAL vLLM/générique n'est PAS llama-natif. ``_llamacpp_srv`` gate
    # les appels aux endpoints SPÉCIFIQUES d'un llama-server (/props, /slots,
    # /tokenize) : AUDIT 2026-09-16, ils suivent le serveur de la CIBLE
    # (``llm_core.engines``) et valent donc aussi pour un connecteur llama.cpp —
    # plus seulement pour ``LLAMA_URL``. Un vLLM (local ou non) ne les expose pas.
    _llama_native = _target.provider_type == "llamacpp"
    _llamacpp_srv = _target.is_llamacpp
    target_model = model_override or _target.model or LLAMA_MODEL

    # ── Connecteur Anthropic natif : délègue à l'adaptateur /v1/messages ──
    # (format de messages, en-têtes x-api-key, SSE et thinking propres). Les
    # callbacks restent identiques → la couche appelante ne change pas.
    if _target.wire == "anthropic":
        from llm_core.providers.anthropic import anthropic_chat_stream
        # AUDIT 2026-08-23 — ce ``return`` était placé AVANT ``_t_start`` et
        # avant les quatre ``record_turn_usage`` du corps, et l'adaptateur n'en
        # appelle aucun : le chemin Anthropic SANS OUTILS était le seul tour du
        # produit à ne rien enregistrer. Or le contrat du registre a été déplacé
        # DANS ce chemin d'appel — la route ne compte plus rien. Un compte qui
        # n'utilise que le connecteur Claude en conversation simple affichait
        # 0 token consommé dans l'onglet Utilisation, ses quotas ne se
        # remplissaient jamais et le taux d'erreur ne comptait aucun de ses
        # tours — alors que les tokens étaient bel et bien facturés côté
        # Anthropic. (Le chemin OUTILS, lui, est couvert : la boucle agentique
        # qui l'englobe enregistre le tour.)
        _t0_anthropic = time.time()
        _thinking, _content, _meta = await anthropic_chat_stream(
            msgs, target=_target, model=target_model,
            on_thinking_token=on_thinking_token, on_content_token=on_content_token,
            thinking_mode=thinking_mode, is_cancelled=is_cancelled,
            sampling_override=sampling_override, chat_id=chat_id,
        )
        with swallow("classic.record_usage_anthropic"):
            record_turn_usage(
                usage=(_meta or {}).get("usage") or {}, model=target_model,
                path="classic",
                duration_ms=int((time.time() - _t0_anthropic) * 1000),
                iterations=1,
                thinking_tokens=int((_meta or {}).get("thinking_tokens") or 0),
                status=("error" if (_meta or {}).get("error") else "ok"),
                error_kind=("provider_error" if (_meta or {}).get("error") else ""),
            )
        return _thinking, _content, _meta

    # ── Résolution des paramètres de sampling ──
    # Priorité : sampling_override (UI frontend) > profil tâche > /props modèle
    # Les anciens hardcodes (temperature=0.6 pour thinking, 0.2 pour chat) sont
    # remplacés par les valeurs recommandées par l'auteur du GGUF via /props.
    # Choix utilisateur : en mode thinking on NE FORCE PAS 0.6 — le modèle
    # (Qwen3, DeepSeek-R1…) connaît mieux sa propre température cible.
    _task = "thinking" if thinking_mode else "chat"
    if _llamacpp_srv:
        from llm_core._llm_params import resolve_sampling
        sampling_params = await resolve_sampling(
            model_id=target_model, task=_task, request_override=sampling_override)
    else:
        # Cible distante (cloud/vLLM) : on N'interroge PAS le /props du llama-server
        # LOCAL (mauvais serveur + latence/timeout si le local est éteint). Sampling
        # limité aux paramètres OpenAI-standard de l'UI.
        from llm_core.providers.openai_compat import remote_sampling
        sampling_params = remote_sampling(sampling_override)

    # Corps de requête COMMUN aux deux moteurs (→ providers.llamacpp) :
    # skeleton + KV-cache + clamp de génération adaptatif au n_ctx (le clamp
    # des overrides explicites, absent ici avant — bug C2b — est désormais
    # garanti par la source partagée) + chat_template_kwargs + slot pinning.
    from llm_core._llm_params import (
        sanitize_preserve_reasoning,
        sanitize_reasoning_effort,
    )
    from llm_core.providers.llamacpp import build_llama_payload as _build_payload
    payload = await _build_payload(
        msgs, target_model=target_model, user_id=user_id,
        sampling_params=sampling_params, llama_native=_llama_native,
        local_llamacpp=_llamacpp_srv, thinking_mode=thinking_mode,
        chat_id=chat_id,
        reasoning_effort=sanitize_reasoning_effort(sampling_override),
        preserve_reasoning=sanitize_preserve_reasoning(sampling_override),
        slot_avoid_own=slot_avoid_own,
    )

    # thinking_budget_tokens : PROPRE au chemin classic (le chemin outils ne
    # le pose pas — thinking + tools[] → 400 côté llama.cpp). Champ body réel
    # lu par llama-server (int top-level ; les builds récents le traitent en
    # alias de ``reasoning_budget_tokens`` : sampler à états qui force
    # ``</think>`` + message de budget à l'épuisement — le tour finit toujours
    # par une réponse). CLAMP au lieu de rejet : l'UI accepte [0..131072] mais
    # un override hors [512..131072] était JETÉ en silence (retour au défaut
    # 8192) — la relation « valeur saisie ↔ comportement observé » mentait.
    # Borné au cap de génération effectif QUAND il existe (sortie illimitée en
    # mode thinking local = pas de rabattement). La valeur réellement envoyée
    # est surfacée dans ``meta.thinking_budget_effective`` (observabilité).
    _thinking_budget_effective: Optional[int] = None

    def _apply_thinking_budget(p: Dict[str, Any], mode: bool) -> None:
        nonlocal _thinking_budget_effective
        if not (_llama_native and mode):
            return
        _budget = LLAMA_THINKING_BUDGET_TOKENS
        if sampling_override and isinstance(sampling_override, dict):
            _b_override = sampling_override.get("thinking_budget_tokens")
            if isinstance(_b_override, (int, float)) and int(_b_override) > 0:
                _budget = min(max(int(_b_override), 512), 131072)
        _gen_cap = p.get("max_tokens")
        if isinstance(_gen_cap, int) and _gen_cap > 0:
            _budget = min(_budget, _gen_cap)
        p["thinking_budget_tokens"] = _budget
        _thinking_budget_effective = _budget

    _apply_thinking_budget(payload, thinking_mode)

    # ── Traçage multi-user ─────────────────────────────────────────────────
    # req_id court mais unique permet de corréler toutes les lignes de log
    # d'UNE MÊME REQUÊTE à travers le pipeline. Si deux users se "chevauchent"
    # dans les logs, on voit immédiatement quel chunk appartient à qui.
    import uuid as _uuid
    _req_id = _uuid.uuid4().hex[:8]
    _t_start = time.time()          # durée du tour, pour le registre d'usage
    _n_msgs = len(msgs)
    _prompt_chars = sum(len((m.get("content") or "")) for m in msgs if isinstance(m.get("content"), str))
    logger.info(
        "[LLM_REQ %s] START user=%r model=%r thinking=%s msgs=%d prompt_chars=%d force_slot=-1=%s",
        _req_id, user_id, target_model, thinking_mode, _n_msgs, _prompt_chars, LLAMA_FORCE_IDLE_SLOT,
    )
    suffix = " [THINKING ON]" if thinking_mode else ""
    logger.info(f"➤ [ROUTAGE] Streaming pour '{user_id}' → {target_model}{suffix}")

    thinking_buf: List[str] = []
    content_buf: List[str] = []
    usage: Dict[str, Any] = {}
    timings: Dict[str, Any] = {}
    last_err = None
    # ``in_think_tag`` is now derived from the splitter's state — kept
    # as a separate variable for the post-stream "unclosed tag" recovery
    # heuristic below. The splitter handles the actual byte-level
    # detection across chunk boundaries.
    in_think_tag = False
    # ``finish_reason`` du dernier chunk porteur (souvent un chunk final à
    # ``delta`` vide) → surfacé dans ``meta`` pour que la route arme le bouton
    # « Continuer » quand le modèle a été coupé par le plafond (``length``).
    _finish: str = ""
    tag_splitter: ThinkTagSplitter
    # See note above: stream_pre_emitted_thinking detects the case
    # where the model used the native ``reasoning_content`` channel
    # AND ALSO emitted a ``<think>...</think>`` block in ``content``.
    # This happens with some Qwen3 builds and we don't want to enter
    # think-mode again because all the actual answer follows.
    stream_pre_emitted_thinking = False

    # ── Transport selon la cible (connecteur) ─────────────────────────────
    # Cible par défaut (llama.cpp intégré) : client partagé + LLAMA_URL +
    # aucun en-tête + payload inchangé. Cible OpenAI-compatible distante :
    # client dédié + URL chat/completions + Bearer + retrait des champs
    # llama-only (sinon 400 côté cloud).
    from llm_core.providers import openai_compat as _oai
    client, _req_url, _req_headers = _oai.endpoint(_target)
    _oai.sanitize_payload(payload, _target)

    # ── État de la boucle de SEGMENTS (auto-reprise d'un raisonnement coupé) ──
    # Un « segment » = une requête HTTP complète. Cas nominal : un seul segment
    # (aucun coût). Si un segment se termine en finish=length EN PLEIN
    # raisonnement (content vide), on reprend la génération in-run — mode natif
    # ``continue_final_message`` (reprise token-exacte DANS le bloc think,
    # KV-cache-friendly) ou repli prefill ``<think>`` — au lieu d'armer la
    # bannière « Continuer ». Gardes : cf. _think_resume.should_auto_resume.
    from llm_core._think_resume import merge_segment_usage, should_auto_resume
    _seg_resumes = 0            # reprises déjà effectuées (0 = tour normal)
    _acc_thinking = ""          # thinking BRUT accumulé des segments précédents
    _acc_usage: Dict[str, Any] = {}
    _acc_think_tokens = 0       # completion_tokens cumulés (gardes de budget)
    _resume_native = False      # mode du segment de reprise en cours
    _resume_ctx = 0
    if _llamacpp_srv:
        try:
            from llm_core._model_info import get_model_context_size
            _resume_ctx = int(await get_model_context_size(target_model) or 0)
        except Exception:
            _resume_ctx = 0

    async def _build_segment_payload(acc_thinking: str, *, native: bool) -> Dict[str, Any]:
        """Payload d'un segment de REPRISE (mêmes messages + queue de reprise).

        Natif : ``continue_final_message`` + dernier assistant
        ``reasoning_content`` (thinking_mode conservé). Repli : prefill
        assistant ``<think>…`` NON fermé + ``thinking_mode=False`` (« Assistant
        prefill is incompatible with enable_thinking ») — le budget de
        réflexion est alors sauté d'office (gate ``mode``)."""
        from llm_core._think_resume import build_resume_tail
        _tail, _flags = build_resume_tail(acc_thinking, native=native)
        _tm = thinking_mode if native else False
        p = await _build_payload(
            msgs + _tail, target_model=target_model, user_id=user_id,
            sampling_params=sampling_params, llama_native=_llama_native,
            local_llamacpp=_llamacpp_srv, thinking_mode=_tm,
            chat_id=chat_id,
            reasoning_effort=sanitize_reasoning_effort(sampling_override),
            preserve_reasoning=sanitize_preserve_reasoning(sampling_override),
        )
        p.update(_flags)
        _apply_thinking_budget(p, _tm)
        _oai.sanitize_payload(p, _target)
        return p

    # Read-timeout du flux adapté à la fenêtre du modèle (prefill silencieux :
    # cf. rationale dans _client.stream_timeout_for_ctx). Cible LOCALE
    # seulement — le prefill d'un fournisseur distant est côté cloud.
    # Le kwarg n'est passé QUE si la fenêtre impose d'élargir le read au-delà
    # du défaut client (petit modèle → requête byte-identique à avant).
    _stream_to = None
    if _llamacpp_srv:
        try:
            from llm_core._client import stream_timeout_for_ctx
            from llm_core._model_info import get_model_context_size
            from shared_infra.config import LLAMA_TIMEOUT_SEC
            _cand = stream_timeout_for_ctx(
                await get_model_context_size(target_model))
            if (_cand.read or 0) > float(LLAMA_TIMEOUT_SEC):
                _stream_to = _cand
        except Exception:
            _stream_to = None

    attempt = 0
    while True:
        thinking_buf.clear()
        content_buf.clear()
        usage.clear()
        timings.clear()
        in_think_tag = False
        _finish = ""
        stream_pre_emitted_thinking = False
        tag_splitter = ThinkTagSplitter()
        try:
            async with client.stream(
                "POST", _req_url, json=payload, headers=_req_headers,
                **({"timeout": _stream_to} if _stream_to is not None else {}),
            ) as resp:
                    if resp.status_code >= 400:
                        # Corps lu AVANT de lever : en streaming httpx ne lit
                        # rien, donc l'exception ne contiendrait que le code et
                        # l'URL — la cause réelle (contexte dépassé vs requête
                        # invalide) serait perdue pour la classification. Même
                        # geste que les deux autres chemins de ce fichier.
                        try:
                            await resp.aread()
                        except Exception:
                            pass
                        resp.raise_for_status()
                    # Boucle SSE + flush : consommateur PARTAGÉ avec le chemin
                    # outils (→ providers.llamacpp.consume_llama_sse). On lui
                    # passe un ``sink`` dont les listes SONT nos buffers de garde
                    # (thinking_buf/content_buf) : il les remplit AU FIL du flux,
                    # donc le partiel est visible MÊME si le flux lève en cours
                    # (erreur transport). Sans ça, l'affectation post-retour
                    # ci-dessous n'avait jamais lieu sur un raise → le garde
                    # anti-duplication (plus bas) voyait des buffers vides et
                    # autorisait un retry qui ré-émettait tout (régression Phase 5).
                    from llm_core.providers.llamacpp import (
                        SseStreamResult,
                        consume_llama_sse,
                    )
                    _sse = SseStreamResult()
                    _sse.thinking_parts = thinking_buf
                    _sse.content_parts = content_buf
                    _sse = await consume_llama_sse(
                        resp, tag_splitter=tag_splitter, req_id=_req_id,
                        user_id=user_id, is_cancelled=is_cancelled,
                        on_thinking_token=on_thinking_token,
                        on_content_token=on_content_token,
                        sink=_sse,
                    )
                    # buffers déjà remplis en place (sink) ; réaffectation
                    # idempotente conservée pour lisibilité du post-traitement.
                    thinking_buf[:] = _sse.thinking_parts
                    content_buf[:] = _sse.content_parts
                    usage.clear(); usage.update(_sse.usage)
                    timings.clear(); timings.update(_sse.timings)
                    _finish = _sse.finish_reason or ""
                    in_think_tag = _sse.in_think
                    stream_pre_emitted_thinking = _sse.stream_pre_emitted_thinking

            _seg_thinking_raw = "".join(thinking_buf)
            # Le thinking rendu/reconcilié = ACCUMULÉ (segments de reprise
            # précédents + segment courant) — concaténation directe, sans
            # séparateur : une reprise continue token-exact, souvent en pleine
            # phrase.
            thinking = (_acc_thinking + _seg_thinking_raw).strip()
            content = "".join(content_buf).strip()
            # Contenu VISIBLE pristine (avant la recovery <think> non-fermé qui
            # peut fusionner du thinking dans ``content``) — c'est lui qu'on
            # journalise, pour respecter la garantie "no-thinking" du viewer.
            _dbg_visible = content

            # ── Filet « réponse piégée dans le thinking » (cf. _thinking_reconcile) ──
            # Règle UNIFIÉE, partagée avec le chemin outillé (run_chat_multi_mcp) et
            # avec ``_extract_thinking``. Deux recouvrements :
            #   1) ``content`` vide alors que ``thinking`` porte la réponse (<think>
            #      non fermé, reasoning_content-only, balise </think> scindée sur une
            #      frontière de chunk) → on remonte le thinking en réponse visible.
            #   2) ``content`` court + <think> non fermé + thinking ≫ content → pattern
            #      « intro creuse + vraie réponse coincée » → append (thinking gardé).
            # Garantit l'invariant : une bulle assistant jamais vide quand le modèle a
            # produit du texte.
            # Fermante de raisonnement sans ouvrante (gabarit qui ouvre
            # ``<think>`` lui-même, serveur en ``--reasoning-format none``) :
            # le raisonnement a été streamé comme RÉPONSE. On le sépare, et la
            # route resynchronise la bulle et le panneau (``thinking_extracted``).
            _thinking_extracted = False
            if not _seg_thinking_raw:
                _orph = split_orphan_think_close(content)
                if _orph is not None:
                    _thinking_extracted = True
                    thinking = (_acc_thinking + _orph[0]).strip()
                    content = _orph[1]
            from llm_core._thinking_reconcile import reconcile_thinking_content
            _content_was_empty = not content
            thinking, content = reconcile_thinking_content(
                thinking, content, in_think=in_think_tag, had_tool_calls=False,
                finish=str(_finish or ""),
            )
            # Promotion détectée (la réponse vient d'être sortie du thinking) : on le
            # signale à la route via ``meta`` pour qu'elle EFFACE le bloc thinking
            # affiché en LIVE — sinon la réponse s'affiche en double (panneau + bulle).
            _thinking_promoted = bool(_content_was_empty and content)
            if _thinking_promoted:
                logger.warning(
                    "[LLM_REQ %s] réponse piégée dans le thinking — promue en réponse "
                    "visible (chars=%d).", _req_id, len(content),
                )

            _in_tok_seg = usage.get("prompt_tokens", 0) if isinstance(usage, dict) else 0
            _out_tok_seg = usage.get("completion_tokens", 0) if isinstance(usage, dict) else 0

            # ── Auto-reprise (filet) : coupure du plafond en PLEIN raisonnement ──
            # Ne concerne qu'un serveur llama.cpp (mécanique llama.cpp) et jamais
            # un tour annulé. Cas nominal (sortie non plafonnée) : ne se
            # déclenche que sur un override explicite de max_tokens ou un
            # contexte plein — cf. _think_resume.should_auto_resume.
            if _llamacpp_srv and not (is_cancelled and is_cancelled()):
                _resume_ok, _resume_why = should_auto_resume(
                    finish=str(_finish or ""), content=content, thinking=thinking,
                    had_tool_calls=False, partial=False,
                    resumes_done=_seg_resumes,
                    think_tokens_done=_acc_think_tokens + int(_out_tok_seg or 0),
                    ctx_size=(_resume_ctx or None),
                    # Occupation RÉELLE en fin de segment = ce que le serveur a
                    # en KV, donc la taille du prompt que la reprise renverra.
                    # (Additionner le raisonnement CUMULÉ au prompt le comptait
                    # deux fois : le prompt du segment le contient déjà.)
                    window_tokens=int(_in_tok_seg or 0) + int(_out_tok_seg or 0),
                )
            else:
                _resume_ok, _resume_why = False, "cible non locale ou annulation"
            if _resume_ok:
                # Trafic LLM : CE segment est journalisé avec un statut dédié —
                # le viewer voit chaque requête réelle, reprises comprises.
                try:
                    from llm_core._llm_debug import capture_llm_exchange_async
                    await capture_llm_exchange_async(
                        req_id=_req_id, user_id=user_id, chat_id=chat_id,
                        model=target_model, path="classic", request_payload=payload,
                        content="", usage=usage, timings=timings,
                        finish_reason="length", status="resumed_think",
                    )
                except Exception:
                    pass
                _acc_usage = merge_segment_usage(_acc_usage, usage)
                _acc_think_tokens += int(_out_tok_seg or 0)
                _acc_thinking = _acc_thinking + _seg_thinking_raw
                _seg_resumes += 1
                from llm_core._llm_params import continue_final_support
                # Natif seulement si (a) le non-support n'est pas mémorisé
                # (inconnu = tentative OPTIMISTE, un 4xx bascule en repli) ET
                # (b) le raisonnement du segment est arrivé par le canal natif
                # ``reasoning_content``. Sinon (balises <think> dans content —
                # serveur en --reasoning-format none), une continuation native
                # arriverait SANS balise ouvrante et serait classée content →
                # repli « conclusion » directement.
                _resume_native = bool(
                    stream_pre_emitted_thinking
                    and continue_final_support(target_model) is not False)
                logger.info(
                    "[LLM_REQ %s] raisonnement coupé par le plafond → auto-reprise "
                    "(%s, ≈%d tk de thinking cumulés, mode=%s)",
                    _req_id, _resume_why, _acc_think_tokens,
                    "natif" if _resume_native else "prefill",
                )
                payload = await _build_segment_payload(_acc_thinking, native=_resume_native)
                attempt = 0
                continue
            if str(_finish or "") == "length" and not content and thinking:
                # Coupé en plein think SANS reprise : tracer la garde qui a
                # refusé — la bannière « Continuer » prend le relais (la route
                # persiste ``resume_thinking`` pour une reprise manuelle utile).
                logger.warning(
                    "[LLM_REQ %s] coupure en plein raisonnement sans auto-reprise : %s",
                    _req_id, _resume_why,
                )
            if _seg_resumes and _resume_native:
                # Au moins une reprise native a ABOUTI → support confirmé.
                from llm_core._llm_params import note_continue_final_support
                note_continue_final_support(target_model, True)

            usage_final = merge_segment_usage(_acc_usage, usage)
            # Part de RÉFLEXION dans la sortie. ``completion_tokens`` mélange
            # raisonnement et réponse : on la mesure ici, une fois par tour
            # (exact via /tokenize en local, estimé sinon — cf. _think_tokens),
            # pour que les vues n'aient plus à choisir entre « tout » et rien.
            _think_tok, _think_est = await measure_thinking_tokens(
                thinking, model_id=target_model, usage=usage_final,
                output_tokens=(usage_final or {}).get("completion_tokens", 0))
            meta = {
                "usage": usage_final, "timings": timings,
                "model": target_model, "thinking": thinking,
                "thinking_tokens": _think_tok,
                "thinking_tokens_estimated": _think_est,
                # Troncature : ``length`` = coupé par le plafond de génération
                # → la route arme ``isTruncated`` pour offrir « Continuer ».
                "finish_reason": _finish,
                "truncated": (_finish == "length"),
                # Réponse dé-routée hors du thinking → la route vide le live.
                "thinking_promoted": _thinking_promoted,
                # Raisonnement sorti de la réponse streamée (fermante
                # orpheline) → la route remplace la bulle et le panneau.
                "thinking_extracted": _thinking_extracted and not _thinking_promoted,
                # Coupé par le plafond EN PLEIN raisonnement (reconcile n'a pas
                # promu) : le front garde le bloc thinking tel quel et arme un
                # « Continuer » qui repart avec le raisonnement (resume_thinking).
                "truncated_in_think": bool(_finish == "length" and not content and thinking),
                # Nombre de reprises in-run effectuées (0 = tour normal).
                "think_resumes": _seg_resumes,
            }
            if _thinking_budget_effective is not None:
                meta["thinking_budget_effective"] = _thinking_budget_effective
            # Log de fin : bilan par requête pour corréler avec le début.
            # Permet de voir instantanément dans les logs quelles requêtes
            # se sont bien découplées et lesquelles se sont marchées dessus.
            _in_tok = _in_tok_seg
            _out_tok = usage_final.get("completion_tokens", 0) if isinstance(usage_final, dict) else 0
            # Ratio chars/token MESURÉ (harnais v4) — même recalage que la
            # boucle outils, depuis la réponse réelle du chemin classic.
            try:
                from llm_core.context.tokens import count_image_blocks, note_real_usage, payload_chars
                note_real_usage(target_model or None, payload_chars(msgs), _in_tok,
                                n_images=count_image_blocks(msgs))
            except Exception:
                pass
            logger.info(
                "[LLM_REQ %s] END user=%r content_chars=%d thinking_chars=%d in_tok=%d out_tok=%d resumes=%d",
                _req_id, user_id, len(content), len(thinking), _in_tok, _out_tok, _seg_resumes,
            )
            # Capture de l'échange pour le viewer admin "Trafic LLM" (best-effort,
            # gated par LLM_DEBUG_ENABLED ; le "thinking" n'est PAS journalisé).
            try:
                from llm_core._llm_debug import capture_llm_exchange_async
                await capture_llm_exchange_async(
                    req_id=_req_id, user_id=user_id, chat_id=chat_id,
                    model=target_model, path="classic", request_payload=payload,
                    content=_dbg_visible, usage=usage_final, timings=timings, status="ok",
                )
            except Exception:
                pass
            # Registre d'usage — mesuré ICI, dans le chemin d'appel, pas dans
            # la route : la génération de titre et le compresseur passent par
            # cette fonction sans jamais toucher la route de chat, et leur
            # consommation n'était donc comptée nulle part.
            record_turn_usage(
                usage=usage_final, model=target_model, path="classic",
                duration_ms=int((time.time() - _t_start) * 1000), iterations=1,
                status="ok", thinking_tokens=_think_tok,
            )
            # Cf. llm_core._llm_retry.note_llm_success : arme l'attente de
            # redémarrage sur un ConnectError ultérieur (le moteur EXISTE).
            try:
                from llm_core._llm_retry import note_llm_success
                note_llm_success()
            except Exception:
                pass
            return thinking, content, meta

        except Exception as e:
            last_err = e
            logger.warning("[LLM_REQ %s] attempt=%d failed: %s", _req_id, attempt + 1, str(e)[:200])
            # BUG FIX — ne PAS retry si des tokens ont déjà été streamés au
            # client. Un retry ré-ouvre le stream depuis zéro et ``on_*_token``
            # ré-émet tout → le client affiche [partiel tentative N] +
            # [réponse complète tentative N+1] concaténés (contenu visiblement
            # corrompu, non corrigé par l'heuristique ``finalContent`` du
            # front qui garde le plus long). On ne retente donc QUE si rien
            # n'a encore été émis (échec d'établissement de connexion).
            # ``content_buf``/``thinking_buf`` sont vidés en début de tentative
            # → non-vides ⟺ au moins un ``on_*_token`` a eu lieu ce tour.
            if content_buf or thinking_buf:
                # AUDIT 2026-08-23 — récupérer ce que le SINK a déjà capté.
                # ``usage``/``timings`` ne sont recopiés dans les dicts locaux
                # qu'APRÈS le retour de ``consume_llama_sse`` : sur un raise
                # (ReadTimeout, RST, ReadError) ces lignes ne sont jamais
                # atteintes et le partiel était enregistré ``usage={}``. Or le
                # consommateur a bien écrit ``r.usage``/``r.timings`` sur
                # l'objet sink à chaque chunk (``timings_per_token`` est posé
                # pour toute cible llama-native), et cet objet est encore
                # accessible ici : seule la recopie manquait. Un run de 40 k
                # tokens de prompt coupé après 3 minutes était facturé ZÉRO —
                # exactement ce que le commentaire d'enregistrement plus bas
                # dit vouloir éviter. Les coupures de transport étant le mode
                # d'échec dominant des missions longues, la sous-estimation
                # était systématique.
                with swallow("classic.recover_partial_usage"):
                    _sink_ref = locals().get("_sse")
                    if _sink_ref is not None:
                        if not usage and getattr(_sink_ref, "usage", None):
                            usage.update(_sink_ref.usage)
                        if not timings and getattr(_sink_ref, "timings", None):
                            timings.update(_sink_ref.timings)
                logger.warning(
                    "[LLM_REQ %s] stream interrompu après émission partielle "
                    "— pas de retry, on retourne le partiel déjà streamé.",
                    _req_id,
                )
                # Le partiel inclut le thinking des segments de reprise
                # PRÉCÉDENTS (déjà streamés au client) — sinon un échec en
                # plein segment N jetterait les N-1 segments accumulés.
                _p_think = (_acc_thinking + "".join(thinking_buf)).strip()
                _p_content = "".join(content_buf).strip()
                _p_usage = merge_segment_usage(_acc_usage, usage)
                try:
                    from llm_core._llm_debug import capture_llm_exchange_async
                    await capture_llm_exchange_async(
                        req_id=_req_id, user_id=user_id, chat_id=chat_id,
                        model=target_model, path="classic", request_payload=payload,
                        content=_p_content, usage=usage, timings=timings,
                        finish_reason="partial", status="partial", error=str(e)[:500],
                    )
                except Exception:
                    pass
                # Un partiel a bel et bien consommé des tokens : on l'enregistre
                # avec son statut, sinon un stream coupé s'efface des compteurs.
                # Sa part de réflexion aussi — un tour coupé EN PLEIN
                # raisonnement est justement celui où elle pèse le plus.
                _p_think_tok, _p_think_est = await measure_thinking_tokens(
                    _p_think, model_id=target_model, usage=_p_usage,
                    output_tokens=(_p_usage or {}).get("completion_tokens", 0))
                record_turn_usage(
                    usage=_p_usage, model=target_model, path="classic",
                    duration_ms=int((time.time() - _t_start) * 1000), iterations=1,
                    status="aborted", error_kind=type(e).__name__,
                    thinking_tokens=_p_think_tok,
                )
                return _p_think, _p_content, {
                    "usage": _p_usage, "timings": timings,
                    "model": target_model, "thinking": _p_think,
                    "thinking_tokens": _p_think_tok,
                    "thinking_tokens_estimated": _p_think_est,
                    "partial": True,
                    # Un partiel (stream interrompu après émission) est par
                    # nature incomplet → continuable.
                    "truncated": True,
                    # Coupé en plein raisonnement : la route persiste
                    # ``resume_thinking`` → « Continuer » reprend utilement.
                    "truncated_in_think": bool(not _p_content and _p_think),
                    "think_resumes": _seg_resumes,
                }
            # P0 fiche 14 — 4xx (hors 408/429) = requête invalide : rejouer à
            # l'identique reproduit le même refus, on abandonne tout de suite.
            if _llm_error_is_fatal(e):
                # Reprise NATIVE refusée (4xx) = build llama-server sans
                # ``continue_final_message`` : mémoriser le non-support puis
                # rejouer LE MÊME segment en mode prefill (repli) — la reprise
                # n'est pas perdue pour autant.
                if _seg_resumes and _resume_native and _http_4xx(e):
                    from llm_core._llm_params import note_continue_final_support
                    note_continue_final_support(target_model, False)
                    logger.warning(
                        "[LLM_REQ %s] continue_final_message refusé (%s) → repli "
                        "prefill <think>", _req_id, str(e)[:120],
                    )
                    _resume_native = False
                    payload = await _build_segment_payload(_acc_thinking, native=False)
                    attempt = 0
                    continue
                logger.warning("[LLM_REQ %s] erreur non-retryable (%s) — abandon",
                               _req_id, str(e)[:150])
                break
            if attempt >= LLAMA_RETRIES:
                break
            # Backoff expo plafonné + full jitter ; 503 llama local
            # (chargement de modèle) → attente /health prêt à la place.
            await _llm_retry_pause(e, attempt, is_cancelled=is_cancelled,
                                   label="classic_stream")
            attempt += 1

    # Message par FAMILLE de panne (contexte dépassé, requête refusée, serveur
    # injoignable, timeout…). L'ancien test ``"http" in str(err)`` était vide de
    # sens : toute erreur httpx contient l'URL « http://… », donc absolument
    # TOUT — y compris un 400 « conversation trop longue » — s'affichait
    # « Erreur de connexion au modèle », et l'utilisateur cherchait une panne
    # réseau inexistante.
    error_msg = _llm_error_user_message(last_err)
    try:
        from llm_core._llm_debug import capture_llm_exchange_async
        await capture_llm_exchange_async(
            req_id=_req_id, user_id=user_id, chat_id=chat_id,
            model=target_model, path="classic", request_payload=payload,
            content="", status="error",
            error=_llm_error_detail(last_err)[:1000],
        )
    except Exception:
        pass
    if _seg_resumes and _acc_thinking.strip():
        # Échec dur PENDANT une auto-reprise : rendre l'état ACCUMULÉ
        # (continuable) plutôt qu'une erreur sèche — le raisonnement des
        # segments aboutis a déjà été streamé au client et la bannière
        # « Continuer » sait repartir de là (resume_thinking).
        logger.warning(
            "[LLM_REQ %s] échec pendant une auto-reprise (%s) — retour de "
            "l'état accumulé (continuable).", _req_id, error_msg,
        )
        _acc_t = _acc_thinking.strip()
        record_turn_usage(
            usage=_acc_usage, model=target_model, path="classic",
            duration_ms=int((time.time() - _t_start) * 1000), iterations=1,
            status="aborted", error_kind=type(last_err).__name__ if last_err else "unknown",
        )
        return _acc_t, "", {
            "usage": _acc_usage, "timings": {},
            "model": target_model, "thinking": _acc_t,
            "finish_reason": "length",
            "truncated": True, "truncated_in_think": True,
            "think_resumes": _seg_resumes,
        }
    # Échec dur : aucun token facturé, mais le tour DOIT compter — c'est ce qui
    # alimente le taux d'erreur. L'ancien signal ``stream_abort`` n'avait aucun
    # émetteur : quatre widgets affichaient 0 depuis toujours.
    record_turn_usage(
        model=target_model, path="classic",
        duration_ms=int((time.time() - _t_start) * 1000), iterations=0,
        status="error", error_kind=type(last_err).__name__ if last_err else "unknown",
    )
    # AUDIT 2026-08-23 — ce chemin ne LÈVE pas : il retourne un tuple
    # d'erreur, donc le garde d'ordonnancement voit un tour réussi et le
    # disjoncteur n'était jamais alimenté. On le nourrit là où la panne est
    # constatée (filtré sur la famille transport : un 400 métier n'ouvre rien).
    try:
        from llm_core._scheduling._breaker import note_transport_failure
        from llm_core._scheduling._engines import breaker_key as _bk
        from llm_core.engines import current_engine as _ce_brk
        # Clé du serveur de la cible : la panne d'un connecteur n'ouvre plus
        # le circuit du modèle HOMONYME de l'intégré (AUDIT 2026-09-16).
        note_transport_failure(_bk(_ce_brk(), target_model), last_err)
    except Exception:
        pass
    return "", f"⚠ Erreur LLM: {error_msg}", {"usage": {}, "timings": {}, "error": True}

async def llama_chat(
    messages: List[Dict[str, str]],
    user_id: str = "guest",
    model_override: str = None,
    thinking_mode: bool = False,
    is_cancelled: Optional[Callable[[], bool]] = None,
    sampling_override: Optional[Dict[str, Any]] = None,
    chat_id: Optional[str] = None,
) -> Tuple[str, Dict[str, Any]]:
    _, content, meta = await llama_chat_stream_tokens(
        messages, user_id=user_id,
        model_override=model_override,
        thinking_mode=thinking_mode,
        is_cancelled=is_cancelled,
        sampling_override=sampling_override,
        chat_id=chat_id,
    )
    return content, meta


def _dump(obj: Any) -> Any:
    if hasattr(obj, "model_dump"):
        return obj.model_dump()
    if hasattr(obj, "dict"):
        return obj.dict()
    return obj





# ──────────────────────────────────────────────────────────────────────────
# v18+ — run_chat_with_open_tools : 1 LLM call, N tools disponibles
# ──────────────────────────────────────────────────────────────────────────

