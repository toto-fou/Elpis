# SPDX-License-Identifier: MIT
"""
llm_core._think_tokens — Combien de tokens le modèle a-t-il brûlés à RÉFLÉCHIR ?

Pourquoi ce module existe
=========================
Aucun backend ne sépare le raisonnement du reste dans son ``usage`` : llama.cpp
ne connaît que ``completion_tokens``, qui additionne le raisonnement, les appels
d'outils et la réponse visible. Toutes les vues de l'app héritaient donc d'un
seul chiffre « sortie », dans lequel la part de réflexion — souvent la
majorité du tour sur un modèle thinking — était indiscernable.

Ce module produit ce chiffre manquant, avec un ordre de vérité explicite (même
idiome que ``count_tokens_for_messages`` : exact d'abord, repli portable) :

1. **Déclaré par le backend** — ``usage.completion_tokens_details.reasoning_tokens``
   (o-series OpenAI, vLLM récents). Exact, gratuit, rien à calculer.
2. **Tokenisé exactement** — llama-server local : ``POST /tokenize`` sur le
   texte du raisonnement (cache LRU partagé avec le reste de l'app).
3. **Estimé** — ratio chars/token MESURÉ pour ce modèle (``context.tokens``),
   quand la cible est distante et muette. Toujours signalé comme tel.

Invariants
==========
- Le raisonnement est un SOUS-ENSEMBLE de la sortie : le résultat est borné par
  ``output_tokens`` quand celui-ci est connu. Un comptage qui dépasserait
  (repli estimé trop généreux) rendrait ``response_tokens`` négatif.
- Best-effort de bout en bout : jamais d'exception vers la boucle de chat. En
  cas de panne du tokenizer, on retombe sur l'estimation, jamais sur 0 — un
  raisonnement présent mais compté 0 mentirait plus qu'une approximation.
- Le raisonnement n'est PAS re-soumis au tour suivant (la boucle outils ne
  garde pas ``reasoning_content`` dans ``working_messages``, et ``save_chat``
  strippe ``thinking``) : ces tokens ne pèsent donc QUE sur la sortie. C'est ce
  qui autorise la décomposition ``output = réflexion + réponse``.
"""
from __future__ import annotations

import logging
from typing import Any, Optional, Tuple

logger = logging.getLogger("uvicorn.error")

# Au-delà de cette taille, on n'appelle plus /tokenize pour mesurer le
# raisonnement : le corps sérialisé coûte plus que ce que la précision
# rapporte, et le timeout de 5 s de ``count_tokens_exact`` expirait de toute
# façon (cf. le commentaire au point d'appel). Aligné sur la borne du
# raisonnement cumulé d'un run (``_chat_with_tools.THINKING_HISTORY_MAX_CHARS``,
# 400 Ko) : en pratique on mesure exactement TOUT ce qui n'est pas déjà
# volumineux au point d'être tronqué.
TOKENIZE_MAX_CHARS = 400_000

# Sous-dicts où les backends OpenAI-compat rangent le détail de complétion.
_DETAIL_KEYS = ("completion_tokens_details", "output_tokens_details")
# Clés plates rencontrées chez les backends qui ne nichent pas le détail.
_FLAT_KEYS = ("reasoning_tokens", "thinking_tokens")


def _pos_int(v: Any) -> Optional[int]:
    """``v`` en entier ≥ 0, ou ``None`` si ce n'est pas un nombre exploitable."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    try:
        n = int(v)
    except (TypeError, ValueError):
        return None
    return n if n >= 0 else None


def native_reasoning_tokens(usage: Any) -> Optional[int]:
    """Tokens de raisonnement DÉCLARÉS par le backend, ou ``None``.

    Cherche d'abord le détail niché (forme OpenAI), puis les clés plates. Un 0
    explicite est une réponse valide (« ce tour n'a pas raisonné ») et n'est
    donc pas confondu avec « non déclaré »."""
    if not isinstance(usage, dict):
        return None
    for dk in _DETAIL_KEYS:
        det = usage.get(dk)
        if isinstance(det, dict):
            for fk in _FLAT_KEYS:
                n = _pos_int(det.get(fk))
                if n is not None:
                    return n
    for fk in _FLAT_KEYS:
        n = _pos_int(usage.get(fk))
        if n is not None:
            return n
    return None


def estimate_thinking_tokens(thinking: Optional[str],
                             model_id: Optional[str] = None) -> int:
    """Estimation par le ratio chars/token MESURÉ de ce modèle.

    Repli portable (cible distante, ``/tokenize`` absent). Plancher à 1 quand
    le texte n'est pas vide : un raisonnement affiché à « 0 token » se lirait
    comme une absence de raisonnement."""
    text = thinking or ""
    if not text:
        return 0
    try:
        from llm_core.context.tokens import measured_chars_per_token
        ratio = measured_chars_per_token(model_id)
    except Exception:
        ratio = 3.3
    return max(1, int(len(text) / max(1.0, float(ratio))))


async def measure_thinking_tokens(
    thinking: Optional[str],
    *,
    model_id: Optional[str] = None,
    usage: Any = None,
    output_tokens: Any = 0,
) -> Tuple[int, bool]:
    """``(tokens_de_raisonnement, estimé)`` pour UN tour.

    ``output_tokens`` (quand > 0) borne le résultat : le raisonnement ne peut
    pas dépasser ce que le backend dit avoir généré.

    Ne lève jamais — l'appelant est la boucle de chat.
    """
    text = thinking or ""
    cap = _pos_int(output_tokens) or 0

    # 1) Le backend le dit lui-même → exact, quel que soit le texte reçu.
    native = native_reasoning_tokens(usage)
    if native is not None:
        return (min(native, cap) if cap > 0 else native), False

    if not text.strip():
        return 0, False

    # 2) llama-server de la CIBLE : tokenisation exacte (cache LRU). Gated sur
    #    ``is_llamacpp`` : depuis le 2026-09-16 ``/tokenize`` vise le serveur
    #    de la cible (intégré ou connecteur llama.cpp), donc le tokenizer du
    #    modèle qui a réellement produit le texte. Un fournisseur non
    #    llama.cpp n'expose pas ``/tokenize``.
    try:
        from llm_core._target import current_target
        local = current_target().is_llamacpp
    except Exception:
        local = False
    if local and len(text) <= TOKENIZE_MAX_CHARS:
        try:
            from llm_core._llama_http import count_tokens_exact
            n = await count_tokens_exact(text, model_id or None)
            if isinstance(n, int) and n >= 0:
                return (min(n, cap) if cap > 0 else n), False
        except Exception:
            logger.debug("[think_tokens] /tokenize indisponible — repli estimé",
                         exc_info=True)
    elif local:
        # AUDIT long-run 2026-08-21 — au-delà de ce seuil on ne TENTE MÊME PAS
        # l'appel exact. Sur une mission longue, le raisonnement cumulé du run
        # atteignait plusieurs mégaoctets : le POST /tokenize expirait sur son
        # timeout de 5 s (on payait donc l'aller-retour ET l'attente pour
        # retomber sur l'estimation), après avoir sérialisé le corps en mémoire
        # et empoisonné le cache LRU avec une entrée géante. Le repli estimé
        # (ratio chars/token MESURÉ) est ici très largement assez bon : c'est
        # un chiffre d'affichage, pas une borne de contexte.
        logger.debug(
            "[think_tokens] raisonnement de %d chars > %d — estimation directe "
            "(pas de /tokenize)", len(text), TOKENIZE_MAX_CHARS)

    # 3) Repli portable, signalé estimé.
    est = estimate_thinking_tokens(text, model_id)
    return (min(est, cap) if cap > 0 else est), True


# AUDIT 2026-08-23 — ``annotate_thinking_tokens`` SUPPRIMÉE : 0 importeur,
# 0 test. Elle se présentait comme « le raccourci des appelants (chemins
# classic et outils) » alors que les deux appellent directement
# ``measure_thinking_tokens`` — un second chemin non testé, que son nom
# invitait à brancher.
