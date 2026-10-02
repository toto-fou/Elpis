# SPDX-License-Identifier: MIT
"""
chatbot_app.routes.chat_compression — compression manuelle d'une
conversation, hors flux.

Routes
------
- GET  /api/chat/{id}/compression-state — état de compression (bouton manuel) ;
- POST /api/chat/{id}/compress          — compression manuelle (``/compact``).

Une compression manuelle et un tour ne tournent jamais en même temps sur une
conversation (``chatbot_app.turn.admission``).
"""
from __future__ import annotations

import asyncio
import logging
import time

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

from chatbot_app.turn.admission import (
    _manual_compression_active,
    _manual_compression_begin,
    _manual_compression_end,
)
from chatbot_app.turn.history import _expand_history_for_llm
from llm_core import llama_chat
from shared_infra.accounts.users import get_user_settings
from shared_infra.chat.store import get_chat, upsert_chat
from shared_infra.observability.tracing import swallow
from shared_infra.observability.usage_ctx import usage_scope
from shared_infra.routes._state import is_generation_active, router
from shared_infra.security.deps import require_user_id

logger = logging.getLogger("uvicorn.error")


@router.get("/api/chat/{chat_id}/compression-state")
def api_chat_compression_state(chat_id: str, request: Request):
    # ``def`` (threadpool), pas ``async def`` :
    # appelée À CHAQUE SWITCH de chat, la route désérialise tout
    # messages_json (get_chat) puis _expand_history_for_llm +
    # measured_prompt_tokens sur l'historique ENTIER — un gel de boucle
    # proportionnel à la plus grosse conversation. Aucun await dans le corps.
    """État de compression d'un chat pour l'UI du bouton manuel.

    Retourne : ``{round, max, can_compress, reason, turns, tokens_estimate,
    estimated, scope}``. ``reason`` ∈ ok | max_reached | too_short |
    generation_running | compression_running.
    ``tokens_estimate`` est l'heuristique unifiée (pas de /tokenize ici :
    l'endpoint est appelé à chaque changement de chat, il doit rester
    gratuit), calculée sur la vue POST-drop — historique seul
    (``scope: history_only``) : ni system prompt du tour, ni schéma tools —
    la jauge live reste la référence d'occupation.
    """
    user_id = require_user_id(request)
    chat = get_chat(user_id, chat_id)
    if not chat:
        raise HTTPException(404, "chat not found")

    from shared_infra import config as _cfg
    with swallow("chat.api_chat_compression_state"):
        _cfg.reload_compression_config_from_disk()
    from llm_core.context.tokens import measured_prompt_tokens
    from llm_core.conversation_compressor import _count_turns, apply_persisted_state, extract_compression_state

    _msgs = [m for m in (chat.get("messages") or [])
             if isinstance(m, dict) and m.get("role") != "system"]
    _expanded = _expand_history_for_llm(
        _msgs, pruned_keys=chat.get("ctx_pruned_keys") or ())
    _state = extract_compression_state(chat.get("messages") or [])
    # Vue RÉELLE de la prochaine requête : le résumé remplace les tours déjà
    # couverts (drop). Compter sur la vue brute rendrait ``can_compress``
    # sur-optimiste (tours couverts recomptés → un clic finirait en
    # ``nothing_to_compress``) et gonflerait ``tokens_estimate`` par rapport
    # à l'envoi réel.
    if _state:
        try:
            _expanded, _ = apply_persisted_state(_expanded, _state)
        except Exception:  # noqa: BLE001 — repli sur la vue brute, tracé
            logger.warning("[compression-state] apply état échoué (vue brute)",
                           exc_info=True)
    _round = int((_state or {}).get("round") or 0)
    # Cap du COMPTE s'il en a réglé un (0 = illimité), défaut d'instance sinon.
    # L'UI affiche « round / max » et grise le bouton sur ce chiffre : le lire
    # ailleurs que le compresseur ferait mentir le badge.
    from llm_core.context.compaction_gate import resolve_max_rounds
    _user_max = resolve_max_rounds(get_user_settings(user_id))
    _max = (_user_max if _user_max is not None
            else int(getattr(_cfg, "COMPRESSION_MAX_PER_CHAT", 0) or 0))
    _turns = _count_turns(_expanded)
    # « Trop court » = rien dans la zone compressible (parité avec la garde
    # nothing_to_compress de compress() : tours ≤ recent+bridge).
    _min_turns = int(getattr(_cfg, "COMPRESSION_KEEP_RECENT", 6)) \
        + int(getattr(_cfg, "COMPRESSION_KEEP_BRIDGE", 3))

    # NB : ``COMPRESSION_ENABLED`` (toggle admin) ne gouverne que la
    # compression AUTOMATIQUE — cet endpoint alimente l'UI MANUELLE
    # (/compact), qui reste disponible quel que soit le toggle.
    if _max > 0 and _round >= _max:
        reason = "max_reached"
    elif is_generation_active(user_id, chat_id):
        reason = "generation_running"
    elif _manual_compression_active(user_id, chat_id):
        reason = "compression_running"
    elif _turns <= _min_turns:
        reason = "too_short"
    else:
        reason = "ok"

    return JSONResponse({
        "round":           _round,
        "max":             _max,
        "can_compress":    reason == "ok",
        "reason":          reason,
        "turns":           _turns,
        # Estimation par le ratio caractères/token MESURÉ
        # (``measured_prompt_tokens`` ; aucun modèle nommé ici : ratio de
        # repli du process) ; toujours marquée estimée.
        "tokens_estimate": measured_prompt_tokens(_expanded),
        "estimated":       True,
        # Périmètre du compte : historique (+ résumé) seul — sans system
        # prompt du tour ni schéma tools. La jauge live reste la référence.
        "scope":           "history_only",
    }, headers={"Cache-Control": "no-cache"})


@router.post("/api/chat/{chat_id}/compress")
async def api_chat_manual_compress(chat_id: str, request: Request):
    """Compression MANUELLE d'un chat persisté, hors streaming.

    Contrairement à /api/chat/compress (déclenché par le client, déprécié),
    ce chemin réutilise le compresseur backend (maybe_compress_conversation,
    ``manual=True`` = seuils bypassés) sur l'historique PERSISTÉ, puis
    persiste l'état résultat (résumé + round) en tête de messages_json.
    Les bulles visibles ne changent pas. Respecte le cap
    COMPRESSION_MAX_PER_CHAT (auto + manuel confondus).

    409 si une génération est en cours sur ce chat (le persist de fin de tour
    écraserait l'état) ou si une compression manuelle y est déjà en vol.
    Échec métier (sans gain, résumé invalide, trop court) → 200
    ``{compressed: false, reason}`` : ce n'est pas une erreur HTTP.
    """
    user_id = require_user_id(request)
    # Threadpool : messages_json entier (cf. compression-state ci-dessus).
    chat = await asyncio.to_thread(get_chat, user_id, chat_id)
    if not chat:
        raise HTTPException(404, "chat not found")
    # Gardes CROSS-WORKER (cf. shared_infra.runtime.chat_locks) : le registre local ne
    # voit pas une génération/compaction hébergée par un autre worker gunicorn.
    if is_generation_active(user_id, chat_id):
        raise HTTPException(409, "generation_running")
    _key = (user_id, chat_id)
    if _manual_compression_active(user_id, chat_id):
        raise HTTPException(409, "compression_running")
    # ── Modèle de compression : le MODÈLE COURANT du chat, PAS le défaut ──────
    # Sans modèle explicite, la résolution ``model_override or _target.model or
    # LLAMA_MODEL`` retomberait sur ``LLAMA_MODEL`` (défaut config, ex. « RAG »
    # sur un routeur) → 400 de llama-server (modèle inexistant). On prend donc
    # le modèle envoyé par le front (selectedModel), sinon le modèle RÉELLEMENT
    # CHARGÉ côté serveur, et seulement en dernier repli LLAMA_MODEL.
    _req_model = None
    _req_connector = None
    try:
        _body = await request.json()
        if isinstance(_body, dict):
            _req_model = (str(_body.get("model") or "").strip() or None)
            _req_connector = _body.get("connector_id")
    except Exception:  # noqa: BLE001 — corps optionnel : illisible = absent
        _req_model = None
    # Le SERVEUR sélectionné compacte, pas toujours l'intégré : avec le seul
    # modèle, un chat mené sur un connecteur serait résumé par le modèle
    # HOMONYME du serveur intégré (ou par un 400 « modèle inexistant »). Même
    # résolution stricte et même politique d'accès que la route de chat.
    from llm_core._target import EngineUnavailable as _EU, resolve_llm_target as _rlt
    try:
        _cid = int(_req_connector) if _req_connector not in (None, "", 0, "0") else None
    except (TypeError, ValueError):
        _cid = None
    try:
        _cmp_target = _rlt(user_id, _cid, _req_model, strict=True)
    except _EU as _eu:
        raise HTTPException(409, {"code": "engine_unavailable",
                                  "reason": _eu.reason, "message": _eu.message})
    _cmp_allowed = True             # fail-open documenté dans engine_access
    with swallow("chat.manual_compress.access"):
        from shared_infra.llm import engine_access as _ea
        _cmp_allowed = _ea.can_use_engine(
            user_id, _ea.connector_key(_cid) if _cid else _ea.BUILTIN_KEY)
    if not _cmp_allowed:
        raise HTTPException(409, {"code": "engine_unavailable", "reason": "forbidden",
                                  "message": "Ce serveur ne vous est pas ouvert."})
    if not _req_model and _cmp_target.is_default:
        try:
            from llm_core import get_currently_loaded_model
            _req_model = await get_currently_loaded_model()
        except Exception:  # noqa: BLE001 — repli sur le modèle par défaut de la résolution
            _req_model = None
    _manual_compression_begin(user_id, chat_id)
    try:
        from shared_infra import config as _cfg
        with swallow("chat.api_chat_manual_compress"):
            _cfg.reload_compression_config_from_disk()
        from llm_core.context.compaction_gate import resolve_max_rounds
        _user_max_rounds = resolve_max_rounds(get_user_settings(user_id))
        from llm_core.conversation_compressor import (
            _strip_summary_messages,
            apply_persisted_state,
            build_state_system_message,
            extract_compression_state,
            maybe_compress_conversation,
        )

        persisted = chat.get("messages") or []
        prev_state = extract_compression_state(persisted)
        bubbles = [m for m in persisted
                   if isinstance(m, dict) and m.get("role") != "system"]
        # Même expansion que le streaming → même indexation de tours que le
        # covered_turns persisté (déterminisme du drop).
        llm_view = _expand_history_for_llm(
            bubbles, pruned_keys=chat.get("ctx_pruned_keys") or ())
        if prev_state:
            llm_view, prev_state = apply_persisted_state(llm_view, prev_state)

        # n_ctx du MODÈLE DE COMPRESSION (le courant), utile aux stats ; pas au
        # déclenchement (manual=True bypasse les seuils).
        from llm_core import set_llm_target as _set_cmp_target
        _set_cmp_target(_cmp_target)    # contextvar : propre à cette requête
        _ctx_tok = 0
        try:
            from llm_core._ctx_window import resolve_context_window as _rcw
            _ctx_tok = int(await _rcw(_req_model or "", _cmp_target) or 0)
        except Exception:  # noqa: BLE001 — fenêtre inconnue (0) : ne sert qu'aux statistiques
            _ctx_tok = 0

        _state_holder: dict = {}

        async def _on_ev(ev: dict):
            if isinstance(ev, dict) and ev.get("type") == "compression_state":
                # Champs UTILES seulement (pas de copie aveugle de l'event :
                # symétrie avec l'interception du chemin streaming).
                for _k in ("round", "covered_turns", "summary_xml",
                           "turns_compressed", "ledger_block"):
                    if _k in ev:
                        _state_holder[_k] = ev[_k]

        _t0 = time.time()
        # Exécution (``runs``) et usage rattachés au compte et à la
        # conversation compactée (sans ce scope, la ligne d'usage n'aurait
        # ni compte ni origine).
        from llm_core.engines import engine_for_target as _eng_cmp
        from shared_infra.observability.runs import run_scope
        async with run_scope("compaction", user_id=user_id, chat_id=chat_id,
                             model=_req_model or "", engine=_eng_cmp(_cmp_target).key):
            with usage_scope("compression", user_id=user_id, origin_id=str(chat_id)):
                _, stats = await maybe_compress_conversation(
                    llm_view,
                    llama_chat_fn   = llama_chat,
                    on_event        = _on_ev,
                    model           = _req_model,   # modèle COURANT (pas le défaut LLAMA_MODEL)
                    user_id         = str(user_id),
                    log_prefix      = "chat_manual",
                    ctx_size_tokens = _ctx_tok or None,
                    prev_state      = prev_state,
                    manual          = True,
                    # Cap par conversation : auto ET manuel partagent le compteur
                    # ``round``, donc le réglage du compte doit valoir des deux côtés —
                    # sinon /compact se ferait refuser par un plafond que l'utilisateur
                    # croit avoir relevé.
                    max_rounds      = _user_max_rounds,
                    fts_session_id  = str(chat_id),
                )

        compressed = bool(stats.get("compressed"))
        if compressed and _state_holder.get("summary_xml"):
            _state_msg = build_state_system_message(
                _state_holder["summary_xml"],
                int(_state_holder.get("round") or 1),
                int(_state_holder.get("covered_turns") or 0),
                turns_compressed=_state_holder.get("turns_compressed"),
                ledger_block=_state_holder.get("ledger_block") or "",
            )
            # Marqueur PERSISTANT dans le fil : l'utilisateur voit OÙ et QUAND
            # la conversation a été compactée (survit au reload — relu par
            # loadChat, renvoyé par le client au tour suivant, et exclu de la
            # vue LLM par _expand_history_for_llm). ``tokens_after`` = taille
            # du contexte APRÈS compaction (c'est elle qu'on affiche).
            _notice = {
                "role":         "notice",
                "kind":         "compaction",
                "ts":           time.time(),
                "round":        int(_state_holder.get("round") or 1),
                "tokens_after": int(stats.get("tokens_after") or 0),
                "content":      "Conversation compactée — contexte ≈ "
                                f"{int(stats.get('tokens_after') or 0):,} tokens".replace(",", " "),
                # Copie du résumé produit, pour l'accordéon de VÉRIFICATION du
                # fil : le porteur system est jeté par le front
                # au reload (_history.js), la notice porte donc sa propre copie.
                # Clip défensif — le budget dur du prompt vise ≤ ~350 mots.
                "summary":      str(_state_holder.get("summary_xml") or "")[:12000],
            }
            new_msgs = [_state_msg] + _strip_summary_messages(persisted) + [_notice]
            try:
                # Concurrence optimiste CROSS-WORKER : n'écrase QUE si le
                # chat n'a pas bougé depuis notre lecture (une génération sur un
                # autre worker a pu persister un nouveau tour pendant notre appel
                # LLM de compression). Sinon → 409 (ne PAS clobberer le tour).
                # Écriture SQLite hors boucle, comme la lecture ``get_chat``
                # de cette même route.
                _persisted_ok = await asyncio.to_thread(
                    upsert_chat,
                    user_id, chat_id, chat.get("title") or "Nouveau chat",
                    new_msgs, time.time(),
                    expected_updated_at=chat.get("updated_at"))
                if not _persisted_ok:
                    return JSONResponse({
                        "ok": False, "compressed": False, "reason": "chat_modified",
                    }, status_code=409)
                # L'occupation persistée décrit l'historique d'AVANT : le
                # front invalide sa jauge (elle se recale au prochain tour),
                # la base fait pareil — sinon un rechargement re-sèmerait
                # une valeur périmée.
                with swallow("chat_manual.ctx_usage"):
                    from shared_infra.chat.store import clear_chat_ctx_usage
                    await asyncio.to_thread(clear_chat_ctx_usage, user_id, chat_id)
            except Exception as _pe:  # noqa: BLE001 — rendu en 500 explicite (``persist_failed``)
                logger.warning("[chat_manual] persist post-compression échoué : %s", _pe)
                return JSONResponse({
                    "ok": False, "compressed": False, "reason": "persist_failed",
                }, status_code=500)

        _max = (_user_max_rounds if _user_max_rounds is not None
                else int(getattr(_cfg, "COMPRESSION_MAX_PER_CHAT", 0) or 0))
        return JSONResponse({
            "ok":         True,
            "compressed": compressed,
            "reason":     stats.get("reason"),
            "stats": {
                "tokens_before":    stats.get("tokens_before"),
                "tokens_after":     stats.get("tokens_after"),
                "tokens_saved":     stats.get("tokens_saved"),
                "tokens_estimated": stats.get("tokens_estimated"),
                "turns_compressed": stats.get("turns_compressed"),
                "round":            stats.get("round") or int((prev_state or {}).get("round") or 0),
                "max":              _max,
                "duration_ms":      stats.get("duration_ms") or int((time.time() - _t0) * 1000),
                "path":             stats.get("path"),
                # Résumé produit → accordéon de vérification (notice optimiste
                # côté front, sans attendre un reload).
                "summary_xml":      str(_state_holder.get("summary_xml") or "")[:12000],
            },
        })
    finally:
        _manual_compression_end(user_id, chat_id)
