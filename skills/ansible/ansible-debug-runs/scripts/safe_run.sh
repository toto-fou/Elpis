#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# safe_run.sh — exécute un playbook Ansible en 3 temps : syntax-check,
# dry-run (--check --diff), puis run réel SEULEMENT si APPLY=1.
#
# Usage : bash safe_run.sh <PLAYBOOK> <INVENTAIRE> [options ansible-playbook...]
#   options typiques : --limit web  --tags config  -e version=1.4.2  -K
#
# Env :
#   APPLY=1   exécuter réellement après un dry-run réussi (défaut : dry-run seul)
#
# Sortie : exit 0 si la dernière étape exécutée est verte.
set -euo pipefail

command -v ansible-playbook >/dev/null || { echo "ansible-playbook introuvable (pip install ansible)" >&2; exit 2; }
[ $# -ge 2 ] || { echo "usage: $0 <PLAYBOOK> <INVENTAIRE> [options]" >&2; exit 2; }

PLAYBOOK="$1"; INVENTORY="$2"; shift 2
[ -f "$PLAYBOOK" ]  || { echo "playbook introuvable : $PLAYBOOK" >&2; exit 2; }
[ -e "$INVENTORY" ] || { echo "inventaire introuvable : $INVENTORY" >&2; exit 2; }

echo "── 1/3 syntax-check ──────────────────────────────────────"
ansible-playbook --syntax-check "$PLAYBOOK"

echo "── 2/3 dry-run (--check --diff) ──────────────────────────"
# Le dry-run peut échouer À TORT si une tâche dépend d'un command/shell sauté
# en check : lire QUELLE tâche échoue avant de conclure (cf. SKILL.md).
ansible-playbook -i "$INVENTORY" "$PLAYBOOK" --check --diff "$@"

if [ "${APPLY:-0}" != "1" ]; then
  echo "dry-run OK — relancer avec APPLY=1 pour exécuter réellement."
  exit 0
fi

echo "── 3/3 run réel ──────────────────────────────────────────"
ansible-playbook -i "$INVENTORY" "$PLAYBOOK" "$@"
echo "OK — rejouer le playbook doit maintenant afficher changed=0 (idempotence)."
