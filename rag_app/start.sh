#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# rag_app/start.sh — lance l'extracteur seul (hors ./elpis) : RAG_HOST (127.0.0.1), RAG_PORT (8000), RAG_STORE_DIR, RAG_CACHE_DIR.
set -euo pipefail
cd "$(dirname "$0")"

if [ -z "${VIRTUAL_ENV:-}" ] && [ -f ../venv/bin/activate ]; then
    # shellcheck disable=SC1091
    . ../venv/bin/activate
fi

# Le core est le seul client : l'extracteur n'écoute que la machine locale, sauf RAG_HOST explicite.
export RAG_STORE_DIR="${RAG_STORE_DIR:-$(cd .. && pwd)/user_db/rag}"
export RAG_CACHE_DIR="${RAG_CACHE_DIR:-${RAG_STORE_DIR%/}-cache}"
exec uvicorn app:app --host "${RAG_HOST:-127.0.0.1}" --port "${RAG_PORT:-8000}"
