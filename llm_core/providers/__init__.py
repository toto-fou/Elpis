# SPDX-License-Identifier: MIT
"""
llm_core.providers — Adaptateurs de transport par fournisseur.

- ``openai_compat`` : résolution d'endpoint + en-têtes + assainissement du
  payload pour les backends OpenAI-compatibles (local llama.cpp/vLLM + OpenAI,
  Mistral, Groq, OpenRouter, DeepSeek…). Le chemin de streaming réutilise le
  code existant de ``_chat_classic`` / ``_chat_with_tools`` (paramétré).
- ``anthropic`` : adaptateur NATIF ``/v1/messages`` (traduction messages/tools
  + parsing SSE Anthropic vers les mêmes callbacks).
"""
from __future__ import annotations
