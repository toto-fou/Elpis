#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# ==============================================================================
#  make_release.sh — paquet d'installation HORS-LIGNE (à joindre à une release)
# ==============================================================================
#
#  À lancer sur une machine connectée, de même architecture et de même version
#  de Python que la cible (les roues pip en dépendent). Produit :
#
#    dist/elpis-offline-<version>-<arch>/
#      wheels/     roues Python (requirements-rag.txt, + AGPL si --with-agpl)
#      qdrant/     archive officielle de Qdrant (sha256 vérifié)
#      sandbox/    image sandbox Docker (.tar.gz)
#      browser/    dépendances npm + Chromium + .deb système (Playwright)
#      caddy/      .deb de Caddy (si --with-caddy)
#      MANIFEST.txt
#    dist/elpis-offline-<version>-<arch>.tar
#
#  Sur la cible : ./install.sh --offline <dossier extrait>
#  Le paquet n'est JAMAIS versionné dans le dépôt (dist/ est ignoré).
#
#  Usage :
#    ./make_release.sh [VERSION] [--with-agpl] [--with-caddy]
#                      [--no-sandbox] [--no-browser]
# ==============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
# shellcheck source=deploy/qdrant/qdrant.env
. "$ROOT/deploy/qdrant/qdrant.env"

info() { printf '\033[1;34m[release]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[  ok   ]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[erreur ]\033[0m %s\n' "$*" >&2; exit 1; }

VERSION=""; WITH_AGPL=0; WITH_CADDY=0; WITH_SANDBOX=1; WITH_BROWSER=1
while [ $# -gt 0 ]; do
    case "$1" in
        --with-agpl)  WITH_AGPL=1 ;;
        --with-caddy) WITH_CADDY=1 ;;
        --no-sandbox) WITH_SANDBOX=0 ;;
        --no-browser) WITH_BROWSER=0 ;;
        -h|--help)    sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        [0-9]*)       VERSION="$1" ;;
        *) die "argument inconnu : $1 (--help)" ;;
    esac
    shift
done
if [ -z "$VERSION" ]; then
    VERSION="$(sed -n 's/^version *= *"\(.*\)"/\1/p' pyproject.toml 2>/dev/null | head -1)"
    VERSION="${VERSION:-0.0.0}"
fi
ARCH="$(uname -m)"
NAME="elpis-offline-$VERSION-$ARCH"
OUT="$ROOT/dist/$NAME"
[ -e "$OUT" ] && die "$OUT existe déjà."
mkdir -p "$OUT"/{wheels,qdrant,sandbox}

PY="${PYTHON_BIN:-$ROOT/venv/bin/python}"
[ -x "$PY" ] || PY="$(command -v python3)"

# ── 1. Roues Python ──────────────────────────────────────────────────────────
req="$ROOT/requirements-rag.txt"
[ "$WITH_AGPL" -eq 1 ] && req="$ROOT/requirements-agpl-optional.txt"
info "Roues Python ($(basename "$req"), $("$PY" -V))…"
"$PY" -m pip download --dest "$OUT/wheels" -r "$req" --only-binary=:all: \
    || "$PY" -m pip download --dest "$OUT/wheels" -r "$req"
"$PY" -m pip download --dest "$OUT/wheels" pip setuptools wheel >/dev/null

# ── 2. Qdrant ────────────────────────────────────────────────────────────────
va="QDRANT_ASSET_$ARCH"; vs="QDRANT_SHA256_$ARCH"
asset="${!va:-}"; sha="${!vs:-}"
[ -n "$asset" ] || die "Qdrant : architecture $ARCH non gérée."
info "Qdrant $QDRANT_VERSION…"
curl -fsSL --retry 3 -o "$OUT/qdrant/$asset" \
    "https://github.com/qdrant/qdrant/releases/download/v${QDRANT_VERSION}/${asset}"
echo "$sha  $OUT/qdrant/$asset" | sha256sum -c --quiet - || die "sha256 de Qdrant invalide."

# ── 3. Image sandbox ─────────────────────────────────────────────────────────
if [ "$WITH_SANDBOX" -eq 1 ]; then
    sb="$ROOT/deploy/docker/sandbox"
    image="$("$sb/build_offline.sh" --print-image)"
    archive="$(echo "$image" | tr '/:' '--').tar.gz"
    if docker image inspect "$image" >/dev/null 2>&1; then
        info "Export de l'image $image…"
        docker save "$image" | gzip > "$OUT/sandbox/$archive"
    else
        info "Construction de l'image $image (mode archive)…"
        "$sb/build_offline.sh" --archive
        mv "$sb"/*.tar.gz "$OUT/sandbox/"
    fi
fi

# ── 4. Service navigateur ────────────────────────────────────────────────────
if [ "$WITH_BROWSER" -eq 1 ]; then
    info "Service navigateur (npm + Chromium + .deb)…"
    ( cd "$ROOT/browser-service" && ./fetch_offline_deps.sh )
    cp -a "$ROOT/browser-service/offline" "$OUT/browser"
fi

# ── 5. Caddy ─────────────────────────────────────────────────────────────────
if [ "$WITH_CADDY" -eq 1 ]; then
    info "Paquets Caddy…"
    "$ROOT/deploy/caddy/fetch_caddy_debs.sh"
    mkdir -p "$OUT/caddy" && cp "$ROOT"/deploy/caddy/debs/*.deb "$OUT/caddy/"
fi

# ── Manifeste + archive ──────────────────────────────────────────────────────
{
    echo "Elpis — paquet hors-ligne $VERSION ($ARCH)"
    echo "créé le : $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "python  : $("$PY" -V 2>&1)"
    echo "agpl    : $([ "$WITH_AGPL" -eq 1 ] && echo oui || echo non)"
    echo
    echo "Installation : ./install.sh --offline <ce dossier>"
    echo
    ( cd "$OUT" && find . -type f ! -name MANIFEST.txt -print0 | sort -z | xargs -0 sha256sum )
} > "$OUT/MANIFEST.txt"
tar -C "$ROOT/dist" -cf "$ROOT/dist/$NAME.tar" "$NAME"
ok "Paquet prêt : dist/$NAME.tar ($(du -h "$ROOT/dist/$NAME.tar" | cut -f1))"
