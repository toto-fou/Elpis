#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# make_venv.sh — crée (ou recrée) le venv d'un projet Python et installe ses
# dépendances déclarées, de façon idempotente.
#
# Usage : bash make_venv.sh [DIR_PROJET]      (défaut : dossier courant)
#
# Détection : requirements.txt → pip install -r ;
#             sinon pyproject.toml → pip install -e . (+ extra [dev] si présent).
#
# Env :
#   PYTHON      interpréteur à utiliser (défaut : python3)
#   RECREATE=1  supprimer et recréer .venv même s'il existe
set -euo pipefail

PROJ="${1:-.}"
PY="${PYTHON:-python3}"
cd "$PROJ"
command -v "$PY" >/dev/null || { echo "$PY introuvable" >&2; exit 2; }

if [ -d .venv ] && [ "${RECREATE:-0}" = "1" ]; then
  echo "recréation de .venv (RECREATE=1)…"; rm -rf .venv
fi
if [ ! -d .venv ]; then
  "$PY" -m venv .venv || { echo "python3-venv manquant ? (apt install python3-venv)" >&2; exit 2; }
fi

VPIP=".venv/bin/pip"; VPY=".venv/bin/python"
"$VPY" -m pip install --upgrade pip --quiet

if [ -f requirements.txt ]; then
  echo "install depuis requirements.txt…"
  "$VPIP" install -r requirements.txt
elif [ -f pyproject.toml ]; then
  # Editable : l'import pointe vers les sources. L'extra dev est optionnel.
  if grep -q '^\s*dev\s*=' pyproject.toml; then
    echo "install editable + extra [dev]…"
    "$VPIP" install -e ".[dev]" || "$VPIP" install -e .
  else
    echo "install editable…"
    "$VPIP" install -e .
  fi
else
  echo "ni requirements.txt ni pyproject.toml — venv nu créé."
fi

"$VPIP" check || echo "⚠ conflits de versions signalés par pip check" >&2
echo
echo "venv prêt : source .venv/bin/activate"
echo "état figé ($("$VPY" --version 2>&1)) :"
"$VPIP" freeze | head -40
