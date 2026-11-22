#!/bin/sh
# SPDX-License-Identifier: MIT
# deploy/qdrant/lancer.sh — Qdrant avec sa clé d'API remise par systemd (LoadCredentialEncrypted=qdrant.key) : QDRANT__SERVICE__API_KEY lue dans $CREDENTIALS_DIRECTORY, puis la commande donnée, telle quelle.
set -eu
QDRANT__SERVICE__API_KEY=""
IFS= read -r QDRANT__SERVICE__API_KEY < "${CREDENTIALS_DIRECTORY:?credentials de systemd absents}/qdrant.key" || true
[ -n "$QDRANT__SERVICE__API_KEY" ] || { echo "deploy/qdrant/lancer.sh : clé d'API de Qdrant absente ou vide" >&2; exit 1; }
export QDRANT__SERVICE__API_KEY
exec "$@"
