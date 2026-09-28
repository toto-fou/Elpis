# SPDX-License-Identifier: MIT
"""chatbot_app — Applicatif chatbot conversationnel (chat utilisateur ↔ LLM).

S'appuie sur le moteur LLM partagé ``llm_core`` et l'infrastructure
``shared_infra``. (L'ancien moteur de pipelines/équipes ``agentic_app`` a été
retiré au profit de Flowise, intégré comme service externe.)
"""
