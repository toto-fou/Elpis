#!/bin/bash
# SPDX-License-Identifier: MIT
# =====================================================================
#  fetch_voices.sh — télécharge une voix Piper française.
#
#    sudo bash deploy/voice/tts/fetch_voices.sh [VOIX ...]
#
#  Sans argument : fr_FR-siwis-medium (féminine, nette, 22 050 Hz).
#  Autres : fr_FR-tom-medium (masculine, 44,1 kHz), fr_FR-upmc-medium
#           (deux locuteurs), fr_FR-siwis-low (deux fois plus rapide),
#           fr_FR-gilles-low, fr_FR-mls-medium, fr_FR-mls_1840-low.
#
#  Une voix = DEUX fichiers (.onnx et .onnx.json). Tant que le .json manque,
#  le service considère la voix comme absente — c'est voulu : une voix à
#  moitié téléchargée ne doit jamais être proposée.
# =====================================================================
set -euo pipefail

DEST="${DEST:-/opt/elpis-voice}"
VOIX_DIR="$DEST/voices"
BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main/fr/fr_FR"

declare -A CHEMIN=(
    [fr_FR-siwis-medium]="siwis/medium"
    [fr_FR-siwis-low]="siwis/low"
    [fr_FR-upmc-medium]="upmc/medium"
    [fr_FR-tom-medium]="tom/medium"
    [fr_FR-gilles-low]="gilles/low"
    [fr_FR-mls-medium]="mls/medium"
    [fr_FR-mls_1840-low]="mls_1840/low"
)

mkdir -p "$VOIX_DIR"
VOIX=("$@")
[ ${#VOIX[@]} -eq 0 ] && VOIX=("fr_FR-siwis-medium")

for nom in "${VOIX[@]}"; do
    sous="${CHEMIN[$nom]:-}"
    if [ -z "$sous" ]; then
        echo "Voix inconnue : $nom" >&2
        echo "Connues : ${!CHEMIN[*]}" >&2
        exit 2
    fi
    if [ -s "$VOIX_DIR/$nom.onnx" ] && [ -s "$VOIX_DIR/$nom.onnx.json" ]; then
        echo "Déjà présente : $nom"
        continue
    fi
    echo "--- $nom ---"
    # Le .json d'abord : il est minuscule, et c'est lui qui rend la voix visible.
    curl -fL --progress-bar -o "$VOIX_DIR/$nom.onnx.part"      "$BASE/$sous/$nom.onnx"
    curl -fL --progress-bar -o "$VOIX_DIR/$nom.onnx.json.part" "$BASE/$sous/$nom.onnx.json"
    mv "$VOIX_DIR/$nom.onnx.part"      "$VOIX_DIR/$nom.onnx"
    mv "$VOIX_DIR/$nom.onnx.json.part" "$VOIX_DIR/$nom.onnx.json"
done

id -u elpis >/dev/null 2>&1 && chown -R elpis:elpis "$VOIX_DIR" || true
echo
echo "Voix dans $VOIX_DIR :"
ls -1 "$VOIX_DIR"/*.onnx 2>/dev/null | xargs -r -n1 basename
