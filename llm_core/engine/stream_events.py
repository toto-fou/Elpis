# SPDX-License-Identifier: MIT
"""llm_core.engine.stream_events — registre des événements du flux NDJSON
d'un tour de chat.

Un type par ligne, avec son rôle. Émetteurs : la boucle agentique et ses
outils (``LOOP_EVENTS``), le tour de chat (``chatbot_app/turn/`` :
préparation, exécution, pompe NDJSON), la route de rattachement
(``chatbot_app/routes/chat_control.py``) et le journal d'exécution rejoué au
rattachement (``shared_infra/runtime/run_journal.py``). Lecteurs, dans
``frontend/js/app-chat.js`` : ``handleStreamEvent`` et la boucle de lecture
du rattachement (``attachRun``).

``tests/llm_core/test_stream_events_2026_09_29.py`` vérifie que l'interface
ne lit, et que la route et le journal n'émettent, aucun type hors registre
(pour la boucle : les goldens de ``test_event_contract.py``) ; que chaque
type a un émetteur ; et qu'il a un lecteur ou figure dans ``NOT_DISPLAYED``.
"""
from __future__ import annotations

from typing import Dict

STREAM_EVENTS: Dict[str, str] = {
    # Réponse et raisonnement
    "mode": "mode du tour (classique, avec outils)",
    "iteration": "début d'une itération de la boucle",
    "thinking": "indicateur « réflexion en cours »",
    "thinking_token": "jeton de raisonnement",
    "thinking_content": "raisonnement complet, réconcilié",
    "content_token": "jeton de la réponse",
    "content_replace": "texte affiché remplacé (nettoyage de fin)",
    # Outils
    "tool_call": "appel d'outil décidé",
    "tool_call_delta": "arguments d'un appel en cours de génération",
    "tool_result": "résultat d'un outil",
    "tool_progress": "progression d'un outil",
    "tool_log": "journal d'un outil",
    "tool_limit": "plafond d'itérations atteint",
    "tool_history_partial": "historique partiel des outils",
    "shell_output": "sortie en direct d'une commande shell",
    "task_step": "étape d'un sous-agent",
    "todo_updated": "liste de tâches mise à jour",
    "annotation_frame": "capture annotée (vision, bureau)",
    # Contexte et moteur
    "prompt_progress": "progression du pré-remplissage du prompt",
    "kv_cache": "occupation du cache KV",
    "compression_start": "compaction du contexte commencée",
    "compression_done": "compaction du contexte terminée",
    "compression_capped": "compaction plafonnée",
    "compression_state": "état de compaction, persisté par la route",
    "prune_state": "état de l'élagage du contexte",
    "llm_user_suffix": "suffixe ajouté au message de l'utilisateur",
    "queue_status": "attente d'un créneau du moteur",
    "queue_cleared": "créneau obtenu",
    "rag_sources": "sources RAG du tour",
    # Génération d'images (tour « Images » et outil ``generate_image``)
    "image_progress": "avancée d'une génération d'images (file, calcul)",
    "image": "images générées (références)",
    "image_prompt": "description enrichie envoyée au moteur d'images",
    "image_error": "échec d'une génération d'images (code, message)",
    # Messages
    "info": "information",
    "notice": "avis affiché dans la conversation",
    "warning": "avertissement",
    "error": "erreur",
    "log": "ligne de journal (modèle chargé…)",
    # Fin et rattachement à une exécution
    "final": "fin du tour : réponse, métriques",
    "ping": "maintien de la connexion",
    "run_started": "début de l'exécution rejouée",
    "replay_done": "fin du rejeu, suite en direct",
    "run_end": "fin de l'exécution",
    "run_lost": "exécution introuvable (worker redémarré)",
    "journal_truncated": "journal plein : seuls les événements structurants suivent",
    "session_expired": "session expirée pendant le flux",
}

# Émis par la boucle agentique et ses outils (contrat figé par les goldens).
LOOP_EVENTS = frozenset({
    "mode", "iteration", "thinking", "thinking_token", "thinking_content",
    "content_token", "content_replace",
    "tool_call", "tool_call_delta", "tool_result", "tool_progress",
    "tool_log", "tool_limit", "tool_history_partial", "shell_output", "task_step",
    "todo_updated", "annotation_frame",
    "prompt_progress", "kv_cache", "compression_start", "compression_done",
    "compression_capped", "compression_state", "prune_state", "llm_user_suffix",
    "info", "notice", "warning", "error",
})

# Émis sans lecteur dans l'interface du chat : à afficher un jour, ou à cesser
# d'émettre. ``compression_state`` est lu par la route, pas par l'interface.
NOT_DISPLAYED = frozenset({
    "tool_limit", "tool_history_partial", "prune_state", "llm_user_suffix",
    "compression_state", "rag_sources", "log", "journal_truncated",
    "image_progress", "image", "image_prompt", "image_error",
})

__all__ = ["LOOP_EVENTS", "NOT_DISPLAYED", "STREAM_EVENTS"]
