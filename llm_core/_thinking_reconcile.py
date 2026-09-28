# SPDX-License-Identifier: MIT
"""
llm_core._thinking_reconcile — réconciliation post-stream thinking/réponse.

Pourquoi ce module
------------------
La séparation « raisonnement » (thinking) / « réponse visible » (content) était
historiquement codée par plusieurs heuristiques DIVERGENTES réparties sur les deux
chemins de chat (``_chat_classic`` sans outils et ``_chat_with_tools`` avec outils),
plus un repli cosmétique côté frontend. Résultat : un bug tenace où **toute la
réponse finale se retrouvait dans le canal thinking** et la bulle assistant restait
vide (le frontend re-titrant alors le bloc « thinking » en « Réponse »).

Les causes de fond menaient toutes au même état terminal — ``content`` vide alors
que ``thinking`` portait la réponse :

* un ``<think>`` jamais fermé aspire toute la suite dans le thinking ;
* un modèle qui streame son raisonnement via le canal natif ``reasoning_content``
  sans jamais émettre de ``content`` ;
* une balise ``</think>`` scindée sur une frontière de chunk SSE.

Ce module centralise **UNE seule règle** de réconciliation, partagée par tous les
chemins post-stream et couverte par des tests. L'invariant garanti :

    Si le modèle a émis du texte (hors appels d'outil), ``content`` n'est JAMAIS vide.

La fonction est PURE (pas d'I/O, pas de log) pour rester trivialement testable ; les
effets de bord propres à chaque appelant (émission d'events, flag de méta,
déduplication de l'affichage live) restent au niveau du site d'appel.
"""
from __future__ import annotations

from typing import Tuple

# Seuils de la branche secondaire « intro creuse + réponse coincée » (cf. infra).
# Choisis empiriquement (repris du filet historique de ``_chat_classic``).
_MIN_THINKING_FOR_APPEND = 200   # en-dessous, c'est probablement du vrai raisonnement
_RATIO_THINKING_OVER_CONTENT = 3  # thinking ≥ 3× content → content est une intro creuse


def reconcile_thinking_content(
    thinking: str,
    content: str,
    *,
    in_think: bool = False,
    had_tool_calls: bool = False,
    finish: str = "",
) -> Tuple[str, str]:
    """Réconcilie ``(thinking, content)`` en fin de stream et renvoie le couple corrigé.

    Règles, appliquées dans l'ordre :

    1. **Promotion** — ``content`` vide ET ``thinking`` présent ET pas d'appel
       d'outil → la réponse a été aspirée dans le canal thinking. On la remonte :
       ``content = thinking`` ; ``thinking = ""``. Cette branche ne dépend PAS de
       ``in_think`` : elle couvre aussi le cas ``reasoning_content``-only (où le
       splitter ``<think>`` n'a jamais été engagé).

       **Exception — raisonnement TRONQUÉ** (``finish == "length"``) : le modèle a
       été coupé par le plafond de génération EN PLEIN raisonnement (``<think>``
       jamais fermé ou canal natif interrompu). Ce texte n'est PAS une réponse :
       le promouvoir l'affichait en markdown dans la bulle (bug « le thinking sort
       du bloc »). On ne touche à rien — l'appelant arme ``truncated_in_think``
       pour que « Continuer » reprenne avec le raisonnement en prefill.
    2. **Append** — ``content`` présent mais COURT ET ``<think>`` non fermé
       (``in_think``) ET ``thinking`` nettement plus long (≥ 200 car. et ≥ 3×
       ``content``) → pattern « intro creuse type *Voici la réponse :* + vraie
       réponse coincée dans un ``<think>`` non refermé ». On append le thinking au
       content (en GARDANT le thinking visible — rien n'est perdu). Gardée derrière
       ``in_think`` pour ne jamais polluer une réponse légitimement courte (ex.
       « 42 ») dont le raisonnement était long — et derrière ``finish != "length"``
       (même exception que la promotion : un ``<think>`` non fermé issu d'une
       COUPURE par le plafond est du raisonnement tronqué, pas une réponse ; le
       recopier dans la bulle est la variante « graduelle » du même bug).
    3. **Inchangé** — sinon, on ne touche à rien (ne JAMAIS déplacer du raisonnement
       légitime quand une réponse visible existe).

    Args:
        thinking: texte de raisonnement accumulé.
        content: texte de réponse visible accumulé.
        in_think: l'analyseur de balises était-il encore en mode ``<think>`` à la fin
            du stream (balise ouverte jamais refermée) ? Pilote la branche 2.
        had_tool_calls: ce tour a-t-il produit des appels d'outil ? Si oui, un
            ``content`` vide est NORMAL (le modèle agit puis répondra au tour
            suivant) → on n'inhibe la promotion.
        finish: ``finish_reason`` du stream (``"length"`` = coupé par le plafond
            de génération). Inhibe la promotion (1) : un thinking interrompu par
            le cap n'est pas une réponse.

    Returns:
        ``(thinking, content)`` réconcilié (les deux ``strip()``és).
    """
    thinking = (thinking or "").strip()
    content = (content or "").strip()

    # (1) Promotion : réponse piégée dans le thinking.
    if thinking and not content and not had_tool_calls:
        # Coupure par le plafond EN PLEIN raisonnement → PAS une réponse.
        if finish == "length":
            return thinking, content
        return "", thinking

    # (2) Append : intro creuse + réponse coincée dans un <think> non fermé.
    # Jamais sur finish=length : coupure en plein raisonnement (cf. docstring).
    if (
        content
        and thinking
        and in_think
        and not had_tool_calls
        and finish != "length"
        and len(thinking) >= _MIN_THINKING_FOR_APPEND
        and len(thinking) >= _RATIO_THINKING_OVER_CONTENT * len(content)
    ):
        return thinking, content + "\n\n" + thinking

    # (3) Cas normal — inchangé.
    return thinking, content
