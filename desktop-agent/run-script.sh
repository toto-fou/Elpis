#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# run-script.sh mon_script.py [--param=valeur ...]
# Exécute un script d'automatisation généré par le Studio avec le Python de
# l'agent (venv créé par install_agent.sh). Code de sortie : 0 ok,
# 1 vérification échouée, 2 erreur d'exécution.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="$HERE/.venv/bin/python"
[ -x "$PY" ] || PY="$HERE/venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3)"
cd "$HERE" && exec "$PY" -m elpis_auto "$@"
