# SPDX-License-Identifier: MIT
"""
chatbot_app.turn.execution — exécution d'un tour de chat : ``run_turn``
(générateur NDJSON) et son worker — attente du moteur, compaction du chemin
classique, boucle d'outils, titre, persistance du tour ou du partiel, ``final``
— puis détachement ou clôture du run quand le flux se ferme.

Ordre des événements et invariants : voir l'en-tête de
``chatbot_app/routes/chats.py``.
"""
from __future__ import annotations

import asyncio
import logging
import secrets
import time
from typing import Optional

from chatbot_app.turn.admission import _pending_gen_locks
from chatbot_app.turn.events import (
    _couper_file,
    _drain_coalesced,
    _drop_event_after_cancel,
    _prompt_progress_relay,
    _start_load_watch,
    _stop_load_watch,
)
from chatbot_app.turn.history import _CANCEL_PLACEHOLDER, _compaction_pour_message, _fc_merge
from chatbot_app.turn.persistence import (
    CONTINUE_ADDITIVE_METRICS,
    _attendre_hors_annulation,
    _message_assistant,
    _message_partiel,
    _persist_turn,
    _plan_mode_should_end,
    _suffixe_question,
)
from chatbot_app.turn.preparation import (
    PersistBaseline,
    TurnPlan,
    TurnResources,
    _agent_mcp_configs,
)
from chatbot_app.turn.tasks import keep
from llm_core import llama_chat, llama_chat_stream_tokens, run_chat_multi_mcp

# Import au niveau MODULE : ce nom sert dans une clause ``except`` du worker
# (Stop pendant l'attente d'un modèle occupé).
# Importé dans le corps de la coroutine, il n'existerait pas si l'exception
# survenait avant sa ligne d'import — le gestionnaire lèverait alors un
# NameError en masquant l'erreur d'origine.
from llm_core._scheduling import LLMQueueAborted
from shared_infra.chat.store import enforce_recent_chats_cap, get_chat
from shared_infra.db import log_metric
from shared_infra.observability.tracing import swallow
from shared_infra.observability.usage_ctx import set_usage_context, usage_scope
from shared_infra.routes._helpers import _ndjson_line
from shared_infra.routes._state import (
    clear_chat_cancellation,
    is_chat_cancelled,
    mark_chat_cancelled,
    register_chat_task,
    unregister_chat_task,
)

logger = logging.getLogger("uvicorn.error")


async def _cloturer_run(task: "asyncio.Task", user_id: int,
                        chat_id: str | None, *,
                        final_sent: bool = False) -> None:
    """Clôture du run quand le flux se ferme SANS détachement.

    Fonction de module plutôt que bloc du ``finally`` de ``run_turn`` : elle
    n'utilise que ces valeurs, et un test peut l'atteindre directement.

    Deux entrées très différentes y mènent :
      * la déconnexion d'un client alors que le worker travaille encore
        → on annule, on le dit aux autres workers, on attend l'unwind ;
      * la fin normale du tour (``task.done()``) → il n'y a RIEN à annuler,
        juste le verrou de présence à rendre.
    """
    # On ATTEND la fin du worker après l'annulation : un simple
    # ``task.cancel()`` le laisserait continuer jusqu'à son prochain
    # ``await`` et exécuter son ``finally`` (upsert_chat du partiel) APRÈS
    # le retour du handler — au risque d'écraser un état plus récent si un
    # nouveau message a déjà démarré (write-after-write). L'attente est
    # bornée pour ne pas bloquer si le worker est gelé sur un I/O réseau.
    # L'unregister vient APRÈS le wait_for : un /api/chat/cancel
    # concurrent pendant l'attente doit encore trouver la task via
    # get_active_chat_task.
    # DIRE qu'on annule, pas seulement annuler.
    # Le flag d'annulation est la seule chose que les AUTRES workers
    # voient ; sans lui, la garde de présence prend le verrou encore
    # tenu par ce run mourant pour une génération bien vivante et
    # refuse le tour suivant. Or le cas typique est justement une
    # re-tentative immédiate : le client rejoue un tour SANS OUTIL
    # après une micro-coupure (il ne rejoue jamais un tour qui a
    # exécuté des outils), et la requête atterrit sur un autre worker.
    # Le flag rend ce déroulement lisible partout : la garde attend
    # l'unwind au lieu de répondre 409, et le run visé se termine plus
    # vite (la boucle consulte ce même flag à chaque itération).
    #
    # Ce bloc ne vaut QUE pour un worker encore vivant.
    # ``_should_detach_run`` rend False dans DEUX cas opposés : la
    # déconnexion sans détachement, et la fin NORMALE du tour
    # (``task_done=True``). Ne jamais poser ni publier le flag d'annulation
    # pour un tour réussi : sur les N-1 autres workers il resterait collé
    # (``clear_chat_cancellation`` est purement local, rien ne le diffuse),
    # neutraliserait la sonde précoce du tour suivant, ferait prendre à la
    # garde de présence ce flag périmé pour la preuve d'un Stop (12 s de
    # passation au lieu d'un 409), et ferait grossir le spool d'annulation
    # d'une ligne par tour. Une task terminée n'a rien à annuler.
    #
    # La télémétrie (sync mémoire + métriques) part APRÈS le 'final' : le
    # worker est donc encore vivant quelques ms (davantage sous contention
    # SQLite) alors que le tour est fini côté client. Un flux fermé dans
    # cette fenêtre (onglet fermé, nouveau message enchaîné →
    # reader.cancel()) ne relève pas de l'annulation : avec ``final_sent``,
    # on attend simplement la fin du worker, sans flag ni cancel.
    if final_sent and not task.done():
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=10.0)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass
        except Exception as _e:  # noqa: BLE001 — l'issue du worker ne change rien à la clôture
            logger.debug("[chat_stream] worker post-final: %s", _e)
    elif not task.done():
        with swallow("chat.mark_cancel_on_disconnect"):
            mark_chat_cancelled(user_id, chat_id)
        task.cancel()
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=10.0)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass
        except Exception as _e:  # noqa: BLE001 — l'issue du worker ne change rien à la clôture
            logger.debug("[chat_stream] worker cleanup: %s", _e)
    # On passe l'identité de NOTRE task : pendant le wait_for
    # ci-dessus, une nouvelle génération sur le même chat peut
    # s'être enregistrée sur la même clé — il ne faut pas la
    # désenregistrer (sinon son Stop perd le task.cancel direct).
    #
    # Le désenregistrement (donc la libération du verrou de présence)
    # suit la fin RÉELLE du worker, pas le chronomètre. L'annulation ne
    # s'observe qu'à un ``await`` : un outil parti pour plusieurs minutes
    # (docker exec, git clone) ne déroule pas en 10 s. Libérer quand même
    # déclarerait le chat libre alors qu'un worker fantôme y travaille
    # encore : le Stop suivant ne le trouverait plus, une compaction
    # pourrait démarrer, et le fantôme finirait par écraser l'état — le
    # write-after-write que cette attente existe pour éviter.
    if task.done():
        unregister_chat_task(user_id, chat_id, task)
    else:
        logger.warning(
            "[chat_stream] worker toujours actif 10 s après l'annulation "
            "(user=%s chat=%s) — présence conservée jusqu'à sa fin réelle",
            user_id, chat_id)
        task.add_done_callback(
            lambda _t, _u=user_id, _c=chat_id, _k=task:
                unregister_chat_task(_u, _c, _k))

def _should_detach_run(*, detach_enabled: bool, task_done: bool,
                       user_stopped: bool, tools_ran: bool = False) -> bool:
    """Faut-il DÉTACHER le run plutôt que l'annuler quand le flux se ferme ?

    Le ``finally`` de ``run_turn`` s'exécute dans deux situations très
    différentes : la fin NORMALE du flux (le worker a déjà rendu la main) et
    la DÉCONNEXION du client en pleine génération. Seule la seconde pose la
    question.

    - ``detach_enabled`` : ``DETACH_RUN_ON_DISCONNECT or resumable``
      (calculé par ``run_turn``). Le chat principal pose ``resumable`` : sa
      déconnexion détache toujours le run. L'interrupteur de l'exploitant
      (``llm.detach_run_on_disconnect``, défaut False) étend le détachement
      aux tours non reprenables (studio, sessions éphémères).
    - ``tools_ran`` : AU MOINS UN OUTIL a déjà tourné dans ce tour — le
      critère des tours non reprenables. Un tour qui a écrit des fichiers,
      lancé un shell, commité, dépensé des heures de contexte n'est PAS
      jetable : ni la fermeture d'onglet, ni une veille du portable, ni un
      changement de réseau, ni une session qui expire (le front purge alors
      son état et coupe le flux) ne doivent le tuer. À l'inverse, un tour de
      pur chat sans outil se relance pour trois fois rien : fermer l'onglet
      arrête la génération, seul moyen de l'arrêter depuis un onglet qu'on
      vient de fermer.
    - ``task_done`` : le worker a terminé → il n'y a rien à détacher, et
      ``task.cancel()`` serait de toute façon sans effet.
    - ``user_stopped`` : un Stop EXPLICITE a été demandé. On ne détache jamais
      dans ce cas : c'est une demande d'arrêt, pas une déconnexion subie.
    """
    if task_done or user_stopped:
        return False
    return bool(detach_enabled) or bool(tools_ran)

# ── Titre de chat par le MODÈLE COURANT (adaptation OpenCode title.txt) ──────
# Appelé UNE fois, au premier tour d'un chat sans titre. Borné pour être quasi
# gratuit : entrée TRONQUÉE (600/240 chars), thinking OFF (chat_template_kwargs
# le coupe au niveau template), max_tokens 24, timeout dur. Best-effort : tout
# échec/sortie douteuse → None, l'appelant garde le titre tronqué par défaut.
_TITLE_PROMPT = (
    "You are a title generator. Output ONLY a chat title for the conversation "
    "below. A single line, maximum 50 characters, in the SAME language as the "
    "user message. Keep key technical terms, numbers and filenames. No quotes, "
    "no trailing punctuation, no emoji. Never answer the question itself."
)


async def _generate_chat_title(selected_model, first_user_text, assistant_text,
                               chat_id=None):
    _t0 = time.monotonic()
    try:
        _user = (first_user_text or "").strip()[:600]
        if not _user:
            return None
        logger.info("[chat_title] requête de titre (chat neuf) modèle=%s chat=%s",
                    selected_model, str(chat_id or "")[:12])
        _asst = (assistant_text or "").strip()[:240]
        msgs = [
            {"role": "system", "content": _TITLE_PROMPT},
            {"role": "user", "content": _user + (
                f"\n\n[the assistant's reply was about: {_asst}]" if _asst else "")},
        ]
        # Fenêtre LARGE (la tâche part en DÉBUT de tour et tourne en parallèle
        # du tour principal — elle peut faire la queue derrière lui sur un
        # serveur occupé sans rien coûter) ; c'est la RÉCOLTE au persist qui
        # est bornée court (cf. worker).
        # Scope « title » : ces tokens sont réels (un appel LLM par
        # conversation neuve) et se comptent comme les autres. Le user est
        # hérité du scope parent — la tâche est créée dans le contexte du tour.
        with usage_scope("title", origin_id=str(chat_id or "")):
            _t, content, _meta = await asyncio.wait_for(
                llama_chat_stream_tokens(
                    msgs, user_id="title", model_override=selected_model,
                    thinking_mode=False,
                    sampling_override={"temperature": 0.2, "max_tokens": 24},
                    chat_id=chat_id,
                    # Hors du slot du chat : posé dessus, le titre en
                    # évincerait le KV et le 2e tour re-préremplirait tout le
                    # 1er. ``chat_id`` reste transmis pour le tap « Trafic LLM ».
                    slot_avoid_own=True,
                ),
                timeout=45.0,
            )
        t = (content or "").strip().splitlines()[0].strip()
        t = t.strip('"\'`«»').rstrip(".…:;,").strip()
        # Sortie douteuse (vide, résidu de raisonnement, prose) → fallback.
        if not t or len(t) < 3 or "<think" in t or len(t) > 80:
            logger.info("[chat_title] sortie inutilisable (%r) — fallback tronqué",
                        (content or "")[:60])
            return None
        logger.info("[chat_title] titre généré en %d ms : %r",
                    int((time.monotonic() - _t0) * 1000), t[:60])
        return t[:60]
    except Exception as _e:  # noqa: BLE001 — titre best-effort : tout échec garde le titre tronqué
        logger.info("[chat_title] échec (%s: %s) — fallback tronqué",
                    type(_e).__name__, str(_e)[:120])
        return None

def _kv_gauge_used_tokens(metrics) -> int:
    """Occupation de contexte à pousser dans la jauge (event ``kv_cache``) en
    fin de tour, d'après les metrics du tour — 0 = ne rien pousser.

    ``last_prompt_tokens`` = taille du DERNIER prompt réellement envoyé : c'est
    l'occupation. ``input_tokens`` n'en est une que sur le chat classique (un
    seul appel LLM) ; sur le chemin outils c'est le CUMUL de toutes les
    itérations (``submitted_input_tokens``, sémantique de facturation) — s'y
    replier pousserait la jauge à 100 % et déverrouillerait la bannière
    « contexte presque plein » à chaque limite d'itérations, fenêtre à 30 %.
    Sans mesure fiable, on masque plutôt que d'afficher un chiffre faux."""
    if not isinstance(metrics, dict):
        return 0
    _lp = metrics.get("last_prompt_tokens")
    if isinstance(_lp, (int, float)) and _lp > 0:
        return int(_lp)
    if "submitted_input_tokens" in metrics or metrics.get("tool_limit_reached"):
        return 0
    try:
        return max(0, int(metrics.get("input_tokens", 0) or 0))
    except (TypeError, ValueError):
        return 0


async def _ctx_usage_snapshot(metrics, model, target) -> Optional[dict]:
    """Occupation RÉELLE du contexte en fin de tour — ``{used, total, pct,
    model, ts}`` ou None si on ne sait pas la mesurer honnêtement.

    Une seule source pour trois consommateurs : l'event ``kv_cache`` (jauge
    live), la pill figée du message (``metrics.kv_cache``, persistée pour
    survivre au rechargement) et ``meta_json["ctx_usage"]`` (re-seed de la
    jauge après rechargement / redémarrage). Jauge KV = serveur llama.cpp de
    la cible (intégré ou connecteur : ``get_model_context_size`` lit le
    /props de CE serveur) ; un fournisseur non llama.cpp n'a pas de n_ctx
    mesurable."""
    if not isinstance(metrics, dict) or not metrics:
        return None
    if not getattr(target, "is_llamacpp", False):
        return None
    used = _kv_gauge_used_tokens(metrics)
    if used <= 0:
        return None
    try:
        from llm_core import get_model_context_size as _gmc
        total = int(await _gmc(model or "") or 0)
    except Exception:  # noqa: BLE001 — fenêtre illisible : pas de jauge plutôt qu'un chiffre faux
        total = 0
    if total <= 0:
        return None
    used = min(used, total)
    return {
        "used": used, "total": total,
        "pct": min(100, round(used / total * 100)),
        "model": str(model or "")[:120],
        "ts": time.time(),
    }


def _payload_final(assistant: str, msg_assistant: dict, thinking_text: str,
                   metrics: Optional[dict], *, exec_id: str, chat_id: str,
                   plan_done: bool, title_was_generated: bool, final_title: str,
                   persisted: bool, persist_error: Optional[str]) -> dict:
    """Événement ``final`` du tour complet.

    ``title`` n'y figure que si le titre vient d'être (re)généré ce tour, et
    il vaut ``final_title`` (le titre du modèle quand il a réussi) : jamais le
    titre tronqué du premier message, qui écraserait le titre du modèle dans
    l'en-tête et la barre latérale.
    """
    payload = {
        "type": "final",
        "assistant": assistant,
        # Exécutions du message (``runs``) : le front les garde et
        # les renvoie avec lui (« Détails », « Continuer »).
        "run_ids": msg_assistant.get("run_ids") or [exec_id],
        **({"files_changed": msg_assistant["files_changed"]}
           if msg_assistant.get("files_changed") else {}),
        **({"compactions": msg_assistant["compactions"]}
           if msg_assistant.get("compactions") else {}),
        **({"pruned": msg_assistant["pruned"]} if msg_assistant.get("pruned") else {}),
        **({"tool_images": msg_assistant["tool_images"]}
           if msg_assistant.get("tool_images") else {}),
        "chat_id": chat_id,
        # Additif : présent seulement quand la sortie auto du mode
        # plan vient d'avoir lieu (``_plan_done`` du worker de
        # ``run_turn`` : ``finalize_turn_meta`` l'a écrite).
        **({"plan_mode_done": True} if plan_done else {}),
        # Additif : présent seulement quand le titre vient d'être
        # (re)généré ce tour — le front recale header + sidebar.
        **({"title": final_title} if title_was_generated else {}),
        # Compteurs CUMULÉS du message (« Continuer » : segments additionnés
        # par la persistance) sur les métriques du tour, qui gardent
        # ``tool_history`` et ``thinking`` pour le front.
        "metrics": ({**metrics, **{k: msg_assistant["metrics"][k]
                                   for k in (*CONTINUE_ADDITIVE_METRICS, "segments",
                                             "thinking_tokens_estimated")
                                   if k in (msg_assistant.get("metrics") or {})}}
                    if metrics else metrics),
        "thinking": msg_assistant.get("thinking", thinking_text),
        "tool_limit_reached": bool(metrics and metrics.get("tool_limit_reached")),
        # Troncature (plafond de tokens OU limite de boucle d'outils) →
        # le front arme isTruncated et propose « Continuer ».
        "truncated": bool(metrics and (metrics.get("truncated") or metrics.get("tool_limit_reached"))),
        # Coupure par le plafond EN PLEIN raisonnement : le front
        # GATE son filet de promotion (le thinking reste dans le
        # bloc Réflexion, titre « Réflexion interrompue ») et le
        # « Continuer » repart du raisonnement persisté
        # (``resume_thinking`` → _expand_history_for_llm).
        "truncated_in_think": bool(metrics and metrics.get("truncated_in_think")),
        # Indicateur de persistance pour le front (toast non
        # bloquant si la réponse n'a PAS été sauvegardée).
        "persisted": persisted,
    }
    if not persisted and persist_error:
        payload["persist_error"] = persist_error
    return payload


async def run_turn(plan: TurnPlan, res: TurnResources, base: PersistBaseline):
    """Générateur NDJSON du tour : réclame le verrou de présence réservé par
    le handler, lance le worker (génération, persistance, ``final``) et
    draine sa file vers le client ; à la fermeture du flux, détache le run ou
    le clôt.

    Les valeurs du plan sont d'abord déballées en locales du même nom que
    dans la préparation : aucune instruction ne peut lever ni rendre la main
    avant la réclamation du verrou.
    """
    user_id = plan.user_id
    chat_id = plan.chat_id
    username = plan.username
    user_settings = plan.user_settings
    ephemeral = plan.ephemeral
    is_continue = plan.is_continue
    _resumable = plan.resumable
    _run_id = plan.run_id
    _exec_id = plan.exec_id
    _target = plan.target
    selected_model = plan.selected_model
    thinking_mode = plan.thinking_mode
    sampling_override = plan.sampling_override
    active_mcp_servers = plan.active_mcp_servers
    rag_meta = plan.rag_meta
    rag_collection = plan.rag_collection
    _mcp_on = plan.mcp_on
    _agents_on = plan.agents_on
    _memory_on = plan.memory_on
    _live_shell_on = plan.live_shell_on
    _deny_tools = plan.deny_tools
    _plan_mode = plan.plan_mode
    _ui_tool_cats = plan.ui_tool_cats
    _ui_ext_ids = plan.ui_ext_ids
    _ui_excl = plan.ui_excl
    _compression_on = plan.compression_on
    _compaction_threshold = plan.compaction_threshold
    _compaction_max_rounds = plan.compaction_max_rounds
    _pruned_keys = plan.pruned_keys
    messages = plan.messages
    msgs = plan.msgs
    msgs_for_llm = plan.msgs_for_llm
    _last_user_text = plan.last_user_text
    _existing_chat = plan.existing_chat
    _chat_read_failed = plan.chat_read_failed
    title = plan.title
    _title_was_generated = plan.title_was_generated
    _title_content = plan.title_content
    _image_tool_on = plan.image_tool_on
    _persist_chat = res.persist_chat
    _mem_manager = res.mem_manager
    _rag_builtin_tools = res.rag_builtin_tools
    _baseline_updated_at = base.updated_at
    _baseline_messages = base.messages
    _baseline_title = base.title
    _compr_prev_state = base.compr_prev_state
    # Le verrou de présence réservé par le handler est RÉCLAMÉ dès la
    # première instruction après le déballage (synchrone), avant le premier
    # ``await`` (ouverture du journal du run) : un client parti pendant cet
    # ``await`` annulerait ``run_turn`` avant la réclamation (verrou orphelin
    # jusqu'au filet de ``_PENDING_GEN_LOCK_WATCHDOG_S``, 409 sur ce chat
    # entre-temps). Il est rendu si ``run_turn`` meurt avant de le confier au
    # worker.
    _claimed = _pending_gen_locks.pop((user_id, str(chat_id)), None)
    _journal = None
    try:
        if _resumable:
            with swallow("chat.run_journal.open"):
                from shared_infra.runtime.run_journal import RunJournal
                _ekey = (f"conn:{_target.connector_id}"
                         if getattr(_target, "connector_id", None) else "builtin")
                _jmeta = {"engine_key": _ekey, "model": selected_model or "",
                          "is_continue": bool(is_continue),
                          # Réconciliation côté client : nombre de messages du
                          # payload et texte du dernier message utilisateur (un
                          # autre appareil ne l'a pas encore en base).
                          "base_count": len(messages),
                          "user_message": (_last_user_text or "")[:20000]}
                _journal = RunJournal(user_id, chat_id, _run_id, meta=_jmeta)
                if not await _journal.open(dict(_jmeta, chat_id=chat_id)):
                    _journal = None
    except BaseException:
        if _claimed:
            with swallow("chat.gen.release_claim"):
                from shared_infra.runtime import chat_locks as _cl_rel
                _cl_rel.release(_claimed[0])
        raise
    # Borne anti-OOM : si le client est lent/déconnecté, ``await q.put`` applique
    # une contre-pression au worker au lieu de bufferiser sans fin. À la
    # fermeture du flux, le ``finally`` de ``run_turn`` coupe
    # l'alimentation et vide la file (``_couper_file``) AVANT d'annuler ou
    # de détacher le worker : un put en attente est débloqué, et le
    # ``final`` du partiel ne peut plus rester coincé sur une file pleine.
    q = asyncio.Queue(maxsize=1000)

    _partial_content_acc: list = []
    # Fichiers modifiés par les outils du tour (``files`` des
    # ``tool_result``) → ``files_changed`` du message : le chat retrouve
    # ses diffs après rechargement.
    _files_changed_acc: dict = {}
    # Compactions du tour → ``compactions`` du message : le jalon
    # (motif, seuil, avant → après) survit au rechargement.
    _compactions_acc: list = []
    _compaction_en_cours: dict = {}
    # Rounds d'outils déjà faits (un appel LLM suivi d'au moins un
    # tool_call) → place du jalon au rechargement, dans l'unité de
    # _tool_segments.js. ``iteration`` arme, le 1er tool_call compte.
    _tours_vus: dict = {"n": 0, "arme": False}
    _partial_thinking_acc: list = []
    # Dernière tool_history cumulée émise par run_chat_multi_mcp juste avant de
    # propager une annulation (event interne ``tool_history_partial``). Liste
    # mutée EN PLACE (pas de ``nonlocal``) ; sert à rattacher le contexte
    # agentique au partiel sauvé pour qu'un « Continuer » ne reparte pas aveugle.
    _partial_tool_history: list = []
    # Nouvel état de compression produit CE tour (event interne
    # ``compression_state`` émis par maybe_compress_conversation). Dict
    # muté EN PLACE (même pattern que _partial_tool_history). Utilisé par
    # ``_with_compr_state`` à la persistance ; sinon carry-forward de
    # ``_compr_prev_state``.
    _new_compr_state: dict = {}
    # Clés d'élagage produites CE tour (event interne ``prune_state`` émis
    # en fin de run par la boucle). Liste mutée EN PLACE ; persistée dans
    # meta_json["ctx_pruned_keys"] à la fin du stream.
    _new_prune_keys: list = []
    # Suffixe LLM de la question de CE tour (event interne
    # ``llm_user_suffix`` de la boucle), persisté en fin de tour.
    _new_user_suffix: dict = {}
    # Détachement (cf. ``_should_detach_run``) : passé à True par
    # le ``finally`` quand le CLIENT s'en va alors que le worker travaille
    # encore. Les events cessent alors d'être mis en file — sans ça le
    # worker se bloquerait sur ``q.put`` dès 1000 events en attente (la
    # contre-pression n'a plus personne pour drainer) et la mission
    # s'arrêterait quand même, mais en pleine action et sans persister.
    _detached = [False]
    # Flux fermé SANS détachement (le worker est annulé ou finit sa
    # télémétrie post-final) : même coupure que ``_detached``, mais sans en
    # porter le sens (« le run continue seul »). Cf. ``_couper_file``.
    _lecteur_parti = [False]
    # « Un outil a déjà tourné dans ce tour » — cf. _should_detach_run.
    # Liste d'un élément : posée depuis ``on_event``, lue depuis le
    # ``finally`` de ``run_turn`` (deux portées de closure différentes).
    _tools_ran = [False]
    # Le 'final' est parti : le tour est TERMINÉ côté
    # client, le worker n'a plus que sa télémétrie post-final à finir.
    # Une fermeture du flux dans cette fenêtre n'est PAS une annulation.
    _final_sent = [False]
    async def on_event(ev: dict):
        _evt = ev.get("type") if isinstance(ev, dict) else None
        # Event INTERNE (jamais forwardé au client) : capturé AVANT le filtre
        # _drop_event_after_cancel — il est justement émis PENDANT l'annulation,
        # quand ce filtre supprime tout sauf 'final'.
        if _evt == "tool_history_partial":
            _ph = ev.get("tool_history")
            if isinstance(_ph, list):
                _partial_tool_history[:] = _ph
            return
        # Events INTERNES de la boucle, jamais forwardés : suffixe LLM de la
        # question et marques d'élagage, persistés en fin de tour.
        if _evt == "llm_user_suffix":
            if isinstance(ev.get("text"), str) and ev["text"]:
                _new_user_suffix["text"] = ev["text"]
            return
        if _evt == "prune_state":
            _ks = ev.get("keys")
            if isinstance(_ks, list):
                _new_prune_keys[:] = [k for k in _ks if isinstance(k, str)]
            return
        # Event INTERNE : état de compression à persister (round, tours
        # couverts, résumé). Jamais forwardé au client — le front n'a que
        # compression_start/done/capped.
        if _evt == "compression_state":
            _new_compr_state.clear()
            _new_compr_state.update({
                "round":            ev.get("round"),
                "covered_turns":    ev.get("covered_turns"),
                "summary_xml":      ev.get("summary_xml"),
                "turns_compressed": ev.get("turns_compressed"),
                "ledger_block":     ev.get("ledger_block") or "",
            })
            return
        if _evt == "iteration":
            _tours_vus["arme"] = True
        elif _evt == "tool_call" and _tours_vus["arme"]:
            _tours_vus["n"] += 1
            _tours_vus["arme"] = False
        elif _evt == "compression_start":
            _compaction_en_cours.clear()
            _compaction_en_cours.update(reason=ev.get("reason"), threshold=ev.get("threshold"),
                                        ctx_size=ev.get("ctx_size"), round=_tours_vus["n"])
        elif _evt == "compression_done":
            _st = ev.get("stats") if isinstance(ev.get("stats"), dict) else {}
            if _st.get("compressed"):
                _compactions_acc.append(_compaction_pour_message(
                    {**_st, **_compaction_en_cours, "path": ev.get("path")}))
            _compaction_en_cours.clear()
        # Relevé AVANT le filtre d'annulation : une écriture faite reste
        # faite, même si son résultat n'est plus montré.
        if _evt in ("tool_result", "task_step") and ev.get("files"):
            _fc_merge(_files_changed_acc, ev.get("files"))
        # Aucun event après un Stop de l'utilisateur (events parasites de
        # compression/outils), SAUF 'final' — cf. docstring de
        # _drop_event_after_cancel.
        if _drop_event_after_cancel(_evt, is_chat_cancelled(user_id, chat_id),
                                    ev.get("status")):
            return
        # « Ce tour a déjà exécuté un outil ».
        # C'est ce qui décide, à la déconnexion, entre détacher le run et
        # l'annuler : un tour qui a écrit sur le disque ou lancé un shell
        # ne se rejoue pas à l'identique. ``tool_call`` est émis JUSTE
        # AVANT l'exécution — c'est volontaire : un outil interrompu en
        # plein vol est précisément le cas qu'on ne veut pas perdre.
        if _evt in ("tool_call", "tool_result"):
            _tools_ran[0] = True
        elif _evt == "final":
            _final_sent[0] = True
        if _evt == "content_token":
            _partial_content_acc.append(ev.get("text", ""))
            # Compaction périodique : accumuler
            # une réponse de 100 Ko en ~25 000 micro-strings coûte
            # ~30× le texte en heap (49 o d'en-tête objet par token).
            # Le join périodique ramène la liste à 1 élément sans
            # changer le résultat final ("".join est associatif).
            if len(_partial_content_acc) > 512:
                _partial_content_acc[:] = ["".join(_partial_content_acc)]
        elif _evt == "content_replace":
            # « Remplace tout le corps » (nettoyage divergent du streamé,
            # reprise de prose) : sinon le partiel persisté sur un Stop
            # entre ce point et ``_final_assistant`` porterait la version
            # BRUTE/tronquée que l'écran vient de corriger.
            _partial_content_acc[:] = [ev.get("text", "")]
        elif _evt == "thinking_token":
            _partial_thinking_acc.append(ev.get("text", ""))
            if len(_partial_thinking_acc) > 512:
                _partial_thinking_acc[:] = ["".join(_partial_thinking_acc)]
        # Journal du run : TOUT événement destiné au client,
        # détaché ou non — c'est justement après un détachement qu'un
        # retour sur la conversation en a besoin. ``final`` clôt le
        # journal (``run_end``) sans attendre la télémétrie post-final :
        # un client rattaché voit le tour fini au moment où il l'est.
        if _journal is not None:
            _journal.append(ev)
            if _evt == "final":
                _jstatus = ("cancelled" if ev.get("cancelled")
                            else ("error" if ev.get("persisted") is False
                                  and ev.get("persist_error") else "done"))
                keep(asyncio.create_task(_journal.close(_jstatus)))
        # Plus personne au bout du fil : on jette au lieu de bufferiser.
        # Les events INTERNES (tool_history_partial, compression_state,
        # prune_state) sont traités plus haut et continuent d'alimenter
        # la persistance — c'est tout ce qui compte une fois détaché.
        if _detached[0] or _lecteur_parti[0]:
            return
        await q.put(ev)

    def _with_compr_state(_full: list) -> list:
        """Préfixe le message system d'état de compression à la liste
        persistée : nouvel état si une compression a eu lieu CE tour,
        sinon CARRY-FORWARD de l'état précédent (le client ne renvoie
        jamais les messages system — sans re-préfixage, l'état serait
        perdu au premier tour suivant la compression). No-op si le chat
        n'a jamais été compressé. Best-effort : ne casse jamais un persist."""
        nonlocal _compr_prev_state
        try:
            # Si la lecture initiale du chat a ÉCHOUÉ (DB lockée en
            # WAL multi-worker), ``_compr_prev_state`` vaut None non pas
            # parce qu'il n'y a pas d'état, mais parce qu'on n'a pas pu le
            # lire. Persister ainsi EFFACERAIT le résumé de compaction et
            # le compteur de rounds. On retente donc la lecture ici, au
            # moment du persist (bien plus tard : la contention a
            # généralement disparu).
            if _chat_read_failed and _compr_prev_state is None:
                try:
                    from llm_core.conversation_compressor import extract_compression_state as _extract_st
                    # Helper SYNC (chemin d'échec rare — la lecture
                    # initiale a raté) : lecture directe assumée.
                    _re = get_chat(user_id, chat_id)
                    if _re:
                        _compr_prev_state = _extract_st(_re.get("messages") or [])
                except Exception:  # noqa: BLE001 — relecture best-effort : le persist part sans état
                    logger.warning(
                        "[chat_stream] relecture de l'état de compression "
                        "échouée — persist SANS carry-forward", exc_info=True)

            _st = None
            if _new_compr_state.get("summary_xml"):
                _st = _new_compr_state
            elif _compr_prev_state and _compr_prev_state.get("summary_xml"):
                _st = _compr_prev_state
            if not _st:
                return _full
            from llm_core.conversation_compressor import _strip_summary_messages, build_state_system_message
            _state_msg = build_state_system_message(
                _st["summary_xml"],
                int(_st.get("round") or 1),
                int(_st.get("covered_turns") or 0),
                turns_compressed=_st.get("turns_compressed"),
                ledger_block=_st.get("ledger_block") or "",
            )
            return [_state_msg] + _strip_summary_messages(_full)
        except Exception:  # noqa: BLE001 — ne casse jamais un persist : liste rendue telle quelle
            logger.warning("[chat_stream] _with_compr_state échoué (persist sans état)",
                           exc_info=True)
            return _full

    async def _persist_question():
        """Écrit la QUESTION en base dès le début d'un tour reprenable.

        Persistée seulement à la FIN du tour, avec la réponse, la
        question disparaîtrait avec un worker qui meurt en plein tour
        (redéploiement, OOM, recyclage) : au rechargement, la conversation
        n'en garderait aucune trace. On écrit donc la base du tour tout de
        suite, avec le carry-forward
        de l'état de compression (le client ne renvoie jamais de system) et
        SOUS la garde optimiste. La base de comparaison du persist final est
        recalée sur ce qu'on vient d'écrire, sinon il tomberait en conflit
        contre sa propre écriture.
        """
        nonlocal _baseline_updated_at, _baseline_messages, _baseline_title
        if not _resumable or ephemeral or _chat_read_failed or is_continue:
            return
        with swallow("chat.persist_question"):
            _early = _with_compr_state(list(msgs))
            _ts = time.time()
            _ok = await asyncio.to_thread(
                _persist_chat, user_id, chat_id, title, _early, _ts,
                expected_updated_at=_baseline_updated_at)
            if _ok is not False:
                _baseline_updated_at = _ts
                _baseline_messages = _early
                _baseline_title = title

    def _issue_du_tour(statut: str, kind: str = "") -> None:
        """Issue de l'exécution du tour (``runs``) : le worker avale
        annulations et pannes, ``run_scope`` n'en voit aucune — sans cet
        appel, un Stop ou un plantage finirait en « ok »."""
        with swallow("chat.run_status"):
            from shared_infra.observability.runs import current_run
            _run = current_run()
            if _run is not None:
                _run.finish(statut, error_kind=kind)

    async def worker():

        clear_chat_cancellation(user_id, chat_id)

        _final_assistant = ""
        _final_thinking = ""
        _final_metrics = None
        # Persistance du tour COMPLET engagée : à partir de là, le
        # ``finally`` ne doit plus écrire de partiel par-dessus (cf.
        # ``_attendre_hors_annulation``).
        _tour_persiste = False
        _was_cancelled = False
        # Exception NON gérée échappée du harnais (bug d'orchestration —
        # ex. parse d'un tool_call malformé hors du try de boucle) : le
        # partiel est persisté comme pour une annulation : sinon tout le
        # tour — y compris les outils MUTANTS déjà exécutés — disparaîtrait
        # de l'historique, sans « Continuer » proposé.
        _run_crashed = False
        # Un ``queue_status`` est-il parti vers le client ? Lié ici, au
        # niveau de ``worker()`` : les branches d'exception ci-dessous
        # doivent pouvoir retirer le widget de file même si l'incident
        # survient avant l'entrée dans le bloc d'ordonnancement.
        _file_annoncee = [False]
        # Sous-agents (outil ``task``) : sink rempli par la branche MCP, lu
        # au persist COMMUN et au persist PARTIEL (finally). Init AVANT le
        # try — un Stop (task.cancel) peut atterrir sur les premiers awaits
        # du try, avant toute affectation : le chemin partiel lirait alors
        # une variable non liée (UnboundLocalError avalé par le repli →
        # partiel perdu sans event final).
        _task_usage: dict = {}
        # Images de l'outil ``generate_image`` (``images``) : même règle que
        # ``_task_usage``, lues au persist complet et au partiel.
        _image_sink: dict = {}
        # Tâche de génération du titre (chat neuf) — lancée AU DÉBUT du
        # tour (cf. lancement sous le guard), récoltée au persist.
        _title_task = None
        try:
            # La question survit à un crash. DANS le ``try`` : hors de
            # lui, un Stop (``task.cancel``) pendant cette écriture SQLite
            # s'échapperait du worker sans partiel, sans event final ni
            # marqueur de fin de file — le flux resterait ouvert et le
            # verrou de présence tenu.
            await _persist_question()
            if rag_meta and rag_meta.get("used"):
                mode_label = "RAG Outils" if _rag_builtin_tools else "RAG"
                await on_event({"type": "mode", "text": f"{mode_label} ON" + (f" ({rag_collection})" if rag_collection else "")})
                if rag_meta.get("sources"): await on_event({"type": "rag_sources", "text": "\n".join(rag_meta["sources"])})
            elif rag_meta and rag_meta.get("enabled") and rag_meta.get("error"):
                # Service RAG en panne : le dire, au lieu d'une
                # réponse sans documents qui ressemble à une réponse sourcée.
                await on_event({"type": "info",
                                "text": "Recherche documentaire indisponible — réponse sans les documents."})

            _use_mcp_path = (bool(active_mcp_servers) or bool(_rag_builtin_tools)
                             or _image_tool_on)

            if not _use_mcp_path: await on_event({"type": "mode", "text": "Génération en cours…"})
            else:
                parts = []
                if active_mcp_servers:
                    parts.append("MCP: " + ", ".join(s.get("name", "?") for s in active_mcp_servers))
                if _rag_builtin_tools:
                    parts.append("RAG Outils")
                if _image_tool_on:
                    parts.append("Images")
                await on_event({"type": "mode", "text": " + ".join(parts)})

            metrics = {}
            assistant = ""

            # On suit ce qui est RÉELLEMENT parti vers le client
            # (``_file_annoncee``), pas ce que disait l'instantané, pris
            # AVANT le guard : l'attente peut survenir quand même. Le front
            # ne remet ``queueStatus`` à null que sur ``queue_cleared`` ou
            # le PREMIER ``content_token`` : conditionné à l'instantané, le
            # ``queue_cleared`` ne partirait pas, et un tour sans prose
            # (limite d'outils atteinte, erreur, Stop en pleine réflexion)
            # laisserait le widget de file affiché après la fin du tour.
            # La cible du tour est posée AVANT l'instantané de file, pas à
            # l'entrée du guard : sinon l'instantané, le suivi de
            # chargement et la sonde du sémaphore verraient le moteur
            # INTÉGRÉ, et un tour destiné à un second serveur dont un
            # modèle porte le même nom afficherait « Chargement de
            # <modèle>… » d'après l'état du serveur local. Contextvar :
            # propre à cette tâche, la ré-affectation plus bas est
            # idempotente.
            from llm_core import (
                llm_scheduling_guard,
                record_llm_duration,
                resolve_scheduling_mode,
                run_chat_multi_mcp_v2,
                set_llm_target as _set_target_early,
            )

            # Variante ASYNC : la SYNC ne voit ni le snapshot Redis (donc
            # rien de ce que tiennent les autres workers) ni l'inventaire
            # autoritaire du moteur — sous Redis elle rendrait toujours
            # « ready », et le front afficherait « vous êtes 1er · ~15 s »
            # à qui attend derrière une mission de plusieurs heures sur un
            # autre worker.
            from llm_core._queue import get_queue_status_for_async
            _set_target_early(_target)
            _qstatus = await get_queue_status_for_async(selected_model)
            if _qstatus.get("kind") != "ready":
                await on_event({"type": "queue_status", **_qstatus})
                _file_annoncee[0] = True
            # Le modèle doit monter en VRAM : suivre sa progression RÉELLE
            # plutôt que d'animer une estimation. Le suivi s'éteint seul
            # quand le modèle est chargé.
            if _qstatus.get("kind") == "loading":
                _start_load_watch(selected_model, on_event, user_id,
                                  chat_id, _qstatus)

            from llm_core._scheduling._engines import scheduling_for as _sched_for
            from llm_core.engines import engine_for_target as _eng_of
            if _target.is_llamacpp and _sched_for(_eng_of(_target))[1].locked_for(selected_model):
                await on_event({"type": "thinking", "text": "En attente…"})
            # Init AVANT le async with pour qu'ils soient toujours
            # bornés même si llm_scheduling_guard lève pendant l'acquire.
            import time as _llm_t0
            _llm_start_wall = 0.0
            # Trois paramètres, trois effets :
            #   • ``target`` : une cible DISTANTE saute l'ordonnanceur
            #     local (elle ne consomme ni la VRAM ni les slots du
            #     llama-server) ;
            #   • ``on_wait`` : l'attente derrière un modèle occupé se VOIT
            #     (widget de file), au lieu d'un écran muet pendant des
            #     heures ;
            #   • ``cancel_probe`` : et elle s'ABANDONNE — le bouton Stop
            #     agit pendant l'attente comme il agit pendant la
            #     génération.
            async def _on_queue_wait(_waited: float):
                _qs = dict(await get_queue_status_for_async(selected_model) or {})
                _qs.pop("type", None)
                _qs["kind"] = _qs.get("kind") or "waiting"
                _qs["waited_ms"] = int(_waited * 1000)
                _file_annoncee[0] = True
                await on_event({"type": "queue_status", **_qs})

            _attente_t0 = _llm_t0.monotonic()
            async with llm_scheduling_guard(
                    selected_model, use_mcp_path=_use_mcp_path,
                    target=_target, on_wait=_on_queue_wait,
                    cancel_probe=lambda: is_chat_cancelled(user_id, chat_id)):
                # Attente d'un créneau du moteur → exécution du tour.
                with swallow("chat.run_wait"):
                    from shared_infra.observability.runs import current_run as _run_cour
                    _rc = _run_cour()
                    if _rc is not None:
                        _rc.add_wait(int((_llm_t0.monotonic() - _attente_t0) * 1000))

                # Active le connecteur cible pour TOUS les appels LLM de ce
                # tour (chat + compression). Contextvar : visible par le
                # transport (_chat_classic / _chat_with_tools). Isolé par
                # tâche de requête → pas de fuite entre utilisateurs.
                from llm_core import set_llm_target as _set_target
                _set_target(_target)

                # Registre d'usage : la route ne MESURE pas la conso, elle
                # se NOMME. Tout ce qui appelle le LLM sous ce scope (tour
                # classic, boucle outils, titre, compression, sous-agents)
                # est enregistré UNE fois, là où l'usage réel est connu ;
                # re-journaliser ici les tokens de la boucle les ferait
                # compter deux fois au tableau de bord admin.
                set_usage_context("chat", user_id=user_id,
                                  origin_id=str(chat_id or ""))

                if _file_annoncee[0]:
                    await on_event({"type": "queue_cleared"})
                    _file_annoncee[0] = False
                _llm_start_wall = _llm_t0.time()
                # ── Titre par le MODÈLE COURANT — AU TOUT DÉBUT du tour ──
                # Chat neuf : la requête de titre part la PREMIÈRE (FIFO
                # serveur : ~1 s avant le prefill principal), en parallèle
                # de l'assemblage. Deux gains sur une génération en fin de
                # tour : le titre est prêt dès le persist SANS allonger la
                # fin de tour, et sur un serveur mono-slot elle n'évince
                # pas le KV de la conversation juste avant le tour suivant
                # (le prefill principal repasse derrière elle au tour 1,
                # où le cache est de toute façon vide). Best-effort :
                # échec/timeout → titre tronqué par défaut au persist.
                # Lecture du chat en échec : son titre (peut-être
                # renommé par l'utilisateur) est inconnu — pas de titre
                # généré par-dessus.
                if _title_was_generated and not ephemeral and not _chat_read_failed:
                    _title_task = asyncio.create_task(_generate_chat_title(
                        selected_model, _title_content, "", chat_id=chat_id))
                if not _use_mcp_path:
                    import time as _time

                    from shared_infra.config import LLAMA_MODEL as _LLAMA_MODEL
                    _start = _time.time()
                    # Pas d'accumulateur des tokens de contenu ici : la
                    # réponse finale vient du retour de
                    # llama_chat_stream_tokens, et le partiel de
                    # ``_partial_content_acc`` (un 3e exemplaire du texte
                    # en heap ne servirait à rien).
                    thinking_chunks: list = []

                    async def _on_think(tok: str):
                        thinking_chunks.append(tok)
                        if len(thinking_chunks) > 512:
                            thinking_chunks[:] = ["".join(thinking_chunks)]
                        await on_event({"type": "thinking_token", "text": tok})

                    async def _on_content(tok: str):
                        await on_event({"type": "content_token", "text": tok})

                    from llm_core import get_model_context_size as _gmc_size
                    # Appels propres à un llama-server (n_ctx via /props,
                    # comptage via /tokenize, compression) : pour tout serveur
                    # llama.cpp, ils visent le serveur de la CIBLE (intégré
                    # ou connecteur). Pour un fournisseur non
                    # llama.cpp (cloud/vLLM) on les saute.
                    _ctx_tok = 0
                    if _target.is_llamacpp:
                        try:
                            _ctx_tok = await _gmc_size(selected_model or "")
                        except Exception:  # noqa: BLE001 — fenêtre inconnue (0) : compaction et budget s'en passent
                            _ctx_tok = 0

                    if _target.is_llamacpp:
                        # Chemin SANS outils : un seul appel LLM par tour,
                        # donc ce point EST la tête de tour — le seuil du
                        # compte s'applique pleinement (rien à couper).
                        from llm_core.context.compaction_gate import compaction_gate as _cgate
                        from llm_core.conversation_compressor import maybe_compress_conversation
                        # Le VRAI ``thinking_mode``, comme le budget dur juste
                        # en dessous et la porte de la boucle outils : même
                        # plafond de génération réservé des deux côtés.
                        _cl_gate = _cgate(_ctx_tok or 0,
                                          thinking_mode=thinking_mode,
                                          threshold=_compaction_threshold)
                        _msgs_classic, _compr_stats_classic = await maybe_compress_conversation(
                            msgs_for_llm,
                            llama_chat_fn   = llama_chat,
                            on_event        = on_event,
                            model           = selected_model,
                            user_id         = str(user_id),
                            log_prefix      = "chat_classic",
                            ctx_size_tokens = _ctx_tok or None,
                            usable_tokens   = (_cl_gate.usable_tokens or None),
                            trigger_tokens  = (_cl_gate.trigger_tokens or None),
                            max_rounds      = _compaction_max_rounds,
                            prev_state      = _compr_prev_state,
                            auto_enabled    = _compression_on,
                        )
                        # ── Garantie DURE du budget de contexte (parité chemin outils) ──
                        # La compression est une HEURISTIQUE (peut ne pas se
                        # déclencher : seuil non atteint / désactivée / échouée, ou
                        # un seul tour très verbeux). Sans dernier rempart, un long
                        # chat SANS outils dépasserait n_ctx → coupe finish=length en
                        # pleine réponse. ``_clamp_messages`` (dans la classic path)
                        # ne borne QUE le NOMBRE de messages (200), pas les tokens :
                        # 200 messages verbeux peuvent valoir 100K tokens sur un
                        # n_ctx 32K. On retire donc au besoin les plus vieux messages
                        # (system + tour courant préservés). Réserve = cap de
                        # génération effectif (adaptatif au n_ctx). Best-effort.
                        with swallow("chat.worker"):
                            from llm_core._constants import effective_generation_cap
                            from llm_core.context.pruning import enforce_context_budget as _enforce_context_budget
                            _msgs_classic = await _enforce_context_budget(
                                _msgs_classic,
                                _ctx_tok or None,
                                model_id=(selected_model or None),
                                gen_cap_tokens=effective_generation_cap(
                                    thinking_mode, _ctx_tok or None),
                            )
                        # Jauge de contexte : AUCUNE émission pré-vol (on
                        # n'« imagine » pas le prompt). La jauge est recalée
                        # sur l'usage RÉEL du serveur via l'event kv_cache de
                        # fin de tour (plus bas, après llama_chat_stream_tokens).
                    else:
                        # Cible distante : pas de compression locale (cloud = grand
                        # contexte), pas d'appel /tokenize. Messages tels quels.
                        _msgs_classic = msgs_for_llm

                    _thinking_ret, assistant, _meta = await llama_chat_stream_tokens(
                        _msgs_classic,
                        user_id=username,
                        model_override=selected_model,
                        on_thinking_token=_on_think,
                        on_content_token=_on_content,
                        thinking_mode=thinking_mode,
                        is_cancelled=lambda uid=user_id, cid=chat_id: is_chat_cancelled(uid, cid),
                        sampling_override=sampling_override,
                        chat_id=chat_id,
                        on_prompt_progress=_prompt_progress_relay(on_event),
                    )
                    # Watcher contexte/perf (LLAMA_WATCH=1) : prompt assemblé
                    # du chemin classic + mesure réelle. Best-effort.
                    with swallow("chat.worker.2"):
                        from llm_core._watch import watch_llm_call
                        watch_llm_call(
                            chat_id=chat_id, path="classic", iteration=None,
                            model=selected_model or "",
                            messages=_msgs_classic, tools_payload=None,
                            usage=(_meta or {}).get("usage"),
                            timings=(_meta or {}).get("timings"),
                        )
                    thinking_text = "".join(thinking_chunks) or _thinking_ret
                    # Réponse dé-routée hors du thinking par le recovery backend
                    # (<think> non fermé / reasoning_content-only) : le texte a été
                    # streamé en LIVE dans le panneau « thinking » mais constitue en
                    # fait la réponse (déjà dans ``assistant``). On vide le bloc
                    # thinking — live (thinking_content="" le remplace) ET côté méta —
                    # pour ne pas l'afficher en double (panneau + bulle).
                    if _meta.get("thinking_promoted"):
                        thinking_text = ""
                        await on_event({"type": "thinking_content", "text": ""})
                    # Raisonnement streamé comme réponse (``</think`` sans
                    # ouvrante) puis séparé par le backend : la bulle live
                    # porte encore raisonnement + balise → on la remplace,
                    # et le panneau reçoit le raisonnement.
                    elif _meta.get("thinking_extracted"):
                        thinking_text = _thinking_ret or ""
                        await on_event({"type": "thinking_content",
                                        "text": thinking_text})
                        await on_event({"type": "content_replace",
                                        "text": assistant or ""})
                    from llm_core import calculate_metrics as _calc
                    metrics = _calc(_meta, _time.time() - _start)
                    actual_model = metrics.get("model", _LLAMA_MODEL)
                    # Tokens : rien à enregistrer ici — ``llama_chat_stream_tokens``
                    # a déjà enregistré le tour dans ``usage_events`` avec
                    # l'usage réel et le scope posé plus haut. Seules les
                    # séries de PERF restent dans ``metric_events``.
                    # INSERT + flock du bus métriques :
                    # hors boucle, comme les voisins de fin de tour.
                    await asyncio.to_thread(
                        log_metric, "write_tps", metrics.get("write_tps", 0),
                        {"model": actual_model})
                    await asyncio.to_thread(
                        log_metric, "llm_latency", round(_time.time() - _start, 2),
                        {"model": actual_model})
                else:
                    await on_event({"type": "mode", "text": "Outils prêts…"})

                    _scheduling_mode = resolve_scheduling_mode()
                    _mcp_fn = run_chat_multi_mcp_v2 if _scheduling_mode == "optimized" else run_chat_multi_mcp

                    # ── Sous-agents (outil ``task``) — builtin construit PAR
                    # TOUR : son handler capture le contexte du tour (modèle,
                    # configs, toggles, annulation, on_event, mode). Fusionné
                    # aux builtins RAG. L'enfant n'en hérite JAMAIS (deny_base
                    # + parent_builtin_tools = RAG seuls). Gaté par le toggle
                    # per-user ``agents_enabled`` (défaut OFF, cf. _agents_on).
                    _task_builtin = {}
                    if _agents_on:
                        from llm_core import build_task_builtin_tool
                        _task_builtin = build_task_builtin_tool(
                            parent_mcp_configs=active_mcp_servers,
                            parent_builtin_tools=_rag_builtin_tools,
                            username=username,
                            chat_id=chat_id,
                            model=selected_model,
                            sampling_override=sampling_override,
                            memory_enabled=_memory_on,
                            is_cancelled=lambda uid=user_id, cid=chat_id: is_chat_cancelled(uid, cid),
                            on_event=on_event,
                            scheduling_mode=_scheduling_mode,
                            usage_sink=_task_usage,
                            custom_agents=(user_settings or {}).get("custom_agents") or [],
                            # Serveurs référençables par un agent custom
                            # (``mcp_server_ids``) : les perso + ceux de la
                            # bibliothèque partagée que ce compte affiche,
                            # résolus AVEC leur auth (host-side, jamais
                            # sérialisés). Sans eux, un agent custom ne pourrait
                            # pointer que des serveurs re-saisis à la main.
                            user_mcp_configs=_agent_mcp_configs(user_settings, user_id),
                            # Index des skills d'un enfant qui détient la
                            # catégorie ``skill`` (agents custom seulement).
                            user_id=user_id,
                        )
                    # Images (outil ``generate_image``) — même gabarit : builtin
                    # par tour, références versées dans ``_image_sink``.
                    _image_builtin = {}
                    if _image_tool_on:
                        from llm_core.tools.image_tool import build_image_builtin_tool
                        _image_builtin = build_image_builtin_tool(
                            user_id=user_id,
                            chat_id=None if ephemeral else chat_id,
                            on_event=on_event,
                            is_cancelled=lambda uid=user_id, cid=chat_id: is_chat_cancelled(uid, cid),
                            sink=_image_sink,
                            prefs=(user_settings or {}).get("image_prefs"))
                    _all_builtins = {**(_rag_builtin_tools or {}), **_task_builtin,
                                     **_image_builtin} or None

                    assistant, _, metrics = await _mcp_fn(
                        msgs_for_llm,
                        mcp_configs=active_mcp_servers,
                        on_event=on_event,
                        username=username,
                        user_id=user_id,   # recopié dans le _meta des outils locaux
                        model=selected_model,
                        builtin_tools=_all_builtins,
                        is_cancelled=lambda uid=user_id, cid=chat_id: is_chat_cancelled(uid, cid),
                        chat_id=chat_id,
                        sampling_override=sampling_override,
                        thinking_mode=thinking_mode,
                        memory_enabled=_memory_on,
                        compression_prev_state=_compr_prev_state,
                        live_shell=_live_shell_on,
                        compression_enabled=_compression_on,
                        compaction_threshold=_compaction_threshold,
                        compaction_max_rounds=_compaction_max_rounds,
                        # Marques d'élagage DÉJÀ persistées : la boucle
                        # part de cet état et y ajoute ses sélections
                        # intra-run. Sans ça elle re-sélectionnerait à
                        # chaque tour des sorties déjà effacées de la vue.
                        prune_keys=_pruned_keys,
                        deny_tool_names=_deny_tools,
                        # Lecture seule : seuls les outils annotés
                        # read-only atteignent le modèle (cf. /plan).
                        read_only=_plan_mode,
                    )
                    thinking_text = metrics.get("thinking", "") if metrics else ""

                    # Sous-agents : compteur de RUNS seulement. Leurs tokens
                    # sont enregistrés par chaque enfant dans le registre
                    # (source « subagent », rattaché au parent) — les
                    # additionner ici les compterait une deuxième fois.
                    if _task_usage.get("tasks"):
                        await asyncio.to_thread(
                            log_metric, "task_runs", _task_usage["tasks"],
                            {"user": username})

                    # Tokens ET débit : déjà enregistrés par la boucle
                    # outils (``_write_end_of_turn_metrics`` écrit
                    # ``write_tps`` + ``llm_latency``). Les réécrire ici
                    # compterait chaque tour outillé DEUX fois dans la
                    # moyenne de débit du tableau de bord.

            # Estimateur de file d'attente : pertinent pour tout serveur
            # llama.cpp (chacun sa file, estimations indexées par serveur).
            # Un moteur vLLM/générique ou un modèle cloud n'a pas de slots.
            if _target.is_llamacpp:
                with swallow("chat.worker.3"):
                    record_llm_duration(
                        selected_model,
                        (_llm_t0.time() - _llm_start_wall) * 1000.0,
                    )

            # Occupation de contexte de fin de tour : UNE mesure, trois
            # usages (pill figée du message, meta_json du chat, event
            # kv_cache). Calculée ici, avant la persistance, pour que la
            # pill survive au rechargement et que la jauge se re-sème au
            # chargement.
            _ctx_snap = None
            with swallow("chat.worker.ctx_snapshot"):
                _ctx_snap = await _ctx_usage_snapshot(
                    metrics, selected_model, _target)

            msg_assistant, _base_msgs, _tail_msgs, assistant = _message_assistant(
                assistant, thinking_text, metrics, exec_id=_exec_id, ctx_snap=_ctx_snap,
                task_usage=_task_usage, files_changed=_files_changed_acc,
                compactions=_compactions_acc, prune_keys=_new_prune_keys, msgs=msgs,
                is_continue=is_continue, tool_images=_image_sink.get("images"))

            # Préfixe l'état de compression (nouveau round ou carry-forward)
            # AVANT persist — les bulles client restent inchangées.
            # ``_tail_msgs`` = les notices qui suivaient l'assistant fusionné
            # (Continue juste après une compaction) : replacées derrière lui
            # pour que le marqueur ne saute pas dans le fil.
            full = _with_compr_state(_base_msgs + [msg_assistant] + _tail_msgs)

            from shared_infra.charts.routes import embed_chart_configs
            # Threadpool : relit le chat persisté ENTIER (get_chat) + le
            # cache .charts/ dès qu'un graphique existe — sur la boucle,
            # pile au moment où la réponse se termine.
            full = await asyncio.to_thread(
                embed_chart_configs, user_id, chat_id, full)
            # Isole la persistance : une collision de chat_id (ValueError —
            # chat_id appartenant à un AUTRE user) ou toute erreur DB ne doit
            # PAS faire avorter le tour (la réponse EST générée). Sans ça,
            # l'exception remonterait à l'except du worker → event 'error' +
            # pas de 'final' → réponse valide perdue. On dégrade : log + on
            # continue.
            #
            # Pas de succès silencieux trompeur : un 'final' NORMAL après un
            # upsert échoué ferait afficher la réponse comme réussie alors
            # qu'elle n'est PAS persistée (perdue au rechargement).
            # ``persisted`` + ``persist_error`` dans l'event 'final' font
            # lever un toast non bloquant au front. Sur collision
            # cross-user (ValueError), on régénère un chat_id serveur et on
            # réessaie UNE fois.
            _persisted = False
            _persist_error = None
            # ── Récolte du titre lancé au début du tour (chat neuf) ──
            # La tâche est normalement déjà terminée (elle est passée
            # AVANT le prefill principal) → await quasi instantané ;
            # _generate_chat_title borne elle-même (timeout 45 s) et ne
            # lève jamais. Échec/None → titre tronqué par défaut.
            _final_title = title
            if _title_task is not None:
                try:
                    # Récolte BORNÉE COURT : la tâche est partie en début
                    # de tour, elle est normalement déjà finie. Encore en
                    # course (serveur saturé) → on ne retient pas le
                    # 'final' plus de 3 s : fallback tronqué + annulation.
                    _llm_title = await asyncio.wait_for(
                        asyncio.shield(_title_task), timeout=3.0)
                except asyncio.TimeoutError:
                    _title_task.cancel()
                    _llm_title = None
                except asyncio.CancelledError:
                    # CancelledError de l'ENFANT (tâche titre annulée) →
                    # on continue sans titre LLM. Si c'est le WORKER qu'on
                    # annule (Stop), l'enfant n'est PAS cancelled → on
                    # propage pour ne pas casser le chemin d'annulation.
                    if not _title_task.cancelled():
                        raise
                    _llm_title = None
                except Exception:  # noqa: BLE001 — titre best-effort : repli sur le titre tronqué
                    _llm_title = None
                if _llm_title:
                    _final_title = _llm_title
            # ``_effective_chat_id`` = id réellement persisté. On NE mute PAS
            # la variable de fermeture ``chat_id`` (utilisée par le tracking
            # cancel / register_chat_task sur l'id d'origine) : on n'expose le
            # nouvel id que dans l'event 'final' pour que le front recale.
            _effective_chat_id = chat_id
            try:
                # Garde optimiste cross-worker : ne persiste que si le
                # chat n'a pas bougé depuis le début du stream. Conflit
                # (autre génération/compression a écrit) → non persisté,
                # surfacé au front (toast) plutôt que d'écraser son tour.
                # (Le lambda ephemeral renvoie None → `is not False` = OK.)
                # Persist en THREAD. ``upsert_chat`` est du SQLite
                # synchrone : il sérialise la conversation entière (des
                # mégaoctets en fin de mission) puis écrit et committe,
                # avec ``busy_timeout=10000``. Appelé tel quel dans une
                # coroutine, un writer en contention (WAL, N workers)
                # endormirait la boucle d'événements jusqu'à DIX SECONDES :
                # plus un token pour les autres utilisateurs de ce worker,
                # plus de SSE, et même le bouton Stop sans effet. Le pool de connexions est
                # déjà par (pid, thread), donc l'appel depuis un thread est
                # sûr.
                #
                # Stop PENDANT cette écriture : le thread va au bout quoi
                # qu'il arrive. On l'attend donc jusqu'à son terme
                # (``_attendre_hors_annulation``) et on finit le tour
                # normalement ; ``_tour_persiste`` interdit au ``finally``
                # d'écrire un partiel par-dessus le tour complet.
                _tour_persiste = True
                (_ret, _final_title), _stop_pendant_persist = (
                    await _attendre_hors_annulation(asyncio.ensure_future(
                        asyncio.to_thread(
                            _persist_turn, _persist_chat, user_id, chat_id,
                            _final_title, full,
                            baseline_updated_at=_baseline_updated_at,
                            baseline_messages=_baseline_messages,
                            baseline_title=_baseline_title))))
                if _stop_pendant_persist:
                    logger.info(
                        "[chat_stream] Stop pendant la persistance du tour "
                        "complet (user_id=%s chat_id=%s) : écriture menée à "
                        "terme, pas de partiel", user_id, str(chat_id)[:12])
                if _ret is False:
                    _persist_error = "conflict"
                    logger.warning(
                        "[chat_stream] persist en conflit optimiste (tour concurrent "
                        "sur le même chat) user_id=%s chat_id=%s — non écrasé",
                        user_id, str(chat_id)[:12])
                else:
                    await asyncio.to_thread(enforce_recent_chats_cap, user_id)
                    _persisted = True
            except ValueError as _collision_err:
                # Collision cross-user : ce chat_id appartient à un autre user.
                # On bascule sur un chat_id serveur neuf et on réessaie une fois.
                _new_chat_id = secrets.token_hex(12)
                logger.warning(
                    "[chat_stream] collision chat_id cross-user — bascule sur un "
                    "nouvel id serveur user_id=%s ancien=%s nouveau=%s : %s",
                    user_id, str(chat_id)[:12], _new_chat_id[:12], _collision_err,
                )
                try:
                    await _attendre_hors_annulation(asyncio.ensure_future(
                        asyncio.to_thread(
                            _persist_chat, user_id, _new_chat_id, _final_title,
                            full, time.time())))
                    await asyncio.to_thread(enforce_recent_chats_cap, user_id)
                    _effective_chat_id = _new_chat_id
                    _persisted = True
                except Exception as _retry_err:  # noqa: BLE001 — signalé au front (persist_error)
                    _persist_error = "collision"
                    logger.warning(
                        "[chat_stream] retry sur nouvel id échoué "
                        "user_id=%s chat_id=%s : %s", user_id, _new_chat_id[:12], _retry_err,
                    )
            except Exception as _persist_err:  # noqa: BLE001 — la réponse générée part quand même, signalée non sauvegardée
                _persist_error = "db"
                logger.warning(
                    "[chat_stream] persistance du tour échouée (réponse générée mais NON sauvegardée) "
                    "user_id=%s chat_id=%s : %s", user_id, str(chat_id)[:12], _persist_err,
                )

            # ── Écritures meta_json de fin de tour : UNE transaction ──
            # Marques d'élagage (best-effort, idempotent), toggles d'outils
            # par chat, sortie one-shot du mode plan, occupation de contexte
            # et suffixes LLM partagent la même colonne : un seul
            # ``finalize_turn_meta`` en thread, une seule transaction, au
            # lieu d'un ``BEGIN IMMEDIATE`` par écriture.
            #
            # Toggles : SAUF quand l'interrupteur maître « Outils
            # externes » est coupé — la liste est alors vide PAR DÉCISION
            # SERVEUR, pas par choix de l'utilisateur. L'écrire effacerait
            # la sélection de chaque chat touché pendant que le toggle est
            # OFF. Ne rien écrire préserve l'état existant.
            #
            # Mode plan ONE-SHOT : le plan est rendu → sortie AUTO.
            # Décision dans ``_plan_mode_should_end`` (module-level,
            # testable) ; le serveur reste l'autorité — le front n'est que
            # prévenu par ``plan_mode_done`` dans le 'final'. Les chemins
            # annulation/erreur ne passent pas ici (blocs except plus
            # bas) : le plan n'a pas été rendu, le mode reste.
            _do_prune = bool(_persisted and _new_prune_keys)
            _do_tools = bool(_persisted and not ephemeral and _mcp_on)
            _want_plan_off = _plan_mode_should_end(_plan_mode, _persisted, ephemeral, metrics)
            # Occupation de contexte : même transaction (un chat éphémère
            # n'a pas de ligne à mettre à jour).
            _do_ctx = bool(_persisted and not ephemeral and _ctx_snap)
            # Suffixe LLM de la question de ce tour (rappel todo) : rejoué
            # à l'octet aux tours suivants. Signature = rang + contenu de la
            # DERNIÈRE question du payload, comme l'expansion la
            # recalculera. L'entrée de la dernière question est POSÉE ou
            # RETIRÉE (``None``) à chaque tour persisté, et les entrées de
            # rang ≥ au sien (branche abandonnée : retry, édition) sont
            # purgées : une entrée jamais retirée ferait rejouer, à un texte
            # identique revenu au même rang, un rappel que le modèle n'a
            # jamais vu. L'écriture n'a lieu que s'il y a quelque chose à
            # changer.
            _suffix_map = None
            _suffix_drop_rank = None
            if _persisted and not ephemeral and not is_continue:
                with swallow("chat.user_suffix_sig"):
                    _suffix_map, _suffix_drop_rank = _suffixe_question(
                        messages, _existing_chat, _new_user_suffix)
            _plan_done = False
            if _do_prune or _do_tools or _want_plan_off or _do_ctx or _suffix_map:
                with swallow("chat.worker.4"):
                    from shared_infra.chat.store import finalize_turn_meta
                    _meta_ok = await asyncio.to_thread(
                        finalize_turn_meta, user_id, _effective_chat_id,
                        list(_new_prune_keys) if _do_prune else None,
                        (_ui_tool_cats + _ui_ext_ids
                         + ["-" + _n for _n in _ui_excl]) if _do_tools else None,
                        _want_plan_off,
                        ctx_usage=(_ctx_snap if _do_ctx else None),
                        user_suffixes=_suffix_map,
                        suffix_drop_from_rank=_suffix_drop_rank)
                    _plan_done = bool(_meta_ok and _want_plan_off)

            _final_assistant = assistant
            _final_thinking = thinking_text
            _final_metrics = metrics

            # Jauge de contexte : émission UNIQUE du tour, depuis l'usage
            # RÉEL du serveur (fin de requête) — le front recale la jauge
            # sur CHAQUE event kv_cache, il n'y a pas d'event pré-vol
            # estimé. Occupation = PROMPT RÉEL uniquement (last_prompt
            # _tokens) : on N'AJOUTE PAS la complétion, qui inclut le thinking —
            # éphémère, strippé de l'historique au tour suivant (l'inclure donnerait
            # "4,7k en fin de tour" vs ~800 au prompt suivant) ; le contenu généré
            # apparaîtra dans le prompt réel du tour suivant.
            with swallow("chat.worker.6"):
                if _ctx_snap:   # jauge KV = serveur llama.cpp de la cible (cf. _ctx_usage_snapshot)
                    await on_event({
                        "type": "kv_cache", "used": _ctx_snap["used"],
                        "total": _ctx_snap["total"], "pct": _ctx_snap["pct"],
                    })

            # (La sortie du mode plan est faite plus haut, dans la
            # transaction composite ``finalize_turn_meta``.)
            _final_payload = _payload_final(
                assistant, msg_assistant, thinking_text, metrics, exec_id=_exec_id,
                chat_id=_effective_chat_id, plan_done=_plan_done,
                title_was_generated=_title_was_generated, final_title=_final_title,
                persisted=_persisted, persist_error=_persist_error)
            await on_event(_final_payload)

            # ── Télémétrie APRÈS le 'final' ──
            # Sync mémoire (FTS5, 3 accès SQLite) + 2 log_metric (INSERT +
            # commit chacun) : rien de tout ça ne conditionne la réponse,
            # et les faire AVANT le 'final' garderait le spinner à l'écran
            # (3 sauts de thread + 3 transactions) alors que la réponse
            # est complète. Un seul saut de thread ; chaque volet avale
            # ses erreurs — le 'final' est parti, plus AUCUNE exception ne
            # doit remonter à l'except du worker (il émettrait un event
            # 'error' après le 'final').
            def _post_final_bookkeeping():
                if _mem_manager is not None:
                    with swallow("chat.worker.5"):
                        _mem_manager.sync_turn(_last_user_text, assistant)
                with swallow("chat.worker.metrics"):
                    log_metric("message_sent", 1,
                               {"role": "user", "user": username})
                    log_metric("message_sent", 1,
                               {"role": "assistant", "user": username})
            with swallow("chat.worker.post_final"):
                await asyncio.to_thread(_post_final_bookkeeping)
        except asyncio.CancelledError:
            _was_cancelled = True
            _issue_du_tour("cancelled")
            logger.info("[chat_stream] Cancellation détectée, sauvegarde du partiel…")
        except LLMQueueAborted:
            # Stop pendant l'ATTENTE d'un modèle occupé (``cancel_probe``
            # de ``llm_scheduling_guard``) : rien n'a
            # été généré, ce n'est pas une panne. Même traitement qu'une
            # annulation ordinaire — le partiel (vide) est persisté.
            # ``cancel_probe`` n'abandonne que sur le drapeau d'annulation,
            # que ``_drop_event_after_cancel`` lit aussi : le
            # ``queue_cleared`` ci-dessous est donc filtré, seul le ``final``
            # partiel part, et l'onglet qui arrête retire lui-même le widget
            # (``stopGeneration``). Ce ``queue_cleared`` ne passe que pour un
            # abandon sans drapeau (faux ordonnanceur de
            # ``tests/chatbot/test_flux_route.py``).
            _was_cancelled = True
            _issue_du_tour("cancelled")
            logger.info("[chat_stream] attente du modèle abandonnée "
                        "(Stop pendant la file)")
            with swallow("chat.queue_abort_evt"):
                await on_event({"type": "queue_cleared"})
        except Exception as e:  # noqa: BLE001 — toute panne devient ``error`` puis ``final`` partiel
            # Filet : sans lui, une panne pendant l'attente laisserait le
            # widget de file affiché pour toujours (le front ne le retire
            # que sur ``queue_cleared`` ou le premier token).
            if _file_annoncee[0]:
                _file_annoncee[0] = False
                with swallow("chat.queue_clear_on_error"):
                    await on_event({"type": "queue_cleared"})
            # Jamais ``str(e)`` tel quel dans la bulle de chat
            # (« 'NoneType' object is not subscriptable », « KeyError:
            # 'content' », ou « Erreur » tout seul pour une exception vide) :
            # une phrase par famille de panne, et le motif technique voyage
            # à côté (champ ``detail``, replié dans l'UI).
            logger.exception("[chat_stream] échec de la génération : %s",
                             str(e)[:300])
            _run_crashed = True
            from llm_core._llm_retry import LLMFailure, llm_error_kind
            if isinstance(e, LLMFailure):
                _text, _detail, _kind = str(e), e.detail, e.kind
            else:
                _kind = llm_error_kind(e)
                _text = (
                    "La génération s'est interrompue sur une erreur interne. "
                    "Relancez-la ; si le problème persiste, ouvrez un nouveau "
                    "chat ou signalez le détail ci-dessous."
                )
                _detail = f"{type(e).__name__}: {str(e)[:300]}"
            _issue_du_tour("error", _kind)
            await on_event({"type": "error", "text": _text,
                            "detail": _detail, "kind": _kind})
        finally:

            # Libère explicitement les ressources du MemoryManager
            # (providers, handles fichiers/index). Best-effort, jamais bloquant.
            if _mem_manager is not None:
                with swallow("chat.worker.7"):
                    _mem_manager.shutdown()

            # Titre lancé au début du tour : récolte s'il est déjà prêt
            # (le partiel annulé profite aussi du titre LLM), sinon
            # annulation propre — pas de tâche orpheline qui continuerait
            # d'occuper le serveur après un Stop.
            _partial_title = title or "Nouveau chat"
            if _title_task is not None:
                if _title_task.done() and not _title_task.cancelled():
                    with swallow("chat.worker.8"):
                        _partial_title = _title_task.result() or _partial_title
                elif not _title_task.done():
                    _title_task.cancel()

            if ((_was_cancelled or _run_crashed) and not _final_assistant
                    and not _tour_persiste):

                try:
                    _partiel = _message_partiel(
                        _partial_content_acc, _partial_thinking_acc, _partial_tool_history,
                        exec_id=_exec_id, task_usage=_task_usage, files_changed=_files_changed_acc,
                        compactions=_compactions_acc, msgs=msgs, is_continue=is_continue,
                        tool_images=_image_sink.get("images"))
                    msg_partial = _partiel.message
                    # Même garde que le tour complet : l'upsert du
                    # partiel peut échouer (collision cross-user / panne DB). On
                    # NE doit PAS avaler l'erreur sans 'final' (sinon le partiel
                    # s'affiche comme sauvegardé alors qu'il est perdu). On émet
                    # toujours le 'final' avec ``persisted`` pour que le front
                    # lève un toast non bloquant.
                    _partial_persisted = False
                    _partial_perr = None
                    try:
                        # Même invariant que le tour complet : l'état de
                        # compression est re-préfixé au partiel (sinon perdu).
                        # Garde optimiste : ne pas clobberer un tour
                        # concurrent avec ce partiel (conflit → non persisté).
                        # Même déport en thread que le tour complet : cette
                        # écriture SQLite (busy_timeout 10 s) bloquerait la
                        # boucle au moment précis où l'utilisateur attend la
                        # réaction au Stop.
                        _pret, _partial_title = await asyncio.to_thread(
                            _persist_turn, _persist_chat, user_id, chat_id,
                            _partial_title,
                            _with_compr_state(_partiel.conversation),
                            baseline_updated_at=_baseline_updated_at,
                            baseline_messages=_baseline_messages,
                            baseline_title=_baseline_title)
                        if _pret is False:
                            _partial_perr = "conflict"
                        else:
                            _partial_persisted = True
                    except Exception as _pp_err:  # noqa: BLE001 — le ``final`` part quand même, signalé non sauvegardé
                        _partial_perr = "db"
                        logger.warning(
                            "[chat_stream] persistance du partiel échouée (réponse interrompue "
                            "NON sauvegardée) user_id=%s chat_id=%s : %s",
                            user_id, str(chat_id)[:12], _pp_err,
                        )
                    _partial_final = {
                        "type": "final",
                        "assistant": msg_partial["content"],
                        "run_ids": msg_partial.get("run_ids") or [_exec_id],
                        **({"tool_images": msg_partial["tool_images"]}
                           if msg_partial.get("tool_images") else {}),
                        "chat_id": chat_id,
                        "metrics": None,
                        "thinking": msg_partial.get("thinking", _partiel.raisonnement),
                        "tool_limit_reached": False,

                        "cancelled": bool(_was_cancelled),
                        # Crash (exception échappée) : même armement du
                        # « Continuer » que la troncature — le front lit
                        # cancelled OU truncated.
                        "truncated": bool(_run_crashed),
                        "persisted": _partial_persisted,
                        # Annulé en plein raisonnement (aucune prose) : le
                        # front garde le bloc Réflexion tel quel (pas de
                        # promotion) et marque la reprise possible.
                        "truncated_in_think": bool(
                            not _partiel.texte and _partiel.raisonnement_fusionne),
                    }
                    if _partial_perr:
                        _partial_final["persist_error"] = _partial_perr
                    # Cf. le titre du tour complet : ne réémet le titre que s'il a été
                    # généré ce tour-ci (chat neuf) ; sinon on préserve le
                    # rename côté front.
                    if _title_was_generated:
                        _partial_final["title"] = _partial_title
                    await on_event(_partial_final)
                except Exception as e:  # noqa: BLE001 — repli sur un ``final`` minimal, jamais un flux sans ``final``
                    logger.warning("[chat_stream] Sauvegarde du partiel échouée: %s", e)
                    # Une exception AVANT l'émission du ``final``
                    # (split/tronc/clip/merge/task_runs/compr_state)
                    # fermerait le flux SANS ``final`` : ni ``cancelled``, ni
                    # ``persisted``, ni ``persist_error`` — le front resterait
                    # sur « connexion interrompue » sans bouton Continuer
                    # ni toast. On émet un ``final`` MINIMAL, non persisté.
                    if not _final_sent[0]:
                        with swallow("chat.worker.partial_final"):
                            _txt = "".join(_partial_content_acc).strip()
                            await on_event({
                                "type": "final",
                                "assistant": _txt or _CANCEL_PLACEHOLDER,
                                "run_ids": [_exec_id],
                                "chat_id": chat_id,
                                "metrics": None,
                                "thinking": "".join(_partial_thinking_acc).strip(),
                                "tool_limit_reached": False,
                                "cancelled": bool(_was_cancelled),
                                "truncated": True,
                                "persisted": False,
                                "persist_error": "db",
                                "truncated_in_think": bool(
                                    not _txt and "".join(_partial_thinking_acc).strip()),
                            })
            # Sentinelle de fin : seulement si quelqu'un lit encore. Flux
            # fermé → file pleine possible, ``put`` bloquant à vie (verrou
            # de présence jamais rendu, 409 jusqu'au redémarrage).
            if not (_detached[0] or _lecteur_parti[0]):
                await q.put(None)
    async def _worker_journaled():
        # Fermeture GARANTIE du journal, même sans ``final`` (exception hors
        # harnais, annulation dure) : un client rattaché reçoit ``run_end``
        # au lieu d'attendre indéfiniment. Idempotent si ``final`` l'a fait.
        # L'exécution (``runs``) couvre tout le tour : ce que la boucle,
        # le titre, la compaction et les outils consomment y est versé.
        from llm_core.engines import engine_for_target as _eng_run
        from shared_infra.observability.runs import run_scope
        try:
            async with run_scope("chat", run_id=_exec_id, user_id=user_id,
                                 chat_id=chat_id, model=selected_model or "",
                                 engine=_eng_run(_target).key):
                await worker()
        finally:
            if _journal is not None:
                with swallow("chat.run_journal.close"):
                    await _journal.close("done" if _final_sent[0] else "error")

    # Référence forte + visibilité du drain : sans elle, un run DÉTACHÉ
    # ne serait rattaché à rien (ni connexion uvicorn, ni _BG_TASKS) — au
    # plafond de drain, le process sortirait en le tuant sans que son
    # ``finally`` ait persisté le partiel.
    task = keep(asyncio.create_task(_worker_journaled()))

    # Verrou de présence réclamé en tête de ``run_turn`` (cf. _pending_gen_locks) :
    # à partir d'ici, c'est ``unregister_chat_task`` qui le relâchera, sur
    # la fin RÉELLE du worker.
    register_chat_task(user_id, task, chat_id,
                       presence_fd=(_claimed[0] if _claimed else None))
    try:
        # Drain avec coalescing des tokens consécutifs — voir
        # _drain_coalesced (module) pour le contrat complet.
        async for ev in _drain_coalesced(q):
            yield _ndjson_line(ev)
    except asyncio.CancelledError:

        pass
    except Exception as _stream_err:  # noqa: BLE001 — garde-fou du drain, voir ci-dessous
        # GARDE-FOU — une exception qui s'échappe d'ici (event non
        # sérialisable, bug dans _drain_coalesced…) remonterait dans le
        # BaseHTTPMiddleware (RequestLoggingMiddleware) et crasherait l'ASGI
        # en « Response content shorter than Content-Length », en MASQUANT
        # l'erreur réelle. On la logge AVEC sa stack, on
        # émet une dernière ligne d'erreur propre, puis on termine le flux
        # normalement plutôt que de laisser l'exception remonter.
        logger.exception("[chat_stream] erreur dans le drain du flux: %s", _stream_err)
        with swallow("chat.gen"):
            yield _ndjson_line({"type": "error", "text": f"Flux interrompu: {_stream_err}"})
    finally:
        # Le tour ne regarde plus le widget : couper le suivi de
        # chargement s'il tourne encore (run détaché compris — il
        # publierait dans une file que plus personne ne lit).
        with swallow("chat.stop_load_watch"):
            _stop_load_watch(user_id, chat_id)
        # ── Déconnexion du CLIENT alors que le run travaille encore ──────
        # Une mission autonome de plusieurs heures ne doit pas dépendre d'un
        # navigateur resté ouvert tout ce temps (une mise en veille
        # suffirait à la perdre) : on DÉTACHE le run — le worker continue,
        # persiste normalement, et le résultat est là au retour sur la
        # conversation. C'est le cas du chat principal (``resumable``) et
        # de tout tour où un outil a tourné ; ``DETACH_RUN_ON_DISCONNECT``
        # l'étend aux tours de pur chat non reprenables. Sinon le run est
        # annulé (``_cloturer_run``). Décision : ``_should_detach_run``.
        #
        # Trois précautions :
        #   * on ne détache PAS un Stop utilisateur (flag d'annulation posé)
        #     — c'est une demande explicite d'arrêt ;
        #   * on vide la file et on coupe l'alimentation (``_detached``),
        #     sinon le worker se bloque sur ``q.put`` dès 1000 events ;
        #   * la task RESTE enregistrée (un Stop ultérieur, depuis un autre
        #     onglet ou un autre worker via le cancel_bus, doit encore la
        #     trouver) ; le désenregistrement — donc la libération du verrou
        #     de présence — part sur un callback de fin.
        _user_stopped = False
        with swallow("chat.detach_probe"):
            _user_stopped = is_chat_cancelled(user_id, chat_id)
        # ``DETACH_RUN_ON_DISCONNECT`` est une constante calculée à l'import
        # de ``shared_infra.config`` (rien ne la recharge) : un changement
        # n'est effectif qu'au redémarrage.
        _detach_on_disconnect = False
        with swallow("chat.detach_flag"):
            from shared_infra import config as _cfg_detach
            _detach_on_disconnect = bool(
                getattr(_cfg_detach, "DETACH_RUN_ON_DISCONNECT", False))
        if _should_detach_run(detach_enabled=(_detach_on_disconnect or _resumable),
                              task_done=task.done(),
                              user_stopped=_user_stopped,
                              tools_ran=bool(_tools_ran[0])):
            _couper_file(q, _detached)
            task.add_done_callback(
                lambda _t, _u=user_id, _c=chat_id, _k=task:
                    unregister_chat_task(_u, _c, _k))
            logger.info(
                "[chat_stream] client déconnecté — run DÉTACHÉ (user=%s "
                "chat=%s) : il ira au bout et persistera seul.",
                user_id, chat_id)
            # ``return`` dans un ``finally`` d'async generator : VÉRIFIÉ
            # sûr. Le « async generator ignored GeneratorExit » ne frappe
            # qu'un générateur qui YIELD après avoir reçu GeneratorExit —
            # un ``return`` est au contraire la façon normale de terminer
            # pendant un ``aclose()``.
            return  # noqa: B012

        # Plus personne ne lit la file : sans cette coupure, le ``final``
        # du partiel (après ``task.cancel()``) ou la sentinelle de fin
        # (après la télémétrie post-final) bloquerait le worker sur une file
        # pleine — il ne se terminerait jamais et garderait le chat (409).
        _couper_file(q, _lecteur_parti)
        await _cloturer_run(task, user_id, chat_id,
                            final_sent=_final_sent[0])
