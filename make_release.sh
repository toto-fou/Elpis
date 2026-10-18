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
#      node/       runtime Node.js : l'archive officielle (sha256 de
#                  deploy/node/node.env) sans npm, npx ni corepack, à
#                  l'empreinte figée elle aussi
#      core/       bundle du core (apps/core/dist) pour cette architecture,
#                  construit et vérifié avec ce Node (module natif, /api/health)
#      toolhost/   bundle de l'hôte d'outils (apps/toolhost/dist), node-pty
#                  compilé ici pour cette architecture, vérifié de même
#                  (modules natifs, /health, arrêt propre)
#      web/        frontend construit (npm run build -w @elpis/web : frontend/dist,
#                  entrées Vite et vendor hachés, aucun CDN), installé dans
#                  frontend/dist ; le serveur n'exécute ni npm ni Vite
#      qdrant/     archive officielle de Qdrant (sha256 vérifié)
#      sandbox/    image sandbox Docker (.tar.gz)
#      browser/    dépendances npm + Chromium (ses bibliothèques système sont
#                  des prérequis apt : deploy/prerequis-apt.txt)
#      MANIFEST.txt
#    dist/elpis-offline-<version>-<arch>.tar
#
#  Sur la cible : ./install.sh --offline <dossier extrait>
#  Le paquet n'est JAMAIS versionné dans le dépôt (dist/ est ignoré). Aucun
#  paquet de l'OS dedans : ils sont des prérequis apt (deploy/prerequis-apt.txt,
#  miroir du LAN ou support de l'OS), Caddy compris.
#
#  Usage :
#    ./make_release.sh [VERSION] [--with-agpl] [--no-sandbox] [--no-browser]
# ==============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
# shellcheck source=deploy/qdrant/qdrant.env
. "$ROOT/deploy/qdrant/qdrant.env"
# shellcheck source=deploy/node/node.env
. "$ROOT/deploy/node/node.env"
# shellcheck source=deploy/node/runtime.sh
. "$ROOT/deploy/node/runtime.sh"

info() { printf '\033[1;34m[release]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[  ok   ]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[erreur ]\033[0m %s\n' "$*" >&2; exit 1; }

VERSION=""; WITH_AGPL=0; WITH_SANDBOX=1; WITH_BROWSER=1
while [ $# -gt 0 ]; do
    case "$1" in
        --with-agpl)  WITH_AGPL=1 ;;
        --with-caddy) echo "--with-caddy ignorée : Caddy est un prérequis apt (deploy/prerequis-apt.txt, groupe https)." >&2 ;;
        --no-sandbox) WITH_SANDBOX=0 ;;
        --no-browser) WITH_BROWSER=0 ;;
        -h|--help)    sed -n '2,/^set -euo pipefail/p' "$0" | sed '$d' | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
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

# ── 2 bis. Node.js et bundle du core ─────────────────────────────────────────
# Le bundle démarre avec le Node livré sur une base SQLite temporaire avant d'entrer dans le paquet.
verifier_core() {
    local node="$1" core="$2" inst port pid rc=0 sain=0
    [ -f "$core/pixels.mjs" ] && [ -f "$core/webp/dec/webp_dec.wasm" ] && [ -f "$core/webp/enc/webp_enc.wasm" ] \
        || die "Bundle du core : thread des images ou codecs WebP absents (pixels.mjs, webp/)."
    ELPIS_RACINE="$ROOT" "$node" "$core/exploitation.mjs" empreinte || die "Bundle du core : empreinte des sources."
    "$node" "$core/exploitation.mjs" natif || die "Bundle du core : module natif."
    inst="$(mktemp -d)"
    echo '{}' > "$inst/config.json"
    port="$("$node" -e 'const s = require("net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); })')"
    env -i PATH="$PATH" HOME="$inst" APP_MODE=main ELPIS_RACINE="$ROOT" APP_CONFIG_PATH="$inst/config.json" \
        APP_DB_PATH="$inst/app.db" APP_SANDBOX_DIR="$inst/sandboxes" ELPIS_AUDIT_DIR="$inst/audit" \
        ELPIS_AUDIT_KEY_PATH="$inst/audit.key" MCP_SERVERS_DIR="$inst/mcp_custom_servers" \
        BIND="127.0.0.1:$port" "$node" "$core/main.mjs" > "$inst/core.log" 2>&1 &
    pid=$!
    for _ in $(seq 1 120); do
        if curl --noproxy '*' -fsS -m 2 -o /dev/null "http://127.0.0.1:$port/api/health" 2>/dev/null; then sain=1; break; fi
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.5
    done
    kill -TERM "$pid" 2>/dev/null || true
    wait "$pid" || rc=$?
    if [ "$sain" -ne 1 ] || [ "$rc" -ne 0 ]; then
        cat "$inst/core.log" >&2
        rm -rf "$inst"
        die "Bundle du core : démarrage ou arrêt en échec (/api/health, SIGTERM)."
    fi
    rm -rf "$inst"
    ok "Bundle du core vérifié avec Node $NODE_VERSION (module natif, /api/health, arrêt propre)."
}
# Même contrôle pour l'hôte d'outils : modules natifs (node-pty compilé pour cette architecture), /health, arrêt propre.
verifier_hote() {
    local node="$1" hote="$2" inst port pid rc=0 sain=0
    ELPIS_RACINE="$ROOT" "$node" "$hote/main.mjs" --empreinte || die "Bundle de l'hôte d'outils : empreinte des sources."
    "$node" "$hote/main.mjs" --natif || die "Bundle de l'hôte d'outils : modules natifs (node-pty, better-sqlite3)."
    inst="$(mktemp -d)"
    echo '{}' > "$inst/config.json"
    port="$("$node" -e 'const s = require("net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); })')"
    env -i PATH="$PATH" HOME="$inst" ELPIS_RACINE="$ROOT" TOOLHOST_CONFIG="$inst/absent.json" \
        APP_CONFIG_PATH="$inst/config.json" APP_DB_PATH="$inst/app.db" APP_MCP_MANIFEST="$inst/absent-mcp.json" \
        APP_SANDBOX_DIR="$inst/sb" APP_FILE_HISTORY_DIR="$inst/fh" ELPIS_AUDIT_DIR="$inst/audit" \
        LOCAL_MCP_HOST=127.0.0.1 LOCAL_MCP_PORT="$port" "$node" "$hote/main.mjs" > "$inst/hote.log" 2>&1 &
    pid=$!
    for _ in $(seq 1 120); do
        if curl --noproxy '*' -fsS -m 2 -o /dev/null "http://127.0.0.1:$port/health" 2>/dev/null; then sain=1; break; fi
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.5
    done
    kill -TERM "$pid" 2>/dev/null || true
    wait "$pid" || rc=$?
    if [ "$sain" -ne 1 ] || [ "$rc" -ne 0 ]; then
        cat "$inst/hote.log" >&2
        rm -rf "$inst"
        die "Bundle de l'hôte d'outils : démarrage ou arrêt en échec (/health, SIGTERM)."
    fi
    rm -rf "$inst"
    ok "Bundle de l'hôte d'outils vérifié avec Node $NODE_VERSION (modules natifs, /health, arrêt propre)."
}
# Le paquet doit valoir pour le code archivé : sources du bundle (construction.json) suivies par git et sans modification.
sources_commitees() {
    local bundle="$1" libelle="$2" sources=()
    git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1 || return 0
    mapfile -t sources < <("$NODE_ARBRE/bin/node" -e 'const c = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf-8")); for (const s of c.sources) console.log(s)' "$bundle/construction.json")
    [ "${#sources[@]}" -gt 0 ] || die "construction.json du bundle ($libelle) sans liste de sources."
    { git -C "$ROOT" ls-files --error-unmatch -- "${sources[@]}" >/dev/null 2>&1 && git -C "$ROOT" diff --quiet HEAD -- "${sources[@]}"; } \
        || die "Bundle ($libelle) construit depuis des sources non commitées (git status apps packages) : sur la cible, le code archivé le ferait refuser."
}
na="NODE_ASSET_$ARCH"; ns="NODE_SHA256_$ARCH"
node_asset="${!na:-}"; node_sha="${!ns:-}"
[ -n "$node_asset" ] || die "Node.js : architecture $ARCH non gérée."
case "$ARCH" in x86_64) cible=linux-x64 ;; *) cible=linux-arm64 ;; esac
info "Node.js $NODE_VERSION…"
mkdir -p "$OUT/node"
# Archive officielle hors du paquet : son npm sert à construire le core, puis il est retiré du runtime livré.
NODE_TMP="$(mktemp -d "$ROOT/dist/.node-officiel.XXXXXX")"
trap 'rm -rf "$NODE_TMP"' EXIT
curl -fsSL --retry 3 -o "$NODE_TMP/$node_asset" "https://nodejs.org/dist/v$NODE_VERSION/$node_asset"
echo "$node_sha  $NODE_TMP/$node_asset" | sha256sum -c --quiet - || die "sha256 de Node.js invalide."
NODE_ARBRE="$NODE_TMP/${node_asset%.tar.gz}"
mkdir "$NODE_ARBRE"
tar -xzf "$NODE_TMP/$node_asset" -C "$NODE_ARBRE" --strip-components=1
info "Bundle du core ($cible : npm ci, construction)…"
( cd "$ROOT" && PATH="$NODE_ARBRE/bin:$PATH" npm ci --no-audit --no-fund \
    && PATH="$NODE_ARBRE/bin:$PATH" npm run build -w @elpis/core -- --sortie "$OUT/core" --cible "$cible" ) \
    || die "Construction du core échouée."
verifier_core "$NODE_ARBRE/bin/node" "$OUT/core"
sources_commitees "$OUT/core" core
info "Bundle de l'hôte d'outils ($cible : node-pty compilé sur cette machine)…"
( cd "$ROOT" && PATH="$NODE_ARBRE/bin:$PATH" npm run build -w @elpis/toolhost -- --sortie "$OUT/toolhost" --cible "$cible" ) \
    || die "Construction de l'hôte d'outils échouée (node-pty : build-essential et python3 requis)."
verifier_hote "$NODE_ARBRE/bin/node" "$OUT/toolhost"
sources_commitees "$OUT/toolhost" "hôte d'outils"
info "Frontend (Vite : entrées chat et console)…"
git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1 && { git -C "$ROOT" diff --quiet HEAD -- frontend package-lock.json \
    || die "Frontend construit depuis des sources non commitées (git status frontend)."; }
( cd "$ROOT" && PATH="$NODE_ARBRE/bin:$PATH" npm run build -w @elpis/web ) || die "Construction du frontend échouée."
[ -f "$ROOT/frontend/dist/.vite/manifest.json" ] || die "Frontend construit sans manifeste."
cp -a "$ROOT/frontend/dist" "$OUT/web"
ok "Frontend construit ($(du -sh "$OUT/web" | cut -f1))."

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

# ── 4. Service navigateur (avec le Node.js livré et le npm de son archive) ───
if [ "$WITH_BROWSER" -eq 1 ]; then
    info "Service navigateur (npm + Chromium)…"
    ( cd "$ROOT/browser-service" && PATH="$NODE_ARBRE/bin:$PATH" ./fetch_offline_deps.sh --no-apt )
    cp -a "$ROOT/browser-service/offline" "$OUT/browser"
fi

# ── 5. Runtime Node.js livré : l'archive officielle sans npm, npx ni corepack ─
runtime_epurer "$NODE_ARBRE"
vr="NODE_RUNTIME_SHA256_$ARCH"
empreinte="$(runtime_empreinte "$NODE_ARBRE")"
[ "$empreinte" = "${!vr:-}" ] \
    || die "Runtime Node.js sans npm : empreinte $empreinte, différente de $vr dans deploy/node/node.env (nouvelle version de Node.js : vérifiez-la, puis figez-la)."
sed '1,/^$/d' "$ROOT/LICENSES/node-runtime.txt" | cmp -s - "$NODE_ARBRE/LICENSE" \
    || die "LICENSES/node-runtime.txt ne correspond plus au LICENSE du runtime : régénérez-le (runtime_licence de deploy/node/runtime.sh)."
tar -C "$NODE_TMP" --sort=name --owner=0 --group=0 --numeric-owner -cf - "${node_asset%.tar.gz}" \
    | gzip -n -9 > "$OUT/node/$(runtime_archive "$ARCH")"
ok "Runtime Node.js $NODE_VERSION sans npm, npx ni corepack (empreinte ${empreinte:0:12})."

# ── Manifeste + archive ──────────────────────────────────────────────────────
{
    echo "Elpis — paquet hors-ligne $VERSION ($ARCH)"
    echo "créé le : $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "python  : $("$PY" -V 2>&1)"
    echo "node    : $NODE_VERSION, $(runtime_archive "$ARCH") (sans npm ; empreinte du runtime $empreinte)"
    echo "core    : $(sed -n 's/.*"empreinte": "\([0-9a-f]*\)".*/\1/p' "$OUT/core/construction.json") (empreinte des sources)"
    echo "hôte    : $(sed -n 's/.*"empreinte": "\([0-9a-f]*\)".*/\1/p' "$OUT/toolhost/construction.json") (empreinte des sources, $cible)"
    echo "web     : $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo '?') (frontend/dist, Vite)"
    echo "agpl    : $([ "$WITH_AGPL" -eq 1 ] && echo oui || echo non)"
    echo
    echo "Installation : ./install.sh --offline <ce dossier>"
    echo
    ( cd "$OUT" && find . -type f ! -name MANIFEST.txt -print0 | sort -z | xargs -0 sha256sum )
} > "$OUT/MANIFEST.txt"
tar -C "$ROOT/dist" -cf "$ROOT/dist/$NAME.tar" "$NAME"
ok "Paquet prêt : dist/$NAME.tar ($(du -h "$ROOT/dist/$NAME.tar" | cut -f1))"
