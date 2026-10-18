#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# deploy/codecs/webp/construire.sh — codecs WebAssembly de libwebp du thread des images, versions figées ; --verifier compare à SHA256SUMS sans rien écrire.
set -euo pipefail
export LC_ALL=C

EMSDK_VERSION="6.0.11"
EMSDK_COMMIT="dd8e25632640cfc1fb570c7fa4cc374e8a5e5a72"
LIBWEBP_VERSION="1.6.0"
LIBWEBP_SHA256="e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564"

ICI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RACINE="$(cd "$ICI/../../.." && pwd)"
SORTIE="$RACINE/packages/images/src/webp"
TRAVAIL="${ELPIS_CODECS_TRAVAIL:-$HOME/.cache/elpis-codecs}"
VERIFIER=0
[ "${1:-}" = "--verifier" ] && VERIFIER=1

mkdir -p "$TRAVAIL"
emsdk="$TRAVAIL/emsdk-$EMSDK_VERSION"
[ -d "$emsdk" ] || git clone --quiet --depth 1 --branch "$EMSDK_VERSION" https://github.com/emscripten-core/emsdk.git "$emsdk"
[ "$(git -C "$emsdk" rev-parse HEAD)" = "$EMSDK_COMMIT" ] || { echo "emsdk $EMSDK_VERSION : commit inattendu" >&2; exit 1; }
"$emsdk/emsdk" install "$EMSDK_VERSION" >/dev/null
"$emsdk/emsdk" activate "$EMSDK_VERSION" >/dev/null
# shellcheck disable=SC1091
source "$emsdk/emsdk_env.sh" >/dev/null 2>&1

archive="$TRAVAIL/libwebp-$LIBWEBP_VERSION.tar.gz"
url="https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-$LIBWEBP_VERSION.tar.gz"
for f in "" .asc; do
    [ -f "$archive$f" ] || { curl -fsSL --retry 3 -o "$archive$f.part" "$url$f" && mv "$archive$f.part" "$archive$f"; }
done
echo "$LIBWEBP_SHA256  $archive" | sha256sum -c --quiet -
# Signature de l'archive par la clé de publication de WebP (6B0E 6B70 976D E303 EDF2 F601 F9C3 D6BD B823 2B5D).
mkdir -p -m 700 "$TRAVAIL/gnupg"
gpg --batch --quiet --homedir "$TRAVAIL/gnupg" --dearmor < "$ICI/webp-release-key.asc" > "$TRAVAIL/webp-release-key.gpg"
gpgv --quiet --keyring "$TRAVAIL/webp-release-key.gpg" "$archive.asc" "$archive"
src="$TRAVAIL/libwebp-$LIBWEBP_VERSION"
rm -rf "$src" "$TRAVAIL/sortie" && tar xzf "$archive" -C "$TRAVAIL" && mkdir -p "$TRAVAIL/sortie/dec" "$TRAVAIL/sortie/enc"

# -DNDEBUG comme la construction amont ; aucun chemin de la machine dans les .wasm ; pile en tête (débordement = arrêt net).
options=(-O3 -DNDEBUG -I"$src" -ffile-prefix-map="$TRAVAIL"=. -sSTANDALONE_WASM --no-entry -sALLOW_MEMORY_GROWTH=1
    -sMAXIMUM_MEMORY=4GB -sFILESYSTEM=0 -sERROR_ON_UNDEFINED_SYMBOLS=1 -Wl,--stack-first)
commun=("$src"/src/dsp/*.c "$src"/src/utils/*.c)
emcc "${options[@]}" "$ICI/elpis_webp_dec.c" "$src"/src/dec/*.c "$src"/src/demux/*.c "${commun[@]}" \
    -sEXPORTED_FUNCTIONS=_malloc,_free,_elpis_webp_decode,_WebPGetDecoderVersion,_WebPGetDemuxVersion \
    -o "$TRAVAIL/sortie/dec/webp_dec.wasm"
emcc "${options[@]}" "$ICI/elpis_webp_enc.c" "$src"/src/enc/*.c "$src"/sharpyuv/*.c "${commun[@]}" \
    -sEXPORTED_FUNCTIONS=_malloc,_free,_elpis_webp_encode,_elpis_webp_free,_WebPGetEncoderVersion \
    -o "$TRAVAIL/sortie/enc/webp_enc.wasm"
cp "$src/COPYING" "$TRAVAIL/sortie/COPYING" && cp "$src/PATENTS" "$TRAVAIL/sortie/PATENTS"
chmod 644 "$TRAVAIL"/sortie/*/*.wasm

empreintes="$(cd "$TRAVAIL/sortie" && sha256sum dec/webp_dec.wasm enc/webp_enc.wasm COPYING PATENTS)"
if [ "$VERIFIER" = 1 ]; then
    diff <(echo "$empreintes") "$ICI/SHA256SUMS" && echo "codecs WebP identiques à SHA256SUMS"
    exit
fi
rm -rf "$SORTIE" && mkdir -p "$SORTIE" && cp -r "$TRAVAIL/sortie/." "$SORTIE/"
echo "$empreintes" > "$ICI/SHA256SUMS"
echo "libwebp $LIBWEBP_VERSION (emsdk $EMSDK_VERSION) → ${SORTIE#"$RACINE"/}"
