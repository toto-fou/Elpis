# SPDX-License-Identifier: MIT
"""
chatbot_app.turn.persistence — enregistrement du tour : construction du
message assistant (tour complet ou partiel d'un tour interrompu, fusion d'un
« Continuer »), écriture optimiste sur ``updated_at`` (un conflit est signalé,
rien n'est écrasé), attente d'une écriture engagée malgré un Stop, et
décisions des écritures ``meta_json`` de fin de tour (sortie du mode plan,
suffixe LLM de la question).

Les fonctions de construction sont pures : elles lisent les accumulateurs du
tour et ne modifient que le message qu'elles rendent.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, NamedTuple, Optional

from chatbot_app.turn.history import (
    _CANCEL_PLACEHOLDER,
    _merge_continue_tool_history,
    _merge_prev_segment_lists,
    _split_for_continue,
    _task_runs_for_persist,
    _tronc_pour_reprise,
)
from shared_infra.chat.store import get_chat

logger = logging.getLogger("uvicorn.error")


def _persist_turn(persist, user_id: int, chat_id: str, title: str, messages: list,
                  *, baseline_updated_at, baseline_messages, baseline_title: str,
                  read_chat=get_chat) -> "tuple[Any, str]":
    """Persistance d'un tour sous garde optimiste, avec reprise du conflit BÉNIN.

    La garde (``expected_updated_at``) refuse l'écriture dès que ``updated_at``
    a bougé depuis le début du tour. C'est voulu contre un tour CONCURRENT
    (autre worker, compaction) — mais ``updated_at`` bouge aussi sans que les
    messages changent : un renommage pendant la génération ne doit pas faire
    perdre la réponse.

    Sur conflit, on relit donc le chat : messages identiques à ceux du début
    du tour ⇒ rien de concurrent n'a été écrit, on réécrit sur la nouvelle base
    en gardant le titre choisi entre-temps. Messages différents ⇒ vrai conflit,
    on ne clobbere pas. Retourne ``(résultat de persist, titre écrit)``.
    Synchrone (appelé en thread)."""
    ret = persist(user_id, chat_id, title, messages, time.time(),
                  expected_updated_at=baseline_updated_at)
    if ret is not False or baseline_updated_at is None:
        return ret, title
    try:
        current = read_chat(user_id, chat_id)
    except Exception:  # noqa: BLE001 — relecture impossible : le conflit est traité comme réel
        logger.warning("[chat_stream] relecture après conflit échouée chat=%s",
                       str(chat_id)[:12], exc_info=True)
        return False, title
    if not current or current.get("messages") != baseline_messages:
        return False, title
    stored_title = (current.get("title") or "").strip()
    if stored_title and stored_title != (baseline_title or "").strip():
        title = stored_title
    logger.info("[chat_stream] conflit bénin (chat modifié sans nouveau message, "
                "ex. renommage) chat=%s — réécriture sur la nouvelle base",
                str(chat_id)[:12])
    ret = persist(user_id, chat_id, title, messages, time.time(),
                  expected_updated_at=current.get("updated_at"))
    return ret, title

async def _attendre_hors_annulation(fut: "asyncio.Future"):
    """Attend ``fut`` jusqu'à SON terme, même si la tâche courante est annulée.

    Retourne ``(résultat, annulée_pendant)``. Sert à la persistance du tour
    COMPLET : ``await asyncio.to_thread(...)`` interrompu par un Stop rend la
    main tout de suite, mais le thread, lui, continue et écrit le tour. Le
    ``finally`` du worker verrait alors ``_final_assistant == ""`` et
    persisterait EN PLUS un partiel : conflit optimiste contre le tour
    complet (toast « non sauvegardé »), méta de fin de tour sautées — et,
    sous contention SQLite, le partiel pourrait écraser le complet.

    Ici l'annulation est ABSORBÉE le temps que l'écriture se termine (le
    ``shield`` protège le thread, la boucle ré-attend après chaque annulation)
    puis retirée du compteur de la tâche (``uncancel``) : l'appelant finit son
    tour normalement (méta, ``final``), puisque la réponse est complète et
    écrite. Une exception de ``fut`` remonte telle quelle.
    """
    annulations = 0
    while True:
        try:
            res = await asyncio.shield(fut)
            break
        except asyncio.CancelledError:
            if fut.cancelled():
                raise
            annulations += 1
    if annulations:
        _t = asyncio.current_task()
        if _t is not None and hasattr(_t, "uncancel"):
            for _ in range(annulations):
                _t.uncancel()
    return res, annulations > 0

def _plan_mode_should_end(plan_mode: bool, persisted: bool, ephemeral: bool,
                          metrics: dict | None) -> bool:
    """Mode plan ONE-SHOT : le tour qui s'achève doit-il couper le mode ?

    Le mode couvre UN tour abouti, puis le serveur le coupe lui-même
    (autorité). On ne coupe PAS sur :
      - troncature (plafond tokens OU limite de boucle d'outils) — le
        « Continuer » doit reprendre EN mode plan, sinon la fin du plan
        repartirait avec les outils d'écriture ;
      - persist en échec (conflit optimiste = un tour concurrent écrit sur ce
        chat — on ne mute pas son meta_json sous lui) ;
      - session éphémère (aucun chat en base).
    Les chemins annulation/erreur n'appellent jamais ce helper : le plan n'a
    pas été rendu, le mode reste.
    """
    if not plan_mode or not persisted or ephemeral:
        return False
    if metrics and (metrics.get("truncated") or metrics.get("tool_limit_reached")):
        return False
    return True


def _message_assistant(assistant: str, thinking_text: str, metrics: Optional[dict], *,
                       exec_id: str, ctx_snap: Optional[dict], task_usage: dict,
                       files_changed: dict, compactions: list, prune_keys: list,
                       msgs: list, is_continue: bool,
                       tool_images: Optional[list] = None) -> "tuple[dict, list, list, str]":
    """Message assistant du tour COMPLET, prêt à enregistrer.

    Rend ``(message, avant, après, contenu)`` : ``avant + [message] + après``
    est la conversation à persister, ``contenu`` le texte de la réponse (la
    fusion avec le segment tronqué après un « Continuer »). Ne modifie que le
    message qu'il construit ; les accumulateurs du tour sont seulement lus.
    """
    # ``run_ids`` : exécutions du message (``runs``) — plusieurs
    # après un « Continuer », dans l'ordre.
    msg_assistant = {"role": "assistant", "content": assistant,
                     "run_ids": [exec_id]}
    if metrics:
        # Le message porte une COPIE des métriques SANS
        # ``tool_history``. La liste (des mégaoctets sur une
        # mission longue) serait sinon présente deux fois dans le
        # même message — au premier niveau ET dans les métriques —
        # donc écrite deux fois en base à chaque tour.
        # L'event NDJSON final, lui, continue de porter les
        # métriques COMPLÈTES : le front lit ``metrics.tool_history``
        # pour reconstruire les cartes d'outils en direct, et son
        # repli ``data.metrics.thinking`` lit cet EVENT, jamais la base.
        #
        # ``thinking`` est retiré ici aussi : le raisonnement n'est
        # pas retenu en base (seule exception : ``resume_thinking``).
        # ``upsert_chat`` le retire de toute façon, ``metrics["thinking"]``
        # compris (jusqu'à ``THINKING_HISTORY_MAX_CHARS`` caractères) ;
        # ce filtre lui évite de recopier les métriques de ce message
        # pour l'en retirer.
        msg_assistant["metrics"] = {
            k: v for k, v in metrics.items()
            if k not in ("tool_history", "thinking")}
        if ctx_snap:
            msg_assistant["metrics"]["kv_cache"] = {
                "used": ctx_snap["used"], "total": ctx_snap["total"],
                "pct": ctx_snap["pct"]}
    if thinking_text:
        msg_assistant["thinking"] = thinking_text
    # Coupure en PLEIN raisonnement (``truncated_in_think``) :
    # persister le raisonnement sous ``resume_thinking`` — seule
    # exception au « thinking non persisté » (cf. upsert_chat), bornée
    # au suffixe utile — pour qu'un « Continuer » reprenne À PARTIR
    # du raisonnement déjà produit (même après rechargement) au lieu
    # de re-raisonner de zéro et retomber sur le même mur.
    if metrics and metrics.get("truncated_in_think") and thinking_text:
        from llm_core._think_resume import clip_resume_thinking
        msg_assistant["resume_thinking"] = clip_resume_thinking(thinking_text)
        msg_assistant["thinkingTruncated"] = True

    if metrics and metrics.get("tool_history"):
        msg_assistant["tool_history"] = metrics["tool_history"]
        # Marqueur de format : la boucle produit un DELTA
        # (travail de CE run seul) — l'expansion du tour
        # suivant l'expanse intégralement, sans dédup legacy.
        if metrics.get("tool_history_delta"):
            msg_assistant["tool_history_delta"] = True

    # Sous-agents (outil ``task``) : records des runs persistés SUR le
    # message (comme toolLoopStats) → la carte agent du front survit
    # au rechargement (_history.js réhydrate ``task_runs``).
    if task_usage.get("runs"):
        msg_assistant["task_runs"] = _task_runs_for_persist(task_usage["runs"])
    if files_changed:
        msg_assistant["files_changed"] = list(files_changed.values())
    if compactions:
        msg_assistant["compactions"] = list(compactions)
    # Images produites par l'outil ``generate_image`` : références posées sur
    # le message, la grille survit au rechargement.
    if tool_images:
        msg_assistant["tool_images"] = list(tool_images)
    # Élagage visible : sorties d'outils retirées du contexte.
    if prune_keys:
        msg_assistant["pruned"] = len(prune_keys)

    # Un « Continuer » (reprise) ne crée PAS de 2e message
    # assistant en base. Le front fusionne la continuation dans la
    # bulle tronquée existante (last.content += chunk) et ne crée
    # pas de nouvelle bulle ; côté serveur, ``msgs`` contient encore
    # l'assistant tronqué. Ajouter ``msg_assistant`` comme message
    # séparé laisserait DEUX assistants consécutifs en base → au
    # rechargement (mapping 1:1) la réponse serait scindée en deux
    # bulles et ``isTruncated`` perdu. On retire donc
    # le dernier assistant de ``msgs`` et on concatène son contenu +
    # tool_history/thinking dans un UNIQUE message.
    _base_msgs = msgs
    _tail_msgs: list = []
    _prev_c, _before_c, _after_c = (
        _split_for_continue(msgs) if is_continue else ({}, msgs, []))
    if _prev_c:
        _prev = _prev_c
        _base_msgs, _tail_msgs = _before_c, _after_c
        _prev_content = _tronc_pour_reprise(_prev)
        msg_assistant["content"] = _prev_content + assistant
        # tool_history : ``metrics["tool_history"]`` est le DELTA de la
        # continuation (travail du run de reprise SEUL, cf.
        # ``RunRecord.run_tool_history``) → on le CONCATÈNE au tronc persisté du
        # message tronqué. Avec un delta, remplacer perdrait le
        # travail du tronc (une capture cumulative, elle, se
        # remplace : re-préfixer la doublerait à chaque Continue).
        _mth = _merge_continue_tool_history(
            _prev,
            msg_assistant.get("tool_history"),
            bool(msg_assistant.get("tool_history_delta")),
        )
        msg_assistant.pop("tool_history", None)
        msg_assistant.pop("tool_history_delta", None)
        msg_assistant.update(_mth)
        # Cartes de sous-agents du SEGMENT tronqué : sans cette
        # fusion, le message ne porterait que celles de la
        # continuation (perdues au rechargement, et absentes du
        # contexte des tours suivants).
        _merge_prev_segment_lists(_prev, msg_assistant)
        # Fusionne thinking de la même façon (tronqué + reprise).
        _prev_think = _prev.get("thinking")
        _merged_think = (str(_prev_think) if _prev_think else "") + (thinking_text or "")
        if _merged_think:
            msg_assistant["thinking"] = _merged_think
        # ``resume_thinking`` : purgé après une reprise ABOUTIE
        # (retour à la règle « thinking non persisté ») ; si le
        # nouveau tour est LUI-MÊME coupé en plein think, il vaut le
        # raisonnement FUSIONNÉ — le prochain Continue repart du
        # raisonnement complet.
        if metrics and metrics.get("truncated_in_think"):
            from llm_core._think_resume import clip_resume_thinking
            _prev_rt = str(_prev.get("resume_thinking")
                           or _prev.get("thinking") or "")
            msg_assistant["resume_thinking"] = clip_resume_thinking(
                _prev_rt + (thinking_text or ""))
            msg_assistant["thinkingTruncated"] = True
        else:
            msg_assistant.pop("resume_thinking", None)
            msg_assistant.pop("thinkingTruncated", None)
        # Le contenu effectivement persisté/affiché est la fusion.
        assistant = msg_assistant["content"]

    # Marqueurs de troncature persistés SUR le message (relus au
    # rechargement par ``loadChat``, ``frontend/js/chat/_history.js``) :
    # le bouton « Continuer »
    # réapparaît après rechargement — pour une limite de boucle d'outils
    # comme pour une coupure par plafond de tokens (finish=length).
    # Basés sur les metrics de CE tour (gère donc la re-troncature
    # d'une continuation).
    if metrics and metrics.get("tool_limit_reached"):
        msg_assistant["isTruncated"] = True
        msg_assistant["toolLoopTruncated"] = True
        # ``iterations`` doit être HOMOGÈNE à ``max_iterations`` :
        # ce dernier est le budget comparé aux itérations PRODUCTIVES,
        # alors que ``tool_limit_iters`` porte le compteur dur : le
        # couple décrirait sinon « 100/50 ». On relaie donc les
        # productives ; le compteur dur reste dispo sous
        # ``hard_iterations`` pour le diagnostic.
        msg_assistant["toolLoopStats"] = {
            "iterations":      metrics.get("tool_limit_effective_iters",
                                           metrics.get("tool_limit_iters", 0)),
            "hard_iterations": metrics.get("tool_limit_iters", 0),
            "max_iterations":  metrics.get("tool_limit_max", 0),
            "tool_calls_done": metrics.get("tool_limit_calls", 0),
            # Cause fine de l'arrêt (steps | hard | wallclock |
            # ctx_saturated | gen_cap | cycle | empty_choices) :
            # le bandeau ne dit pas « limite atteinte » pour un
            # run arrêté par le mur d'horloge ou une coupe.
            "stop_reason":     metrics.get("tool_limit_stop_reason") or "",
        }
    elif metrics and metrics.get("truncated"):
        msg_assistant["isTruncated"] = True
    return msg_assistant, _base_msgs, _tail_msgs, assistant


class MessagePartiel(NamedTuple):
    """Partiel d'un tour interrompu, prêt à enregistrer. Se lit par attribut :
    l'ordre des champs n'est pas un contrat."""
    message: dict
    avant: list
    apres: list
    texte: str
    raisonnement: str
    raisonnement_fusionne: str

    @property
    def conversation(self) -> list:
        """La conversation à persister : ``avant + [message] + apres``."""
        return self.avant + [self.message] + self.apres


def _message_partiel(content_parts: list, thinking_parts: list,
                     partial_tool_history: list, *, exec_id: str, task_usage: dict,
                     files_changed: dict, compactions: list, msgs: list,
                     is_continue: bool, tool_images: Optional[list] = None) -> MessagePartiel:
    """Message assistant d'un tour INTERROMPU (Stop, plantage) : la prose et
    le raisonnement déjà streamés, l'historique d'outils capturé avant la
    propagation de l'annulation, les sous-agents, fichiers et jalons du tour.

    ``avant + [message] + apres`` est la conversation à persister ; ``texte``,
    ``raisonnement`` et ``raisonnement_fusionne`` servent au ``final``
    partiel. Ne modifie que le message qu'il construit.
    """
    partial = "".join(content_parts).strip()
    partial_thinking = "".join(thinking_parts).strip()
    # Même invariant qu'au tour complet : en
    # is_continue, ``msgs`` contient encore l'assistant
    # tronqué. On le retire et on fusionne son contenu/thinking
    # dans le partiel pour ne pas créer deux bulles assistant.
    _base_partial = msgs
    _tail_partial: list = []
    _prev_partial_think = ""
    _prev_p: dict = {}
    _pp, _bp, _ap = (
        _split_for_continue(msgs) if is_continue else ({}, msgs, []))
    if _pp:
        _prev_p = _pp
        _base_partial, _tail_partial = _bp, _ap
        partial = (_tronc_pour_reprise(_prev_p) + partial)
        _pt = _prev_p.get("thinking")
        if _pt:
            _prev_partial_think = str(_pt)
    _merged_partial_think = _prev_partial_think + (partial_thinking or "")
    if partial:

        msg_partial = {
            "role": "assistant",
            "content": partial,
            "isTruncated": True,
            "run_ids": [exec_id],
        }
        if _merged_partial_think:
            msg_partial["thinking"] = _merged_partial_think
    else:

        msg_partial = {
            "role": "assistant",
            "content": _CANCEL_PLACEHOLDER,
            # Le placeholder est marqué continuable : une
            # annulation en plein raisonnement (drain
            # worker 300 s compris) garde le bouton
            # « Continuer ».
            "isTruncated": True,
            "run_ids": [exec_id],
        }
        if _merged_partial_think:
            msg_partial["thinking"] = _merged_partial_think
            # Annulé 100 % thinking : le raisonnement doit
            # SURVIVRE pour la reprise (cf. resume_thinking
            # du tour complet).
            from llm_core._think_resume import clip_resume_thinking
            msg_partial["resume_thinking"] = clip_resume_thinking(
                _merged_partial_think)
            msg_partial["thinkingTruncated"] = True
    # Annulation EN PLEINE boucle d'outils : rattache la
    # tool_history capturée (event interne tool_history_partial)
    # pour qu'un « Continuer » rejoue le travail déjà fait au lieu
    # de repartir aveugle (et de rejouer des outils mutants déjà
    # appliqués). Le snapshot est le DELTA du run annulé → même
    # fusion que le tour complet : concaténé au tronc si
    # Continue (jamais à sa place), et le tronc seul est
    # préservé si le run annulé n'a rien produit.
    msg_partial.update(_merge_continue_tool_history(
        _prev_p, list(partial_tool_history) or None, True))
    # Lignes agents (outil ``task``) du tour interrompu :
    # sans ce rattachement, les runs (y compris celui
    # annulé en vol, poussé dans le sink AVANT la
    # propagation du Stop) disparaîtraient du partiel →
    # cartes agents évaporées au rechargement.
    if task_usage.get("runs"):
        msg_partial["task_runs"] = _task_runs_for_persist(task_usage["runs"])
    if files_changed:
        msg_partial["files_changed"] = list(files_changed.values())
    if compactions:
        msg_partial["compactions"] = list(compactions)
    # Images déjà rangées par l'outil avant le Stop : elles existent, le
    # partiel les montre.
    if tool_images:
        msg_partial["tool_images"] = list(tool_images)
    # Stop pendant un « Continuer » : les
    # cartes de sous-agents du segment tronqué sont gardées.
    if isinstance(_prev_p, dict) and _prev_p:
        _merge_prev_segment_lists(_prev_p, msg_partial)
    return MessagePartiel(msg_partial, _base_partial, _tail_partial, partial,
                          partial_thinking, _merged_partial_think)


def _suffixe_question(messages: list, existing_chat: Optional[dict],
                      new_user_suffix: dict) -> "tuple[Optional[dict], Optional[int]]":
    """Entrée de ``llm_user_suffixes`` à écrire pour la DERNIÈRE question du
    payload : ``({signature: suffixe ou None}, rang)``, ou ``(None, None)``
    s'il n'y a rien à changer.

    La signature (rang + contenu) est celle que l'expansion recalculera.
    L'entrée est posée, ou retirée (``None``), à chaque tour persisté, et le
    rang rendu sert à purger les entrées de rang supérieur ou égal (branche
    abandonnée : retry, édition) : une entrée jamais retirée ferait rejouer, à
    un texte identique revenu au même rang, un rappel que le modèle n'a
    jamais vu.
    """
    from llm_core.context.pruning import user_suffix_sig
    _uq = [m for m in messages if (m or {}).get("role") == "user"]
    if not _uq:
        return None, None
    _rank = len(_uq) - 1
    _prev_sfx = (existing_chat or {}).get("llm_user_suffixes")
    _stale = isinstance(_prev_sfx, dict) and any(
        str(_k).split(":", 1)[0].isdigit()
        and int(str(_k).split(":", 1)[0]) >= _rank
        for _k in _prev_sfx)
    if new_user_suffix.get("text") or _stale:
        return ({user_suffix_sig(_rank, _uq[-1].get("content")):
                 new_user_suffix.get("text") or None}, _rank)
    return None, None
