#!/bin/bash
# SPDX-License-Identifier: MIT
# =====================================================================
#  fetch_models.sh — récupère un modèle ggml pour whisper.cpp.
#
#    sudo bash deploy/voice/stt/fetch_models.sh [MODELE]
#
#  MODELE : small-q5_1 (défaut, CPU) | large-v3-turbo-q5_0 (GPU) | medium-q5_0 | base-q5_1
#
#  Mesures relevées sur un projet antérieur (énoncé de 5 s, français) :
#      small-q5_1           CPU 2 414 ms    GPU   226 ms    182 Mo
#      medium-q5_0          CPU 7 656 ms    GPU   461 ms    515 Mo
#      large-v3-turbo-q5_0  CPU 12 062 ms   GPU   250 ms    548 Mo
#  Sans GPU, restez sur small : au-delà la dictée n'est plus utilisable.
# =====================================================================
set -euo pipefail

MODELE="${1:-small-q5_1}"
DEST="${DEST:-/opt/elpis-voice}"
BASE="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"
FICHIER="ggml-${MODELE}.bin"

mkdir -p "$DEST/models"
CIBLE="$DEST/models/$FICHIER"

if [ -s "$CIBLE" ]; then
    echo "Déjà présent : $CIBLE"
else
    echo "--- Téléchargement de $FICHIER ---"
    # .part puis rename : un téléchargement coupé ne laisse pas un modèle tronqué
    curl -fL --progress-bar -o "$CIBLE.part" "$BASE/$FICHIER"
    mv "$CIBLE.part" "$CIBLE"
fi

id -u elpis >/dev/null 2>&1 && chown -R elpis:elpis "$DEST/models" || true

echo
echo "Modèle : $CIBLE"
echo "Autre que small-q5_1 ? « sudo systemctl edit elpis-whisper » puis :"
echo "    [Service]"
echo "    Environment=WHISPER_MODEL=$CIBLE"
