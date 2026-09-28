#!/bin/bash
# SPDX-License-Identifier: MIT
# =====================================================================
#  build_whisper.sh — compile whisper.cpp sur la machine de reconnaissance.
#
#    sudo bash deploy/voice/stt/build_whisper.sh [CIBLE]
#
#  CIBLE : cpu (défaut) | cuda | vulkan | rocm
#
#  Les binaires livrés avec le projet antérieur sont des exécutables Windows : ils ne
#  servent à rien ici. Et les binaires llama.cpp déjà installés NON PLUS —
#  whisper.cpp est un autre projet, avec son propre serveur.
#
#  Résultat : /opt/elpis-voice/whisper/bin/whisper-server
#
#  ELPIS_VOICE_HOST : adresse d'écoute (défaut 127.0.0.1, Elpis sur cette
#  machine ; IP privée ou 0.0.0.0 si Elpis tourne ailleurs).
# =====================================================================
set -euo pipefail

CIBLE="${1:-cpu}"
DEST="${DEST:-/opt/elpis-voice}"
SRC="$DEST/src/whisper.cpp"
VERSION="${WHISPER_VERSION:-master}"

echo "--- Dépendances de compilation ---"
if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq
    apt-get install -y --no-install-recommends build-essential cmake git ca-certificates curl
elif command -v dnf >/dev/null 2>&1; then
    dnf install -y gcc-c++ cmake git ca-certificates curl
else
    echo "  (gestionnaire de paquets inconnu — il faut build-essential, cmake, git)"
fi

echo "--- Source ($VERSION) ---"
mkdir -p "$DEST/src"
if [ -d "$SRC/.git" ]; then
    git -C "$SRC" fetch --depth 1 origin "$VERSION"
    git -C "$SRC" checkout -f FETCH_HEAD
else
    git clone --depth 1 --branch "$VERSION" https://github.com/ggml-org/whisper.cpp "$SRC" \
        || git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$SRC"
fi

echo "--- Compilation (cible : $CIBLE) ---"
CMAKE_FLAGS="-DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON"
case "$CIBLE" in
    cpu)    ;;
    cuda)   CMAKE_FLAGS="$CMAKE_FLAGS -DGGML_CUDA=ON" ;;
    vulkan) CMAKE_FLAGS="$CMAKE_FLAGS -DGGML_VULKAN=ON" ;;
    rocm)   CMAKE_FLAGS="$CMAKE_FLAGS -DGGML_HIP=ON" ;;
    *) echo "Cible inconnue : $CIBLE (cpu|cuda|vulkan|rocm)" >&2; exit 2 ;;
esac

cmake -S "$SRC" -B "$SRC/build" $CMAKE_FLAGS
cmake --build "$SRC/build" --config Release -j "$(nproc)"

echo "--- Installation ---"
mkdir -p "$DEST/bin" "$DEST/models"
# Le binaire a changé de nom et d'emplacement au fil des versions : on prend
# le premier qui existe plutôt que de parier sur un chemin.
TROUVE=""
for c in "$SRC/build/bin/whisper-server" "$SRC/build/bin/server" "$SRC/build/examples/server/whisper-server"; do
    [ -x "$c" ] && TROUVE="$c" && break
done
if [ -z "$TROUVE" ]; then
    echo "whisper-server introuvable après compilation — cherchez-le dans $SRC/build" >&2
    exit 1
fi
install -m 0755 "$TROUVE" "$DEST/bin/whisper-server"
# Les backends GPU sont des bibliothèques chargées dynamiquement à côté du binaire.
find "$SRC/build" \( -name 'libggml*.so' -o -name 'libwhisper*.so' \) | while read -r so; do
    install -m 0644 "$so" "$DEST/bin/" 2>/dev/null || true
done

id -u elpis >/dev/null 2>&1 || useradd --system --home "$DEST" --shell /usr/sbin/nologin elpis
chown -R elpis:elpis "$DEST"

echo "--- Unité systemd ---"
sed -e "s#/opt/elpis-voice#$DEST#g" \
    -e "s#^Environment=WHISPER_HOST=.*#Environment=WHISPER_HOST=${ELPIS_VOICE_HOST:-127.0.0.1}#" \
    "$(dirname "$0")/elpis-whisper.service" > /etc/systemd/system/elpis-whisper.service
systemctl daemon-reload

echo
echo "Compilé : $DEST/bin/whisper-server"
echo "Ensuite : sudo bash $(dirname "$0")/fetch_models.sh"
echo "Puis    : sudo systemctl enable --now elpis-whisper"
