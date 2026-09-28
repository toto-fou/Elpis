#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Lancement autonome du service RAG (console + API outils du chatbot).
#   RAG_HOST  : adresse d'écoute. Défaut : 0.0.0.0 si un jeton de service est
#               configuré, sinon 127.0.0.1 — sans jeton, seul un appel direct
#               de la machine locale est accepté : l'écoute LAN ne servirait à rien.
#   RAG_PORT  : port (8000).
set -euo pipefail
cd "$(dirname "$0")"

if [ -z "${VIRTUAL_ENV:-}" ] && [ -f ../venv/bin/activate ]; then
    # shellcheck disable=SC1091
    . ../venv/bin/activate
fi

if [ -z "${RAG_HOST:-}" ]; then
    if [ -n "${RAG_SERVICE_TOKEN:-}" ] || [ -s ../user_db/.rag_service_token ] \
       || grep -q '"service_token": *"[^"]' rag_config.json 2>/dev/null; then
        RAG_HOST=0.0.0.0
    else
        RAG_HOST=127.0.0.1
    fi
fi

exec uvicorn app:app --host "$RAG_HOST" --port "${RAG_PORT:-8000}"
