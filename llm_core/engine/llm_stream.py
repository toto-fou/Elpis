# SPDX-License-Identifier: MIT
"""llm_core.engine.llm_stream — transport d'UN appel LLM en flux avec ``tools[]``.

``_llama_chat_with_tools_stream`` envoie la requête au moteur de la cible
(llama.cpp, moteur compatible OpenAI ou Anthropic), lit le flux SSE et rend
une réponse au format OpenAI non streamé (``choices[0].message`` avec
``content``, ``reasoning_content`` et ``tool_calls``), plus l'usage réel.
Il gère aussi :
  * les replis : requête sans flux, puis analyse du texte quand le moteur ne
    sait pas produire de ``tool_calls`` natifs ;
  * la reprise d'un flux coupé (``_resume_cut_stream``, llama.cpp avec
    ``LLAMA_RESUMABLE_STREAM``) ;
  * l'arrêt côté moteur à l'annulation (``_fire_cancel_stream``) et la borne
    souple du raisonnement (``_reasoning_guard``) ;
  * les nouvelles tentatives sur erreur transitoire et le disjoncteur du
    serveur.

La boucle (``_chat_with_tools``) appelle cette fonction par SA globale
``_llama_chat_with_tools_stream`` : c'est le point de substitution des tests.
La taille de contexte est lue à l'appel via ``_model_info``, comme dans le
reste de la boucle.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Callable, Dict, List, Optional, cast

import httpx

from llm_core import _model_info
from llm_core._chat_classic import (
    _coalesce_system_messages,
    _extract_thinking,
    _http_4xx,
)
from llm_core._llm_retry import (
    LLMFailure,
    llm_error_detail as _llm_error_detail,
    llm_error_is_fatal as _llm_error_is_fatal,
    retry_pause as _llm_retry_pause,
)
from llm_core._mcp_wrappers import _sanitize_schema_for_grammar
from llm_core._stream_tag_parser import ThinkTagSplitter
from llm_core._tool_parsing import (
    _recover_tool_calls_from_reasoning,
    _strip_tool_call_markup,
    extract_tool_calls,
)
from llm_core.context.pruning import strip_internal_keys as _strip_internal_keys
from shared_infra.config import (
    LLAMA_MODEL,
    LLAMA_RESUMABLE_STREAM,
    LLAMA_RETRIES,
    LLAMA_TIMEOUT_SEC,
    LLAMA_URL,
)
from shared_infra.observability.tracing import swallow

logger = logging.getLogger("uvicorn.error")


# Tâches d'arrêt détachées : on les référence pour qu'elles ne soient pas
# ramassées par le GC avant d'avoir abouti (asyncio ne garde qu'une weakref).
_CANCEL_TASKS: set = set()


def _fire_cancel_stream(client, target, conv_id: str, model: str) -> None:
    """Demande au moteur d'arrêter la session, SANS attendre.

    On est déjà dans l'unwind d'une annulation : tout ``await`` ici serait
    ré-annulé immédiatement. La tâche détachée, elle, aboutit.
    """
    if not conv_id:
        return
    from llm_core.providers.llama_stream import cancel_stream
    base = _endpoint_base(getattr(target, "base_url", "") or LLAMA_URL)
    try:
        # En-tête d'auth du serveur visé : sans lui, l'arrêt d'un llama-server
        # protégé par ``--api-key`` rendrait 401 et le modèle continuerait de
        # générer.
        from llm_core.providers.openai_compat import headers as _auth_headers
        t = asyncio.create_task(cancel_stream(
            client, base, conv_id, model, headers=_auth_headers(target)))
    except RuntimeError:
        return          # plus de boucle (arrêt du worker) : rien à faire
    _CANCEL_TASKS.add(t)
    t.add_done_callback(_CANCEL_TASKS.discard)


def _reasoning_cap_chars(payload: Dict[str, Any]) -> int:
    """Seuil de fermeture du raisonnement, EN CARACTÈRES. 0 = jamais.

    Deux sources, la plus basse gagne :
      - le budget souple explicite (``llama.reasoning_soft_budget_tokens``,
        0 par défaut : rien) ;
      - 80 % du plafond de génération de la requête, QUAND il y en a un. Ce
        n'est pas une limite nouvelle : c'est celle qui existe déjà et qui,
        aujourd'hui, coupe le raisonnement au milieu d'une phrase. Sans
        ``max_tokens`` — le cas de la réflexion volontairement non plafonnée
        en local — il n'y a pas de seuil du tout.
    """
    from llm_core.context.tokens import CHARS_PER_TOKEN
    from shared_infra.config import LLAMA_REASONING_SOFT_BUDGET_TOKENS as _soft
    caps = []
    if _soft and int(_soft) > 0:
        caps.append(int(_soft))
    _mt = payload.get("max_tokens")
    if isinstance(_mt, int) and _mt > 0:
        caps.append(int(_mt * 0.8))
    if not caps:
        return 0
    return int(min(caps) * CHARS_PER_TOKEN)


def _publish_completion(inner, sse, chat_id: Optional[str], model: str):
    """Enveloppe ``on_thinking_token`` : dépose une fois l'``id`` de la
    complétion en cours dans le magasin partagé (cf.
    ``shared_infra.llm.reasoning_control``)."""
    done = [False]

    async def _wrapped(segment: str):
        if inner:
            await inner(segment)
        if done[0] or not chat_id or not sse.completion_id:
            return
        done[0] = True
        with swallow("harness.reasoning_control.note"):
            from llm_core.engines import current_engine
            from shared_infra.llm.reasoning_control import note_completion

            # L'écriture fichier (makedirs + open + json.dump + os.replace)
            # ne part pas en SYNC du callback de token, sur la boucle (une fois
            # par complétion, donc par itération de la boucle d'outils) :
            # fire-and-forget ORDONNÉ via le thread unique de
            # ``shared_infra.runtime.ordered_io`` — l'exécuteur par défaut est
            # multi-thread, deux écritures last-write-wins du même tour
            # pourraient s'inverser. La valeur de ``completion_id`` est
            # capturée MAINTENANT, pas au moment où le thread s'exécute.
            from shared_infra.runtime.ordered_io import submit_ordered
            _cid = sse.completion_id
            submit_ordered("reasoning_control.note", note_completion,
                           chat_id, _cid, model, current_engine().key)
    return _wrapped


def _reasoning_guard(inner, cap_chars: int, sse, client, target,
                     model: str, req_id: str):
    """Enveloppe ``on_thinking_token`` : demande la fermeture du bloc de
    raisonnement une seule fois, quand il dépasse ``cap_chars``."""
    seen = [0]
    fired = [False]

    async def _wrapped(segment: str):
        if inner:
            await inner(segment)
        if fired[0]:
            return
        seen[0] += len(segment or "")
        if seen[0] < cap_chars or not sse.completion_id:
            return
        fired[0] = True
        from llm_core.providers.llama_stream import end_reasoning
        base = _endpoint_base(getattr(target, "base_url", "") or LLAMA_URL)
        logger.warning(
            "[LLM_REQ %s] raisonnement au-delà du seuil (~%d caractères) → "
            "fermeture demandée au moteur (le modèle passe à la réponse ; "
            "rien n'est tronqué)", req_id, seen[0])
        try:
            from llm_core.providers.openai_compat import headers as _auth_headers
            t = asyncio.create_task(
                end_reasoning(client, base, sse.completion_id, model,
                              headers=_auth_headers(target)))
        except RuntimeError:
            return
        _CANCEL_TASKS.add(t)
        t.add_done_callback(_CANCEL_TASKS.discard)
    return _wrapped


def _endpoint_base(url: str) -> str:
    """Racine du serveur à partir de l'URL de complétion (``…/v1/chat/
    completions`` → ``…``) : les routes de flux reprenable sont voisines, pas
    filles, de celle-ci."""
    u = (url or "").rstrip("/")
    # ``/v1`` fait partie de la liste, comme dans les deux autres
    # implémentations du même calcul (``llama_caps._base`` et
    # ``chatbot_app.turn.events._cancel_engine_stream``) :
    # un connecteur OpenAI-compatible stocke une base en ``…/v1``, et la
    # garder construirait ``…/v1/v1/stream`` — reprise d'un flux coupé
    # impossible, « Stop » sur un 404 classé en succès (génération jamais
    # arrêtée). L'ordre compte : les suffixes les plus longs d'abord.
    for suffix in ("/v1/chat/completions", "/chat/completions",
                   "/v1/completions", "/v1"):
        if u.endswith(suffix):
            return u[: -len(suffix)]
    return u


def _skipping(cb, already: int):
    """Enveloppe un callback de token pour SAUTER les ``already`` premiers
    caractères déjà envoyés au client.

    La reprise rejoue le flux DEPUIS LE DÉBUT (le tampon du serveur est
    indexé en octets ; nos compteurs sont en caractères — les faire coïncider
    sur de l'UTF-8 serait une source de bugs silencieux). On relit donc tout et
    on ne ré-émet que ce que l'utilisateur n'a pas déjà lu : zéro duplication
    à l'écran, et le résultat final est complet.
    """
    remaining = [max(0, int(already))]

    async def _wrapped(segment: str):
        if remaining[0] > 0:
            n = min(remaining[0], len(segment))
            remaining[0] -= n
            segment = segment[n:]
            if not segment:
                return
        if cb:
            await cb(segment)
    return _wrapped


def _keep_resumed_text(previous, fresh) -> None:
    """Reprise coupée à son tour : le partiel rendu doit couvrir tout ce que
    l'écran a reçu.

    La reprise rejoue le flux depuis le début et n'émet que ce qui dépasse
    ``previous`` (cf. ``_skipping``). Si elle meurt en route, l'écran a
    pourtant reçu ce surplus : rendre ``previous`` seul persisterait un
    partiel plus COURT que ce que l'utilisateur vient de lire, et
    « Continuer » repartirait de trop loin.
    On recopie donc, canal par canal, le plus long des deux EN PLACE dans
    les listes de ``previous`` — ce sont les tampons de garde de l'appelant
    (sink), qui les relit tels quels pour son partiel."""
    if previous is None or fresh is None:
        return
    for _attr in ("content_parts", "thinking_parts"):
        _old = getattr(previous, _attr, None)
        _new = getattr(fresh, _attr, None)
        if _old is None or not _new:
            continue
        if len("".join(_new)) > len("".join(_old)):
            _old[:] = list(_new)


async def _resume_cut_stream(client, target, conv_id: str, model: str,
                             err: BaseException, *, req_id: str, user_id: str,
                             previous, is_cancelled,
                             on_thinking_token, on_content_token,
                             stream_timeout):
    """Reprend un flux coupé par le TRANSPORT, depuis le tampon du moteur.

    Retourne le résultat COMPLET (flux rejoué du début, tokens déjà lus non
    ré-émis), ou ``None`` quand la reprise n'est pas possible — l'appelant
    retombe alors sur le partiel + bouton « Continuer ».

    Ne s'applique qu'aux coupures de transport : un refus HTTP (4xx/5xx) n'a
    créé aucune session à reprendre, et une annulation est un ARRÊT voulu.
    """
    if not conv_id or isinstance(err, asyncio.CancelledError):
        return None
    if isinstance(err, httpx.HTTPStatusError):
        return None
    base = _endpoint_base(getattr(target, "base_url", "") or LLAMA_URL)
    from llm_core._stream_tag_parser import ThinkTagSplitter
    from llm_core.providers.llama_stream import lookup_streams, resume_request
    from llm_core.providers.llamacpp import SseStreamResult, consume_llama_sse
    from llm_core.providers.openai_compat import headers as _auth_headers
    _hdrs = _auth_headers(target)
    live = await lookup_streams(client, base, [conv_id], model, headers=_hdrs)
    row = live.get(conv_id)
    if not row:
        logger.info("[LLM_REQ %s] flux coupé (%s) et aucune session reprenable "
                    "— repli sur le partiel", req_id, type(err).__name__)
        return None
    logger.warning(
        "[LLM_REQ %s] flux coupé (%s) → REPRISE depuis le tampon du moteur "
        "(%s octets déjà produits, terminé=%s)",
        req_id, type(err).__name__, row.get("total_bytes"), row.get("is_done"))

    seen_content = len("".join(previous.content_parts)) if previous else 0
    seen_think = len("".join(previous.thinking_parts)) if previous else 0
    fresh = SseStreamResult()
    try:
        async with resume_request(client, base, conv_id, model,
                                  from_bytes=0, timeout=stream_timeout,
                                  headers=_hdrs) as r2:
            if r2.status_code != 200:
                return None
            await consume_llama_sse(
                r2, tag_splitter=ThinkTagSplitter(), req_id=req_id,
                user_id=user_id, is_cancelled=is_cancelled,
                on_thinking_token=_skipping(on_thinking_token, seen_think),
                on_content_token=_skipping(on_content_token, seen_content),
                # Pré-stream d'outils volontairement MUET sur la reprise : le
                # front a déjà reçu les deltas du début, les re-jouer ferait
                # clignoter des cartes d'outils déjà affichées. La structure
                # finale, elle, est bien reconstruite dans ``fresh``.
                on_tool_call_delta=None,
                sink=fresh,
            )
    except asyncio.CancelledError:
        raise
    except Exception as e2:  # noqa: BLE001 — reprise impossible : repli sur le partiel
        logger.warning("[LLM_REQ %s] reprise du flux impossible (%s) — repli "
                       "sur le partiel", req_id, str(e2)[:150])
        _keep_resumed_text(previous, fresh)
        return None
    logger.info("[LLM_REQ %s] reprise réussie : %d caractères au total "
                "(%d déjà lus, %d rendus à l'écran)", req_id,
                len(fresh.content()), seen_content,
                max(0, len(fresh.content()) - seen_content))
    return fresh


async def _llama_chat_with_tools_stream(
    messages: List[Dict],
    tools_payload: List[Dict],
    model_override: Optional[str] = None,
    user_id: str = "guest",
    on_thinking_token: Optional[Callable] = None,
    on_content_token:  Optional[Callable] = None,
    on_tool_call_delta: Optional[Callable] = None,
    on_prompt_progress: Optional[Callable] = None,
    is_cancelled:      Optional[Callable[[], bool]] = None,
    sampling_override: Optional[Dict[str, Any]] = None,
    thinking_mode:     bool = False,
    chat_id:           Optional[str] = None,
    resume_think:      Optional[str] = None,
    resume_native_ok:  bool = True,
    resume_content:    Optional[str] = None,
    tool_choice:       str = "auto",
) -> Dict[str, Any]:
    """
    POST /v1/chat/completions avec tools[] en mode stream:True.

    ``tool_choice`` : ``"none"`` pour un tour qui garde ``tools[]`` (préfixe
    KV identique aux itérations) sans offrir d'appel — tour de synthèse.
    Vérifié dans llama.cpp (``oaicompat_chat_params_parse`` puis
    ``common_chat_templates_apply``) : les outils restent rendus dans le
    gabarit, seules la grammaire et l'analyse d'appels sont désactivées.

    ``resume_think`` (auto-reprise d'un raisonnement coupé par le plafond) :
    raisonnement accumulé à POURSUIVRE. Mode natif ``continue_final_message``
    tenté d'abord (reprise token-exacte DANS le bloc think, KV-cache-friendly) ;
    un 4xx bascule en repli prefill ``<think>`` non fermé (+ mémorisation du
    non-support via ``note_continue_final_support``). ``tools[]`` est conservé :
    le modèle peut conclure sa réflexion PUIS appeler un outil.

    Reconstruit les tool_calls depuis les deltas SSE.
    Relaie raisonnement et réponse en temps réel (``on_thinking_token``,
    ``on_content_token``).

    ``on_tool_call_delta(index, name_delta, args_delta)`` : callback appelé à
    chaque fragment d'argument / nom reçu depuis llama.cpp AVANT que le tool
    soit exécuté. Utilisé pour pré-afficher en streaming le contenu que le
    modèle va écrire (write_file, edit_file) dans l'éditeur côté frontend.
    Les fragments sont des strings JSON brutes — au frontend de les décoder
    progressivement.

    Fallback automatique vers stream:False si le serveur répond 500
    (certains serveurs ne supportent pas stream+tools).
    Retourne un dict normalisé format non-streaming.
    """
    from llm_core._target import current_target
    _target = current_target()
    # cf. _chat_classic : ``_llama_native`` (TYPE du fournisseur SEUL) garde les
    # extensions de payload pour toute cible llama.cpp ; ``_llamacpp_srv`` gate
    # les appels aux endpoints spécifiques d'un llama-server (/props, /slots),
    # qui suivent le serveur de la CIBLE (intégré OU connecteur llama.cpp) —
    # un moteur vLLM/générique ne les expose pas.
    _llama_native = _target.provider_type == "llamacpp"
    _llamacpp_srv = _target.is_llamacpp
    target_model = model_override or _target.model or LLAMA_MODEL
    # Normalisation pour les templates STRICTS : un seul ``system`` en tête. L'app
    # injecte un 2e system (runtime_context + capacités) quand des outils fs/shell/
    # git sont actifs → Qwen3.5 & co lèvent « System message must be at the
    # beginning » (HTTP 400). cf. _coalesce_system_messages. Étape DISTINCTE du
    # clamp (concern séparé) appliquée juste avant l'envoi.
    # Pas de clamp en NOMBRE de messages : la seule borne est le budget en
    # TOKENS (fit_context / budget dur en
    # amont). Si le prompt dépasse malgré tout la fenêtre, le serveur répond
    # « contexte dépassé » → message utilisateur clair (KIND_CONTEXT_OVERFLOW),
    # au lieu d'une amnésie silencieuse des vieux messages.
    # Clés INTERNES du harnais (``_ephemeral``…) retirées ICI, au dernier
    # moment : elles pilotent le comptage de tours côté app mais sont des
    # champs INCONNUS pour un fournisseur strict (400 à l'envoi). Le strip
    # opère sur la copie transitoire — la vue de la boucle les garde.
    msgs = _coalesce_system_messages(_strip_internal_keys(list(messages)))

    # ── Connecteur Anthropic natif : délègue à l'adaptateur /v1/messages ──
    # Renvoie un dict OpenAI non-streaming (mêmes choices/usage) → la boucle
    # agentique appelante reste inchangée.
    if _target.wire == "anthropic":
        from llm_core.providers.anthropic import anthropic_chat_with_tools_stream
        # Messages NON strippés : l'adaptateur relit ``_anthropic_thinking``
        # (blocs signés à rejouer) et reconstruit de toute façon chaque
        # message — aucune clé interne n'atteint l'API.
        return await anthropic_chat_with_tools_stream(
            _coalesce_system_messages(list(messages)), tools_payload, target=_target, model=target_model,
            on_thinking_token=on_thinking_token, on_content_token=on_content_token,
            on_tool_call_delta=on_tool_call_delta, is_cancelled=is_cancelled,
            sampling_override=sampling_override, thinking_mode=thinking_mode,
            chat_id=chat_id,
        )

    # ── Traçage multi-user ─────────────────────────────────────────────────
    import uuid as _uuid
    _req_id = _uuid.uuid4().hex[:8]
    _prompt_chars = sum(len((m.get("content") or "")) for m in msgs if isinstance(m.get("content"), str))

    if tools_payload:
        logger.info(
            "[LLM_REQ %s] START_TOOLS user=%r model=%r n_tools=%d msgs=%d prompt_chars=%d",
            _req_id, user_id, target_model, len(tools_payload), len(msgs), _prompt_chars,
        )
    else:
        logger.info(
            "[LLM_REQ %s] START_TOOLS user=%r model=%r (pas d'outils) msgs=%d prompt_chars=%d",
            _req_id, user_id, target_model, len(msgs), _prompt_chars,
        )

    # ── Paramètres de sampling : pilotés par /props du modèle + override UI ──
    # Les valeurs viennent du GGUF (calibré par l'auteur pour un bon
    # tool-calling), et l'utilisateur peut ajuster via sampling_override envoyé
    # depuis le frontend.
    #
    # Note sur ``thinking_mode`` : le paramètre est ACCEPTÉ (signature
    # kwargs-compatible avec run_chat_multi_mcp et la classic path) mais
    # il N'INJECTE PAS ``payload["thinking"]`` ici — contrairement à la
    # classic path. Raison : sur certaines builds llama.cpp, la combinai-
    # son ``thinking`` + ``tools[]`` déclenche un 400 Bad Request au
    # niveau du parseur de payload. Le thinking en mode tools est piloté
    # par le chat_template du modèle lui-même (Qwen3 et dérivés ont un
    # ``enable_thinking=true`` par défaut dans leur template, donc le
    # modèle pense naturellement même sans hint explicite dans le
    # payload). Le ``task`` passé à ``resolve_sampling`` reflète quand
    # même le mode pour que les paramètres de sampling (temperature,
    # top_p) soient cohérents avec le mode de génération attendu.
    if _llamacpp_srv:
        from llm_core._llm_params import resolve_sampling
        sampling_params = await resolve_sampling(
            model_id=target_model,
            task=("thinking" if thinking_mode else "tools"),
            request_override=sampling_override,
        )
    else:
        # Cible distante (cloud/vLLM) : pas d'interrogation du /props LOCAL.
        from llm_core.providers.openai_compat import remote_sampling
        sampling_params = remote_sampling(sampling_override)

    # Corps de requête COMMUN aux deux moteurs (→ providers.llamacpp) :
    # skeleton + KV-cache + clamp de génération adaptatif au n_ctx +
    # chat_template_kwargs + slot pinning. IMPORTANT : ce chemin ne pose PAS
    # ``payload["thinking"]`` même en thinking_mode — thinking + tools[] → 400
    # côté llama.cpp ; le thinking passe par chat_template_kwargs (posé dans
    # build_llama_payload). Le ``task`` de sampling reflète quand même le mode.
    from llm_core._llm_params import (
        sanitize_preserve_reasoning,
        sanitize_reasoning_effort,
    )

    # ── Transport selon la cible (connecteur) ─────────────────────────────
    # Défaut (llama.cpp intégré) : client partagé + LLAMA_URL + payload
    # inchangé. OpenAI-compatible distant : client dédié + URL chat/completions
    # + Bearer + retrait des champs llama-only (sinon 400 côté cloud).
    from llm_core.providers import openai_compat as _oai
    from llm_core.providers.llamacpp import build_llama_payload as _build_payload
    client, _req_url, _req_headers = _oai.endpoint(_target)
    # ── Flux REPRENABLE (llama-server b10545+) ───────────────────────────────
    # Adosse la génération à une session nommée côté moteur : une coupure du
    # transport (veille du portable, proxy, recyclage de worker, read-timeout)
    # ne la tue plus, et on relit le tampon au lieu de perdre la fin du tour.
    # ⚠ En contrepartie, fermer le flux n'arrête plus le modèle : l'arrêt passe
    # par ``cancel_stream`` (câblé sur l'annulation, plus bas).
    _conv_id = ""
    if _llama_native and LLAMA_RESUMABLE_STREAM and chat_id:
        # ⚠ Ici la PREUVE est exigée : nommer la session n'a de sens que si
        # ``/v1/stream`` existe en face. Sur un build ancien l'en-tête serait
        # ignoré, mais la reprise se solderait par un 404 à chaque coupure —
        # et surtout ``DELETE /v1/stream`` n'arrêterait rien, alors que tout
        # le contrat d'annulation repose dessus. Moteur non identifié ⇒ flux
        # non nommé, non reprenable.
        # On sonde la cible RÉELLE : la garde d'entrée ``_llama_native`` est
        # vraie aussi pour un CONNECTEUR llama.cpp distant, et sans cible
        # ``engine_caps`` retomberait sur ``LLAMA_URL`` (le moteur LOCAL) —
        # on déciderait des capacités du serveur B en interrogeant le serveur
        # A. On passe le SERVEUR de la cible (``EngineRef``), pas sa seule
        # base : la sonde part avec l'en-tête d'auth (sinon 401 sur un
        # llama-server protégé par ``--api-key``). Le cache est indexé par
        # serveur : une requête toutes les 5 minutes et par serveur.
        from llm_core.engines import current_engine as _cur_engine
        from llm_core.providers.llama_caps import engine_caps as _eng_caps
        if (await _eng_caps(engine=_cur_engine())).resumable_stream:
            from llm_core.providers.llama_stream import (
                conversation_id as _conv_of,
                headers_with_conv as _hdr_conv,
            )
            _conv_id = _conv_of(user_id, chat_id)
            _req_headers = _hdr_conv(_req_headers, _conv_id)

    # Reprise : mode natif tenté d'abord, SAUF non-support mémorisé ou
    # ``resume_native_ok=False`` (le raisonnement du tour coupé est arrivé par
    # BALISES <think> dans content — serveur en --reasoning-format none — où
    # une continuation native arriverait sans balise ouvrante et serait
    # classée content) → repli « conclusion » directement.
    _resume_native = False
    if resume_think is not None and _llamacpp_srv:
        from llm_core._llm_params import continue_final_support
        _resume_native = bool(resume_native_ok
                              and continue_final_support(target_model) is not False)

    async def _build_full_payload(*, native_resume: bool) -> Dict[str, Any]:
        """Payload complet (skeleton + reprise éventuelle + tools[] + sanitize).

        Factorisé pour être REJOUABLE : un 4xx sur la reprise native bascule en
        repli prefill et reconstruit le payload sans dupliquer ce bloc."""
        _m = msgs
        _tm = thinking_mode
        _flags: Dict[str, Any] = {}
        if resume_content is not None:
            # Reprise de PROSE : uniquement le canal natif (l'appelant l'a
            # déjà vérifié via should_auto_resume_content). Le serveur re-rend
            # le dernier message assistant NON fermé et continue dedans.
            from llm_core._think_resume import build_content_resume_tail
            _tail, _flags = build_content_resume_tail(resume_content)
            _m = msgs + _tail
        elif resume_think is not None:
            from llm_core._think_resume import build_resume_tail
            _tail, _flags = build_resume_tail(resume_think, native=native_resume)
            _m = msgs + _tail
            if not native_resume:
                # Prefill assistant ⟂ enable_thinking (llama.cpp) : le repli
                # coupe le kwarg de template. Le repli est un prefill FERMÉ +
                # consigne de conclusion (``_think_resume``) : la continuation
                # est routée en CONTENU, et c'est voulu.
                _tm = False
        # reasoning_effort passe par chat_template_kwargs (posé dans
        # build_llama_payload) : compatible tools[] — contrairement à
        # payload["thinking"], c'est le template qui consomme le kwarg.
        p: Dict[str, Any] = await _build_payload(
            _m, target_model=target_model, user_id=user_id,
            sampling_params=sampling_params, llama_native=_llama_native,
            local_llamacpp=_llamacpp_srv, thinking_mode=_tm,
            chat_id=chat_id,
            reasoning_effort=sanitize_reasoning_effort(sampling_override),
            preserve_reasoning=sanitize_preserve_reasoning(sampling_override),
        )
        p.update(_flags)
        if tools_payload:
            # Filet de sécurité au POINT D'ENVOI : normalise le JSON Schema de CHAQUE
            # outil pour le convertisseur grammaire de llama.cpp (retrait des schémas
            # booléens — cf. _sanitize_schema_for_grammar). Couvre TOUTE source d'outil
            # (MCP déjà normalisé à la conversion, builtins, legacy) : un seul schéma
            # booléen (champ pydantic Any/list/tuple) fait échouer en 400 TOUTE la
            # requête sur les builds llama.cpp récents. Idempotent.
            _norm_payload = []
            for _t in tools_payload:
                _fn = (_t.get("function") or {}) if isinstance(_t, dict) else {}
                _params = _fn.get("parameters")
                if isinstance(_params, dict):
                    _t = {**_t, "function": {**_fn, "parameters": _sanitize_schema_for_grammar(_params)}}
                _norm_payload.append(_t)
            # Ordre DÉTERMINISTE (tri stable par nom) → la sérialisation de tools[]
            # est byte-identique d'un tour à l'autre. Les définitions d'outils sont
            # rendues EN TÊTE du prompt par le chat template ; un ordre qui varierait
            # (itération du pool MCP, reconnexion d'un serveur) casserait le
            # prefix-cache dès le préfixe. Le SET d'outils est inchangé — seul
            # l'ordre est figé.
            p["tools"] = sorted(
                _norm_payload,
                key=lambda _t: ((_t.get("function") or {}).get("name") or ""),
            )
            p["tool_choice"] = tool_choice if tool_choice in ("auto", "none") else "auto"
        _oai.sanitize_payload(p, _target)
        return p

    payload: Dict[str, Any] = await _build_full_payload(native_resume=_resume_native)

    # Read-timeout du flux adapté à la fenêtre du modèle (prefill silencieux :
    # cf. rationale dans _client.stream_timeout_for_ctx). Cible LOCALE
    # seulement — le prefill d'un fournisseur distant est côté cloud. Le
    # kwarg n'est passé QUE si la fenêtre impose d'élargir le read au-delà du
    # défaut client (petit modèle → requête sans kwarg de délai).
    _stream_to = None
    if _llamacpp_srv:
        try:
            from llm_core._client import stream_timeout_for_ctx
            from llm_core.providers.llama_stream import has_alive_signal
            if has_alive_signal(target_model):
                # Moteur qui a DÉJÀ prouvé qu'il ping pendant le silence : le
                # read-timeout n'a plus à couvrir toute la durée du
                # pré-remplissage, seulement un trou de ping. Un moteur
                # vraiment planté est donc détecté en une minute au lieu du
                # plafond étiré — et, s'il ne l'était pas, la reprise
                # rattraperait le flux de toute façon.
                from shared_infra.config import LLAMA_SSE_PING_INTERVAL_S
                _read_s = max(60.0, 4.0 * float(LLAMA_SSE_PING_INTERVAL_S or 15))
                _stream_to = httpx.Timeout(LLAMA_TIMEOUT_SEC, connect=15.0,
                                           read=_read_s)
            else:
                _cand = stream_timeout_for_ctx(
                    await _model_info.get_model_context_size(target_model))
                if (_cand.read or 0) > float(LLAMA_TIMEOUT_SEC):
                    _stream_to = _cand
        except Exception:  # noqa: BLE001 — délai de lecture par défaut
            _stream_to = None

    last_err = None
    for attempt in range(LLAMA_RETRIES + 1):
        tool_calls_acc: Dict[int, Dict] = {}
        content_parts:  List[str]       = []
        thinking_parts: List[str]       = []
        usage:          Dict            = {}
        timings:        Dict            = {}
        finish_reason:  str             = ""
        # Même découpeur que le chemin sans outils (``_chat_classic``) :
        # une balise ``<think>`` / ``</think>`` coupée entre deux morceaux
        # SSE serait sinon manquée, et la réponse resterait piégée dans
        # ``thinking_parts`` (cf. l'en-tête de ``llm_core/_stream_tag_parser.py``).
        tag_splitter:   ThinkTagSplitter = ThinkTagSplitter()
        # See same flag in llama_chat_stream_tokens — when the model
        # already wrote reasoning via the native ``reasoning_content``
        # channel, any later ``<think>`` block in ``content`` is most
        # likely a duplicate, not new reasoning. Route it as content.
        stream_pre_emitted_thinking: bool = False

        try:
            async with client.stream(
                "POST", _req_url, json=payload, headers=_req_headers,
                **cast(Dict[str, Any],
                       {"timeout": _stream_to} if _stream_to is not None else {}),
            ) as resp:
                # En streaming, httpx ne lit PAS le corps : ``raise_for_status``
                # ne produit alors que « Client error '400 Bad Request' for url
                # … », et le motif réel du refus — contexte dépassé vs schéma
                # d'outil invalide — est définitivement perdu. On lit le corps
                # AVANT de lever, pour que ``llm_error_kind`` puisse le
                # classer et l'utilisateur recevoir un message actionnable.
                # Uniquement sur erreur : lire un 200 ici bufferiserait tout
                # le flux et tuerait le streaming.
                if resp.status_code >= 400:
                    with swallow("harness.llama_chat_with_tools_stream"):
                        await resp.aread()
                # ── 500 = parser tool_call llama.cpp en panne (Qwen3, etc.) ─
                # Stratégie de fallback en 2 temps :
                # 1) Retry non-streaming AVEC tools (peut-être juste un bug de stream)
                # 2) Si ça échoue encore → retry SANS tools, on demande au LLM
                #    de répondre en texte libre, puis on parse via extract_tool_calls
                #    qui supporte XML <tool_call>, JSON, <function=>, etc.
                if resp.status_code == 500:
                    logger.info("[tools_stream] 500 sur stream+tools → fallback non-streaming avec tools")
                    fb_payload = {**payload, "stream": False}
                    fb_payload.pop("thinking", None)
                    try:
                        fb_resp = await client.post(
                            _req_url, json=fb_payload, headers=_req_headers,
                        )
                        fb_resp.raise_for_status()
                        data = fb_resp.json()
                        msg = (data.get("choices") or [{}])[0].get("message") or {}
                        _rc = (msg.get("reasoning_content") or "").strip()
                        _ct = (msg.get("content") or "").strip()
                        if not _rc:
                            _rc, _ct = _extract_thinking(_ct)
                            # Le raisonnement extrait QUITTE le contenu : sinon
                            # il repartirait dans l'historique (``_iter_clean``)
                            # et dans le parseur d'appels en texte, la boucle
                            # sautant sa propre extraction dès qu'un thinking a
                            # été émis.
                            if _rc and isinstance(msg, dict):
                                msg["content"] = _ct
                                msg["reasoning_content"] = _rc
                        if _rc and on_thinking_token:
                            for i in range(0, len(_rc), 40):
                                await on_thinking_token(_rc[i:i+40])
                        return data
                    except Exception as fb_err:  # noqa: BLE001 — étape suivante du repli : appel sans outils
                        # Étape 2 : llama.cpp ne sait toujours pas parser les tool_calls
                        # de ce modèle (Qwen3-Coder etc.). On retry SANS tools et on
                        # parse nous-mêmes la sortie texte libre.
                        logger.warning("[tools_stream] Fallback non-stream a aussi échoué (%s) → retry SANS tools, parsing manuel",
                                       str(fb_err)[:200])
                        no_tools_payload = {k: v for k, v in payload.items() if k not in ("tools", "tool_choice")}
                        no_tools_payload["stream"] = False
                        no_tools_payload.pop("thinking", None)
                        # Hint pour le modèle : il doit émettre du texte (avec
                        # éventuellement <tool_call> XML) au lieu d'attendre un schema
                        try:
                            nt_resp = await client.post(
                                _req_url, json=no_tools_payload, headers=_req_headers,
                            )
                            nt_resp.raise_for_status()
                            nt_data = nt_resp.json()
                            nt_choice = (nt_data.get("choices") or [{}])[0] or {}
                            nt_msg = nt_choice.get("message") or {}
                            nt_text = nt_msg.get("content") or ""
                            # Le VRAI motif de fin est conservé, jamais
                            # remplacé par « tool_calls »/« stop » : un appel
                            # coupé par le plafond (``length``) partirait à
                            # l'exécution avec des arguments amputés, et une
                            # prose tronquée serait rendue sans « Continuer ».
                            # ``length`` est propagé tel quel — la boucle a ses
                            # gardes de troncature (canal natif ET texte) :
                            # l'appel n'est pas exécuté, le tour est relancé
                            # ou offert à « Continuer ».
                            nt_length = (str(nt_choice.get("finish_reason")
                                             or "") == "length")
                            # Parse les tool_calls éventuels via notre extracteur
                            from_text_calls = extract_tool_calls(nt_text)
                            if from_text_calls:
                                # Construit une réponse compatible OpenAI tool_calls format
                                built_tcs = []
                                for i, (tname, targs) in enumerate(from_text_calls):
                                    built_tcs.append({
                                        "id": f"call_{i}",
                                        "type": "function",
                                        "function": {
                                            "name": tname,
                                            "arguments": json.dumps(targs, ensure_ascii=False),
                                        },
                                    })
                                # Strip TOUS les blocs d'appel d'outil du
                                # contenu visible (Qwen <tool_call> ET Llama
                                # <function=>) — cf. _strip_tool_call_markup.
                                cleaned_content = _strip_tool_call_markup(nt_text)
                                return {
                                    "choices": [{
                                        "finish_reason": ("length" if nt_length
                                                          else "tool_calls"),
                                        "message": {
                                            "role": "assistant",
                                            "content": cleaned_content or None,
                                            "tool_calls": built_tcs,
                                        },
                                    }],
                                    "usage": nt_data.get("usage") or {},
                                    "timings": nt_data.get("timings") or {},
                                }
                            # Pas de tool calls détectés → réponse texte normale
                            return {
                                "choices": [{
                                    "finish_reason": ("length" if nt_length
                                                      else "stop"),
                                    "message": {"role": "assistant", "content": nt_text},
                                }],
                                "usage": nt_data.get("usage") or {},
                                "timings": nt_data.get("timings") or {},
                            }
                        except Exception as nt_err:
                            logger.error("[tools_stream] Fallback sans-tools a échoué aussi : %s", str(nt_err)[:200])
                            raise

                if resp.status_code >= 400:
                    resp.raise_for_status()

                # Boucle SSE + flush : consommateur PARTAGÉ avec le chemin
                # classic (→ providers.llamacpp.consume_llama_sse). Il accumule
                # les tool_calls (canal natif) et route thinking/content à
                # l'identique. Le POST-traitement propre au chemin outils
                # (récupération reasoning, forme de retour) reste ci-dessous.
                from llm_core.providers.llamacpp import (
                    SseStreamResult,
                    consume_llama_sse,
                )
                # ``sink`` dont les listes SONT nos buffers de garde
                # (content_parts/thinking_parts) : consume_llama_sse les remplit
                # AU FIL du flux → le partiel est visible même si le flux lève en
                # cours (erreur transport). Sur un raise, la réaffectation
                # post-retour ci-dessous n'a pas lieu : sans ce branchement, la
                # garde anti-duplication (plus bas) verrait des buffers vides et
                # laisserait un retry ré-émettre tout.
                _sse = SseStreamResult()
                _sse.content_parts = content_parts
                _sse.thinking_parts = thinking_parts
                # L'accumulateur de tool_calls DOIT être celui du sink : sans
                # ce branchement, la garde anti-duplication (``… or
                # tool_calls_acc`` plus bas) verrait toujours un dict VIDE, et
                # une coupure au milieu des arguments d'un ``write_file``
                # laisserait un retry rejouer les ``tool_call_delta`` déjà
                # poussés (aperçu Monaco doublé).
                _sse.tool_calls_acc = tool_calls_acc
                # ── Fin de raisonnement PILOTÉE plutôt que subie ───────────
                # Le chemin outils n'a pas de budget de réflexion :
                # ``thinking_budget_tokens`` + ``tools[]`` = 400 côté
                # llama.cpp. Un raisonnement qui s'emballe serait donc coupé
                # par le plafond de génération, en plein milieu — reprise du
                # raisonnement et aller-retour complet avec le moteur.
                # Le contrôle temps réel change la nature de la limite : on
                # DEMANDE la fermeture du bloc, le modèle sort du raisonnement
                # et rédige sa réponse. Rien n'est tronqué.
                # ⚠ Aucun mur nouveau : sans ``max_tokens`` (réflexion
                # délibérément non plafonnée en local) et sans budget souple
                # explicite, ce garde-fou ne se déclenche JAMAIS.
                _think_cb = on_thinking_token
                if _llama_native and payload.get("reasoning_control"):
                    # Publie l'``id`` de la complétion dès le premier token de
                    # raisonnement : c'est ce qui rend le bouton « Répondre
                    # maintenant » utilisable depuis N'IMPORTE quel worker.
                    # Une écriture par tour, pas par token.
                    _think_cb = _publish_completion(_think_cb, _sse, chat_id,
                                                    target_model)
                _rea_cap = _reasoning_cap_chars(payload)
                if _rea_cap > 0 and _llamacpp_srv:
                    _think_cb = _reasoning_guard(
                        _think_cb, _rea_cap, _sse, client, _target,
                        target_model, _req_id)
                try:
                    _sse = await consume_llama_sse(
                        resp, tag_splitter=tag_splitter, req_id=_req_id,
                        user_id=user_id, is_cancelled=is_cancelled,
                        on_thinking_token=_think_cb,
                        on_content_token=on_content_token,
                        on_tool_call_delta=on_tool_call_delta,
                        on_prompt_progress=on_prompt_progress,
                        sink=_sse,
                    )
                except Exception as _cut:
                    # Coupure du TRANSPORT en plein flux. Le moteur, lui, n'a
                    # rien arrêté (session nommée) : on relit son tampon au
                    # lieu de rendre un partiel et d'armer « Continuer ».
                    _resumed = await _resume_cut_stream(
                        client, _target, _conv_id, target_model, _cut,
                        req_id=_req_id, user_id=user_id,
                        previous=_sse,
                        is_cancelled=is_cancelled,
                        on_thinking_token=on_thinking_token,
                        on_content_token=on_content_token,
                        stream_timeout=_stream_to,
                    )
                    if _resumed is None:
                        raise
                    _sse = _resumed
                    content_parts = _sse.content_parts
                    thinking_parts = _sse.thinking_parts
                    tool_calls_acc = _sse.tool_calls_acc
                finally:
                    # Le flux est fini : cette complétion n'est plus
                    # contrôlable. Sans ce retrait, l'entrée survivrait jusqu'à
                    # son TTL (15 min) et « Répondre maintenant » pourrait
                    # viser un tour mort — le moteur refuserait, et le bouton
                    # retomberait sur le geste coûteux. Idempotent, et sans
                    # effet si rien n'a été publié.
                    if chat_id and payload.get("reasoning_control"):
                        with swallow("harness.reasoning_control.clear"):
                            from shared_infra.llm.reasoning_control import clear_completion
                            clear_completion(chat_id)

            # Le moteur a donné signe de vie pendant le silence du
            # pré-remplissage : on peut resserrer son read-timeout aux tours
            # suivants (cf. llama_stream.note_alive_signal).
            if _sse.prompt_progress:
                from llm_core.providers.llama_stream import note_alive_signal
                note_alive_signal(target_model)

            # Réaffecte les buffers locaux depuis le résultat (post-traitement
            # en aval inchangé ; idempotent — le sink a rempli en place).
            content_parts = _sse.content_parts
            thinking_parts = _sse.thinking_parts
            tool_calls_acc = _sse.tool_calls_acc
            usage = _sse.usage
            timings = _sse.timings
            finish_reason = _sse.finish_reason or ""
            stream_pre_emitted_thinking = _sse.stream_pre_emitted_thinking

            # Assembler la réponse au format dict standard
            built_tcs = _sse.built_tool_calls()
            final_content = "".join(content_parts) or ""

            # ── Récupération d'un tool-call piégé dans le reasoning ──────────
            # Qwen3/GLM-4.x émettent parfois l'appel dans le canal reasoning au
            # lieu du canal tool_calls natif (template/parser qui rate la
            # frontière) → tour mort + markup brut visible dans le « thinking ».
            # Si rien n'a été produit nativement (0 tool-call, 0 prose) mais que
            # le reasoning contient un appel explicite, on le promeut.
            # La promotion est INTERDITE quand le serveur a annoncé
            # ``finish_reason="length"`` : le raisonnement est alors tronqué
            # PAR CONSTRUCTION, et les regex de la Stratégie 2 de
            # ``extract_tool_calls`` sont volontairement tolérantes au bloc non
            # fermé (``(?:</parameter>|$)``) — un ``write_file`` coupé en plein
            # ``content`` serait « extrait » avec sa valeur amputée puis
            # EXÉCUTÉ (fichier écrit à moitié). Réécrire ``finish_reason``
            # effacerait aussi l'information et contournerait les deux gardes
            # anti-troncature de la boucle (canal natif et canal texte).
            # Même interdiction pour la coupure SILENCIEUSE (flux fermé sans
            # ``finish_reason``) : le raisonnement y est tout autant tronqué.
            # Le silence doit être constaté ICI, AVANT la récupération :
            # celle-ci réécrit ``finish_reason`` en « tool_calls », et un
            # ``_silent_cut`` calculé après vaudrait False.
            _silent_cut = bool(not finish_reason)
            _tronque = (str(finish_reason or "") == "length") or _silent_cut
            if not built_tcs and not final_content.strip() and not _tronque:
                _known_names = {
                    (t.get("function") or {}).get("name")
                    for t in (tools_payload or [])
                } - {None, ""}
                _recovered = _recover_tool_calls_from_reasoning(
                    "".join(thinking_parts), known_names=(_known_names or None))
                if _recovered:
                    built_tcs = _recovered
                    # Ni ``length`` ni une coupure silencieuse n'atteignent
                    # ce point (garde ci-dessus) : la réécriture ne peut donc
                    # pas effacer une troncature. Pour ``stop``, c'est la
                    # réécriture en « tool_calls » qui fait exécuter l'appel
                    # récupéré.
                    finish_reason = "tool_calls"
                    logger.warning(
                        "[LLM_REQ %s] %d tool-call(s) récupéré(s) depuis le reasoning "
                        "(canal tool_calls natif manqué — modèle thinking)",
                        _req_id, len(built_tcs),
                    )

            # Log de fin tools_stream : bilan + tool_calls émis
            _in_tok = usage.get("prompt_tokens", 0) if isinstance(usage, dict) else 0
            _out_tok = usage.get("completion_tokens", 0) if isinstance(usage, dict) else 0
            logger.info(
                "[LLM_REQ %s] END_TOOLS user=%r n_tool_calls=%d content_chars=%d in_tok=%d out_tok=%d finish=%s",
                _req_id, user_id, len(built_tcs), len(final_content), _in_tok, _out_tok, finish_reason or "stop",
            )

            # Fin de flux SANS finish_reason ni tool_call : le serveur a fermé
            # le flux sans conclure (crash/coupure réseau SANS exception httpx
            # — l'itérateur SSE se termine simplement). Le classer « stop »
            # mènerait la boucle au chemin RÉPONSE FINALE : un run de
            # plusieurs heures se terminerait « proprement » en pleine mission,
            # sans bouton « Continuer ». Un flux VIDE est RETENTÉ (aucun token
            # émis → aucun risque de duplication côté client) ; un flux non
            # vide devient un PARTIEL de transport — même traitement que le
            # chemin d'exception ci-dessous (troncature/reprise en aval).
            #
            # La détection ne se désarme PAS en présence de tool_calls : c'est
            # précisément le cas d'une coupure au milieu de l'émission des
            # ARGUMENTS. ``built_tool_calls()`` recolle les fragments reçus
            # sans vérifier que le JSON est complet ; sans cette détection, la
            # réponse remonterait en ``finish_reason="tool_calls"`` SANS
            # ``partial`` et la boucle exécuterait l'outil avec des arguments
            # tronqués (``args={}`` après l'échec du parse) — un
            # ``delete_file`` ou un ``git_commit`` amputé partirait pour de
            # bon. Même règle que le chemin d'EXCEPTION, qui abandonne ces
            # tool_calls (« leurs arguments sont tronqués, donc
            # inexécutables »). (``_silent_cut`` est calculé AVANT la
            # récupération ci-dessus.)
            if (_silent_cut and not built_tcs and not final_content.strip()
                    and not "".join(thinking_parts).strip()):
                raise RuntimeError(
                    "flux SSE terminé sans finish_reason (0 token)")
            if _silent_cut and built_tcs:
                logger.warning(
                    "[LLM_REQ %s] flux coupé pendant l'émission de %d "
                    "tool_call(s) — arguments incomplets, abandonnés ; le "
                    "tour repart en partiel.", _req_id, len(built_tcs))
                built_tcs = []
            _fr = finish_reason or (
                "tool_calls" if built_tcs else ("length" if _silent_cut else "stop"))
            # Capture de l'échange pour le viewer admin "Trafic LLM" (best-effort,
            # gated par LLM_DEBUG_ENABLED ; le "thinking" n'est PAS journalisé).
            with swallow("harness.llama_chat_with_tools_stream.2"):
                from llm_core._llm_debug import capture_llm_exchange_async
                await capture_llm_exchange_async(
                    req_id=_req_id, user_id=user_id, chat_id=chat_id,
                    model=target_model, path="tools", request_payload=payload,
                    content=final_content, tool_calls=built_tcs,
                    usage=usage, timings=timings, finish_reason=_fr, status="ok",
                )
            if (resume_content is not None
                    or (resume_think is not None and _resume_native)):
                # Reprise native ABOUTIE → support confirmé pour ce modèle.
                from llm_core._llm_params import note_continue_final_support
                note_continue_final_support(target_model, True)
            # Le moteur a répondu : un ``ConnectError`` ultérieur sera traité
            # comme un REDÉMARRAGE (attente /health) et non comme un serveur
            # absent — cf. llm_core._llm_retry.note_llm_success.
            with swallow("harness.note_llm_success"):
                from llm_core._llm_retry import note_llm_success
                note_llm_success()
            return {
                "choices": [{
                    "finish_reason": _fr,
                    "message": {
                        "role":       "assistant",
                        "content":    final_content or None,
                        "tool_calls": built_tcs or None,
                    },
                }],
                "usage": usage,
                "timings": timings,
                # Le raisonnement de CE tour est-il arrivé par le canal natif
                # ``reasoning_content`` ? Pilote le MODE d'une éventuelle
                # auto-reprise du tour suivant (natif vs repli).
                "reasoning_channel_native": bool(stream_pre_emitted_thinking),
                # Coupure silencieuse (fin de flux sans finish_reason) :
                # marquée comme partiel de TRANSPORT, parité avec le chemin
                # d'exception.
                **({"partial": True} if _silent_cut else {}),
            }

        except asyncio.CancelledError:
            # ⚠ Avec une session nommée, fermer le flux N'ARRÊTE PLUS le
            # modèle — c'est le prix de la reprise. L'arrêt doit donc être
            # DIT au moteur, sinon un Stop laisserait la génération courir
            # jusqu'à l'EOS, sur le seul slot de la machine.
            _fire_cancel_stream(client, _target, _conv_id, target_model)
            raise
        except Exception as e:  # noqa: BLE001 — tentative suivante, ou partiel déjà émis
            last_err = e
            logger.warning("[LLM_REQ %s] tools_stream attempt %d failed: %s",
                           _req_id, attempt + 1, str(e)[:200])
            # Pas de retry si des tokens ont déjà été streamés :
            # le retry ré-émettrait tout depuis zéro → contenu dupliqué côté
            # client. On retourne le PARTIEL accumulé (déjà reçu via
            # on_*_token) comme un tour terminé SANS tool calls. Les
            # tool_calls éventuellement reçus à moitié sont abandonnés —
            # leurs ``arguments`` sont tronqués, donc inexécutables.
            # ``tool_calls_acc`` compte aussi : des fragments
            # d'arguments déjà poussés au front (tool_call_delta) seraient
            # rejoués à l'identique par un retry (même iter/index).
            if content_parts or thinking_parts or tool_calls_acc:
                logger.warning(
                    "[LLM_REQ %s] tools_stream interrompu après émission "
                    "partielle — pas de retry, retour du partiel.", _req_id,
                )
                # Coupure de TRANSPORT dont la reprise a échoué : avec une
                # session nommée, le moteur, lui,
                # continue de générer jusqu'à l'EOS, sur un slot que
                # l'ordonnanceur croit libre dès ce retour. On lui DIT
                # d'arrêter, comme sur un Stop. Un refus HTTP (4xx/5xx, erreur
                # SSE du fournisseur) n'a rien laissé tourner : rien à arrêter.
                if not isinstance(e, httpx.HTTPStatusError):
                    _fire_cancel_stream(client, _target, _conv_id, target_model)
                with swallow("harness.llama_chat_with_tools_stream.3"):
                    from llm_core._llm_debug import capture_llm_exchange_async
                    await capture_llm_exchange_async(
                        req_id=_req_id, user_id=user_id, chat_id=chat_id,
                        model=target_model, path="tools", request_payload=payload,
                        content="".join(content_parts), usage=usage, timings=timings,
                        finish_reason="partial", status="partial", error=str(e)[:500],
                    )
                return {
                    "choices": [{
                        # Un partiel de transport est par nature INCOMPLET :
                        # ``length`` (et non ``stop``) pour que la boucle arme
                        # ``truncated``/``truncated_in_think`` — parité avec le
                        # chemin classic, qui retournait déjà ``truncated``
                        # quand ce chemin finissait en « stop » silencieux.
                        "finish_reason": "length",
                        "message": {
                            "role": "assistant",
                            "content": ("".join(content_parts) or None),
                            "tool_calls": None,
                        },
                    }],
                    "usage": usage,
                    "timings": timings,
                    # Marqueur racine : le serveur vient de timeouter/planter —
                    # bloque l'auto-reprise (pas de re-POST aveugle).
                    "partial": True,
                }
            # Un 4xx (hors 408/429) est une requête invalide
            # (schéma/grammaire/contexte) : la rejouer à l'identique reproduit
            # exactement le même refus. On abandonne immédiatement au lieu de
            # brûler les tentatives.
            if _llm_error_is_fatal(e):
                # Reprise NATIVE refusée (4xx) = build llama-server sans
                # ``continue_final_message`` : mémoriser puis rejouer LE MÊME
                # appel en mode prefill (repli) — la reprise n'est pas perdue.
                if resume_content is not None and _http_4xx(e):
                    # Reprise de PROSE refusée : le serveur ne connaît pas
                    # ``continue_final_message``. On mémorise (les tentatives
                    # suivantes n'essaieront plus) et on ABANDONNE la reprise —
                    # il n'existe pas de repli sûr pour la prose, cf.
                    # _think_resume.should_auto_resume_content. L'appelant
                    # retombe sur le partiel + « Continuer ».
                    from llm_core._llm_params import note_continue_final_support
                    note_continue_final_support(target_model, False)
                    logger.warning(
                        "[LLM_REQ %s] continue_final_message refusé (%s) — "
                        "reprise de prose abandonnée", _req_id, str(e)[:120],
                    )
                    break
                if resume_think is not None and _resume_native and _http_4xx(e):
                    from llm_core._llm_params import note_continue_final_support
                    note_continue_final_support(target_model, False)
                    logger.warning(
                        "[LLM_REQ %s] continue_final_message refusé (%s) → "
                        "repli prefill <think>", _req_id, str(e)[:120],
                    )
                    _resume_native = False
                    payload = await _build_full_payload(native_resume=False)
                    continue
                logger.warning(
                    "[LLM_REQ %s] erreur non-retryable (%s) — abandon immédiat",
                    _req_id, str(e)[:150],
                )
                break
            if attempt < LLAMA_RETRIES:
                # Backoff expo plafonné + full jitter ; sur 503 llama local
                # (modèle en chargement), attend /health prêt à la place.
                await _llm_retry_pause(e, attempt,
                                       is_cancelled=is_cancelled,
                                       label="tools_stream")

    with swallow("harness.llama_chat_with_tools_stream.4"):
        from llm_core._llm_debug import capture_llm_exchange_async
        await capture_llm_exchange_async(
            req_id=_req_id, user_id=user_id, chat_id=chat_id,
            model=target_model, path="tools", request_payload=payload,
            # Le CORPS de la réponse d'erreur, pas seulement « Client error
            # '400 Bad Request' for url … » : c'est le corps qui dit lequel
            # des champs/messages le moteur a refusé. Sans lui, diagnostiquer
            # un refus demande de rejouer ``llm_calls.request_json`` à la main.
            content="", status="error",
            error=_llm_error_detail(last_err)[:1000],
        )
    # LLMFailure porte le message ACTIONNABLE (str) + le motif technique
    # (.detail) + la famille (.kind) : la bulle de chat affiche une cause et un
    # geste, jamais le texte brut de httpx.
    # Le disjoncteur est nourri ICI, pas dans le garde : ce ``raise`` produit
    # un ``LLMFailure`` (RuntimeError), que la boucle agentique attrape avant
    # que le garde ne puisse voir quoi que ce soit.
    with swallow("harness.breaker_note_tools"):
        from llm_core._scheduling._breaker import note_transport_failure
        from llm_core._scheduling._engines import breaker_key as _bk
        from llm_core.engines import current_engine as _ce_brk
        # Clé du serveur de la cible : la panne d'un connecteur n'ouvre pas
        # le circuit du modèle HOMONYME de l'intégré.
        note_transport_failure(_bk(_ce_brk(), target_model), last_err)
    raise LLMFailure(last_err,
                     attempts=(1 if _llm_error_is_fatal(last_err)
                               else LLAMA_RETRIES + 1))
