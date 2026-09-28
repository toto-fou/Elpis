# SPDX-License-Identifier: MIT
"""llm_core._think_resume — primitives PURES de reprise d'un raisonnement coupé.

Quand une génération se termine en ``finish_reason == "length"`` alors que le
modèle était encore en plein raisonnement (``content`` vide, ``thinking`` non
vide), les moteurs (chat classique ET boucle outillée) peuvent reprendre la
génération in-run au lieu d'armer la bannière « Continuer » :

- **Mode natif** (builds llama.cpp récents) : ``continue_final_message: true``
  + ``add_generation_prompt: false`` — le serveur re-rend le DERNIER message
  assistant **non fermé** ; avec un ``reasoning_content`` présent et un
  ``content`` vide, la génération reprend *à l'intérieur* du bloc think,
  token-exacte et compatible KV-cache (mécanique du webui llama.cpp).
- **Mode repli** (serveur ancien → 4xx sur le natif, mémorisé par
  ``_llm_params.note_continue_final_support`` ; ou raisonnement arrivé par
  BALISES ``<think>`` dans le canal content — serveur en ``--reasoning-format
  none`` — où une continuation native arriverait sans balise ouvrante et
  serait classée content) : prefill assistant ``<think>…</think>`` FERMÉ +
  consigne « ta réflexion est terminée, rédige la réponse », avec
  ``thinking_mode=False``. Un prefill NON fermé ne « continue » pas réellement
  hors ``continue_final_message`` : le template clôt le message et rouvre un
  tour — le modèle repartirait. Le repli demande donc la CONCLUSION à partir
  du raisonnement déjà produit (même geste que « Répondre maintenant »).

Ce module ne fait AUCUNE I/O : décisions et constructions de messages
seulement, pour rester trivialement testable (tests/llm_core/test_think_resume.py).
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from llm_core._constants import (
    LLAMA_CONTENT_RESUME_MAX,
    LLAMA_THINK_RESUME_MAX,
    LLAMA_THINK_RESUME_TOTAL_TOKENS,
)

THINK_PREFILL_OPEN = "<think>\n"

# Consigne du mode repli — texte CANONIQUE partagé avec la route
# (chatbot_app.routes.chats._RESUME_AFTER_THINK l'importe) : même geste que le
# « Répondre maintenant » historique.
RESUME_AFTER_THINK_INSTRUCTION = (
    "Your thinking phase is over. Now write your final answer for the user, "
    "building on the reasoning above — without repeating or continuing it, "
    "and without <think> tags."
)

# Borne du raisonnement rejoué dans une reprise (prefill OU persistance
# ``resume_thinking``) : au-delà, on ne garde que le SUFFIXE — le raisonnement
# récent est le plus utile pour conclure — précédé d'un marqueur explicite.
MAX_RESUME_THINKING_CHARS = 150_000
RESUME_TRUNC_MARKER = "[…raisonnement antérieur tronqué…]\n"

# Marge minimale de FENÊTRE D'INFÉRENCE (tokens) exigée pour tenter une
# reprise. À ne pas confondre avec le budget de contexte de la conversation :
# le raisonnement est ÉPHÉMÈRE (jamais re-soumis au tour suivant, strippé de
# l'historique) et ne pèse donc RIEN sur le contexte de travail — la seule
# limite qui le concerne est physique : llama.cpp ne peut pas générer au-delà
# de la fenêtre qu'il a en KV. Quand cette fenêtre est pleine, re-POSTer ne
# produirait que quelques tokens avant un nouveau finish=length : on rend la
# main (bannière) au lieu de payer un prefill complet pour rien.
RESUME_HEADROOM_TOKENS = 2048

# ── Reprise du CONTENU (audit long-run 2026-08-21) ─────────────────────────
# Jusqu'ici, seul le RAISONNEMENT coupé était repris in-run. Une réponse en
# PROSE coupée par le plafond (ou par un flux interrompu mi-génération)
# terminait le tour en ``truncated`` + bannière « Continuer » : parfait pour un
# humain devant son écran, fatal pour une mission autonome de plusieurs heures
# où personne ne cliquera. C'est la coupure la plus fréquente sur les runs
# longs — et la seule dont il ne restait aucune reprise automatique.
#
# Contrainte de correction : on ne reprend QU'EN MODE NATIF
# (``continue_final_message``, llama.cpp local récent), qui reprend la
# génération À L'INTÉRIEUR du message assistant non fermé, token-exacte. Le
# repli « prefill + consigne » utilisé pour le raisonnement ne convient PAS ici
# : demander à un modèle de « continuer sans répéter » de la prose produit
# régulièrement un chevauchement ou une redite, et une réponse visiblement
# dupliquée est PIRE que la bannière « Continuer » qu'on cherche à éviter.
# Sans canal natif, le comportement historique est donc conservé tel quel.
MAX_RESUME_CONTENT_CHARS = 200_000


def clip_resume_thinking(thinking: str) -> str:
    """Borne le raisonnement rejoué (suffixe conservé, marqueur en tête)."""
    t = thinking or ""
    if len(t) <= MAX_RESUME_THINKING_CHARS:
        return t
    return RESUME_TRUNC_MARKER + t[-MAX_RESUME_THINKING_CHARS:]


def build_resume_tail(
    thinking: str, *, native: bool,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Construit la QUEUE de messages + les flags de payload d'une reprise.

    Retourne ``(extra_messages, payload_flags)`` :
    - natif : ``[{role: assistant, content: "", reasoning_content: …}]`` +
      ``{"continue_final_message": True, "add_generation_prompt": False}``
      (flags aussi auto-armés par ``build_llama_payload`` sur cette forme) —
      la génération reprend À L'INTÉRIEUR du bloc think ;
    - repli : ``[{role: assistant, content: "<think>…</think>"}, {role: user,
      content: consigne de conclusion}]``, aucun flag — l'appelant force
      ``thinking_mode=False`` ; le modèle CONCLUT à partir du raisonnement.
    """
    clipped = clip_resume_thinking(thinking)
    if native:
        return (
            [{"role": "assistant", "content": "", "reasoning_content": clipped}],
            {"continue_final_message": True, "add_generation_prompt": False},
        )
    return (
        [
            {"role": "assistant",
             "content": THINK_PREFILL_OPEN + clipped + "\n</think>"},
            {"role": "user", "content": RESUME_AFTER_THINK_INSTRUCTION},
        ],
        {},
    )


def build_content_resume_tail(
    content: str,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """QUEUE de messages + flags de payload d'une reprise de CONTENU (natif).

    Retourne ``([{role: assistant, content: <prose partielle>}],
    {"continue_final_message": True, "add_generation_prompt": False})`` : le
    serveur re-rend le dernier message assistant NON fermé et la génération
    reprend exactement là où elle s'est arrêtée. Aucun repli non-natif — cf.
    ``MAX_RESUME_CONTENT_CHARS``.

    La prose est bornée par la QUEUE : si elle dépasse, on ne peut pas
    tronquer la tête (le modèle doit reprendre depuis la FIN exacte), donc
    l'appelant refuse la reprise plutôt que de renvoyer un préfixe faux —
    cf. ``should_auto_resume_content``.
    """
    return (
        [{"role": "assistant", "content": content}],
        {"continue_final_message": True, "add_generation_prompt": False},
    )


def should_auto_resume_content(
    *,
    finish: str,
    content: str,
    had_tool_calls: bool = False,
    native_ok: bool = False,
    resumes_done: int = 0,
    ctx_size: Optional[int] = None,
    window_tokens: int = 0,
) -> Tuple[bool, str]:
    """Décide si une reprise in-run de la PROSE est justifiée et sûre.

    Mêmes gardes que ``should_auto_resume`` (plafond de reprises, marge de
    fenêtre d'inférence), plus deux exigences propres au contenu :

    - ``native_ok`` : le canal ``continue_final_message`` est disponible. Sans
      lui, pas de reprise — un repli par consigne dupliquerait la prose (cf.
      ``MAX_RESUME_CONTENT_CHARS``).
    - la prose déjà produite tient dans ``MAX_RESUME_CONTENT_CHARS`` : on ne
      peut pas la tronquer (le modèle reprend depuis sa FIN, un préfixe
      amputé lui ferait continuer un texte qu'il n'a pas écrit).

    Contrairement au raisonnement, la prose N'EST PAS éphémère : elle part
    dans la réponse et dans l'historique. Le budget de contexte s'applique
    donc normalement — c'est ``window_tokens`` qui le porte ici.
    """
    if (finish or "") != "length":
        return False, "finish!=length"
    if not (content or "").strip():
        return False, "aucune prose à continuer"
    if had_tool_calls:
        return False, "tool_calls présents (reprise mi-séquence interdite)"
    if not native_ok:
        return False, ("canal natif continue_final_message indisponible "
                       "— pas de reprise de prose par consigne (risque de redite)")
    if LLAMA_CONTENT_RESUME_MAX <= 0:
        return False, "reprise de contenu désactivée (content_resume_max=0)"
    if resumes_done >= LLAMA_CONTENT_RESUME_MAX:
        return False, (f"plafond de reprises atteint "
                       f"({resumes_done}/{LLAMA_CONTENT_RESUME_MAX})")
    if len(content) > MAX_RESUME_CONTENT_CHARS:
        return False, (f"prose trop longue pour être renvoyée intacte "
                       f"({len(content)} > {MAX_RESUME_CONTENT_CHARS} chars)")
    _win = int(window_tokens or 0)
    if ctx_size and ctx_size > 0 and _win > 0:
        needed = _win + RESUME_HEADROOM_TOKENS
        if needed >= ctx_size:
            return False, (f"fenêtre d'inférence pleine "
                           f"({_win} + {RESUME_HEADROOM_TOKENS} ≥ n_ctx={ctx_size})")
    return True, f"reprise de prose {resumes_done + 1}/{LLAMA_CONTENT_RESUME_MAX}"


def should_auto_resume(
    *,
    finish: str,
    content: str,
    thinking: str,
    had_tool_calls: bool = False,
    partial: bool = False,
    resumes_done: int = 0,
    think_tokens_done: int = 0,
    ctx_size: Optional[int] = None,
    window_tokens: int = 0,
) -> Tuple[bool, str]:
    """Décide si une reprise automatique in-run est justifiée et sûre.

    Retourne ``(décision, raison)`` — la raison est destinée aux logs (elle
    explique aussi bien un refus qu'un accord).

    Conditions cumulatives :
    - coupure par plafond (``finish == "length"``) en PLEIN raisonnement
      (``content`` vide, ``thinking`` non vide, pas de tool_calls) — un
      PARTIEL de transport (``partial``) est éligible aussi : la reprise
      passe par le retry/backoff complet, un serveur mort échoue vite ;
    - gardes anti-boucle : ``LLAMA_THINK_RESUME_MAX`` reprises max par appel
      LLM et ``LLAMA_THINK_RESUME_TOTAL_TOKENS`` de thinking cumulé ;
    - marge de FENÊTRE D'INFÉRENCE : ``window_tokens + RESUME_HEADROOM_TOKENS``
      doit tenir dans ``ctx_size``.

    ``window_tokens`` = occupation RÉELLE mesurée à la fin du segment qui vient
    d'être coupé (``usage.prompt_tokens + completion_tokens``), c'est-à-dire ce
    que le serveur a effectivement en KV — donc la taille du prompt que la
    reprise native va renvoyer.

    ⚠ Ce n'est PAS ``last_prompt_tokens + think_tokens_done``, comme c'était
    calculé avant : le prompt d'un segment de reprise CONTIENT déjà le
    raisonnement des segments précédents, donc l'addition le comptait deux
    fois et refusait la reprise vers la moitié de la fenêtre réelle. Un long
    raisonnement était ainsi bloqué par un mur qui n'existait pas.

    Et ce n'est pas non plus le budget de contexte de la conversation : le
    raisonnement est éphémère (jamais re-soumis au tour suivant), il ne
    consomme aucun contexte de travail. La seule limite qui le concerne est la
    fenêtre physique du moteur.
    """
    if (finish or "") != "length":
        return False, "finish!=length"
    if (content or "").strip():
        return False, "contenu visible présent"
    if not (thinking or "").strip():
        return False, "aucun raisonnement accumulé"
    if had_tool_calls:
        return False, "tool_calls présents (reprise mi-séquence interdite)"
    # ``partial`` (flux coupé mi-génération : ReadTimeout, reset TCP, fin SSE
    # sans finish_reason) ne bloque PLUS la reprise. Le re-POST n'est pas
    # « aveugle » : l'appel de reprise passe par le retry/backoff complet
    # (+ attente /health sur 503 local), donc un serveur réellement mort
    # échoue vite et proprement — et les mêmes plafonds (RESUME_MAX, budget
    # de thinking, fenêtre) bornent l'acharnement. Bloquer ici transformait
    # chaque micro-coupure réseau en fin de run (« Continuer » à l'itération
    # N) sur les missions longues.
    if LLAMA_THINK_RESUME_MAX <= 0:
        return False, "auto-reprise désactivée (think_resume_max=0)"
    if resumes_done >= LLAMA_THINK_RESUME_MAX:
        return False, f"plafond de reprises atteint ({resumes_done}/{LLAMA_THINK_RESUME_MAX})"
    if (LLAMA_THINK_RESUME_TOTAL_TOKENS > 0
            and think_tokens_done >= LLAMA_THINK_RESUME_TOTAL_TOKENS):
        return False, (
            f"budget total de thinking atteint "
            f"({think_tokens_done}/{LLAMA_THINK_RESUME_TOTAL_TOKENS} tk)"
        )
    _win = int(window_tokens or 0)
    if ctx_size and ctx_size > 0 and _win > 0:
        needed = _win + RESUME_HEADROOM_TOKENS
        if needed >= ctx_size:
            return False, (f"fenêtre d'inférence pleine "
                           f"({_win} + {RESUME_HEADROOM_TOKENS} ≥ n_ctx={ctx_size})")
    _suffix = " — après coupure transport" if partial else ""
    return True, f"reprise {resumes_done + 1}/{LLAMA_THINK_RESUME_MAX}{_suffix}"


def merge_segment_usage(acc: Dict[str, Any], seg: Dict[str, Any]) -> Dict[str, Any]:
    """Fusionne l'``usage`` d'un segment de reprise dans l'accumulé.

    ``completion_tokens`` (et ``total_tokens``) se SOMMENT ; les champs de
    prompt (``prompt_tokens``…) prennent la valeur du DERNIER segment : c'est
    le prompt réellement facturé par la dernière requête (les précédents sont
    des préfixes du même prompt, les additionner gonflerait la jauge).
    """
    if not isinstance(seg, dict) or not seg:
        return acc
    if not isinstance(acc, dict) or not acc:
        return dict(seg)
    out = dict(acc)
    for k, v in seg.items():
        if k in ("completion_tokens", "total_tokens"):
            try:
                out[k] = int(out.get(k) or 0) + int(v or 0)
            except (TypeError, ValueError):
                out[k] = v
        else:
            out[k] = v
    return out
