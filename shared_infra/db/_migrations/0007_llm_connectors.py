# SPDX-License-Identifier: MIT
"""
0007_llm_connectors — Table ``llm_connectors`` (Connecteurs LLM multi-fournisseurs).

Feature « Connecteurs LLM » : permet de pointer le chat vers d'autres backends
d'inférence que l'unique llama-server global codé en dur.

Deux portées (``scope``) :
  - ``user``   : connecteur perso d'un utilisateur (``owner_user_id`` renseigné),
                 typiquement un fournisseur cloud avec SA clé API.
  - ``shared`` : connecteur partagé géré par l'admin (``owner_user_id`` NULL),
                 typiquement un backend local (llama.cpp / vLLM) visible par tous.

Deux formats « wire » :
  - ``openai``    : OpenAI-compatible (local llama.cpp/vLLM/Ollama + OpenAI,
                    Mistral, Groq, OpenRouter, DeepSeek…). Auth ``Bearer``.
  - ``anthropic`` : API native ``/v1/messages`` (en-tête ``x-api-key``).

Clés API chiffrées au repos (``key_scheme='fernet'`` via
``shared_infra/security/encryption.py`` ; ``'plain'`` réservé/legacy). CRUD :
``shared_infra/llm/connectors.py``. Idempotent. Ne commit PAS (le runner
de migrations commit à la fin).
"""
from __future__ import annotations

import sqlite3


def migrate(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS llm_connectors (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_user_id INTEGER,                       -- NULL ⇒ connecteur partagé (admin)
            scope         TEXT NOT NULL DEFAULT 'user',  -- 'user' | 'shared'
            provider_type TEXT NOT NULL,                 -- llamacpp | vllm | openai | anthropic
                                                         -- | mistral | groq | openrouter | deepseek | generic
            wire          TEXT NOT NULL DEFAULT 'openai',-- 'openai' | 'anthropic'
            label         TEXT NOT NULL DEFAULT '',
            base_url      TEXT NOT NULL DEFAULT '',
            api_key_enc   TEXT NOT NULL DEFAULT '',
            key_scheme    TEXT NOT NULL DEFAULT 'fernet',-- 'fernet' | 'plain'
            default_model TEXT NOT NULL DEFAULT '',
            models_json   TEXT NOT NULL DEFAULT '',      -- liste de modèles saisie à la main (repli)
            enabled       INTEGER NOT NULL DEFAULT 1,
            created_at    REAL NOT NULL,
            updated_at    REAL NOT NULL,
            last_used     REAL,
            FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE CASCADE
        )
        """
    )
    # Chemin chaud : lister les connecteurs d'un user.
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_llmconn_owner "
        "ON llm_connectors(owner_user_id)"
    )
    # Lister les connecteurs partagés (admin), visibles par tous.
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_llmconn_scope "
        "ON llm_connectors(scope)"
    )
