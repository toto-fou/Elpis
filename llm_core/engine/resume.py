# SPDX-License-Identifier: MIT
"""llm_core.engine.resume — reprises automatiques d'une génération coupée.

Deux filets relancent l'appel LLM au lieu de finir le tour sur « Continuer »
(sans effet dans une mission autonome, où personne ne clique) :

  - reprise du RAISONNEMENT : coupure par le plafond de génération en plein
    raisonnement (``finish=length``, ni appel d'outil ni prose) — l'appel
    suivant poursuit le raisonnement accumulé (``continue_final_message``
    natif ou préremplissage ``<think>``) ;
  - reprise de la RÉDACTION : coupure en pleine prose (plafond atteint ou flux
    interrompu) — l'appel suivant continue le message assistant non fermé.

Les deux sont des séries bornées, CHAÎNÉES PAR APPEL LLM : remises à zéro dès
qu'un round aboutit. Leurs préremplissages sont TRANSITOIRES : rien n'entre
dans ``working_messages`` ni dans la tool_history du run.

La borne de la série de reprises du raisonnement (``_think_resume``) est le
seul garde-fou anti-boucle propre aux coupes 100 % raisonnement :
``TruncationGuard`` (``engine.tool_dispatch``) ne compte que les coupes qui
portent des appels d'outils. Sans elle, un modèle qui raisonne toujours
au-delà du plafond serait relancé jusqu'au plafond dur de la boucle.

``ResumeState`` porte la demande en attente pour le PROCHAIN appel et les
compteurs de la série. Une demande est consommée juste avant l'appel
(``take``) et RESTITUÉE (``restore``) si l'appel est relancé (hoquet,
aplatissement, compaction, réponse vide) : sans restitution, la relance
partirait sans elle — le modèle réécrirait sa réponse depuis le début et la
partie déjà écrite n'arriverait jamais en base.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from llm_core._scheduling._guard import _emit
from llm_core._think_resume import should_auto_resume, should_auto_resume_content
from llm_core._tool_parsing import _strip_tool_call_markup
from llm_core.engine.live_text import LiveText
from llm_core.engine.run import RunContext
from shared_infra.config import LLAMA_MODEL
from shared_infra.observability.tracing import swallow

logger = logging.getLogger("uvicorn.error")


def _resume_prefix_join(clean: str, exact: str) -> str:
    """Prose à renvoyer pour une reprise token-exacte.

    ``clean`` est la version affichable (strippée, éventuellement recollée
    d'un segment précédent) ; ``exact`` est le contenu brut du DERNIER
    segment, qui seul porte les espaces de fin. On rend ``clean`` prolongé de
    la queue blanche de ``exact`` : la frontière de reprise est conservée sans
    perdre ce qui a été recollé en amont."""
    tail = exact[len(exact.rstrip()):] if exact else ""
    return (clean or "") + tail


@dataclass(frozen=True, slots=True)
class ResumeRequest:
    """Demande de reprise consommée par UN appel LLM (rien = appel normal)."""

    think: Optional[str] = None     # raisonnement accumulé à poursuivre
    native_ok: bool = True          # canal natif utilisable pour cette demande ?
    content: Optional[str] = None   # prose déjà écrite, à continuer


@dataclass(slots=True)
class ResumeState:
    """Demande de reprise en attente et compteurs de la série en cours."""

    think_count: int = 0                 # reprises de raisonnement chaînées
    think_tokens: int = 0                # completion_tokens cumulés du chaînage
    pending_think: Optional[str] = None  # demande pour le PROCHAIN appel
    pending_native_ok: bool = True       # canal natif OK pour cette demande ?
    content_count: int = 0               # reprises de rédaction chaînées
    pending_content: Optional[str] = None

    def take(self) -> ResumeRequest:
        """Consomme la demande en attente pour l'appel qui part."""
        req = ResumeRequest(think=self.pending_think,
                            native_ok=self.pending_native_ok,
                            content=self.pending_content)
        self.pending_think = None
        self.pending_native_ok = True
        self.pending_content = None
        return req

    def restore(self, req: ResumeRequest) -> None:
        """Restitue une demande consommée par un appel qui sera relancé."""
        self.pending_think = req.think
        self.pending_native_ok = req.native_ok
        self.pending_content = req.content

    def reset_chain(self) -> None:
        """Un round a abouti : le chaînage des reprises repart de zéro."""
        self.think_count = 0
        self.content_count = 0
        self.think_tokens = 0

    async def plan(self, ctx: RunContext, *, live: LiveText, finish: Any,
                   tool_calls: List[Dict[str, Any]], legacy_calls: Any,
                   iter_thinking: str, iter_clean: str, raw_content_exact: str,
                   raw_response: Dict[str, Any], gauge_ctx_total: int,
                   iteration: int) -> bool:
        """Le tour se termine sans appel d'outil : faut-il relancer l'appel
        pour poursuivre une génération coupée ? True = une reprise est
        programmée pour le PROCHAIN appel (l'orchestrateur compte un tour dur
        — une reprise n'est pas un tour productif — et relance l'itération) ;
        False = le tour se conclut."""
        # Constantes du run et données du tour sous leurs noms locaux usuels.
        is_cancelled = ctx.is_cancelled
        on_event = ctx.on_event
        model = ctx.model
        _live = live
        _iter_content_parts = live.parts
        _iter_thinking = iter_thinking
        _iter_clean = iter_clean
        _raw_content_exact = raw_content_exact
        # ── Auto-reprise (filet) : coupure du plafond en PLEIN raisonnement ──
        # Aucun tool_call (natif ni legacy), aucune prose visible, finish=length
        # → relancer l'appel avec le raisonnement accumulé (le bloc Réflexion
        # continue de croître côté UI, aucune bannière). Gardes anti-boucle et
        # headroom n_ctx : cf. _think_resume.should_auto_resume. ``partial``
        # (timeout/plantage serveur) bloque la reprise. Prefill TRANSIENT :
        # rien n'entre dans working_messages ni la tool_history du run.
        if (str(finish or "") == "length"
                and not tool_calls and not legacy_calls
                and not _strip_tool_call_markup("".join(_iter_content_parts)).strip()
                and (_iter_thinking or "").strip()
                and not (is_cancelled and is_cancelled())):
            _seg_usage = raw_response.get("usage") or {}
            _resume_ok, _resume_why = should_auto_resume(
                finish="length", content="", thinking=_iter_thinking,
                had_tool_calls=False,
                partial=bool(raw_response.get("partial")),
                resumes_done=self.think_count,
                think_tokens_done=(self.think_tokens
                                   + int(_seg_usage.get("completion_tokens") or 0)),
                ctx_size=(int(gauge_ctx_total or 0) or None),
                # Occupation RÉELLE en fin de segment (prompt + généré) = ce que
                # le serveur a en KV. Cf. _think_resume :
                # ``last_prompt_tokens + think_tokens_done`` compterait le
                # raisonnement deux fois et bloquerait à mi-fenêtre.
                window_tokens=(int(_seg_usage.get("prompt_tokens") or 0)
                               + int(_seg_usage.get("completion_tokens") or 0)),
            )
            if _resume_ok:
                self.think_count += 1
                self.think_tokens += int(_seg_usage.get("completion_tokens") or 0)
                self.pending_think = _iter_thinking
                self.pending_native_ok = bool(
                    raw_response.get("reasoning_channel_native"))
                logger.info(
                    "[run_chat_multi_mcp] raisonnement coupé par le plafond → "
                    "auto-reprise in-run (%s, iter %d, ≈%d tk de thinking cumulés)",
                    _resume_why, iteration, self.think_tokens,
                )
                return True
            logger.warning(
                "[run_chat_multi_mcp] coupure en plein raisonnement sans "
                "auto-reprise : %s (iter %d)", _resume_why, iteration,
            )

        # ── Auto-reprise : coupure du plafond en pleine RÉDACTION ────────
        # Symétrique du filet ci-dessus, mais pour la PROSE : finish=length,
        # aucun tool_call, du texte visible déjà produit. Sans reprise
        # automatique, le tour finirait en ``truncated`` + bannière
        # « Continuer », ce qui ne veut rien dire dans une mission autonome de
        # plusieurs heures (personne ne clique).
        # Couvre les DEUX causes : plafond de génération réellement atteint, et
        # partiel de TRANSPORT (flux coupé mi-génération) — dans les deux cas
        # le serveur a du texte cohérent en KV et sait le continuer.
        # Réservé au canal natif ``continue_final_message`` : cf.
        # _think_resume.should_auto_resume_content (un repli par consigne
        # dupliquerait la prose).
        if (str(finish or "") == "length"
                and not tool_calls and not legacy_calls
                and not (is_cancelled and is_cancelled())):
            # Source de vérité : la prose du MESSAGE (``_iter_clean``, déjà
            # débarrassée des balises de raisonnement), avec le buffer streamé
            # en second recours. Ne lire QUE le buffer laisserait passer un
            # fournisseur non-streamant, dont la réponse tronquée n'aurait
            # alors jamais de reprise.
            # ``_raw_content_exact`` porte la frontière EXACTE (espaces de fin
            # compris) ; on ne s'en sert que si la prose strippée en est bien
            # un préfixe — sinon ``_extract_thinking`` a retiré un bloc
            # <think> et seule la version nettoyée est renvoyable.
            _cr_raw = _iter_clean or "".join(_iter_content_parts)
            # La relation testée est le SUFFIXE, pas l'égalité : dès la
            # deuxième reprise, ``_iter_clean`` vaut « préfixe accumulé +
            # nouveau segment » alors que ``_raw_content_exact`` ne porte que
            # le NOUVEAU segment. Avec l'égalité, ``_resume_prefix_join`` ne
            # serait pas appelé et l'espace de fin du segment serait perdu —
            # dans le texte affiché (« …distinctes.Voici la suite. ») ET dans
            # le message renvoyé au serveur pour ``continue_final_message``
            # (promesse « token-exacte » et préfixe KV cassés). Seule la queue
            # blanche du dernier segment est à recoller, quel que soit le
            # préfixe déjà accumulé.
            _exact_strip = (_raw_content_exact or "").strip()
            if (_iter_clean and _raw_content_exact and _exact_strip
                    and _iter_clean.rstrip().endswith(_exact_strip)):
                _cr_raw = _resume_prefix_join(_iter_clean, _raw_content_exact)
            _cr_text = _strip_tool_call_markup(_cr_raw).strip()
            if _cr_text:
                _cr_usage = raw_response.get("usage") or {}
                # Canal natif = cible llama.cpp (intégrée ou connecteur) **et**
                # support de ``continue_final_message`` pas déjà infirmé pour ce modèle
                # (le mémo négatif expire — cf. _llm_params, TTL des caches).
                _cr_native_ok = False
                with swallow("harness.content_resume_native_probe"):
                    from llm_core._llm_params import continue_final_support
                    from llm_core._target import current_target as _ct3
                    _cr_native_ok = bool(
                        _ct3().is_llamacpp
                        and continue_final_support(
                            model or LLAMA_MODEL or None) is not False)
                _cr_ok, _cr_why = should_auto_resume_content(
                    finish="length", content=_cr_text, had_tool_calls=False,
                    native_ok=_cr_native_ok,
                    resumes_done=self.content_count,
                    ctx_size=(int(gauge_ctx_total or 0) or None),
                    window_tokens=(int(_cr_usage.get("prompt_tokens") or 0)
                                   + int(_cr_usage.get("completion_tokens") or 0)),
                )
                if _cr_ok:
                    self.content_count += 1
                    # La prose brute (AVANT strip du markup) est ce que le
                    # serveur a réellement en KV : c'est elle qu'il faut lui
                    # renvoyer pour qu'il continue token-exacte.
                    self.pending_content = _cr_raw
                    logger.info(
                        "[run_chat_multi_mcp] réponse coupée par le plafond → "
                        "auto-reprise de la rédaction (%s, iter %d, %d chars "
                        "déjà écrits)", _cr_why, iteration, len(_cr_text),
                    )
                    # Le client doit tenir EXACTEMENT
                    # ``_cr_text`` avant la reprise : queue retenue (fenêtre /
                    # portail) émise ici, resynchronisation si le nettoyage
                    # diverge du déjà-émis. L'itération de reprise compte ce
                    # préfixe dans le ``n`` de son ``LiveText``
                    # (``prefixer_deja_emis``, dans ``llm_turn.call_llm``).
                    await _live.emit_rest(_cr_text, replace_on_divergence=True)
                    await _emit(on_event, {
                        "type": "info",
                        "text": "Réponse tronquée — reprise automatique de la rédaction…",
                    })
                    return True
                logger.warning(
                    "[run_chat_multi_mcp] réponse coupée sans reprise : %s "
                    "(iter %d)", _cr_why, iteration,
                )
        return False
