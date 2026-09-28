#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# ─────────────────────────────────────────────────────────────────────
#  load_image.sh — Charge une image sandbox depuis son archive .tar.gz
#                  et purge les versions elpis/sandbox antérieures.
#
#  Pourquoi : les archives .tar.gz ne sont plus commitées (cf. .gitignore).
#  Sur le serveur, ce script charge la nouvelle image dans le daemon Docker
#  et nettoie les anciennes versions pour ne pas saturer le disque.
#
#  Usage
#  -----
#    ./load_image.sh                       Charge la .tar.gz la plus RÉCENTE
#                                          du dossier courant (auto-détection).
#    ./load_image.sh elpis-sandbox-1.6.0.tar.gz   Charge cette archive précise.
#    ./load_image.sh /chemin/vers/archive.tar.gz
#
#  Sécurité : une ancienne version encore référencée par un conteneur (même
#  arrêté) n'est PAS supprimée — recrée d'abord les conteneurs, puis relance.
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")"

# ─── 1. Résoudre l'archive ───────────────────────────────────────────
TAR="${1:-}"
if [[ -z "$TAR" ]]; then
    TAR=$(ls -1t elpis-sandbox-*.tar.gz 2>/dev/null | head -1 || true)
    [[ -n "$TAR" ]] || { echo "✗ Aucune archive elpis-sandbox-*.tar.gz dans $(pwd)" >&2; exit 1; }
    echo "ℹ Archive auto-détectée : $TAR"
fi
[[ -f "$TAR" ]] || { echo "✗ Archive introuvable : $TAR" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "✗ docker absent du PATH" >&2; exit 1; }

# ─── 2. Intégrité (si gzip) ──────────────────────────────────────────
if [[ "$TAR" == *.gz ]]; then
    gzip -t "$TAR" || { echo "✗ Archive corrompue (gzip -t a échoué) : $TAR" >&2; exit 1; }
fi

# ─── 3. Charger l'image ──────────────────────────────────────────────
echo "═══ docker load -i $TAR ($(du -h "$TAR" | cut -f1)) ═══"
LOAD_OUT=$(docker load -i "$TAR")
echo "$LOAD_OUT"
# docker load imprime "Loaded image: elpis/sandbox:X.Y.Z"
NEW_TAG=$(printf '%s\n' "$LOAD_OUT" | sed -n 's/^Loaded image: //p' | head -1)
[[ -n "$NEW_TAG" ]] || { echo "✗ Impossible de déterminer le tag chargé." >&2; exit 1; }
echo "✓ Image active : $NEW_TAG"

# ─── 4. Purger les versions antérieures (même repo, tag différent) ───
REPO="${NEW_TAG%:*}"           # elpis/sandbox
echo "═══ Purge des versions antérieures de $REPO ═══"
PURGED=0; KEPT=0
while read -r OLD; do
    [[ -z "$OLD" || "$OLD" == "$NEW_TAG" || "$OLD" == *":<none>" ]] && continue
    # Ne PAS casser une image utilisée par un conteneur (même arrêté).
    if [[ -n "$(docker ps -a --filter "ancestor=$OLD" --format '{{.Names}}')" ]]; then
        echo "  ⚠ $OLD référencée par un conteneur → conservée (recrée les conteneurs puis relance)"
        KEPT=$((KEPT+1)); continue
    fi
    if docker rmi "$OLD" >/dev/null 2>&1; then
        echo "  ✓ supprimée : $OLD"; PURGED=$((PURGED+1))
    else
        echo "  ⚠ échec suppression $OLD (en usage ?) → conservée"; KEPT=$((KEPT+1))
    fi
done < <(docker images "$REPO" --format '{{.Repository}}:{{.Tag}}')

echo "═══ Terminé : $NEW_TAG chargée · $PURGED purgée(s) · $KEPT conservée(s) ═══"
docker images "$REPO"
