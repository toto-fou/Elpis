#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# deploy/node/installer.sh — installe le runtime Node.js (archive officielle sans npm, empreinte figée) dans node/, le bundle du core dans apps/core/dist, celui de l'hôte d'outils dans apps/toolhost/dist et le frontend construit dans frontend/dist, sans réseau avec --offline.
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "$0")")/../.." && pwd)"
# shellcheck source=deploy/node/node.env
. "$ROOT/deploy/node/node.env"
# shellcheck source=deploy/node/runtime.sh
. "$ROOT/deploy/node/runtime.sh"
DIST="$ROOT/apps/core/dist"
DIST_HOTE="$ROOT/apps/toolhost/dist"
DIST_WEB="$ROOT/frontend/dist"
NETTOYER=()
NPM_CHEMIN=""
trap 'rm -rf "${NETTOYER[@]}"' EXIT

info() { printf '\033[1;34m[ node  ]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[  ok   ]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[erreur ]\033[0m %s\n' "$*" >&2; exit 1; }
usage() { die "usage : deploy/node/installer.sh node|core|hote|bundles|web [--offline DOSSIER] | npm DOSSIER"; }

ACTION="${1:-}"; shift || true
OFFLINE=""; DOSSIER_NPM=""
if [ "$ACTION" = npm ]; then DOSSIER_NPM="${1:-}"; [ -n "$DOSSIER_NPM" ] || usage; shift; fi
while [ $# -gt 0 ]; do
    case "$1" in
        --offline) OFFLINE="${2:-}"; [ -n "$OFFLINE" ] || usage; shift ;;
        *) usage ;;
    esac
    shift
done

node_bin() {
    if [ -n "${ELPIS_NODE:-}" ]; then echo "$ELPIS_NODE"
    elif [ -x "$ROOT/node/bin/node" ]; then echo "$ROOT/node/bin/node"
    else command -v node || echo node; fi
}

# Archive officielle de nodejs.org dans le fichier donné (copiée de ELPIS_NODE_CACHE si elle y est déjà), refusée si sa somme diffère de node.env ; ARCHIVE = son nom.
archive_officielle() {
    local va="NODE_ASSET_$(uname -m)" vs="NODE_SHA256_$(uname -m)" cache=""
    ARCHIVE="${!va:-}"
    [ -n "$ARCHIVE" ] && [ -n "${!vs:-}" ] || die "Node.js : architecture $(uname -m) non prise en charge (x86_64, aarch64)."
    [ -n "${ELPIS_NODE_CACHE:-}" ] && [ -d "$ELPIS_NODE_CACHE" ] && cache="$ELPIS_NODE_CACHE/$ARCHIVE"
    if [ -n "$cache" ] && [ -f "$cache" ] && echo "${!vs}  $cache" | sha256sum -c --quiet - >/dev/null 2>&1; then
        cp "$cache" "$1"
        return 0
    fi
    info "Téléchargement de Node.js $NODE_VERSION ($ARCHIVE)…"
    curl -fsSL --retry 3 -o "$1" "https://nodejs.org/dist/v$NODE_VERSION/$ARCHIVE" \
        || die "Téléchargement de Node.js échoué (hors ligne : ./install.sh --offline <paquet>)."
    echo "${!vs}  $1" | sha256sum -c --quiet - >/dev/null 2>&1 || die "Somme SHA-256 de $ARCHIVE invalide : archive refusée."
    if [ -n "$cache" ]; then cp "$1" "$cache"; fi
}

# Runtime du paquet hors ligne, ou archive officielle épurée ; refusé si son empreinte diffère de node.env ; remplacé d'un coup.
installer_node() {
    local vr="NODE_RUNTIME_SHA256_$(uname -m)" attendu tgz neuf nom
    attendu="${!vr:-}"
    [ -n "$attendu" ] || die "Node.js : architecture $(uname -m) non prise en charge (x86_64, aarch64)."
    if [ "$(runtime_empreinte "$ROOT/node" 2>/dev/null)" = "$attendu" ]; then
        ok "Node.js $NODE_VERSION déjà en place (node/, sans npm, empreinte vérifiée)."
        return 0
    fi
    tgz="$(mktemp "$ROOT/.node-archive.XXXXXX")"
    neuf="$(mktemp -d "$ROOT/.node-nouveau.XXXXXX")"
    NETTOYER+=("$tgz" "$neuf" "$ROOT/.node-ancien")
    if [ -n "$OFFLINE" ]; then
        nom="$(runtime_archive "$(uname -m)")"
        cp "$OFFLINE/node/$nom" "$tgz" 2>/dev/null \
            || die "$OFFLINE/node/$nom absent ou illisible : paquet hors ligne d'une autre version ou d'une autre architecture."
        tar -xzf "$tgz" -C "$neuf" --strip-components=1 || die "Archive $nom illisible."
    else
        archive_officielle "$tgz"
        tar -xzf "$tgz" -C "$neuf" --strip-components=1 || die "Archive $ARCHIVE illisible."
        runtime_epurer "$neuf"
    fi
    [ "$(runtime_empreinte "$neuf")" = "$attendu" ] \
        || die "Runtime Node.js refusé : son empreinte diffère de deploy/node/node.env (paquet d'une autre version, ou modifié)."
    [ "$("$neuf/bin/node" -v 2>/dev/null)" = "v$NODE_VERSION" ] || die "Node.js $NODE_VERSION ne s'exécute pas sur cette machine."
    chmod 755 "$neuf"
    rm -rf "$ROOT/.node-ancien"
    if [ -e "$ROOT/node" ]; then mv "$ROOT/node" "$ROOT/.node-ancien"; fi
    mv "$neuf" "$ROOT/node"
    ok "Node.js $NODE_VERSION installé dans node/ (sans npm, empreinte vérifiée)."
}

# npm de l'archive officielle dans DOSSIER (bin/npm, bin/npx), le temps d'une construction en ligne : jamais dans node/.
installer_npm() {
    local tgz haut
    mkdir -p "$1"
    tgz="$(mktemp "$1/.archive.XXXXXX")"
    NETTOYER+=("$tgz")
    archive_officielle "$tgz"
    haut="${ARCHIVE%.tar.gz}"
    tar -xzf "$tgz" -C "$1" --strip-components=1 "$haut/lib/node_modules/npm" "$haut/bin/npm" "$haut/bin/npx" \
        || die "npm absent de $ARCHIVE."
    ok "npm de Node.js $NODE_VERSION prêt dans $1, le temps de la construction."
}

# bundle_sain DOSSIER NODE : complet (thread des images et codecs WebP compris), mêmes sources que le dépôt et module natif chargé ; MOTIF dit sinon pourquoi.
bundle_sain() {
    local dossier="$1" node="$2" rc=0
    [ -f "$dossier/exploitation.mjs" ] || { MOTIF="exploitation.mjs absent"; return 1; }
    [ -f "$dossier/pixels.mjs" ] && [ -f "$dossier/webp/dec/webp_dec.wasm" ] && [ -f "$dossier/webp/enc/webp_enc.wasm" ] \
        || { MOTIF="thread des images ou codecs WebP absents (pixels.mjs, webp/)"; return 1; }
    MOTIF="$(ELPIS_RACINE="$ROOT" "$node" "$dossier/exploitation.mjs" empreinte 2>&1)" || rc=$?
    if [ "$rc" -ne 0 ]; then MOTIF="autre version que ce dépôt : ${MOTIF:-contrôle interrompu (code $rc)}"; return 1; fi
    MOTIF="$("$node" "$dossier/exploitation.mjs" natif 2>&1)" || rc=$?
    if [ "$rc" -ne 0 ]; then MOTIF="module natif : ${MOTIF:-contrôle interrompu (code $rc)}"; return 1; fi
    return 0
}

# bundle_hote_sain DOSSIER NODE : mêmes sources que le dépôt, node-pty et better-sqlite3 chargés pour cette machine ; MOTIF dit sinon pourquoi.
bundle_hote_sain() {
    local dossier="$1" node="$2" rc=0
    [ -f "$dossier/main.mjs" ] || { MOTIF="main.mjs absent"; return 1; }
    MOTIF="$(ELPIS_RACINE="$ROOT" "$node" "$dossier/main.mjs" --empreinte 2>&1)" || rc=$?
    if [ "$rc" -ne 0 ]; then MOTIF="autre version que ce dépôt : ${MOTIF:-contrôle interrompu (code $rc)}"; return 1; fi
    MOTIF="$(timeout 30 "$node" "$dossier/main.mjs" --natif 2>&1)" || rc=$?
    if [ "$rc" -ne 0 ]; then MOTIF="modules natifs : ${MOTIF:-contrôle interrompu (code $rc)}"; return 1; fi
    return 0
}

# npm ci une fois par exécution (npm de l'archive officielle, jamais dans node/) ; NPM_CHEMIN = PATH de la construction.
preparer_npm() {
    [ -n "$NPM_CHEMIN" ] && return 0
    local node npm_tmp
    node="$(node_bin)"
    npm_tmp="$(mktemp -d "$ROOT/.node-npm.XXXXXX")"
    NETTOYER+=("$npm_tmp")
    installer_npm "$npm_tmp"
    NPM_CHEMIN="$npm_tmp/bin:$PATH"
    case "$node" in */*) NPM_CHEMIN="$(dirname "$node"):$NPM_CHEMIN" ;; esac
    ( cd "$ROOT" && PATH="$NPM_CHEMIN" npm ci --no-audit --no-fund ) \
        || die "npm ci échoué (réseau vers le registre npm ? hors ligne : ./install.sh --offline <paquet>)."
}

# installer_bundle LIBELLÉ DIST DOSSIER_DU_PAQUET CONTRÔLE ESPACE_NPM ANTÉRIEUR : bundle du paquet hors ligne (vérifié), sinon npm ci et construction ; un bundle abîmé est remplacé d'un coup.
installer_bundle() {
    local libelle="$1" dist="$2" paquet="$3" controle="$4" espace="$5" anterieur="$6" node neuf rel
    node="$(node_bin)"
    rel="${dist#"$ROOT"/}"
    if [ -n "$OFFLINE" ]; then
        [ -f "$OFFLINE/$paquet/main.mjs" ] && [ -f "$OFFLINE/$paquet/construction.json" ] \
            || die "$OFFLINE/$paquet absent : paquet hors ligne antérieur $anterieur, refaites-le avec make_release.sh."
        if cmp -s "$OFFLINE/$paquet/construction.json" "$dist/construction.json" && "$controle" "$dist" "$node"; then
            ok "$libelle déjà en place ($rel) : $MOTIF"
            return 0
        fi
        neuf="$dist.construction-$$"
        NETTOYER+=("$neuf" "$dist.ancien-$$")
        rm -rf "$neuf"
        mkdir -p "$(dirname "$dist")"
        cp -a "$OFFLINE/$paquet" "$neuf"
        "$controle" "$neuf" "$node" || die "Bundle du paquet hors ligne ($libelle) refusé ($MOTIF) : prenez le paquet construit pour cette version, sur cette architecture."
        rm -rf "$dist.ancien-$$"
        if [ -e "$dist" ]; then mv "$dist" "$dist.ancien-$$"; fi
        mv "$neuf" "$dist"
        ok "$libelle installé depuis le paquet hors ligne ($rel) : $MOTIF"
        return 0
    fi
    if "$controle" "$dist" "$node"; then
        ok "$libelle déjà construit pour ces sources ($rel) : $MOTIF"
        return 0
    fi
    info "$libelle : npm ci puis construction…"
    preparer_npm
    ( cd "$ROOT" && PATH="$NPM_CHEMIN" npm run build -w "$espace" ) \
        || die "Construction échouée ($libelle) ; l'hôte d'outils compile node-pty : build-essential et python3 requis (deploy/prerequis-apt.txt)."
    "$controle" "$dist" "$node" || die "$libelle construit mais inutilisable ($MOTIF)."
    ok "$libelle construit ($rel) : $MOTIF"
}

# installer_web : frontend construit (frontend/dist) depuis web/ du paquet hors ligne, sinon npm run build -w @elpis/web ; remplacé d'un coup.
installer_web() {
    local neuf
    if [ -n "$OFFLINE" ]; then
        [ -f "$OFFLINE/web/.vite/manifest.json" ] \
            || die "$OFFLINE/web absent : paquet hors ligne antérieur au frontend construit, refaites-le avec make_release.sh."
        neuf="$DIST_WEB.construction-$$"
        NETTOYER+=("$neuf" "$DIST_WEB.ancien-$$")
        rm -rf "$neuf"
        cp -a "$OFFLINE/web" "$neuf"
        if [ -e "$DIST_WEB" ]; then mv "$DIST_WEB" "$DIST_WEB.ancien-$$"; fi
        mv "$neuf" "$DIST_WEB"
        ok "Frontend installé depuis le paquet hors ligne (frontend/dist)."
        return 0
    fi
    info "Frontend : npm ci puis construction (Vite)…"
    preparer_npm
    ( cd "$ROOT" && PATH="$NPM_CHEMIN" npm run build -w @elpis/web ) || die "Construction du frontend échouée."
    [ -f "$DIST_WEB/.vite/manifest.json" ] || die "Frontend construit sans manifeste (frontend/dist/.vite/manifest.json)."
    ok "Frontend construit (frontend/dist)."
}

installer_core() { installer_bundle "Core" "$DIST" core bundle_sain @elpis/core "au core Node"; }
installer_hote() { installer_bundle "Hôte d'outils" "$DIST_HOTE" toolhost bundle_hote_sain @elpis/toolhost "à l'hôte d'outils Node"; }

case "$ACTION" in
    node) installer_node ;;
    core) installer_core ;;
    hote) installer_hote ;;
    bundles) installer_core; installer_hote ;;
    web) installer_web ;;
    npm) installer_npm "$DOSSIER_NPM" ;;
    *) usage ;;
esac
